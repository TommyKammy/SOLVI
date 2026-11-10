import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProfile, validateProfile } from '../../tools/performance/profiles.mjs';
import {
  parseOverviewArgs,
  createProbeCredential,
} from '../../tools/performance/run-overview-diagnostic.mjs';
import {
  parseDiagnosticArgs,
  prepareQueryFixture,
  executeListDiagnostic,
} from '../../tools/performance/run-list-diagnostic.mjs';
import {
  parseDeadlineArgs,
  executeDeadlineDiagnostic,
} from '../../tools/performance/run-deadline-diagnostic.mjs';
import {
  parseSearchArgs,
  executeSearchDiagnostic,
} from '../../tools/performance/run-search-diagnostic.mjs';
import {
  parseSearchCapacityArgs,
  executeSearchCapacity,
} from '../../tools/performance/run-search-capacity.mjs';
import {
  parseDirectoryArgs,
  executeDirectoryDiagnostic,
} from '../../tools/performance/run-directory-diagnostic.mjs';
import {
  parseArgs,
  prepareOutput,
  observeDatabase,
  finalizeReport,
  parsePoolMetrics,
  executeBaseline,
} from '../../tools/performance/run-baseline.mjs';

const ownedPaths: string[] = [];
describe('WP049 bounded state-prefix diagnostic modes', () => {
  const base = ['--profile', 'smoke', '--label', 'after', '--work-package', 'WP-P2-PERF-049'];
  it('requires an explicit bounded mode and preserves the older defaults', () => {
    expect(parseSearchCapacityArgs([...base, '--sql-only'])).toMatchObject({
      workPackage: 'WP-P2-PERF-049',
      'sql-only': true,
    });
    expect(parseSearchCapacityArgs([...base, '--contract-only'])).toMatchObject({
      workPackage: 'WP-P2-PERF-049',
      'contract-only': true,
    });
    expect(parseSearchCapacityArgs(['--profile', 'smoke', '--label', 'after'])).toEqual({
      profile: 'smoke',
      label: 'after',
    });
    expect(() => parseSearchCapacityArgs(base)).toThrow('SEARCH_049_MODE_REQUIRED');
    expect(() => parseSearchCapacityArgs([...base, '--sql-only', '--contract-only'])).toThrow(
      'DIAGNOSTIC_MODES_CONFLICT',
    );
    expect(() => parseSearchCapacityArgs([...base, '--contract-only', '--contract-only'])).toThrow(
      'DUPLICATE_ARGUMENT',
    );
    expect(() =>
      parseSearchCapacityArgs([...base.slice(0, -1), 'WP-P2-PERF-048', '--contract-only']),
    ).toThrow('CONTRACT_ONLY_MODE_REJECTED');
  });
  it('rejects mode types and evidence from another WP before allocating a runtime', async () => {
    const createRuntime = vi.fn();
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    await expect(
      executeSearchCapacity({
        profile: 'smoke',
        label: 'after',
        workPackage: 'WP-P2-PERF-049',
        'contract-only': 'true' as never,
      }),
    ).rejects.toThrow('CONTRACT_ONLY_MODE_REJECTED');
    await expect(
      executeSearchCapacity({
        profile: 'smoke',
        label: 'after',
        workPackage: 'WP-P2-PERF-049',
        'contract-only': true,
        output: 'evidence/WP-P2-PERF-048/wrong-state',
      }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it.each([
    {
      mode: 'sql',
      equivalent: true,
      apiValid: true,
      drained: true,
      cleanupOk: true,
      expected: true,
    },
    {
      mode: 'contract',
      equivalent: true,
      apiValid: true,
      drained: true,
      cleanupOk: true,
      expected: true,
    },
    {
      mode: 'contract',
      equivalent: false,
      apiValid: true,
      drained: true,
      cleanupOk: true,
      expected: false,
    },
    {
      mode: 'contract',
      equivalent: true,
      apiValid: false,
      drained: true,
      cleanupOk: true,
      expected: false,
    },
    {
      mode: 'contract',
      equivalent: true,
      apiValid: true,
      drained: false,
      cleanupOk: true,
      expected: false,
    },
    {
      mode: 'contract',
      equivalent: true,
      apiValid: true,
      drained: true,
      cleanupOk: false,
      expected: false,
    },
    {
      mode: 'throw',
      equivalent: true,
      apiValid: true,
      drained: true,
      cleanupOk: true,
      expected: false,
    },
    {
      mode: 'interrupt',
      equivalent: true,
      apiValid: true,
      drained: true,
      cleanupOk: true,
      expected: false,
    },
    {
      mode: 'exercise',
      equivalent: true,
      apiValid: true,
      drained: true,
      cleanupOk: true,
      expected: false,
    },
  ])('preserves SQL/API/cleanup boundaries without capacity waves: %j', async (test) => {
    const path = resolve(`evidence/WP-P2-PERF-049/unit-state-${randomUUID()}`);
    ownedPaths.push(path);
    const database = 'solvi_perf041_123_abcdef123456';
    const cleanup = vi.fn(async () => ({ success: test.cleanupOk }));
    const rt = {
      meta: { database, workPackage: 'WP-P2-PERF-049' },
      admin: {
        query: async (sql: string) => ({
          rows: sql.includes('current_database()') ? [{ database }] : [],
          rowCount: 1,
        }),
      },
      createCredential: vi.fn(),
      cleanup,
    };
    const createRuntime = vi.fn(async () => rt);
    const fixture = { organizationId: 'synthetic', counts: { tickets: 2400 } };
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    vi.doMock('../../tools/performance/fixture.mjs', () => ({ seedFixture: async () => fixture }));
    const analyzeSearchStatePrefix = vi.fn(async () => ({
      completed: true,
      equivalent: test.equivalent,
      assessment: { accepted: false },
    }));
    const analyzeSearchPrefix = vi.fn();
    vi.doMock('../../tools/performance/search-prefix-analysis.mjs', () => ({
      analyzeSearchStatePrefix,
      analyzeSearchPrefix,
    }));
    const runSearchCapacity = vi.fn();
    vi.doMock('../../tools/performance/search-capacity.mjs', () => ({ runSearchCapacity }));
    const runSearchStateApiContract = vi.fn(async () => {
      if (test.mode === 'throw') throw new Error('PRIVATE_SECRET_VALUE');
      if (test.mode === 'interrupt') process.emit('SIGTERM');
      return {
        completed: true,
        valid: test.apiValid,
        capacityMeasured: false,
        cases: [{ key: 'state-agent-newest', valid: true }],
        drain: { drained: test.drained },
      };
    });
    vi.doMock('../../tools/performance/list-load.mjs', () => ({ runSearchStateApiContract }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeSearchCapacity({
      profile: 'smoke',
      label: 'after',
      workPackage: 'WP-P2-PERF-049',
      'sql-only': test.mode === 'sql',
      'contract-only': test.mode !== 'sql',
      'exercise-cleanup': test.mode === 'exercise',
      output: path,
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workPackage: 'WP-P2-PERF-049' }),
    );
    expect(analyzeSearchPrefix).not.toHaveBeenCalled();
    expect(analyzeSearchStatePrefix).toHaveBeenCalledTimes(test.mode === 'exercise' ? 0 : 1);
    expect(runSearchCapacity).not.toHaveBeenCalled();
    expect(runSearchStateApiContract).toHaveBeenCalledTimes(
      test.mode !== 'sql' && test.mode !== 'exercise' && test.equivalent ? 1 : 0,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      workPackage: 'WP-P2-PERF-049',
      capacitySkipped: true,
      allRequestsSucceeded: false,
      success: test.expected,
      cleanup: { success: test.cleanupOk },
      measurementScope: test.mode === 'sql' ? 'sql-only' : 'sql-and-contract',
    });
    expect(report.capacity).toBeUndefined();
    if (test.mode === 'contract' && test.equivalent)
      expect(report.apiContract?.cases).toHaveLength(1);
    if (test.mode === 'throw') expect(report.failureCode).toBe('DIAGNOSTIC_FAILED');
    if (test.mode === 'interrupt') expect(report.failureCode).toBe('DIAGNOSTIC_INTERRUPTED');
    if (test.mode === 'exercise') expect(report.failureCode).toBe('EXPECTED_CLEANUP_EXERCISE');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
    expect(report.interpretation).toMatchObject({
      model: expect.stringMatching(
        /no (HTTP sessions or arrival waves|capacity arrival waves) measured/,
      ),
    });
    expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
      success: test.expected,
      allRequestsSucceeded: false,
    });
  });
});
describe('overview diagnostic scope', () => {
  it('rolls back the synthetic credential write when its audit fails', async () => {
    const database = 'solvi_perf041_123_abcdef123456';
    const calls: string[] = [];
    const runtime = {
      meta: { database },
      admin: {
        query: async (sql: string) => {
          calls.push(sql);
          return { rows: [{ database }] };
        },
      },
      createCredential: vi.fn(async () => {
        calls.push('credential-and-audit');
        throw new Error('AUDIT_FAILED');
      }),
    };
    await expect(
      createProbeCredential(runtime, {
        userId: 'synthetic',
        email: 'unit@example.test',
        password: 'unit-only',
      }),
    ).rejects.toThrow('AUDIT_FAILED');
    expect(calls).toEqual([
      'SELECT current_database() AS database',
      'BEGIN',
      'credential-and-audit',
      'ROLLBACK',
    ]);
  });
  it('rejects a database identity mismatch before beginning or changing credentials', async () => {
    const query = vi.fn(async () => ({ rows: [{ database: 'unrelated' }] }));
    const createCredential = vi.fn(async () => ({ ok: true }));
    await expect(
      createProbeCredential(
        {
          meta: { database: 'solvi_perf041_123_abcdef123456' },
          admin: { query },
          createCredential,
        },
        { userId: 'synthetic', email: 'unit@example.test', password: 'unit-only' },
      ),
    ).rejects.toThrow('PROBE_DATABASE_MISMATCH');
    expect(query).toHaveBeenCalledTimes(1);
    expect(createCredential).not.toHaveBeenCalled();
  });
  it('requires a known profile and comparison label without external targets', () => {
    expect(parseOverviewArgs(['--profile', 'growth', '--label', 'before'])).toEqual({
      profile: 'growth',
      label: 'before',
    });
    expect(() => parseOverviewArgs(['--profile', 'growth'])).toThrow('LABEL_REQUIRED');
    expect(() =>
      parseOverviewArgs([
        '--profile',
        'growth',
        '--label',
        'after',
        '--url',
        'https://example.test',
      ]),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(() =>
      parseOverviewArgs(['--profile', 'growth', '--label', 'after', '--label', 'before']),
    ).toThrow('DUPLICATE_ARGUMENT');
  });
  it('keeps WP043 evidence separate from earlier WPs', async () => {
    await expect(
      prepareOutput('evidence/WP-P2-PERF-042/wrong-overview', 'smoke', 'WP-P2-PERF-043'),
    ).rejects.toThrow();
  });
});
afterEach(async () => {
  vi.doUnmock('../../tools/performance/runtime.mjs');
  vi.doUnmock('../../tools/performance/fixture.mjs');
  vi.doUnmock('../../tools/performance/list-load.mjs');
  vi.doUnmock('../../tools/performance/list-query-analysis.mjs');
  vi.doUnmock('../../tools/performance/deadline-analysis.mjs');
  vi.doUnmock('../../tools/performance/search-analysis.mjs');
  vi.doUnmock('../../tools/performance/search-capacity.mjs');
  vi.doUnmock('../../tools/performance/search-cost-analysis.mjs');
  vi.doUnmock('../../tools/performance/search-prefix-analysis.mjs');
  vi.doUnmock('../../tools/performance/directory-load.mjs');
  vi.doUnmock('../../tools/performance/directory-analysis.mjs');
  vi.restoreAllMocks();
  await Promise.all(ownedPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('performance CLI isolation and reproducibility', () => {
  it.each(['LIST_DRAIN_FAILED', 'LIST_HARD_CAP', 'LIST_OBSERVATION_INVALID'])(
    'does not start query analysis after incomplete comparison %s',
    async (failureCode) => {
      const path = resolve(`evidence/WP-P2-PERF-042/unit-incomplete-${randomUUID()}`);
      ownedPaths.push(path);
      const cleanup = vi.fn(async () => ({ success: true }));
      const database = 'solvi_perf041_123_abcdef123456';
      const admin = {
        query: vi.fn(async (sql: string) =>
          sql.includes('current_database()')
            ? { rows: [{ database }], rowCount: 1 }
            : { rows: [], rowCount: 1 },
        ),
      };
      vi.doMock('../../tools/performance/runtime.mjs', () => ({
        createRuntime: async () => ({
          meta: { database },
          admin,
          createCredential: vi.fn(),
          cleanup,
        }),
      }));
      vi.doMock('../../tools/performance/fixture.mjs', () => ({
        seedFixture: async () => ({
          organizationId: 'synthetic-organization',
          counts: { users: 120 },
        }),
      }));
      const comparison = {
        comparisonCompleted: false,
        allRequestsSucceeded: false,
        loginCompleted: 12,
        phases: [{ index: 1, failureCode }],
        failureCode,
      };
      const runListComparison = vi.fn(async () => comparison);
      const runQueryAnalysis = vi.fn(async () => ({ completed: true, equivalent: true }));
      vi.doMock('../../tools/performance/list-load.mjs', () => ({ runListComparison }));
      vi.doMock('../../tools/performance/list-query-analysis.mjs', () => ({ runQueryAnalysis }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const report = await executeListDiagnostic({
        profile: 'smoke',
        label: 'before',
        output: path,
      });
      expect(runListComparison).toHaveBeenCalledOnce();
      expect(runQueryAnalysis).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(report).toMatchObject({
        success: false,
        failureCode: 'DIAGNOSTIC_COMPARISON_INCOMPLETE',
        comparison,
        cleanup: { success: true },
      });
      expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
        failureCode: 'DIAGNOSTIC_COMPARISON_INCOMPLETE',
        comparison,
      });
    },
  );

  it.each([
    [undefined, 'WP-P2-PERF-041'],
    ['WP-P2-PERF-042', 'WP-P2-PERF-042'],
    ['WP-P2-PERF-043', 'WP-P2-PERF-043'],
    ['WP-P2-PERF-044', 'WP-P2-PERF-044'],
    ['WP-P2-PERF-045', 'WP-P2-PERF-045'],
    ['WP-P2-PERF-046', 'WP-P2-PERF-046'],
    ['WP-P2-PERF-047', 'WP-P2-PERF-047'],
    ['WP-P2-PERF-048', 'WP-P2-PERF-048'],
    ['WP-P2-PERF-049', 'WP-P2-PERF-049'],
  ] as const)(
    'binds internal work package %s consistently to output, runtime, and report',
    async (workPackage, expected) => {
      const path = resolve(`evidence/${expected}/unit-regression-${randomUUID()}`);
      ownedPaths.push(path);
      const cleanup = vi.fn(async () => ({ success: true }));
      const createRuntime = vi.fn(async (options: { workPackage: string }) => ({
        meta: { database: 'solvi_perf041_123_abcdef123456', workPackage: options.workPackage },
        admin: {},
        createCredential: vi.fn(),
        cleanup,
      }));
      const seedFixture = vi.fn(async () => ({ counts: { users: 120 } }));
      vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
      vi.doMock('../../tools/performance/fixture.mjs', () => ({ seedFixture }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const report = await executeBaseline({
        profile: 'smoke',
        output: path,
        workPackage,
        'exercise-cleanup': true,
      });
      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ workPackage: expected }),
      );
      expect(seedFixture).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(report).toMatchObject({
        workPackage: expected,
        runtime: { workPackage: expected },
        success: false,
        failureCode: 'EXPECTED_CLEANUP_EXERCISE',
        cleanup: { success: true },
      });
      expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
        workPackage: expected,
        runtime: { workPackage: expected },
      });
    },
  );

  it('rejects arbitrary internal work packages and cross-package output before runtime allocation', async () => {
    const createRuntime = vi.fn();
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    await expect(
      executeBaseline({
        profile: 'smoke',
        // @ts-expect-error Deliberately invalid JavaScript caller input must also be rejected.
        workPackage: 'WP-P2-PERF-999',
      }),
    ).rejects.toThrow('OUTPUT_WORK_PACKAGE_REJECTED');
    await expect(
      executeBaseline({
        profile: 'smoke',
        workPackage: 'WP-P2-PERF-042',
        output: 'evidence/WP-P2-PERF-041/wrong-regression',
      }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    expect(createRuntime).not.toHaveBeenCalled();
    expect(() => parseArgs(['--profile', 'baseline', '--work-package', 'WP-P2-PERF-042'])).toThrow(
      'UNKNOWN_ARGUMENT',
    );
  });

  it('requires diagnostic condition labels and refuses target overrides', () => {
    expect(() => parseDiagnosticArgs(['--profile', 'growth'])).toThrow('LABEL_REQUIRED');
    expect(() =>
      parseDiagnosticArgs(['--profile', 'growth', '--label', 'before', '--api-url', 'https://x']),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(parseDiagnosticArgs(['--profile', 'growth', '--label', 'after'])).toMatchObject({
      profile: 'growth',
      label: 'after',
    });
  });

  it('cannot put new diagnostic evidence inside the previous work package', async () => {
    await expect(
      prepareOutput('evidence/WP-P2-PERF-041/wrong-work-package', 'smoke', 'WP-P2-PERF-042'),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
  });

  it('refuses SLA fixture mutation unless both owned name and current database agree', async () => {
    let calls = 0;
    const admin = {
      query: async () => {
        calls++;
        return { rows: [{ database: 'unrelated' }], rowCount: 1 };
      },
    };
    await expect(
      prepareQueryFixture({ admin, meta: { database: 'production' } }, { organizationId: 'x' }),
    ).rejects.toThrow('FIXTURE_DATABASE_REJECTED');
    expect(calls).toBe(0);
    await expect(
      prepareQueryFixture(
        { admin, meta: { database: 'solvi_perf041_123_abcdef123456' } },
        { organizationId: 'x' },
      ),
    ).rejects.toThrow('FIXTURE_DATABASE_MISMATCH');
    expect(calls).toBe(1);
  });

  it('cannot mark an interrupted cleanup or incomplete cleanup as success', () => {
    expect(finalizeReport({ success: true, cleanup: { success: true } }, true)).toMatchObject({
      success: false,
      interrupted: true,
      failureCode: 'BASELINE_INTERRUPTED',
    });
    expect(finalizeReport({ success: true, cleanup: { success: false } }, false)).toMatchObject({
      success: false,
      failureCode: 'CLEANUP_FAILED',
    });
  });

  it('lets resource cleanup proceed even if the observation query is still pending', async () => {
    const observation = observeDatabase({ query: () => new Promise(() => {}) });
    const result = await observation.stop();
    expect(result.samples).toEqual([]);
  });

  it('requires both acquired-connection counts and all connection-state gauges', () => {
    const partial = 'solvi_db_pool_connections_total 10\n';
    expect(parsePoolMetrics(partial).complete).toBe(false);
    const full =
      partial +
      'solvi_db_pool_connections_idle 7\nsolvi_db_pool_connections_waiting 0\n' +
      'solvi_db_pool_acquire_duration_milliseconds_count{outcome="success"} 40\n' +
      'solvi_db_pool_acquire_duration_milliseconds_count{outcome="failure"} 2\n';
    expect(parsePoolMetrics(full)).toMatchObject({ complete: true, acquisitionCount: 42 });
  });
  it('requires a named profile and cannot accept a supplied DB or HTTP target', () => {
    expect(() => parseArgs([])).toThrow('PROFILE_REQUIRED');
    expect(() =>
      parseArgs(['--profile', 'baseline', '--database-url', 'postgres://example']),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(() => parseArgs(['--profile', 'baseline', '--api-url', 'https://example.test'])).toThrow(
      'UNKNOWN_ARGUMENT',
    );
    expect(() => parseArgs(['--profile', 'baseline', '--profile', 'smoke'])).toThrow(
      'DUPLICATE_ARGUMENT',
    );
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('keeps the workload profiles independent and bounds accidental large runs', () => {
    const first = getProfile('baseline');
    first.roles.requester = 1;
    expect(getProfile('baseline').roles.requester).toBe(90);
    expect(getProfile('growth').tickets).toBe(100_000);
    expect(() => getProfile('production')).toThrow('UNKNOWN_PROFILE');
    expect(() => validateProfile({ ...getProfile('baseline'), activeSessions: 1000 })).toThrow(
      'INVALID_PROFILE',
    );
    expect(() =>
      validateProfile({ ...getProfile('baseline'), requestTimeoutMs: Infinity }),
    ).toThrow('INVALID_PROFILE');
    expect(() =>
      validateProfile({ ...getProfile('baseline'), roles: { requester: 99, agent: 9, admin: 1 } }),
    ).toThrow('INVALID_PROFILE');
  });

  it('refuses traversal and an existing output directory rather than overwriting evidence', async () => {
    await expect(prepareOutput('../../outside', 'smoke')).rejects.toThrow(
      'OUTPUT_OUTSIDE_EVIDENCE',
    );
    const path = resolve(`evidence/WP-P2-PERF-041/unit-${randomUUID()}`);
    ownedPaths.push(path);
    await mkdir(path, { recursive: true });
    await expect(prepareOutput(path, 'smoke')).rejects.toThrow('OUTPUT_ALREADY_EXISTS');
  });

  it('rejects a symlinked ancestor and leaves the destination untouched', async () => {
    const outside = await mkdtemp(resolve(tmpdir(), 'solvi-perf-cli-'));
    const link = resolve(`evidence/WP-P2-PERF-041/unit-link-${randomUUID()}`);
    ownedPaths.push(link, outside);
    await mkdir(resolve('evidence/WP-P2-PERF-041'), { recursive: true });
    await symlink(outside, link);
    await expect(prepareOutput(resolve(link, 'report'), 'smoke')).rejects.toThrow('OUTPUT_SYMLINK');
  });

  it('atomically claims an output directory before either run can start a workload', async () => {
    const path = resolve(`evidence/WP-P2-PERF-041/unit-race-${randomUUID()}`);
    ownedPaths.push(path);
    const results = await Promise.allSettled([
      prepareOutput(path, 'smoke'),
      prepareOutput(path, 'smoke'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.message).toBe('OUTPUT_ALREADY_EXISTS');
  });
});

describe('WP044 deadline diagnostic isolation', () => {
  it('accepts only fixed profiles, labels and owned output options', () => {
    expect(
      parseDeadlineArgs(['--profile', 'smoke', '--label', 'before', '--exercise-cleanup']),
    ).toEqual({ profile: 'smoke', label: 'before', 'exercise-cleanup': true });
    expect(() =>
      parseDeadlineArgs(['--profile', 'growth', '--label', 'after', '--sort', 'newest']),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(() =>
      parseDeadlineArgs([
        '--profile',
        'growth',
        '--label',
        'after',
        '--work-package',
        'WP-P2-PERF-042',
      ]),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(() =>
      parseDeadlineArgs(['--profile', 'growth', '--label', 'after', '--label', 'before']),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() => parseDeadlineArgs(['--profile', 'growth'])).toThrow('LABEL_REQUIRED');
  });
  it('rejects prior-WP output before creating a runtime', async () => {
    const createRuntime = vi.fn();
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    await expect(
      executeDeadlineDiagnostic({
        profile: 'smoke',
        // @ts-expect-error Direct JavaScript callers must not bypass the label contract.
        label: 'arbitrary',
      }),
    ).rejects.toThrow('LABEL_REQUIRED');
    await expect(
      executeDeadlineDiagnostic({
        profile: 'smoke',
        label: 'after',
        output: 'evidence/WP-P2-PERF-042/deadline-wrong',
      }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it.each([
    { complete: false, apiValid: true, requests: false, equivalent: true, expected: false },
    { complete: true, apiValid: false, requests: true, equivalent: true, expected: false },
    { complete: true, apiValid: true, requests: false, equivalent: true, expected: true },
    { complete: true, apiValid: true, requests: true, equivalent: false, expected: false },
    { complete: true, apiValid: true, requests: true, equivalent: true, expected: true },
  ])(
    'keeps completion, API proof, SQL equivalence and HTTP success distinct: %j',
    async ({ complete, apiValid, requests, equivalent, expected }) => {
      const path = resolve(`evidence/WP-P2-PERF-044/unit-deadline-${randomUUID()}`);
      ownedPaths.push(path);
      const cleanup = vi.fn(async () => ({ success: true }));
      const database = 'solvi_perf041_123_abcdef123456';
      const admin = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes('current_database()') ? [{ database }] : [],
          rowCount: 1,
        })),
      };
      const createRuntime = vi.fn(async (options: { workPackage: string }) => ({
        meta: { database, workPackage: options.workPackage },
        admin,
        createCredential: vi.fn(),
        cleanup,
      }));
      vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
      vi.doMock('../../tools/performance/fixture.mjs', () => ({
        seedFixture: async () => ({ organizationId: 'synthetic', counts: { tickets: 2400 } }),
      }));
      const comparison = {
        comparisonCompleted: complete,
        allRequestsSucceeded: requests,
        apiContractValid: apiValid,
        phases: [{ index: 1 }],
      };
      const runDeadlineComparison = vi.fn(async () => comparison);
      const runDeadlineAnalysis = vi.fn(async () => ({
        completed: true,
        equivalent,
        projection: { confirmed: false },
      }));
      vi.doMock('../../tools/performance/list-load.mjs', () => ({ runDeadlineComparison }));
      vi.doMock('../../tools/performance/deadline-analysis.mjs', () => ({ runDeadlineAnalysis }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const report = await executeDeadlineDiagnostic({
        profile: 'smoke',
        label: 'before',
        output: path,
      });
      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ workPackage: 'WP-P2-PERF-044' }),
      );
      expect(runDeadlineComparison).toHaveBeenCalledOnce();
      expect(runDeadlineAnalysis).toHaveBeenCalledTimes(complete ? 1 : 0);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(report).toMatchObject({
        workPackage: 'WP-P2-PERF-044',
        label: 'before',
        success: expected,
        allRequestsSucceeded: requests,
        comparison,
        cleanup: { success: true },
      });
      if (!complete) expect(report.failureCode).toBe('DIAGNOSTIC_COMPARISON_INCOMPLETE');
      expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
        success: expected,
        comparison,
      });
      // before deliberately retains legacy projection; the label never changes source or SQL.
      if (complete)
        expect(runDeadlineAnalysis).toHaveBeenCalledWith(
          expect.objectContaining({ runtime: expect.any(Object) }),
        );
    },
  );
});

describe('WP046 search diagnostic isolation', () => {
  it('accepts only fixed profiles, labels and owned output options', () => {
    expect(
      parseSearchArgs(['--profile', 'smoke', '--label', 'before', '--exercise-cleanup']),
    ).toEqual({ profile: 'smoke', label: 'before', 'exercise-cleanup': true });
    expect(() =>
      parseSearchArgs(['--profile', 'growth', '--label', 'after', '--sort', 'newest']),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(() =>
      parseSearchArgs([
        '--profile',
        'growth',
        '--label',
        'after',
        '--work-package',
        'WP-P2-PERF-042',
      ]),
    ).toThrow('UNKNOWN_ARGUMENT');
    expect(() =>
      parseSearchArgs(['--profile', 'growth', '--label', 'after', '--label', 'before']),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() => parseSearchArgs(['--profile', 'growth'])).toThrow('LABEL_REQUIRED');
  });
  it('rejects prior-WP output before creating a runtime', async () => {
    const createRuntime = vi.fn();
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    await expect(
      executeSearchDiagnostic({
        profile: 'smoke',
        // @ts-expect-error Direct JavaScript callers must not bypass the label contract.
        label: 'arbitrary',
      }),
    ).rejects.toThrow('LABEL_REQUIRED');
    await expect(
      executeSearchDiagnostic({
        profile: 'smoke',
        label: 'after',
        output: 'evidence/WP-P2-PERF-042/search-wrong',
      }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it.each([
    { complete: false, apiValid: true, requests: false, equivalent: true, expected: false },
    { complete: true, apiValid: false, requests: true, equivalent: true, expected: false },
    { complete: true, apiValid: true, requests: false, equivalent: true, expected: true },
    { complete: true, apiValid: true, requests: true, equivalent: false, expected: false },
    { complete: true, apiValid: true, requests: true, equivalent: true, expected: true },
  ])(
    'keeps completion, API proof, SQL equivalence and HTTP success distinct: %j',
    async ({ complete, apiValid, requests, equivalent, expected }) => {
      const path = resolve(`evidence/WP-P2-PERF-046/unit-search-${randomUUID()}`);
      ownedPaths.push(path);
      const cleanup = vi.fn(async () => ({ success: true }));
      const database = 'solvi_perf041_123_abcdef123456';
      const admin = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes('current_database()') ? [{ database }] : [],
          rowCount: 1,
        })),
      };
      const createRuntime = vi.fn(async (options: { workPackage: string }) => ({
        meta: { database, workPackage: options.workPackage },
        admin,
        createCredential: vi.fn(),
        cleanup,
      }));
      vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
      vi.doMock('../../tools/performance/fixture.mjs', () => ({
        seedFixture: async () => ({ organizationId: 'synthetic', counts: { tickets: 2400 } }),
      }));
      const comparison = {
        comparisonCompleted: complete,
        allRequestsSucceeded: requests,
        apiContractValid: apiValid,
        phases: [{ index: 1 }],
      };
      const runSearchComparison = vi.fn(async () => comparison);
      const runSearchAnalysis = vi.fn(async () => ({
        completed: true,
        equivalent,
        optimization: { confirmed: false },
      }));
      vi.doMock('../../tools/performance/list-load.mjs', () => ({ runSearchComparison }));
      vi.doMock('../../tools/performance/search-analysis.mjs', () => ({ runSearchAnalysis }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const report = await executeSearchDiagnostic({
        profile: 'smoke',
        label: 'before',
        output: path,
      });
      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ workPackage: 'WP-P2-PERF-046' }),
      );
      expect(runSearchComparison).toHaveBeenCalledOnce();
      expect(runSearchAnalysis).toHaveBeenCalledTimes(complete ? 1 : 0);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(report).toMatchObject({
        workPackage: 'WP-P2-PERF-046',
        label: 'before',
        success: expected,
        allRequestsSucceeded: requests,
        comparison,
        cleanup: { success: true },
      });
      if (!complete) expect(report.failureCode).toBe('DIAGNOSTIC_COMPARISON_INCOMPLETE');
      expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
        success: expected,
        comparison,
      });
      // before deliberately retains legacy projection; the label never changes source or SQL.
      if (complete)
        expect(runSearchAnalysis).toHaveBeenCalledWith(
          expect.objectContaining({ runtime: expect.any(Object) }),
        );
    },
  );
});

describe('WP047 search workload diagnostic', () => {
  it('accepts only fixed profile/label/output and refuses arbitrary target, term or concurrency', async () => {
    expect(parseSearchCapacityArgs(['--profile', 'growth', '--label', 'before'])).toEqual({
      profile: 'growth',
      label: 'before',
    });
    for (const flag of ['--url', '--keyword', '--concurrency', '--ref']) {
      expect(() =>
        parseSearchCapacityArgs(['--profile', 'growth', '--label', 'before', flag, 'arbitrary']),
      ).toThrow('UNKNOWN_ARGUMENT');
    }
    await expect(
      executeSearchCapacity({
        profile: 'smoke',
        label: 'before',
        output: 'evidence/WP-P2-PERF-046/forbidden-047',
      }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
  });
  it.each([
    {
      analysis: true,
      equivalent: true,
      complete: true,
      api: true,
      requests: true,
      cleanupOk: true,
      expected: true,
    },
    {
      analysis: true,
      equivalent: true,
      complete: true,
      api: true,
      requests: false,
      cleanupOk: true,
      expected: true,
    },
    {
      analysis: false,
      equivalent: false,
      complete: true,
      api: true,
      requests: true,
      cleanupOk: true,
      expected: false,
    },
    {
      analysis: true,
      equivalent: false,
      complete: true,
      api: true,
      requests: true,
      cleanupOk: true,
      expected: false,
    },
    {
      analysis: true,
      equivalent: true,
      complete: false,
      api: true,
      requests: false,
      cleanupOk: true,
      expected: false,
    },
    {
      analysis: true,
      equivalent: true,
      complete: true,
      api: false,
      requests: true,
      cleanupOk: true,
      expected: false,
    },
    {
      analysis: true,
      equivalent: true,
      complete: true,
      api: true,
      requests: true,
      cleanupOk: false,
      expected: false,
    },
  ])('uses one runtime, separates SQL/HTTP validity and saves cleanup: %j', async (test) => {
    const path = resolve(`evidence/WP-P2-PERF-047/unit-capacity-${randomUUID()}`);
    ownedPaths.push(path);
    const order: string[] = [];
    const database = 'solvi_perf041_123_abcdef123456';
    const cleanup = vi.fn(async () => {
      order.push('cleanup');
      return { success: test.cleanupOk };
    });
    const createRuntime = vi.fn(async () => ({
      meta: { database, workPackage: 'WP-P2-PERF-047' },
      admin: {
        query: async (sql: string) => ({
          rows: sql.includes('current_database()') ? [{ database }] : [],
          rowCount: 1,
        }),
      },
      createCredential: vi.fn(),
      cleanup,
    }));
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    vi.doMock('../../tools/performance/fixture.mjs', () => ({
      seedFixture: async () => ({ organizationId: 'synthetic', counts: { tickets: 2400 } }),
    }));
    const runSearchCostAnalysis = vi.fn(async () => {
      order.push('analysis');
      return {
        completed: test.analysis,
        equivalent: test.equivalent,
        cases: [{ completed: test.analysis }],
        optimization: { confirmed: false },
      };
    });
    const runSearchCapacity = vi.fn(async () => {
      order.push('capacity');
      return {
        completed: test.complete,
        apiContractValid: test.api,
        allRequestsSucceeded: test.requests,
        phases: [{ index: 1 }],
      };
    });
    vi.doMock('../../tools/performance/search-cost-analysis.mjs', () => ({
      runSearchCostAnalysis,
    }));
    vi.doMock('../../tools/performance/search-capacity.mjs', () => ({ runSearchCapacity }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeSearchCapacity({ profile: 'smoke', label: 'before', output: path });
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workPackage: 'WP-P2-PERF-047' }),
    );
    expect(runSearchCostAnalysis).toHaveBeenCalledOnce();
    expect(order).toEqual(
      test.analysis && test.equivalent
        ? ['analysis', 'capacity', 'cleanup']
        : ['analysis', 'cleanup'],
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(report.success).toBe(test.expected);
    expect(report.allRequestsSucceeded).toBe(test.analysis && test.equivalent && test.requests);
    expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
      success: test.expected,
      cleanup: { success: test.cleanupOk },
    });
  });
  it('suppresses unrecognized uppercase errors in failed reports', async () => {
    const path = resolve(`evidence/WP-P2-PERF-047/unit-private-${randomUUID()}`);
    ownedPaths.push(path);
    vi.doMock('../../tools/performance/runtime.mjs', () => ({
      createRuntime: async () => {
        throw new Error('PRIVATE_SECRET_TOKEN');
      },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeSearchCapacity({ profile: 'smoke', label: 'before', output: path });
    expect(report).toMatchObject({ success: false, failureCode: 'DIAGNOSTIC_FAILED' });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
  });
});

describe('WP048 selected search-prefix diagnostic', () => {
  it('preserves the 047 default and restricts SQL-only to explicitly selected 048', () => {
    expect(parseSearchCapacityArgs(['--profile', 'growth', '--label', 'before'])).toEqual({
      profile: 'growth',
      label: 'before',
    });
    expect(
      parseSearchCapacityArgs([
        '--profile',
        'growth',
        '--label',
        'after',
        '--work-package',
        'WP-P2-PERF-048',
        '--sql-only',
      ]),
    ).toEqual({
      profile: 'growth',
      label: 'after',
      workPackage: 'WP-P2-PERF-048',
      'sql-only': true,
    });
    expect(() =>
      parseSearchCapacityArgs(['--profile', 'smoke', '--label', 'before', '--sql-only']),
    ).toThrow('SQL_ONLY_MODE_REJECTED');
    expect(() =>
      parseSearchCapacityArgs([
        '--profile',
        'smoke',
        '--label',
        'before',
        '--work-package',
        'WP-P2-PERF-046',
      ]),
    ).toThrow('SEARCH_WORK_PACKAGE_REJECTED');
    expect(() =>
      parseSearchCapacityArgs([
        '--profile',
        'smoke',
        '--label',
        'before',
        '--work-package',
        'WP-P2-PERF-048',
        '--work-package',
        'WP-P2-PERF-048',
      ]),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() =>
      parseSearchCapacityArgs([
        '--profile',
        'smoke',
        '--label',
        'before',
        '--sql-only',
        '--sql-only',
      ]),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() =>
      parseSearchCapacityArgs(['--profile', 'smoke', '--label', 'before', '--work-package']),
    ).toThrow('MISSING_ARGUMENT');
    expect(() =>
      parseSearchCapacityArgs([
        '--profile',
        'smoke',
        '--label',
        'before',
        '--output',
        '--work-package',
        'WP-P2-PERF-048',
        'unclaimed-path',
      ]),
    ).toThrow('MISSING_ARGUMENT');
    expect(() =>
      parseSearchCapacityArgs(['--profile', 'smoke', '--label', 'before', '--ref', 'HEAD']),
    ).toThrow('UNKNOWN_ARGUMENT');
  });
  it('rejects direct calls with unsupported work package, mode or evidence target before allocation', async () => {
    const createRuntime = vi.fn();
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    await expect(
      executeSearchCapacity({
        profile: 'smoke',
        label: 'after',
        workPackage: 'WP-P2-PERF-048',
        output: 'evidence/WP-P2-PERF-047/forbidden-prefix',
      }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    await expect(
      executeSearchCapacity({ profile: 'smoke', label: 'after', 'sql-only': true }),
    ).rejects.toThrow('SQL_ONLY_MODE_REJECTED');
    await expect(
      executeSearchCapacity({
        profile: 'smoke',
        label: 'after',
        workPackage: 'arbitrary' as never,
      }),
    ).rejects.toThrow('SEARCH_WORK_PACKAGE_REJECTED');
    await expect(
      executeSearchCapacity({
        profile: 'smoke',
        label: 'after',
        workPackage: 'WP-P2-PERF-048',
        'sql-only': 'true' as never,
      }),
    ).rejects.toThrow('SQL_ONLY_MODE_REJECTED');
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it.each([
    {
      sqlOnly: true,
      completed: true,
      equivalent: true,
      cleanupOk: true,
      requests: true,
      expected: true,
    },
    {
      sqlOnly: true,
      completed: false,
      equivalent: false,
      cleanupOk: true,
      requests: true,
      expected: false,
    },
    {
      sqlOnly: true,
      completed: true,
      equivalent: false,
      cleanupOk: true,
      requests: true,
      expected: false,
    },
    {
      sqlOnly: true,
      completed: true,
      equivalent: true,
      cleanupOk: false,
      requests: true,
      expected: false,
    },
    {
      sqlOnly: false,
      completed: true,
      equivalent: true,
      cleanupOk: true,
      requests: false,
      expected: true,
    },
    {
      sqlOnly: false,
      completed: true,
      equivalent: true,
      cleanupOk: true,
      requests: true,
      expected: true,
    },
  ])('separates SQL-only validity, rejected adoption and HTTP measurement: %j', async (test) => {
    const path = resolve(`evidence/WP-P2-PERF-048/unit-prefix-${randomUUID()}`);
    ownedPaths.push(path);
    const database = 'solvi_perf041_123_abcdef123456';
    const cleanup = vi.fn(async () => ({ success: test.cleanupOk }));
    const rt = {
      meta: { database, workPackage: 'WP-P2-PERF-048' },
      admin: {
        query: async (sql: string) => ({
          rows: sql.includes('current_database()') ? [{ database }] : [],
          rowCount: 1,
        }),
      },
      createCredential: vi.fn(),
      cleanup,
    };
    const createRuntime = vi.fn(async () => rt);
    const fixture = { organizationId: 'synthetic', counts: { tickets: 2400 } };
    vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
    vi.doMock('../../tools/performance/fixture.mjs', () => ({ seedFixture: async () => fixture }));
    const analyzeSearchPrefix = vi.fn(async () => ({
      completed: test.completed,
      equivalent: test.equivalent,
      cases: [{ completed: test.completed }],
      assessment: { accepted: false },
    }));
    const runSearchCostAnalysis = vi.fn();
    const runSearchCapacity = vi.fn(async () => ({
      completed: true,
      apiContractValid: true,
      allRequestsSucceeded: test.requests,
      phases: [{ index: 1 }],
    }));
    vi.doMock('../../tools/performance/search-prefix-analysis.mjs', () => ({
      analyzeSearchPrefix,
    }));
    vi.doMock('../../tools/performance/search-cost-analysis.mjs', () => ({
      runSearchCostAnalysis,
    }));
    vi.doMock('../../tools/performance/search-capacity.mjs', () => ({ runSearchCapacity }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeSearchCapacity({
      profile: 'smoke',
      label: 'after',
      workPackage: 'WP-P2-PERF-048',
      'sql-only': test.sqlOnly,
      output: path,
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workPackage: 'WP-P2-PERF-048' }),
    );
    expect(analyzeSearchPrefix).toHaveBeenCalledWith(rt, fixture, expect.any(AbortSignal));
    expect(runSearchCostAnalysis).not.toHaveBeenCalled();
    expect(runSearchCapacity).toHaveBeenCalledTimes(
      !test.sqlOnly && test.completed && test.equivalent ? 1 : 0,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      workPackage: 'WP-P2-PERF-048',
      capacitySkipped: test.sqlOnly,
      measurementScope: test.sqlOnly ? 'sql-only' : 'sql-and-http',
      success: test.expected,
      allRequestsSucceeded: !test.sqlOnly && test.requests,
      queryAnalysis: { assessment: { accepted: false } },
      cleanup: { success: test.cleanupOk },
    });
    if (test.sqlOnly) {
      expect(report.capacity).toBeUndefined();
      expect(report.capacitySkipReason).toBe('sql-only-requested');
      expect(report.interpretation).toMatchObject({
        model:
          'RLS READ ONLY SQL contexts and four fixed synthetic search terms; no HTTP sessions or arrival waves measured.',
      });
    } else {
      expect(report.interpretation).toMatchObject({
        model: expect.stringContaining('independent real sessions; simultaneous API arrival waves'),
      });
    }
    expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
      success: test.expected,
      capacitySkipped: test.sqlOnly,
    });
  });
  it('retains cleanup and suppresses private errors from the prefix analyzer', async () => {
    const path = resolve(`evidence/WP-P2-PERF-048/unit-prefix-private-${randomUUID()}`);
    ownedPaths.push(path);
    const database = 'solvi_perf041_123_abcdef123456';
    const cleanup = vi.fn(async () => ({ success: true }));
    vi.doMock('../../tools/performance/runtime.mjs', () => ({
      createRuntime: async () => ({
        meta: { database },
        admin: {
          query: async (sql: string) => ({
            rows: sql.includes('current_database()') ? [{ database }] : [],
            rowCount: 1,
          }),
        },
        cleanup,
        createCredential: vi.fn(),
      }),
    }));
    vi.doMock('../../tools/performance/fixture.mjs', () => ({
      seedFixture: async () => ({ organizationId: 'synthetic', counts: {} }),
    }));
    vi.doMock('../../tools/performance/search-prefix-analysis.mjs', () => ({
      analyzeSearchPrefix: async () => {
        throw new Error('PRIVATE_SECRET_VALUE');
      },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeSearchCapacity({
      profile: 'smoke',
      label: 'after',
      workPackage: 'WP-P2-PERF-048',
      'sql-only': true,
      output: path,
    });
    expect(report).toMatchObject({
      success: false,
      allRequestsSucceeded: false,
      capacitySkipped: true,
      failureCode: 'DIAGNOSTIC_FAILED',
      cleanup: { success: true },
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('WP046 diagnostic confidentiality', () => {
  it('does not publish unknown uppercase runtime errors or codes', async () => {
    const path = resolve(`evidence/WP-P2-PERF-046/unit-private-error-${randomUUID()}`);
    ownedPaths.push(path);
    vi.doMock('../../tools/performance/runtime.mjs', () => ({
      createRuntime: async () => {
        throw Object.assign(new Error('DIRECTORY_PRIVATE_SECRET'), {
          code: 'PRIVATE_SECRET_TOKEN',
        });
      },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeSearchDiagnostic({
      profile: 'smoke',
      label: 'before',
      output: path,
    });
    expect(report).toMatchObject({ success: false, failureCode: 'DIAGNOSTIC_FAILED' });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
  });
});

describe('WP045 directory diagnostic fixed scope', () => {
  it('does not publish unknown uppercase runtime errors or codes', async () => {
    const path = resolve(`evidence/WP-P2-PERF-045/unit-private-error-${randomUUID()}`);
    ownedPaths.push(path);
    vi.doMock('../../tools/performance/runtime.mjs', () => ({
      createRuntime: async () => {
        throw Object.assign(new Error('DIRECTORY_PRIVATE_SECRET'), {
          code: 'PRIVATE_SECRET_TOKEN',
        });
      },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await executeDirectoryDiagnostic({
      profile: 'smoke',
      label: 'before',
      output: path,
    });
    expect(report).toMatchObject({ success: false, failureCode: 'DIAGNOSTIC_FAILED' });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
  });
  it('permits security checks only for after smoke and rejects arbitrary targets', async () => {
    expect(
      parseDirectoryArgs(['--profile', 'smoke', '--label', 'after', '--security-checks']),
    ).toEqual({ profile: 'smoke', label: 'after', 'security-checks': true });
    for (const profile of ['baseline', 'growth']) {
      expect(() =>
        parseDirectoryArgs(['--profile', profile, '--label', 'after', '--security-checks']),
      ).toThrow('SECURITY_CHECKS_AFTER_SMOKE_ONLY');
    }
    expect(() =>
      parseDirectoryArgs(['--profile', 'smoke', '--label', 'before', '--security-checks']),
    ).toThrow('SECURITY_CHECKS_AFTER_SMOKE_ONLY');
    for (const option of ['--url', '--database', '--ref', '--work-package']) {
      expect(() =>
        parseDirectoryArgs(['--profile', 'smoke', '--label', 'after', option, 'arbitrary']),
      ).toThrow('UNKNOWN_ARGUMENT');
    }
    expect(() =>
      parseDirectoryArgs([
        '--profile',
        'smoke',
        '--label',
        'after',
        '--security-checks',
        '--security-checks',
      ]),
    ).toThrow('DUPLICATE_ARGUMENT');
    await expect(
      executeDirectoryDiagnostic({ profile: 'baseline', label: 'after', 'security-checks': true }),
    ).rejects.toThrow('SECURITY_CHECKS_AFTER_SMOKE_ONLY');
  });
  it('retains WP045 evidence isolation', async () => {
    await expect(
      prepareOutput('evidence/WP-P2-PERF-044/wrong-directory', 'smoke', 'WP-P2-PERF-045'),
    ).rejects.toThrow();
  });
  it.each([
    ['measured-http-failure', true, false, true, true, false, true],
    ['incomplete-comparison', false, false, true, true, false, false],
    ['incomplete-analysis', true, true, false, true, true, false],
    ['failed-state-proof', true, true, true, false, true, false],
    ['security-success', true, true, true, true, true, true],
  ] as const)(
    'separates measurement, state probes, SQL and security completion: %s',
    async (_name, completed, requestsSucceeded, analysisValid, statesValid, security, success) => {
      const path = resolve(`evidence/WP-P2-PERF-045/unit-${randomUUID()}`);
      ownedPaths.push(path);
      const order: string[] = [];
      const cleanup = vi.fn(async () => {
        order.push('cleanup');
        return { success: true };
      });
      const securityHook = vi.fn(async () => {
        order.push('security');
        return {
          completed: true,
          success: true,
          testFiles: { passed: 2, failed: 0 },
          tests: { passed: 20, failed: 0, pending: 0 },
        };
      });
      const createRuntime = vi.fn(async () => ({
        meta: { database: 'solvi_perf041_123_abcdef123456' },
        admin: {},
        createCredential: vi.fn(),
        cleanup,
        runDirectorySecurityTests: securityHook,
      }));
      vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
      vi.doMock('../../tools/performance/fixture.mjs', () => ({
        seedFixture: async () => ({ counts: { users: 120 } }),
      }));
      const runDirectoryComparison = vi.fn(async () => {
        order.push('comparison');
        return {
          comparisonCompleted: completed,
          allRequestsSucceeded: requestsSucceeded,
          apiContractValid: true,
          phases: [],
        };
      });
      const runDirectoryStateProbes = vi.fn(async () => {
        order.push('states');
        return { completed: statesValid, valid: statesValid };
      });
      const runDirectoryAnalysis = vi.fn(async () => {
        order.push('analysis');
        return { completed: analysisValid, equivalent: analysisValid };
      });
      vi.doMock('../../tools/performance/directory-load.mjs', () => ({
        runDirectoryComparison,
        runDirectoryStateProbes,
      }));
      vi.doMock('../../tools/performance/directory-analysis.mjs', () => ({ runDirectoryAnalysis }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const report = await executeDirectoryDiagnostic({
        profile: 'smoke',
        label: 'after',
        output: path,
        ...(security ? { 'security-checks': true as const } : {}),
      });
      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ workPackage: 'WP-P2-PERF-045' }),
      );
      expect(report).toMatchObject({
        workPackage: 'WP-P2-PERF-045',
        success,
        allRequestsSucceeded: requestsSucceeded,
        cleanup: { success: true },
      });
      const expected = ['comparison'];
      if (completed) expected.push('analysis');
      if (completed && analysisValid && security) expected.push('states');
      if (completed && analysisValid && security && statesValid) expected.push('security');
      expected.push('cleanup');
      expect(order).toEqual(expected);
      expect(JSON.parse(await readFile(resolve(path, 'report.json'), 'utf8'))).toMatchObject({
        success,
        workPackage: 'WP-P2-PERF-045',
      });
    },
  );
});
