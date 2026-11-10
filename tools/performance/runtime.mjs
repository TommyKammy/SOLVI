import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

// WP-P2-PERF-041..050 / ADR-0035. No external target URL or inherited DB environment is accepted.
export const POSTGRES_IMAGE =
  'postgres:16.6-alpine@sha256:1d04b9ba1d4996401f2552b51beda8187f175c0645c091e4781134fc9c9a3eef';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WP = 'WP-P2-PERF-041';
const OWNER_FILE = '.solvi-perf041-owner';
const PROTECTED_PORTS = [3000, 3001, 3080, 5433];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const digest = (value) => createHash('sha256').update(value).digest('hex');

export const LEGACY_TICKET_QUERY_BASELINE = Object.freeze({
  ref: '08a0904145a3b036ad5c36330b56e1d638e1451e',
  sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
  sourceSha256: 'f3d57ae916cd480022c5889c93cac53f2acf603503ecafa282cee2027e031ae0',
  compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-044.js',
});

export const LEGACY_USER_ADMIN_BASELINE = Object.freeze({
  ref: '035288fcb2caf0a77b74282cc56fd14c73ca79bc',
  sourcePath: 'services/api/src/modules/auth/user-admin.service.ts',
  sourceSha256: '87ae8bc42e203a0e26a8e6af264486150d9db7af21a2438235b00a358cd9d8ce',
  compiledPath: 'services/api/dist/modules/auth/user-admin.service.legacy-045.js',
});
export const LEGACY_SEARCH_QUERY_BASELINE = Object.freeze({
  ref: 'd66537ca01a6c127d3bc55a66bb75eb8a3ade8ea',
  sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
  sourceSha256: '3eba00d14e2fe1a4f14cf291ef1212ff18a20576e09f51a96a897fc249bb99f6',
  compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-046.js',
});
export const LEGACY_SEARCH_WORKLOAD_BASELINE = Object.freeze({
  ref: '15016d7326c91503a200be815e128f35b5107f13',
  sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
  sourceSha256: 'ce20b8646438c86615ef9293e34a3a2c72683ca3ffb292114fe03e5aaef3d949',
  compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-workload-047.js',
});
export const LEGACY_SEARCH_PREFIX_BASELINE = Object.freeze({
  ref: '1d5e0ec89427d4d04c496b908b2ce5abaa1d1b04',
  sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
  sourceSha256: '0ee13411051f6446ccf096e838f914e74d3ac3431718aecc85fc5e7b4da15d93',
  compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-prefix-048.js',
});
export const LEGACY_SEARCH_048_BASELINE = Object.freeze({
  ref: '1e491c998bbf71189139fa6003af2930eda14eef',
  sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
  sourceSha256: 'd6c124eb610d9e9e1e796236104b2413d475a497d8408c3ce0d023b7934eba62',
  compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-048-control-049.js',
});
export const LEGACY_SEARCH_049_BASELINE = Object.freeze({
  ref: 'a49ecbdf45047c8daa48027635649f8869e311c6',
  sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
  sourceSha256: '8b638fc7194849ba8cbe682423f8c100f9b96ca28e64bc3472f6ef22cf4691f5',
  compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-049-control-050.js',
});
export const DIRECTORY_SECURITY_FILES = Object.freeze([
  'tests/security/user-admin.test.ts',
  'tests/security/user-directory-consistency.test.ts',
]);

function check(condition, code) {
  if (!condition) throw new Error(code);
}

export function assertWorkPackage(workPackage = WP) {
  check(
    [
      'WP-P2-PERF-041',
      'WP-P2-PERF-042',
      'WP-P2-PERF-043',
      'WP-P2-PERF-044',
      'WP-P2-PERF-045',
      'WP-P2-PERF-046',
      'WP-P2-PERF-047',
      'WP-P2-PERF-048',
      'WP-P2-PERF-049',
      'WP-P2-PERF-050',
      'WP-P2-PERF-051',
      'WP-P2-PERF-053',
    ].includes(workPackage),
    'WORK_PACKAGE_NOT_ALLOWED',
  );
  return workPackage;
}

/** Never echo an underlying driver, subprocess, URL, or filesystem exception. */
export function safeFailure(error) {
  return /^[A-Z][A-Z0-9_]{2,90}$/.test(error?.message ?? '')
    ? error.message
    : 'RUNTIME_ERROR_DETAILS_SUPPRESSED';
}

export function isolatedEnvironment(source = process.env) {
  return Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
      .filter((key) => typeof source[key] === 'string')
      .map((key) => [key, source[key]]),
  );
}

/** WP050/051 diagnose fixed product bytes; neither may become a product comparison. */
export function assertSearch049ProductSource(source) {
  check(
    (typeof source === 'string' || Buffer.isBuffer(source)) &&
      digest(source) === LEGACY_SEARCH_049_BASELINE.sourceSha256,
    'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
  );
  return {
    sourcePath: LEGACY_SEARCH_049_BASELINE.sourcePath,
    sha256: LEGACY_SEARCH_049_BASELINE.sourceSha256,
    matchesFixed049: true,
  };
}

/** Re-read each time; a successful startup check cannot authorize later changed source. */
export function createSearchProductSourceGuard(workPackage, readSource) {
  assertWorkPackage(workPackage);
  check(typeof readSource === 'function', 'PRODUCT_SOURCE_READER_INVALID');
  if (!['WP-P2-PERF-050', 'WP-P2-PERF-051', 'WP-P2-PERF-053'].includes(workPackage))
    return () => undefined;
  return () => {
    let source;
    try {
      source = readSource();
    } catch {
      throw new Error('SEARCH_REPRO_PRODUCT_SOURCE_UNAVAILABLE');
    }
    return assertSearch049ProductSource(source);
  };
}

/** Fixed cgroup-v2 files only. Device identifiers and unused counters never escape. */
export function parseDatabaseResources(output) {
  check(typeof output === 'string', 'CGROUP_PAYLOAD_INVALID');
  check(Buffer.byteLength(output, 'utf8') <= 65_536, 'CGROUP_OUTPUT_TOO_LARGE');
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  check(lines.length > 0 && lines.length <= 512, 'CGROUP_PAYLOAD_INVALID');
  const cpuKeys = new Set([
    'usage_usec',
    'user_usec',
    'system_usec',
    'nr_periods',
    'nr_throttled',
    'throttled_usec',
    'nr_bursts',
    'burst_usec',
    // Linux v6.12 kernel/cgroup/rstat.c, CONFIG_SCHED_CORE optional accounting.
    'core_sched.force_idle_usec',
  ]);
  const ioKeys = new Set(['rbytes', 'wbytes', 'rios', 'wios', 'dbytes', 'dios']);
  const integer = (value) => {
    check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value), 'CGROUP_PAYLOAD_INVALID');
    const number = Number(value);
    check(Number.isSafeInteger(number) && number >= 0, 'CGROUP_PAYLOAD_INVALID');
    return number;
  };
  const cpu = {};
  const io = { rbytes: 0, wbytes: 0, rios: 0, wios: 0 };
  const devices = new Set();
  let inIo = false;
  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (/^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/.test(fields[0])) {
      inIo = true;
      check(devices.size < 256 && !devices.has(fields[0]), 'CGROUP_PAYLOAD_INVALID');
      for (const part of fields[0].split(':')) integer(part);
      devices.add(fields[0]);
      const values = {};
      for (const field of fields.slice(1)) {
        const pair = field.split('=');
        check(
          pair.length === 2 && ioKeys.has(pair[0]) && !Object.hasOwn(values, pair[0]),
          'CGROUP_PAYLOAD_INVALID',
        );
        values[pair[0]] = integer(pair[1]);
      }
      for (const key of Object.keys(io)) {
        check(
          Object.hasOwn(values, key) && Number.isSafeInteger(io[key] + values[key]),
          'CGROUP_PAYLOAD_INVALID',
        );
        io[key] += values[key];
      }
    } else {
      check(
        !inIo && fields.length === 2 && cpuKeys.has(fields[0]) && !Object.hasOwn(cpu, fields[0]),
        'CGROUP_PAYLOAD_INVALID',
      );
      cpu[fields[0]] = integer(fields[1]);
    }
  }
  check(
    ['usage_usec', 'user_usec', 'system_usec'].every((key) => Object.hasOwn(cpu, key)),
    'CGROUP_PAYLOAD_INVALID',
  );
  return {
    cpu: Object.fromEntries(
      [
        'usage_usec',
        'user_usec',
        'system_usec',
        'nr_periods',
        'nr_throttled',
        'throttled_usec',
      ].map((key) => [key, cpu[key] ?? null]),
    ),
    io,
    devices: devices.size,
  };
}

/** The runtime injects ownership/source checks and its tracked, bounded child executor. */
export function createDatabaseResourceReader({
  assertReady,
  execute,
  assertLive = () => {},
  now = () => performance.now(),
  clock = () => new Date().toISOString(),
}) {
  return async () => {
    const started = now();
    const unavailable = (reason) => ({
      available: false,
      reason,
      capturedAt: clock(),
      durationMs: now() - started,
    });
    assertLive();
    const containerId = await assertReady();
    check(/^[a-f0-9]{64}$/.test(containerId ?? ''), 'CGROUP_CONTAINER_ID_INVALID');
    assertLive();
    let result;
    try {
      result = await execute([
        'exec',
        '--user',
        'postgres',
        containerId,
        'cat',
        '/sys/fs/cgroup/cpu.stat',
        '/sys/fs/cgroup/io.stat',
      ]);
    } catch {
      assertLive();
      check((await assertReady()) === containerId, 'CGROUP_CONTAINER_CHANGED');
      assertLive();
      return unavailable('CGROUP_READ_FAILED');
    }
    assertLive();
    check((await assertReady()) === containerId, 'CGROUP_CONTAINER_CHANGED');
    assertLive();
    if (result?.outputBytes > 65_536) return unavailable('CGROUP_OUTPUT_TOO_LARGE');
    if (result?.code !== 0)
      return unavailable(result?.code === -2 ? 'CGROUP_READ_TIMEOUT' : 'CGROUP_UNAVAILABLE');
    try {
      const parsed = parseDatabaseResources(result.stdout);
      return {
        available: true,
        source: 'cgroup-v2',
        capturedAt: clock(),
        durationMs: now() - started,
        ...parsed,
      };
    } catch (error) {
      return unavailable(
        error?.message === 'CGROUP_OUTPUT_TOO_LARGE'
          ? 'CGROUP_OUTPUT_TOO_LARGE'
          : 'CGROUP_PAYLOAD_INVALID',
      );
    }
  };
}

export function assertOwnedDatabaseUrl(value, expected) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL_INVALID');
  }
  check(/^solvi_perf041_\d+_[a-f0-9]{12}$/.test(expected.database), 'DATABASE_NAME_UNSAFE');
  check(expected.database.length < 63, 'DATABASE_NAME_UNSAFE');
  check(
    Number.isSafeInteger(expected.port) && expected.port > 1024 && expected.port <= 65535,
    'DATABASE_PORT_INVALID',
  );
  check(!PROTECTED_PORTS.includes(expected.port), 'PROTECTED_PORT_FORBIDDEN');
  check(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1', 'DATABASE_HOST_UNSAFE');
  check(Number(url.port) === expected.port, 'DATABASE_PORT_MISMATCH');
  check(url.pathname === `/${expected.database}`, 'DATABASE_NAME_MISMATCH');
  check(
    url.username === expected.user && ['solvi_owner', 'solvi_app'].includes(expected.user),
    'DATABASE_USER_MISMATCH',
  );
  check(Boolean(url.password) && !url.search && !url.hash, 'DATABASE_OPTIONS_UNSAFE');
  return url.href;
}

/** Rechecked immediately before connecting, migrating, seeding, and removing the container. */
export function assertOwnedContainer(value, expected, requireRunning = true) {
  check(value?.Name === `/${expected.name}`, 'CONTAINER_NAME_MISMATCH');
  check(
    value.Config?.Labels?.['solvi.wp'] === assertWorkPackage(expected.workPackage),
    'CONTAINER_WP_MISMATCH',
  );
  check(value.Config?.Labels?.['solvi.run'] === expected.token, 'CONTAINER_TOKEN_MISMATCH');
  check(
    value.Config?.Image === POSTGRES_IMAGE && value.Image === expected.imageId,
    'CONTAINER_IMAGE_MISMATCH',
  );
  check(/^[a-f0-9]{64}$/.test(value.Id ?? ''), 'CONTAINER_ID_INVALID');
  check(!expected.id || value.Id === expected.id, 'CONTAINER_ID_MISMATCH');
  check(!(expected.protectedIds ?? []).includes(value.Id), 'PROTECTED_CONTAINER_FORBIDDEN');
  check(!requireRunning || value.State?.Running === true, 'CONTAINER_NOT_RUNNING');
  check(value.HostConfig?.NetworkMode !== 'host', 'HOST_NETWORK_FORBIDDEN');
  check(
    !value.HostConfig?.Binds?.length && value.Mounts?.every((m) => m.Type === 'tmpfs'),
    'PERSISTENT_MOUNT_FORBIDDEN',
  );
  check(Boolean(value.HostConfig?.Tmpfs?.['/var/lib/postgresql/data']), 'DATABASE_TMPFS_MISSING');
  if (requireRunning) {
    const ports = value.NetworkSettings?.Ports?.['5432/tcp'];
    check(ports?.length === 1 && ports[0].HostIp === '127.0.0.1', 'DATABASE_BIND_NOT_LOOPBACK');
    const port = Number(ports[0].HostPort);
    check(Number.isSafeInteger(port) && port > 1024 && port <= 65535, 'DATABASE_PORT_INVALID');
    check(!PROTECTED_PORTS.includes(port), 'PROTECTED_PORT_FORBIDDEN');
    check(!expected.port || port === expected.port, 'DATABASE_PORT_CHANGED');
    check(!(expected.protectedPorts ?? []).includes(port), 'PROTECTED_PORT_FORBIDDEN');
  }
  return value;
}

/** A replaced directory, symlink, or copied owner marker never authorizes recursive deletion. */
export function assertOwnedDirectory(path, identity) {
  check(path === identity.path && dirname(path) === identity.parent, 'TEMP_PATH_MISMATCH');
  check(basename(path).startsWith('solvi-perf041-'), 'TEMP_NAME_UNSAFE');
  const stat = lstatSync(path);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'TEMP_NOT_DIRECTORY');
  check(stat.dev === identity.dev && stat.ino === identity.ino, 'TEMP_IDENTITY_CHANGED');
  const marker = join(path, OWNER_FILE);
  check(!lstatSync(marker).isSymbolicLink(), 'TEMP_MARKER_SYMLINK');
  check(readFileSync(marker, 'utf8') === identity.token, 'TEMP_TOKEN_MISMATCH');
}

export function removeOwnedDirectory(identity) {
  assertOwnedDirectory(identity.path, identity);
  rmSync(identity.path, { recursive: true, force: false });
  return !existsSync(identity.path);
}

/** Compile only the pinned source into the owned copy; never write to the checkout's dist. */
export async function installLegacyTicketQuery(identity, readBaseline, assertLive = () => {}) {
  return compilePinnedTicketQuery(
    identity,
    readBaseline,
    assertLive,
    LEGACY_TICKET_QUERY_BASELINE,
    'LEGACY_TICKET_QUERY',
  );
}

export async function installLegacySearchQuery(identity, readBaseline, assertLive = () => {}) {
  return compilePinnedTicketQuery(
    identity,
    readBaseline,
    assertLive,
    LEGACY_SEARCH_QUERY_BASELINE,
    'LEGACY_SEARCH_QUERY',
  );
}

export async function installLegacySearchWorkloadQuery(
  identity,
  readBaseline,
  assertLive = () => {},
) {
  return compilePinnedTicketQuery(
    identity,
    readBaseline,
    assertLive,
    LEGACY_SEARCH_WORKLOAD_BASELINE,
    'LEGACY_SEARCH_WORKLOAD',
  );
}

async function compilePinnedTicketQuery(identity, readBaseline, assertLive, baseline, errorPrefix) {
  assertLive();
  assertOwnedDirectory(identity.path, identity);
  const source = await readBaseline();
  assertLive();
  check(
    typeof source === 'string' && digest(source) === baseline.sourceSha256,
    `${errorPrefix}_SOURCE_MISMATCH`,
  );
  const ts = (await import('typescript')).default;
  const compiled = ts.transpileModule(source, {
    fileName: 'ticket-query.ts',
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      sourceMap: false,
    },
    reportDiagnostics: true,
  });
  check(
    !compiled.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error),
    `${errorPrefix}_COMPILE_FAILED`,
  );
  assertLive();
  assertOwnedDirectory(identity.path, identity);
  // The API build must have created real directories. A replaced ancestor must not redirect writes.
  let parent = identity.path;
  for (const part of ['services', 'api', 'dist', 'modules', 'ticket']) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    check(stat.isDirectory() && !stat.isSymbolicLink(), `${errorPrefix}_PATH_UNSAFE`);
  }
  const destination = join(identity.path, baseline.compiledPath);
  check(!existsSync(destination), `${errorPrefix}_ALREADY_EXISTS`);
  writeFileSync(destination, compiled.outputText, { mode: 0o600, flag: 'wx' });
  return { ...baseline, compiledSha256: digest(compiled.outputText) };
}

export async function installLegacySearchPrefixQuery(
  identity,
  readBaseline,
  assertLive = () => {},
) {
  return compilePinnedTicketQuery(
    identity,
    readBaseline,
    assertLive,
    LEGACY_SEARCH_PREFIX_BASELINE,
    'LEGACY_SEARCH_PREFIX',
  );
}

export async function installLegacySearch048Query(identity, readBaseline, assertLive = () => {}) {
  return compilePinnedTicketQuery(
    identity,
    readBaseline,
    assertLive,
    LEGACY_SEARCH_048_BASELINE,
    'LEGACY_SEARCH_048',
  );
}

export async function installLegacySearch049Query(identity, readBaseline, assertLive = () => {}) {
  return compilePinnedTicketQuery(
    identity,
    readBaseline,
    assertLive,
    LEGACY_SEARCH_049_BASELINE,
    'LEGACY_SEARCH_049',
  );
}

/** A separate immutable source pin; callers cannot supply a ref, destination or source hash. */
export async function installLegacyUserAdmin(identity, readBaseline, assertLive = () => {}) {
  assertLive();
  assertOwnedDirectory(identity.path, identity);
  const source = await readBaseline();
  assertLive();
  check(
    typeof source === 'string' && digest(source) === LEGACY_USER_ADMIN_BASELINE.sourceSha256,
    'LEGACY_USER_ADMIN_SOURCE_MISMATCH',
  );
  const ts = (await import('typescript')).default;
  const compiled = ts.transpileModule(source, {
    fileName: 'user-admin.service.ts',
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      sourceMap: false,
    },
    reportDiagnostics: true,
  });
  check(
    !compiled.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error),
    'LEGACY_USER_ADMIN_COMPILE_FAILED',
  );
  assertLive();
  assertOwnedDirectory(identity.path, identity);
  let parent = identity.path;
  for (const part of ['services', 'api', 'dist', 'modules', 'auth']) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'LEGACY_USER_ADMIN_PATH_UNSAFE');
  }
  const destination = join(identity.path, LEGACY_USER_ADMIN_BASELINE.compiledPath);
  check(!existsSync(destination), 'LEGACY_USER_ADMIN_ALREADY_EXISTS');
  writeFileSync(destination, compiled.outputText, { mode: 0o600, flag: 'wx' });
  return { ...LEGACY_USER_ADMIN_BASELINE, compiledSha256: digest(compiled.outputText) };
}

/** SQL/parameters stay private and are used only for EXPLAIN in the caller's same transaction. */
export function bindDirectoryReader(services, isAllowedClient, assertLive = () => {}) {
  return async (variant, client, context) => {
    assertLive();
    check(['legacy', 'candidate'].includes(variant), 'DIRECTORY_VARIANT_INVALID');
    check(isAllowedClient(client), 'DIRECTORY_READ_CLIENT_NOT_OWNED');
    const Service = services[variant];
    check(typeof Service === 'function', 'DIRECTORY_SERVICE_UNAVAILABLE');
    const queries = [];
    const capture = {
      query: async (sql, params = []) => {
        assertLive();
        check(isAllowedClient(client), 'DIRECTORY_READ_CLIENT_NOT_OWNED');
        check(
          typeof sql === 'string' &&
            /^\s*SELECT\b/.test(sql) &&
            !sql.includes(';') &&
            Array.isArray(params),
          'DIRECTORY_READ_QUERY_REJECTED',
        );
        queries.push({ sql, params: structuredClone(params) });
        return client.query(sql, params);
      },
    };
    const members = await new Service(capture).listMembers(context);
    assertLive();
    check(isAllowedClient(client), 'DIRECTORY_READ_CLIENT_NOT_OWNED');
    return { members, queries };
  };
}

/** Report counts only: assertion titles, values, exception text and raw child logs are private. */
/** Remove only the known synthetic request dependency after measurements, before legacy tests. */
export async function prepareDirectorySecurityFixture(admin, database, assertLive = () => {}) {
  const failureCodes = new Set([
    'DIRECTORY_SECURITY_DATABASE_REJECTED',
    'DIRECTORY_SECURITY_DATABASE_MISMATCH',
    'DIRECTORY_SECURITY_FIXTURE_UNEXPECTED',
    'DIRECTORY_SECURITY_PREPARATION_COUNTS_INVALID',
  ]);
  let transaction = false;
  const query = async (text, values = []) => {
    assertLive();
    return admin.query({ text, values, query_timeout: 3000 });
  };
  try {
    check(
      /^solvi_perf041_\d+_[a-f0-9]{12}$/.test(database ?? ''),
      'DIRECTORY_SECURITY_DATABASE_REJECTED',
    );
    const identity = await query('SELECT current_database() AS database, current_user AS role');
    check(
      identity.rows[0]?.database === database && identity.rows[0]?.role === 'solvi_owner',
      'DIRECTORY_SECURITY_DATABASE_MISMATCH',
    );
    await query('BEGIN');
    transaction = true;
    await query("SET LOCAL statement_timeout = '3000ms'");
    const selected = await query(
      `SELECT sr.id, sr.organization_id, sr.ticket_id, sr.current_approval_id,
        sr.idempotency_key, sr.version, sr.revision, sr.state,
        (SELECT count(*)::int FROM local_service_request) AS total_requests
       FROM local_service_request sr
       JOIN local_catalog_item item ON item.id=sr.item_id AND item.organization_id=sr.organization_id
       JOIN organization org ON org.id=sr.organization_id
       WHERE item.code=$1 AND org.code=$2 FOR UPDATE OF sr`,
      ['perf041-service', 'acme'],
    );
    const request = selected.rows[0];
    check(
      selected.rows.length === 1 &&
        request.total_requests === 1 &&
        request.id === '04100000-0000-4000-8004-000000000001' &&
        request.ticket_id === '04100000-0000-4000-8002-000000000001' &&
        request.current_approval_id === '04100000-0000-4000-8005-000000000001' &&
        request.idempotency_key === request.id &&
        request.version === 1 &&
        request.revision === 1 &&
        request.state === 'pending',
      'DIRECTORY_SECURITY_FIXTURE_UNEXPECTED',
    );
    const params = [request.id, request.organization_id];
    const counts = {};
    // The request's current-approval FK is initially deferred. Delete its children
    // then its parent in one transaction, without disabling a constraint or trigger.
    for (const [table, key, expectedCount] of [
      ['local_simulation_receipt', 'simulationReceipts', 0],
      ['local_request_approval', 'requestApprovals', 1],
      ['local_request_revision', 'requestRevisions', 1],
      ['local_service_request', 'serviceRequests', 1],
    ]) {
      const idColumn = table === 'local_service_request' ? 'id' : 'request_id';
      const result = await query(
        `DELETE FROM ${table} WHERE ${idColumn}=$1 AND organization_id=$2`,
        params,
      );
      check(result.rowCount === expectedCount, 'DIRECTORY_SECURITY_PREPARATION_COUNTS_INVALID');
      counts[key] = result.rowCount;
    }
    await query('COMMIT');
    transaction = false;
    return { completed: true, counts };
  } catch (error) {
    if (transaction) {
      try {
        await admin.query({ text: 'ROLLBACK', query_timeout: 3000 });
      } catch {
        throw new Error('DIRECTORY_SECURITY_PREPARATION_ROLLBACK_FAILED');
      }
    }
    throw new Error(
      failureCodes.has(error?.message) ? error.message : 'DIRECTORY_SECURITY_PREPARATION_FAILED',
    );
  }
}

export function sanitizeDirectorySecurityResult(document, exitCode, directory) {
  const results = document?.testResults;
  check(
    Array.isArray(results) && results.length === DIRECTORY_SECURITY_FILES.length,
    'DIRECTORY_SECURITY_REPORT_INVALID',
  );
  const expected = DIRECTORY_SECURITY_FILES.map((file) => join(directory, file)).sort();
  check(
    JSON.stringify(results.map((result) => result.name).sort()) === JSON.stringify(expected),
    'DIRECTORY_SECURITY_REPORT_INVALID',
  );
  const assertions = results.flatMap((result) => {
    check(
      ['passed', 'failed'].includes(result.status) && Array.isArray(result.assertionResults),
      'DIRECTORY_SECURITY_REPORT_INVALID',
    );
    return result.assertionResults;
  });
  check(
    assertions.length > 0 &&
      assertions.every((test) =>
        ['passed', 'failed', 'pending', 'todo', 'skipped'].includes(test.status),
      ),
    'DIRECTORY_SECURITY_REPORT_INVALID',
  );
  const testFiles = {
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
  const tests = {
    passed: assertions.filter((t) => t.status === 'passed').length,
    failed: assertions.filter((t) => t.status === 'failed').length,
    pending: assertions.filter((t) => !['passed', 'failed'].includes(t.status)).length,
  };
  const success =
    exitCode === 0 && testFiles.failed === 0 && tests.failed === 0 && tests.pending === 0;
  const failures = results.flatMap((result, fileIndex) => [
    ...(result.status === 'failed' ? [{ fileIndex, kind: 'suite_failed' }] : []),
    ...result.assertionResults.flatMap((test, assertionIndex) =>
      test.status === 'passed'
        ? []
        : [
            {
              fileIndex,
              assertionIndex,
              kind: test.status === 'failed' ? 'assertion_failed' : 'assertion_not_run',
            },
          ],
    ),
  ]);
  return {
    completed: true,
    success,
    testFiles,
    tests,
    ...(success ? {} : { failureCode: 'DIRECTORY_SECURITY_TESTS_FAILED', failures }),
  };
}

export function assertServerBindings(output, servers) {
  let pid;
  const found = new Set();
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n')) continue;
    for (const server of servers)
      if (line.endsWith(`:${server.port}`)) {
        check(
          line === `n127.0.0.1:${server.port}` && pid === server.pid,
          'LISTENER_OWNERSHIP_OR_BIND_MISMATCH',
        );
        found.add(server.port);
      }
  }
  check(found.size === servers.length, 'OWNED_LISTENER_MISSING');
}

export function assertOwnedProcessGroup(members, groupId, directory) {
  check(
    Number.isSafeInteger(groupId) && groupId > 1 && groupId !== process.pid,
    'PROCESS_GROUP_ID_UNSAFE',
  );
  check(members.length > 0 && directory, 'PROCESS_GROUP_OWNERSHIP_UNKNOWN');
  for (const member of members) {
    check(
      Number.isSafeInteger(member.pid) && member.pid > 1 && member.pgid === groupId,
      'PROCESS_GROUP_ID_MISMATCH',
    );
    check(
      member.cwd === directory || member.cwd?.startsWith(directory + '/'),
      'PROCESS_GROUP_CWD_MISMATCH',
    );
  }
}

/** Keep credentials, identity, revocation and audit in the caller's existing fixture transaction. */
export function bindCredentialWriter(admin, { LocalAuthService, SessionService }, assertReady) {
  const auth = new LocalAuthService(admin, new SessionService(admin), {
    maxFailedAttempts: 5,
    lockoutSeconds: 900,
  });
  return async (params) => {
    await assertReady();
    return auth.createCredential(params);
  };
}

export const STATIC_CONTEXT_KEYS = Object.freeze([
  'agent',
  'requester',
  'other-requester',
  'foreign',
  'actor-missing',
  'deactivated',
  'expired',
  'revoked',
]);
const staticId = (kind, value) =>
  `053${kind}0000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const STATIC_ERRORS = new Set([
  'STATIC_FIXTURE_ALREADY_PREPARED',
  'STATIC_FIXTURE_NOT_FROZEN',
  'STATIC_FIXTURE_NOT_EMPTY',
  'STATIC_FIXTURE_LIMIT_EXCEEDED',
  'STATIC_FIXTURE_INVALID',
  'STATIC_FIXTURE_PREPARATION_FAILED',
  'STATIC_FIXTURE_ROLLBACK_FAILED',
  'STATIC_COLLATION_INVALID',
  'STATIC_OWNER_CLOSE_FAILED',
  'STATIC_CONTEXT_INVALID',
  'STATIC_QUERY_REQUIRED',
  'STATIC_QUERY_FAILED',
  'STATIC_PROOF_INVALID',
  'STATIC_CONTEXT_CHANGED',
  'STATIC_WRITE_PROBE_FAILED',
  'STATIC_CALLBACK_FAILED',
  'STATIC_CALLBACK_TIMEOUT',
  'STATIC_CLIENT_CLOSE_FAILED',
  'STATIC_CONNECTION_CLOSED',
  'STATIC_ABORTED',
  'RUNTIME_INTERRUPTED',
  'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
  'SEARCH_REPRO_PRODUCT_SOURCE_UNAVAILABLE',
  'CONNECTED_DATABASE_IDENTITY_MISMATCH',
]);
const staticFailure = (error) =>
  STATIC_ERRORS.has(error?.message) ? error.message : 'STATIC_CALLBACK_FAILED';

/** Fixed synthetic input; no caller-supplied rows, organization, actor or SQL are accepted. */
export function staticSearchFixtureDefinition() {
  const organizationId = staticId('0', 1);
  const controlOrganizationId = staticId('0', 2);
  const users = [
    'agent',
    'requester',
    'other-requester',
    'foreign',
    'deactivated',
    'expired',
    'revoked',
    'foreign-other',
  ].map((key, index) => ({
    key,
    id: staticId('1', index + 1),
    organizationId: key.startsWith('foreign') ? controlOrganizationId : organizationId,
    status: key === 'deactivated' ? 'deactivated' : 'active',
  }));
  const groups = [staticId('2', 1), staticId('2', 2)];
  const states = [
    'new',
    'assigned',
    'in_progress',
    'pending',
    'resolved',
    'closed',
    'cancelled',
    'merged',
    'new',
    'pending',
    'in_progress',
    'assigned',
    'new',
    'new',
    'new',
    'new',
  ];
  const createdAt = '2026-10-01T00:00:00.123456Z';
  const tickets = Array.from({ length: 4096 }, (_, i) => {
    const boundary = i < 16;
    const state = boundary ? states[i] : 'new';
    const priority = boundary ? ['medium', 'high', 'critical', 'low'][i % 4] : 'medium';
    const requester = i < 2048 ? (i % 2 ? users[2] : users[1]) : i % 2 ? users[7] : users[3];
    return {
      id: staticId('3', i + 1),
      organization_id: requester.organizationId,
      number: `TKT-${String(i).padStart(6, '0')}`,
      subject: `padding ${String(i).padStart(4, '0')}`,
      body: `static row ${String(i).padStart(4, '0')}${i === 0 ? ' qxzneedle' : ''}`,
      kind: boundary && i % 2 ? 'request' : 'incident',
      state,
      priority,
      impact: 'medium',
      urgency: 'medium',
      requester_id: requester.id,
      assignee_id: boundary && i % 3 === 0 ? users[0].id : null,
      assignee_group_id: boundary && i % 3 !== 2 ? groups[0] : null,
      created_at: createdAt,
      updated_at: createdAt,
      sla_clock_started_at: ['new', 'assigned', 'in_progress'].includes(state) ? createdAt : null,
      sla_elapsed_seconds: boundary ? (i % 2) * 1800 : 0,
      first_responded_at: boundary && i % 2 ? createdAt : null,
      resolved_at: ['resolved', 'closed'].includes(state) ? createdAt : null,
      closed_at: state === 'closed' ? createdAt : null,
      merged_into_id: state === 'merged' ? staticId('3', 1) : null,
      pending_reason: state === 'pending' ? 'wait_requester' : null,
    };
  });
  return { organizationId, controlOrganizationId, users, groups, tickets };
}

/** Runs only during owner preparation. The caller closes this owner before exposing readers. */
export async function prepareStaticSearchFixture(admin, assertReady) {
  check(typeof assertReady === 'function', 'STATIC_FIXTURE_INVALID');
  const definition = staticSearchFixtureDefinition();
  let began = false;
  try {
    await assertReady();
    const empty = await admin.query(`SELECT
      (SELECT count(*)::int FROM public.ticket) AS tickets,
      (SELECT count(*)::int FROM public.organization) AS organizations,
      (SELECT count(*)::int FROM public.app_user) AS users,
      to_regnamespace('perf053') IS NULL AS schema_absent`);
    check(
      empty.rows[0]?.tickets === 0 &&
        empty.rows[0]?.organizations === 0 &&
        empty.rows[0]?.users === 0 &&
        empty.rows[0]?.schema_absent === true,
      'STATIC_FIXTURE_NOT_EMPTY',
    );
    await admin.query('BEGIN');
    began = true;
    const environment = await admin.query(`SELECT current_setting('server_version_num') AS engine,
      current_setting('server_encoding') AS encoding, d.datlocprovider AS provider,
      d.daticulocale AS locale, d.datcollversion AS version,
      pg_database_collation_actual_version(d.oid) AS actual_version,
      c.collisdeterministic AS deterministic,
      (SELECT attcollation='pg_catalog."default"'::regcollation FROM pg_attribute
       WHERE attrelid='public.ticket'::regclass AND attname='search_text') AS ticket_default,
      transaction_timestamp() AS fixture_now
      FROM pg_database d CROSS JOIN pg_collation c
      WHERE d.datname=current_database() AND c.oid='pg_catalog."default"'::regcollation`);
    const env = environment.rows[0];
    check(
      env?.engine === '160006' &&
        env.encoding === 'UTF8' &&
        env.provider === 'i' &&
        env.locale === 'ja-JP' &&
        env.deterministic === true &&
        env.ticket_default === true &&
        typeof env.version === 'string' &&
        /^[0-9.]{1,40}$/.test(env.version) &&
        env.version === env.actual_version &&
        env.fixture_now instanceof Date &&
        Number.isFinite(env.fixture_now.getTime()),
      'STATIC_COLLATION_INVALID',
    );
    const now = env.fixture_now;
    const { organizationId, controlOrganizationId, users, groups, tickets } = definition;
    await assertReady();
    await admin.query(
      `INSERT INTO public.organization(id,code,name) VALUES
      ($1,'perf053-a','Synthetic static A'),($2,'perf053-b','Synthetic static B')`,
      [organizationId, controlOrganizationId],
    );
    await admin.query(
      `INSERT INTO public.app_user(id,display_name,status,created_via,deactivated_at)
      SELECT id,'Synthetic static '||key,status,'seed',CASE WHEN status='deactivated' THEN $2::timestamptz END
      FROM jsonb_to_recordset($1::jsonb) AS u(id uuid,key text,status text)`,
      [JSON.stringify(users), now],
    );
    const bindings = users
      .filter((u) => u.key !== 'revoked')
      .map((u, i) => ({
        id: staticId('4', i + 1),
        user_id: u.id,
        organization_id: u.organizationId,
        role_code: ['agent', 'expired', 'deactivated'].includes(u.key) ? 'agent' : 'requester',
        valid_from: new Date(now.getTime() - 172800000),
        valid_until: u.key === 'expired' ? new Date(now.getTime() - 86400000) : null,
      }));
    await admin.query(
      `INSERT INTO public.role_binding(id,user_id,role_id,role_scope,organization_id,valid_from,valid_until,source)
      SELECT b.id,b.user_id,r.id,'org',b.organization_id,b.valid_from,b.valid_until,'seed'
      FROM jsonb_to_recordset($1::jsonb) AS b(id uuid,user_id uuid,organization_id uuid,role_code text,valid_from timestamptz,valid_until timestamptz)
      JOIN public.role r ON r.code=b.role_code`,
      [JSON.stringify(bindings)],
    );
    await admin.query(
      `INSERT INTO public.assignment_group(id,organization_id,code,name) VALUES
      ($1,$3,'static-a','Synthetic group A'),($2,$4,'static-b','Synthetic group B')`,
      [...groups, organizationId, controlOrganizationId],
    );
    await admin.query(
      `INSERT INTO public.assignment_group_member(group_id,user_id,organization_id)
      VALUES($1,$2,$3)`,
      [groups[0], users[0].id, organizationId],
    );
    await admin.query(
      `INSERT INTO public.sla_policy(id,organization_id,priority,response_target_minutes,resolution_target_minutes)
      SELECT ('05350000-0000-4000-8000-'||lpad((o.n*10+p.n)::text,12,'0'))::uuid,
        o.id,p.priority,30,p.minutes
      FROM (VALUES($1::uuid,1),($2::uuid,2)) o(id,n)
      CROSS JOIN (VALUES('medium',1,240),('high',2,120),('critical',3,60)) p(priority,n,minutes)`,
      [organizationId, controlOrganizationId],
    );
    await assertReady();
    await admin.query(
      `INSERT INTO public.ticket
      (id,organization_id,number,subject,body,kind,state,priority,impact,urgency,requester_id,
       assignee_id,assignee_group_id,created_at,updated_at,sla_clock_started_at,sla_elapsed_seconds,
       first_responded_at,resolved_at,closed_at,merged_into_id,pending_reason)
      SELECT id,organization_id,number,subject,body,kind,state,priority,impact,urgency,requester_id,
       assignee_id,assignee_group_id,created_at,updated_at,sla_clock_started_at,sla_elapsed_seconds,
       first_responded_at,resolved_at,closed_at,merged_into_id,pending_reason
      FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,organization_id uuid,number text,subject text,body text,
        kind text,state text,priority text,impact text,urgency text,requester_id uuid,
        assignee_id uuid,assignee_group_id uuid,created_at timestamptz,updated_at timestamptz,
        sla_clock_started_at timestamptz,sla_elapsed_seconds integer,first_responded_at timestamptz,
        resolved_at timestamptz,closed_at timestamptz,merged_into_id uuid,pending_reason text)`,
      [JSON.stringify(tickets)],
    );
    for (const sql of [
      'CREATE SCHEMA perf053 AUTHORIZATION solvi_owner',
      'REVOKE ALL ON SCHEMA perf053 FROM PUBLIC, solvi_app',
      'GRANT USAGE ON SCHEMA perf053 TO solvi_app',
      `CREATE TABLE perf053.search_posting (
        organization_id uuid NOT NULL REFERENCES public.organization(id),
        generation integer NOT NULL CHECK(generation=1), token bytea NOT NULL,
        ticket_id uuid NOT NULL REFERENCES public.ticket(id),
        CHECK(octet_length(token)>0))`,
      'ALTER TABLE perf053.search_posting ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE perf053.search_posting FORCE ROW LEVEL SECURITY',
      `CREATE POLICY search_posting_org ON perf053.search_posting FOR SELECT TO solvi_app
        USING(organization_id=public.app_current_org())`,
      'REVOKE ALL ON perf053.search_posting FROM PUBLIC, solvi_app',
      'GRANT SELECT ON perf053.search_posting TO solvi_app',
      `CREATE UNIQUE INDEX search_posting_token_idx ON perf053.search_posting
        (organization_id,generation,token,ticket_id)`,
      `INSERT INTO perf053.search_posting(organization_id,generation,token,ticket_id)
        SELECT DISTINCT t.organization_id,1,convert_to(substring(lower(t.search_text) FROM n FOR 3),'UTF8'),t.id
        FROM public.ticket t CROSS JOIN LATERAL generate_series(1,char_length(lower(t.search_text))-2) n`,
      'ANALYZE public.ticket',
      'ANALYZE perf053.search_posting',
    ]) {
      await assertReady();
      await admin.query(sql);
    }
    const result = await admin.query(
      `SELECT
      (SELECT count(*)::int FROM public.ticket) AS tickets,
      (SELECT count(*)::int FROM perf053.search_posting) AS postings,
      (SELECT count(*)::int FROM public.app_user) AS users,
      (SELECT count(*)::int FROM public.role_binding) AS bindings,
      (SELECT max(char_length(body)) FROM public.ticket) AS max_body,
      (SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname IN ('public','perf053') AND c.relkind IN ('r','m')) AS bytes,
      (SELECT count(*)::int FROM public.ticket WHERE organization_id=$1) AS organization_tickets,
      (SELECT count(*)::int FROM public.ticket WHERE organization_id=$2) AS control_tickets,
      (SELECT bool_and(search_text=number||' '||subject||' '||body) FROM public.ticket) AS generated_correct`,
      [organizationId, controlOrganizationId],
    );
    const measured = result.rows[0];
    check(
      measured?.tickets === 4096 &&
        measured.users === 8 &&
        measured.bindings === 7 &&
        measured.organization_tickets === 2048 &&
        measured.control_tickets === 2048 &&
        measured.generated_correct === true &&
        Number.isSafeInteger(measured.postings) &&
        measured.postings > 0 &&
        measured.postings <= 1000000 &&
        Number.isSafeInteger(measured.max_body) &&
        measured.max_body <= 2048 &&
        /^\d+$/.test(measured.bytes ?? '') &&
        BigInt(measured.bytes) <= 512n * 1024n * 1024n,
      'STATIC_FIXTURE_LIMIT_EXCEEDED',
    );
    await assertReady();
    await admin.query('COMMIT');
    began = false;
    const actors = Object.fromEntries(
      users
        .filter((u) => u.key !== 'foreign-other')
        .map((u) => [
          u.key,
          {
            userId: u.id,
            context: {
              organizationId: u.organizationId,
              now,
              principal: {
                userId: u.id,
                status: u.status,
                bindings: bindings
                  .filter((b) => b.user_id === u.id)
                  .map((b) => ({
                    roleCode: b.role_code,
                    organizationId: b.organization_id,
                    validFrom: b.valid_from,
                    validUntil: b.valid_until,
                  })),
              },
            },
          },
        ]),
    );
    return {
      organizationId,
      controlOrganizationId,
      actors,
      groups,
      definitionSha256: digest(JSON.stringify(definition)),
      counts: {
        tickets: 4096,
        postings: measured.postings,
        users: 8,
        organizationTickets: 2048,
        controlTickets: 2048,
        bytes: Number(measured.bytes),
        definitionSha256: digest(JSON.stringify(definition)),
        collation: {
          provider: 'icu',
          locale: 'ja-JP',
          deterministic: true,
          version: env.version,
          actualVersion: env.actual_version,
          engine: 160006,
          encoding: 'UTF8',
        },
      },
    };
  } catch (error) {
    if (began) {
      try {
        await admin.query('ROLLBACK');
      } catch {
        throw new Error('STATIC_FIXTURE_ROLLBACK_FAILED');
      }
    }
    throw new Error(
      STATIC_ERRORS.has(error?.message) ? error.message : 'STATIC_FIXTURE_PREPARATION_FAILED',
    );
  }
}

/** WP053 only: fixed fixture keys, independent connections, no optional actor in the normal reader. */
export function createStaticReadOnlyAccess({
  createClient,
  assertReady,
  assertIdentity,
  getFixture,
  assertLive = () => {},
  signal,
  budgetMs = 120_000,
}) {
  check(
    Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 120_000,
    'STATIC_CONTEXT_INVALID',
  );
  const clients = new Set();
  let stopped = false;
  const close = (record) => {
    if (!record.closing)
      record.closing = (async () => {
        let timer;
        try {
          await Promise.race([
            record.client.end(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('STATIC_CLIENT_CLOSE_FAILED')), 5000);
            }),
          ]);
          clients.delete(record);
        } catch {
          throw new Error('STATIC_CLIENT_CLOSE_FAILED');
        } finally {
          clearTimeout(timer);
        }
      })();
    return record.closing;
  };
  const withStaticReadOnly = async (contextKey, callback) => {
    check(
      STATIC_CONTEXT_KEYS.includes(contextKey) && typeof callback === 'function',
      'STATIC_CONTEXT_INVALID',
    );
    let record,
      began = false,
      timer,
      cancelled,
      rejectInterrupted;
    const live = () => {
      check(!cancelled, cancelled ?? 'STATIC_ABORTED');
      check(!stopped && !signal?.aborted, 'STATIC_ABORTED');
      assertLive();
    };
    live();
    const interruption = new Promise((_, reject) => {
      rejectInterrupted = reject;
    });
    const cancel = (code = 'STATIC_ABORTED') => {
      cancelled = code;
      rejectInterrupted(new Error(code));
      if (record) void close(record).catch(() => {});
    };
    const abort = () => cancel();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => cancel('STATIC_CALLBACK_TIMEOUT'), budgetMs);
    try {
      return await Promise.race([
        (async () => {
          await assertReady();
          live();
          const fixture = getFixture();
          check(fixture && fixture.actors, 'STATIC_FIXTURE_NOT_FROZEN');
          const actorMissing = contextKey === 'actor-missing';
          const actor = actorMissing ? undefined : fixture.actors[contextKey];
          const organizationId = actorMissing
            ? fixture.organizationId
            : actor?.context.organizationId;
          const actorId = actor?.userId;
          const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
          check(
            uuid.test(organizationId) &&
              (actorMissing || (uuid.test(actorId) && actorId === actor.context.principal.userId)),
            'STATIC_CONTEXT_INVALID',
          );
          check(
            organizationId ===
              (contextKey === 'foreign' ? fixture.controlOrganizationId : fixture.organizationId),
            'STATIC_CONTEXT_INVALID',
          );
          record = { client: createClient(), cancel };
          clients.add(record);
          record.client.on('error', () => {});
          await record.client.connect();
          live();
          await assertIdentity(record.client);
          const verify = async () => {
            live();
            const result = await record.client.query(`SELECT current_user AS role_name,
            r.rolsuper, r.rolbypassrls,
            EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname IN ('public','perf053') AND c.relowner=r.oid) AS owns_tables,
            current_setting('transaction_read_only') AS read_only,
            current_setting('transaction_isolation') AS isolation_level,
            current_setting('row_security') AS row_security,
            current_setting('enable_seqscan') AS seqscan,
            current_setting('statement_timeout') AS statement_timeout,
            current_setting('app.current_org',true) AS organization_id,
            current_setting('app.current_actor',true) AS actor_id,
            coalesce(current_setting('app.autoclose',true),'') <> 'on' AS autoclose_disabled,
            row_security_active('public.ticket') AS ticket_rls_active,
            (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.ticket'::regclass) AS ticket_rls_forced,
            row_security_active('perf053.search_posting') AS posting_rls_active,
            (SELECT relforcerowsecurity FROM pg_class WHERE oid='perf053.search_posting'::regclass) AS posting_rls_forced,
            has_schema_privilege(current_user,'perf053','USAGE') AS schema_usage,
            has_schema_privilege(current_user,'perf053','CREATE') AS schema_create,
            has_table_privilege(current_user,'perf053.search_posting','SELECT') AS posting_select,
            has_table_privilege(current_user,'perf053.search_posting','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS posting_write,
            (SELECT atttypid='bytea'::regtype AND attcollation=0 FROM pg_attribute
             WHERE attrelid='perf053.search_posting'::regclass AND attname='token') AS token_bytea
            FROM pg_roles r WHERE r.rolname=current_user`);
            const p = result.rows[0];
            check(
              p?.role_name === 'solvi_app' &&
                p.rolsuper === false &&
                p.rolbypassrls === false &&
                p.owns_tables === false &&
                p.read_only === 'on' &&
                p.isolation_level === 'repeatable read' &&
                p.row_security === 'on' &&
                p.seqscan === 'on' &&
                p.statement_timeout === '30s' &&
                p.ticket_rls_active === true &&
                p.ticket_rls_forced === true &&
                p.posting_rls_active === true &&
                p.posting_rls_forced === true &&
                p.schema_usage === true &&
                p.schema_create === false &&
                p.posting_select === true &&
                p.posting_write === false &&
                p.token_bytea === true,
              'STATIC_PROOF_INVALID',
            );
            check(
              p.organization_id === organizationId &&
                (actorMissing ? p.actor_id === null : p.actor_id === actorId) &&
                p.autoclose_disabled === true,
              'STATIC_CONTEXT_CHANGED',
            );
            live();
          };
          const begin = async () => {
            await record.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            began = true;
            await record.client.query(
              `SELECT set_config('app.current_org',$1,true),
            set_config('statement_timeout','30000',true),set_config('lock_timeout','30000',true),
            set_config('idle_in_transaction_session_timeout','30000',true)`,
              [organizationId],
            );
            if (!actorMissing)
              await record.client.query("SELECT set_config('app.current_actor',$1,true)", [
                actorId,
              ]);
            await verify();
          };
          await begin();
          let writeRejected = false;
          try {
            await record.client.query('UPDATE public.ticket SET id=id WHERE false');
          } catch (error) {
            check(error?.code === '25006', 'STATIC_WRITE_PROBE_FAILED');
            writeRejected = true;
          }
          check(writeRejected, 'STATIC_WRITE_PROBE_FAILED');
          await record.client.query('ROLLBACK');
          began = false;
          await begin();
          const foreign =
            organizationId === fixture.organizationId
              ? fixture.controlOrganizationId
              : fixture.organizationId;
          const denied = await record.client.query(
            `SELECT
          (SELECT count(*)::int FROM public.ticket WHERE organization_id=$1) AS ticket_count,
          (SELECT count(*)::int FROM perf053.search_posting WHERE organization_id=$1) AS posting_count`,
            [foreign],
          );
          check(
            denied.rows[0]?.ticket_count === 0 && denied.rows[0]?.posting_count === 0,
            'STATIC_PROOF_INVALID',
          );
          const facade = Object.freeze({
            proof: Object.freeze({
              role: 'solvi_app',
              superuser: false,
              bypassRls: false,
              ownsTables: false,
              readOnly: true,
              isolationLevel: 'repeatable read',
              rowSecurity: true,
              ticketRlsActive: true,
              ticketRlsForced: true,
              postingRlsActive: true,
              postingRlsForced: true,
              postingSelectOnly: true,
              schemaCreateDenied: true,
              tokenByteaUncollated: true,
              actorContextPresent: !actorMissing,
              autocloseDisabled: true,
              transactionLocalContext: true,
              statementTimeoutMs: 30000,
              queryTimeoutMs: 35000,
              readOnlyWriteRejected: true,
              readOnlyWriteSqlState: '25006',
              foreignRowsDenied: true,
            }),
            query: async (sql, params = []) => {
              live();
              check(!record.closing, 'STATIC_CONNECTION_CLOSED');
              check(
                typeof sql === 'string' &&
                  Array.isArray(params) &&
                  (/^\s*SELECT\b/i.test(sql) ||
                    /^\s*EXPLAIN\s*(?:\([^)]*\)\s*)?SELECT\b/i.test(sql)) &&
                  !/\b(?:set_config|pg_advisory_lock|pg_sleep|pg_terminate_backend|pg_cancel_backend)\b/i.test(
                    sql,
                  ),
                'STATIC_QUERY_REQUIRED',
              );
              await verify();
              let value;
              try {
                value = await record.client.query({
                  text: sql,
                  values: params,
                  queryMode: 'extended',
                });
              } catch {
                throw new Error('STATIC_QUERY_FAILED');
              }
              await verify();
              return value;
            },
          });
          const result = await callback(facade);
          await verify();
          return result;
        })(),
        interruption,
      ]);
    } catch (error) {
      throw new Error(staticFailure(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (record) {
        try {
          if (began && !record.closing) await record.client.query('ROLLBACK');
        } catch {
          /* Connection closure also rolls back; a failed close remains a hard failure. */
        } finally {
          await close(record);
        }
      }
    }
  };
  return {
    withStaticReadOnly,
    closeAll: async () => {
      stopped = true;
      const owned = [...clients];
      for (const record of owned) record.cancel();
      const results = await Promise.allSettled(owned.map(close));
      return {
        success: clients.size === 0 && results.every((r) => r.status === 'fulfilled'),
        remaining: clients.size,
      };
    },
  };
}

/** Query-only callbacks cannot commit, change transaction mode, or submit multiple statements. */
export function createAppReadOnlyAccess({
  createClient,
  assertReady,
  assertIdentity,
  assertLive = () => {},
  signal,
  budgetMs = 120_000,
}) {
  check(
    Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 120_000,
    'READ_ONLY_BUDGET_INVALID',
  );
  const clients = new Set();
  let stopped = false;
  const close = (record) => {
    if (!record.closing) {
      record.closing = (async () => {
        let timer;
        try {
          await Promise.race([
            record.client.end(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('APP_CLIENT_CLOSE_TIMEOUT')), 5000);
            }),
          ]);
          clients.delete(record);
        } catch {
          throw new Error('APP_CLIENT_CLOSE_FAILED');
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    return record.closing;
  };
  const withAppReadOnly = async ({ organizationId, actorId }, callback) => {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    check(uuid.test(organizationId) && uuid.test(actorId), 'READ_ONLY_CONTEXT_INVALID');
    check(typeof callback === 'function', 'READ_ONLY_CALLBACK_INVALID');
    let record,
      connected = false,
      began = false,
      cancelled,
      timer,
      rejectInterrupted;
    const live = () => {
      check(!cancelled, cancelled ?? 'RUNTIME_INTERRUPTED');
      check(!stopped && !signal?.aborted, 'RUNTIME_INTERRUPTED');
      assertLive();
    };
    live();
    const interrupted = new Promise((_, reject) => {
      rejectInterrupted = reject;
    });
    const cancel = (code = 'RUNTIME_INTERRUPTED') => {
      cancelled = code;
      rejectInterrupted(new Error(code));
      // Ending this privately owned connection cancels its query and rolls back in PostgreSQL.
      if (record) void close(record).catch(() => {});
    };
    const aborted = () => cancel();
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => cancel('READ_ONLY_CALLBACK_TIMEOUT'), budgetMs);
    try {
      return await Promise.race([
        (async () => {
          await assertReady();
          live();
          record = { client: createClient(), cancel };
          clients.add(record);
          record.client.on('error', () => {});
          await record.client.connect();
          connected = true;
          live();
          await assertIdentity(record.client);
          live();
          const beginReadOnly = async () => {
            live();
            await record.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            began = true;
            await record.client.query(
              `SELECT set_config('app.current_org',$1,true), set_config('app.current_actor',$2,true),
             set_config('statement_timeout','30000',true), set_config('lock_timeout','30000',true),
             set_config('idle_in_transaction_session_timeout','30000',true)`,
              [organizationId, actorId],
            );
            const result = await record.client.query(`SELECT current_user AS role_name,
            rolsuper, rolbypassrls,
            EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=r.oid) AS owns_tables,
            current_setting('transaction_read_only') AS read_only,
            current_setting('transaction_isolation') AS isolation_level,
            current_setting('row_security') AS row_security,
            current_setting('app.current_org') AS organization_id,
            current_setting('app.current_actor') AS actor_id,
            row_security_active('public.ticket') AS ticket_rls_active,
            (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.ticket'::regclass) AS ticket_rls_forced
            FROM pg_roles r WHERE rolname=current_user`);
            const proof = result.rows[0];
            check(
              proof?.role_name === 'solvi_app' &&
                proof.rolsuper === false &&
                proof.rolbypassrls === false &&
                proof.owns_tables === false,
              'APPLICATION_ROLE_UNSAFE',
            );
            check(
              proof.read_only === 'on' &&
                proof.isolation_level === 'repeatable read' &&
                proof.row_security === 'on' &&
                proof.ticket_rls_active === true &&
                proof.ticket_rls_forced === true,
              'READ_ONLY_RLS_NOT_ACTIVE',
            );
            check(
              proof.organization_id === organizationId && proof.actor_id === actorId,
              'READ_ONLY_CONTEXT_MISMATCH',
            );
            live();
          };
          await beginReadOnly();
          let rejected = false;
          try {
            // Fixed false predicate guarantees zero changed rows even if a safety guard regresses.
            // This separate transaction is discarded before the actual comparison snapshot starts.
            await record.client.query('UPDATE ticket SET id=id WHERE false');
          } catch (error) {
            check(error?.code === '25006', 'READ_ONLY_WRITE_PROBE_UNEXPECTED_ERROR');
            rejected = true;
          }
          check(rejected, 'READ_ONLY_WRITE_PROBE_NOT_REJECTED');
          await record.client.query('ROLLBACK');
          began = false;
          await beginReadOnly();
          const client = Object.freeze({
            proof: Object.freeze({
              role: 'solvi_app',
              superuser: false,
              bypassRls: false,
              ownsTables: false,
              readOnly: true,
              isolationLevel: 'repeatable read',
              rowSecurity: true,
              ticketRlsActive: true,
              ticketRlsForced: true,
              transactionLocalContext: true,
              statementTimeoutMs: 30_000,
              queryTimeoutMs: 35_000,
              readOnlyWriteRejected: true,
              readOnlyWriteSqlState: '25006',
            }),
            query: async (sql, params = []) => {
              live();
              check(!record.closing, 'READ_ONLY_CONNECTION_CLOSED');
              check(
                typeof sql === 'string' &&
                  /^\s*(SELECT|EXPLAIN)\b/i.test(sql) &&
                  Array.isArray(params),
                'READ_ONLY_QUERY_REQUIRED',
              );
              // Extended protocol rejects multiple commands even for a parameterless SELECT.
              try {
                const response = await record.client.query({
                  text: sql,
                  values: params,
                  queryMode: 'extended',
                });
                live();
                return response;
              } catch (error) {
                throw new Error(safeFailure(error));
              }
            },
          });
          const value = await callback(client);
          live();
          return value;
        })(),
        interrupted,
      ]);
    } catch (error) {
      throw new Error(safeFailure(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (record) {
        try {
          if (connected && began && !record.closing) await record.client.query('ROLLBACK');
        } catch {
          // A disconnect also aborts the transaction; connection closure is still required.
        } finally {
          await close(record);
        }
      }
    }
  };
  return {
    withAppReadOnly,
    closeAll: async () => {
      stopped = true;
      const owned = [...clients];
      for (const record of owned) record.cancel();
      const results = await Promise.allSettled(owned.map(close));
      return {
        success: clients.size === 0 && results.every((r) => r.status === 'fulfilled'),
        remaining: clients.size,
      };
    },
  };
}

export async function reserveLoopbackPort(excluded = []) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const port = server.address().port;
    if (![...PROTECTED_PORTS, ...excluded].includes(port)) {
      let released = false;
      return {
        port,
        release: async () => {
          if (released) return;
          released = true;
          await new Promise((done) => server.close(done));
        },
      };
    }
    await new Promise((done) => server.close(done));
  }
  throw new Error('NO_SAFE_LOOPBACK_PORT');
}

async function probePortRelease(port) {
  const server = createServer();
  return new Promise((done) => {
    server.once('error', (error) =>
      done({
        available: false,
        code: ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(error.code)
          ? error.code
          : 'PORT_PROBE_FAILED',
      }),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => done({ available: true })));
  });
}

/** One shared deadline for all owned ports. An unavailable bind is not proof of a listener. */
export async function waitForPortRelease(
  ports,
  {
    probe = probePortRelease,
    inspect = async () => ({ available: false, listeners: [] }),
    budgetMs = 15_000,
    intervalMs = 250,
    now = Date.now,
    wait = sleep,
  } = {},
) {
  check(
    ports.length <= 4 &&
      new Set(ports).size === ports.length &&
      ports.every(
        (port) =>
          Number.isSafeInteger(port) &&
          port > 1024 &&
          port <= 65535 &&
          !PROTECTED_PORTS.includes(port),
      ),
    'PORT_RELEASE_TARGET_UNSAFE',
  );
  check(
    budgetMs > 0 && budgetMs <= 20_000 && intervalMs > 0 && intervalMs <= 1000,
    'PORT_RELEASE_BUDGET_INVALID',
  );
  const started = now();
  const result = ports.map((port) => ({ port, released: false, attempts: 0, waitedMs: 0 }));
  do {
    await Promise.all(
      result
        .filter((item) => !item.released)
        .map(async (item) => {
          let state;
          try {
            state = await probe(item.port);
          } catch {
            state = { available: false, code: 'PORT_PROBE_FAILED' };
          }
          item.attempts += 1;
          item.waitedMs = now() - started;
          item.released = state.available === true;
          if (!item.released) item.bindError = state.code ?? 'PORT_PROBE_FAILED';
          else delete item.bindError;
        }),
    );
    if (result.every((item) => item.released) || now() - started >= budgetMs) break;
    await wait(Math.min(intervalMs, budgetMs - (now() - started)));
  } while (now() - started <= budgetMs);
  const pending = result.filter((item) => !item.released);
  if (pending.length) {
    let diagnostic;
    try {
      diagnostic = await inspect(pending.map((item) => item.port));
    } catch {
      diagnostic = { available: false, listeners: [] };
    }
    for (const item of pending) {
      item.listeners = (diagnostic.listeners ?? []).filter(
        (listener) => listener.port === item.port,
      );
      item.classification = !diagnostic.available
        ? 'diagnostic_unavailable'
        : item.listeners.length
          ? 'listener_present'
          : 'bind_unavailable_without_listener';
    }
  }
  return {
    released: result.every((item) => item.released),
    budgetMs,
    elapsedMs: now() - started,
    ports: result,
  };
}

function sourceFiles(path) {
  if (!existsSync(path)) return [];
  check(!lstatSync(path).isSymbolicLink(), 'SOURCE_SYMLINK_FORBIDDEN');
  if (!lstatSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => {
      if (
        /^\.env(?:\.|$)/.test(name) ||
        ['node_modules', 'dist', '.next', '.git'].includes(name) ||
        name.endsWith('.tsbuildinfo')
      )
        return [];
      return sourceFiles(join(path, name));
    });
}

function nextFingerprint() {
  const path = join(ROOT, 'apps/web/.next');
  if (!existsSync(path)) return { exists: false };
  // Do not read or follow generated symlinks; record the original build tree's file metadata.
  const visit = (folder) =>
    readdirSync(folder)
      .sort()
      .flatMap((name) => {
        const child = join(folder, name);
        const stat = lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) return visit(child);
        return [[relative(path, child), stat.ino, stat.size, stat.mtimeMs, stat.isSymbolicLink()]];
      });
  return { exists: true, fingerprint: digest(JSON.stringify(visit(path))) };
}

function containerSnapshot(value) {
  return {
    id: value.Id,
    name: value.Name,
    image: value.Image,
    running: value.State.Running,
    startedAt: value.State.StartedAt,
    restartCount: value.RestartCount,
    ports: value.NetworkSettings.Ports,
    mounts: value.Mounts.map(({ Type, Source, Destination }) => ({ Type, Source, Destination })),
  };
}

/** Importing this module is side-effect free. Only this factory can allocate runtime resources. */
export async function createRuntime({ onProgress = () => {}, signal, workPackage = WP } = {}) {
  check(typeof onProgress === 'function', 'PROGRESS_CALLBACK_INVALID');
  assertWorkPackage(workPackage);
  const staticOnly = workPackage === 'WP-P2-PERF-053';
  const assertProductSource = createSearchProductSourceGuard(workPackage, () =>
    readFileSync(join(ROOT, LEGACY_SEARCH_049_BASELINE.sourcePath)),
  );
  const productSource = assertProductSource();
  const token = randomBytes(18).toString('hex');
  const suffix = `${Date.now()}_${token.slice(0, 12)}`;
  const expected = {
    token,
    workPackage,
    name: `solvi-perf041-${suffix.replace('_', '-')}`,
    database: `solvi_perf041_${suffix}`,
    protectedIds: [],
    protectedPorts: [],
  };
  const baseEnv = isolatedEnvironment();
  const secrets = Array.from({ length: 3 }, () => randomBytes(32).toString('hex'));
  const children = [];
  const reservations = [];
  let tempIdentity,
    admin,
    appReadOnly,
    stage = 'preflight',
    stopping = false,
    cleanupPromise;
  let attemptedCreation = false,
    sourceManifest = [],
    development = [],
    localListeners;
  const meta = {
    workPackage,
    ...(productSource ? { productSource } : {}),
    resourceNamespace: 'solvi_perf041 (legacy fixture and owner-marker compatibility)',
    startedAt: new Date().toISOString(),
    stages: [],
    image: POSTGRES_IMAGE,
    api: {
      compiled: true,
      nodeEnv: 'development',
      localAuthentication: true,
      watch: false,
      limitation:
        'Existing local-only routes require development; production API and IdP are not measured',
    },
    web: {
      productionBuild: true,
      nodeEnv: 'production',
      measurement: 'SSR, not browser rendering',
    },
    adaptations: [
      'Isolated shared package exports point to compiled dist',
      'Isolated seed imports point to compiled API dist',
      'Next standalone tracing root is /',
    ],
    excludedInputs: ['.env', '.env.*', '.next', 'dist', 'node_modules', '*.tsbuildinfo'],
    rawLogs: 'discarded; no credentials or child output in reports',
  };
  if (staticOnly) {
    meta.api = { started: false, measurement: 'not measured' };
    meta.web = { started: false, productionBuild: false, measurement: 'not measured' };
    meta.mode = 'static-database-only';
    meta.adaptations = ['Isolated shared package exports point to compiled dist'];
  }
  const live = () => check(!stopping && !signal?.aborted, 'RUNTIME_INTERRUPTED');
  const progress = (name) => {
    stage = name;
    onProgress(name);
    live();
  };

  // All subprocesses have an owned process group. Output is captured privately with a hard cap,
  // never attached to errors or returned to callers (seed includes a fixture password).
  const startChild = (
    command,
    args,
    env = baseEnv,
    cwd = ROOT,
    label = stage,
    duringCleanup = false,
  ) => {
    if (!duringCleanup) live();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = {
      child,
      label,
      pid: undefined,
      exited: false,
      stdout: '',
      stderr: '',
      bytes: 0,
    };
    children.push(record);
    record.done = new Promise((done) => {
      child.once('spawn', () => {
        record.pid = child.pid;
      });
      child.once('error', () => {
        record.exited = true;
        done({ code: -1 });
      });
      child.once('exit', (code, signal) => {
        record.exited = true;
        done({ code, signal });
      });
    });
    // Resource snapshots must consume all stdout before accepting an empty io.stat.
    record.closed = new Promise((done) => {
      child.once('close', (code, signal) => done({ code, signal }));
    });
    for (const stream of ['stdout', 'stderr'])
      child[stream].on('data', (chunk) => {
        record.bytes += chunk.length;
        if (record.bytes <= 2 * 1024 * 1024) record[stream] += chunk.toString();
      });
    return record;
  };
  const killChild = (record, signal) => {
    if (!record.pid || record.exited) return;
    // The retained ChildProcess proves this PID/group was created by this factory.
    try {
      process.kill(-record.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error('OWNED_PROCESS_STOP_FAILED');
    }
  };
  const run = async (
    command,
    args,
    env = baseEnv,
    cwd = ROOT,
    timeout = 30_000,
    duringCleanup = false,
    waitForClose = false,
  ) => {
    const record = startChild(command, args, env, cwd, stage, duringCleanup);
    let timer;
    const result = await Promise.race([
      waitForClose ? record.closed : record.done,
      new Promise((done) => {
        timer = setTimeout(() => {
          killChild(record, 'SIGKILL');
          done({ code: -2 });
        }, timeout);
      }),
    ]);
    clearTimeout(timer);
    if (!duringCleanup) live();
    return { ...result, stdout: record.stdout, stderr: record.stderr, outputBytes: record.bytes };
  };
  const inspect = async (target, duringCleanup = false, timeout = 30_000) => {
    const result = await run('docker', ['inspect', target], baseEnv, ROOT, timeout, duringCleanup);
    check(result.code === 0, 'CONTAINER_INSPECTION_FAILED');
    try {
      return JSON.parse(result.stdout)[0];
    } catch {
      throw new Error('CONTAINER_INSPECTION_INVALID');
    }
  };
  const owned = async (running = true, duringCleanup = false) =>
    assertOwnedContainer(
      await inspect(expected.id ?? expected.name, duringCleanup),
      expected,
      running,
    );
  const url = (user) => {
    const value = new URL(`postgresql://127.0.0.1:${expected.port}/${expected.database}`);
    value.username = user;
    value.password = secrets[user === 'solvi_owner' ? 0 : 1];
    return assertOwnedDatabaseUrl(value.href, { ...expected, user });
  };
  const databaseIdentity = async (client, user) => {
    await owned();
    const result = await client.query('SELECT current_database() AS db, current_user AS usr');
    check(
      result.rows[0].db === expected.database && result.rows[0].usr === user,
      'CONNECTED_DATABASE_IDENTITY_MISMATCH',
    );
  };
  const stageCommand = async (name, command, args, env, cwd, timeout = 120_000) => {
    progress(name);
    const started = Date.now();
    const result = await run(command, args, env, cwd, timeout);
    meta.stages.push({ stage: name, durationMs: Date.now() - started, exitCode: result.code });
    check(result.code === 0, `${name.toUpperCase().replaceAll('-', '_')}_FAILED`);
  };
  const snapshotListeners = async (duringCleanup = false) => {
    const result = await run(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
      baseEnv,
      ROOT,
      30_000,
      duringCleanup,
    );
    check(result.code === 0 || result.code === 1, 'LISTENER_INSPECTION_FAILED');
    let pid, command;
    const rows = [];
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      if (line.startsWith('c')) command = line.slice(1);
      if (line.startsWith('n')) {
        const port = Number(line.match(/:(\d+)$/)?.[1]);
        if (PROTECTED_PORTS.includes(port)) rows.push({ pid, command, port });
      }
    }
    for (const row of rows) {
      const identity = await run(
        'ps',
        ['-p', String(row.pid), '-o', 'lstart='],
        baseEnv,
        ROOT,
        10_000,
        duringCleanup,
      );
      check(identity.code === 0 && identity.stdout.trim(), 'LISTENER_IDENTITY_UNAVAILABLE');
      row.startedAt = identity.stdout.trim();
    }
    return rows.sort((a, b) => a.port - b.port || a.pid - b.pid);
  };

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      stopping = true;
      const result = {
        processesStopped: true,
        appClientsClosed: true,
        containerRemoved: !attemptedCreation,
        tempRemoved: !tempIdentity,
        listenersFree: true,
        developmentUnchanged: true,
        sourceUnchanged: true,
        originalNextUnchanged: true,
        failures: [],
      };
      const fail = (code) => result.failures.push(code);
      if (appReadOnly) {
        const closed = await appReadOnly.closeAll();
        result.appClientsClosed = closed.success;
        result.remainingAppClients = closed.remaining;
        if (!closed.success) fail('APP_CLIENT_CLEANUP_FAILED');
      }
      try {
        const initialChildren = [...children];
        const groups = new Set(initialChildren.map((child) => child.pid).filter(Boolean));
        for (const reservation of reservations) await reservation.release();
        for (const record of initialChildren) killChild(record, 'SIGTERM');
        await Promise.race([Promise.all(initialChildren.map((c) => c.done)), sleep(5000)]);
        for (const record of initialChildren) killChild(record, 'SIGKILL');
        await Promise.race([Promise.all(initialChildren.map((c) => c.done)), sleep(2000)]);
        const remainingGroups = async () => {
          if (!groups.size) return [];
          const processes = await run('ps', ['-axo', 'pid=,pgid='], baseEnv, ROOT, 10_000, true);
          check(processes.code === 0, 'PROCESS_GROUP_INSPECTION_FAILED');
          return processes.stdout
            .trim()
            .split('\n')
            .map((line) => {
              const [pid, pgid] = line.trim().split(/\s+/).map(Number);
              return { pid, pgid };
            })
            .filter((process) => groups.has(process.pgid));
        };
        const remaining = await remainingGroups();
        for (const groupId of new Set(remaining.map((process) => process.pgid))) {
          const members = remaining.filter((process) => process.pgid === groupId);
          for (const member of members) {
            const cwd = await run(
              'lsof',
              ['-a', '-p', String(member.pid), '-d', 'cwd', '-Fn'],
              baseEnv,
              ROOT,
              10_000,
              true,
            );
            check(cwd.code === 0, 'PROCESS_CWD_INSPECTION_FAILED');
            member.cwd = cwd.stdout
              .split('\n')
              .find((line) => line.startsWith('n'))
              ?.slice(1);
          }
          assertOwnedProcessGroup(members, groupId, tempIdentity?.path);
          try {
            process.kill(-groupId, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw new Error('OWNED_PROCESS_GROUP_STOP_FAILED');
          }
        }
        if (remaining.length) await sleep(250);
        result.processesStopped =
          initialChildren.every((c) => c.exited) && !(await remainingGroups()).length;
        if (!result.processesStopped) fail('OWNED_PROCESSES_REMAIN');
      } catch {
        result.processesStopped = false;
        fail('PROCESS_CLEANUP_FAILED');
      }
      try {
        if (admin)
          await Promise.race([
            admin.end(),
            sleep(5000).then(() => {
              throw new Error('ADMIN_CLOSE_TIMEOUT');
            }),
          ]);
      } catch {
        fail('ADMIN_CLOSE_FAILED');
      }
      if (attemptedCreation) {
        try {
          const container = await owned(false, true);
          const removed = await run(
            'docker',
            ['rm', '-f', container.Id],
            baseEnv,
            ROOT,
            30_000,
            true,
          );
          const remaining = await run(
            'docker',
            ['ps', '-a', '--filter', `id=${container.Id}`, '--format', '{{.ID}}'],
            baseEnv,
            ROOT,
            30_000,
            true,
          );
          result.containerRemoved =
            removed.code === 0 && remaining.code === 0 && !remaining.stdout.trim();
          if (!result.containerRemoved) fail('OWNED_CONTAINER_REMAINS');
        } catch {
          fail('CONTAINER_CLEANUP_REFUSED_OR_FAILED');
        }
      }
      try {
        for (const original of development) {
          const after = containerSnapshot(await inspect(original.id, true));
          if (JSON.stringify(after) !== JSON.stringify(original))
            result.developmentUnchanged = false;
        }
        if (
          localListeners &&
          JSON.stringify(await snapshotListeners(true)) !== JSON.stringify(localListeners)
        )
          result.developmentUnchanged = false;
        if (!result.developmentUnchanged) fail('EXISTING_RUNTIME_CHANGED');
      } catch {
        result.developmentUnchanged = false;
        fail('EXISTING_RUNTIME_CHECK_FAILED');
      }
      result.portRelease = await waitForPortRelease(
        [expected.port, ...reservations.map((r) => r.port)].filter(Boolean),
        {
          // Shared 15-second release budget + one bounded two-second diagnostic, not per port.
          inspect: async (ports) => {
            const snapshot = await run(
              'lsof',
              ['-nP', ...ports.map((port) => `-iTCP:${port}`), '-sTCP:LISTEN', '-Fpcn'],
              baseEnv,
              ROOT,
              2000,
              true,
            );
            const listeners = [];
            let pid, command;
            for (const line of snapshot.stdout.split('\n')) {
              if (line.startsWith('p')) pid = Number(line.slice(1));
              if (line.startsWith('c')) command = line.slice(1);
              if (line.startsWith('n')) {
                const port = Number(line.match(/:(\d+)$/)?.[1]);
                if (ports.includes(port))
                  listeners.push({ port, pid, command, address: line.slice(1) });
              }
            }
            return { available: snapshot.code === 0 || snapshot.code === 1, listeners };
          },
        },
      );
      result.listenersFree = result.portRelease.released;
      if (!result.listenersFree)
        fail(
          result.portRelease.ports.some((port) => port.classification === 'listener_present')
            ? 'PORT_LISTENER_PRESENT'
            : 'PORT_RELEASE_NOT_CONFIRMED',
        );
      try {
        result.sourceUnchanged = sourceManifest.every(
          ({ path, sha256 }) =>
            existsSync(join(ROOT, path)) && digest(readFileSync(join(ROOT, path))) === sha256,
        );
        result.originalNextUnchanged =
          !meta.originalNext ||
          JSON.stringify(nextFingerprint()) === JSON.stringify(meta.originalNext);
        if (!result.sourceUnchanged) fail('SOURCE_CHANGED_DURING_RUN');
        if (!result.originalNextUnchanged) fail('EXISTING_NEXT_CHANGED_DURING_RUN');
      } catch {
        result.sourceUnchanged = false;
        fail('SOURCE_RECHECK_FAILED');
      }
      if (tempIdentity && !result.processesStopped) {
        fail('TEMP_KEPT_FOR_PROCESS_RECOVERY');
      } else if (tempIdentity) {
        try {
          result.tempRemoved = removeOwnedDirectory(tempIdentity);
          if (!result.tempRemoved) fail('OWNED_TEMP_REMAINS');
        } catch {
          fail('TEMP_CLEANUP_REFUSED_OR_FAILED');
        }
      }
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      signal?.removeEventListener('abort', aborted);
      result.success =
        result.failures.length === 0 && result.containerRemoved && result.tempRemoved;
      meta.cleanup = result;
      meta.finishedAt = new Date().toISOString();
      return result;
    })();
    return cleanupPromise;
  }
  const aborted = () => {
    if (stopping) return;
    stopping = true;
    meta.interrupted = true;
    void cleanup();
  };
  const interrupted = () => {
    process.exitCode = 130;
    aborted();
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  signal?.addEventListener('abort', aborted, { once: true });

  try {
    progress('preflight');
    for (const file of [
      'node_modules/typescript/bin/tsc',
      ...(staticOnly ? [] : ['node_modules/next/dist/bin/next']),
    ])
      check(existsSync(join(ROOT, file)), 'REQUIRED_DEPENDENCY_NOT_INSTALLED');
    const cached = await run('docker', ['image', 'inspect', POSTGRES_IMAGE]);
    check(cached.code === 0, 'PINNED_IMAGE_NOT_CACHED');
    const image = JSON.parse(cached.stdout)[0];
    check(
      image.RepoDigests?.includes(POSTGRES_IMAGE.replace('postgres:16.6-alpine', 'postgres')),
      'PINNED_IMAGE_DIGEST_MISMATCH',
    );
    expected.imageId = image.Id;
    meta.imageId = image.Id;
    const existing = await run('docker', [
      'ps',
      '-a',
      '--filter',
      'label=com.docker.compose.project=solvi',
      '--format',
      '{{.ID}}',
    ]);
    check(existing.code === 0, 'EXISTING_CONTAINERS_UNAVAILABLE');
    for (const id of existing.stdout.trim().split('\n').filter(Boolean))
      development.push(containerSnapshot(await inspect(id)));
    expected.protectedIds = development.map((c) => c.id);
    expected.protectedPorts = development.flatMap((c) =>
      Object.values(c.ports)
        .flat()
        .filter(Boolean)
        .map((p) => Number(p.HostPort)),
    );
    localListeners = await snapshotListeners();
    meta.developmentBefore = development;
    meta.existingListeners = localListeners;
    meta.originalNext = nextFingerprint();
    const revision = await run('git', ['rev-parse', 'HEAD']);
    check(
      revision.code === 0 && /^[a-f0-9]{40}\s*$/.test(revision.stdout),
      'SOURCE_REVISION_UNAVAILABLE',
    );
    meta.sourceRevision = revision.stdout.trim();

    progress('copy-source');
    const tempParent = realpathSync(tmpdir());
    const directory = mkdtempSync(join(tempParent, 'solvi-perf041-'));
    const stat = lstatSync(directory);
    tempIdentity = { path: directory, parent: tempParent, dev: stat.dev, ino: stat.ino, token };
    meta.tempDirectory = directory;
    writeFileSync(join(directory, OWNER_FILE), token, { mode: 0o600, flag: 'wx' });
    const inputs = [
      'package.json',
      'package-lock.json',
      'tsconfig.base.json',
      'packages/shared',
      'services/api',
      'apps/web',
      'db/migrations',
      'tools/migrate.mjs',
      'tools/bootstrap_roles.mjs',
      'tools/seed.mjs',
      'tools/performance',
      ...(workPackage === 'WP-P2-PERF-045'
        ? ['tsconfig.json', 'vitest.config.ts', 'tests/support', ...DIRECTORY_SECURITY_FILES]
        : []),
    ];
    for (const input of inputs)
      for (const path of sourceFiles(join(ROOT, input))) {
        const name = relative(ROOT, path),
          destination = join(directory, name);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(path, destination);
        const sha256 = digest(readFileSync(path));
        check(digest(readFileSync(destination)) === sha256, 'SOURCE_COPY_MISMATCH');
        sourceManifest.push({ path: name, sha256 });
      }
    meta.sourceFiles = sourceManifest;
    meta.sourceManifestSha256 = digest(JSON.stringify(sourceManifest));
    if (productSource) {
      assertProductSource();
      assertSearch049ProductSource(
        readFileSync(join(directory, LEGACY_SEARCH_049_BASELINE.sourcePath)),
      );
    }
    // Dependencies stay read-only in the original checkout. Local workspace packages resolve
    // to the copy, never through the original @solvi symlink back to src or dist.
    const linkDependencies = (origin, target) => {
      if (!existsSync(origin)) return;
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(origin)) {
        if (name === '@solvi' || name === '.cache') continue;
        symlinkSync(join(origin, name), join(target, name));
      }
      mkdirSync(join(target, '@solvi'), { recursive: true });
      symlinkSync(join(directory, 'packages/shared'), join(target, '@solvi/shared'));
    };
    linkDependencies(join(ROOT, 'node_modules'), join(directory, 'node_modules'));
    for (const workspace of ['packages/shared', 'services/api', 'apps/web'])
      linkDependencies(
        join(ROOT, workspace, 'node_modules'),
        join(directory, workspace, 'node_modules'),
      );
    const buildEnv = {
      ...baseEnv,
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      OTEL_TRACES_EXPORTER: 'none',
    };
    const tsc = join(directory, 'node_modules/typescript/bin/tsc');
    await stageCommand(
      'build-shared',
      process.execPath,
      [tsc, '-p', 'packages/shared/tsconfig.json'],
      buildEnv,
      directory,
    );
    const sharedPackagePath = join(directory, 'packages/shared/package.json');
    const sharedPackage = JSON.parse(readFileSync(sharedPackagePath, 'utf8'));
    sharedPackage.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.js' };
    writeFileSync(sharedPackagePath, JSON.stringify(sharedPackage, null, 2) + '\n');
    await stageCommand(
      'build-api',
      process.execPath,
      [tsc, '-p', 'services/api/tsconfig.json'],
      buildEnv,
      directory,
    );
    if (workPackage === 'WP-P2-PERF-044') {
      progress('compile-legacy-ticket-query');
      meta.legacyTicketQuery = await installLegacyTicketQuery(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_TICKET_QUERY_BASELINE.ref}:${LEGACY_TICKET_QUERY_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_TICKET_QUERY_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (workPackage === 'WP-P2-PERF-046') {
      progress('compile-legacy-search-query');
      meta.legacySearchQuery = await installLegacySearchQuery(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_SEARCH_QUERY_BASELINE.ref}:${LEGACY_SEARCH_QUERY_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_SEARCH_QUERY_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (['WP-P2-PERF-047', 'WP-P2-PERF-048', 'WP-P2-PERF-049'].includes(workPackage)) {
      progress('compile-legacy-search-workload');
      meta.legacySearchWorkload = await installLegacySearchWorkloadQuery(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_SEARCH_WORKLOAD_BASELINE.ref}:${LEGACY_SEARCH_WORKLOAD_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_SEARCH_WORKLOAD_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (workPackage === 'WP-P2-PERF-048' || workPackage === 'WP-P2-PERF-049') {
      progress('compile-legacy-search-prefix');
      meta.legacySearchPrefix = await installLegacySearchPrefixQuery(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_SEARCH_PREFIX_BASELINE.ref}:${LEGACY_SEARCH_PREFIX_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_SEARCH_PREFIX_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (workPackage === 'WP-P2-PERF-049' || workPackage === 'WP-P2-PERF-050') {
      progress('compile-legacy-search-048');
      meta.legacySearch048 = await installLegacySearch048Query(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_SEARCH_048_BASELINE.ref}:${LEGACY_SEARCH_048_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_SEARCH_048_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (workPackage === 'WP-P2-PERF-050') {
      progress('compile-legacy-search-049');
      meta.legacySearch049 = await installLegacySearch049Query(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_SEARCH_049_BASELINE.ref}:${LEGACY_SEARCH_049_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_SEARCH_049_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (workPackage === 'WP-P2-PERF-045') {
      progress('compile-legacy-user-admin');
      meta.legacyUserAdmin = await installLegacyUserAdmin(
        tempIdentity,
        async () => {
          const baseline = await run('git', [
            'show',
            `${LEGACY_USER_ADMIN_BASELINE.ref}:${LEGACY_USER_ADMIN_BASELINE.sourcePath}`,
          ]);
          check(baseline.code === 0, 'LEGACY_USER_ADMIN_SOURCE_UNAVAILABLE');
          return baseline.stdout;
        },
        live,
      );
    }
    if (!staticOnly) {
      const seedPath = join(directory, 'tools/seed.mjs');
      writeFileSync(
        seedPath,
        readFileSync(seedPath, 'utf8').replaceAll('../services/api/src/', '../services/api/dist/'),
      );
      const nextConfig = join(directory, 'apps/web/next.config.mjs');
      writeFileSync(
        nextConfig,
        readFileSync(nextConfig, 'utf8') + '\nnextConfig.outputFileTracingRoot = "/";\n',
      );
      await stageCommand(
        'build-web',
        process.execPath,
        [join(directory, 'node_modules/next/dist/bin/next'), 'build'],
        { ...buildEnv, NODE_ENV: 'production' },
        join(directory, 'apps/web'),
        300_000,
      );
      meta.build = {
        shared: 'tsc',
        api: 'tsc / node dist/main.js',
        web: 'next build / next start',
      };
    } else {
      meta.build = { shared: 'tsc', api: 'tsc; query builder only', web: 'not built' };
    }

    progress('create-database');
    const occupied = await run('docker', [
      'ps',
      '-a',
      '--filter',
      `name=^/${expected.name}$`,
      '--format',
      '{{.ID}}',
    ]);
    check(occupied.code === 0 && !occupied.stdout.trim(), 'OWNED_NAME_ALREADY_EXISTS');
    attemptedCreation = true;
    const created = await run(
      'docker',
      [
        'run',
        '--detach',
        '--pull=never',
        '--name',
        expected.name,
        '--label',
        `solvi.wp=${workPackage}`,
        '--label',
        `solvi.run=${token}`,
        '--publish',
        '127.0.0.1::5432',
        '--tmpfs',
        '/var/lib/postgresql/data:rw,noexec,nosuid,size=1g',
        '--memory',
        '1536m',
        '--cpus',
        '2',
        '--env',
        'POSTGRES_USER=solvi_owner',
        '--env',
        `POSTGRES_DB=${expected.database}`,
        '--env',
        'POSTGRES_PASSWORD',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        '--env',
        'POSTGRES_INITDB_ARGS=--locale-provider=icu --icu-locale=ja-JP --encoding=UTF8',
        POSTGRES_IMAGE,
      ],
      { ...baseEnv, POSTGRES_PASSWORD: secrets[0] },
      ROOT,
      30_000,
    );
    check(created.code === 0 && /^[a-f0-9]{64}\s*$/.test(created.stdout), 'DATABASE_CREATE_FAILED');
    expected.id = created.stdout.trim();
    const instance = await owned();
    expected.port = Number(instance.NetworkSettings.Ports['5432/tcp'][0].HostPort);
    await owned();
    meta.database = expected.database;
    meta.databaseRuntime = {
      name: expected.database,
      port: expected.port,
      containerId: expected.id,
      cpuLimit: 2,
      memoryMiB: 1536,
      tmpfsMiB: 1024,
      bindHost: '127.0.0.1',
    };
    let connected = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      live();
      const candidate = new pg.Client({
        connectionString: url('solvi_owner'),
        connectionTimeoutMillis: 1000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
      });
      candidate.on('error', () => {});
      try {
        await candidate.connect();
        await databaseIdentity(candidate, 'solvi_owner');
        admin = candidate;
        connected = true;
        break;
      } catch {
        await candidate.end().catch(() => undefined);
        await sleep(250);
      }
    }
    check(connected, 'OWNED_DATABASE_NOT_READY');
    const empty = await admin.query(
      "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'",
    );
    check(empty.rows[0].n === 0, 'NEW_DATABASE_NOT_EMPTY');
    const dbEnv = {
      ...baseEnv,
      NODE_ENV: 'test',
      DATABASE_ADMIN_URL: url('solvi_owner'),
      DATABASE_URL: url('solvi_app'),
    };
    for (const [name, script, extra, args] of [
      ['migrate', 'tools/migrate.mjs', {}, ['up']],
      [
        'bootstrap-roles',
        'tools/bootstrap_roles.mjs',
        { POSTGRES_APP_PASSWORD: secrets[1], POSTGRES_EXECUTOR_PASSWORD: secrets[2] },
        [],
      ],
      ...(staticOnly ? [] : [['seed', 'tools/seed.mjs', {}, []]]),
    ]) {
      await databaseIdentity(admin, 'solvi_owner');
      await stageCommand(
        name,
        process.execPath,
        [join(directory, script), ...args],
        { ...dbEnv, ...extra },
        directory,
      );
    }
    const app = new pg.Client({
      connectionString: url('solvi_app'),
      connectionTimeoutMillis: 5000,
    });
    try {
      await app.connect();
      await databaseIdentity(app, 'solvi_app');
      const role = await app.query(`SELECT rolsuper,rolbypassrls,
        EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns_tables
        FROM pg_roles WHERE rolname=current_user`);
      check(
        !role.rows[0].rolsuper && !role.rows[0].rolbypassrls && !role.rows[0].owns_tables,
        'APPLICATION_ROLE_UNSAFE',
      );
      meta.appRole = { name: 'solvi_app', superuser: false, bypassRls: false, ownsTables: false };
    } finally {
      await app.end();
    }
    if (staticOnly) {
      assertProductSource();
      assertSearch049ProductSource(
        readFileSync(join(directory, LEGACY_SEARCH_049_BASELINE.sourcePath)),
      );
      const { buildListQuery } = await import(
        pathToFileURL(join(directory, 'services/api/dist/modules/ticket/ticket-query.js')).href
      );
      check(typeof buildListQuery === 'function', 'TICKET_QUERY_BUILDER_UNAVAILABLE');
      let prepared = false;
      let fixture;
      appReadOnly = createStaticReadOnlyAccess({
        signal,
        assertLive: live,
        getFixture: () => fixture,
        assertReady: async () => {
          live();
          assertProductSource();
          check(prepared && fixture && !admin, 'STATIC_FIXTURE_NOT_FROZEN');
          await owned();
        },
        assertIdentity: (client) => databaseIdentity(client, 'solvi_app'),
        createClient: () =>
          new pg.Client({
            connectionString: url('solvi_app'),
            connectionTimeoutMillis: 5000,
            statement_timeout: 30_000,
            query_timeout: 35_000,
            options: '-c default_transaction_read_only=on',
          }),
      });
      progress('database-ready');
      return {
        meta,
        cleanup,
        prepareStaticFixture: async () => {
          check(!prepared, 'STATIC_FIXTURE_ALREADY_PREPARED');
          prepared = true;
          try {
            progress('prepare-static-fixture');
            fixture = await prepareStaticSearchFixture(admin, async () => {
              live();
              assertProductSource();
              await databaseIdentity(admin, 'solvi_owner');
            });
            const owner = admin;
            await Promise.race([
              owner.end(),
              sleep(5000).then(() => {
                throw new Error('STATIC_OWNER_CLOSE_FAILED');
              }),
            ]);
            admin = undefined;
            meta.staticFixture = { ...fixture.counts, ownerClosed: true, frozen: true };
            progress('fixture-ready');
            return structuredClone(fixture);
          } catch (error) {
            throw new Error(staticFailure(error));
          }
        },
        withStaticReadOnly: appReadOnly.withStaticReadOnly,
        buildTicketListQuery: (context, options) => {
          live();
          assertProductSource();
          return buildListQuery(context, options);
        },
      };
    }
    meta.seed = {
      organizations: (await admin.query('SELECT id,code FROM organization ORDER BY code')).rows,
      users: (
        await admin.query(`SELECT u.id,array_agg(DISTINCT r.code) AS roles FROM app_user u
        JOIN role_binding b ON b.user_id=u.id JOIN role r ON r.id=b.role_id GROUP BY u.id ORDER BY u.id`)
      ).rows,
    };

    progress('start-api');
    for (let index = 0; index < 3; index += 1)
      reservations.push(
        await reserveLoopbackPort([
          expected.port,
          ...expected.protectedPorts,
          ...reservations.map((r) => r.port),
        ]),
      );
    const [apiPort, webPort, metricsPort] = reservations.map((r) => r.port);
    const apiBase = `http://127.0.0.1:${apiPort}`,
      webBase = `http://127.0.0.1:${webPort}`;
    const metricsBase = `http://127.0.0.1:${metricsPort}`;
    await reservations[0].release();
    await reservations[2].release();
    const apiChild = startChild(
      process.execPath,
      [join(directory, 'services/api/dist/main.js')],
      {
        ...baseEnv,
        NODE_ENV: 'development',
        DATABASE_URL: url('solvi_app'),
        API_PORT: String(apiPort),
        API_HOST: '127.0.0.1',
        METRICS_PORT: String(metricsPort),
        METRICS_HOST: '127.0.0.1',
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_SERVICE_NAMESPACE: 'solvi-perf041',
        LOG_LEVEL: 'error',
        PG_POOL_MAX: '10',
        AUTH_LOCAL_ENABLED: 'true',
        SESSION_COOKIE_SECURE: 'false',
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_REGION: 'local',
        S3_BUCKET_ATTACHMENTS: 'perf041-unused',
        S3_BUCKET_AUDIT_ANCHOR: 'perf041-unused',
        S3_ACCESS_KEY: secrets[1],
        S3_SECRET_KEY: secrets[2],
      },
      directory,
      'api',
    );
    const waitHttp = async (base, path, child, accept) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        live();
        check(!child.exited, 'OWNED_SERVER_EXITED');
        try {
          const response = await fetch(base + path, {
            redirect: 'manual',
            signal: AbortSignal.timeout(1000),
          });
          const body = await response.text();
          if (accept(response, body)) return;
        } catch {
          /* Startup is bounded; raw network errors are private. */
        }
        await sleep(250);
      }
      throw new Error('OWNED_SERVER_NOT_READY');
    };
    await waitHttp(
      apiBase,
      '/readyz',
      apiChild,
      (res, body) => res.status === 200 && JSON.parse(body).status === 'ready',
    );
    await waitHttp(
      metricsBase,
      '/metrics',
      apiChild,
      (res, body) => res.status === 200 && body.includes('#'),
    );
    progress('start-web');
    await reservations[1].release();
    const webChild = startChild(
      process.execPath,
      [
        join(directory, 'node_modules/next/dist/bin/next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(webPort),
      ],
      { ...baseEnv, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', API_BASE_URL: apiBase },
      join(directory, 'apps/web'),
      'web',
    );
    await waitHttp(
      webBase,
      '/login',
      webChild,
      (res, body) => res.status === 200 && body.includes('<html'),
    );
    // Verify ownership after releasing probe sockets: a race must fail rather than hit another server.
    const listeners = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    check(listeners.code === 0, 'OWNED_LISTENERS_UNAVAILABLE');
    assertServerBindings(listeners.stdout, [
      { port: apiPort, pid: apiChild.pid },
      { port: metricsPort, pid: apiChild.pid },
      { port: webPort, pid: webChild.pid },
    ]);
    meta.listeners = {
      api: { port: apiPort, pid: apiChild.pid },
      web: { port: webPort, pid: webChild.pid },
      metrics: { port: metricsPort, pid: apiChild.pid },
      bindHost: '127.0.0.1',
    };
    meta.readyAt = new Date().toISOString();
    const { LocalAuthService } = await import(
      pathToFileURL(join(directory, 'services/api/dist/modules/auth/local-auth.service.js')).href
    );
    const { SessionService } = await import(
      pathToFileURL(join(directory, 'services/api/dist/modules/auth/session.service.js')).href
    );
    const createCredential = bindCredentialWriter(
      admin,
      { LocalAuthService, SessionService },
      async () => {
        live();
        await databaseIdentity(admin, 'solvi_owner');
      },
    );
    appReadOnly = createAppReadOnlyAccess({
      signal,
      assertLive: live,
      assertReady: async () => {
        live();
        if (productSource) assertProductSource();
        await owned();
      },
      assertIdentity: (client) => databaseIdentity(client, 'solvi_app'),
      createClient: () =>
        new pg.Client({
          connectionString: url('solvi_app'),
          connectionTimeoutMillis: 5000,
          statement_timeout: 30_000,
          query_timeout: 35_000,
          options: '-c default_transaction_read_only=on',
        }),
    });
    if (workPackage === 'WP-P2-PERF-051') {
      assertProductSource();
      assertSearch049ProductSource(
        readFileSync(join(directory, LEGACY_SEARCH_049_BASELINE.sourcePath)),
      );
    }
    const { buildListQuery } = await import(
      pathToFileURL(join(directory, 'services/api/dist/modules/ticket/ticket-query.js')).href
    );
    check(typeof buildListQuery === 'function', 'TICKET_QUERY_BUILDER_UNAVAILABLE');
    const buildTicketListQuery = (context, options) => {
      live();
      return buildListQuery(context, options);
    };
    let overviewBuilder;
    if (workPackage === 'WP-P2-PERF-043') {
      ({ buildTicketOverviewQuery: overviewBuilder } = await import(
        pathToFileURL(join(directory, 'services/api/dist/modules/ticket/overview-query.js')).href
      ));
      check(typeof overviewBuilder === 'function', 'OVERVIEW_QUERY_BUILDER_UNAVAILABLE');
    }
    const buildTicketOverviewQuery = (context, options) => {
      live();
      check(typeof overviewBuilder === 'function', 'OVERVIEW_QUERY_BUILDER_UNAVAILABLE');
      return overviewBuilder(context, options);
    };
    let buildLegacyTicketListQuery;
    if (workPackage === 'WP-P2-PERF-044') {
      const { buildListQuery: legacyBuilder } = await import(
        pathToFileURL(join(directory, LEGACY_TICKET_QUERY_BASELINE.compiledPath)).href
      );
      check(typeof legacyBuilder === 'function', 'LEGACY_TICKET_QUERY_BUILDER_UNAVAILABLE');
      buildLegacyTicketListQuery = (context, options) => {
        live();
        return legacyBuilder(context, options);
      };
    }
    let buildLegacySearchQuery;
    if (workPackage === 'WP-P2-PERF-046') {
      const { buildListQuery: legacyBuilder } = await import(
        pathToFileURL(join(directory, LEGACY_SEARCH_QUERY_BASELINE.compiledPath)).href
      );
      check(typeof legacyBuilder === 'function', 'LEGACY_SEARCH_QUERY_BUILDER_UNAVAILABLE');
      buildLegacySearchQuery = (context, options) => {
        live();
        return legacyBuilder(context, options);
      };
    }
    let buildLegacySearchWorkloadQuery;
    if (['WP-P2-PERF-047', 'WP-P2-PERF-048', 'WP-P2-PERF-049'].includes(workPackage)) {
      const { buildListQuery: legacyBuilder } = await import(
        pathToFileURL(join(directory, LEGACY_SEARCH_WORKLOAD_BASELINE.compiledPath)).href
      );
      check(typeof legacyBuilder === 'function', 'LEGACY_SEARCH_WORKLOAD_BUILDER_UNAVAILABLE');
      buildLegacySearchWorkloadQuery = (context, options) => {
        live();
        return legacyBuilder(context, options);
      };
    }
    let buildLegacySearchPrefixQuery;
    if (workPackage === 'WP-P2-PERF-048' || workPackage === 'WP-P2-PERF-049') {
      const { buildListQuery: legacyBuilder } = await import(
        pathToFileURL(join(directory, LEGACY_SEARCH_PREFIX_BASELINE.compiledPath)).href
      );
      check(typeof legacyBuilder === 'function', 'LEGACY_SEARCH_PREFIX_BUILDER_UNAVAILABLE');
      buildLegacySearchPrefixQuery = (context, options) => {
        live();
        return legacyBuilder(context, options);
      };
    }
    let buildLegacySearch048Query;
    if (workPackage === 'WP-P2-PERF-049' || workPackage === 'WP-P2-PERF-050') {
      const { buildListQuery: legacyBuilder } = await import(
        pathToFileURL(join(directory, LEGACY_SEARCH_048_BASELINE.compiledPath)).href
      );
      check(typeof legacyBuilder === 'function', 'LEGACY_SEARCH_048_BUILDER_UNAVAILABLE');
      buildLegacySearch048Query = (context, options) => {
        live();
        return legacyBuilder(context, options);
      };
    }
    let buildLegacySearch049Query;
    let readDatabaseResources;
    if (workPackage === 'WP-P2-PERF-050') {
      const { buildListQuery: legacyBuilder } = await import(
        pathToFileURL(join(directory, LEGACY_SEARCH_049_BASELINE.compiledPath)).href
      );
      check(typeof legacyBuilder === 'function', 'LEGACY_SEARCH_049_BUILDER_UNAVAILABLE');
      buildLegacySearch049Query = (context, options) => {
        live();
        return legacyBuilder(context, options);
      };
      readDatabaseResources = createDatabaseResourceReader({
        assertLive: live,
        assertReady: async () => {
          live();
          assertProductSource();
          const container = assertOwnedContainer(await inspect(expected.id, false, 5000), expected);
          return container.Id;
        },
        execute: (args) => run('docker', args, baseEnv, ROOT, 5000, false, true),
      });
    }
    let directoryHooks;
    let withAppReadOnly = appReadOnly.withAppReadOnly;
    if (workPackage === 'WP-P2-PERF-045') {
      const { UserAdminService: legacy } = await import(
        pathToFileURL(join(directory, LEGACY_USER_ADMIN_BASELINE.compiledPath)).href
      );
      const { UserAdminService: candidate } = await import(
        pathToFileURL(join(directory, 'services/api/dist/modules/auth/user-admin.service.js')).href
      );
      const activeClients = new WeakSet();
      withAppReadOnly = (context, callback) =>
        appReadOnly.withAppReadOnly(context, async (client) => {
          activeClients.add(client);
          try {
            return await callback(client);
          } finally {
            activeClients.delete(client);
          }
        });
      const readDirectoryMembers = bindDirectoryReader(
        { legacy, candidate },
        (client) => activeClients.has(client),
        live,
      );
      let securityStarted = false;
      const runDirectorySecurityTests = async () => {
        check(!securityStarted, 'DIRECTORY_SECURITY_ALREADY_STARTED');
        securityStarted = true;
        let completedFiles = 0;
        let preparation = { completed: false };
        try {
          live();
          assertOwnedDirectory(directory, tempIdentity);
          await databaseIdentity(admin, 'solvi_owner');
          await owned();
          preparation = await prepareDirectorySecurityFixture(admin, expected.database, live);
          progress('directory-security-tests');
          const testResults = [];
          let exitCode = 0;
          for (const [index, file] of DIRECTORY_SECURITY_FILES.entries()) {
            live();
            await databaseIdentity(admin, 'solvi_owner');
            assertOwnedDirectory(directory, tempIdentity);
            const reportPath = join(directory, `.directory-security-results-${index}.json`);
            writeFileSync(reportPath, '', { mode: 0o600, flag: 'wx' });
            const result = await run(
              process.execPath,
              [
                join(directory, 'node_modules/vitest/vitest.mjs'),
                'run',
                file,
                '--no-file-parallelism',
                '--reporter=json',
                `--outputFile=${reportPath}`,
              ],
              {
                ...baseEnv,
                NODE_ENV: 'test',
                DATABASE_ADMIN_URL: url('solvi_owner'),
                DATABASE_URL: url('solvi_app'),
              },
              directory,
              90_000,
            );
            live();
            assertOwnedDirectory(directory, tempIdentity);
            const stat = lstatSync(reportPath);
            check(
              stat.isFile() && !stat.isSymbolicLink() && stat.size < 8_000_000,
              'DIRECTORY_SECURITY_REPORT_INVALID',
            );
            const document = JSON.parse(readFileSync(reportPath, 'utf8'));
            check(
              Array.isArray(document.testResults) &&
                document.testResults.length === 1 &&
                document.testResults[0].name === join(directory, file),
              'DIRECTORY_SECURITY_REPORT_INVALID',
            );
            testResults.push(document.testResults[0]);
            completedFiles += 1;
            if (result.code !== 0) exitCode = result.code;
          }
          return {
            ...sanitizeDirectorySecurityResult({ testResults }, exitCode, directory),
            preparation,
          };
        } catch (error) {
          return {
            completed: false,
            success: false,
            completedFiles,
            preparation,
            failureCode: signal?.aborted
              ? 'DIRECTORY_SECURITY_INTERRUPTED'
              : [
                    'DIRECTORY_SECURITY_REPORT_INVALID',
                    'CONNECTED_DATABASE_IDENTITY_MISMATCH',
                    'DIRECTORY_SECURITY_DATABASE_REJECTED',
                    'DIRECTORY_SECURITY_DATABASE_MISMATCH',
                    'DIRECTORY_SECURITY_FIXTURE_UNEXPECTED',
                    'DIRECTORY_SECURITY_PREPARATION_COUNTS_INVALID',
                    'DIRECTORY_SECURITY_PREPARATION_FAILED',
                    'DIRECTORY_SECURITY_PREPARATION_ROLLBACK_FAILED',
                  ].includes(error?.message)
                ? error.message
                : 'DIRECTORY_SECURITY_FAILED',
          };
        }
      };
      directoryHooks = { readDirectoryMembers, runDirectorySecurityTests };
    }
    progress('ready');
    return {
      apiBase,
      webBase,
      metricsBase,
      admin,
      createCredential,
      meta,
      cleanup,
      withAppReadOnly,
      buildTicketListQuery,
      ...(buildLegacySearchQuery ? { buildLegacySearchQuery } : {}),
      ...(buildLegacySearchWorkloadQuery ? { buildLegacySearchWorkloadQuery } : {}),
      ...(buildLegacySearchPrefixQuery ? { buildLegacySearchPrefixQuery } : {}),
      ...(buildLegacySearch048Query ? { buildLegacySearch048Query } : {}),
      ...(buildLegacySearch049Query ? { buildLegacySearch049Query, readDatabaseResources } : {}),
      buildTicketOverviewQuery,
      ...(buildLegacyTicketListQuery ? { buildLegacyTicketListQuery } : {}),
      ...directoryHooks,
    };
  } catch (error) {
    const failedStage = stage;
    const failure = new Error(safeFailure(error));
    failure.stage = failedStage;
    failure.cleanupReport = await cleanup();
    failure.meta = meta;
    throw failure;
  }
}
