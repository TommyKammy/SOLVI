import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePoolSnapshot,
  poolDifference,
  runBurst,
  runListComparison,
  runDeadlineComparison,
  runSearchComparison,
  runSearchStateApiContract,
  validateSearchResponse,
  SEARCH_KEYWORD,
  SEARCH_LIST_PATH,
  validateDeadlineResponse,
  DEADLINE_LIST_PATH,
  verifySessions,
  MAX_COMPARISON_MS,
  type QueryClient,
} from '../../tools/performance/list-load.mjs';
import { getProfile } from '../../tools/performance/profiles.mjs';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type { RequestSample } from '../../tools/performance/workload.mjs';
import {
  TicketController,
  type TicketRouteDeps,
} from '../../services/api/src/modules/ticket/ticket.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deadlineStates = ['new', 'assigned', 'in_progress'];
const deadlineId = (index: number) => `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function deadlineItem(index: number, remainingSeconds: number | null, scope = 'organization') {
  return {
    id: deadlineId(index),
    number: `SYNTH-${index}`,
    kind: 'incident',
    state: 'new',
    subject: '合成の期限',
    body: '合成本文',
    impact: 'low',
    urgency: 'low',
    priority: 'low',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    assigned: false,
    sla: { remainingSeconds, breached: remainingSeconds !== null && remainingSeconds < 0 },
    ...(scope === 'organization'
      ? { assigneeName: null, requesterName: '合成', assigneeGroupName: null }
      : {}),
  };
}
function deadlineBody(total = 3, scope = 'organization', nullSla = false) {
  const items = Array.from({ length: Math.min(total, 50) }, (_, index) =>
    deadlineItem(index + 1, nullSla ? null : index === 0 ? -3.25 : index === 1 ? 0 : null, scope),
  );
  return {
    scope,
    total,
    items,
    appliedFilter: { state: [...deadlineStates] },
    nextCursor:
      items.length === 50
        ? { id: items.at(-1)!.id, createdAt: '2026-01-01 00:00:00.000001+00' }
        : null,
  };
}

const searchRows = Array.from({ length: 120 }, (_, index) => ({
  id: deadlineId(120 - index),
  cursor_created_at: '2026-01-01 00:00:00.123456+00',
}));
function searchBody(
  rows = searchRows,
  scope = 'organization',
  offset = 0,
  keyword = SEARCH_KEYWORD,
) {
  const page = rows.slice(offset, offset + 50);
  const last = page.at(-1);
  return {
    scope,
    total: rows.length,
    items: page.map((row, i) => ({
      ...deadlineItem(i + 1, null, scope),
      id: row.id,
      subject: SEARCH_KEYWORD,
    })),
    appliedFilter: { keyword },
    nextCursor: page.length === 50 ? { id: last!.id, createdAt: last!.cursor_created_at } : null,
  };
}
const expectedSearch = (data = searchBody()) => ({
  scope: data.scope as 'organization' | 'own',
  total: data.total,
  keyword: data.appliedFilter.keyword,
  ids: data.items.map((item) => item.id),
  cursor: data.nextCursor,
});
describe('WP046 exact search response oracle', () => {
  it('accepts exact first/next pages and raw microsecond cursor while rejecting truncation', () => {
    for (const offset of [0, 50, 100, 120]) {
      const body = searchBody(searchRows, 'organization', offset);
      expect(validateSearchResponse(body, expectedSearch(body))).toBe(true);
    }
    const data = searchBody();
    const expected = expectedSearch(data);
    data.nextCursor = { ...data.nextCursor!, createdAt: '2026-01-01T00:00:00.123Z' };
    expect(validateSearchResponse(data, expected)).toBe(false);
  });
  it.each([
    [
      'wrong total',
      (d: ReturnType<typeof searchBody>) => {
        d.total++;
      },
    ],
    [
      'wrong keyword',
      (d: ReturnType<typeof searchBody>) => {
        d.appliedFilter.keyword = 'different';
      },
    ],
    [
      'wrong order',
      (d: ReturnType<typeof searchBody>) => {
        d.items.reverse();
      },
    ],
    [
      'foreign row',
      (d: ReturnType<typeof searchBody>) => {
        d.items[0]!.id = deadlineId(999);
      },
    ],
    [
      'wrong scope',
      (d: ReturnType<typeof searchBody>) => {
        d.scope = 'own';
      },
    ],
    [
      'invalid SLA',
      (d: ReturnType<typeof searchBody>) => {
        d.items[0]!.sla.breached = true;
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const data = searchBody(),
      expected = expectedSearch(data);
    mutate(data);
    expect(validateSearchResponse(data, expected)).toBe(false);
  });
  it('requires own-scope redaction and handles exact zero independently of failures', () => {
    const own = searchBody(searchRows.slice(0, 2), 'own');
    expect(validateSearchResponse(own, expectedSearch(own))).toBe(true);
    Object.assign(own.items[0]!, { requesterName: 'should not be disclosed' });
    expect(validateSearchResponse(own, expectedSearch(own))).toBe(false);
    const empty = searchBody([]);
    expect(validateSearchResponse(empty, expectedSearch(empty))).toBe(true);
    expect(validateSearchResponse({ status: 500 }, expectedSearch(empty))).toBe(false);
    const impossible = searchBody(searchRows.slice(0, 2));
    impossible.total = 0;
    expect(validateSearchResponse(impossible, expectedSearch(impossible))).toBe(false);
  });
});

describe('WP044 per-response deadline contract', () => {
  it('accepts fractional SLA, zero and NULL last without assuming a shared cross-request clock', () => {
    expect(validateDeadlineResponse(deadlineBody(), { scope: 'organization', total: 3 })).toBe(
      true,
    );
    const later = deadlineBody();
    later.items[0]!.sla.remainingSeconds = -4.5;
    later.items[1]!.sla = { remainingSeconds: -1.25, breached: true };
    expect(validateDeadlineResponse(later, { scope: 'organization', total: 3 })).toBe(true);
  });
  it.each([
    [
      'SLA omitted',
      (data: ReturnType<typeof deadlineBody>) => {
        Object.assign(data.items[0]!, { sla: undefined });
      },
    ],
    [
      'SLA string',
      (data: ReturnType<typeof deadlineBody>) => {
        Object.assign(data.items[0]!.sla, { remainingSeconds: '-3' });
      },
    ],
    [
      'NaN SLA',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items[0]!.sla.remainingSeconds = NaN;
      },
    ],
    [
      'incorrect breach',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items[1]!.sla.breached = true;
      },
    ],
    [
      'NULL before known',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items.reverse();
      },
    ],
    [
      'equal SLA wrong ID order',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items[0]!.sla = { remainingSeconds: 0, breached: false };
        data.items[0]!.id = deadlineId(9);
      },
    ],
    [
      'duplicate ID',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items[1]!.id = data.items[0]!.id;
      },
    ],
    [
      'wrong total',
      (data: ReturnType<typeof deadlineBody>) => {
        data.total = 4;
      },
    ],
    [
      'missing row',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items.pop();
      },
    ],
    [
      'wrong state',
      (data: ReturnType<typeof deadlineBody>) => {
        data.items[0]!.state = 'pending';
      },
    ],
    [
      'wrong filter',
      (data: ReturnType<typeof deadlineBody>) => {
        data.appliedFilter.state.pop();
      },
    ],
    [
      'wrong scope',
      (data: ReturnType<typeof deadlineBody>) => {
        data.scope = 'own';
      },
    ],
    [
      'missing staff display field',
      (data: ReturnType<typeof deadlineBody>) => {
        Object.assign(data.items[0]!, { assigneeName: undefined });
      },
    ],
  ] as const)('rejects %s', (_label, mutate) => {
    const data = deadlineBody();
    mutate(data);
    expect(validateDeadlineResponse(data, { scope: 'organization', total: 3 })).toBe(false);
  });
  it('requires the raw created-at cursor to identify the last row when a complete page exists', () => {
    const data = deadlineBody(120);
    expect(validateDeadlineResponse(data, { scope: 'organization', total: 120 })).toBe(true);
    data.nextCursor!.id = deadlineId(1);
    expect(validateDeadlineResponse(data, { scope: 'organization', total: 120 })).toBe(false);
  });
  it('checks requester membership and prevents staff-only display fields in own-scope responses', () => {
    const data = deadlineBody(2, 'own');
    const allowedIds = new Set([deadlineId(1), deadlineId(2)]);
    expect(validateDeadlineResponse(data, { scope: 'own', total: 2, allowedIds })).toBe(true);
    allowedIds.delete(deadlineId(2));
    expect(validateDeadlineResponse(data, { scope: 'own', total: 2, allowedIds })).toBe(false);
    Object.assign(data.items[0]!, { requesterName: 'must-not-leak' });
    expect(validateDeadlineResponse(data, { scope: 'own', total: 2 })).toBe(false);
  });
  it('treats policy absence as NULL with breached=false and validates genuine empty responses', () => {
    expect(
      validateDeadlineResponse(deadlineBody(2, 'organization', true), {
        scope: 'organization',
        total: 2,
        nullSla: true,
      }),
    ).toBe(true);
    expect(
      validateDeadlineResponse(deadlineBody(2), { scope: 'organization', total: 2, nullSla: true }),
    ).toBe(false);
    expect(validateDeadlineResponse(deadlineBody(0), { scope: 'organization', total: 0 })).toBe(
      true,
    );
  });
});

function exposition(success = 10, failure = 0, suffix = '', waiting = 0, inUse = 0) {
  const family = `solvi_db_pool_acquire_duration${suffix}`;
  return [
    `solvi_db_pool_connections_total 5`,
    `solvi_db_pool_connections_idle ${5 - inUse}`,
    `solvi_db_pool_connections_waiting ${waiting}`,
    ...(['success', 'failure'] as const).flatMap((outcome) => {
      const count = outcome === 'success' ? success : failure;
      if (outcome === 'failure' && count === 0) return [];
      return [
        `${family}_count{outcome="${outcome}"} ${count}`,
        `${family}_sum{outcome="${outcome}"} ${count * 4}`,
        `${family}_bucket{outcome="${outcome}",le="5"} ${count}`,
        `${family}_bucket{outcome="${outcome}",le="+Inf"} ${count}`,
      ];
    }),
  ].join('\n');
}

const sample = (overrides: Partial<RequestSample> = {}): RequestSample => ({
  route: 'api-ops-list',
  kind: 'api',
  status: 200,
  outcome: 'success',
  durationMs: 15,
  bytes: 100,
  ...overrides,
});
const fixture: PerformanceFixture = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  controlOrganizationId: '10000000-0000-4000-8000-000000000002',
  controlTicketId: '20000000-0000-4000-8000-000000000002',
  catalogItemId: '30000000-0000-4000-8000-000000000001',
  serviceRequestId: '40000000-0000-4000-8000-000000000001',
  counts: {
    users: 120,
    tickets: 2400,
    usersByStatus: [],
    roles: [],
    states: [],
    priorities: [],
    assignment: [],
    groups: 2,
    memberships: 10,
    comments: 10,
    catalog: 1,
    approvals: 1,
    credentials: 12,
    readReceipts: 1,
    attachments: 1,
    controlUsers: 1,
    controlTickets: 1,
  },
  actors: [
    {
      userId: '10000000-0000-4000-8000-000000000003',
      email: 'synthetic@example.test',
      password: 'not-a-real-password',
      role: 'agent',
      ticketId: '20000000-0000-4000-8000-000000000001',
      ticketSubject: '合成問い合わせ',
    },
  ],
};

describe('WP046 public ticket search query parameter', () => {
  it('passes keyword through the real controller into appliedFilter and the combined search SQL', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.includes('AS __solvi_total')
        ? [{ id: null, cursor_created_at: null, __solvi_total: 0 }]
        : sql.startsWith('SELECT count(*)::int AS total')
          ? [{ total: 0 }]
          : [],
    }));
    const release = vi.fn();
    const denialRecord = vi.fn();
    const controller = new TicketController({
      pool: { connect: async () => ({ query, release }) },
      denialRecorder: { record: denialRecord },
    } as unknown as TicketRouteDeps);
    const auth: AuthenticatedRequest = {
      sessionId: '10000000-0000-4000-8000-000000000004',
      userId: fixture.actors[0]!.userId,
      authz: {
        organizationId: fixture.organizationId,
        principal: {
          userId: fixture.actors[0]!.userId,
          status: 'active',
          bindings: [
            {
              roleCode: 'agent',
              organizationId: fixture.organizationId,
              validFrom: new Date(0),
              validUntil: null,
            },
          ],
        },
      },
    };
    const params = new URL(SEARCH_LIST_PATH, 'http://127.0.0.1').searchParams;
    // Public HTTP contract: this assertion must not infer the parameter from a mock.
    expect(params.get('keyword')).toBe('合成性能問い合わせ 1');
    expect(params.has('q')).toBe(false);
    const response = await controller.list(auth, params);
    expect(response.body.appliedFilter).toEqual({ keyword: '合成性能問い合わせ 1' });
    expect(response.body.scope).toBe('organization');
    expect(response.body.items).toEqual([]);
    expect(response.body.total).toBe(0);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body).not.toHaveProperty('__solvi_total');
    const searches = query.mock.calls.filter(([sql]) => sql.includes('t.search_text ILIKE $2'));
    expect(searches).toHaveLength(1);
    expect(searches[0]![0]).toContain('AS __solvi_total');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('SELECT count(*)::int AS total'))).toBe(
      false,
    );
    for (const [, values] of searches) {
      expect(values?.slice(0, 2)).toEqual([fixture.organizationId, '%合成性能問い合わせ 1%']);
    }
    expect(denialRecord).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();

    // The historical diagnostic typo is silently unfiltered by this API, not an alias.
    query.mockClear();
    const ignored = await controller.list(auth, new URLSearchParams({ q: '合成性能問い合わせ 1' }));
    expect(ignored.body.appliedFilter).toEqual({});
    expect(query.mock.calls.some(([sql]) => sql.includes('t.search_text ILIKE'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('AS __solvi_total'))).toBe(false);
    expect(
      query.mock.calls.filter(([sql]) => sql.startsWith('SELECT count(*)::int AS total')),
    ).toHaveLength(1);

    // WP049 uses the existing repeated state parameter, with newest/DESC only on HTTP.
    for (const states of [['new'], ['new', 'assigned'], ['new', 'new']]) {
      query.mockClear();
      const actual = new URLSearchParams({ keyword: '合', sort: 'newest', limit: '50' });
      for (const state of states) actual.append('state', state);
      const stateResponse = await controller.list(auth, actual);
      expect(stateResponse.body.appliedFilter).toEqual({ keyword: '合', state: states });
      expect(stateResponse.body.total).toBe(0);
      const sql = query.mock.calls.find(([value]) => value.includes('AS __solvi_total'));
      expect(sql?.[1]).toContainEqual(states);
      expect(sql?.[1]).toContain('%合%');
    }
    query.mockClear();
    await expect(
      controller.list(auth, new URLSearchParams({ keyword: '合', state: 'new', sort: 'asc' })),
    ).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('WP042 fixed arrival schedule', () => {
  it('launches all 100 planned requests before any response completes', async () => {
    const release: Array<(value: RequestSample) => void> = [];
    let now = 0;
    const running = runBurst({
      count: 100,
      signal: new AbortController().signal,
      now: () => now++,
      send: () => new Promise((resolve) => release.push(resolve)),
    });
    expect(release).toHaveLength(100);
    for (const resolve of release) resolve(sample());
    const report = await running;
    expect(report).toMatchObject({
      planned: 100,
      sent: 100,
      completed: 100,
      unsent: 0,
      unfinished: 0,
      maxInFlight: 100,
      inFlight: 0,
      statusCounts: { 200: 100 },
      bytes: 10_000,
    });
    expect(
      report.timing.every((item) => item.plannedAtMs === 0 && item.completedAtMs !== null),
    ).toBe(true);
    expect(report.latenessMs.max).toBe(100);
  });
  it('retains status failures, timeout bytes and successful-only latency', async () => {
    const responses = [
      sample(),
      sample({ status: 500, outcome: 'http_error', durationMs: 200 }),
      sample({ status: null, outcome: 'timeout', durationMs: 1000, bytes: 7 }),
    ];
    const report = await runBurst({
      count: 3,
      signal: new AbortController().signal,
      send: async (i) => responses[i]!,
    });
    expect(report).toMatchObject({
      successes: 1,
      failures: 1,
      unsuccessful: 2,
      timeouts: 1,
      statusCounts: { 200: 1, 500: 1, no_response: 1 },
      bytes: 207,
      successfulLatencyMs: { p95: 15 },
    });
  });
  it('records unsent work if interrupted while dispatching without reducing planned work', async () => {
    const controller = new AbortController();
    const report = await runBurst({
      count: 100,
      signal: controller.signal,
      send: async (index) => {
        if (index === 2) controller.abort();
        return sample();
      },
    });
    expect(report).toMatchObject({ planned: 100, sent: 3, completed: 3, unsent: 97, inFlight: 0 });
  });
  it('does not expose thrown transport errors and still accounts for completion', async () => {
    const report = await runBurst({
      count: 1,
      signal: new AbortController().signal,
      send: async () => {
        throw new Error('credential-secret-body');
      },
    });
    expect(report).toMatchObject({ completed: 1, failures: 1, statusCounts: { no_response: 1 } });
    expect(JSON.stringify(report)).not.toContain('credential-secret-body');
  });
});

describe('pool phase windows', () => {
  it.each(['', '_milliseconds'])(
    'parses actual exporter histogram suffix %s without copying labels',
    (suffix) => {
      const report = parsePoolSnapshot(
        exposition(10, 0, suffix, 3, 2) + '\nsecret_metric{token="do-not-record"} 1',
      );
      expect(report).toMatchObject({
        valid: true,
        connections: { total: 5, idle: 3, inUse: 2, waiting: 3 },
        acquisitions: { success: { count: 10, sumMs: 40 }, failure: { count: 0 } },
      });
      expect(JSON.stringify(report)).not.toContain('do-not-record');
    },
  );
  it('requires all gauges and a coherent histogram', () => {
    expect(
      parsePoolSnapshot(exposition().replace('solvi_db_pool_connections_idle 5\n', '')).valid,
    ).toBe(false);
    expect(parsePoolSnapshot(exposition().replace('le="+Inf"} 10', 'le="+Inf"} 9')).valid).toBe(
      false,
    );
    expect(
      parsePoolSnapshot(
        exposition().replace(
          'duration_sum{outcome="success"} 40',
          'duration_sum{outcome="success"} NaN',
        ),
      ).valid,
    ).toBe(false);
  });
  it('differences both success and newly appearing failure buckets', () => {
    const delta = poolDifference(
      parsePoolSnapshot(exposition(10)),
      parsePoolSnapshot(exposition(14, 3)),
    );
    expect(delta).toMatchObject({
      valid: true,
      success: {
        count: 4,
        sumMs: 16,
        buckets: [
          { le: '5', count: 4 },
          { le: '+Inf', count: 4 },
        ],
      },
      failure: { count: 3, sumMs: 12 },
    });
  });
  it('rejects counter resets rather than misreporting a negative acquisition cost', () => {
    expect(
      poolDifference(parsePoolSnapshot(exposition(10, 3)), parsePoolSnapshot(exposition(8))).valid,
    ).toBe(false);
  });
});

describe('real-login session cardinality validation', () => {
  it('checks only supplied token hashes, one matching principal and active organization', async () => {
    const query = vi.fn<QueryClient['query']>().mockResolvedValue({
      rows: [{ sessions: 2, distinct_sessions: 2, principals: 1, active_matching: 2 }],
    });
    const report = await verifySessions(
      { query },
      fixture.actors[0]!,
      fixture,
      ['solvi_session=firsttoken', 'solvi_session=secondtoken'],
      new AbortController().signal,
    );
    expect(report).toMatchObject({
      verified: true,
      expected: 2,
      principals: 1,
      distinctSessions: 2,
    });
    const config = query.mock.calls[0]![0];
    expect(config.query_timeout).toBe(2000);
    expect(config.values[0]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
    );
    expect(JSON.stringify(config.values)).not.toContain('firsttoken');
    expect(JSON.stringify(report)).not.toContain(fixture.actors[0]!.userId);
  });
  it.each([
    { sessions: 2, distinct_sessions: 2, principals: 2, active_matching: 2 },
    { sessions: 2, distinct_sessions: 1, principals: 1, active_matching: 2 },
    { sessions: 2, distinct_sessions: 2, principals: 1, active_matching: 1 },
  ])('rejects wrong principal, duplicate rows, or revoked/mismatched sessions', async (row) => {
    const result = await verifySessions(
      { query: async () => ({ rows: [row] }) },
      fixture.actors[0]!,
      fixture,
      ['solvi_session=one', 'solvi_session=two'],
      new AbortController().signal,
    );
    expect(result.verified).toBe(false);
  });
  it('rejects reused cookies before querying', async () => {
    const query = vi.fn();
    await expect(
      verifySessions(
        { query },
        fixture.actors[0]!,
        fixture,
        ['solvi_session=same', 'solvi_session=same'],
        new AbortController().signal,
      ),
    ).rejects.toThrow('LIST_SESSIONS_NOT_DISTINCT');
    expect(query).not.toHaveBeenCalled();
  });
});

function simulatedRuntime(status: number | 'timeout', controller?: AbortController) {
  let logins = 0;
  let acquisitions = 10;
  const received: string[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/auth/login')) {
      logins += 1;
      if (controller && logins === 2) controller.abort();
      return Response.json(
        { userId: fixture.actors[0]!.userId, organizationId: fixture.organizationId },
        { headers: { 'set-cookie': `solvi_session=synthetictoken${logins}; HttpOnly` } },
      );
    }
    if (input.endsWith('/metrics')) return new Response(exposition(acquisitions));
    if (input.endsWith('/tickets?limit=50')) {
      acquisitions += 1;
      received.push(new Headers(init?.headers).get('cookie') ?? '');
      if (status === 'timeout') {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Response.json(
        status === 200
          ? {
              total: fixture.counts.tickets,
              scope: 'organization',
              items: [
                {
                  id: fixture.actors[0]!.ticketId,
                  subject: '合成',
                  state: 'new',
                  kind: 'incident',
                },
              ],
            }
          : { secret: 'raw-error-forbidden' },
        { status },
      );
    }
    throw new Error('UNEXPECTED_FIXTURE_URL');
  });
  vi.stubGlobal('fetch', fetchMock);
  const admin: QueryClient = {
    query: async ({ text }) => ({
      rows: [
        text.includes('token_hash=ANY')
          ? { sessions: 12, distinct_sessions: 12, principals: 1, active_matching: 12 }
          : { connections: 5, active: 0, idle_in_transaction: 0, lock_waiting: 0 },
      ],
    }),
  };
  return {
    runtime: { apiBase: 'http://127.0.0.1:3001', metricsBase: 'http://127.0.0.1:9464', admin },
    fetchMock,
    received,
  };
}

describe('comparison report preserves measured failures separately from harness completion', () => {
  it.each([200, 500, 'timeout'] as const)(
    'runs the same 12-arrival ABBA schedule for outcome %s',
    async (status) => {
      const { runtime, received } = simulatedRuntime(status);
      const report = await runListComparison({
        runtime,
        fixture,
        profile: { ...getProfile('smoke'), requestTimeoutMs: 100 },
      });
      expect(report.failureCode).toBeUndefined();
      expect(report).toMatchObject({
        comparisonCompleted: true,
        allRequestsSucceeded: status === 200,
        loginCompleted: 12,
        schedule: ['A', 'B', 'B', 'A'],
        requestsPerPhase: 12,
      });
      expect(report.phases).toHaveLength(4);
      if (status === 'timeout')
        expect(
          report.phases.every(
            (phase) => phase.burst?.timeouts === 12 && phase.burst.unsuccessful === 12,
          ),
        ).toBe(true);
      expect(
        report.phases.every(
          (phase) =>
            phase.burst?.sent === 12 &&
            phase.burst.completed === 12 &&
            phase.observationValid &&
            phase.poolDelta?.success.count === 12,
        ),
      ).toBe(true);
      for (const [index, mode] of ['A', 'B', 'B', 'A'].entries())
        expect(new Set(received.slice(index * 12, (index + 1) * 12)).size).toBe(
          mode === 'A' ? 1 : 12,
        );
      expect(JSON.stringify(report)).not.toMatch(
        /synthetictoken|raw-error-forbidden|synthetic@example|not-a-real-password/,
      );
      expect(
        report.phases[0]?.observations?.pool.every((point) => !('acquisitions' in point)),
      ).toBe(true);
    },
    10_000,
  );
  it('retains partial login progress when interrupted without sending workload requests', async () => {
    const controller = new AbortController();
    const { runtime, received } = simulatedRuntime(200, controller);
    const report = await runListComparison({
      runtime,
      fixture,
      profile: getProfile('smoke'),
      signal: controller.signal,
    });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      allRequestsSucceeded: false,
      loginCompleted: 2,
      failureCode: 'LIST_ABORTED',
      phases: [],
    });
    expect(received).toHaveLength(0);
  });
  it('enforces the overall hard cap during drain and keeps safe partial progress', async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
      originalTimeout(ms === MAX_COMPARISON_MS ? 20 : ms),
    );
    const { runtime, received } = simulatedRuntime(200);
    const report = await runListComparison({ runtime, fixture, profile: getProfile('smoke') });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      allRequestsSucceeded: false,
      failureCode: 'LIST_HARD_CAP',
      loginCompleted: 12,
    });
    expect(received).toHaveLength(0);
  });
  it('refuses to start any phase when DB session verification contradicts login responses', async () => {
    const { runtime, received } = simulatedRuntime(200);
    runtime.admin = {
      query: async () => ({
        rows: [{ sessions: 12, distinct_sessions: 12, principals: 2, active_matching: 12 }],
      }),
    };
    const report = await runListComparison({ runtime, fixture, profile: getProfile('smoke') });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      allRequestsSucceeded: false,
      failureCode: 'LIST_SESSION_CARDINALITY_INVALID',
      sessionVerification: { verified: false },
      phases: [],
    });
    expect(received).toHaveLength(0);
  });
});

function simulatedDeadlineRuntime(
  status: 200 | 500,
  ownLeak = false,
  profileName: 'smoke' | 'growth' = 'smoke',
) {
  const profile = getProfile(profileName);
  const deadlineFixture: PerformanceFixture = {
    ...fixture,
    counts: {
      ...fixture.counts,
      users: profile.users,
      tickets: profile.tickets,
      states: [{ state: 'new', n: profile.tickets }],
    },
    actors: [
      fixture.actors[0]!,
      ...(['requester', 'admin'] as const).map((role, index) => ({
        ...fixture.actors[0]!,
        role,
        email: `${role}@example.test`,
        userId: deadlineId(100 + index),
      })),
    ],
  };
  let logins = 0;
  let acquisitions = 10;
  const phaseCookies: string[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/auth/login')) {
      logins++;
      const credentials = JSON.parse(String(init?.body)) as { email: string };
      const actor = deadlineFixture.actors.find((item) => item.email === credentials.email)!;
      return Response.json(
        { userId: actor.userId, organizationId: fixture.organizationId },
        {
          headers: { 'set-cookie': `solvi_session=deadline${actor.role}${logins}; HttpOnly` },
        },
      );
    }
    if (input.endsWith('/metrics')) return new Response(exposition(acquisitions));
    const url = new URL(input);
    if (url.pathname !== '/tickets') throw new Error('UNEXPECTED_FIXTURE_URL');
    expect(url.searchParams.get('sort')).toBe('deadline');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.getAll('state')).toEqual(deadlineStates);
    acquisitions++;
    const cookie = new Headers(init?.headers).get('cookie') ?? '';
    if (!cookie) return Response.json({ status: 401 }, { status: 401 });
    if (url.searchParams.has('cursorId')) return Response.json({ status: 400 }, { status: 400 });
    if (url.searchParams.has('group')) return Response.json(deadlineBody(0));
    if (url.searchParams.has('priority'))
      return Response.json(deadlineBody(2, 'organization', true));
    if (cookie.includes('requester')) {
      const data = deadlineBody(2, 'own');
      if (ownLeak) data.items[1]!.id = deadlineId(999);
      return Response.json(data);
    }
    if (cookie.includes('admin')) return Response.json(deadlineBody(profile.tickets));
    phaseCookies.push(cookie);
    return status === 200
      ? Response.json(deadlineBody(profile.tickets))
      : Response.json({ secret: 'forbidden-error-body' }, { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  const admin: QueryClient = {
    query: async ({ text }) => {
      if (text.includes('token_hash=ANY'))
        return {
          rows: [
            {
              sessions: profile.activeSessions,
              distinct_sessions: profile.activeSessions,
              principals: 1,
              active_matching: profile.activeSessions,
            },
          ],
        };
      if (text.includes('requester_id=$2'))
        return { rows: [{ id: deadlineId(1) }, { id: deadlineId(2) }] };
      if (text.includes('FROM assignment_group')) return { rows: [{ id: deadlineId(99) }] };
      if (text.includes("priority='critical'")) return { rows: [{ total: 2 }] };
      return { rows: [{ connections: 5, active: 0, idle_in_transaction: 0, lock_waiting: 0 }] };
    },
  };
  return {
    deadlineFixture,
    runtime: { apiBase: 'http://127.0.0.1:3001', metricsBase: 'http://127.0.0.1:9464', admin },
    phaseCookies,
  };
}

function simulatedSearchRuntime(
  status: 200 | 500,
  ownLeak = false,
  profileName: 'smoke' | 'growth' = 'smoke',
) {
  const profile = getProfile(profileName);
  const searchFixture: PerformanceFixture = {
    ...fixture,
    actors: [
      fixture.actors[0]!,
      ...(['requester', 'admin'] as const).map((role, index) => ({
        ...fixture.actors[0]!,
        role,
        email: `${role}@example.test`,
        userId: deadlineId(1000 + index),
      })),
    ],
  };
  let logins = 0,
    acquisitions = 10;
  const phaseCookies: string[] = [];
  const ownRows = searchRows.slice(0, 2);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/auth/login')) {
        logins++;
        const credentials = JSON.parse(String(init?.body)) as { email: string };
        const actor = searchFixture.actors.find((item) => item.email === credentials.email)!;
        return Response.json(
          { userId: actor.userId, organizationId: fixture.organizationId },
          {
            headers: { 'set-cookie': `solvi_session=search${actor.role}${logins}; HttpOnly` },
          },
        );
      }
      if (input.endsWith('/metrics')) return new Response(exposition(acquisitions));
      const url = new URL(input);
      expect(url.pathname).toBe('/tickets');
      expect(url.searchParams.get('limit')).toBe('50');
      acquisitions++;
      const cookie = new Headers(init?.headers).get('cookie') ?? '';
      if (!cookie) return Response.json({ status: 401 }, { status: 401 });
      if (url.searchParams.get('sort') === 'unsupported')
        return Response.json({ status: 400 }, { status: 400 });
      expect(url.searchParams.get('sort')).toBe('newest');
      if (url.searchParams.get('keyword') === 'isolated-missing-search-046')
        return Response.json(searchBody([], 'organization', 0, 'isolated-missing-search-046'));
      expect(url.searchParams.get('keyword')).toBe(SEARCH_KEYWORD);
      if (url.searchParams.has('group')) return Response.json(searchBody([]));
      if (url.searchParams.has('cursorId')) {
        expect(url.searchParams.get('cursorCreatedAt')).toBe('2026-01-01 00:00:00.123456+00');
        expect(url.searchParams.get('cursorId')).toBe(searchRows[49]!.id);
        return Response.json(searchBody(searchRows, 'organization', 50));
      }
      if (cookie.includes('requester')) {
        const data = searchBody(ownRows, 'own');
        if (ownLeak) data.items[0]!.id = deadlineId(999);
        return Response.json(data);
      }
      if (cookie.includes('admin')) return Response.json(searchBody());
      phaseCookies.push(cookie);
      return status === 200
        ? Response.json(searchBody())
        : Response.json({ secret: 'PRIVATE_FAILURE' }, { status });
    }),
  );
  const admin: QueryClient = {
    query: async ({ text, values }) => {
      if (text.includes('token_hash=ANY'))
        return {
          rows: [
            {
              sessions: profile.activeSessions,
              distinct_sessions: profile.activeSessions,
              principals: 1,
              active_matching: profile.activeSessions,
            },
          ],
        };
      if (text.includes('search_text ILIKE')) {
        expect(values[0]).toBe(fixture.organizationId);
        expect(values[1]).toBe(`%${SEARCH_KEYWORD}%`);
        return { rows: values[2] ? ownRows : searchRows };
      }
      if (text.includes('FROM assignment_group')) return { rows: [{ id: deadlineId(999) }] };
      return { rows: [{ connections: 5, active: 0, idle_in_transaction: 0, lock_waiting: 0 }] };
    },
  };
  return {
    runtime: { apiBase: 'http://127.0.0.1:3001', metricsBase: 'http://127.0.0.1:9464', admin },
    searchFixture,
    phaseCookies,
  };
}

function simulatedStateRuntime(fault = '', controller?: AbortController) {
  const { runtime: base, searchFixture } = simulatedSearchRuntime(200);
  const priorFetch = fetch;
  const stateRows = searchRows.slice(0, 80);
  const stateCalls: URL[] = [];
  const runtime = { ...base, meta: { workPackage: 'WP-P2-PERF-049' } };
  runtime.admin = {
    query: async (config) => {
      if (!config.text.includes('state=ANY($4')) return base.admin.query(config);
      expect(config.values[0]).toBe(fixture.organizationId);
      expect(config.values[3]).toEqual(expect.arrayContaining(['new']));
      expect(config.query_timeout).toBe(2000);
      if (fault === 'oracle') throw new Error('LIST_PRIVATE_SECRET');
      return {
        rows:
          config.values[1] === '%isolated-missing-state-049%'
            ? []
            : config.values[2]
              ? stateRows.slice(0, 2)
              : (config.values[3] as string[]).includes('assigned')
                ? searchRows
                : stateRows,
      };
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const states = url.searchParams.getAll('state');
      if (!states.length) {
        if (fault === 'drain' && input.endsWith('/metrics'))
          return new Response('PRIVATE_BAD_METRICS');
        return priorFetch(input, init);
      }
      stateCalls.push(url);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.has('q')).toBe(false);
      const cookie = new Headers(init?.headers).get('cookie') ?? '';
      if (!cookie) return Response.json({ status: 401 }, { status: 401 });
      if (url.searchParams.get('sort') === 'asc' || states.includes('invalid'))
        return Response.json({ status: 400 }, { status: 400 });
      expect(url.searchParams.get('sort')).toBe('newest');
      const keyword = url.searchParams.get('keyword')!;
      expect(['合', 'isolated-missing-state-049']).toContain(keyword);
      const own = cookie.includes('requester');
      let rows = own ? stateRows.slice(0, 2) : states.includes('assigned') ? searchRows : stateRows;
      if (
        keyword === 'isolated-missing-state-049' ||
        url.searchParams.has('group') ||
        (own && url.searchParams.has('requester'))
      )
        rows = [];
      const cursorId = url.searchParams.get('cursorId');
      const offset = cursorId ? rows.findIndex((row) => row.id === cursorId) + 1 : 0;
      if (cursorId)
        expect(url.searchParams.get('cursorCreatedAt')).toBe('2026-01-01 00:00:00.123456+00');
      const data = {
        ...searchBody(rows, own ? 'own' : 'organization', offset, keyword),
        appliedFilter: { keyword, state: states },
      };
      if (fault === 'filter') data.appliedFilter.state = [];
      if (fault === 'item' && data.items.length) data.items[0]!.state = 'pending';
      if (fault === 'cursor' && data.nextCursor)
        data.nextCursor.createdAt = '2026-01-01T00:00:00.123Z';
      if (fault === 'own' && own && data.items.length) data.items[0]!.id = deadlineId(999);
      if (fault === 'foreign' && url.searchParams.has('group')) data.total = 1;
      if (fault === 'empty' && cursorId === stateRows.at(-1)!.id) data.total = 0;
      if (fault === 'http') return Response.json({ secret: 'PRIVATE_FAILURE' }, { status: 500 });
      if (fault === 'abort') controller?.abort();
      return Response.json(data);
    }),
  );
  return { runtime, searchFixture, stateCalls };
}

describe('WP049 sequential state API correctness contract', () => {
  it('checks public state/keyword routes, complete counts, precise next/terminal cursors and authorization without waves', async () => {
    const { runtime, searchFixture, stateCalls } = simulatedStateRuntime();
    const report = await runSearchStateApiContract({
      runtime,
      fixture: searchFixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: true,
      valid: true,
      capacityMeasured: false,
      population: { organizationState: 80, requesterState: 2, multiState: 120, empty: 0 },
      drain: { drained: true },
    });
    expect(report.cases).toHaveLength(20);
    expect(stateCalls).toHaveLength(13);
    expect(report.cases.every((item) => item.valid)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /searchagent|searchrequester|searchadmin|example\.test|PRIVATE_|70000000-0000|SELECT|ILIKE/,
    );
  });
  it.each(['filter', 'item', 'cursor', 'own', 'foreign', 'empty', 'http'])(
    'rejects %s corruption while retaining observations',
    async (fault) => {
      const { runtime, searchFixture } = simulatedStateRuntime(fault);
      const report = await runSearchStateApiContract({
        runtime,
        fixture: searchFixture,
        profile: getProfile('smoke'),
      });
      expect(report.completed).toBe(true);
      expect(report.valid).toBe(false);
      expect(report.capacityMeasured).toBe(false);
      expect(report.cases).toHaveLength(20);
      expect(report.cases.some((item) => !item.valid)).toBe(true);
      expect(JSON.stringify(report)).not.toContain('PRIVATE_FAILURE');
    },
  );
  it('rejects other work packages before queries or authentication', async () => {
    const { runtime, searchFixture, stateCalls } = simulatedStateRuntime();
    runtime.meta.workPackage = 'WP-P2-PERF-048';
    const query = vi.spyOn(runtime.admin, 'query');
    const report = await runSearchStateApiContract({
      runtime,
      fixture: searchFixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: false,
      valid: false,
      failureCode: 'LIST_STATE_WORK_PACKAGE_INVALID',
    });
    expect(query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(stateCalls).toHaveLength(0);
  });
  it.each(['oracle', 'drain', 'abort'])(
    'preserves partial proof and safe failure on %s',
    async (fault) => {
      const controller = new AbortController();
      const { runtime, searchFixture } = simulatedStateRuntime(fault, controller);
      const report = await runSearchStateApiContract({
        runtime,
        fixture: searchFixture,
        profile: getProfile('smoke'),
        signal: controller.signal,
      });
      expect(report.completed).toBe(false);
      expect(report.valid).toBe(false);
      expect(report.cases.length).toBeGreaterThanOrEqual(7);
      expect(report.failureCode).toBe(
        fault === 'abort'
          ? 'LIST_ABORTED'
          : fault === 'drain'
            ? 'LIST_POOL_INVALID'
            : 'LIST_STATE_PROBES_FAILED',
      );
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|70000000-0000|SELECT|ILIKE/);
    },
  );
});

describe('WP046 fixed search burst and API probes', () => {
  it.each([200, 500] as const)(
    'preserves HTTP %s separately from valid controlled comparison',
    async (status) => {
      const { runtime, searchFixture, phaseCookies } = simulatedSearchRuntime(status);
      const report = await runSearchComparison({
        runtime,
        fixture: searchFixture,
        profile: getProfile('smoke'),
      });
      expect(report).toMatchObject({
        comparisonCompleted: true,
        allRequestsSucceeded: status === 200,
        route: { key: 'api-search-list', path: SEARCH_LIST_PATH },
        schedule: ['A', 'B', 'B', 'A'],
        searchContract: { keyword: SEARCH_KEYWORD, total: 120, limit: 50 },
        sessionVerification: { verified: true, principals: 1, distinctSessions: 12 },
        apiContractValid: true,
        probeDrain: { drained: true },
      });
      expect(report.apiProbes?.cases).toHaveLength(7);
      expect(report.phases.every((p) => p.burst?.sent === 12 && p.burst.unfinished === 0)).toBe(
        true,
      );
      expect(new Set(phaseCookies.slice(0, 12)).size).toBe(1);
      expect(new Set(phaseCookies.slice(12, 24)).size).toBe(12);
      expect(JSON.stringify(report)).not.toMatch(
        /searchagent|searchrequester|searchadmin|example\.test|PRIVATE_FAILURE|70000000-0000/,
      );
    },
  );
  it('requires 100 actual distinct sessions in the growth contrast', async () => {
    const { runtime, searchFixture, phaseCookies } = simulatedSearchRuntime(200, false, 'growth');
    const report = await runSearchComparison({
      runtime,
      fixture: searchFixture,
      profile: getProfile('growth'),
    });
    expect(report.comparisonCompleted).toBe(true);
    expect(report.schedule).toEqual(['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A']);
    expect(report.sessionVerification?.distinctSessions).toBe(100);
    expect(phaseCookies).toHaveLength(800);
    expect(new Set(phaseCookies.slice(100, 200)).size).toBe(100);
  });
  it('fails the API contract on a requester leak while preserving completed observations', async () => {
    const { runtime, searchFixture } = simulatedSearchRuntime(200, true);
    const report = await runSearchComparison({
      runtime,
      fixture: searchFixture,
      profile: getProfile('smoke'),
    });
    expect(report.comparisonCompleted).toBe(true);
    expect(report.apiContractValid).toBe(false);
    expect(report.apiProbes?.cases.find((p) => p.key === 'search-requester-own')?.valid).toBe(
      false,
    );
  });
  it('rejects a missing oracle and masks even uppercase driver details before login', async () => {
    const { runtime, searchFixture, phaseCookies } = simulatedSearchRuntime(200);
    runtime.admin.query = async () => {
      throw new Error('LIST_PRIVATE_SECRET');
    };
    const report = await runSearchComparison({
      runtime,
      fixture: searchFixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      failureCode: 'LIST_COMPARISON_FAILED',
      loginCompleted: 0,
    });
    expect(phaseCookies).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SECRET');
  });
});

describe('WP044 fixed deadline burst and separate API probes', () => {
  it('preserves eight fixed 100-arrival phases and 100 distinct real-login cookies in the growth profile', async () => {
    const { runtime, deadlineFixture, phaseCookies } = simulatedDeadlineRuntime(
      200,
      false,
      'growth',
    );
    const report = await runDeadlineComparison({
      runtime,
      fixture: deadlineFixture,
      profile: getProfile('growth'),
    });
    expect(report).toMatchObject({
      comparisonCompleted: true,
      allRequestsSucceeded: true,
      apiContractValid: true,
      requestsPerPhase: 100,
      loginCompleted: 100,
      sessionVerification: { verified: true, distinctSessions: 100, principals: 1 },
      schedule: ['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A'],
    });
    expect(report.phases).toHaveLength(8);
    expect(phaseCookies).toHaveLength(800);
    expect(
      report.phases.every(
        (phase) =>
          phase.burst?.planned === 100 &&
          phase.burst.sent === 100 &&
          phase.burst.completed === 100 &&
          phase.burst.maxInFlight === 100,
      ),
    ).toBe(true);
    for (const [index, mode] of report.schedule!.entries())
      expect(new Set(phaseCookies.slice(index * 100, (index + 1) * 100)).size).toBe(
        mode === 'A' ? 1 : 100,
      );
  }, 10_000);
  it.each([200, 500] as const)(
    'keeps 12-arrival ABBA and independent session counts with HTTP %s',
    async (status) => {
      const { runtime, deadlineFixture, phaseCookies } = simulatedDeadlineRuntime(status);
      const report = await runDeadlineComparison({
        runtime,
        fixture: deadlineFixture,
        profile: getProfile('smoke'),
      });
      expect(report).toMatchObject({
        comparisonCompleted: true,
        allRequestsSucceeded: status === 200,
        apiContractValid: true,
        loginCompleted: 12,
        schedule: ['A', 'B', 'B', 'A'],
        route: { key: 'api-deadline-list', path: DEADLINE_LIST_PATH },
        requestsPerPhase: 12,
        deadlineContract: { limit: 50, total: 2400, states: deadlineStates },
        apiProbes: { completed: true, valid: true },
        probeDrain: { drained: true },
      });
      expect(report.apiProbes?.cases).toHaveLength(6);
      expect(
        report.phases.every(
          (phase) =>
            phase.burst?.sent === 12 &&
            phase.burst.completed === 12 &&
            phase.poolDelta?.success.count === 12,
        ),
      ).toBe(true);
      for (const [index, mode] of ['A', 'B', 'B', 'A'].entries())
        expect(new Set(phaseCookies.slice(index * 12, (index + 1) * 12)).size).toBe(
          mode === 'A' ? 1 : 12,
        );
      expect(JSON.stringify(report)).not.toMatch(
        /deadlineagent|deadlinerequester|deadlineadmin|example\.test|forbidden-error-body|70000000-0000/,
      );
    },
    10_000,
  );
  it('keeps an own-scope identity mismatch as a failed API contract even if every burst succeeds', async () => {
    const { runtime, deadlineFixture } = simulatedDeadlineRuntime(200, true);
    const report = await runDeadlineComparison({
      runtime,
      fixture: deadlineFixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      comparisonCompleted: true,
      allRequestsSucceeded: true,
      apiContractValid: false,
      apiProbes: { completed: true, valid: false },
    });
    expect(
      report.apiProbes?.cases.find((item) => item.key === 'deadline-requester-own'),
    ).toMatchObject({ valid: false, sample: { outcome: 'invalid_response', status: 200 } });
  }, 10_000);
  it('refuses an incomplete fixture state count before login or workload', async () => {
    const { runtime, phaseCookies } = simulatedDeadlineRuntime(200);
    const report = await runDeadlineComparison({ runtime, fixture, profile: getProfile('smoke') });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      loginCompleted: 0,
      failureCode: 'LIST_DEADLINE_FIXTURE_INVALID',
    });
    expect(phaseCookies).toEqual([]);
  });
});
