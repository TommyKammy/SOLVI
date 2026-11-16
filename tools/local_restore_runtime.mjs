/**
 * Hooks for local_restore_drill --runtime. Only the new synthetic databases/files.
 *
 * Object Storage is SeaweedFS (ADR-0028), one throwaway container for the source and a
 * separate one for the restore target, so the restored object never shares storage with
 * the source. The backup of the object is taken through a signed GET and restored through
 * a signed PUT, exactly as an S3 copy would be.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../packages/shared/dist/auth/password.js';
import { S3CompatibleStorage } from '../packages/shared/dist/storage/object-storage.js';

export const postgresPassword = randomBytes(24).toString('hex');
const appPassword = randomBytes(24).toString('hex');
const root = fileURLToPath(new URL('..', import.meta.url));
const work = join(root, '.local/recovery', `runtime-${Date.now()}`);
const sourceRoot = join(work, 'source');
const restoreRoot = join(work, 'restore');
const apiBase = 'http://127.0.0.1:3301';
const webBase = 'http://localhost:3300';
const bytes = Buffer.from('SOLVI same-Mac recovery: harmless synthetic attachment only.\n');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
// Same image and arguments as docker-compose.yml `seaweedfs` (digest pinned, AGENTS.md §1.14).
const storageImage =
  'chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59';
const children = [];
const logs = [];
const containers = [];
let attachmentId;
let storageKey;
let sourceContainer;
let restoreContainer;
let backupObject;
const envBase = {
  ...process.env,
  NODE_ENV: 'development',
  API_PORT: '3301',
  WEB_PORT: '3300',
  API_BASE_URL: apiBase,
  WEB_BASE_URL: webBase,
  AUTH_LOCAL_ENABLED: 'true',
  SESSION_COOKIE_SECURE: 'false',
  METRICS_PORT: '19464',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  S3_ENDPOINT: 'http://127.0.0.1:19100',
  S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:19100',
  S3_REGION: 'us-east-1',
  S3_BUCKET_ATTACHMENTS: 'recovery-synthetic',
  S3_BUCKET_AUDIT_ANCHOR: 'recovery-audit-synthetic',
  S3_ACCESS_KEY: randomBytes(16).toString('hex'),
  S3_SECRET_KEY: randomBytes(24).toString('hex'),
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: '3310',
  LOG_LEVEL: 'warn',
};

export async function checkPorts() {
  for (const port of [55433, 3301, 3300, 19100, 19464]) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', () => reject(new Error(`Recovery port ${port} unavailable; stop`)));
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
  }
}

async function launch(label, args, cwd, database) {
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const log = await open(join(work, `${label}.log`), 'wx', 0o600);
  logs.push(log);
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...envBase,
      DATABASE_URL: `postgresql://solvi_app:${appPassword}@127.0.0.1:55433/${database}`,
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  children.push(child);
  child.once('error', () => {
    child.launchFailed = true;
  });
  return child;
}

async function stopChildren() {
  const active = children.splice(0);
  await Promise.all(
    active.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || child.launchFailed) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

async function waitFor(label, url) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (children.some((c) => c.exitCode !== null || c.signalCode !== null || c.launchFailed))
      throw new Error(`${label}: recovery child stopped; inspect private local logs`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      /* A newly launched process can still be binding its port. */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready; no environment changes attempted`);
}

async function api(path, cookie, body) {
  const response = await fetch(apiBase + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  // Never include response bodies: download/upload responses contain signed URLs.
  assert.equal(
    response.status,
    body === undefined || path === '/auth/login' ? 200 : 201,
    `Recovery API ${path}: status ${response.status}`,
  );
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function credential(context, database, password) {
  // Synthetic identity only. The database target is hardcoded by this module.
  const hash = await hashPassword(password);
  context.sql(
    database,
    context.insert('local_credential', {
      id: context.id(database === 'synthetic_source' ? 19 : 20),
      user_id: context.requester,
      password_hash: hash,
    }),
  );
}

function docker(args, failure) {
  const result = spawnSync('docker', args, {
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: envBase.S3_ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: envBase.S3_SECRET_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout.toString().trim();
}

/** A fresh, empty SeaweedFS for one side of the drill. Credentials are passed by name only. */
async function startStorage(database) {
  const name = `solvi-recovery-${database}-${process.pid}-${Date.now()}`;
  docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      '127.0.0.1:19100:8333',
      '-e',
      'AWS_ACCESS_KEY_ID',
      '-e',
      'AWS_SECRET_ACCESS_KEY',
      storageImage,
      'server',
      '-dir=/data',
      '-s3',
      '-master.volumeSizeLimitMB=256',
    ],
    'Recovery storage container did not start; is Docker running?',
  );
  containers.push(name);
  await waitFor('storage', `${envBase.S3_ENDPOINT}/healthz`);
  const buckets = spawnSync(process.execPath, [join(root, 'tools/ensure_buckets.mjs')], {
    env: envBase,
    stdio: 'ignore',
  });
  assert.equal(buckets.status, 0, 'Recovery storage buckets could not be prepared');
  return name;
}

async function stopStorage() {
  for (const name of containers.splice(0)) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

const storageClient = () =>
  new S3CompatibleStorage({
    endpoint: envBase.S3_ENDPOINT,
    bucket: envBase.S3_BUCKET_ATTACHMENTS,
    accessKey: envBase.S3_ACCESS_KEY,
    secretKey: envBase.S3_SECRET_KEY,
    region: envBase.S3_REGION,
  });

async function startApi(cwd, database) {
  await launch(
    `${database}-api`,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'services/api/src/main.ts')],
    cwd,
    database,
  );
  await waitFor('API', `${apiBase}/readyz`);
}

export async function prepare(context) {
  await mkdir(work, { recursive: true, mode: 0o700 });
  context.sql('postgres', `ALTER ROLE solvi_app LOGIN PASSWORD ${context.quoted(appPassword)};`);
  context.sql(
    'synthetic_source',
    `UPDATE app_user SET primary_email='restore-requester@example.invalid' WHERE id='${context.requester}';\n` +
      context.insert('role', {
        id: context.id(17),
        code: 'requester',
        scope: 'org',
        name: '合成一般利用者',
      }) +
      '\n' +
      context.insert('role_binding', {
        id: context.id(18),
        user_id: context.requester,
        role_id: context.id(17),
        role_scope: 'org',
        organization_id: context.org,
        source: 'seed',
      }),
  );
  const password = randomBytes(24).toString('hex');
  await credential(context, 'synthetic_source', password);
  sourceContainer = await startStorage('synthetic_source');
  await startApi(sourceRoot, 'synthetic_source');
  await launch(
    'synthetic-scan',
    [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'tools/dev_scan_attachments.ts')],
    sourceRoot,
    'synthetic_source',
  );
  const { cookie } = await api('/auth/login', null, {
    email: 'restore-requester@example.invalid',
    password,
  });
  assert.ok(cookie, 'Synthetic login cookie missing');
  const upload = await api(`/tickets/${context.incident}/attachments`, cookie, {
    fileName: '合成復元確認.txt',
    contentType: 'text/plain',
    sizeBytes: bytes.length,
    visibility: 'public',
  });
  attachmentId = upload.data.attachmentId;
  const put = await fetch(upload.data.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: bytes,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(put.status, 200, 'Synthetic signed upload refused');
  let clean = false;
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    const list = await api(`/tickets/${context.incident}/attachments`, cookie);
    clean = list.data.items.some((a) => a.id === attachmentId && a.scanStatus === 'clean');
    if (clean) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(clean, 'ClamAV clean result not confirmed; do not bypass scanning');
  const downloaded = await api(`/attachments/${attachmentId}/download`, cookie);
  const response = await fetch(downloaded.data.url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(bytes));
  await stopChildren();
  storageKey = context.sql(
    'synthetic_source',
    `SELECT storage_key FROM ticket_attachment WHERE id = ${context.quoted(attachmentId)};`,
  );
  assert.ok(storageKey, 'Synthetic attachment storage key missing');
  // Back up the object from the source storage itself (server-side signed GET), not from
  // the bytes we uploaded, so the drill proves the stored copy is restorable.
  const stored = await storageClient().getObject(storageKey);
  assert.equal(sha256(stored), sha256(bytes));
  const backupRoot = join(work, 'object-backup');
  await mkdir(backupRoot, { mode: 0o700 });
  backupObject = join(backupRoot, 'attachment.bin');
  await writeFile(backupObject, stored, { flag: 'wx', mode: 0o600 });
  await stopStorage();
}

export async function verify(context) {
  const backup = await readFile(backupObject);
  assert.equal(sha256(backup), sha256(bytes));
  // Credentials/sessions are excluded from pg_dump; recreate only synthetic auth.
  const password = randomBytes(24).toString('hex');
  await credential(context, 'synthetic_restore', password);
  restoreContainer = await startStorage('synthetic_restore');
  assert.notEqual(sourceContainer, restoreContainer);
  await storageClient().putObject(storageKey, backup, 'text/plain');
  await startApi(restoreRoot, 'synthetic_restore');
  const webDir = join(work, 'web');
  await cp(join(root, 'apps/web'), webDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (path) =>
      !/(?:^|\/)(?:node_modules|\.next)(?:\/|$)/.test(path) && !path.endsWith('.tsbuildinfo'),
  });
  await symlink(join(root, 'node_modules'), join(webDir, 'node_modules'), 'dir');
  await launch(
    'restore-web',
    [
      join(root, 'node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3300',
    ],
    webDir,
    'synthetic_restore',
  );
  await waitFor('Web', `${webBase}/login`);
  const { cookie } = await api('/auth/login', null, {
    email: 'restore-requester@example.invalid',
    password,
  });
  assert.ok(cookie);
  const ticket = await api(`/tickets/${context.incident}`, cookie);
  assert.equal(ticket.data.subject, '合成Restoreチケット');
  const request = await api(`/service-requests/${context.requestId}`, cookie);
  assert.equal(request.data.request.state, 'completed');
  const list = await api(`/tickets/${context.incident}/attachments`, cookie);
  assert.ok(
    list.data.items.some(
      (a) => a.id === attachmentId && a.scanStatus === 'clean' && a.downloadable,
    ),
  );
  const page = await fetch(`${webBase}/tickets/${context.incident}`, {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(page.status, 200, 'Restored Web ticket page not readable');
  const html = await page.text();
  assert.ok(
    html.includes('合成Restoreチケット') && html.includes('合成復元確認.txt'),
    'Restored Web must render synthetic ticket and attachment',
  );
  const webDownload = await fetch(`${webBase}/attachments/${attachmentId}`, {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(webDownload.status, 302, 'Restored Web download route refused');
  const url = new URL(webDownload.headers.get('location'));
  assert.equal(url.origin, envBase.S3_ENDPOINT);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const restoredBytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(restoredBytes), sha256(bytes));
  assert.ok(response.headers.get('content-disposition')?.startsWith('attachment;'));
  return {
    web: webBase,
    api: apiBase,
    postgres: '127.0.0.1:55433',
    storage: envBase.S3_ENDPOINT,
    metrics: '19464',
    workingDirectory: work.replace(root + '/', ''),
    syntheticTicketId: context.incident,
    syntheticRequestId: context.requestId,
    syntheticAttachmentId: attachmentId,
    attachmentBytes: restoredBytes.length,
    attachmentSha256: sha256(restoredBytes),
    clamAvCleanConfirmedBeforeBackup: true,
    restoredApiReady: true,
    restoredTicketAndCompletedRequestReadable: true,
    webHttpRenderContainsTicketAndAttachment: true,
    webDownloadRedirectAndSignedGetBytesMatch: true,
    sourceAndRestoreStorageContainersDistinct: true,
    syntheticCredentialsRecreatedAfterRestore: true,
    existingEnvAndStorageUntouched: true,
    limitations: [
      'HTTP rendered Web only; no additional browser UI operation',
      'Same Mac, synthetic data only; original container/volumes were not a restore target',
    ],
  };
}

export async function cleanup() {
  await stopChildren();
  await stopStorage();
  await Promise.all(logs.map((log) => log.close()));
}
