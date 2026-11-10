#!/usr/bin/env node
/* global document, window, getComputedStyle */
// WP054: real owned DB/API/Web, with separately labelled read-only fault injection.
// Credentials, cookies, response bodies and child output remain private in memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const wp = 'WP-P3-KNWUI-054';
const dbModule = 'evidence/' + wp + '/20261007/isolated-knowledge-db.mjs';
const fixtureModule = 'evidence/' + wp + '/20261007/knowledge-fixture.mjs';
const nonce = randomBytes(12).toString('hex');
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' })
  .format(new Date())
  .replaceAll('-', '');
const evidenceRoot = join(root, 'evidence', wp);
const args = process.argv.slice(2);
let evidence;
if (args.length === 0)
  evidence = join(evidenceRoot, day, 'ui-' + Date.now() + '-' + nonce.slice(0, 8));
else if (args.length === 2 && args[0] === '--output') evidence = resolve(root, args[1]);
else throw new Error('KNOWLEDGE_UI_ARGUMENTS_INVALID');
const evidenceRelative = relative(evidenceRoot, evidence);
if (!evidenceRelative || evidenceRelative.startsWith('..') || isAbsolute(evidenceRelative))
  throw new Error('KNOWLEDGE_UI_OUTPUT_INVALID');

const baseEnv = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]),
);
const abort = new AbortController();
const report = {
  workPackage: wp,
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  success: false,
  evidenceModel:
    'Owned real PostgreSQL, authenticated real API and copied production Web. Controlled list responses are labelled separately.',
  productionAcceptance: false,
  checks: [],
  stages: [],
  screenshots: [],
  axe: [],
  source: {
    files: [],
    exclusions: ['.env*', '.next', 'dist', 'node_modules', '.git', '*.tsbuildinfo'],
  },
  fixture: { syntheticOnly: true },
  apiObservations: [],
  proxy: { realReads: {}, controlledResponses: {}, rejectedWrites: 0 },
  cleanup: {},
  interrupted: false,
};
const knownFailures = new Set([
  'KNOWLEDGE_UI_ABORTED',
  'KNOWLEDGE_UI_TIMEOUT',
  'KNOWLEDGE_UI_COPY_INVALID',
  'KNOWLEDGE_UI_BUILD_FAILED',
  'KNOWLEDGE_UI_CHILD_FAILED',
  'KNOWLEDGE_UI_CHILD_OUTPUT_LIMIT',
  'KNOWLEDGE_UI_READINESS_FAILED',
  'KNOWLEDGE_UI_BINDING_INVALID',
  'KNOWLEDGE_UI_TEMP_IDENTITY_INVALID',
  'KNOWLEDGE_UI_DB_INTERFACE_INVALID',
  'KNOWLEDGE_UI_LOGIN_FAILED',
  'KNOWLEDGE_UI_RESPONSE_INVALID',
  'KNOWLEDGE_UI_PROXY_FAILED',
  'KNOWLEDGE_UI_BROWSER_MISSING',
  'KNOWLEDGE_UI_ASSERTION_FAILED',
  'KNOWLEDGE_UI_CLEANUP_FAILED',
  'KNOWLEDGE_UI_SOURCE_CHANGED',
  'KNOWLEDGE_UI_PRIOR_NEXT_CHANGED',
  'KNOWLEDGE_UI_OUTPUT_INVALID',
  'KNOWLEDGE_UI_EVIDENCE_INVALID',
]);
const safeCode = (error) =>
  knownFailures.has(error?.message) ? error.message : 'KNOWLEDGE_UI_ASSERTION_FAILED';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = async (path) => digest(await readFile(path));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const check = (value, code) => {
  if (!value) throw new Error(code);
};
function live() {
  if (abort.signal.aborted)
    throw new Error(report.interrupted ? 'KNOWLEDGE_UI_ABORTED' : 'KNOWLEDGE_UI_TIMEOUT');
}
function interrupt() {
  report.interrupted = true;
  abort.abort();
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const hardCap = setTimeout(() => abort.abort(), 15 * 60_000);
hardCap.unref();

let tempIdentity, database, browser, context, page, proxy, proxyPort, apiBase, webBase;
let fault = null;
let role = 'requester';
const children = [];
const reservations = [];
const cookies = new Map();
let originalNext;
let apiPort, webPort, metricsPort;

async function nextFingerprint() {
  const base = join(root, 'apps/web/.next');
  if (
    !(await access(base).then(
      () => true,
      () => false,
    ))
  )
    return { exists: false };
  const records = [];
  async function visit(folder) {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name),
        stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(path);
      else
        records.push([
          relative(base, path),
          stat.ino,
          stat.size,
          stat.mtimeMs,
          stat.isSymbolicLink(),
        ]);
    }
  }
  await visit(base);
  return { exists: true, fingerprint: digest(JSON.stringify(records)) };
}
async function inputFiles(path) {
  const stat = await lstat(path);
  check(!stat.isSymbolicLink(), 'KNOWLEDGE_UI_COPY_INVALID');
  if (!stat.isDirectory()) return [path];
  const result = [];
  for (const name of (await readdir(path)).sort()) {
    if (
      /^\.env/.test(name) ||
      ['node_modules', '.next', 'dist', '.git'].includes(name) ||
      name.endsWith('.tsbuildinfo')
    )
      continue;
    result.push(...(await inputFiles(join(path, name))));
  }
  return result;
}
async function assertTemp() {
  check(
    tempIdentity && (await realpath(tempIdentity.path)) === tempIdentity.path,
    'KNOWLEDGE_UI_TEMP_IDENTITY_INVALID',
  );
  const stat = await lstat(tempIdentity.path);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === tempIdentity.dev &&
      stat.ino === tempIdentity.ino &&
      (await readFile(join(tempIdentity.path, '.wp054-owner'), 'utf8')) === nonce,
    'KNOWLEDGE_UI_TEMP_IDENTITY_INVALID',
  );
}
async function own() {
  live();
  await assertTemp();
  await database?.assertOwned();
}
async function linkDependencies(origin, target) {
  if (
    !(await access(origin).then(
      () => true,
      () => false,
    ))
  )
    return;
  await mkdir(target, { recursive: true });
  for (const name of await readdir(origin)) {
    if (name === '@solvi' || name === '.cache') continue;
    await symlink(join(origin, name), join(target, name));
  }
  await mkdir(join(target, '@solvi'), { recursive: true });
  await symlink(join(tempIdentity.path, 'packages/shared'), join(target, '@solvi/shared'));
}
async function copySource() {
  const parent = await realpath(tmpdir());
  const path = await mkdtemp(join(parent, 'solvi-wp054-ui-'));
  const stat = await lstat(path);
  tempIdentity = { path, dev: stat.dev, ino: stat.ino };
  await writeFile(join(path, '.wp054-owner'), nonce, { flag: 'wx', mode: 0o600 });
  for (const input of [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'packages/shared',
    'services/api',
    'apps/web',
  ]) {
    for (const source of await inputFiles(join(root, input))) {
      const name = relative(root, source),
        target = join(path, name);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { errorOnExist: true, force: false });
      const sha256 = await hashFile(source);
      check(sha256 === (await hashFile(target)), 'KNOWLEDGE_UI_COPY_INVALID');
      report.source.files.push({ path: name, sha256 });
    }
  }
  for (const input of ['tools/e2e/knowledge_search_flow.mjs', dbModule, fixtureModule])
    report.source.files.push({ path: input, sha256: await hashFile(join(root, input)) });
  report.source.manifestSha256 = digest(JSON.stringify(report.source.files));
  report.source.temporaryDirectory = path;
  await linkDependencies(join(root, 'node_modules'), join(path, 'node_modules'));
  for (const workspace of ['packages/shared', 'services/api', 'apps/web'])
    await linkDependencies(
      join(root, workspace, 'node_modules'),
      join(path, workspace, 'node_modules'),
    );
}

function startChild(label, commandArgs, cwd, env) {
  live();
  const child = spawn(process.execPath, commandArgs, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = {
    label,
    child,
    cwd,
    pid: child.pid,
    outputBytes: 0,
    outputLimited: false,
    spawnError: false,
    finished: false,
    diagnostics: [],
  };
  children.push(record);
  child.on('error', () => {
    record.spawnError = true;
  });
  record.closed = new Promise((done) =>
    child.once('close', (code, signal) => {
      record.finished = true;
      record.code = code;
      record.signal = signal;
      done();
    }),
  );
  const buildOutput = ['shared-tsc', 'api-tsc', 'web-build'].includes(label);
  const phases = new Map([
    ['Creating an optimized production build', 'production-build'],
    ['Failed to compile.', 'compilation-failed'],
    ['Compiled successfully', 'compiled'],
    ['Checking validity of types', 'type-validation'],
    ['Collecting page data', 'page-data'],
    ['Generating static pages', 'static-pages'],
  ]);
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.on('data', (chunk) => {
      record.outputBytes += chunk.length;
      // Derive coordinates and fixed phase codes only; discard message/source/stack text.
      if (buildOutput && record.diagnostics.length < 30) {
        const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
        pending = lines.pop()?.slice(-2048) ?? '';
        for (const line of lines) {
          const ts = /^([A-Za-z0-9_./()[\]-]+)\((\d+),(\d+)\): error TS(\d+):/.exec(line);
          const next = /^(\.\/[A-Za-z0-9_./()[\]-]+):(\d+):(\d+)\s*$/.exec(line);
          const match = ts ?? next;
          if (match) {
            const path = relative(tempIdentity.path, resolve(cwd, match[1]));
            const lineNumber = Number(match[2]),
              column = Number(match[3]);
            if (
              !isAbsolute(path) &&
              !path.startsWith('..') &&
              /^(apps|services|packages)\//.test(path) &&
              lineNumber > 0 &&
              lineNumber < 1e7 &&
              column > 0 &&
              column < 1e7
            ) {
              record.diagnostics.push({
                path,
                line: lineNumber,
                column,
                ...(ts ? { code: 'TS' + ts[4] } : { code: 'NEXT_TYPE_LOCATION' }),
              });
            }
          }
          for (const [text, phase] of phases)
            if (line.includes(text) && !record.diagnostics.some((entry) => entry.phase === phase))
              record.diagnostics.push({ phase });
          if (record.diagnostics.length >= 30) break;
        }
      }
      // Deliberately do not retain stdout/stderr: real API/seed errors can contain credentials.
      if (record.outputBytes > 4 * 1024 * 1024) {
        record.outputLimited = true;
        try {
          process.kill(-record.pid, 'SIGTERM');
        } catch {
          /* cleanup will verify */
        }
      }
    });
  }
  return record;
}
async function stopChild(record) {
  if (!record) return;
  const groupExists = () => {
    if (!record.pid) return false;
    try {
      process.kill(-record.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  if (record.finished && !groupExists()) return;
  if (record.pid && record.pid > 1 && record.pid !== process.pid) {
    try {
      process.kill(-record.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error('KNOWLEDGE_UI_CLEANUP_FAILED');
    }
  }
  await Promise.race([record.closed, sleep(4000)]);
  if ((!record.finished || groupExists()) && record.pid) {
    try {
      process.kill(-record.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error('KNOWLEDGE_UI_CLEANUP_FAILED');
    }
    await Promise.race([record.closed, sleep(4000)]);
  }
  for (let i = 0; i < 40 && groupExists(); i++) await sleep(100);
  check(record.finished && !groupExists(), 'KNOWLEDGE_UI_CLEANUP_FAILED');
}
async function build(label, commandArgs, cwd, env, timeout = 120_000) {
  await assertTemp();
  const record = startChild(label, commandArgs, cwd, env),
    start = Date.now();
  while (!record.finished && Date.now() - start < timeout && !abort.signal.aborted)
    await sleep(100);
  if (!record.finished) await stopChild(record);
  live();
  report.stages.push({
    label,
    exitCode: record.code,
    outputBytes: record.outputBytes,
    elapsedMs: Date.now() - start,
    diagnostics: record.code === 0 ? [] : record.diagnostics,
  });
  check(!record.outputLimited, 'KNOWLEDGE_UI_CHILD_OUTPUT_LIMIT');
  check(!record.spawnError && record.code === 0, 'KNOWLEDGE_UI_BUILD_FAILED');
}
async function compile() {
  const dir = tempIdentity.path,
    tsc = join(dir, 'node_modules/typescript/bin/tsc');
  const env = { ...baseEnv, CI: '1', NEXT_TELEMETRY_DISABLED: '1', OTEL_TRACES_EXPORTER: 'none' };
  await build('shared-tsc', [tsc, '-p', 'packages/shared/tsconfig.json'], dir, env);
  const packagePath = join(dir, 'packages/shared/package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  pkg.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.js' };
  await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  await build('api-tsc', [tsc, '-p', 'services/api/tsconfig.json'], dir, env);
  const config = join(dir, 'apps/web/next.config.mjs');
  await writeFile(
    config,
    (await readFile(config, 'utf8')) + '\nnextConfig.outputFileTracingRoot = "/";\n',
  );
  await build(
    'web-build',
    [join(dir, 'node_modules/next/dist/bin/next'), 'build'],
    join(dir, 'apps/web'),
    { ...env, NODE_ENV: 'production' },
    300_000,
  );
  report.source.copyOnlyAdaptations = [
    'shared package exports points at copied dist',
    'Next tracing root permits installed dependency symlinks',
  ];
}

async function reservePort() {
  const server = createPortServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  const reservation = {
    port,
    closed: false,
    async release() {
      if (this.closed) return;
      await new Promise((done) => server.close(done));
      this.closed = true;
    },
  };
  reservations.push(reservation);
  if ([3000, 3001, 5432, 5433, 9090, 9100].includes(port)) {
    await reservation.release();
    throw new Error('KNOWLEDGE_UI_BINDING_INVALID');
  }
  return reservation;
}
async function portFree(port) {
  if (!port) return true;
  const server = createPortServer();
  return new Promise((done) => {
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}
async function waitHttp(base, path, child) {
  for (let i = 0; i < 160; i++) {
    await own();
    check(
      !child.finished && !child.spawnError && !child.outputLimited,
      'KNOWLEDGE_UI_CHILD_FAILED',
    );
    try {
      const response = await fetch(base + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
      await response.arrayBuffer();
    } catch {
      /* bounded startup, private transport errors */
    }
    await sleep(250);
  }
  throw new Error('KNOWLEDGE_UI_READINESS_FAILED');
}
async function processOutput(command, commandArgs) {
  const child = spawn(command, commandArgs, { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0,
    output = '',
    failed = false;
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 1_000_000) output += chunk;
    else {
      failed = true;
      child.kill();
    }
  });
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => {
    failed = true;
    child.kill('SIGKILL');
  }, 5000);
  const code = await new Promise((done) => {
    child.once('error', () => {
      failed = true;
      done(null);
    });
    child.once('close', done);
  });
  clearTimeout(timer);
  check(!failed && code === 0, 'KNOWLEDGE_UI_BINDING_INVALID');
  return output;
}
async function assertBindings(apiChild, webChild) {
  const output = await processOutput('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  let pid;
  const listeners = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n')) listeners.push({ pid, address: line.slice(1) });
  }
  for (const entry of [
    { port: apiPort, pid: apiChild.pid },
    { port: metricsPort, pid: apiChild.pid },
    { port: webPort, pid: webChild.pid },
    { port: proxyPort, pid: process.pid },
  ]) {
    const found = listeners.filter((x) => x.address.endsWith(':' + entry.port));
    check(
      found.length === 1 &&
        found[0].pid === entry.pid &&
        found[0].address === '127.0.0.1:' + entry.port,
      'KNOWLEDGE_UI_BINDING_INVALID',
    );
  }
  report.runtime = {
    api: { pid: apiChild.pid, port: apiPort },
    metricsPort,
    web: { pid: webChild.pid, port: webPort },
    proxyPort,
    bindHost: '127.0.0.1',
    compiledApi: true,
    productionWebBuild: true,
    apiNodeEnv: 'development',
  };
}
async function startProxy() {
  proxy = createServer(async (request, response) => {
    try {
      await own();
      if (!['GET', 'HEAD'].includes(request.method)) {
        report.proxy.rejectedWrites++;
        response.writeHead(405, { 'content-type': 'application/problem+json' });
        response.end(JSON.stringify({ status: 405, title: 'Read-only verification proxy' }));
        return;
      }
      const url = new URL(request.url, apiBase);
      check(url.origin === apiBase, 'KNOWLEDGE_UI_PROXY_FAILED');
      const key =
        url.pathname === '/knowledge'
          ? 'knowledge-list'
          : /^\/knowledge\//.test(url.pathname)
            ? 'knowledge-detail'
            : url.pathname === '/auth/me'
              ? 'session'
              : url.pathname === '/auth/organizations'
                ? 'organizations'
                : 'other-read';
      if (url.pathname === '/knowledge' && fault) {
        const status = fault.status ?? 200;
        const body =
          status === 200
            ? { items: [], total: fault.total ?? 0, previousCursor: null, nextCursor: null }
            : { type: 'about:blank', title: 'Controlled knowledge response', status };
        report.proxy.controlledResponses[fault.label] =
          (report.proxy.controlledResponses[fault.label] ?? 0) + 1;
        response.writeHead(status, {
          'content-type': status === 200 ? 'application/json' : 'application/problem+json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(body));
        return;
      }
      report.proxy.realReads[key] = (report.proxy.realReads[key] ?? 0) + 1;
      const headers = new Headers();
      if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
      const result = await fetch(url, {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      });
      const body = await result.arrayBuffer();
      check(body.byteLength <= 4 * 1024 * 1024, 'KNOWLEDGE_UI_RESPONSE_INVALID');
      response.writeHead(result.status, {
        'content-type': result.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      response.end(Buffer.from(body));
    } catch {
      report.proxy.failure = true;
      if (!response.headersSent)
        response.writeHead(502, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ status: 502, title: 'Owned proxy failed' }));
    }
  });
  await new Promise((done, fail) => {
    proxy.once('error', fail);
    proxy.listen(0, '127.0.0.1', done);
  });
  proxyPort = proxy.address().port;
}
async function startServers() {
  const apiReservation = await reservePort(),
    metricsReservation = await reservePort(),
    webReservation = await reservePort();
  apiPort = apiReservation.port;
  metricsPort = metricsReservation.port;
  webPort = webReservation.port;
  apiBase = 'http://127.0.0.1:' + apiPort;
  webBase = 'http://127.0.0.1:' + webPort;
  await apiReservation.release();
  await metricsReservation.release();
  const apiChild = startChild(
    'api',
    [join(tempIdentity.path, 'services/api/dist/main.js')],
    tempIdentity.path,
    {
      ...baseEnv,
      NODE_ENV: 'development',
      DATABASE_URL: database.appUrl,
      API_PORT: String(apiPort),
      API_HOST: '127.0.0.1',
      METRICS_PORT: String(metricsPort),
      METRICS_HOST: '127.0.0.1',
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_SERVICE_NAMESPACE: 'solvi-wp054-ui',
      LOG_LEVEL: 'error',
      AUTH_LOCAL_ENABLED: 'true',
      SESSION_COOKIE_SECURE: 'false',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_REGION: 'local',
      S3_BUCKET_ATTACHMENTS: 'wp054-unused',
      S3_BUCKET_AUDIT_ANCHOR: 'wp054-unused',
      S3_ACCESS_KEY: randomBytes(24).toString('hex'),
      S3_SECRET_KEY: randomBytes(24).toString('hex'),
    },
  );
  await waitHttp(apiBase, '/readyz', apiChild);
  await startProxy();
  await webReservation.release();
  const webChild = startChild(
    'web',
    [
      join(tempIdentity.path, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    join(tempIdentity.path, 'apps/web'),
    {
      ...baseEnv,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      API_BASE_URL: 'http://127.0.0.1:' + proxyPort,
    },
  );
  await waitHttp(webBase, '/login', webChild);
  await assertBindings(apiChild, webChild);
}

async function apiRequest(path, cookie, body) {
  await own();
  const response = await fetch(apiBase + path, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
  });
  const text = await response.text();
  check(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'KNOWLEDGE_UI_RESPONSE_INVALID');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('KNOWLEDGE_UI_RESPONSE_INVALID');
  }
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function loginRoles() {
  for (const name of ['requester', 'agent', 'admin', 'foreign']) {
    const fixture = database.fixture,
      actor = fixture.actors[name];
    const organizationId =
      name === 'foreign' ? fixture.controlOrganizationId : fixture.organizationId;
    const result = await apiRequest('/auth/login', null, {
      email: fixture.login[name].email,
      password: fixture.login.password,
      organizationId,
    });
    check(
      result.status === 200 &&
        result.data.userId === actor.userId &&
        result.data.organizationId === organizationId &&
        /^solvi_session[^=]*=[A-Za-z0-9_-]+$/.test(result.cookie ?? ''),
      'KNOWLEDGE_UI_LOGIN_FAILED',
    );
    cookies.set(name, result.cookie);
  }
  report.authentication = {
    realLoginSessions: cookies.size,
    identitiesAndOrganizationsMatched: true,
    cookieValuesSaved: false,
  };
}
async function useRole(name) {
  await context?.close();
  role = name;
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: 'ja-JP',
  });
  const cookie = cookies.get(name),
    at = cookie.indexOf('=');
  await context.addCookies([
    {
      name: cookie.slice(0, at),
      value: cookie.slice(at + 1),
      url: webBase,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  page = await context.newPage();
  page.setDefaultTimeout(12_000);
}
const list = () => page.locator('ul.knowledge-results > li');
const topNav = () => page.getByRole('navigation', { name: 'ナレッジ検索結果のページ（上）' });
const searchInput = () => page.getByRole('searchbox', { name: '検索する言葉' });
const urlPath = () => new URL(page.url()).pathname + new URL(page.url()).search;
function searchHref(query = '', manage = false, cursor) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (manage) params.set('manage', '1');
  if (cursor) params.set('cursor', cursor);
  return '/knowledge' + (params.size ? '?' + params : '');
}
async function open(path = '/knowledge') {
  await own();
  await page.goto(webBase + path, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: /ナレッジを探す|ナレッジの管理/ }).waitFor();
  await own();
}
async function waitUntil(predicate, label = 'KNOWLEDGE_UI_ASSERTION_FAILED') {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    live();
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(label);
}
async function visibleRows(expected) {
  await waitUntil(async () => (await list().count()) === expected);
}
async function rowIds() {
  return Promise.all(
    (await list().locator('h2 a').all()).map(async (link) => {
      const path = new URL(await link.getAttribute('href'), webBase).pathname;
      check(/^\/knowledge\/[a-f0-9-]{36}$/.test(path), 'KNOWLEDGE_UI_RESPONSE_INVALID');
      return path.split('/').at(-1);
    }),
  );
}
async function totalIs(value) {
  await waitUntil(
    async () =>
      (await page.locator('.knowledge-result strong').innerText()).trim() === value + '件',
  );
}
async function navigate(locator) {
  const href = await locator.getAttribute('href');
  check(typeof href === 'string' && href.startsWith('/knowledge'), 'KNOWLEDGE_UI_RESPONSE_INVALID');
  await locator.click();
  await page.waitForURL((url) => url.pathname + url.search === href);
  await page.waitForLoadState('networkidle');
  await own();
}
async function submitSearch(value) {
  await searchInput().fill(value);
  await page.getByRole('button', { name: '検索する', exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === '/knowledge' && (url.searchParams.get('q') ?? '') === value,
  );
  await page.waitForLoadState('networkidle');
  await own();
}
async function capture(name, withAxe = true) {
  await own();
  await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
  await chmod(join(evidence, name + '.png'), 0o600);
  report.screenshots.push({
    name,
    captureType: 'full-page',
    viewport: page.viewportSize(),
    role,
    controlledResponse: fault?.label ?? null,
  });
  if (['requester-public-desktop', 'body-tail-search', 'requester-mobile-390'].includes(name)) {
    const viewportName = name + '-viewport';
    await page.screenshot({ path: join(evidence, viewportName + '.png'), fullPage: false });
    await chmod(join(evidence, viewportName + '.png'), 0o600);
    report.screenshots.push({
      name: viewportName,
      captureType: 'viewport',
      viewport: page.viewportSize(),
      role,
      controlledResponse: fault?.label ?? null,
    });
  }
  if (withAxe) {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await writeFile(join(evidence, name + '-axe.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    report.axe.push({
      name,
      violations: result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        count: nodes.length,
      })),
    });
    assert.equal(result.violations.length, 0);
  }
}
async function tabTo(locator) {
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error('KNOWLEDGE_UI_ASSERTION_FAILED');
}
async function focusVisible(locator) {
  const result = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      active: document.activeElement === element,
      visible: element.matches(':focus-visible'),
      outline: parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none',
      shadow: style.boxShadow !== 'none',
    };
  });
  assert.ok(result.active && result.visible && (result.outline || result.shadow));
  return result;
}
async function caseCheck(name, fn, mode = 'real API') {
  await own();
  process.stdout.write('WP054 check: ' + name + '\n');
  try {
    await fn();
    await own();
    report.checks.push({ name, mode, passed: true });
  } catch (error) {
    report.checks.push({ name, mode, passed: false, failureCode: safeCode(error) });
  } finally {
    fault = null;
  }
  live();
}

async function apiList(query, { manage = false, limit = 100, cursor, actor = role } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (manage) params.set('manage', '1');
  if (cursor) params.set('cursor', cursor);
  const result = await apiRequest('/knowledge?' + params, cookies.get(actor));
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.data.items) && Number.isSafeInteger(result.data.total));
  return result.data;
}
async function allApiIds(query) {
  const ids = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const data = await apiList(query, { cursor });
    ids.push(...data.items.map((item) => item.id));
    if (!data.nextCursor) {
      assert.equal(ids.length, data.total);
      assert.equal(new Set(ids).size, ids.length);
      return ids;
    }
    cursor = data.nextCursor;
  }
  throw new Error('KNOWLEDGE_UI_RESPONSE_INVALID');
}
async function expectHeading(name) {
  await page.getByRole('heading', { name, exact: true }).waitFor();
}
async function runChecks() {
  const fixture = database.fixture;
  let secondPageHref;
  await useRole('requester');
  await caseCheck('requester-public-desktop', async () => {
    await open();
    await totalIs(fixture.counts.public);
    await visibleRows(20);
    assert.equal(await page.getByRole('link', { name: '記事を作成・管理する' }).count(), 0);
    await capture('requester-public-desktop');
  });
  await caseCheck('all-205-results-real-pagination', async () => {
    const oracle = await allApiIds(fixture.search.base);
    assert.deepEqual(new Set(oracle), new Set(fixture.ids.base));
    await open();
    await submitSearch(fixture.search.base);
    const observed = [],
      lengths = [];
    for (let n = 0; n < 11; n++) {
      const length = Math.min(20, 205 - n * 20);
      await visibleRows(length);
      await totalIs(205);
      const actual = await rowIds();
      assert.deepEqual(actual, oracle.slice(n * 20, n * 20 + length));
      observed.push(...actual);
      lengths.push(length);
      if (n === 1) secondPageHref = urlPath();
      if (n < 10) await navigate(topNav().getByRole('link', { name: '次の結果', exact: true }));
    }
    assert.equal(await topNav().getByRole('link', { name: '次の結果', exact: true }).count(), 0);
    assert.equal(new Set(observed).size, 205);
    await capture('requester-final-page');
    await navigate(topNav().getByRole('link', { name: '前の結果', exact: true }));
    assert.deepEqual(await rowIds(), oracle.slice(180, 200));
    await navigate(topNav().getByRole('link', { name: '最初の結果へ', exact: true }));
    assert.equal(new URL(page.url()).searchParams.has('cursor'), false);
    assert.deepEqual(await rowIds(), oracle.slice(0, 20));
    report.apiObservations.push({
      check: 'all-205-results',
      pages: lengths,
      distinctResults: 205,
      nativeApiOrderMatched: true,
    });
  });
  await caseCheck('second-page-detail-return-history-reload', async () => {
    assert.ok(secondPageHref);
    await open(secondPageHref);
    const ids = await rowIds();
    const detail = list().locator('h2 a').first();
    const href = await detail.getAttribute('href');
    assert.equal(new URL(href, webBase).searchParams.get('returnTo'), secondPageHref);
    await navigate(detail);
    await page.getByRole('link', { name: '元の画面へ戻る', exact: true }).waitFor();
    await capture('article-detail');
    await navigate(page.getByRole('link', { name: '元の画面へ戻る', exact: true }));
    assert.equal(urlPath(), secondPageHref);
    assert.deepEqual(await rowIds(), ids);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(urlPath(), secondPageHref);
    assert.deepEqual(await rowIds(), ids);
    await navigate(list().locator('h2 a').first());
    await page.goBack({ waitUntil: 'networkidle' });
    await visibleRows(20);
    assert.equal(urlPath(), secondPageHref);
    assert.deepEqual(await rowIds(), ids);
  });
  await caseCheck('japanese-title-tail-tags-literal-and-safe-html', async () => {
    for (const [query, expected, label] of [
      ['日本語手順', 69, 'title'],
      [fixture.search.tail, 205, 'tail'],
      ['分類タグ', 41, 'tags'],
      [fixture.search.literal, 205, 'literal'],
      [fixture.search.html, 205, 'html'],
    ]) {
      await open(searchHref(query));
      await totalIs(expected);
      await visibleRows(Math.min(20, expected));
      assert.equal((await apiList(query)).total, expected);
      if (label === 'tail') {
        assert.ok((await list().first().locator('.knowledge-excerpt').innerText()).includes(query));
        assert.ok((await list().first().locator('.knowledge-excerpt mark').count()) > 0);
        await capture('body-tail-search');
      }
      if (label === 'html') {
        assert.equal(await page.evaluate(() => window.__wp054Executed), undefined);
        assert.equal(await list().locator('script').count(), 0);
        assert.ok((await list().first().innerText()).includes('<script>'));
        await capture('literal-html-as-text');
      }
      report.apiObservations.push({
        check: 'search-' + label,
        total: expected,
        literalQueryMatched: true,
      });
    }
  });
  await caseCheck('legacy-list-default-full-body-contract', async () => {
    const result = await apiRequest(
      '/knowledge?' + new URLSearchParams({ q: fixture.search.base }),
      cookies.get(role),
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.total, 205);
    assert.equal(result.data.items.length, 100);
    assert.ok(
      result.data.items.every(
        (item) =>
          typeof item.body === 'string' &&
          item.body.includes(fixture.search.tail) &&
          typeof item.title === 'string',
      ),
    );
    report.apiObservations.push({
      check: 'legacy-default',
      total: 205,
      returned: 100,
      completeBodiesRetained: true,
    });
  });
  await caseCheck('real-requester-and-foreign-access-boundaries', async () => {
    const checks = [
      ['/knowledge?manage=1', 'requester', 403],
      ['/knowledge/' + fixture.ids.staff, 'requester', 404],
      ['/knowledge/' + fixture.ids.draft, 'requester', 404],
      ['/knowledge/' + fixture.ids.retired, 'requester', 404],
      ['/knowledge/' + fixture.ids.foreign, 'requester', 404],
      ['/knowledge/' + fixture.ids.base[0], 'foreign', 404],
    ];
    for (const [path, actor, expected] of checks)
      assert.equal((await apiRequest(path, cookies.get(actor))).status, expected);
    const publicOld = await apiRequest(
      '/knowledge/' + fixture.ids.publishedDraft,
      cookies.get('requester'),
    );
    assert.equal(publicOld.status, 200);
    assert.equal(publicOld.data.article.title, fixture.search.published);
    assert.equal((await apiList(fixture.search.unpublished, { actor: 'requester' })).total, 0);
    await open('/knowledge?manage=1');
    await expectHeading('ナレッジを探す');
    assert.equal(await page.getByRole('link', { name: '記事を作成・管理する' }).count(), 0);
    await useRole('foreign');
    await open();
    await totalIs(1);
    await visibleRows(1);
    assert.deepEqual(await rowIds(), [fixture.ids.foreign]);
    report.apiObservations.push({
      check: 'access-boundaries',
      denied: { 403: 1, 404: 5 },
      requesterManageHidden: true,
      publicPointerPreserved: true,
      foreignOrganizationOnly: true,
    });
  });
  await caseCheck('agent-admin-management-and-mode-query-retention', async () => {
    for (const actor of ['agent', 'admin']) {
      await useRole(actor);
      await open();
      await totalIs(fixture.counts.staff);
      await open(searchHref(fixture.search.base));
      await navigate(topNav().getByRole('link', { name: '次の結果', exact: true }));
      await navigate(page.getByRole('link', { name: '記事を作成・管理する', exact: true }));
      await expectHeading('ナレッジの管理');
      assert.equal(new URL(page.url()).searchParams.get('q'), fixture.search.base);
      assert.equal(new URL(page.url()).searchParams.has('cursor'), false);
      await totalIs(205);
      await navigate(page.getByRole('link', { name: '公開された記事を見る', exact: true }));
      assert.equal(new URL(page.url()).searchParams.get('q'), fixture.search.base);
      assert.equal(new URL(page.url()).searchParams.has('cursor'), false);
      await open(searchHref('', true));
      await totalIs(fixture.counts.manage);
      await capture(actor + '-manage');
      await open(searchHref(fixture.search.unpublished, true));
      await totalIs(1);
      await visibleRows(1);
      await navigate(page.getByRole('link', { name: '公開された記事を見る', exact: true }));
      await expectHeading('条件に合う記事はありません');
      await totalIs(0);
    }
  });
  await caseCheck('real-api-cursor-400-and-recovery', async () => {
    await useRole('requester');
    // Syntactically safe but semantically invalid cursor reaches the real controller.
    const path = searchHref(fixture.search.base, false, 'AAAA');
    const direct = await apiRequest(path + '&limit=20', cookies.get(role));
    assert.equal(direct.status, 400);
    await open(path);
    await expectHeading('検索条件を確認してください');
    assert.equal(await searchInput().inputValue(), fixture.search.base);
    assert.equal(await page.locator('.knowledge-result').count(), 0);
    await capture('real-cursor-400');
    await navigate(page.getByRole('link', { name: '最初の結果へ', exact: true }));
    await totalIs(205);
    await visibleRows(20);
  });
  await caseCheck('real-search-zero-and-clear', async () => {
    await open(searchHref('存在しないWP054検索語'));
    await totalIs(0);
    await expectHeading('条件に合う記事はありません');
    await capture('search-zero');
    await navigate(page.getByRole('link', { name: '条件を解除してすべて表示', exact: true }));
    await totalIs(fixture.counts.public);
  });
  await caseCheck(
    'public-and-management-unregistered-empty',
    async () => {
      await useRole('requester');
      fault = { label: 'public-empty', total: 0 };
      await open();
      await expectHeading('公開中の記事はありません');
      await totalIs(0);
      await capture('controlled-public-empty');
      await useRole('admin');
      fault = { label: 'management-empty', total: 0 };
      await open(searchHref('', true));
      await expectHeading('記事はまだ登録されていません');
      await totalIs(0);
      assert.ok(
        (await page.getByRole('link', { name: '新しい記事を書く', exact: true }).count()) > 0,
      );
      await capture('controlled-management-empty');
    },
    'controlled knowledge response; real authentication',
  );
  await caseCheck(
    'continuation-empty-keeps-total-and-first-page-recovery',
    async () => {
      await useRole('requester');
      assert.ok(secondPageHref);
      fault = { label: 'continuation-empty', total: 205 };
      await open(secondPageHref);
      await expectHeading('この取得位置に記事はありません');
      await totalIs(205);
      await capture('controlled-continuation-empty');
      fault = null;
      await navigate(page.getByRole('link', { name: '最初の結果へ', exact: true }));
      await totalIs(205);
      await visibleRows(20);
      assert.equal(new URL(page.url()).searchParams.has('cursor'), false);
      assert.equal(await searchInput().inputValue(), fixture.search.base);
    },
    'controlled continuation response followed by real recovery',
  );
  for (const [status, heading] of [
    [403, '記事を表示する権限がありません'],
    [503, '記事を読み込めませんでした'],
  ]) {
    await caseCheck(
      'knowledge-' + status + '-with-real-session-and-retry',
      async () => {
        await useRole('requester');
        const sessionReads = report.proxy.realReads.session ?? 0;
        fault = { status, label: 'knowledge-' + status };
        await open(searchHref(fixture.search.base));
        await expectHeading(heading);
        assert.equal(await searchInput().inputValue(), fixture.search.base);
        assert.equal(await page.locator('.knowledge-result').count(), 0);
        assert.ok((report.proxy.realReads.session ?? 0) > sessionReads);
        await capture('controlled-' + status);
        const listReads = report.proxy.realReads['knowledge-list'] ?? 0;
        fault = null;
        await navigate(page.getByRole('link', { name: '再読み込み', exact: true }));
        await totalIs(205);
        await visibleRows(20);
        assert.ok((report.proxy.realReads['knowledge-list'] ?? 0) > listReads);
      },
      'controlled knowledge ' + status + '; real session and recovery',
    );
  }
  await caseCheck('keyboard-search-page-detail-and-visible-focus', async () => {
    await useRole('requester');
    await open();
    await tabTo(searchInput());
    const searchFocus = await focusVisible(searchInput());
    await searchInput().fill(fixture.search.base);
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.searchParams.get('q') === fixture.search.base);
    await page.waitForLoadState('networkidle');
    await visibleRows(20);
    const next = topNav().getByRole('link', { name: '次の結果', exact: true });
    await tabTo(next);
    const pageFocus = await focusVisible(next);
    await capture('keyboard-pagination-focus');
    const href = await next.getAttribute('href');
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname + url.search === href);
    await page.waitForLoadState('networkidle');
    const detail = list().locator('h2 a').first();
    await tabTo(detail);
    const detailFocus = await focusVisible(detail),
      detailHref = await detail.getAttribute('href');
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname + url.search === detailHref);
    await page.waitForLoadState('networkidle');
    const back = page.getByRole('link', { name: '元の画面へ戻る', exact: true });
    await tabTo(back);
    const backFocus = await focusVisible(back);
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname + url.search === href);
    await page.waitForLoadState('networkidle');
    await visibleRows(20);
    report.keyboard = {
      keys: ['Tab', 'Enter'],
      searchFocus,
      pageFocus,
      detailFocus,
      backFocus,
      completeFlow: true,
    };
  });
  await caseCheck('mobile-search-detail-and-no-page-overflow', async () => {
    await useRole('requester');
    await page.setViewportSize({ width: 390, height: 844 });
    await open(searchHref(fixture.search.tail));
    await visibleRows(20);
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    assert.ok(widths.document <= widths.viewport);
    await capture('requester-mobile-390');
    await navigate(list().locator('h2 a').first());
    const detailWidths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    assert.ok(detailWidths.document <= detailWidths.viewport);
    await capture('article-mobile-390');
    await navigate(page.getByRole('link', { name: '元の画面へ戻る', exact: true }));
    await visibleRows(20);
    report.mobile = { widths, detailWidths, resultAndDetailPassed: true };
  });
}

async function prepareEvidence() {
  // Resolve every existing parent: a user-supplied output must never escape via a symlink.
  check((await realpath(evidenceRoot)) === evidenceRoot, 'KNOWLEDGE_UI_OUTPUT_INVALID');
  let parent = evidenceRoot;
  for (const segment of relative(evidenceRoot, dirname(evidence)).split('/').filter(Boolean)) {
    parent = join(parent, segment);
    await mkdir(parent, { recursive: false }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(parent);
    check(
      stat.isDirectory() && !stat.isSymbolicLink() && (await realpath(parent)) === parent,
      'KNOWLEDGE_UI_OUTPUT_INVALID',
    );
  }
  await mkdir(evidence, { recursive: false, mode: 0o700 });
}
async function cleanup() {
  const result = {
    browserClosed: true,
    childrenStopped: true,
    proxyClosed: true,
    reservationsReleased: true,
    listenersFree: true,
    tempRemoved: !tempIdentity,
    sourceUnchanged: true,
    priorNextUnchanged: true,
    database: report.cleanup.database ?? null,
  };
  try {
    await Promise.race([
      browser?.close(),
      sleep(10_000).then(() => {
        throw new Error('KNOWLEDGE_UI_CLEANUP_FAILED');
      }),
    ]);
  } catch {
    result.browserClosed = false;
  }
  for (const child of [...children].reverse()) {
    try {
      await stopChild(child);
    } catch {
      result.childrenStopped = false;
    }
  }
  result.children = children.map(({ label, pid, finished, code }) => ({
    label,
    pid,
    exited: finished,
    exitCode: code ?? null,
  }));
  if (proxy) {
    try {
      proxy.closeAllConnections();
      await Promise.race([
        new Promise((done, fail) => proxy.close((error) => (error ? fail(error) : done()))),
        sleep(5000).then(() => {
          throw new Error('KNOWLEDGE_UI_CLEANUP_FAILED');
        }),
      ]);
    } catch {
      result.proxyClosed = false;
    }
  }
  for (const reservation of reservations) {
    try {
      await reservation.release();
    } catch {
      result.reservationsReleased = false;
    }
  }
  for (const port of [apiPort, metricsPort, webPort, proxyPort].filter(Boolean)) {
    let free = false;
    for (let i = 0; i < 50; i++) {
      if (await portFree(port)) {
        free = true;
        break;
      }
      await sleep(100);
    }
    if (!free) result.listenersFree = false;
  }
  if (database) {
    try {
      result.database = await database.cleanup();
    } catch {
      result.database = { success: false, failureCode: 'KNOWLEDGE_UI_CLEANUP_FAILED' };
    }
  }
  for (const entry of report.source.files) {
    try {
      if ((await hashFile(join(root, entry.path))) !== entry.sha256) result.sourceUnchanged = false;
    } catch {
      result.sourceUnchanged = false;
    }
  }
  try {
    result.priorNextUnchanged =
      JSON.stringify(originalNext) === JSON.stringify(await nextFingerprint());
  } catch {
    result.priorNextUnchanged = false;
  }
  if (tempIdentity) {
    try {
      await assertTemp();
      await rm(tempIdentity.path, { recursive: true, force: false });
      result.tempRemoved = !(await access(tempIdentity.path).then(
        () => true,
        () => false,
      ));
    } catch {
      result.tempRemoved = false;
    }
  }
  result.success =
    result.browserClosed &&
    result.childrenStopped &&
    result.proxyClosed &&
    result.reservationsReleased &&
    result.listenersFree &&
    result.tempRemoved &&
    result.sourceUnchanged &&
    result.priorNextUnchanged &&
    (result.database?.success === true || (!database && !result.database));
  return result;
}
async function main() {
  await prepareEvidence();
  try {
    check(
      await access(chromium.executablePath()).then(
        () => true,
        () => false,
      ),
      'KNOWLEDGE_UI_BROWSER_MISSING',
    );
    originalNext = await nextFingerprint();
    await copySource();
    await compile();
    const { createKnowledgeDatabase } = await import(pathToFileURL(join(root, dbModule)).href);
    const stages = new Set([
      'database-starting',
      'database-migrations',
      'database-bootstrap',
      'database-seed',
      'knowledge-fixture',
      'database-ready',
    ]);
    database = await createKnowledgeDatabase({
      signal: abort.signal,
      onProgress: (value) => {
        if (stages.has(value)) process.stdout.write('WP054 database: ' + value + '\n');
      },
    });
    check(
      database &&
        typeof database.assertOwned === 'function' &&
        typeof database.cleanup === 'function' &&
        database.fixture?.counts?.base === 205,
      'KNOWLEDGE_UI_DB_INTERFACE_INVALID',
    );
    await own();
    report.database = database.meta;
    report.fixture.counts = database.fixture.counts;
    await startServers();
    await loginRoles();
    browser = await chromium.launch({ headless: true });
    await runChecks();
    check(report.proxy.rejectedWrites === 0 && !report.proxy.failure, 'KNOWLEDGE_UI_PROXY_FAILED');
  } catch (error) {
    report.failureCode = safeCode(error);
    if (error.cleanupReport) report.cleanup.database = error.cleanupReport;
  } finally {
    report.cleanup = await cleanup();
    clearTimeout(hardCap);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString();
    report.success =
      !report.failureCode &&
      !abort.signal.aborted &&
      !report.interrupted &&
      report.checks.length >= 15 &&
      report.checks.every((entry) => entry.passed) &&
      report.cleanup.success;
    const serialized = JSON.stringify(report, null, 2) + '\n';
    const forbidden = [
      database?.fixture?.login?.password,
      database?.appUrl,
      database?.adminUrl,
      ...cookies.values(),
    ].filter(Boolean);
    check(
      forbidden.every((value) => !serialized.includes(value)),
      'KNOWLEDGE_UI_EVIDENCE_INVALID',
    );
    await writeFile(join(evidence, 'report.json'), serialized, { flag: 'wx', mode: 0o600 });
    await writeFile(
      join(evidence, 'source-manifest.json'),
      JSON.stringify(report.source, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(
      JSON.stringify({
        success: report.success,
        checks: report.checks.length,
        failed: report.checks.filter((entry) => !entry.passed).map((entry) => entry.name),
        cleanup: report.cleanup.success,
        evidence: relative(root, evidence),
      }) + '\n',
    );
    if (!report.success) process.exitCode = 1;
  }
}
await main().catch(() => {
  process.stderr.write('KNOWLEDGE_UI_RUN_FAILED\n');
  process.exitCode = 1;
});
