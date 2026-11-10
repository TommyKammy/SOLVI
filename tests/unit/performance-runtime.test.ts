import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { prepareOutput } from '../../tools/performance/run-baseline.mjs';

// @ts-expect-error The runtime is a directly executable ESM tool; tests exercise its public guards.
const runtime = await import('../../tools/performance/runtime.mjs');
const {
  POSTGRES_IMAGE,
  LEGACY_TICKET_QUERY_BASELINE,
  LEGACY_USER_ADMIN_BASELINE,
  LEGACY_SEARCH_QUERY_BASELINE,
  LEGACY_SEARCH_WORKLOAD_BASELINE,
  LEGACY_SEARCH_PREFIX_BASELINE,
  LEGACY_SEARCH_048_BASELINE,
  LEGACY_SEARCH_049_BASELINE,
  DIRECTORY_SECURITY_FILES,
  assertWorkPackage,
  assertOwnedContainer,
  assertOwnedDatabaseUrl,
  assertOwnedDirectory,
  removeOwnedDirectory,
  installLegacyTicketQuery,
  installLegacyUserAdmin,
  installLegacySearchQuery,
  installLegacySearchWorkloadQuery,
  installLegacySearchPrefixQuery,
  installLegacySearch048Query,
  installLegacySearch049Query,
  assertSearch049ProductSource,
  createSearchProductSourceGuard,
  parseDatabaseResources,
  createDatabaseResourceReader,
  bindDirectoryReader,
  prepareDirectorySecurityFixture,
  sanitizeDirectorySecurityResult,
  assertServerBindings,
  assertOwnedProcessGroup,
  bindCredentialWriter,
  createAppReadOnlyAccess,
  createStaticReadOnlyAccess,
  staticSearchFixtureDefinition,
  prepareStaticSearchFixture,
  STATIC_CONTEXT_KEYS,
  isolatedEnvironment,
  safeFailure,
  reserveLoopbackPort,
  waitForPortRelease,
  createRuntime,
} = runtime;

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'solvi-perf041-unit-'));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const expectedContainer = () => ({
  name: 'solvi-perf041-unit',
  token: 'unit-owner-token',
  imageId: 'sha256:cached',
  id: 'a'.repeat(64),
  port: 45001,
  protectedIds: ['b'.repeat(64)],
  protectedPorts: [5433, 3001],
});
const container = () => ({
  Name: '/solvi-perf041-unit',
  Id: 'a'.repeat(64),
  Image: 'sha256:cached',
  Config: {
    Image: POSTGRES_IMAGE,
    Labels: { 'solvi.wp': 'WP-P2-PERF-041', 'solvi.run': 'unit-owner-token' },
  },
  State: { Running: true },
  HostConfig: { NetworkMode: 'bridge', Binds: [], Tmpfs: { '/var/lib/postgresql/data': 'rw' } },
  Mounts: [{ Type: 'tmpfs' }],
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '45001' }] } },
});

describe('performance runtime target isolation', () => {
  it('permits only the fixed WP041 default and WP042/043/044/045/046/047/048/049/050/051 ownership labels', async () => {
    expect(assertWorkPackage()).toBe('WP-P2-PERF-041');
    expect(assertWorkPackage('WP-P2-PERF-042')).toBe('WP-P2-PERF-042');
    expect(assertWorkPackage('WP-P2-PERF-043')).toBe('WP-P2-PERF-043');
    expect(assertWorkPackage('WP-P2-PERF-044')).toBe('WP-P2-PERF-044');
    expect(assertWorkPackage('WP-P2-PERF-045')).toBe('WP-P2-PERF-045');
    expect(assertWorkPackage('WP-P2-PERF-046')).toBe('WP-P2-PERF-046');
    expect(assertWorkPackage('WP-P2-PERF-047')).toBe('WP-P2-PERF-047');
    expect(assertWorkPackage('WP-P2-PERF-048')).toBe('WP-P2-PERF-048');
    expect(assertWorkPackage('WP-P2-PERF-049')).toBe('WP-P2-PERF-049');
    expect(assertWorkPackage('WP-P2-PERF-050')).toBe('WP-P2-PERF-050');
    expect(assertWorkPackage('WP-P2-PERF-051')).toBe('WP-P2-PERF-051');
    expect(() => assertWorkPackage('WP-P2-PERF-052')).toThrow('WORK_PACKAGE_NOT_ALLOWED');
    const indexDiagnostic = container();
    indexDiagnostic.Config.Labels['solvi.wp'] = 'WP-P2-PERF-051';
    expect(
      assertOwnedContainer(indexDiagnostic, {
        ...expectedContainer(),
        workPackage: 'WP-P2-PERF-051',
      }).Id,
    ).toBe(indexDiagnostic.Id);
    expect(() =>
      assertOwnedContainer(indexDiagnostic, {
        ...expectedContainer(),
        workPackage: 'WP-P2-PERF-050',
      }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    const reproducibility = container();
    reproducibility.Config.Labels['solvi.wp'] = 'WP-P2-PERF-050';
    expect(
      assertOwnedContainer(reproducibility, {
        ...expectedContainer(),
        workPackage: 'WP-P2-PERF-050',
      }).Id,
    ).toBe(reproducibility.Id);
    expect(() =>
      assertOwnedContainer(reproducibility, {
        ...expectedContainer(),
        workPackage: 'WP-P2-PERF-049',
      }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    const statePrefix = container();
    statePrefix.Config.Labels['solvi.wp'] = 'WP-P2-PERF-049';
    expect(
      assertOwnedContainer(statePrefix, { ...expectedContainer(), workPackage: 'WP-P2-PERF-049' })
        .Id,
    ).toBe(statePrefix.Id);
    expect(() =>
      assertOwnedContainer(statePrefix, { ...expectedContainer(), workPackage: 'WP-P2-PERF-048' }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    const prefix = container();
    prefix.Config.Labels['solvi.wp'] = 'WP-P2-PERF-048';
    expect(
      assertOwnedContainer(prefix, { ...expectedContainer(), workPackage: 'WP-P2-PERF-048' }).Id,
    ).toBe(prefix.Id);
    expect(() =>
      assertOwnedContainer(prefix, { ...expectedContainer(), workPackage: 'WP-P2-PERF-047' }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    const latest = container();
    latest.Config.Labels['solvi.wp'] = 'WP-P2-PERF-047';
    expect(
      assertOwnedContainer(latest, { ...expectedContainer(), workPackage: 'WP-P2-PERF-047' }).Id,
    ).toBe(latest.Id);
    expect(() =>
      assertOwnedContainer(latest, { ...expectedContainer(), workPackage: 'WP-P2-PERF-046' }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    const next = container();
    next.Config.Labels['solvi.wp'] = 'WP-P2-PERF-042';
    expect(
      assertOwnedContainer(next, { ...expectedContainer(), workPackage: 'WP-P2-PERF-042' }).Id,
    ).toBe(next.Id);
    expect(() => assertOwnedContainer(next, expectedContainer())).toThrow('CONTAINER_WP_MISMATCH');
    expect(() =>
      assertOwnedContainer(container(), { ...expectedContainer(), workPackage: 'WP-P2-PERF-042' }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    next.Config.Labels['solvi.wp'] = 'WP-P2-PERF-045';
    expect(
      assertOwnedContainer(next, { ...expectedContainer(), workPackage: 'WP-P2-PERF-045' }).Id,
    ).toBe(next.Id);
    next.Config.Labels['solvi.wp'] = 'WP-P2-PERF-044';
    expect(
      assertOwnedContainer(next, { ...expectedContainer(), workPackage: 'WP-P2-PERF-044' }).Id,
    ).toBe(next.Id);
    expect(() =>
      assertOwnedContainer(next, { ...expectedContainer(), workPackage: 'WP-P2-PERF-043' }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    await expect(createRuntime({ workPackage: 'arbitrary-target' })).rejects.toThrow(
      'WORK_PACKAGE_NOT_ALLOWED',
    );
  });

  it('accepts only the generated database, port, host and intended login role', () => {
    const value = 'postgresql://solvi_app:synthetic@127.0.0.1:45001/solvi_perf041_123_abcdef123456';
    expect(
      assertOwnedDatabaseUrl(value, {
        port: 45001,
        database: 'solvi_perf041_123_abcdef123456',
        user: 'solvi_app',
      }),
    ).toBe(value);
  });

  it('claims a new WP051 output without permitting another package or an existing leaf', async () => {
    const output = join(
      process.cwd(),
      'evidence/WP-P2-PERF-051',
      `runtime-unit-${process.pid}-${Date.now()}`,
    );
    await expect(prepareOutput(output, 'smoke', 'WP-P2-PERF-050')).rejects.toThrow(
      'OUTPUT_OUTSIDE_EVIDENCE',
    );
    expect(existsSync(output)).toBe(false);
    expect(await prepareOutput(output, 'smoke', 'WP-P2-PERF-051')).toBe(output);
    directories.push(output);
    expect(lstatSync(output).mode & 0o777).toBe(0o700);
    await expect(prepareOutput(output, 'smoke', 'WP-P2-PERF-051')).rejects.toThrow(
      'OUTPUT_ALREADY_EXISTS',
    );
    await expect(
      prepareOutput(join(output, '../outside'), 'smoke', 'WP-P2-PERF-052' as never),
    ).rejects.toThrow('OUTPUT_WORK_PACKAGE_REJECTED');
  });

  it.each([
    [
      'postgresql://solvi_app:synthetic@example.test:45001/solvi_perf041_123_abcdef123456',
      'DATABASE_HOST_UNSAFE',
    ],
    [
      'postgresql://solvi_app:synthetic@127.0.0.1:45002/solvi_perf041_123_abcdef123456',
      'DATABASE_PORT_MISMATCH',
    ],
    ['postgresql://solvi_app:synthetic@127.0.0.1:45001/solvi', 'DATABASE_NAME_MISMATCH'],
    [
      'postgresql://solvi_owner:synthetic@127.0.0.1:45001/solvi_perf041_123_abcdef123456',
      'DATABASE_USER_MISMATCH',
    ],
    [
      'postgresql://solvi_app:synthetic@127.0.0.1:45001/solvi_perf041_123_abcdef123456?host=example.test',
      'DATABASE_OPTIONS_UNSAFE',
    ],
  ])('refuses unsafe database target %s without exposing credentials', (value, code) => {
    expect(() =>
      assertOwnedDatabaseUrl(value, {
        port: 45001,
        database: 'solvi_perf041_123_abcdef123456',
        user: 'solvi_app',
      }),
    ).toThrow(code);
  });

  it('refuses a protected development port even if the URL otherwise agrees', () => {
    expect(() =>
      assertOwnedDatabaseUrl(
        'postgresql://solvi_app:synthetic@127.0.0.1:5433/solvi_perf041_123_abcdef123456',
        { port: 5433, database: 'solvi_perf041_123_abcdef123456', user: 'solvi_app' },
      ),
    ).toThrow('PROTECTED_PORT_FORBIDDEN');
  });

  it('requires all independent ownership proofs before use or removal', () => {
    expect(assertOwnedContainer(container(), expectedContainer()).Id).toBe('a'.repeat(64));
    const wrongToken = container();
    wrongToken.Config.Labels['solvi.run'] = 'somebody-else';
    expect(() => assertOwnedContainer(wrongToken, expectedContainer(), false)).toThrow(
      'CONTAINER_TOKEN_MISMATCH',
    );
    expect(() =>
      assertOwnedContainer(
        container(),
        { ...expectedContainer(), protectedIds: ['a'.repeat(64)] },
        false,
      ),
    ).toThrow('PROTECTED_CONTAINER_FORBIDDEN');
    expect(() =>
      assertOwnedContainer(
        container(),
        { ...expectedContainer(), imageId: 'sha256:another' },
        false,
      ),
    ).toThrow('CONTAINER_IMAGE_MISMATCH');
  });

  it('rejects persistent volumes and non-loopback publication', () => {
    const volume = container();
    volume.Mounts = [{ Type: 'volume' }];
    expect(() => assertOwnedContainer(volume, expectedContainer())).toThrow(
      'PERSISTENT_MOUNT_FORBIDDEN',
    );
    const wildcard = container();
    wildcard.NetworkSettings.Ports['5432/tcp'][0]!.HostIp = '0.0.0.0';
    expect(() => assertOwnedContainer(wildcard, expectedContainer())).toThrow(
      'DATABASE_BIND_NOT_LOOPBACK',
    );
  });

  it('accepts a stopped owned container for cleanup while refusing it for connections', () => {
    const stopped = container();
    stopped.State.Running = false;
    expect(() => assertOwnedContainer(stopped, expectedContainer())).toThrow(
      'CONTAINER_NOT_RUNNING',
    );
    expect(assertOwnedContainer(stopped, expectedContainer(), false).Id).toBe(stopped.Id);
  });

  it('does not inherit DB credentials, Node hooks, proxy settings or export destinations', () => {
    expect(
      isolatedEnvironment({
        PATH: '/usr/bin',
        HOME: '/tmp/example',
        DATABASE_URL: 'private',
        NODE_OPTIONS: '--import unwanted',
        HTTPS_PROXY: 'private',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'private',
        AWS_SECRET_ACCESS_KEY: 'private',
      }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/tmp/example' });
    expect(safeFailure(new Error('postgresql://user:secret@example.test/db'))).toBe(
      'RUNTIME_ERROR_DETAILS_SUPPRESSED',
    );
    expect(safeFailure(new Error('DATABASE_HOST_UNSAFE'))).toBe('DATABASE_HOST_UNSAFE');
  });
});

describe('WP045 private directory adapters and fixed security report', () => {
  const legacySource = () =>
    execFileSync(
      'git',
      ['show', `${LEGACY_USER_ADMIN_BASELINE.ref}:${LEGACY_USER_ADMIN_BASELINE.sourcePath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const ownedDirectory = () => {
    const path = directory();
    const stat = lstatSync(path);
    const identity = {
      path,
      parent: realpathSync(tmpdir()),
      dev: stat.dev,
      ino: stat.ino,
      token: 'directory-unit',
    };
    writeFileSync(join(path, '.solvi-perf041-owner'), identity.token);
    mkdirSync(join(path, 'services/api/dist/modules/auth'), { recursive: true });
    return identity;
  };
  it('compiles only the immutable UserAdmin service next to its copied relative dependencies', async () => {
    const identity = ownedDirectory();
    const meta = await installLegacyUserAdmin(identity, async () => legacySource());
    expect(meta.ref).toBe('035288fcb2caf0a77b74282cc56fd14c73ca79bc');
    expect(meta.sourceSha256).toBe(
      '87ae8bc42e203a0e26a8e6af264486150d9db7af21a2438235b00a358cd9d8ce',
    );
    const source = readFileSync(join(identity.path, meta.compiledPath), 'utf8');
    expect(source).toContain('export class UserAdminService');
    expect(source).toContain("from './session.service.js'");
    expect(source).not.toContain('export interface');
    expect(createHash('sha256').update(source).digest('hex')).toBe(meta.compiledSha256);
    expect(lstatSync(join(identity.path, meta.compiledPath)).mode & 0o777).toBe(0o600);
  });
  it('rejects substituted baseline bytes and foreign ownership without writing', async () => {
    const identity = ownedDirectory();
    await expect(installLegacyUserAdmin(identity, async () => 'changed')).rejects.toThrow(
      'LEGACY_USER_ADMIN_SOURCE_MISMATCH',
    );
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'foreign');
    const read = vi.fn();
    await expect(installLegacyUserAdmin(identity, read)).rejects.toThrow('TEMP_TOKEN_MISMATCH');
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(identity.path, LEGACY_USER_ADMIN_BASELINE.compiledPath))).toBe(false);
  });
  it('rejects symlinked ancestors and existing legacy modules', async () => {
    const identity = ownedDirectory();
    const target = join(identity.path, LEGACY_USER_ADMIN_BASELINE.compiledPath);
    writeFileSync(target, 'preserve');
    await expect(installLegacyUserAdmin(identity, async () => legacySource())).rejects.toThrow(
      'LEGACY_USER_ADMIN_ALREADY_EXISTS',
    );
    expect(readFileSync(target, 'utf8')).toBe('preserve');
    rmSync(join(identity.path, 'services/api/dist'), { recursive: true });
    symlinkSync(directory(), join(identity.path, 'services/api/dist'));
    await expect(installLegacyUserAdmin(identity, async () => legacySource())).rejects.toThrow(
      'LEGACY_USER_ADMIN_PATH_UNSAFE',
    );
  });
  it('captures private SQL only on the same active owned facade and rejects arbitrary variants or writes', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    let owned = true;
    class Service {
      constructor(
        private readonly db: { query(sql: string, values: unknown[]): Promise<unknown> },
      ) {}
      async listMembers() {
        await this.db.query('SELECT id FROM app_user WHERE id=$1', ['private-id']);
        return [];
      }
    }
    const read = bindDirectoryReader(
      { legacy: Service, candidate: Service },
      (value: unknown) => owned && value === client,
    );
    expect(await read('legacy', client, {})).toEqual({
      members: [],
      queries: [{ sql: 'SELECT id FROM app_user WHERE id=$1', params: ['private-id'] }],
    });
    expect(client.query).toHaveBeenCalledOnce();
    await expect(read('unknown', client, {})).rejects.toThrow('DIRECTORY_VARIANT_INVALID');
    await expect(read('candidate', {}, {})).rejects.toThrow('DIRECTORY_READ_CLIENT_NOT_OWNED');
    owned = false;
    await expect(read('candidate', client, {})).rejects.toThrow('DIRECTORY_READ_CLIENT_NOT_OWNED');
    // A separate fake service tries the injected query surface, not an unrelated client.
    const writer = class {
      constructor(private readonly db: { query(sql: string): Promise<unknown> }) {}
      async listMembers() {
        await this.db.query('DELETE FROM ticket');
        return [];
      }
    };
    const unsafe = bindDirectoryReader({ legacy: writer, candidate: writer }, () => true);
    await expect(unsafe('candidate', client, {})).rejects.toThrow('DIRECTORY_READ_QUERY_REJECTED');
    expect(client.query).toHaveBeenCalledOnce();
  });
  const security = (root: string) => ({
    testResults: DIRECTORY_SECURITY_FILES.map((file: string) => ({
      name: join(root, file),
      status: 'passed',
      assertionResults: [{ status: 'passed', title: 'private-data' }],
    })),
  });
  it('returns only fixed file/test counts and index diagnostics, never titles or exceptions', () => {
    const root = directory();
    const input = security(root);
    expect(sanitizeDirectorySecurityResult(input, 0, root)).toEqual({
      completed: true,
      success: true,
      testFiles: { passed: 2, failed: 0 },
      tests: { passed: 2, failed: 0, pending: 0 },
    });
    input.testResults[1].status = 'failed';
    input.testResults[1].assertionResults[0].status = 'failed';
    const failed = sanitizeDirectorySecurityResult(input, 1, root);
    expect(failed).toMatchObject({
      completed: true,
      success: false,
      tests: { passed: 1, failed: 1 },
      failures: [
        { fileIndex: 1, kind: 'suite_failed' },
        { fileIndex: 1, assertionIndex: 0, kind: 'assertion_failed' },
      ],
    });
    expect(JSON.stringify(failed)).not.toContain('private-data');
  });
  it('never treats a skipped test, nonzero exit or unexpected test path as success', () => {
    const root = directory(),
      input = security(root);
    expect(sanitizeDirectorySecurityResult(input, 1, root).success).toBe(false);
    input.testResults[0].assertionResults[0].status = 'pending';
    expect(sanitizeDirectorySecurityResult(input, 0, root).success).toBe(false);
    input.testResults[0].name = join(root, 'tests/security/unapproved.test.ts');
    expect(() => sanitizeDirectorySecurityResult(input, 0, root)).toThrow(
      'DIRECTORY_SECURITY_REPORT_INVALID',
    );
  });
});

describe('owned directory security fixture preparation', () => {
  const database = 'solvi_perf041_1234567890_abcdef123456';
  const request = {
    id: '04100000-0000-4000-8004-000000000001',
    organization_id: '00000000-0000-4000-9000-000000000001',
    ticket_id: '04100000-0000-4000-8002-000000000001',
    current_approval_id: '04100000-0000-4000-8005-000000000001',
    idempotency_key: '04100000-0000-4000-8004-000000000001',
    version: 1,
    revision: 1,
    state: 'pending',
    total_requests: 1,
  };
  const fake = (
    options: {
      database?: string;
      role?: string;
      rows?: Record<string, unknown>[];
      wrongCount?: boolean;
      failDelete?: boolean;
      failRollback?: boolean;
    } = {},
  ) => ({
    query: vi.fn(async ({ text }: { text: string; values?: unknown[]; query_timeout?: number }) => {
      if (text.includes('current_database()'))
        return {
          rows: [{ database: options.database ?? database, role: options.role ?? 'solvi_owner' }],
        };
      if (text.startsWith('SELECT sr.id')) return { rows: options.rows ?? [request] };
      if (text === 'ROLLBACK' && options.failRollback) throw new Error('PRIVATE_ROLLBACK');
      if (text.startsWith('DELETE')) {
        if (options.failDelete) throw new Error('PRIVATE_DRIVER_URL');
        return {
          rowCount: options.wrongCount ? 2 : text.includes('local_simulation_receipt') ? 0 : 1,
        };
      }
      return { rows: [] };
    }),
  });
  it('removes exactly the fixed dependency in one transaction, preserving catalog/audit/triggers', async () => {
    const admin = fake();
    const result = await prepareDirectorySecurityFixture(admin, database);
    expect(result).toEqual({
      completed: true,
      counts: {
        simulationReceipts: 0,
        requestApprovals: 1,
        requestRevisions: 1,
        serviceRequests: 1,
      },
    });
    const calls = admin.query.mock.calls.map(([query]) => query);
    expect(calls.slice(0, 3).map((q) => q.text)).toEqual([
      'SELECT current_database() AS database, current_user AS role',
      'BEGIN',
      "SET LOCAL statement_timeout = '3000ms'",
    ]);
    expect(calls.at(-1)!.text).toBe('COMMIT');
    const deletes = calls.filter((q) => q.text.startsWith('DELETE'));
    expect(deletes.map((q) => q.text)).toEqual([
      'DELETE FROM local_simulation_receipt WHERE request_id=$1 AND organization_id=$2',
      'DELETE FROM local_request_approval WHERE request_id=$1 AND organization_id=$2',
      'DELETE FROM local_request_revision WHERE request_id=$1 AND organization_id=$2',
      'DELETE FROM local_service_request WHERE id=$1 AND organization_id=$2',
    ]);
    expect(
      deletes.every(
        (q) => JSON.stringify(q.values) === JSON.stringify([request.id, request.organization_id]),
      ),
    ).toBe(true);
    expect(calls.every((q) => q.query_timeout === 3000)).toBe(true);
    expect(calls.map((q) => q.text).join('\n')).not.toMatch(
      /ALTER|TRUNCATE|DELETE FROM (audit|ticket|local_catalog)/,
    );
    expect(JSON.stringify(result)).not.toMatch(/04100000|9000|perf041-service/);
  });
  it('rejects non-owned database names without any query', async () => {
    const admin = fake();
    await expect(prepareDirectorySecurityFixture(admin, 'solvi')).rejects.toThrow(
      'DIRECTORY_SECURITY_DATABASE_REJECTED',
    );
    expect(admin.query).not.toHaveBeenCalled();
  });
  it.each([{ database: 'solvi' }, { role: 'solvi_app' }])(
    'rejects connected identity %j before BEGIN',
    async (options) => {
      const admin = fake(options);
      await expect(prepareDirectorySecurityFixture(admin, database)).rejects.toThrow(
        'DIRECTORY_SECURITY_DATABASE_MISMATCH',
      );
      expect(admin.query).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [],
    [request, request],
    [{ ...request, total_requests: 2 }],
    [{ ...request, id: '00000000-0000-4000-9000-000000000099' }],
    [{ ...request, state: 'completed' }],
  ])('rolls back an unexpected fixed fixture without DELETE', async (...rows) => {
    const admin = fake({ rows });
    await expect(prepareDirectorySecurityFixture(admin, database)).rejects.toThrow(
      'DIRECTORY_SECURITY_FIXTURE_UNEXPECTED',
    );
    const sql = admin.query.mock.calls.map(([query]) => query.text);
    expect(sql.at(-1)).toBe('ROLLBACK');
    expect(sql.some((text) => text.startsWith('DELETE'))).toBe(false);
  });
  it.each([
    { options: { wrongCount: true }, code: 'DIRECTORY_SECURITY_PREPARATION_COUNTS_INVALID' },
    { options: { failDelete: true }, code: 'DIRECTORY_SECURITY_PREPARATION_FAILED' },
    {
      options: { failDelete: true, failRollback: true },
      code: 'DIRECTORY_SECURITY_PREPARATION_ROLLBACK_FAILED',
    },
  ])('fails closed and rolls back partial preparation: $code', async ({ options, code }) => {
    const admin = fake(options);
    await expect(prepareDirectorySecurityFixture(admin, database)).rejects.toThrow(code);
    const sql = admin.query.mock.calls.map(([query]) => query.text);
    expect(sql.at(-1)).toBe('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });
  it('rolls back interruption after a dependency was removed', async () => {
    const admin = fake();
    await expect(
      prepareDirectorySecurityFixture(admin, database, () => {
        if (admin.query.mock.calls.some(([query]) => query.text.startsWith('DELETE')))
          throw new Error('RUNTIME_INTERRUPTED');
      }),
    ).rejects.toThrow('DIRECTORY_SECURITY_PREPARATION_FAILED');
    expect(admin.query.mock.calls.at(-1)![0].text).toBe('ROLLBACK');
  });
});

const legacyDirectory = () => {
  const path = directory();
  const stat = lstatSync(path);
  const identity = {
    path,
    parent: realpathSync(tmpdir()),
    dev: stat.dev,
    ino: stat.ino,
    token: 'legacy-query-unit-owner',
  };
  writeFileSync(join(path, '.solvi-perf041-owner'), identity.token);
  mkdirSync(join(path, 'services/api/dist/modules/ticket'), { recursive: true });
  return identity;
};
const pinnedLegacySource = () =>
  execFileSync(
    'git',
    ['show', `${LEGACY_TICKET_QUERY_BASELINE.ref}:${LEGACY_TICKET_QUERY_BASELINE.sourcePath}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

describe('fixed legacy ticket query compilation', () => {
  it('compiles the pinned source only inside the owned API dist and preserves relative ESM imports', async () => {
    const identity = legacyDirectory();
    const meta = await installLegacyTicketQuery(identity, async () => pinnedLegacySource());
    const target = join(identity.path, meta.compiledPath);
    const compiled = readFileSync(target, 'utf8');
    expect(meta.ref).toBe('08a0904145a3b036ad5c36330b56e1d638e1451e');
    expect(meta.sourceSha256).toBe(
      'f3d57ae916cd480022c5889c93cac53f2acf603503ecafa282cee2027e031ae0',
    );
    expect(meta.compiledPath).toBe('services/api/dist/modules/ticket/ticket-query.legacy-044.js');
    expect(createHash('sha256').update(compiled).digest('hex')).toBe(meta.compiledSha256);
    expect(compiled).toContain("from '../../common/authz/authz.js'");
    expect(compiled).toContain("from '@solvi/shared'");
    expect(compiled).toContain('export function buildListQuery(');
    expect(compiled).not.toContain('export interface');
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(Object.isFrozen(LEGACY_TICKET_QUERY_BASELINE)).toBe(true);
  });

  it('rejects any source other than the fixed commit bytes before writing', async () => {
    const identity = legacyDirectory();
    await expect(
      installLegacyTicketQuery(identity, async () => 'export const arbitrary = true;'),
    ).rejects.toThrow('LEGACY_TICKET_QUERY_SOURCE_MISMATCH');
    expect(existsSync(join(identity.path, LEGACY_TICKET_QUERY_BASELINE.compiledPath))).toBe(false);
  });

  it('refuses a foreign owner marker before obtaining baseline source', async () => {
    const identity = legacyDirectory();
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'different-owner');
    const read = vi.fn();
    await expect(installLegacyTicketQuery(identity, read)).rejects.toThrow('TEMP_TOKEN_MISMATCH');
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a symlinked dist ancestor without writing outside the owned directory', async () => {
    const identity = legacyDirectory();
    const outside = directory();
    const dist = join(identity.path, 'services/api/dist');
    rmSync(dist, { recursive: true });
    symlinkSync(outside, dist);
    await expect(
      installLegacyTicketQuery(identity, async () => pinnedLegacySource()),
    ).rejects.toThrow('LEGACY_TICKET_QUERY_PATH_UNSAFE');
    expect(existsSync(join(outside, 'modules/ticket/ticket-query.legacy-044.js'))).toBe(false);
  });

  it('never overwrites an existing comparison module', async () => {
    const identity = legacyDirectory();
    const target = join(identity.path, LEGACY_TICKET_QUERY_BASELINE.compiledPath);
    writeFileSync(target, 'preserve-existing-content');
    await expect(
      installLegacyTicketQuery(identity, async () => pinnedLegacySource()),
    ).rejects.toThrow('LEGACY_TICKET_QUERY_ALREADY_EXISTS');
    expect(readFileSync(target, 'utf8')).toBe('preserve-existing-content');
  });

  it('rechecks interruption after awaiting source and before compilation or writes', async () => {
    const identity = legacyDirectory();
    let stopped = false;
    await expect(
      installLegacyTicketQuery(
        identity,
        async () => {
          stopped = true;
          return pinnedLegacySource();
        },
        () => {
          if (stopped) throw new Error('RUNTIME_INTERRUPTED');
        },
      ),
    ).rejects.toThrow('RUNTIME_INTERRUPTED');
    expect(existsSync(join(identity.path, LEGACY_TICKET_QUERY_BASELINE.compiledPath))).toBe(false);
  });
});

describe('WP046 immutable search comparison source', () => {
  const source = () =>
    execFileSync(
      'git',
      ['show', `${LEGACY_SEARCH_QUERY_BASELINE.ref}:${LEGACY_SEARCH_QUERY_BASELINE.sourcePath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  it('pins WP045 ticket SQL separately from WP044 and compiles only in the owned copy', async () => {
    const identity = legacyDirectory();
    const meta = await installLegacySearchQuery(identity, async () => source());
    expect(meta).toMatchObject({
      ref: 'd66537ca01a6c127d3bc55a66bb75eb8a3ade8ea',
      sourceSha256: '3eba00d14e2fe1a4f14cf291ef1212ff18a20576e09f51a96a897fc249bb99f6',
      compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-046.js',
    });
    const target = join(identity.path, meta.compiledPath);
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, 'utf8')).toContain('export function buildListQuery');
    expect(readFileSync(target, 'utf8')).toContain("'../../common/authz/authz.js'");
    expect(existsSync(join(identity.path, LEGACY_TICKET_QUERY_BASELINE.compiledPath))).toBe(false);
    await expect(installLegacySearchQuery(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_QUERY_ALREADY_EXISTS',
    );
  });
  it('rejects the deadline legacy source and a changed owner marker before writing', async () => {
    const identity = legacyDirectory();
    await expect(
      installLegacySearchQuery(identity, async () => pinnedLegacySource()),
    ).rejects.toThrow('LEGACY_SEARCH_QUERY_SOURCE_MISMATCH');
    const read = vi.fn(async () => source());
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'different-owner');
    await expect(installLegacySearchQuery(identity, read)).rejects.toThrow('TEMP_TOKEN_MISMATCH');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects ancestor symlinks and rechecks cancellation before search artifact creation', async () => {
    const identity = legacyDirectory();
    const outside = directory();
    const dist = join(identity.path, 'services/api/dist');
    rmSync(dist, { recursive: true });
    symlinkSync(outside, dist);
    await expect(installLegacySearchQuery(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_QUERY_PATH_UNSAFE',
    );
    const untouched = legacyDirectory();
    let stop = false;
    await expect(
      installLegacySearchQuery(
        untouched,
        async () => {
          stop = true;
          return source();
        },
        () => {
          if (stop) throw new Error('RUNTIME_INTERRUPTED');
        },
      ),
    ).rejects.toThrow('RUNTIME_INTERRUPTED');
    expect(existsSync(join(untouched.path, LEGACY_SEARCH_QUERY_BASELINE.compiledPath))).toBe(false);
  });
});

describe('WP047 immutable projected-search workload source', () => {
  const source = () =>
    execFileSync(
      'git',
      [
        'show',
        `${LEGACY_SEARCH_WORKLOAD_BASELINE.ref}:${LEGACY_SEARCH_WORKLOAD_BASELINE.sourcePath}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  it('pins the WP046 result separately and permits only one owned destination', async () => {
    const identity = legacyDirectory();
    const meta = await installLegacySearchWorkloadQuery(identity, async () => source());
    expect(meta).toMatchObject({
      ref: '15016d7326c91503a200be815e128f35b5107f13',
      sourceSha256: 'ce20b8646438c86615ef9293e34a3a2c72683ca3ffb292114fe03e5aaef3d949',
      compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-workload-047.js',
    });
    const destination = join(identity.path, meta.compiledPath);
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);
    expect(readFileSync(destination, 'utf8')).toContain('export function buildListQuery');
    expect(readFileSync(destination, 'utf8')).toContain("'../../common/authz/authz.js'");
    expect(existsSync(join(identity.path, LEGACY_SEARCH_QUERY_BASELINE.compiledPath))).toBe(false);
    await expect(installLegacySearchWorkloadQuery(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_WORKLOAD_ALREADY_EXISTS',
    );
  });
  it('rejects a different fixed baseline, a changed marker, and interruption before writing', async () => {
    const identity = legacyDirectory();
    await expect(
      installLegacySearchWorkloadQuery(identity, async () => pinnedLegacySource()),
    ).rejects.toThrow('LEGACY_SEARCH_WORKLOAD_SOURCE_MISMATCH');
    let stopped = false;
    await expect(
      installLegacySearchWorkloadQuery(
        identity,
        async () => {
          stopped = true;
          return source();
        },
        () => {
          if (stopped) throw new Error('RUNTIME_INTERRUPTED');
        },
      ),
    ).rejects.toThrow('RUNTIME_INTERRUPTED');
    const read = vi.fn(async () => source());
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'changed-owner');
    await expect(installLegacySearchWorkloadQuery(identity, read)).rejects.toThrow(
      'TEMP_TOKEN_MISMATCH',
    );
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(identity.path, LEGACY_SEARCH_WORKLOAD_BASELINE.compiledPath))).toBe(
      false,
    );
  });
  it('refuses a symlinked compilation ancestor', async () => {
    const identity = legacyDirectory();
    const dist = join(identity.path, 'services/api/dist');
    rmSync(dist, { recursive: true });
    symlinkSync(directory(), dist);
    await expect(installLegacySearchWorkloadQuery(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_WORKLOAD_PATH_UNSAFE',
    );
  });
});

describe('WP048 immutable held-WP047 comparison source', () => {
  const source = () =>
    execFileSync(
      'git',
      ['show', `${LEGACY_SEARCH_PREFIX_BASELINE.ref}:${LEGACY_SEARCH_PREFIX_BASELINE.sourcePath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const adoptedSource = () =>
    execFileSync(
      'git',
      [
        'show',
        `${LEGACY_SEARCH_WORKLOAD_BASELINE.ref}:${LEGACY_SEARCH_WORKLOAD_BASELINE.sourcePath}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  it('keeps the fixed held combined-SQL source and the adopted two-statement source distinct', async () => {
    const identity = legacyDirectory();
    const adopted = await installLegacySearchWorkloadQuery(identity, async () => adoptedSource());
    const held = await installLegacySearchPrefixQuery(identity, async () => source());
    expect(held).toMatchObject({
      ref: '1d5e0ec89427d4d04c496b908b2ce5abaa1d1b04',
      sourceSha256: '0ee13411051f6446ccf096e838f914e74d3ac3431718aecc85fc5e7b4da15d93',
      compiledPath: 'services/api/dist/modules/ticket/ticket-query.legacy-search-prefix-048.js',
    });
    const heldPath = join(identity.path, held.compiledPath);
    const adoptedPath = join(identity.path, adopted.compiledPath);
    expect(heldPath).not.toBe(adoptedPath);
    expect(lstatSync(heldPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(heldPath, 'utf8')).toContain('combinedSql');
    expect(readFileSync(heldPath, 'utf8')).toContain("'../../common/authz/authz.js'");
    expect(readFileSync(adoptedPath, 'utf8')).not.toContain('combinedSql');
    await expect(installLegacySearchPrefixQuery(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_PREFIX_ALREADY_EXISTS',
    );
  });
  it('rejects adopted-source substitution and a replaced marker before compilation', async () => {
    const identity = legacyDirectory();
    await expect(
      installLegacySearchPrefixQuery(identity, async () => adoptedSource()),
    ).rejects.toThrow('LEGACY_SEARCH_PREFIX_SOURCE_MISMATCH');
    const read = vi.fn(async () => source());
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'other-owner');
    await expect(installLegacySearchPrefixQuery(identity, read)).rejects.toThrow(
      'TEMP_TOKEN_MISMATCH',
    );
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(identity.path, LEGACY_SEARCH_PREFIX_BASELINE.compiledPath))).toBe(false);
  });
  it('rejects symlinked ancestors and interruption before creating the fixed artifact', async () => {
    const identity = legacyDirectory();
    const dist = join(identity.path, 'services/api/dist');
    rmSync(dist, { recursive: true });
    symlinkSync(directory(), dist);
    await expect(installLegacySearchPrefixQuery(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_PREFIX_PATH_UNSAFE',
    );
    const untouched = legacyDirectory();
    let stopped = false;
    await expect(
      installLegacySearchPrefixQuery(
        untouched,
        async () => {
          stopped = true;
          return source();
        },
        () => {
          if (stopped) throw new Error('RUNTIME_INTERRUPTED');
        },
      ),
    ).rejects.toThrow('RUNTIME_INTERRUPTED');
    expect(existsSync(join(untouched.path, LEGACY_SEARCH_PREFIX_BASELINE.compiledPath))).toBe(
      false,
    );
  });
});

describe('WP049 immutable held-WP048 comparison source', () => {
  const source = () =>
    execFileSync(
      'git',
      ['show', `${LEGACY_SEARCH_048_BASELINE.ref}:${LEGACY_SEARCH_048_BASELINE.sourcePath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  it('pins the prefix source separately from both earlier controls', async () => {
    const identity = legacyDirectory();
    const meta = await installLegacySearch048Query(identity, async () => source());
    expect(meta).toMatchObject({
      ref: '1e491c998bbf71189139fa6003af2930eda14eef',
      sourceSha256: 'd6c124eb610d9e9e1e796236104b2413d475a497d8408c3ce0d023b7934eba62',
      compiledPath:
        'services/api/dist/modules/ticket/ticket-query.legacy-search-048-control-049.js',
    });
    expect(
      new Set([
        meta.compiledPath,
        LEGACY_SEARCH_PREFIX_BASELINE.compiledPath,
        LEGACY_SEARCH_WORKLOAD_BASELINE.compiledPath,
      ]).size,
    ).toBe(3);
    const destination = join(identity.path, meta.compiledPath);
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);
    expect(readFileSync(destination, 'utf8')).toContain('combinedSql');
    expect(readFileSync(destination, 'utf8')).toContain("'../../common/authz/authz.js'");
    await expect(installLegacySearch048Query(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_048_ALREADY_EXISTS',
    );
  });
  it('rejects a previous control and replaced ownership marker without writing', async () => {
    const identity = legacyDirectory();
    await expect(
      installLegacySearch048Query(identity, async () => pinnedLegacySource()),
    ).rejects.toThrow('LEGACY_SEARCH_048_SOURCE_MISMATCH');
    const read = vi.fn(async () => source());
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'changed-owner');
    await expect(installLegacySearch048Query(identity, read)).rejects.toThrow(
      'TEMP_TOKEN_MISMATCH',
    );
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(identity.path, LEGACY_SEARCH_048_BASELINE.compiledPath))).toBe(false);
  });
  it('rejects a symlinked destination ancestor and aborts before compilation output', async () => {
    const identity = legacyDirectory();
    const dist = join(identity.path, 'services/api/dist');
    rmSync(dist, { recursive: true });
    symlinkSync(directory(), dist);
    await expect(installLegacySearch048Query(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_048_PATH_UNSAFE',
    );
    const untouched = legacyDirectory();
    let stop = false;
    await expect(
      installLegacySearch048Query(
        untouched,
        async () => {
          stop = true;
          return source();
        },
        () => {
          if (stop) throw new Error('RUNTIME_INTERRUPTED');
        },
      ),
    ).rejects.toThrow('RUNTIME_INTERRUPTED');
    expect(existsSync(join(untouched.path, LEGACY_SEARCH_048_BASELINE.compiledPath))).toBe(false);
  });
});

describe('WP050/051 immutable product and WP050 fixed WP049 control', () => {
  const source = () =>
    execFileSync(
      'git',
      ['show', `${LEGACY_SEARCH_049_BASELINE.ref}:${LEGACY_SEARCH_049_BASELINE.sourcePath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  it.each(['WP-P2-PERF-050', 'WP-P2-PERF-051'])(
    '%s rechecks exact product bytes and suppresses private reader errors',
    (workPackage) => {
      const product = source();
      const read = vi.fn(() => product);
      const guard = createSearchProductSourceGuard(workPackage, read);
      expect(guard()).toEqual(assertSearch049ProductSource(product));
      read.mockReturnValue(product + '\n');
      expect(guard).toThrow('SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH');
      read.mockImplementation(() => {
        throw new Error('private-filesystem-path-and-credential');
      });
      expect(guard).toThrow('SEARCH_REPRO_PRODUCT_SOURCE_UNAVAILABLE');
      expect(read).toHaveBeenCalledTimes(3);
    },
  );
  it('keeps earlier packages unpinned while rejecting unknown packages and reader types', () => {
    const read = vi.fn(() => {
      throw new Error('must-not-read');
    });
    expect(createSearchProductSourceGuard('WP-P2-PERF-041', read)()).toBeUndefined();
    expect(createSearchProductSourceGuard('WP-P2-PERF-049', read)()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(() => createSearchProductSourceGuard('WP-P2-PERF-052', read)).toThrow(
      'WORK_PACKAGE_NOT_ALLOWED',
    );
    expect(() => createSearchProductSourceGuard('WP-P2-PERF-051', null)).toThrow(
      'PRODUCT_SOURCE_READER_INVALID',
    );
  });
  it('rejects changed WP051 source before constructing a read-only app connection', async () => {
    const guard = createSearchProductSourceGuard('WP-P2-PERF-051', () => source() + '\n');
    const { access, createClient, assertReady } = readOnlyHarness();
    assertReady.mockImplementation(async () => {
      guard();
    });
    const callback = vi.fn();
    await expect(access.withAppReadOnly(context, callback)).rejects.toThrow(
      'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
  });
  it('pins the current product to exact WP049 bytes and preserves a distinct compiled control', async () => {
    const identity = legacyDirectory();
    const product = source();
    const metadata = assertSearch049ProductSource(product);
    expect(metadata).toEqual({
      sourcePath: 'services/api/src/modules/ticket/ticket-query.ts',
      sha256: '8b638fc7194849ba8cbe682423f8c100f9b96ca28e64bc3472f6ef22cf4691f5',
      matchesFixed049: true,
    });
    expect(assertSearch049ProductSource(Buffer.from(product))).toEqual(metadata);
    expect(() => assertSearch049ProductSource(product + '\n')).toThrow(
      'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
    );
    expect(() => assertSearch049ProductSource(null)).toThrow(
      'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
    );
    const installed = await installLegacySearch049Query(identity, async () => product);
    expect(installed).toMatchObject({
      ref: 'a49ecbdf45047c8daa48027635649f8869e311c6',
      sourceSha256: metadata.sha256,
      compiledPath:
        'services/api/dist/modules/ticket/ticket-query.legacy-search-049-control-050.js',
    });
    expect(installed.compiledPath).not.toBe(LEGACY_SEARCH_048_BASELINE.compiledPath);
    const output = readFileSync(join(identity.path, installed.compiledPath), 'utf8');
    expect(createHash('sha256').update(output).digest('hex')).toBe(installed.compiledSha256);
    expect(lstatSync(join(identity.path, installed.compiledPath)).mode & 0o777).toBe(0o600);
    await expect(installLegacySearch049Query(identity, async () => product)).rejects.toThrow(
      'LEGACY_SEARCH_049_ALREADY_EXISTS',
    );
  });
  it('rejects altered fixed source or replaced owner before writing', async () => {
    const identity = legacyDirectory();
    await expect(installLegacySearch049Query(identity, async () => source() + ' ')).rejects.toThrow(
      'LEGACY_SEARCH_049_SOURCE_MISMATCH',
    );
    const read = vi.fn(async () => source());
    writeFileSync(join(identity.path, '.solvi-perf041-owner'), 'changed-owner');
    await expect(installLegacySearch049Query(identity, read)).rejects.toThrow(
      'TEMP_TOKEN_MISMATCH',
    );
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(identity.path, LEGACY_SEARCH_049_BASELINE.compiledPath))).toBe(false);
  });
  it('refuses redirected compilation and cancellation before output', async () => {
    const identity = legacyDirectory();
    const dist = join(identity.path, 'services/api/dist');
    rmSync(dist, { recursive: true });
    symlinkSync(directory(), dist);
    await expect(installLegacySearch049Query(identity, async () => source())).rejects.toThrow(
      'LEGACY_SEARCH_049_PATH_UNSAFE',
    );
    const clean = legacyDirectory();
    let aborted = false;
    await expect(
      installLegacySearch049Query(
        clean,
        async () => {
          aborted = true;
          return source();
        },
        () => {
          if (aborted) throw new Error('RUNTIME_INTERRUPTED');
        },
      ),
    ).rejects.toThrow('RUNTIME_INTERRUPTED');
    expect(existsSync(join(clean.path, LEGACY_SEARCH_049_BASELINE.compiledPath))).toBe(false);
  });
});

const cpuStat = 'usage_usec 15\nuser_usec 10\nsystem_usec 5\n';
const ioStat = '8:0 rbytes=100 wbytes=200 rios=3 wios=4 dbytes=0 dios=0\n';
describe('WP050 cgroup-v2 resource parser', () => {
  it('aggregates numeric devices and retains absent optional CPU values as null', () => {
    expect(
      parseDatabaseResources(cpuStat + ioStat + '259:2 wios=5 rios=2 wbytes=30 rbytes=40\n'),
    ).toEqual({
      cpu: {
        usage_usec: 15,
        user_usec: 10,
        system_usec: 5,
        nr_periods: null,
        nr_throttled: null,
        throttled_usec: null,
      },
      io: { rbytes: 140, wbytes: 230, rios: 5, wios: 9 },
      devices: 2,
    });
    const emptyIo = parseDatabaseResources(cpuStat);
    expect(emptyIo.devices).toBe(0);
    expect(emptyIo.io).toEqual({ rbytes: 0, wbytes: 0, rios: 0, wios: 0 });
  });
  it('accepts known extra CPU and discard counters without publishing them or device IDs', () => {
    const parsed = parseDatabaseResources(
      cpuStat +
        'nr_periods 12\nnr_throttled 2\nthrottled_usec 4\nnr_bursts 0\nburst_usec 0\n' +
        ioStat,
    );
    expect(parsed.cpu).toMatchObject({ nr_periods: 12, nr_throttled: 2, throttled_usec: 4 });
    expect(JSON.stringify(parsed)).not.toMatch(/8:0|nr_bursts|burst_usec|dbytes|dios/);
  });
  it('validates the optional Linux core scheduling counter without changing the public DTO', () => {
    const plain = parseDatabaseResources(cpuStat + ioStat);
    for (const value of [0, 12345, Number.MAX_SAFE_INTEGER]) {
      const parsed = parseDatabaseResources(
        cpuStat + `core_sched.force_idle_usec ${value}\n` + ioStat,
      );
      expect(parsed).toEqual(plain);
      expect(JSON.stringify(parsed)).not.toContain('core_sched');
    }
  });
  it.each(['-1', '1.5', '9007199254740992', 'NaN'])(
    'rejects invalid optional core scheduling counter %s',
    (value) => {
      expect(() =>
        parseDatabaseResources(cpuStat + `core_sched.force_idle_usec ${value}\n`),
      ).toThrow('CGROUP_PAYLOAD_INVALID');
    },
  );
  it('rejects duplicate or unknown core scheduling fields', () => {
    expect(() =>
      parseDatabaseResources(
        cpuStat + 'core_sched.force_idle_usec 0\ncore_sched.force_idle_usec 1\n',
      ),
    ).toThrow('CGROUP_PAYLOAD_INVALID');
    expect(() => parseDatabaseResources(cpuStat + 'core_sched.private_counter 0\n')).toThrow(
      'CGROUP_PAYLOAD_INVALID',
    );
  });
  it.each([
    ['', 'missing CPU'],
    ['usage_usec 10\nuser_usec 8\n', 'missing required system'],
    [cpuStat + 'usage_usec 1\n', 'duplicate CPU'],
    [cpuStat.replace('15', '-1'), 'negative CPU'],
    [cpuStat.replace('15', '1.5'), 'fractional CPU'],
    [cpuStat.replace('15', '9007199254740992'), 'unsafe CPU'],
    [cpuStat.replace('15', '1e2'), 'exponential CPU'],
    [cpuStat + 'PRIVATE_SECRET 1\n', 'unknown CPU'],
    [cpuStat + ioStat + ioStat, 'duplicate device'],
    [cpuStat + ioStat.replace('rbytes=100', 'rbytes=100 rbytes=2'), 'duplicate IO'],
    [cpuStat + ioStat.replace('rbytes=100', 'private=100'), 'unknown IO'],
    [cpuStat + ioStat.replace('rios=3 ', ''), 'missing IO'],
    [cpuStat + ioStat.replace('rbytes=100', 'rbytes=-1'), 'negative IO'],
    [cpuStat + ioStat.replace('rbytes=100', 'rbytes=9007199254740992'), 'unsafe IO'],
    [
      cpuStat +
        ioStat.replace('rbytes=100', 'rbytes=9007199254740991') +
        '8:1 rbytes=1 wbytes=0 rios=0 wios=0\n',
      'unsafe aggregate',
    ],
    [cpuStat + ioStat + 'nr_periods 1\n', 'CPU after IO'],
    [cpuStat + ioStat.replace('8:0', '08:0'), 'ambiguous device'],
    [cpuStat + ioStat.replace('8:0', '9007199254740992:0'), 'unsafe device'],
    [
      cpuStat +
        Array.from({ length: 257 }, (_, i) => `${i}:0 rbytes=0 wbytes=0 rios=0 wios=0\n`).join(''),
      'device bound',
    ],
    [cpuStat + 'bad\n'.repeat(512), 'line bound'],
  ])('rejects %s (%s) with a bounded error', (text) => {
    expect(() => parseDatabaseResources(text)).toThrow('CGROUP_PAYLOAD_INVALID');
  });
  it('bounds input bytes before parsing', () => {
    expect(() => parseDatabaseResources('x'.repeat(65_537))).toThrow('CGROUP_OUTPUT_TOO_LARGE');
    expect(() => parseDatabaseResources({ text: cpuStat })).toThrow('CGROUP_PAYLOAD_INVALID');
  });
});

describe('WP050 owned resource reader', () => {
  const id = 'a'.repeat(64);
  it('uses one fixed unprivileged cat argv between ownership/source checks', async () => {
    const assertReady = vi.fn(async () => id);
    const execute = vi.fn(async () => ({ code: 0, stdout: cpuStat + ioStat }));
    let tick = 10;
    const read = createDatabaseResourceReader({
      assertReady,
      execute,
      now: () => tick++,
      clock: () => '2026-10-05T00:00:00.000Z',
    });
    expect(await read()).toMatchObject({
      available: true,
      source: 'cgroup-v2',
      capturedAt: '2026-10-05T00:00:00.000Z',
      durationMs: 1,
      devices: 1,
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith([
      'exec',
      '--user',
      'postgres',
      id,
      'cat',
      '/sys/fs/cgroup/cpu.stat',
      '/sys/fs/cgroup/io.stat',
    ]);
    expect(assertReady).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ code: 1, stdout: cpuStat, stderr: 'PRIVATE_SECRET' }, 'CGROUP_UNAVAILABLE'],
    [{ code: -2, stdout: '', stderr: 'PRIVATE_SECRET' }, 'CGROUP_READ_TIMEOUT'],
    [{ code: 0, stdout: 'PRIVATE_SECRET' }, 'CGROUP_PAYLOAD_INVALID'],
    [{ code: 0, stdout: 'x'.repeat(65_537) }, 'CGROUP_OUTPUT_TOO_LARGE'],
    [{ code: 0, stdout: cpuStat, outputBytes: 2_097_153 }, 'CGROUP_OUTPUT_TOO_LARGE'],
  ])(
    'preserves an unavailable observation without publishing child output',
    async (response, reason) => {
      const read = createDatabaseResourceReader({
        assertReady: async () => id,
        execute: async () => response,
      });
      const result = await read();
      expect(result).toMatchObject({ available: false, reason });
      expect(result).not.toHaveProperty('cpu');
      expect(result).not.toHaveProperty('io');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SECRET|stdout|stderr/);
    },
  );
  it('masks an unknown reader exception but rechecks safety', async () => {
    const assertReady = vi.fn(async () => id);
    const read = createDatabaseResourceReader({
      assertReady,
      execute: async () => {
        throw new Error('PRIVATE_SECRET_VALUE');
      },
    });
    expect(await read()).toMatchObject({ available: false, reason: 'CGROUP_READ_FAILED' });
    expect(assertReady).toHaveBeenCalledTimes(2);
  });
  it.each(['CONTAINER_TOKEN_MISMATCH', 'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH'])(
    'fails closed before reading on %s',
    async (reason) => {
      const execute = vi.fn();
      const read = createDatabaseResourceReader({
        assertReady: async () => {
          throw new Error(reason);
        },
        execute,
      });
      await expect(read()).rejects.toThrow(reason);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('refuses invalid or changed ownership IDs', async () => {
    const execute = vi.fn(async () => ({ code: 0, stdout: cpuStat }));
    await expect(
      createDatabaseResourceReader({ assertReady: async () => 'arbitrary-target', execute })(),
    ).rejects.toThrow('CGROUP_CONTAINER_ID_INVALID');
    expect(execute).not.toHaveBeenCalled();
    const assertReady = vi.fn().mockResolvedValueOnce(id).mockResolvedValueOnce('b'.repeat(64));
    await expect(createDatabaseResourceReader({ assertReady, execute })()).rejects.toThrow(
      'CGROUP_CONTAINER_CHANGED',
    );
  });
  it('does not soften a post-read source violation into unavailable data', async () => {
    const assertReady = vi
      .fn()
      .mockResolvedValueOnce(id)
      .mockRejectedValueOnce(new Error('SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH'));
    await expect(
      createDatabaseResourceReader({
        assertReady,
        execute: async () => ({ code: 1, stdout: '' }),
      })(),
    ).rejects.toThrow('SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH');
  });
  it.each(['before', 'during'])('propagates interruption %s the read', async (when) => {
    let aborted = when === 'before';
    const execute = vi.fn(async () => {
      aborted = true;
      return { code: -2, stdout: 'PRIVATE_SECRET' };
    });
    const read = createDatabaseResourceReader({
      assertReady: async () => id,
      execute,
      assertLive: () => {
        if (aborted) throw new Error('RUNTIME_INTERRUPTED');
      },
    });
    await expect(read()).rejects.toThrow('RUNTIME_INTERRUPTED');
    expect(execute).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
  });
});

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
};
interface ReadOnlyFacade {
  proof: Record<string, unknown>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}
const readOnlyHarness = (
  proofOverrides: Record<string, unknown> = {},
  signal?: AbortSignal,
  budgetMs?: number,
) => {
  const client = {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    on: vi.fn(),
    query: vi.fn(async (input: string | { text: string; values: unknown[]; queryMode: string }) => {
      if (input === 'UPDATE ticket SET id=id WHERE false') {
        throw Object.assign(new Error('private database detail'), { code: '25006' });
      }
      return {
        rows:
          typeof input === 'string' && input.startsWith('SELECT current_user')
            ? [
                {
                  role_name: 'solvi_app',
                  rolsuper: false,
                  rolbypassrls: false,
                  owns_tables: false,
                  read_only: 'on',
                  isolation_level: 'repeatable read',
                  row_security: 'on',
                  organization_id: context.organizationId,
                  actor_id: context.actorId,
                  ticket_rls_active: true,
                  ticket_rls_forced: true,
                  ...proofOverrides,
                },
              ]
            : [],
      };
    }),
  };
  const createClient = vi.fn(() => client);
  const assertReady = vi.fn(async () => {});
  const assertIdentity = vi.fn(async () => {});
  const access = createAppReadOnlyAccess({
    createClient,
    assertReady,
    assertIdentity,
    signal,
    budgetMs,
  });
  return { client, createClient, assertReady, assertIdentity, access };
};

describe('performance read-only application access', () => {
  it('rechecks ownership and app identity before a local-context read-only transaction and always rolls back', async () => {
    const { client, assertReady, assertIdentity, access } = readOnlyHarness();
    const result = await access.withAppReadOnly(context, async (app: ReadOnlyFacade) => {
      expect(app.proof).toMatchObject({
        role: 'solvi_app',
        superuser: false,
        bypassRls: false,
        ownsTables: false,
        readOnly: true,
        ticketRlsActive: true,
        ticketRlsForced: true,
        transactionLocalContext: true,
        readOnlyWriteRejected: true,
        readOnlyWriteSqlState: '25006',
      });
      expect(JSON.stringify(app.proof)).not.toContain(context.actorId);
      await app.query('SELECT id FROM ticket WHERE id=$1', [context.actorId]);
      await app.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM ticket');
      return 'complete';
    });
    expect(result).toBe('complete');
    expect(assertReady).toHaveBeenCalledOnce();
    expect(assertIdentity).toHaveBeenCalledWith(client);
    expect(client.query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.current_org',$1,true)"),
      [context.organizationId, context.actorId],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        queryMode: 'extended',
        text: 'SELECT id FROM ticket WHERE id=$1',
        values: [context.actorId],
      }),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ queryMode: 'extended', values: [] }),
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    const statements = client.query.mock.calls.map(([input]) => input);
    const probeIndex = statements.indexOf('UPDATE ticket SET id=id WHERE false');
    expect(statements.slice(probeIndex, probeIndex + 3)).toEqual([
      'UPDATE ticket SET id=id WHERE false',
      'ROLLBACK',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    ]);
    expect(statements.filter((input) => input === 'ROLLBACK')).toHaveLength(2);
    expect(client.end).toHaveBeenCalledOnce();
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
  });

  it.each([
    [{ role_name: 'solvi_owner' }, 'APPLICATION_ROLE_UNSAFE'],
    [{ rolsuper: true }, 'APPLICATION_ROLE_UNSAFE'],
    [{ rolbypassrls: true }, 'APPLICATION_ROLE_UNSAFE'],
    [{ owns_tables: true }, 'APPLICATION_ROLE_UNSAFE'],
    [{ read_only: 'off' }, 'READ_ONLY_RLS_NOT_ACTIVE'],
    [{ isolation_level: 'read committed' }, 'READ_ONLY_RLS_NOT_ACTIVE'],
    [{ row_security: 'off' }, 'READ_ONLY_RLS_NOT_ACTIVE'],
    [{ ticket_rls_active: false }, 'READ_ONLY_RLS_NOT_ACTIVE'],
    [{ ticket_rls_forced: false }, 'READ_ONLY_RLS_NOT_ACTIVE'],
    [{ organization_id: context.actorId }, 'READ_ONLY_CONTEXT_MISMATCH'],
    [{ actor_id: context.organizationId }, 'READ_ONLY_CONTEXT_MISMATCH'],
  ])('refuses unsafe role/RLS/context proof %j before calling user code', async (proof, code) => {
    const { client, access } = readOnlyHarness(proof);
    const callback = vi.fn();
    await expect(access.withAppReadOnly(context, callback)).rejects.toThrow(code);
    expect(callback).not.toHaveBeenCalled();
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('refuses invalid context and changed container ownership before connecting', async () => {
    const { createClient, assertReady, access } = readOnlyHarness();
    await expect(
      access.withAppReadOnly({ ...context, organizationId: 'other-database' }, vi.fn()),
    ).rejects.toThrow('READ_ONLY_CONTEXT_INVALID');
    expect(assertReady).not.toHaveBeenCalled();
    assertReady.mockRejectedValueOnce(new Error('CONTAINER_TOKEN_MISMATCH'));
    await expect(access.withAppReadOnly(context, vi.fn())).rejects.toThrow(
      'CONTAINER_TOKEN_MISMATCH',
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'READ_ONLY_WRITE_PROBE_NOT_REJECTED'],
    ['42501', 'READ_ONLY_WRITE_PROBE_UNEXPECTED_ERROR'],
  ])(
    'requires actual read-only SQLSTATE rather than success or an unrelated error (%s)',
    async (code, failure) => {
      const { client, access } = readOnlyHarness();
      const original = client.query.getMockImplementation()!;
      client.query.mockImplementation(async (input) => {
        if (input === 'UPDATE ticket SET id=id WHERE false') {
          if (code) throw Object.assign(new Error('private SQL details'), { code });
          return { rows: [] };
        }
        return original(input);
      });
      const callback = vi.fn();
      await expect(access.withAppReadOnly(context, callback)).rejects.toThrow(failure);
      expect(callback).not.toHaveBeenCalled();
      expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      expect(client.end).toHaveBeenCalledOnce();
    },
  );

  it('closes a mismatched actual database connection before beginning a transaction', async () => {
    const { client, assertIdentity, access } = readOnlyHarness();
    assertIdentity.mockRejectedValueOnce(new Error('CONNECTED_DATABASE_IDENTITY_MISMATCH'));
    await expect(access.withAppReadOnly(context, vi.fn())).rejects.toThrow(
      'CONNECTED_DATABASE_IDENTITY_MISMATCH',
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(['COMMIT', 'ROLLBACK', 'SET TRANSACTION READ WRITE', 'DELETE FROM ticket', 'BEGIN'])(
    'rejects transaction escape or write command %s',
    async (sql) => {
      const { client, access } = readOnlyHarness();
      await expect(
        access.withAppReadOnly(context, (app: ReadOnlyFacade) => app.query(sql)),
      ).rejects.toThrow('READ_ONLY_QUERY_REQUIRED');
      expect(client.query.mock.calls.some(([input]) => typeof input !== 'string')).toBe(false);
      expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      expect(client.end).toHaveBeenCalledOnce();
    },
  );

  it('rolls back after callback failure and suppresses SQL/parameter or credential error details', async () => {
    const { client, access } = readOnlyHarness();
    await expect(
      access.withAppReadOnly(context, async () => {
        throw new Error('private SQL with password and user values');
      }),
    ).rejects.toThrow('RUNTIME_ERROR_DETAILS_SUPPRESSED');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('ends active private connections on cancellation, rejects reuse, and closes idempotently', async () => {
    const controller = new AbortController();
    const { client, access } = readOnlyHarness({}, controller.signal);
    const entered = vi.fn();
    const operation = access.withAppReadOnly(context, async () => {
      entered();
      return new Promise(() => {});
    });
    const assertion = expect(operation).rejects.toThrow('RUNTIME_INTERRUPTED');
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(client.end).toHaveBeenCalledOnce();
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
    await expect(access.withAppReadOnly(context, vi.fn())).rejects.toThrow('RUNTIME_INTERRUPTED');
  });

  it('closes active connections during runtime cleanup without requiring the callback to return', async () => {
    const { client, access } = readOnlyHarness();
    const entered = vi.fn();
    const operation = access.withAppReadOnly(context, async () => {
      entered();
      return new Promise(() => {});
    });
    const assertion = expect(operation).rejects.toThrow('RUNTIME_INTERRUPTED');
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
    await assertion;
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('bounds a stalled callback and never counts a failed connection close as clean', async () => {
    const { client, access } = readOnlyHarness({}, undefined, 5);
    client.end.mockRejectedValue(new Error('private driver details'));
    await expect(access.withAppReadOnly(context, () => new Promise(() => {}))).rejects.toThrow(
      'APP_CLIENT_CLOSE_FAILED',
    );
    await expect(access.closeAll()).resolves.toEqual({ success: false, remaining: 1 });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('ends the owned connection when the complete read-only callback exceeds its budget', async () => {
    const { client, access } = readOnlyHarness({}, undefined, 5);
    await expect(access.withAppReadOnly(context, () => new Promise(() => {}))).rejects.toThrow(
      'READ_ONLY_CALLBACK_TIMEOUT',
    );
    expect(client.end).toHaveBeenCalledOnce();
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
  });

  it('prevents a pending ownership check from opening a connection after runtime cleanup', async () => {
    const { createClient, assertReady, access } = readOnlyHarness();
    let release!: () => void;
    assertReady.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const operation = access.withAppReadOnly(context, vi.fn());
    const assertion = expect(operation).rejects.toThrow('RUNTIME_INTERRUPTED');
    await expect(access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
    release();
    await assertion;
    expect(createClient).not.toHaveBeenCalled();
  });

  it('refuses reuse of a callback facade after its transaction has been rolled back and closed', async () => {
    const { access } = readOnlyHarness();
    let retained!: ReadOnlyFacade;
    await access.withAppReadOnly(context, (app: ReadOnlyFacade) => {
      retained = app;
    });
    await expect(retained.query('SELECT 1')).rejects.toThrow('READ_ONLY_CONNECTION_CLOSED');
  });
});

describe('WP053 fixed static preparation and reader', () => {
  const fixture = () => {
    const definition = staticSearchFixtureDefinition();
    return {
      organizationId: definition.organizationId,
      controlOrganizationId: definition.controlOrganizationId,
      actors: Object.fromEntries(
        definition.users.map((user: { key: string; id: string; organizationId: string }) => [
          user.key,
          {
            userId: user.id,
            context: { organizationId: user.organizationId, principal: { userId: user.id } },
          },
        ]),
      ),
    };
  };
  const preparationHarness = (emptyOverrides = {}, envOverrides = {}, countOverrides = {}) => {
    const admin = {
      query: vi.fn(async (input: string) => {
        if (input.includes("to_regnamespace('perf053')"))
          return {
            rows: [
              { tickets: 0, users: 0, organizations: 0, schema_absent: true, ...emptyOverrides },
            ],
          };
        if (input.includes('pg_database_collation_actual_version'))
          return {
            rows: [
              {
                engine: '160006',
                encoding: 'UTF8',
                provider: 'i',
                locale: 'ja-JP',
                version: '153.120',
                actual_version: '153.120',
                deterministic: true,
                ticket_default: true,
                fixture_now: new Date('2026-10-07T00:00:00Z'),
                ...envOverrides,
              },
            ],
          };
        if (input.includes('AS generated_correct'))
          return {
            rows: [
              {
                tickets: 4096,
                users: 8,
                bindings: 7,
                postings: 123456,
                max_body: 32,
                bytes: '10000000',
                organization_tickets: 2048,
                control_tickets: 2048,
                generated_correct: true,
                ...countOverrides,
              },
            ],
          };
        return { rows: [] };
      }),
    };
    const ready = vi.fn(async () => {});
    return { admin, ready };
  };
  const readerHarness = (
    overrides: Record<string, unknown> = {},
    signal?: AbortSignal,
    budgetMs?: number,
  ) => {
    const data = fixture();
    let organizationId: string | null = null;
    let actorId: string | null = null;
    const state: Record<string, unknown> = {};
    const client = {
      connect: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      on: vi.fn(),
      query: vi.fn(
        async (
          input: string | { text: string; values: unknown[]; queryMode: string },
          params?: unknown[],
        ) => {
          if (typeof input === 'object') return { rows: [{ n: 1 }] };
          if (input.includes("SELECT set_config('app.current_org'"))
            organizationId = String(params?.[0]);
          if (input.includes("SELECT set_config('app.current_actor'"))
            actorId = String(params?.[0]);
          if (input === 'UPDATE public.ticket SET id=id WHERE false')
            throw Object.assign(new Error('private SQL'), { code: '25006' });
          if (input.startsWith('SELECT current_user'))
            return {
              rows: [
                {
                  role_name: 'solvi_app',
                  rolsuper: false,
                  rolbypassrls: false,
                  owns_tables: false,
                  read_only: 'on',
                  isolation_level: 'repeatable read',
                  row_security: 'on',
                  seqscan: 'on',
                  statement_timeout: '30s',
                  organization_id: organizationId,
                  actor_id: actorId,
                  autoclose_disabled: true,
                  ticket_rls_active: true,
                  ticket_rls_forced: true,
                  posting_rls_active: true,
                  posting_rls_forced: true,
                  schema_usage: true,
                  schema_create: false,
                  posting_select: true,
                  posting_write: false,
                  token_bytea: true,
                  ...overrides,
                  ...state,
                },
              ],
            };
          if (input.includes('AS ticket_count'))
            return { rows: [{ ticket_count: 0, posting_count: 0, ...state }] };
          return { rows: [] };
        },
      ),
    };
    const createClient = vi.fn(() => client);
    const ready = vi.fn(async () => {});
    const identity = vi.fn(async () => {});
    const access = createStaticReadOnlyAccess({
      createClient,
      assertReady: ready,
      assertIdentity: identity,
      getFixture: () => data,
      signal,
      budgetMs,
    });
    return { data, client, createClient, ready, identity, access, state };
  };

  it('permits only WP053 and binds its container/source guard to the fixed049 bytes', () => {
    expect(assertWorkPackage('WP-P2-PERF-053')).toBe('WP-P2-PERF-053');
    expect(() => assertWorkPackage('WP-P2-PERF-052')).toThrow('WORK_PACKAGE_NOT_ALLOWED');
    const expected = { ...expectedContainer(), workPackage: 'WP-P2-PERF-053' };
    const value = container();
    value.Config.Labels['solvi.wp'] = 'WP-P2-PERF-053';
    expect(assertOwnedContainer(value, expected)).toBe(value);
    expect(() =>
      assertOwnedContainer(value, { ...expected, workPackage: 'WP-P2-PERF-051' }),
    ).toThrow('CONTAINER_WP_MISMATCH');
    const source = readFileSync(join(process.cwd(), LEGACY_SEARCH_049_BASELINE.sourcePath));
    const readSource = vi.fn(() => source);
    const guard = createSearchProductSourceGuard('WP-P2-PERF-053', readSource);
    expect(guard()).toMatchObject({ matchesFixed049: true });
    readSource.mockReturnValue(Buffer.from('different bytes'));
    expect(guard).toThrow('SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH');
  });

  it('keeps the fixed 4096 recipe, organization split, own needle and native boundary fields', () => {
    const f = staticSearchFixtureDefinition();
    expect(f.tickets).toHaveLength(4096);
    expect(f.users).toHaveLength(8);
    expect(
      f.tickets.filter((t: { organization_id: string }) => t.organization_id === f.organizationId),
    ).toHaveLength(2048);
    expect(f.tickets[0]).toMatchObject({
      number: 'TKT-000000',
      subject: 'padding 0000',
      body: 'static row 0000 qxzneedle',
      requester_id: f.users.find((u: { key: string }) => u.key === 'requester').id,
    });
    expect(
      f.tickets.filter((t: { body: string; subject: string; number: string }) =>
        /qxz|jkv/.test(t.body + t.subject + t.number),
      ),
    ).toHaveLength(1);
    expect(new Set(f.tickets.slice(0, 16).map((t: { state: string }) => t.state)).size).toBe(8);
    expect(
      f.tickets
        .slice(16)
        .every(
          (t: { body: string; state: string }) =>
            /^static row \d{4}$/.test(t.body) && t.state === 'new',
        ),
    ).toBe(true);
    expect(new Set(f.tickets.map((t: { id: string }) => t.id)).size).toBe(4096);
    expect(JSON.stringify(staticSearchFixtureDefinition())).toBe(JSON.stringify(f));
  });

  it('prepares only a new owned database, fixed SELECT-only posting and native PG tokenization, then commits', async () => {
    const h = preparationHarness();
    const result = await prepareStaticSearchFixture(h.admin, h.ready);
    expect(result.counts).toMatchObject({ tickets: 4096, users: 8, postings: 123456 });
    expect(result.definitionSha256).toBe(
      createHash('sha256').update(JSON.stringify(staticSearchFixtureDefinition())).digest('hex'),
    );
    expect(result.actors.expired.context.principal.bindings[0].validUntil.getTime()).toBeLessThan(
      result.actors.expired.context.now.getTime(),
    );
    expect(result.actors.revoked.context.principal.bindings).toEqual([]);
    expect(result.actors.deactivated.context.principal.status).toBe('deactivated');
    const sql = h.admin.query.mock.calls.map(([input]) => input).join('\n');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT SELECT ON perf053.search_posting TO solvi_app');
    expect(sql).toContain('substring(lower(t.search_text) FROM n FOR 3)');
    expect(sql).not.toMatch(
      /SECURITY DEFINER|DISABLE ROW LEVEL|LEAKPROOF|app\.autoclose|GRANT.*(?:UPDATE|INSERT).*solvi_app/,
    );
    expect(h.ready.mock.calls.length).toBeGreaterThan(10);
    expect(h.admin.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it.each([{ tickets: 1 }, { organizations: 1 }, { users: 1 }, { schema_absent: false }])(
    'rejects a nonempty fixture before writes %j',
    async (overrides) => {
      const h = preparationHarness(overrides);
      await expect(prepareStaticSearchFixture(h.admin, h.ready)).rejects.toThrow(
        'STATIC_FIXTURE_NOT_EMPTY',
      );
      expect(h.admin.query).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { engine: '170000' },
    { provider: 'c' },
    { locale: 'en-US' },
    { deterministic: false },
    { actual_version: 'different' },
    { ticket_default: false },
  ])('rolls back unknown collation %j', async (overrides) => {
    const h = preparationHarness({}, overrides);
    await expect(prepareStaticSearchFixture(h.admin, h.ready)).rejects.toThrow(
      'STATIC_COLLATION_INVALID',
    );
    expect(h.admin.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it.each([
    { postings: 1000001 },
    { max_body: 2049 },
    { bytes: String(512 * 1024 * 1024 + 1) },
    { generated_correct: false },
    { control_tickets: 2047 },
    { users: 9 },
  ])('rolls back a fixture limit/proof failure %j', async (overrides) => {
    const h = preparationHarness({}, {}, overrides);
    await expect(prepareStaticSearchFixture(h.admin, h.ready)).rejects.toThrow(
      'STATIC_FIXTURE_LIMIT_EXCEEDED',
    );
    expect(h.admin.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('refuses preparation before any SQL if ownership/source checks fail', async () => {
    const h = preparationHarness();
    h.ready.mockRejectedValueOnce(new Error('SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH'));
    await expect(prepareStaticSearchFixture(h.admin, h.ready)).rejects.toThrow(
      'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
    );
    expect(h.admin.query).not.toHaveBeenCalled();
  });

  it.each(STATIC_CONTEXT_KEYS)(
    'uses a private app connection and verifies %s before and after each query',
    async (key) => {
      const h = readerHarness();
      await h.access.withStaticReadOnly(key, async (client: ReadOnlyFacade) => {
        expect(client.proof).toMatchObject({
          postingSelectOnly: true,
          postingRlsActive: true,
          readOnlyWriteRejected: true,
          foreignRowsDenied: true,
          actorContextPresent: key !== 'actor-missing',
        });
        expect(JSON.stringify(client.proof)).not.toContain(h.data.organizationId);
        await client.query('SELECT lower($1::text)', ['private fixture input']);
        await client.query(
          'EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM perf053.search_posting',
        );
      });
      expect(h.identity).toHaveBeenCalledWith(h.client);
      const sql = h.client.query.mock.calls.map(([input]) =>
        typeof input === 'string' ? input : input.text,
      );
      expect(sql.filter((s) => s.startsWith('SELECT current_user')).length).toBeGreaterThanOrEqual(
        7,
      );
      expect(sql.filter((s) => s.includes("SELECT set_config('app.current_actor'"))).toHaveLength(
        key === 'actor-missing' ? 0 : 2,
      );
      expect(sql.at(-1)).toBe('ROLLBACK');
      expect(h.client.end).toHaveBeenCalledOnce();
      await expect(h.access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
    },
  );
  it.each(['owner', '', { actorId: context.actorId }, null])(
    'refuses arbitrary context %j before connecting',
    async (key) => {
      const h = readerHarness();
      await expect(h.access.withStaticReadOnly(key, async () => {})).rejects.toThrow(
        'STATIC_CONTEXT_INVALID',
      );
      expect(h.createClient).not.toHaveBeenCalled();
    },
  );
  it.each([
    { posting_write: true },
    { posting_select: false },
    { posting_rls_forced: false },
    { posting_rls_active: false },
    { schema_create: true },
    { token_bytea: false },
    { owns_tables: true },
    { rolbypassrls: true },
    { read_only: 'off' },
    { seqscan: 'off' },
    { statement_timeout: '0' },
  ])('refuses a weakened proof %j', async (overrides) => {
    const h = readerHarness(overrides);
    const callback = vi.fn();
    await expect(h.access.withStaticReadOnly('requester', callback)).rejects.toThrow(
      'STATIC_PROOF_INVALID',
    );
    expect(callback).not.toHaveBeenCalled();
    expect(h.client.end).toHaveBeenCalledOnce();
  });
  it.each([
    { autoclose_disabled: false },
    { actor_id: context.actorId },
    { organization_id: context.organizationId },
  ])('refuses contaminated actorless context %j', async (overrides) => {
    const h = readerHarness(overrides);
    await expect(h.access.withStaticReadOnly('actor-missing', async () => {})).rejects.toThrow(
      'STATIC_CONTEXT_CHANGED',
    );
  });
  it('does not return rows if context is changed during the callback', async () => {
    const h = readerHarness();
    await expect(
      h.access.withStaticReadOnly('agent', async (client: ReadOnlyFacade) => {
        h.state.organization_id = h.data.controlOrganizationId;
        await client.query('SELECT 1');
      }),
    ).rejects.toThrow('STATIC_CONTEXT_CHANGED');
    expect(h.client.end).toHaveBeenCalledOnce();
  });
  it.each([
    'COMMIT',
    'UPDATE ticket SET id=id',
    'SELECT set_config($1,$2,true)',
    'EXPLAIN UPDATE ticket SET id=id',
    'SELECT pg_sleep(1)',
  ])('rejects setting/transaction/mutation SQL %s', async (sql) => {
    const h = readerHarness();
    await expect(
      h.access.withStaticReadOnly('agent', (client: ReadOnlyFacade) => client.query(sql)),
    ).rejects.toThrow('STATIC_QUERY_REQUIRED');
    expect(h.client.query.mock.calls.some(([input]) => typeof input === 'object')).toBe(false);
  });
  it('suppresses callback details, rolls back and closes', async () => {
    const h = readerHarness();
    await expect(
      h.access.withStaticReadOnly('agent', async () => {
        throw new Error('PRIVATE_TOKEN_VALUE');
      }),
    ).rejects.toThrow('STATIC_CALLBACK_FAILED');
    expect(h.client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(h.client.end).toHaveBeenCalledOnce();
  });
  it('aborts and closes the owned callback connection', async () => {
    const controller = new AbortController();
    const h = readerHarness({}, controller.signal);
    const result = h.access.withStaticReadOnly('agent', async () => {
      controller.abort();
      await new Promise(() => {});
    });
    await expect(result).rejects.toThrow('STATIC_ABORTED');
    expect(h.client.end).toHaveBeenCalledOnce();
    await expect(h.access.closeAll()).resolves.toEqual({ success: true, remaining: 0 });
  });
  it('bounds a callback that never finishes and prevents retained connection reuse', async () => {
    const h = readerHarness({}, undefined, 5);
    let retained: ReadOnlyFacade | undefined;
    await expect(
      h.access.withStaticReadOnly('agent', async (client: ReadOnlyFacade) => {
        retained = client;
        await new Promise(() => {});
      }),
    ).rejects.toThrow('STATIC_CALLBACK_TIMEOUT');
    await expect(retained?.query('SELECT 1')).rejects.toThrow('STATIC_CALLBACK_TIMEOUT');
    expect(h.client.end).toHaveBeenCalledOnce();
  });
});

describe('performance runtime resource ownership', () => {
  it('delegates credential creation and session operations to existing services on the same client', async () => {
    const client = { query: vi.fn() };
    const write = vi.fn(async (params: { userId: string; password: string; subject: string }) => ({
      ok: true,
      userId: params.userId,
    }));
    const ready = vi.fn(async () => undefined);
    class Session {
      constructor(readonly connection: object) {}
    }
    class Auth {
      constructor(connection: object, sessions: Session, options: object) {
        expect(connection).toBe(client);
        expect(sessions.connection).toBe(client);
        expect(options).toEqual({ maxFailedAttempts: 5, lockoutSeconds: 900 });
      }
      createCredential = write;
    }
    const create = bindCredentialWriter(
      client,
      { LocalAuthService: Auth, SessionService: Session },
      ready,
    );
    const params = {
      userId: 'synthetic-actor',
      password: 'synthetic-input',
      subject: 'synthetic-subject',
    };
    await expect(create(params)).resolves.toEqual({ ok: true, userId: params.userId });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(params);
    // The adapter must not open/commit another transaction or duplicate SQL/password handling.
    expect(client.query).not.toHaveBeenCalled();
  });

  it('does not invoke credential writes when runtime ownership validation fails', async () => {
    const write = vi.fn();
    class Session {}
    class Auth {
      createCredential = write;
    }
    const create = bindCredentialWriter(
      {},
      { LocalAuthService: Auth, SessionService: Session },
      async () => {
        throw new Error('CONNECTED_DATABASE_IDENTITY_MISMATCH');
      },
    );
    await expect(
      create({
        userId: 'synthetic-actor',
        password: 'synthetic-input',
        subject: 'synthetic-subject',
      }),
    ).rejects.toThrow('CONNECTED_DATABASE_IDENTITY_MISMATCH');
    expect(write).not.toHaveBeenCalled();
  });

  it('removes only the exact directory identity with its unmodified owner marker', () => {
    const path = directory();
    const stat = lstatSync(path);
    const identity = {
      path,
      parent: realpathSync(tmpdir()),
      dev: stat.dev,
      ino: stat.ino,
      token: 'unit-token',
    };
    writeFileSync(join(path, '.solvi-perf041-owner'), identity.token);
    writeFileSync(join(path, 'owned-data'), 'fixture');
    expect(() => assertOwnedDirectory(path, { ...identity, token: 'foreign-token' })).toThrow(
      'TEMP_TOKEN_MISMATCH',
    );
    expect(readFileSync(join(path, 'owned-data'), 'utf8')).toBe('fixture');
    expect(removeOwnedDirectory(identity)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses deleting a symlink or a directory whose recorded inode differs', () => {
    const target = directory(),
      holder = directory(),
      link = join(holder, 'solvi-perf041-link');
    const stat = lstatSync(target);
    writeFileSync(join(target, '.solvi-perf041-owner'), 'unit-token');
    const identity = {
      path: target,
      parent: realpathSync(tmpdir()),
      dev: stat.dev,
      ino: stat.ino + 1,
      token: 'unit-token',
    };
    expect(() => removeOwnedDirectory(identity)).toThrow('TEMP_IDENTITY_CHANGED');
    symlinkSync(target, link);
    expect(() => removeOwnedDirectory({ ...identity, path: link, parent: holder })).toThrow(
      'TEMP_NOT_DIRECTORY',
    );
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a foreign PID or wildcard listener after the port-reservation race', () => {
    const servers = [
      { pid: 101, port: 45001 },
      { pid: 102, port: 45002 },
    ];
    expect(() =>
      assertServerBindings('p101\nn127.0.0.1:45001\np102\nn127.0.0.1:45002\n', servers),
    ).not.toThrow();
    expect(() =>
      assertServerBindings('p999\nn127.0.0.1:45001\np102\nn127.0.0.1:45002\n', servers),
    ).toThrow('LISTENER_OWNERSHIP_OR_BIND_MISMATCH');
    expect(() => assertServerBindings('p101\nn*:45001\np102\nn127.0.0.1:45002\n', servers)).toThrow(
      'LISTENER_OWNERSHIP_OR_BIND_MISMATCH',
    );
    expect(() => assertServerBindings('p101\nn127.0.0.1:45001\n', servers)).toThrow(
      'OWNED_LISTENER_MISSING',
    );
  });

  it('refuses terminating an orphan process group unless every remaining cwd belongs to the copy', () => {
    const path = directory();
    const group = [{ pid: 99002, pgid: 99001, cwd: join(path, 'apps/web') }];
    expect(() => assertOwnedProcessGroup(group, 99001, path)).not.toThrow();
    expect(() =>
      assertOwnedProcessGroup([{ ...group[0], cwd: path + '-foreign' }], 99001, path),
    ).toThrow('PROCESS_GROUP_CWD_MISMATCH');
    expect(() => assertOwnedProcessGroup([{ ...group[0], pgid: 99003 }], 99001, path)).toThrow(
      'PROCESS_GROUP_ID_MISMATCH',
    );
    expect(() => assertOwnedProcessGroup(group, process.pid, path)).toThrow(
      'PROCESS_GROUP_ID_UNSAFE',
    );
    expect(() => assertOwnedProcessGroup([], 99001, path)).toThrow(
      'PROCESS_GROUP_OWNERSHIP_UNKNOWN',
    );
  });

  it('reserves a real loopback socket and releases it idempotently', async () => {
    const reservation = await reserveLoopbackPort();
    const competing = createServer();
    try {
      const code = await new Promise((done) => {
        competing.once('error', (error: NodeJS.ErrnoException) => done(error.code));
        competing.listen(reservation.port, '127.0.0.1', () => done('UNEXPECTED_BIND'));
      });
      expect(code).toBe('EADDRINUSE');
      await reservation.release();
      await reservation.release();
      const after = createServer();
      await new Promise<void>((done, reject) => {
        after.once('error', reject);
        after.listen(reservation.port, '127.0.0.1', done);
      });
      await new Promise<void>((done) => after.close(() => done()));
    } finally {
      competing.close();
      await reservation.release();
    }
  });

  it('waits beyond the old 1.5-second window for a transient forwarding socket to release', async () => {
    let elapsed = 0;
    const diagnostic = vi.fn();
    const result = await waitForPortRelease([45001], {
      now: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
      budgetMs: 4000,
      intervalMs: 250,
      probe: async () =>
        elapsed >= 2000 ? { available: true } : { available: false, code: 'EADDRINUSE' },
      inspect: diagnostic,
    });
    expect(result.released).toBe(true);
    expect(result.elapsedMs).toBe(2000);
    expect(result.ports[0].attempts).toBe(9);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('uses one release budget for all ports and distinguishes busy binds without listeners', async () => {
    let elapsed = 0;
    const result = await waitForPortRelease([45001, 45002, 45003, 45004], {
      now: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
      budgetMs: 2000,
      intervalMs: 250,
      probe: async () => ({ available: false, code: 'EADDRINUSE' }),
      inspect: async () => ({ available: true, listeners: [] }),
    });
    expect(result.released).toBe(false);
    expect(result.elapsedMs).toBe(2000);
    expect(result.ports).toHaveLength(4);
    expect(
      result.ports.every(
        (port: { classification: string }) =>
          port.classification === 'bind_unavailable_without_listener',
      ),
    ).toBe(true);
  });

  it('reports a real listener by safe port/PID metadata without claiming ownership or killing it', async () => {
    let elapsed = 0;
    const listener = { port: 45001, pid: 99003, command: 'node', address: '127.0.0.1:45001' };
    const result = await waitForPortRelease([45001], {
      now: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
      budgetMs: 250,
      intervalMs: 250,
      probe: async () => ({ available: false, code: 'EADDRINUSE' }),
      inspect: async () => ({ available: true, listeners: [listener] }),
    });
    expect(result.released).toBe(false);
    expect(result.ports[0].classification).toBe('listener_present');
    expect(result.ports[0].listeners).toEqual([listener]);
  });

  it('never counts an ambiguous failed probe or diagnostic as successful release', async () => {
    let elapsed = 0;
    const result = await waitForPortRelease([45001], {
      now: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
      budgetMs: 250,
      intervalMs: 250,
      probe: async () => {
        throw new Error('private diagnostic');
      },
      inspect: async () => {
        throw new Error('private diagnostic');
      },
    });
    expect(result.released).toBe(false);
    expect(result.ports[0].classification).toBe('diagnostic_unavailable');
    expect(result.ports[0].bindError).toBe('PORT_PROBE_FAILED');
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });

  it('cleans an already-aborted startup without launching any runtime', async () => {
    let failure;
    try {
      await createRuntime({ signal: AbortSignal.abort() });
    } catch (error) {
      failure = error as Error & { cleanupReport: { success: boolean }; stage: string };
    }
    expect(failure?.message).toBe('RUNTIME_INTERRUPTED');
    expect(failure?.stage).toBe('preflight');
    expect(failure?.cleanupReport.success).toBe(true);
  });

  it('preserves the requested WP042 metadata in interrupted startup cleanup', async () => {
    await expect(
      createRuntime({ workPackage: 'WP-P2-PERF-042', signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      message: 'RUNTIME_INTERRUPTED',
      meta: { workPackage: 'WP-P2-PERF-042' },
      cleanupReport: { success: true, appClientsClosed: true },
    });
  });
});
