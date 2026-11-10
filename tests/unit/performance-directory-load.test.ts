import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readDirectoryExpectation,
  validateDirectoryResponse,
  runDirectoryComparison,
  runDirectoryStateProbes,
  type DirectoryExpectation,
} from '../../tools/performance/directory-load.mjs';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import { getProfile } from '../../tools/performance/profiles.mjs';
import type { PoolSnapshot } from '../../tools/performance/list-load.mjs';

let acquisitions = 0;
vi.mock('../../tools/performance/list-load.mjs', async (original) => {
  const actual = await original<typeof import('../../tools/performance/list-load.mjs')>();
  return {
    ...actual,
    scrapePool: async (): Promise<PoolSnapshot> => ({
      valid: true,
      acquisitions: {
        success: {
          count: ++acquisitions,
          sumMs: acquisitions,
          buckets: [{ le: '+Inf', count: acquisitions }],
        },
        failure: { count: 0, sumMs: 0, buckets: [] },
      },
      connections: { total: 5, idle: 5, waiting: 0, inUse: 0 },
    }),
    drain: async (_runtime: unknown, signal: AbortSignal) => ({
      drained: !signal.aborted,
      waitedMs: 0,
    }),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  acquisitions = 0;
});

const id = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const fixture: PerformanceFixture = {
  organizationId: id(500),
  controlOrganizationId: id(501),
  controlTicketId: id(502),
  catalogItemId: id(503),
  serviceRequestId: id(504),
  counts: {
    users: 3,
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
  actors: (['admin', 'requester', 'agent'] as const).map((role, i) => ({
    userId: id(i + 1),
    email: `${role}@example.test`,
    password: 'synthetic-unit-only',
    role,
    ticketId: id(600),
    ticketSubject: '合成',
  })),
};
const roleByIndex = [['org_admin', 'requester'], ['requester'], ['agent']];
function body() {
  return {
    items: fixture.actors.map((actor, index) => ({
      userId: actor.userId,
      displayName: index === 2 ? '停止中' : '同名の利用者',
      email: actor.email,
      status: index === 2 ? 'deactivated' : 'active',
      deactivatedAt: index === 2 ? '2026-01-01T00:00:00.000Z' : null,
      roleCodes: roleByIndex[index]!,
      openTicketCount: index * 2,
      temporaryRoles:
        index === 0
          ? [
              {
                roleCode: 'requester',
                validUntil: '2099-01-01T00:00:00.000Z',
                daysRemaining: 26000,
                expiringSoon: false,
              },
            ]
          : [],
    })),
  };
}
function expectation(): DirectoryExpectation {
  const data = body();
  return {
    members: new Map(
      data.items.map((item) => [
        item.userId,
        {
          ...item,
          status: item.status as 'active' | 'deactivated',
          roleCodes: [...item.roleCodes].sort(),
        },
      ]),
    ),
    order: data.items.map((item) => ({
      status: item.status as 'active' | 'deactivated',
      displayName: item.displayName,
    })),
  };
}
function rows() {
  return body().items.map((item) => ({
    user_id: item.userId,
    display_name: item.displayName,
    primary_email: item.email,
    status: item.status,
    deactivated_at: item.deactivatedAt,
    role_codes: item.roleCodes,
    temporary_roles: item.temporaryRoles,
  }));
}

describe('WP045 full organization directory response', () => {
  it('accepts multi-role, stopped users, temporary roles and tied names without inventing an ID tie break', () => {
    const data = body();
    expect(validateDirectoryResponse(data, expectation())).toBe(true);
    [data.items[0], data.items[1]] = [data.items[1]!, data.items[0]!];
    expect(validateDirectoryResponse(data, expectation())).toBe(true);
  });
  it.each([
    [
      'missing user',
      (data: ReturnType<typeof body>) => {
        data.items.pop();
      },
    ],
    [
      'foreign user',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.userId = id(999);
      },
    ],
    [
      'duplicate user',
      (data: ReturnType<typeof body>) => {
        data.items[1] = data.items[0]!;
      },
    ],
    [
      'wrong order',
      (data: ReturnType<typeof body>) => {
        data.items.reverse();
      },
    ],
    [
      'wrong name',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.displayName = 'other';
      },
    ],
    [
      'wrong email',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.email = 'other@example.test';
      },
    ],
    [
      'wrong status',
      (data: ReturnType<typeof body>) => {
        data.items[2]!.status = 'active';
      },
    ],
    [
      'wrong deactivation',
      (data: ReturnType<typeof body>) => {
        data.items[2]!.deactivatedAt = null;
      },
    ],
    [
      'negative count',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.openTicketCount = -1;
      },
    ],
    [
      'fractional count',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.openTicketCount = 0.5;
      },
    ],
    [
      'missing count',
      (data: ReturnType<typeof body>) => {
        Object.assign(data.items[0]!, { openTicketCount: undefined });
      },
    ],
    [
      'extra role',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.roleCodes = ['platform_admin'];
      },
    ],
    [
      'duplicate role',
      (data: ReturnType<typeof body>) => {
        data.items[1]!.roleCodes = ['requester', 'requester'];
      },
    ],
    [
      'invalid temporary role',
      (data: ReturnType<typeof body>) => {
        Object.assign(data.items[0]!, { temporaryRoles: [null] });
      },
    ],
    [
      'invalid expiry',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.temporaryRoles[0]!.validUntil = 'invalid';
      },
    ],
    [
      'invalid remaining days',
      (data: ReturnType<typeof body>) => {
        data.items[0]!.temporaryRoles[0]!.daysRemaining = -1;
      },
    ],
  ] as const)('rejects %s', (_name, change) => {
    const data = structuredClone(body());
    change(data);
    expect(validateDirectoryResponse(data, expectation())).toBe(false);
  });
  it('keeps oracle fields in memory and rejects unexpected fixture cardinality', async () => {
    const query = vi.fn(async () => ({ rows: rows() }));
    const runtime = {
      apiBase: 'http://127.0.0.1:39991',
      metricsBase: 'http://127.0.0.1:39992',
      admin: { query },
    };
    const expected = await readDirectoryExpectation(runtime, fixture, new AbortController().signal);
    expect(expected.members.size).toBe(3);
    expect(query.mock.calls[0]).toBeDefined();
    await expect(
      readDirectoryExpectation(
        runtime,
        { ...fixture, counts: { ...fixture.counts, users: 4 } },
        new AbortController().signal,
      ),
    ).rejects.toThrow('DIRECTORY_FIXTURE_COUNT_INVALID');
  });
});

function setup(
  options: {
    status500?: boolean;
    forbiddenAllowed?: boolean;
    abort?: AbortController;
    wrongSessionPrincipal?: boolean;
  } = {},
) {
  const phaseCookies: string[][] = [];
  let phase = -1;
  let sequence = 0;
  const sessions = new Map<string, string>();
  const admin = {
    query: vi.fn(async (config: { text: string; values: unknown[] }) => {
      if (config.text.includes('array_agg')) return { rows: rows() };
      if (config.text.includes('pg_stat_activity'))
        return { rows: [{ connections: 5, active: 0, idle_in_transaction: 0, lock_waiting: 0 }] };
      if (config.text.includes('token_hash')) {
        const count = (config.values[0] as string[]).length;
        return {
          rows: [
            {
              sessions: count,
              distinct_sessions: count,
              principals: options.wrongSessionPrincipal ? 2 : 1,
              active_matching: count,
            },
          ],
        };
      }
      throw new Error('unexpected unit query');
    }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/login')) {
        const data = JSON.parse(String(init.body)) as { email: string; organizationId: string };
        const actor = fixture.actors.find((item) => item.email === data.email)!;
        const cookie = `solvi_session=unit_${++sequence}`;
        sessions.set(cookie, actor.role);
        return new Response(
          JSON.stringify({ userId: actor.userId, organizationId: fixture.organizationId }),
          { status: 200, headers: { 'set-cookie': cookie } },
        );
      }
      expect(new URL(url).pathname).toBe('/users');
      expect(new URL(url).search).toBe('');
      const cookie = new Headers(init.headers).get('cookie') ?? '';
      const role = sessions.get(cookie);
      if (phase >= 0) {
        phaseCookies[phase]!.push(cookie);
        options.abort?.abort();
        if (options.status500)
          return new Response('{"status":500}', {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
      }
      const status = !cookie ? 401 : role === 'admin' || options.forbiddenAllowed ? 200 : 403;
      return new Response(JSON.stringify(status === 200 ? body() : { status }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return {
    runtime: { apiBase: 'http://127.0.0.1:39991', metricsBase: 'http://127.0.0.1:39992', admin },
    phaseCookies,
    onProgress: (stage: string) => {
      if (stage.startsWith('comparison-phase-')) {
        phase++;
        phaseCookies.push([]);
      } else phase = -1;
    },
  };
}

describe('WP045 controlled directory session comparison', () => {
  it.each(['smoke', 'baseline', 'growth'] as const)(
    'uses the same administrator and fixed ABBA bursts for %s',
    async (name) => {
      const harness = setup();
      const report = await runDirectoryComparison({
        ...harness,
        fixture,
        profile: getProfile(name),
      });
      const count = name === 'smoke' ? 12 : 100;
      const modes =
        name === 'smoke' ? ['A', 'B', 'B', 'A'] : ['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A'];
      expect(report).toMatchObject({
        comparisonCompleted: true,
        allRequestsSucceeded: true,
        apiContractValid: true,
        principal: { role: 'org_admin', count: 1, organizationCount: 1 },
        route: { path: '/users' },
        loginCompleted: count,
        sessionVerification: { verified: true, principals: 1, distinctSessions: count },
        schedule: modes,
      });
      expect(report.phases.map((item) => item.burst?.sent)).toEqual(modes.map(() => count));
      expect(harness.phaseCookies.map((cookies) => new Set(cookies).size)).toEqual(
        modes.map((mode) => (mode === 'A' ? 1 : count)),
      );
      expect(
        report.phases.every(
          (item) =>
            item.observationValid && item.burst?.inFlight === 0 && item.burst?.unfinished === 0,
        ),
      ).toBe(true);
      expect(report.apiProbes?.cases.map((item) => item.expectedStatus)).toEqual([
        200, 403, 403, 401,
      ]);
      const encoded = JSON.stringify(report);
      for (const forbidden of [
        'unit_',
        'example.test',
        fixture.organizationId,
        '同名',
        'SELECT ',
        'synthetic-unit-only',
      ])
        expect(encoded).not.toContain(forbidden);
    },
  );
  it('retains measured HTTP failures while keeping comparison completion distinct', async () => {
    const report = await runDirectoryComparison({
      ...setup({ status500: true }),
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      comparisonCompleted: true,
      allRequestsSucceeded: false,
      apiContractValid: true,
    });
    expect(
      report.phases.every(
        (item) => item.burst?.statusCounts['500'] === 12 && item.burst?.unsuccessful === 12,
      ),
    ).toBe(true);
  });
  it('rejects incorrect authorization despite complete successful measured bursts', async () => {
    const report = await runDirectoryComparison({
      ...setup({ forbiddenAllowed: true }),
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      comparisonCompleted: true,
      allRequestsSucceeded: true,
      apiContractValid: false,
    });
  });
  it('stops before phases when DB sessions do not prove one principal', async () => {
    const report = await runDirectoryComparison({
      ...setup({ wrongSessionPrincipal: true }),
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      allRequestsSucceeded: false,
      phases: [],
      failureCode: 'DIRECTORY_SESSION_CARDINALITY_INVALID',
    });
  });
  it('retains partial dispatch and does not proceed to permission probes after abort', async () => {
    const controller = new AbortController();
    const report = await runDirectoryComparison({
      ...setup({ abort: controller }),
      fixture,
      profile: getProfile('smoke'),
      signal: controller.signal,
    });
    expect(report).toMatchObject({
      comparisonCompleted: false,
      allRequestsSucceeded: false,
      failureCode: 'DIRECTORY_ABORTED',
    });
    expect(report.phases).toHaveLength(1);
    expect(report.phases[0]?.burst?.unsent).toBeGreaterThan(0);
    expect(report.apiProbes).toBeUndefined();
  });
});

describe('WP045 post-measurement state probe isolation', () => {
  function stateHarness(options: { wrongResponse?: boolean; failSetup?: boolean } = {}) {
    let state: 'initial' | 'expired' | 'platform' | 'stopped' = 'initial';
    const statements: string[] = [];
    const database = 'solvi_perf041_123_abcdef123456';
    const query = vi.fn(async (config: { text: string; values: unknown[] }) => {
      statements.push(config.text);
      if (config.text.includes('current_database()')) return { rows: [{ database }] };
      if (config.text.includes('array_agg')) return { rows: rows() };
      if (config.text.startsWith('UPDATE role_binding')) {
        if (options.failSetup) throw new Error('DIRECTORY_PRIVATE_SECRET');
        expect(config.values).toEqual([fixture.actors[0]!.userId, fixture.organizationId]);
        expect(config.text).toContain('valid_from=LEAST');
        state = 'expired';
        return { rows: [{ id: id(800) }] };
      }
      if (config.text.startsWith('INSERT INTO role_binding')) {
        if (config.text.includes("code='platform_admin'")) state = 'platform';
        return { rows: [{ id: id(801) }] };
      }
      if (config.text.startsWith('UPDATE app_user')) {
        state = 'stopped';
        return { rows: [{ id: fixture.actors[0]!.userId }] };
      }
      if (
        ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(config.text) ||
        config.text.startsWith('SET LOCAL')
      )
        return { rows: [] };
      throw new Error('unexpected unit state query');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/auth/login'))
          return new Response(
            JSON.stringify({
              userId: fixture.actors[0]!.userId,
              organizationId: fixture.organizationId,
            }),
            { status: 200, headers: { 'set-cookie': 'solvi_session=state_unit' } },
          );
        expect(new URL(url).pathname).toBe('/users');
        const status = options.wrongResponse
          ? 200
          : state === 'expired'
            ? 403
            : state === 'stopped'
              ? 401
              : 200;
        return new Response(JSON.stringify(status === 200 ? body() : { status }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return {
      statements,
      runtime: {
        apiBase: 'http://127.0.0.1:39991',
        metricsBase: 'http://127.0.0.1:39992',
        admin: { query },
        meta: { database },
      },
    };
  }
  it('records expiration, platform access and stopped-cookie refusal separately after fixture preparation', async () => {
    const harness = stateHarness();
    const report = await runDirectoryStateProbes({
      runtime: harness.runtime,
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: true,
      valid: true,
      measuredFixtureUsers: 3,
      postPreparationRosterUsers: 3,
      preparation: {
        organizationMembershipAdded: 1,
        administratorBindingsExpired: 1,
        platformBindingsAdded: 1,
        usersDeactivated: 1,
      },
    });
    expect(report.cases.map((item) => item.expectedStatus)).toEqual([403, 200, 401]);
    expect(harness.statements.indexOf('COMMIT')).toBeLessThan(
      harness.statements.findIndex((sql) => sql.includes("code='platform_admin'")),
    );
    expect(JSON.stringify(report)).not.toContain('state_unit');
    expect(JSON.stringify(report)).not.toContain(fixture.actors[0]!.userId);
  });
  it('rolls back incomplete preparation and reports no SQL detail', async () => {
    const harness = stateHarness({ failSetup: true });
    const report = await runDirectoryStateProbes({
      runtime: harness.runtime,
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: false,
      valid: false,
      failureCode: 'DIRECTORY_STATE_PROBES_FAILED',
      cases: [],
    });
    expect(harness.statements.at(-1)).toBe('ROLLBACK');
    expect(JSON.stringify(report)).not.toContain('DIRECTORY_PRIVATE_SECRET');
  });
  it('fails closed before platform or stopped setup when expired privileges are accepted', async () => {
    const harness = stateHarness({ wrongResponse: true });
    const report = await runDirectoryStateProbes({
      runtime: harness.runtime,
      fixture,
      profile: getProfile('smoke'),
    });
    expect(report).toMatchObject({
      completed: false,
      valid: false,
      failureCode: 'DIRECTORY_STATE_RESPONSE_INVALID',
    });
    expect(report.cases).toHaveLength(1);
    expect(harness.statements.some((sql) => sql.includes("code='platform_admin'"))).toBe(false);
  });
  it('rejects non-owned or mismatched database before login or writes', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const query = vi.fn(async () => ({ rows: [{ database: 'unrelated' }] }));
    const runtime = {
      apiBase: 'http://127.0.0.1:39991',
      metricsBase: 'http://127.0.0.1:39992',
      admin: { query },
      meta: { database: 'unrelated' },
    };
    expect(
      await runDirectoryStateProbes({ runtime, fixture, profile: getProfile('smoke') }),
    ).toMatchObject({
      completed: false,
      valid: false,
      failureCode: 'DIRECTORY_STATE_DATABASE_REJECTED',
    });
    expect(query).not.toHaveBeenCalled();
    runtime.meta.database = 'solvi_perf041_123_abcdef123456';
    expect(
      await runDirectoryStateProbes({ runtime, fixture, profile: getProfile('smoke') }),
    ).toMatchObject({
      completed: false,
      valid: false,
      failureCode: 'DIRECTORY_STATE_DATABASE_MISMATCH',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
