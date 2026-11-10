import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProfile } from '../../tools/performance/profiles.mjs';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type { AnalysisClient } from '../../tools/performance/list-query-analysis.mjs';
import {
  discoverSearchTerms,
  runSearchCapacity,
  searchCapacityPath,
  searchCapacitySchedule,
  type SearchCapacityRuntime,
} from '../../tools/performance/search-capacity.mjs';

const controls = vi.hoisted(() => ({
  login: vi.fn(),
  verify: vi.fn(),
  drain: vi.fn(),
  scrape: vi.fn(),
  observe: vi.fn(),
  probes: vi.fn(),
}));
vi.mock('../../tools/performance/workload.mjs', async (original) => ({
  ...(await original<typeof import('../../tools/performance/workload.mjs')>()),
  login: controls.login,
}));
vi.mock('../../tools/performance/list-load.mjs', async (original) => ({
  ...(await original<typeof import('../../tools/performance/list-load.mjs')>()),
  verifySessions: controls.verify,
  drain: controls.drain,
  scrapePool: controls.scrape,
  observePhase: controls.observe,
  verifySearchApiContract: controls.probes,
}));

const id = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-05 00:00:00.123456+00';
const fixture = {
  organizationId: id(1),
  controlOrganizationId: id(2),
  actors: [
    {
      role: 'agent',
      userId: id(3),
      ticketId: id(4),
      email: 'synthetic@example.test',
      password: 'private-unit-value',
    },
  ],
} as PerformanceFixture;
const proof = {
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
  statementTimeoutMs: 30000,
  queryTimeoutMs: 35000,
  readOnlyWriteRejected: true,
  readOnlyWriteSqlState: '25006',
} as const;
const total = (keyword: string) =>
  keyword === '合'
    ? 200
    : keyword === '合成性能問い合わせ 1'
      ? 75
      : keyword === 'PERF041-0000001'
        ? 1
        : 0;
function response(keyword: string) {
  const count = total(keyword);
  return {
    scope: 'organization',
    total: count,
    appliedFilter: { keyword },
    items: Array.from({ length: Math.min(50, count) }, (_, index) => ({
      id: id(100 - index),
      number: `SYNTH-${index}`,
      kind: 'incident',
      state: 'new',
      subject: '合成本文',
      body: '合成本文',
      impact: 'low',
      urgency: 'low',
      priority: 'low',
      createdAt: '2026-10-05T00:00:00.123Z',
      resolvedAt: null,
      assigned: false,
      sla: { remainingSeconds: null, breached: false },
      assigneeName: null,
      requesterName: '合成',
      assigneeGroupName: null,
    })),
    nextCursor: count >= 50 ? { id: id(51), createdAt: stamp } : null,
  };
}
function runtime(overrides: Partial<AnalysisClient['proof']> = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const withAppReadOnly = vi.fn(
    async <T>(
      context: { organizationId: string; actorId: string },
      callback: (client: AnalysisClient) => Promise<T>,
    ) => {
      expect(context).toEqual({ organizationId: id(1), actorId: id(3) });
      return callback({
        proof: { ...proof, ...overrides },
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes('FROM role_binding')) return { rows: [{ code: 'agent' }] };
          if (sql.startsWith('SELECT number')) return { rows: [{ number: 'PERF041-0000001' }] };
          const keyword = String(params[1]).slice(1, -1);
          if (sql.startsWith('SELECT count')) return { rows: [{ total: total(keyword) }] };
          return {
            rows: Array.from({ length: Math.min(50, total(keyword)) }, (_, index) => ({
              id: id(100 - index),
              cursor_created_at: stamp,
            })),
          };
        },
      });
    },
  );
  return {
    apiBase: 'http://127.0.0.1:45001',
    metricsBase: 'http://127.0.0.1:45002',
    admin: { query: vi.fn() },
    withAppReadOnly: withAppReadOnly as SearchCapacityRuntime['withAppReadOnly'],
    readOnlyMock: withAppReadOnly,
    queries,
  };
}
beforeEach(() => {
  let loginCount = 0,
    acquisitions = 0;
  controls.login.mockImplementation(async () => `solvi_session=synthetic-${++loginCount}`);
  controls.verify.mockImplementation(async (_admin, _actor, _fixture, cookies: string[]) => ({
    expected: cookies.length,
    sessions: cookies.length,
    distinctSessions: new Set(cookies).size,
    principals: 1,
    activeMatching: cookies.length,
    verified: new Set(cookies).size === cookies.length,
  }));
  controls.drain.mockResolvedValue({ drained: true, waitedMs: 0 });
  controls.scrape.mockImplementation(async () => ({
    valid: true,
    connections: { total: 1, idle: 1, waiting: 0, inUse: 0 },
    acquisitions: {
      success: { count: ++acquisitions, sumMs: acquisitions, buckets: [] },
      failure: { count: 0, sumMs: 0, buckets: [] },
    },
  }));
  controls.observe.mockImplementation(async () => ({
    pool: [],
    stop: async () => ({
      poolIntervalMs: 250,
      databaseIntervalMs: 500,
      pool: [{ atMs: 0, connections: { total: 1, idle: 1, waiting: 0, inUse: 0 } }],
      database: [{ atMs: 0, connections: 1, active: 0, idleInTransaction: 0, lockWaiting: 0 }],
      poolErrors: 0,
      databaseErrors: 0,
    }),
  }));
  controls.probes.mockResolvedValue({ completed: true, valid: true, cases: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('WP047 fixed search workload scope', () => {
  it.each(['baseline', 'growth'])(
    'fixes %s to 32 waves and 1480 simultaneous arrivals with reverse pass',
    (name) => {
      const steps = searchCapacitySchedule(getProfile(name));
      expect(steps).toHaveLength(32);
      expect(steps.reduce((sum, step) => sum + step.count, 0)).toBe(1480);
      expect(steps.slice(16).map(({ count, term }) => ({ count, term }))).toEqual(
        steps
          .slice(0, 16)
          .map(({ count, term }) => ({ count, term }))
          .reverse(),
      );
      expect([...new Set(steps.map((step) => step.count))]).toEqual([10, 25, 50, 100]);
    },
  );
  it('labels a fixed 240-request reduced smoke without changing the profile', () => {
    const profile = getProfile('smoke');
    const before = structuredClone(profile);
    expect(searchCapacitySchedule(profile).reduce((sum, step) => sum + step.count, 0)).toBe(240);
    expect(profile).toEqual(before);
    expect(() => searchCapacitySchedule({ ...profile, requestTimeoutMs: 15000 })).toThrow(
      'CAPACITY_PROFILE_INVALID',
    );
    expect(() => searchCapacitySchedule({ ...profile, activeSessions: 100 })).toThrow(
      'CAPACITY_PROFILE_INVALID',
    );
  });
  it('uses literal public keyword with fixed sort and rejects arbitrary search/URL input', () => {
    for (const keyword of [
      '合',
      '合成性能問い合わせ 1',
      'PERF041-0000001',
      'WP047不存在query-a879ef',
    ]) {
      const url = new URL(searchCapacityPath(keyword), 'http://127.0.0.1');
      expect(url.pathname).toBe('/tickets');
      expect([...url.searchParams.keys()]).toEqual(['limit', 'sort', 'keyword']);
      expect(url.searchParams.get('keyword')).toBe(keyword);
      expect(url.searchParams.get('sort')).toBe('newest');
      expect(url.searchParams.get('limit')).toBe('50');
    }
    expect(() => searchCapacityPath('https://example.test')).toThrow('CAPACITY_FIXTURE_INVALID');
    expect(() => searchCapacityPath('arbitrary')).toThrow('CAPACITY_FIXTURE_INVALID');
  });
  it('discovers a synthetic rare term only after real role and RLS proof checks', async () => {
    const rt = runtime();
    const result = await discoverSearchTerms(rt, fixture);
    expect(result.terms).toEqual([
      { key: 'short', keyword: '合' },
      { key: 'wide', keyword: '合成性能問い合わせ 1' },
      { key: 'rare', keyword: 'PERF041-0000001' },
      { key: 'zero', keyword: 'WP047不存在query-a879ef' },
    ]);
    expect(rt.queries[0]!.params).toEqual([id(1), id(3)]);
    expect(rt.queries[1]!.params).toEqual([id(1), id(4)]);
  });
  it('rejects missing RLS evidence before any database read or login', async () => {
    const rt = runtime({ ticketRlsActive: false } as unknown as Partial<AnalysisClient['proof']>);
    await expect(discoverSearchTerms(rt, fixture)).rejects.toThrow('QUERY_READ_ONLY_PROOF_INVALID');
    expect(rt.queries).toEqual([]);
    expect(controls.login).not.toHaveBeenCalled();
  });
  it.each([200, 500])(
    'preserves complete waves separately from HTTP %s success',
    async (status) => {
      const requests: Array<{ keyword: string; cookie: string }> = [];
      let preflight = 0;
      vi.stubGlobal('fetch', async (input: string, options: { headers: { cookie: string } }) => {
        const url = new URL(input);
        const keyword = url.searchParams.get('keyword')!;
        requests.push({ keyword, cookie: options.headers.cookie });
        return new Response(JSON.stringify(response(keyword)), {
          status: ++preflight <= 4 ? 200 : status,
          headers: { 'content-type': 'application/json' },
        });
      });
      const report = await runSearchCapacity({
        runtime: runtime(),
        fixture,
        profile: getProfile('growth'),
      });
      expect(report).toMatchObject({
        completed: true,
        allRequestsSucceeded: status === 200,
        apiContractValid: true,
        loginCompleted: 100,
        plannedRequests: 1480,
      });
      expect(report.phases).toHaveLength(32);
      expect(
        report.phases.every((phase) => phase.observationValid && phase.burst?.unfinished === 0),
      ).toBe(true);
      expect(requests).toHaveLength(1484);
      expect(new Set(requests.slice(4).map((value) => value.cookie)).size).toBe(100);
      expect(
        report.phases
          .filter((phase) => phase.count === 100)
          .every((phase) => phase.burst?.sent === 100),
      ).toBe(true);
      expect(controls.login).toHaveBeenCalledTimes(100);
      expect(controls.verify).toHaveBeenCalledOnce();
      expect(controls.drain).toHaveBeenCalledTimes(33);
      expect(JSON.stringify(report)).not.toContain('solvi_session');
      expect(JSON.stringify(report)).not.toContain('PERF041-0000001');
      expect(JSON.stringify(report)).not.toContain('private-unit-value');
    },
  );
  it('refuses silently unfiltered HTTP 200 before waves and retains the failed probe', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ ...response('合'), appliedFilter: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const report = await runSearchCapacity({
      runtime: runtime(),
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: false,
      apiContractValid: false,
      failureCode: 'CAPACITY_PREFLIGHT_INVALID',
      phases: [],
      preflight: [{ valid: false, sample: { status: 200, outcome: 'invalid_response' } }],
    });
  });
  it('preserves a completed first wave when drainage fails and masks unknown errors', async () => {
    vi.stubGlobal(
      'fetch',
      async (input: string) =>
        new Response(JSON.stringify(response(new URL(input).searchParams.get('keyword')!)), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    controls.drain
      .mockResolvedValueOnce({ drained: true })
      .mockResolvedValueOnce({ drained: false });
    const report = await runSearchCapacity({
      runtime: runtime(),
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: false,
      allRequestsSucceeded: false,
      failureCode: 'CAPACITY_DRAIN_FAILED',
      phases: [{ burst: { sent: 3, completed: 3 }, failureCode: 'CAPACITY_DRAIN_FAILED' }],
    });
    controls.login.mockRejectedValueOnce(new Error('PRIVATE_SYNTHETIC_SECRET'));
    const failed = await runSearchCapacity({
      runtime: runtime(),
      fixture,
      profile: getProfile('smoke'),
    });
    expect(failed.failureCode).toBe('CAPACITY_FAILED');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SYNTHETIC_SECRET');
  });
  it('keeps partial aborted arrivals and stops scheduling the next wave', async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.stubGlobal('fetch', async (input: string) => {
      if (++calls === 5) controller.abort();
      return new Response(JSON.stringify(response(new URL(input).searchParams.get('keyword')!)), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const report = await runSearchCapacity({
      runtime: runtime(),
      fixture,
      profile: getProfile('smoke'),
      signal: controller.signal,
    });
    expect(report).toMatchObject({
      completed: false,
      allRequestsSucceeded: false,
      failureCode: 'CAPACITY_ABORTED',
    });
    expect(report.phases).toHaveLength(1);
    expect(report.phases[0]!.burst).toMatchObject({
      planned: 3,
      sent: 1,
      completed: 1,
      unsent: 2,
      unfinished: 0,
      inFlight: 0,
    });
  });
  it('rejects a changed expected population without making HTTP requests', async () => {
    const rt = runtime();
    rt.readOnlyMock.mockImplementation(async (_context, callback) =>
      callback({
        proof,
        query: async (sql) => ({
          rows: sql.includes('role_binding')
            ? [{ code: 'agent' }]
            : sql.startsWith('SELECT number')
              ? [{ number: 'PERF041-0000001' }]
              : [{ total: 0 }],
        }),
      }),
    );
    const report = await runSearchCapacity({
      runtime: rt as SearchCapacityRuntime,
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: false,
      failureCode: 'CAPACITY_ORACLE_INVALID',
      loginCompleted: 0,
    });
    expect(controls.login).not.toHaveBeenCalled();
  });
});
