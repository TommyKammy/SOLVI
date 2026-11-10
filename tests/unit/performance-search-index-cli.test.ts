import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  executeSearchIndex,
  parseSearchIndexArgs,
} from '../../tools/performance/run-search-index.mjs';

const ownedPaths: string[] = [];
const database = 'solvi_perf041_123_abcdef123456';
const privateValue = 'SYNTHETIC_PRIVATE_VALUE_MUST_NOT_BE_REPORTED';
const options = { profile: 'smoke' } as const;

function outputPath() {
  const path = resolve(`evidence/WP-P2-PERF-051/unit-index-${randomUUID()}`);
  ownedPaths.push(path);
  return path;
}

function mockDependencies() {
  const analysis = {
    completed: true,
    equivalent: true,
    protocolCompleted: true,
    catalogComplete: true,
    restorationVerified: true,
    adoptionEstablished: false,
    elapsedMs: 7,
    conditions: [],
    readOnlyContexts: [],
    boundaries: [],
    equalityControls: [],
    catalog: { indexes: [{ valid: true }], statistics: { present: true } },
  };
  const cleanup = vi.fn(async () => ({ success: true }));
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('current_database()') ? [{ database }] : [],
    rowCount: 1,
  }));
  const runtime = {
    meta: { workPackage: 'WP-P2-PERF-051', database },
    admin: { query },
    createCredential: vi.fn(),
    cleanup,
  };
  const fixture = {
    organizationId: 'synthetic-organization',
    counts: { users: 4000, tickets: 2400 },
    actors: [{ password: privateValue, userId: privateValue }],
  };
  const createRuntime = vi.fn(async (_args?: unknown) => runtime);
  const seedFixture = vi.fn(async () => fixture);
  const analyzeSearchIndex = vi.fn(
    async (
      _runtime?: unknown,
      _fixture?: unknown,
      _args?: { signal?: AbortSignal; onProgress?: (stage: string) => void },
    ) => analysis,
  );
  vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
  vi.doMock('../../tools/performance/fixture.mjs', () => ({ seedFixture }));
  vi.doMock('../../tools/performance/search-index-analysis.mjs', () => ({ analyzeSearchIndex }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    analysis,
    cleanup,
    runtime,
    fixture,
    createRuntime,
    seedFixture,
    analyzeSearchIndex,
    log,
  };
}

afterEach(async () => {
  vi.doUnmock('../../tools/performance/runtime.mjs');
  vi.doUnmock('../../tools/performance/fixture.mjs');
  vi.doUnmock('../../tools/performance/search-index-analysis.mjs');
  vi.restoreAllMocks();
  await Promise.all(ownedPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('WP051 fixed CLI arguments', () => {
  it('accepts the three profiles, private output and standalone help', () => {
    expect(parseSearchIndexArgs(['--help'])).toEqual({ help: true });
    for (const profile of ['smoke', 'baseline', 'growth']) {
      expect(parseSearchIndexArgs(['--profile', profile, '--exercise-cleanup'])).toEqual({
        profile,
        'exercise-cleanup': true,
      });
    }
    expect(
      parseSearchIndexArgs(['--profile', 'growth', '--output', 'evidence/WP-P2-PERF-051/new-run']),
    ).toEqual({ profile: 'growth', output: 'evidence/WP-P2-PERF-051/new-run' });
  });

  it.each([
    '--replica',
    '--sql',
    '--ref',
    '--url',
    '--db',
    '--iterations',
    '--label',
    '--work-package',
    '--sql-only',
    '--enable-seqscan',
    '--statement-timeout',
  ])('rejects arbitrary option %s', (key) => {
    expect(() => parseSearchIndexArgs(['--profile', 'smoke', key, privateValue])).toThrow(
      'UNKNOWN_ARGUMENT',
    );
  });

  it('rejects missing, repeated, unknown and help-mixed arguments', () => {
    expect(() => parseSearchIndexArgs([])).toThrow('PROFILE_REQUIRED');
    expect(() => parseSearchIndexArgs(['--profile', 'other'])).toThrow('UNKNOWN_PROFILE');
    expect(() => parseSearchIndexArgs(['--profile', '--output', 'x'])).toThrow('MISSING_ARGUMENT');
    expect(() => parseSearchIndexArgs(['--profile'])).toThrow('MISSING_ARGUMENT');
    expect(() => parseSearchIndexArgs(['--profile', 'smoke', '--output'])).toThrow(
      'MISSING_ARGUMENT',
    );
    expect(() => parseSearchIndexArgs(['--profile', 'smoke', '--profile', 'growth'])).toThrow(
      'DUPLICATE_ARGUMENT',
    );
    expect(() =>
      parseSearchIndexArgs(['--profile', 'smoke', '--exercise-cleanup', '--exercise-cleanup']),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() => parseSearchIndexArgs(['--help', '--profile', 'smoke'])).toThrow(
      'UNKNOWN_ARGUMENT',
    );
  });

  it.each([
    { value: { ...options, replica: 1 }, code: 'UNKNOWN_ARGUMENT' },
    { value: { ...options, profile: undefined }, code: 'PROFILE_REQUIRED' },
    { value: { ...options, output: 1 }, code: 'OUTPUT_INVALID' },
    { value: { ...options, output: ' ' }, code: 'OUTPUT_INVALID' },
    { value: { ...options, 'exercise-cleanup': 'true' }, code: 'EXERCISE_CLEANUP_INVALID' },
    { value: { ...options, workPackage: 'WP-P2-PERF-050' }, code: 'UNKNOWN_ARGUMENT' },
    { value: { ...options, iterations: 1 }, code: 'UNKNOWN_ARGUMENT' },
    { value: { ...options, [Symbol('extra')]: true }, code: 'UNKNOWN_ARGUMENT' },
    { value: null, code: 'UNKNOWN_ARGUMENT' },
    { value: [], code: 'UNKNOWN_ARGUMENT' },
  ])('validates direct calls before allocation: $code', async ({ value, code }) => {
    const { createRuntime } = mockDependencies();
    await expect(executeSearchIndex(value as never)).rejects.toThrow(code);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe('WP051 diagnostic report and cleanup', () => {
  it('binds fixed work package and SQL scope, forwards cancellation, saves only fixture counts with mode 0600', async () => {
    const m = mockDependencies();
    const output = outputPath();
    const report = await executeSearchIndex({ ...options, output });
    expect(m.createRuntime).toHaveBeenCalledWith({
      workPackage: 'WP-P2-PERF-051',
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    expect(m.seedFixture).toHaveBeenCalledWith(m.runtime.admin, report.profile, {
      createCredential: m.runtime.createCredential,
      databaseName: database,
    });
    expect(m.analyzeSearchIndex).toHaveBeenCalledWith(m.runtime, m.fixture, {
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    expect(report).toMatchObject({
      success: true,
      interrupted: false,
      workPackage: 'WP-P2-PERF-051',
      measurementScope: 'sql-and-catalog',
      capacitySkipped: true,
      allRequestsSucceeded: false,
      adoptionEstablished: false,
      catalogComplete: true,
      restorationVerified: true,
      fixtureAdjustments: { missingCriticalSlaPolicyRows: 1, statistics: 'explicit-analyze' },
    });
    expect(report).not.toHaveProperty('capacity');
    expect(report).not.toHaveProperty('workload');
    expect(report).not.toHaveProperty('replica');
    expect(m.cleanup).toHaveBeenCalledTimes(1);
    const bytes = await readFile(resolve(output, 'report.json'), 'utf8');
    expect(bytes).not.toContain(privateValue);
    expect(JSON.parse(bytes)).toEqual(report);
    expect((await stat(resolve(output, 'report.json'))).mode & 0o777).toBe(0o600);
  });

  it.each(['completed', 'equivalent', 'protocolCompleted'] as const)(
    'requires %s while preserving partial analysis',
    async (field) => {
      const m = mockDependencies();
      m.analysis[field] = false;
      const report = await executeSearchIndex({ ...options, output: outputPath() });
      expect(report.success).toBe(false);
      expect(report.failureCode).toBe('DIAGNOSTIC_ANALYSIS_INCOMPLETE');
      expect(report.queryAnalysis?.[field]).toBe(false);
      expect(m.cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it('retains completed SQL when catalog observation is unavailable without declaring success', async () => {
    const m = mockDependencies();
    m.analysis.catalogComplete = false;
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report).toMatchObject({
      success: false,
      failureCode: 'DIAGNOSTIC_CATALOG_INCOMPLETE',
      catalogComplete: false,
      queryAnalysis: { completed: true, equivalent: true, protocolCompleted: true },
      cleanup: { success: true },
    });
  });

  it('does not confuse a successfully observed unhealthy index or absent statistics with collection failure', async () => {
    const m = mockDependencies();
    m.analysis.catalog.indexes = [{ valid: false }];
    m.analysis.catalog.statistics.present = false;
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report.success).toBe(true);
    expect(report.catalogComplete).toBe(true);
    expect(report.queryAnalysis).toMatchObject({ catalog: m.analysis.catalog });
    expect(report.adoptionEstablished).toBe(false);
  });

  it('requires setting restoration independently from semantic and protocol completion', async () => {
    const m = mockDependencies();
    m.analysis.restorationVerified = false;
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report).toMatchObject({
      success: false,
      failureCode: 'DIAGNOSTIC_RESTORATION_UNVERIFIED',
      restorationVerified: false,
      queryAnalysis: { completed: true, equivalent: true, protocolCompleted: true },
    });
    expect(m.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    'completed',
    'equivalent',
    'protocolCompleted',
    'catalogComplete',
    'restorationVerified',
  ] as const)('rejects a truthy nonboolean %s', async (field) => {
    const m = mockDependencies();
    Object.assign(m.analysis, { [field]: 'true' });
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report.success).toBe(false);
    expect(m.cleanup).toHaveBeenCalledTimes(1);
  });

  it('exercises failure after fixture preparation before SQL analysis', async () => {
    const m = mockDependencies();
    const report = await executeSearchIndex({
      ...options,
      output: outputPath(),
      'exercise-cleanup': true,
    });
    expect(report).toMatchObject({
      success: false,
      failureCode: 'EXPECTED_CLEANUP_EXERCISE',
      dataset: m.fixture.counts,
      fixtureAdjustments: { missingCriticalSlaPolicyRows: 1 },
      cleanup: { success: true },
    });
    expect(m.analyzeSearchIndex).not.toHaveBeenCalled();
    expect(m.cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps interrupted partial analysis and removes its signal listeners', async () => {
    const m = mockDependencies();
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    m.analyzeSearchIndex.mockImplementationOnce(async (_runtime, _fixture, args) => {
      process.emit('SIGTERM');
      expect(args?.signal?.aborted).toBe(true);
      return { ...m.analysis, completed: false, protocolCompleted: false, elapsedMs: 19 };
    });
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report).toMatchObject({
      success: false,
      interrupted: true,
      failureCode: 'DIAGNOSTIC_INTERRUPTED',
      queryAnalysis: { completed: false, protocolCompleted: false, elapsedMs: 19 },
      cleanup: { success: true },
    });
    expect(m.cleanup).toHaveBeenCalledTimes(1);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });

  it('rejects success if a signal arrives during cleanup after completed analysis', async () => {
    const m = mockDependencies();
    m.cleanup.mockImplementationOnce(async () => {
      process.emit('SIGINT');
      return { success: true };
    });
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report).toMatchObject({
      success: false,
      interrupted: true,
      failureCode: 'DIAGNOSTIC_INTERRUPTED',
      queryAnalysis: { completed: true, equivalent: true, protocolCompleted: true },
    });
  });

  it.each(['false', 'throws'])('requires cleanup success (%s)', async (mode) => {
    const m = mockDependencies();
    if (mode === 'throws') m.cleanup.mockRejectedValueOnce(new Error(privateValue));
    else m.cleanup.mockResolvedValueOnce({ success: false });
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report.success).toBe(false);
    expect(report.failureCode).toBe('CLEANUP_FAILED');
    expect(report.queryAnalysis?.completed).toBe(true);
    expect(JSON.stringify(report)).not.toContain(privateValue);
  });

  it('retains owned factory startup metadata and cleanup only', async () => {
    const m = mockDependencies();
    m.createRuntime.mockRejectedValueOnce(
      Object.assign(new Error(privateValue), {
        meta: m.runtime.meta,
        cleanupReport: { success: true, ownedRemoved: true },
      }),
    );
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report).toMatchObject({
      success: false,
      failureCode: 'DIAGNOSTIC_FAILED',
      runtime: m.runtime.meta,
      cleanup: { success: true, ownedRemoved: true },
    });
    expect(m.cleanup).not.toHaveBeenCalled();
    expect(m.seedFixture).not.toHaveBeenCalled();
    expect(m.analyzeSearchIndex).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(privateValue);
  });

  it.each(['fixture', 'analysis'])(
    'bounds unknown %s errors and refuses their metadata',
    async (where) => {
      const m = mockDependencies();
      const error = Object.assign(new Error(privateValue), {
        code: privateValue,
        meta: { privateValue },
        cleanupReport: { privateValue },
      });
      if (where === 'fixture') m.seedFixture.mockRejectedValueOnce(error);
      else m.analyzeSearchIndex.mockRejectedValueOnce(error);
      const output = outputPath();
      const report = await executeSearchIndex({ ...options, output });
      expect(report).toMatchObject({
        success: false,
        failureCode: 'DIAGNOSTIC_FAILED',
        runtime: m.runtime.meta,
        cleanup: { success: true },
      });
      expect(m.cleanup).toHaveBeenCalledTimes(1);
      expect(await readFile(resolve(output, 'report.json'), 'utf8')).not.toContain(privateValue);
      expect(m.log.mock.calls.flat().join(' ')).not.toContain(privateValue);
    },
  );

  it('records only bounded fixed progress including the partial-result signal point', async () => {
    const m = mockDependencies();
    const names = [
      'index-ready',
      'index-catalog-completed',
      ...['short', 'wide', 'rare', 'zero', 'rare-state', 'zero-new', 'short-new'].map(
        (condition) => `index-${condition}-completed`,
      ),
      'index-boundaries-completed',
    ];
    m.analyzeSearchIndex.mockImplementationOnce(async (_runtime, _fixture, args) => {
      args?.onProgress?.(privateValue);
      args?.onProgress?.('index-unrecognized-completed');
      for (const name of names) args?.onProgress?.(name);
      for (let i = 0; i < 150; i += 1) args?.onProgress?.('index-ready');
      return m.analysis;
    });
    const report = await executeSearchIndex({ ...options, output: outputPath() });
    expect(report.stages.map(({ stage }) => stage)).toEqual(expect.arrayContaining(names));
    expect(report.stages).toHaveLength(128);
    expect(m.log).toHaveBeenCalledWith('search-index: index-short-completed');
    expect(JSON.stringify(report)).not.toContain(privateValue);
    expect(m.log.mock.calls.flat().join(' ')).not.toContain('index-unrecognized-completed');
  });

  it('rejects another work package or an existing output before allocation', async () => {
    const m = mockDependencies();
    await expect(
      executeSearchIndex({ ...options, output: 'evidence/WP-P2-PERF-050/unit-invalid-051' }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    const output = outputPath();
    await mkdir(output, { recursive: true });
    await expect(executeSearchIndex({ ...options, output })).rejects.toThrow(
      'OUTPUT_ALREADY_EXISTS',
    );
    expect(m.createRuntime).not.toHaveBeenCalled();
  });

  it('never overwrites a report and removes signal listeners even when wx writing fails', async () => {
    const m = mockDependencies();
    const output = outputPath();
    const reportPath = resolve(output, 'report.json');
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    m.cleanup.mockImplementationOnce(async () => {
      await writeFile(reportPath, 'owned-unit-sentinel', { flag: 'wx' });
      return { success: true };
    });
    await expect(executeSearchIndex({ ...options, output })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(reportPath, 'utf8')).toBe('owned-unit-sentinel');
    expect(m.cleanup).toHaveBeenCalledTimes(1);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });
});
