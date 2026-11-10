import { describe, expect, it, vi } from 'vitest';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type { ReadOnlyProof } from '../../tools/performance/list-query-analysis.mjs';
import type { SearchCostQuery } from '../../tools/performance/search-cost-analysis.mjs';
import {
  analyzeSearchRepro,
  searchReproSchedule,
  searchReproBinding,
  summarizeSearchReproPlan,
  sanitizeSearchReproResources,
  searchReproResourceDelta,
  summarizeSearchReproPairs,
  type SearchReproRuntime,
  type ReproResourceSnapshot,
  type ReproPair,
} from '../../tools/performance/search-repro-analysis.mjs';

const id = (n: number) => `05000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-05 00:00:00.123456+00';
const fixture: PerformanceFixture = {
  organizationId: id(100),
  controlOrganizationId: id(101),
  controlTicketId: id(102),
  catalogItemId: id(103),
  serviceRequestId: id(104),
  actors: [
    {
      userId: id(200),
      role: 'agent',
      email: 'PRIVATE-email',
      password: 'PRIVATE-password',
      ticketId: id(1),
      ticketSubject: 'PRIVATE-subject',
    },
  ],
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
    approvals: 0,
    credentials: 1,
    readReceipts: 0,
    attachments: 0,
    controlUsers: 1,
    controlTickets: 1,
  },
};
const proof: ReadOnlyProof = {
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
};
const row = () => ({
  id: id(1),
  organization_id: fixture.organizationId,
  requester_id: id(200),
  created_at: new Date(stamp),
  cursor_created_at: stamp,
  assignee_name: null,
  requester_name: 'PRIVATE-name',
  assignee_group_name: null,
  sla_elapsed_now: 1,
  remaining_seconds: null,
  response_target_minutes: null,
  resolution_target_minutes: null,
  sla_elapsed_seconds: 1,
  sla_clock_started_at: null,
});
const sentinel = () => Object.fromEntries(Object.keys(row()).map((key) => [key, null]));
const built = (
  sql = 'SELECT fixed FROM ticket',
  params: unknown[] = [fixture.organizationId, 'PRIVATE-keyword', 50],
): SearchCostQuery => ({
  sql: 'SELECT legacy FROM ticket',
  countSql: 'SELECT count(*) FROM ticket',
  combinedSql: sql,
  params,
  countParams: params.slice(0, -1),
  limit: 50,
});

function plan(prefix = false, rows = 1, timing = true) {
  const scan = (loops: number) => ({
    'Node Type': 'Seq Scan',
    'Relation Name': 'ticket',
    'Actual Rows': loops ? 1 : 0,
    'Actual Loops': loops,
    'Rows Removed by Filter': loops ? 99 : 0,
    Filter: 'PRIVATE-predicate',
    'Shared Hit Blocks': 50,
  });
  const producer = (name: string, count: number, children: Record<string, unknown>[]) => ({
    'Node Type': 'Result',
    'Subplan Name': `CTE ${name}`,
    'Actual Rows': count,
    'Actual Loops': 1,
    Plans: children,
  });
  const lookup = {
    'Node Type': 'Index Scan',
    'Relation Name': 'ticket',
    'Index Name': 'ticket_pkey',
    'Index Cond': 'id = PRIVATE-value',
    'Actual Rows': 1,
    'Actual Loops': rows,
  };
  const root: Record<string, unknown> = {
    'Node Type': 'Nested Loop',
    'Actual Rows': Math.max(rows, 1),
    'Actual Loops': 1,
    'Shared Hit Blocks': 10,
    'Local Read Blocks': 3,
    'Temp Read Blocks': 0,
    'Temp Written Blocks': 0,
    Plans: [
      producer('probe_keys', 50, [
        {
          'Node Type': 'Index Only Scan',
          'Relation Name': 'ticket',
          'Index Name': 'ticket_list_state_idx',
          'Index Cond': "organization_id = 'PRIVATE-org' AND state = 'PRIVATE-state'",
          'Actual Rows': 50,
          'Actual Loops': 1,
        },
      ]),
      producer('probe_evaluation', 50, [{ ...lookup, 'Actual Loops': 50 }]),
      producer('probe_status', 1, []),
      producer('matched', prefix ? 0 : rows, [scan(prefix ? 0 : 1)]),
      producer('counted', 1, [scan(prefix ? 1 : 0)]),
      lookup,
      ...['assignee', 'requester', 'assignee_group'].map((alias) => ({
        'Node Type': 'Seq Scan',
        'Relation Name': alias === 'assignee_group' ? 'assignment_group' : 'app_user',
        Alias: alias,
        'Actual Rows': rows,
        'Actual Loops': 1,
      })),
    ],
  };
  if (timing) {
    root['Actual Startup Time'] = 0.2;
    root['Actual Total Time'] = 2;
  }
  return [{ Plan: root, 'Planning Time': 0.1, 'Execution Time': timing ? 2 : 1 }];
}
const snapshot = (sequence = 0): ReproResourceSnapshot => ({
  available: true,
  source: 'cgroup-v2',
  capturedAt: new Date(Date.UTC(2026, 9, 5, 0, 0, sequence)).toISOString(),
  durationMs: 1,
  cpu: {
    usage_usec: sequence * 100,
    user_usec: sequence * 80,
    system_usec: sequence * 20,
    nr_periods: sequence,
    nr_throttled: 0,
    throttled_usec: 0,
  },
  io: { rbytes: sequence * 10, wbytes: 0, rios: sequence, wios: 0 },
  devices: 1,
});

function setup(
  options: {
    unavailable?: boolean;
    failMeasured?: boolean;
    badPlan?: boolean;
    failResource?: boolean;
  } = {},
) {
  const trace: string[] = [];
  const registry = new Map<string, { total: number; prefix: boolean }>();
  let resources = 0;
  const create: (side: string) => SearchReproRuntime['buildTicketListQuery'] =
    (side) => (_ctx, input) => {
      const keyword = input.filter!.keyword!;
      const condition = keyword.startsWith('PERF041')
        ? 'rare'
        : keyword === '合'
          ? 'short'
          : 'zero';
      const state = input.filter!.state;
      const suffix = state ? `_${side}_state` : '';
      const sql = `SELECT ${condition}${suffix} FROM ticket`;
      const total = condition === 'zero' ? 0 : 1;
      registry.set(sql, { total, prefix: condition === 'short' && side === 'B' });
      return built(sql, [fixture.organizationId, keyword, ...(state ? [state] : []), 50]);
    };
  const query = vi.fn(async (sql: string) => {
    trace.push(sql.startsWith('EXPLAIN') ? (sql.includes('TIMING OFF') ? 'off' : 'on') : 'select');
    if (sql.startsWith('SELECT r.code')) return { rows: [{ code: 'agent' }] };
    if (sql.startsWith('SELECT number')) return { rows: [{ number: 'PERF041-0000001' }] };
    if (sql.startsWith('SELECT state')) return { rows: [{ state: 'new' }] };
    const key = sql.startsWith('EXPLAIN') ? sql.slice(sql.indexOf('SELECT')) : sql;
    const value = registry.get(key)!;
    if (!value) throw new Error('PRIVATE-unexpected-query');
    if (sql.startsWith('EXPLAIN')) {
      const doc = plan(value.prefix, value.total, !sql.includes('TIMING OFF'));
      if (options.badPlan) doc[0]!.Plan['Node Type'] = 'PRIVATE-unknown-node';
      return { rows: [{ 'QUERY PLAN': doc }] };
    }
    const data: Record<string, unknown> = value.total ? row() : sentinel();
    if (options.failMeasured && resources === 1) data.created_at = 'PRIVATE-wrong-type';
    return { rows: [{ ...data, __solvi_total: value.total }] };
  });
  const runtime: SearchReproRuntime = {
    buildLegacySearch048Query: create('A'),
    buildLegacySearch049Query: create('B'),
    buildTicketListQuery: create('B'),
    withAppReadOnly: vi.fn(async (_context, callback) => callback({ query, proof })),
    readDatabaseResources: vi.fn(async (): Promise<ReproResourceSnapshot> => {
      trace.push('resource');
      resources++;
      if (options.failResource && resources === 2) throw new Error('PRIVATE-resource-error');
      return options.unavailable
        ? {
            available: false,
            reason: 'CGROUP_UNAVAILABLE',
            capturedAt: new Date().toISOString(),
            durationMs: 1,
          }
        : snapshot(resources);
    }),
  };
  return { runtime, trace, query };
}

describe('WP050 fixed protocol and native bindings', () => {
  it('balances 24/8/8 pairs and reverses conditions, first order and EXPLAIN phases in replica2', () => {
    const first = searchReproSchedule(1),
      second = searchReproSchedule(2);
    expect(first.measuredPairs).toEqual({ plain: 24, 'explain-off': 8, 'explain-on': 8 });
    expect(first.warmupPairs).toBe(2);
    expect(second.conditions).toEqual([...first.conditions].reverse());
    expect(first.phases).toEqual(['plain', 'explain-off', 'explain-on']);
    expect(second.phases).toEqual(['plain', 'explain-on', 'explain-off']);
    expect(first.orders).toEqual(['AB', 'BA', 'BA', 'AB']);
    expect(second.orders).toEqual(['BA', 'AB', 'AB', 'BA']);
    for (const schedule of [first, second])
      for (const count of [24, 8]) {
        const orders = Array.from({ length: count }, (_, i) => schedule.orders[i % 4]);
        expect(orders.filter((order) => order === 'AB')).toHaveLength(count / 2);
      }
    expect(() => searchReproSchedule(3 as 1)).toThrow('REPRO_PROTOCOL_FAILED');
  });
  it('requires byte-identical negative SQL, native typed params and fixed049 product equivalence', () => {
    const a = built(),
      b = built();
    const binding = searchReproBinding(a, b, b, true);
    expect(binding).toMatchObject({
      sqlIdentical: true,
      typedParamsEqual: true,
      currentMatchesFixed049: true,
      paramTypes: ['string', 'string', 'number'],
    });
    expect(binding.aSqlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(binding)).not.toContain('PRIVATE');
    expect(JSON.stringify(binding)).not.toContain('paramsSha');
    expect(() => searchReproBinding(a, built('SELECT different FROM ticket'), b, true)).toThrow(
      'REPRO_BINDING_INVALID',
    );
    const number = built('SELECT B FROM ticket', [50]);
    expect(() =>
      searchReproBinding(built('SELECT A FROM ticket', ['50']), number, number, false),
    ).toThrow('REPRO_BINDING_INVALID');
    const date = built('SELECT B FROM ticket', [new Date(stamp)]);
    expect(() =>
      searchReproBinding(
        built('SELECT A FROM ticket', [new Date(stamp).toISOString()]),
        date,
        date,
        false,
      ),
    ).toThrow('REPRO_BINDING_INVALID');
    expect(() =>
      searchReproBinding(a, b, { ...b, countSql: 'SELECT changed FROM ticket' }, true),
    ).toThrow('REPRO_BINDING_INVALID');
  });
});

describe('WP050 compact EXPLAIN evidence', () => {
  it.each([false, true])(
    'accepts the PostgreSQL SubqueryScan child relationship with timing=%s while rejecting unknown relationships',
    (timing) => {
      const document = plan(false, 1, timing);
      const children = document[0]!.Plan.Plans as Array<Record<string, unknown>>;
      const subqueryChild = { ...children[5], 'Parent Relationship': 'Subquery' };
      children[5] = {
        'Node Type': 'Subquery Scan',
        'Parent Relationship': 'Inner',
        'Actual Rows': 1,
        'Actual Loops': 1,
        Plans: [subqueryChild],
      };
      const result = summarizeSearchReproPlan(document, 1);
      expect(result.structure.children![5]!.children![0]!.relationship).toBe('Subquery');
      expect(result.work.page).toMatchObject({ loops: 1, visitedRows: 1 });
      expect(result.work.branch).toBe('fallback');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      subqueryChild['Parent Relationship'] = 'PRIVATE-unknown-relationship';
      expect(() => summarizeSearchReproPlan(document, 1)).toThrow('REPRO_PLAN_INVALID');
    },
  );
  it('excludes times, rows and buffers from shape and preserves only root buffer totals', () => {
    const on = summarizeSearchReproPlan(plan(false, 1, true), 1);
    const off = summarizeSearchReproPlan(plan(false, 1, false), 1);
    expect(on.structureSha256).toBe(off.structureSha256);
    expect(on.executionMs).toBe(2);
    expect(off.executionMs).toBe(1);
    expect(on.work.rootBuffers.sharedHitBlocks).toBe(10);
    expect(on.work.rootBuffers.localReadBlocks).toBe(3);
    expect(on.work.matched).toMatchObject({ loops: 1, visitedRows: 100, removedRows: 99 });
    expect(on.work.count.loops).toBe(0);
    expect(JSON.stringify(on)).not.toContain('PRIVATE');
    expect(JSON.stringify(on.structure)).not.toMatch(/actual|Rows|Blocks|Time/);
    const changed = plan();
    (changed[0]!.Plan.Plans as Array<Record<string, unknown>>)[0]!['Node Type'] = 'Limit';
    expect(summarizeSearchReproPlan(changed, 1).structureSha256).not.toBe(on.structureSha256);
  });
  it('rejects unknown identifiers and an unproven double-execution branch', () => {
    const unknown = plan();
    unknown[0]!.Plan['Relation Name'] = 'PRIVATE-table';
    expect(() => summarizeSearchReproPlan(unknown, 1)).toThrow('REPRO_PLAN_INVALID');
    const both = plan();
    const ctes = both[0]!.Plan.Plans as Array<Record<string, unknown>>;
    const countScan = (ctes[4]!.Plans as Array<Record<string, unknown>>)[0]!;
    countScan['Actual Loops'] = 1;
    expect(() => summarizeSearchReproPlan(both, 1)).toThrow('REPRO_PLAN_INVALID');
  });
});

describe('WP050 resources and descriptive statistics', () => {
  it('keeps counter regression and unavailable fields explicit instead of rounding to zero', () => {
    const before = sanitizeSearchReproResources(snapshot(2)),
      after = sanitizeSearchReproResources(snapshot(3));
    expect(searchReproResourceDelta(before, after)).toMatchObject({
      available: true,
      cpu: { usage_usec: 100 },
      io: { rbytes: 10 },
    });
    expect(searchReproResourceDelta(after, before)).toMatchObject({
      available: false,
      reason: 'COUNTER_REGRESSION',
      cpu: { usage_usec: null },
      elapsedMs: null,
    });
    const missing = snapshot(3);
    if (missing.available) missing.cpu.nr_periods = null;
    expect(searchReproResourceDelta(before, sanitizeSearchReproResources(missing))).toMatchObject({
      available: false,
      reason: 'COUNTER_UNAVAILABLE',
      cpu: { usage_usec: 100, nr_periods: null },
    });
    const unknown = sanitizeSearchReproResources({
      available: false,
      reason: 'PRIVATE-reason',
      capturedAt: new Date().toISOString(),
      durationMs: 1,
    });
    expect(unknown).toMatchObject({ available: false, reason: 'RESOURCE_UNAVAILABLE' });
    expect(() => sanitizeSearchReproResources({ ...snapshot(), durationMs: -1 })).toThrow(
      'REPRO_RESOURCE_INVALID',
    );
  });
  it('separates client wall from execution time and reports paired order strata without CI', () => {
    const samples: ReproPair[] = [0, 1, 2, 3].map((index) => ({
      pair: index + 1,
      order: index % 2 ? 'BA' : 'AB',
      completed: true,
      verification: 'phase-oracle-and-plan',
      A: { wallMs: 10, executionMs: 100 },
      B: { wallMs: 11 + index, executionMs: 95 },
    }));
    const plain = summarizeSearchReproPairs(samples, 'plain'),
      explain = summarizeSearchReproPairs(samples, 'explain-off');
    expect(plain.all.pairedDeltaMs).toMatchObject({ mean: 2.5, median: 2.5, min: 1, max: 4 });
    expect(plain.AB!.A.count).toBe(2);
    expect(plain.BA!.A.count).toBe(2);
    expect(plain.all.overFivePercent).toBe(4);
    expect(explain.all.pairedDeltaMs.mean).toBe(-5);
    expect(explain.all.ratioOfMeans).toBe(0.95);
    expect(JSON.stringify(explain)).not.toContain('confidence');
  });
});

describe('WP050 complete and partial diagnostic execution', () => {
  it.each([1, 2] as const)(
    'executes replica %s exactly without EXPLAIN inside plain or observers inside SQL timings',
    async (replica) => {
      const { runtime, trace } = setup();
      const report = await analyzeSearchRepro(runtime, fixture, { replica });
      expect(report).toMatchObject({
        completed: true,
        equivalent: true,
        protocolCompleted: true,
        adoptionEstablished: false,
        resourceObservations: { complete: true, expectedWindows: 15 },
      });
      expect(report.conditions.map((item) => item.name)).toEqual(
        searchReproSchedule(replica).conditions,
      );
      expect(report.readOnlyContexts).toHaveLength(7);
      expect(report.resourceObservations.windows).toHaveLength(15);
      expect(runtime.readDatabaseResources).toHaveBeenCalledTimes(30);
      for (const condition of report.conditions) {
        expect(condition.phases.map((item) => item.name)).toEqual(
          searchReproSchedule(replica).phases,
        );
        for (const phase of condition.phases) {
          expect(phase.warmup).toHaveLength(2);
          expect(phase.samples).toHaveLength(phase.name === 'plain' ? 24 : 8);
          expect(phase.samples[0]!.order).toBe(replica === 1 ? 'AB' : 'BA');
          expect(phase.oracle?.excludedFromMeasurement).toBe(true);
          expect(phase.summary?.AB?.A.count).toBe(phase.name === 'plain' ? 12 : 4);
        }
      }
      const windows = trace.flatMap((value, index) => (value === 'resource' ? [index] : []));
      for (let index = 0; index < windows.length; index += 2) {
        const events = trace.slice(windows[index]! + 1, windows[index + 1]!);
        const phase = report.resourceObservations.windows[index / 2]!.phase;
        expect(new Set(events)).toEqual(
          new Set([phase === 'plain' ? 'select' : phase === 'explain-off' ? 'off' : 'on']),
        );
        expect(events).toHaveLength(phase === 'plain' ? 48 : 16);
      }
      expect(Object.keys(report.structures).length).toBeLessThan(10);
      expect(JSON.stringify(report)).not.toContain('PRIVATE');
      expect(JSON.stringify(report)).not.toContain('PERF041-0000001');
    },
  );
  it('retains complete SQL diagnostics when cgroup observations are unavailable', async () => {
    const { runtime } = setup({ unavailable: true });
    const report = await analyzeSearchRepro(runtime, fixture, { replica: 1 });
    expect(report).toMatchObject({
      completed: true,
      equivalent: true,
      protocolCompleted: true,
      resourceObservations: { complete: false },
    });
    expect(
      report.resourceObservations.windows.every((item) => item.delta?.available === false),
    ).toBe(true);
  });
  it('preserves a measured mismatch, partial sample and ending observation and stops further phases', async () => {
    const { runtime } = setup({ failMeasured: true });
    const report = await analyzeSearchRepro(runtime, fixture, { replica: 1 });
    expect(report).toMatchObject({
      completed: false,
      equivalent: false,
      protocolCompleted: false,
      failureCode: 'REPRO_ORACLE_FAILED',
    });
    expect(report.conditions).toHaveLength(1);
    expect(report.conditions[0]!.phases[0]!.samples).toHaveLength(1);
    expect(report.conditions[0]!.phases[0]!.samples[0]!.completed).toBe(false);
    expect(report.resourceObservations.windows[0]!.after).toBeDefined();
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('retains the completed plain phase when a later EXPLAIN shape is rejected', async () => {
    const { runtime } = setup({ badPlan: true });
    const report = await analyzeSearchRepro(runtime, fixture, { replica: 1 });
    expect(report.completed).toBe(false);
    expect(report.failureCode).toBe('QUERY_PLAN_INVALID');
    expect(report.conditions[0]!.phases[0]!.completed).toBe(true);
    expect(report.conditions[0]!.phases[1]!.warmup[0]!.completed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('does not hide an observer hard failure as soft unavailability', async () => {
    const { runtime } = setup({ failResource: true });
    const report = await analyzeSearchRepro(runtime, fixture, { replica: 1 });
    expect(report).toMatchObject({
      completed: false,
      protocolCompleted: false,
      failureCode: 'REPRO_ANALYSIS_FAILED',
    });
    expect(report.resourceObservations.windows[0]!.completed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('aborts without executing discovery or resource observers', async () => {
    const { runtime, query } = setup();
    const abort = new AbortController();
    abort.abort('PRIVATE');
    const report = await analyzeSearchRepro(runtime, fixture, { replica: 1, signal: abort.signal });
    expect(report.failureCode).toBe('REPRO_ABORTED');
    expect(query).not.toHaveBeenCalled();
    expect(runtime.readDatabaseResources).not.toHaveBeenCalled();
  });
});
