import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RESPONSE_BYTES,
  actorRoutes,
  assertLoopbackBase,
  percentile,
  requestSample,
  runWorkload,
  summarizeSamples,
  validateProfile,
  validateResponse,
  type ApiRoute,
  type FetchImplementation,
  type SsrRoute,
  type WorkloadRoute,
} from '../../tools/performance/workload.mjs';
import { seedFixture, type PerformanceFixture } from '../../tools/performance/fixture.mjs';
import { prepareOutput } from '../../tools/performance/run-baseline.mjs';

it('WP053 output cannot claim another work package or a path outside its Evidence', async () => {
  for (const target of [
    'evidence/WP-P2-PERF-051/static-output',
    '/tmp/solvi-static-output',
    'evidence/WP-P2-PERF-053/../WP-P2-PERF-052/static-output',
  ]) {
    await expect(prepareOutput(target, 'static', 'WP-P2-PERF-053')).rejects.toThrow(
      'OUTPUT_OUTSIDE_EVIDENCE',
    );
  }
});

const profile = {
  name: 'smoke',
  users: 120,
  tickets: 2400,
  activeSessions: 12,
  roles: { requester: 10, agent: 1, admin: 1 },
  warmupMs: 2000,
  durationMs: 10000,
  thinkTimeMs: 500,
  requestTimeoutMs: 10000,
  seed: 41,
};
const apiRoute: ApiRoute = {
  key: 'test-api',
  path: '/tickets',
  kind: 'api',
  check: (data) =>
    typeof data === 'object' && data !== null && 'items' in data && Array.isArray(data.items),
};
const htmlRoute: SsrRoute = {
  key: 'test-html',
  path: '/portal',
  kind: 'ssr',
  heading: 'あなたのITサポート',
  markers: ['あなたの問い合わせ'],
};
const html = '<main id="main"><h1>あなたのITサポート</h1><h2>あなたの問い合わせ</h2></main>';
const response = (body: string, type = 'application/json', status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } });

describe('isolated performance workload contracts', () => {
  it('accepts only explicit loopback origins without credentials or extra URL state', () => {
    expect(assertLoopbackBase('http://127.0.0.1:43210')).toBe('http://127.0.0.1:43210');
    for (const value of [
      'http://localhost:43210',
      'https://example.test',
      'http://127.0.0.1',
      'http://user:password@127.0.0.1:43210',
      'http://127.0.0.1:43210/path',
      'http://127.0.0.1:43210/?q=1',
    ]) {
      expect(() => assertLoopbackBase(value)).toThrow('WORKLOAD_BASE_REJECTED');
    }
  });

  it('bounds load, durations, response waits, and exact role/session accounting', () => {
    expect(validateProfile(profile)).toBe(profile);
    for (const changed of [
      { activeSessions: 101 },
      { durationMs: 60001 },
      { thinkTimeMs: 0 },
      { requestTimeoutMs: 10001 },
      { users: 4001 },
      { tickets: 100001 },
      { seed: NaN },
      { roles: { requester: 12 } },
      { roles: { requester: 11, agent: 1, admin: 1 } },
    ]) {
      expect(() => validateProfile({ ...profile, ...changed })).toThrow(
        'WORKLOAD_PROFILE_REJECTED',
      );
    }
  });

  it('keeps fast failures and timeouts out of successful latency quantiles', () => {
    const result = summarizeSamples(
      [
        { outcome: 'success', durationMs: 100, bytes: 50 },
        { outcome: 'success', durationMs: 400, bytes: 50 },
        { outcome: 'http_error', durationMs: 1, bytes: 10 },
        { outcome: 'timeout', durationMs: 1000, bytes: 0 },
      ],
      2000,
    );
    expect(result).toMatchObject({
      requests: 4,
      successes: 2,
      failures: 1,
      timeouts: 1,
      failureRate: 0.5,
      rps: 2,
      bytes: 110,
    });
    expect(result.successfulLatencyMs).toEqual({ p50: 100, p95: 400, p99: 400, max: 400 });
    expect(summarizeSamples([], 1000).successfulLatencyMs.p95).toBeNull();
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(() => percentile([NaN], 95)).toThrow('WORKLOAD_SAMPLE_REJECTED');
  });

  it('rejects a login page, error page, malformed JSON, or unexpected JSON shape returned as 200', () => {
    expect(validateResponse(htmlRoute, response(html, 'text/html'), html)).toBe(true);
    for (const body of [
      html.replace('あなたのITサポート', 'ログイン'),
      html + '<p role="alert">取得失敗</p>',
      '<h1>あなたのITサポート</h1>あなたの問い合わせ',
    ]) {
      expect(validateResponse(htmlRoute, response(body, 'text/html'), body)).toBe(false);
    }
    expect(validateResponse(apiRoute, response('{"items":[]}'), '{"items":[]}')).toBe(true);
    for (const body of ['not json', '{"error":"no"}', '{"items":{}}']) {
      expect(validateResponse(apiRoute, response(body), body)).toBe(false);
    }
  });

  it('does not follow redirects or retain cookie, body, and URL in the sample', async () => {
    const fetchImpl = vi.fn<FetchImplementation>(
      async () => new Response('', { status: 302, headers: { location: '/login' } }),
    );
    const sample = await requestSample({
      base: 'http://127.0.0.1:43210',
      route: apiRoute,
      cookie: 'test-private-cookie',
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(sample).toMatchObject({ outcome: 'http_error', status: 302 });
    expect(JSON.stringify(sample)).not.toContain('test-private-cookie');
    expect(JSON.stringify(sample)).not.toContain('/login');
  });

  it('consumes the whole successful response and counts actual UTF-8 bytes', async () => {
    const body = '{"items":["合成"]}';
    const sample = await requestSample({
      base: 'http://127.0.0.1:43210',
      route: apiRoute,
      cookie: '',
      timeoutMs: 1000,
      fetchImpl: async () => response(body),
    });
    expect(sample).toMatchObject({ outcome: 'success', bytes: Buffer.byteLength(body) });
    expect(JSON.stringify(sample)).not.toContain('合成');
  });

  it('rejects oversized bodies even without a content-length header', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const sample = await requestSample({
      base: 'http://127.0.0.1:43210',
      route: apiRoute,
      cookie: '',
      timeoutMs: 1000,
      fetchImpl: async () => new Response(stream),
    });
    expect(sample).toMatchObject({ outcome: 'too_large', bytes: MAX_RESPONSE_BYTES + 1 });
    expect(cancelled).toBe(true);
  });

  it('retains the bytes consumed before a stream fails without retaining the failure text', async () => {
    let first = true;
    const stream = new ReadableStream({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new TextEncoder().encode('合成'));
        } else controller.error(new Error('private response failure'));
      },
    });
    const sample = await requestSample({
      base: 'http://127.0.0.1:43210',
      route: apiRoute,
      cookie: '',
      timeoutMs: 1000,
      fetchImpl: async () => new Response(stream),
    });
    expect(sample).toMatchObject({ outcome: 'network_error', bytes: 6 });
    expect(JSON.stringify(sample)).not.toContain('private');
  });

  it('labels timeout and explicit cancellation separately without echoing exception details', async () => {
    const fetchImpl = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        if (init.signal.aborted) reject(new Error('private URL and token'));
        else
          init.signal.addEventListener('abort', () => reject(new Error('private URL and token')), {
            once: true,
          });
      });
    const sample = await requestSample({
      base: 'http://127.0.0.1:43210',
      route: apiRoute,
      cookie: '',
      timeoutMs: 100,
      fetchImpl,
    });
    expect(sample.outcome).toBe('timeout');
    const cancelled = await requestSample({
      base: 'http://127.0.0.1:43210',
      route: apiRoute,
      cookie: '',
      timeoutMs: 100,
      signal: AbortSignal.abort(),
      fetchImpl,
    });
    expect(cancelled.outcome).toBe('aborted');
    expect(JSON.stringify([sample, cancelled])).not.toContain('private');
  });

  it('distinguishes expected cross-org denial from an ordinary failed request', async () => {
    const route: ApiRoute = {
      ...apiRoute,
      expectedStatus: 404,
      check: (data) =>
        typeof data === 'object' && data !== null && 'status' in data && data.status === 404,
    };
    const sample = await requestSample({
      base: 'http://127.0.0.1:43210',
      route,
      cookie: '',
      timeoutMs: 1000,
      fetchImpl: async () => response('{"status":404}', 'application/problem+json', 404),
    });
    expect(sample.outcome).toBe('success');
    const leak = await requestSample({
      base: 'http://127.0.0.1:43210',
      route,
      cookie: '',
      timeoutMs: 1000,
      fetchImpl: async () => response('{"status":200}'),
    });
    expect(leak.outcome).toBe('http_error');
  });

  it('rejects repeated actors before starting authentication', async () => {
    const fixture: PerformanceFixture = {
      organizationId: 'fixture-org',
      controlOrganizationId: 'fixture-control',
      controlTicketId: 'fixture-control-ticket',
      catalogItemId: 'fixture-catalog',
      serviceRequestId: 'fixture-request',
      counts: {
        users: 120,
        tickets: 2400,
        usersByStatus: [],
        roles: [],
        states: [],
        priorities: [],
        assignment: [],
        groups: 2,
        memberships: 1,
        comments: 0,
        catalog: 1,
        approvals: 1,
        credentials: 12,
        readReceipts: 0,
        attachments: 0,
        controlUsers: 1,
        controlTickets: 1,
      },
      actors: Array.from({ length: 12 }, () => ({
        userId: 'same',
        email: 'fixture@example.test',
        password: 'unused',
        role: 'requester',
        ticketId: '04100000-0000-4000-8002-000000000001',
        ticketSubject: 'fixture',
      })),
    };
    await expect(
      runWorkload({
        profile,
        fixture,
        apiBase: 'http://127.0.0.1:43210',
        webBase: 'http://127.0.0.1:43211',
      }),
    ).rejects.toThrow('WORKLOAD_ACTORS_NOT_DISTINCT');
  });

  it('keeps administrator-only and approval routes out of requester traffic', () => {
    const actor = {
      role: 'requester' as const,
      ticketId: '04100000-0000-4000-8002-000000000001',
      ticketSubject: '合成',
    };
    const fixture = {
      counts: { users: 120, tickets: 2400 },
      catalogItemId: 'fixture-catalog',
      serviceRequestId: 'fixture-request',
    };
    const requester = actorRoutes(actor, fixture).map((r: { key: string }) => r.key);
    const admin = actorRoutes({ ...actor, role: 'admin' }, fixture).map(
      (r: { key: string }) => r.key,
    );
    expect(requester).toContain('request-form');
    expect(requester).not.toContain('users');
    expect(requester).not.toContain('approvals');
    expect(admin).toContain('users');
    expect(admin).toContain('approvals');
  });

  it('requires real ticket DTOs and the fixture detail subject in successful API bodies', () => {
    const actor = {
      role: 'requester' as const,
      ticketId: '04100000-0000-4000-8002-000000000001',
      ticketSubject: '合成性能問い合わせ 1',
    };
    const fixture = {
      counts: { users: 120, tickets: 2400 },
      catalogItemId: 'fixture-catalog',
      serviceRequestId: 'fixture-request',
    };
    const requester = actorRoutes(actor, fixture);
    const agent = actorRoutes({ ...actor, role: 'agent' }, fixture);
    const item = {
      id: actor.ticketId,
      subject: actor.ticketSubject,
      state: 'assigned',
      kind: 'request',
    };
    const checkBody = (route: WorkloadRoute | undefined, data: unknown) => {
      if (!route) throw new Error('TEST_ROUTE_MISSING');
      const body = JSON.stringify(data);
      return validateResponse(route, response(body), body);
    };
    for (const [route, scope, total] of [
      [requester.find((r: { key: string }) => r.key === 'api-ticket-list'), 'own', 10],
      [agent.find((r: { key: string }) => r.key === 'api-ops-list'), 'organization', 2400],
    ] as const) {
      expect(checkBody(route, { items: [item], scope, total })).toBe(true);
      for (const items of [
        [],
        [{}],
        [{ ...item, id: 'bad-id' }],
        [{ ...item, subject: '' }],
        [{ ...item, state: 'invented' }],
        [{ ...item, kind: 'invented' }],
      ])
        expect(checkBody(route, { items, scope, total })).toBe(false);
    }
    const detail = requester.find((r: { key: string }) => r.key === 'api-ticket-detail');
    expect(checkBody(detail, item)).toBe(true);
    expect(checkBody(detail, { ...item, subject: 'unrelated ticket' })).toBe(false);
    expect(checkBody(detail, { id: item.id, subject: item.subject })).toBe(false);
  });

  it('refuses fixture writes outside the exactly named owned database', async () => {
    const query = vi.fn(async () => ({ rows: [{ database: 'solvi' }] }));
    const createCredential = vi.fn(async () => ({ ok: true as const }));
    await expect(
      seedFixture({ query }, profile, { createCredential, databaseName: 'solvi' }),
    ).rejects.toThrow('FIXTURE_DATABASE_NAME_REJECTED');
    expect(query).not.toHaveBeenCalled();
    await expect(
      seedFixture({ query }, profile, { createCredential, databaseName: 'solvi_perf041_test' }),
    ).rejects.toThrow('FIXTURE_DATABASE_MISMATCH');
    expect(query).toHaveBeenCalledTimes(1);
    expect(createCredential).not.toHaveBeenCalled();
  });

  it('rolls back fixture preparation if the real credential service refuses an actor', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('current_database')) return { rows: [{ database: 'solvi_perf041_test' }] };
      if (sql.includes('SELECT id,code FROM organization'))
        return {
          rows: [
            { id: 'target-org', code: 'acme' },
            { id: 'control-org', code: 'beta' },
          ],
        };
      if (sql.startsWith('SELECT count')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    });
    const createCredential = vi.fn(async () => ({
      ok: false as const,
      reason: 'private service details',
    }));
    await expect(
      seedFixture({ query }, profile, {
        createCredential,
        databaseName: 'solvi_perf041_test',
      }),
    ).rejects.toThrow(/^FIXTURE_CREDENTIAL_REJECTED$/);
    expect(createCredential).toHaveBeenCalledTimes(1);
    expect(createCredential.mock.calls).toHaveLength(1);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('COMMIT'))).toBe(false);
  });
});
