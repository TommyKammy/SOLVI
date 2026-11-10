import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  executeSearchRepro,
  parseSearchReproArgs,
} from '../../tools/performance/run-search-repro.mjs';

const ownedPaths: string[] = [];
const database = 'solvi_perf041_123_abcdef123456';
const privateValue = 'SYNTHETIC_PRIVATE_VALUE_MUST_NOT_BE_REPORTED';
const options = { profile: 'smoke', replica: 1 } as const;

function outputPath() {
  const path = resolve(`evidence/WP-P2-PERF-050/unit-repro-${randomUUID()}`);
  ownedPaths.push(path);
  return path;
}

function validAnalysis() {
  return {
    completed: true,
    equivalent: true,
    protocolCompleted: true,
    adoptionEstablished: false,
    elapsedMs: 7,
    conditions: [],
    readOnlyContexts: [],
    resourceObservations: { complete: true, expectedWindows: 15, windows: [] },
    summary: {},
    structures: {},
  };
}

function mockDependencies() {
  const analysis = validAnalysis();
  const cleanup = vi.fn(async () => ({ success: true }));
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('current_database()') ? [{ database }] : [],
    rowCount: 1,
  }));
  const runtime = {
    meta: { workPackage: 'WP-P2-PERF-050', database },
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
  const analyzeSearchRepro = vi.fn(
    async (
      _runtime?: unknown,
      _fixture?: unknown,
      _args?: { replica: 1 | 2; signal?: AbortSignal; onProgress?: (stage: string) => void },
    ) => analysis,
  );
  vi.doMock('../../tools/performance/runtime.mjs', () => ({ createRuntime }));
  vi.doMock('../../tools/performance/fixture.mjs', () => ({ seedFixture }));
  vi.doMock('../../tools/performance/search-repro-analysis.mjs', () => ({ analyzeSearchRepro }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    analysis,
    cleanup,
    runtime,
    fixture,
    createRuntime,
    seedFixture,
    analyzeSearchRepro,
    log,
  };
}

afterEach(async () => {
  vi.doUnmock('../../tools/performance/runtime.mjs');
  vi.doUnmock('../../tools/performance/fixture.mjs');
  vi.doUnmock('../../tools/performance/search-repro-analysis.mjs');
  vi.restoreAllMocks();
  await Promise.all(ownedPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('WP050 fixed CLI arguments', () => {
  it('accepts only fixed profiles, exact replica numbers and a standalone help request', () => {
    expect(parseSearchReproArgs(['--help'])).toEqual({ help: true });
    for (const profile of ['smoke', 'baseline', 'growth']) {
      for (const replica of ['1', '2']) {
        expect(
          parseSearchReproArgs(['--profile', profile, '--replica', replica, '--exercise-cleanup']),
        ).toEqual({ profile, replica: Number(replica), 'exercise-cleanup': true });
      }
    }
    expect(
      parseSearchReproArgs([
        '--replica',
        '1',
        '--profile',
        'growth',
        '--output',
        'evidence/WP-P2-PERF-050/new-run',
      ]),
    ).toMatchObject({ output: 'evidence/WP-P2-PERF-050/new-run' });
  });

  it.each(['--sql', '--ref', '--url', '--iterations', '--label', '--work-package', '--sql-only'])(
    'rejects arbitrary option %s',
    (key) => {
      expect(() =>
        parseSearchReproArgs(['--profile', 'smoke', '--replica', '1', key, privateValue]),
      ).toThrow('UNKNOWN_ARGUMENT');
    },
  );

  it.each(['0', '3', '-1', '01', '1.0', '1e0', 'NaN', ' 1'])(
    'rejects noncanonical replica %s',
    (replica) => {
      expect(() => parseSearchReproArgs(['--profile', 'smoke', '--replica', replica])).toThrow(
        'REPLICA_INVALID',
      );
    },
  );

  it('rejects missing, repeated, unknown and help-mixed arguments', () => {
    expect(() => parseSearchReproArgs([])).toThrow('PROFILE_REQUIRED');
    expect(() => parseSearchReproArgs(['--profile', 'smoke'])).toThrow('REPLICA_REQUIRED');
    expect(() => parseSearchReproArgs(['--profile', 'other', '--replica', '1'])).toThrow(
      'UNKNOWN_PROFILE',
    );
    expect(() => parseSearchReproArgs(['--profile', '--replica', '1'])).toThrow('MISSING_ARGUMENT');
    expect(() => parseSearchReproArgs(['--replica'])).toThrow('MISSING_ARGUMENT');
    expect(() =>
      parseSearchReproArgs(['--profile', 'smoke', '--profile', 'growth', '--replica', '1']),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() =>
      parseSearchReproArgs([
        '--profile',
        'smoke',
        '--replica',
        '1',
        '--exercise-cleanup',
        '--exercise-cleanup',
      ]),
    ).toThrow('DUPLICATE_ARGUMENT');
    expect(() => parseSearchReproArgs(['--help', '--url', privateValue])).toThrow(
      'UNKNOWN_ARGUMENT',
    );
  });

  it.each([
    { value: { ...options, replica: '1' }, code: 'REPLICA_INVALID' },
    { value: { ...options, replica: undefined }, code: 'REPLICA_REQUIRED' },
    { value: { ...options, profile: undefined }, code: 'PROFILE_REQUIRED' },
    { value: { ...options, output: 1 }, code: 'OUTPUT_INVALID' },
    { value: { ...options, output: ' ' }, code: 'OUTPUT_INVALID' },
    { value: { ...options, 'exercise-cleanup': 'true' }, code: 'EXERCISE_CLEANUP_INVALID' },
    { value: { ...options, workPackage: 'WP-P2-PERF-049' }, code: 'UNKNOWN_ARGUMENT' },
    { value: { ...options, iterations: 1 }, code: 'UNKNOWN_ARGUMENT' },
    { value: null, code: 'UNKNOWN_ARGUMENT' },
  ])('also validates direct calls before runtime allocation: $code', async ({ value, code }) => {
    const { createRuntime } = mockDependencies();
    await expect(executeSearchRepro(value as never)).rejects.toThrow(code);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe('WP050 diagnostic report and cleanup', () => {
  it('binds fixed work package, forwards replica, retains only fixture counts and writes a private report', async () => {
    const m = mockDependencies();
    const output = outputPath();
    const report = await executeSearchRepro({ ...options, replica: 2, output });
    expect(m.createRuntime).toHaveBeenCalledWith({
      workPackage: 'WP-P2-PERF-050',
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    expect(m.seedFixture).toHaveBeenCalledWith(m.runtime.admin, report.profile, {
      createCredential: m.runtime.createCredential,
      databaseName: database,
    });
    expect(m.analyzeSearchRepro).toHaveBeenCalledWith(m.runtime, m.fixture, {
      replica: 2,
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    });
    expect(report).toMatchObject({
      success: true,
      interrupted: false,
      workPackage: 'WP-P2-PERF-050',
      replica: 2,
      measurementScope: 'sql-only',
      capacitySkipped: true,
      allRequestsSucceeded: false,
      adoptionEstablished: false,
      resourceObservationsComplete: true,
      fixtureAdjustments: { missingCriticalSlaPolicyRows: 1, statistics: 'explicit-analyze' },
    });
    expect(report).not.toHaveProperty('capacity');
    expect(report).not.toHaveProperty('workload');
    expect(m.cleanup).toHaveBeenCalledTimes(1);
    const bytes = await readFile(resolve(output, 'report.json'), 'utf8');
    expect(bytes).not.toContain(privateValue);
    expect(JSON.parse(bytes)).toEqual(report);
    expect((await stat(resolve(output, 'report.json'))).mode & 0o777).toBe(0o600);
  });

  it('preserves SQL success when resources are unavailable without claiming the resource gate', async () => {
    const m = mockDependencies();
    m.analysis.resourceObservations.complete = false;
    const report = await executeSearchRepro({ ...options, output: outputPath() });
    expect(report.success).toBe(true);
    expect(report.resourceObservationsComplete).toBe(false);
    expect(report.queryAnalysis?.protocolCompleted).toBe(true);
    expect(report.adoptionEstablished).toBe(false);
    expect(report.interpretation.resources).toContain('unavailable');
  });

  it.each(['completed', 'equivalent', 'protocolCompleted'] as const)(
    'requires %s, retains partial analysis and cleans up',
    async (field) => {
      const m = mockDependencies();
      m.analysis[field] = false;
      const report = await executeSearchRepro({ ...options, output: outputPath() });
      expect(report.success).toBe(false);
      expect(report.failureCode).toBe('DIAGNOSTIC_ANALYSIS_INCOMPLETE');
      expect(report.queryAnalysis?.[field]).toBe(false);
      expect(m.cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it('exercises failure only after fixture preparation and never starts analysis', async () => {
    const m = mockDependencies();
    const report = await executeSearchRepro({
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
    expect(m.analyzeSearchRepro).not.toHaveBeenCalled();
    expect(m.cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains a signal-interrupted partial analysis and removes its signal listeners', async () => {
    const m = mockDependencies();
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    m.analyzeSearchRepro.mockImplementationOnce(async (_runtime, _fixture, args) => {
      process.emit('SIGTERM');
      expect(args?.signal?.aborted).toBe(true);
      return { ...m.analysis, completed: false, protocolCompleted: false, elapsedMs: 19 };
    });
    const report = await executeSearchRepro({ ...options, output: outputPath() });
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

  it('does not report success when interruption arrives during cleanup after completed analysis', async () => {
    const m = mockDependencies();
    m.cleanup.mockImplementationOnce(async () => {
      process.emit('SIGINT');
      return { success: true };
    });
    const report = await executeSearchRepro({ ...options, output: outputPath() });
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
    const report = await executeSearchRepro({ ...options, output: outputPath() });
    expect(report.success).toBe(false);
    expect(report.failureCode).toBe('CLEANUP_FAILED');
    expect(report.queryAnalysis?.completed).toBe(true);
    expect(JSON.stringify(report)).not.toContain(privateValue);
  });

  it('retains only owned factory startup metadata and cleanup on preparation failure', async () => {
    const m = mockDependencies();
    m.createRuntime.mockRejectedValueOnce(
      Object.assign(new Error(privateValue), {
        meta: m.runtime.meta,
        cleanupReport: { success: true, ownedRemoved: true },
      }),
    );
    const report = await executeSearchRepro({ ...options, output: outputPath() });
    expect(report).toMatchObject({
      success: false,
      failureCode: 'DIAGNOSTIC_FAILED',
      runtime: m.runtime.meta,
      cleanup: { success: true, ownedRemoved: true },
    });
    expect(m.cleanup).not.toHaveBeenCalled();
    expect(m.seedFixture).not.toHaveBeenCalled();
    expect(m.analyzeSearchRepro).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(privateValue);
  });

  it.each(['fixture', 'analysis'])(
    'bounds unknown errors from %s and always releases runtime',
    async (where) => {
      const m = mockDependencies();
      const error = Object.assign(new Error(privateValue), {
        code: privateValue,
        meta: { privateValue },
        cleanupReport: { privateValue },
      });
      if (where === 'fixture') m.seedFixture.mockRejectedValueOnce(error);
      else m.analyzeSearchRepro.mockRejectedValueOnce(error);
      const output = outputPath();
      const report = await executeSearchRepro({ ...options, output });
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

  it('records only bounded fixed progress names, including analysis windows', async () => {
    const m = mockDependencies();
    m.analyzeSearchRepro.mockImplementationOnce(async (_runtime, _fixture, args) => {
      args?.onProgress?.(privateValue);
      args?.onProgress?.('repro-ready');
      args?.onProgress?.('repro-rare-state-explain-off-completed');
      for (let i = 0; i < 150; i += 1) args?.onProgress?.('repro-ready');
      return m.analysis;
    });
    const report = await executeSearchRepro({ ...options, output: outputPath() });
    expect(report.stages.map(({ stage }) => stage)).toContain(
      'repro-rare-state-explain-off-completed',
    );
    expect(report.stages.length).toBe(128);
    expect(JSON.stringify(report)).not.toContain(privateValue);
    expect(m.log.mock.calls.flat().join(' ')).not.toContain(privateValue);
  });

  it('rejects another work package or an existing output directory before allocating runtime', async () => {
    const m = mockDependencies();
    await expect(
      executeSearchRepro({ ...options, output: 'evidence/WP-P2-PERF-049/unit-invalid-050' }),
    ).rejects.toThrow('OUTPUT_OUTSIDE_EVIDENCE');
    const output = outputPath();
    await mkdir(output, { recursive: true });
    await expect(executeSearchRepro({ ...options, output })).rejects.toThrow(
      'OUTPUT_ALREADY_EXISTS',
    );
    expect(m.createRuntime).not.toHaveBeenCalled();
  });

  it('never overwrites an existing report and still cleans up and removes listeners on write failure', async () => {
    const m = mockDependencies();
    const output = outputPath();
    const reportPath = resolve(output, 'report.json');
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    m.cleanup.mockImplementationOnce(async () => {
      await writeFile(reportPath, 'owned-unit-sentinel', { flag: 'wx' });
      return { success: true };
    });
    await expect(executeSearchRepro({ ...options, output })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(reportPath, 'utf8')).toBe('owned-unit-sentinel');
    expect(m.cleanup).toHaveBeenCalledTimes(1);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });
});
