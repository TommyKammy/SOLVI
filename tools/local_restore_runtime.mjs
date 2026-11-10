/** Hooks for local_restore_drill --runtime. Only the new synthetic databases/files. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, open, readdir, readFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../packages/shared/dist/auth/password.js';

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
const children = [];
const logs = [];
let attachmentId;
let sourceObject;
let restoredObject;
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

async function startApiStorage(cwd, database) {
  await launch(`${database}-storage`, [join(root, 'tools/dev_object_storage.mjs')], cwd, database);
  await launch(
    `${database}-api`,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'services/api/src/main.ts')],
    cwd,
    database,
  );
  await waitFor('storage', `${envBase.S3_ENDPOINT}/healthz`);
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
  await startApiStorage(sourceRoot, 'synthetic_source');
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
  const storage = join(sourceRoot, '.local/object-storage');
  const keys = await readdir(storage);
  assert.equal(keys.length, 1, 'Expected exactly one synthetic object');
  sourceObject = join(storage, keys[0]);
  assert.equal(sha256(await readFile(sourceObject)), sha256(bytes));
  const backupRoot = join(work, 'object-backup');
  const restoreStorage = join(restoreRoot, '.local/object-storage');
  await mkdir(backupRoot, { mode: 0o700 });
  await mkdir(restoreStorage, { recursive: true, mode: 0o700 });
  const backupObject = join(backupRoot, keys[0]);
  restoredObject = join(restoreStorage, keys[0]);
  await cp(sourceObject, backupObject, { errorOnExist: true, force: false });
  await cp(backupObject, restoredObject, { errorOnExist: true, force: false });
  assert.notEqual(sourceObject, restoredObject);
}

export async function verify(context) {
  assert.equal(sha256(await readFile(restoredObject)), sha256(bytes));
  // Credentials/sessions are excluded from pg_dump; recreate only synthetic auth.
  const password = randomBytes(24).toString('hex');
  await credential(context, 'synthetic_restore', password);
  await startApiStorage(restoreRoot, 'synthetic_restore');
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
    sourceAndRestoreObjectPathsDistinct: true,
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
  await Promise.all(logs.map((log) => log.close()));
}
