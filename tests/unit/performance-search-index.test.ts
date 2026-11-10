import { describe, expect, it, vi } from 'vitest';
import type {
  AnalysisRuntime,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import {
  analyzeSearchIndex,
  sanitizeSearchIndexCatalog,
  summarizeSearchIndexPlan,
} from '../../tools/performance/search-index-analysis.mjs';

const id = (n: number) => `05100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function requiredItem<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('TEST_FIXTURE_ITEM_REQUIRED');
  return value;
}
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
vi.mock('../../tools/performance/search-capacity.mjs', () => ({
  discoverSearchTerms: vi.fn(async (runtime: AnalysisRuntime, input: PerformanceFixture) =>
    runtime.withAppReadOnly(
      { organizationId: input.organizationId, actorId: requiredItem(input.actors[0]).userId },
      async (client) => ({
        proof: client.proof,
        terms: [
          { key: 'short', keyword: 'PRIVATE-short' },
          { key: 'wide', keyword: 'PRIVATE-wide' },
          { key: 'rare', keyword: 'PRIVATE-rare' },
          { key: 'zero', keyword: 'PRIVATE-zero' },
        ],
      }),
    ),
  ),
}));
const fixture: PerformanceFixture = {
  organizationId: id(100),
  controlOrganizationId: id(101),
  controlTicketId: id(102),
  catalogItemId: id(103),
  serviceRequestId: id(104),
  actors: [
    {
      role: 'agent',
      userId: id(1),
      ticketId: id(11),
      ticketSubject: 'PRIVATE-subject',
      email: 'PRIVATE-email',
      password: 'PRIVATE-password',
    },
    {
      role: 'requester',
      userId: id(2),
      ticketId: id(12),
      ticketSubject: 'PRIVATE-subject',
      email: 'PRIVATE-email',
      password: 'PRIVATE-password',
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
    credentials: 2,
    readReceipts: 0,
    attachments: 0,
    controlUsers: 1,
    controlTickets: 1,
  },
};
const environment = () => ({
  version: 160013,
  role: 'solvi_app',
  superuser: false,
  bypass_rls: false,
  owns_ticket: false,
  rls: true,
  force_rls: true,
  rls_active: true,
  estimated_rows: 2401,
  estimated_pages: 240,
  statistics_target: -1,
  collation_provider: 'd',
  deterministic: true,
  default_collation: true,
  visible_column_statistics: false,
  analyze_recorded: true,
});
const index = () => ({
  valid: true,
  ready: true,
  live: true,
  check_xmin: false,
  key_columns: 1,
  all_columns: 1,
  expression: false,
  partial: false,
  search_text_column: true,
  collation_matches: true,
  access_method: 'gin',
  opclass: 'gin_trgm_ops',
  opfamily: 'gin_trgm_ops',
  supports_ilike: true,
});
const operator = () => ({
  operator: '~~*',
  procedure: 'texticlike',
  leakproof: false,
  volatility: 'i',
  strict: true,
  security_definer: false,
});
const row = (own = false): Record<string, unknown> => ({
  id: own ? id(12) : id(11),
  organization_id: fixture.organizationId,
  requester_id: own ? id(2) : id(1),
  created_at: new Date('2026-10-05T00:00:00.123Z'),
  cursor_created_at: '2026-10-05 00:00:00.123456+00',
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
function plan(
  executed: boolean,
  indexed = false,
  loops = 1,
): [
  {
    Plan: Record<string, unknown>;
    'Planning Time'?: number;
    'Execution Time'?: number;
  },
] {
  const leaf: Record<string, unknown> = {
    'Node Type': indexed ? 'Index Scan' : 'Seq Scan',
    'Relation Name': 'ticket',
    'Plan Rows': 1,
    'Startup Cost': 0,
    'Total Cost': 100,
    Filter: "search_text ~~* 'PRIVATE-keyword'",
    Output: ['PRIVATE-output'],
    ...(indexed ? { 'Index Name': 'ticket_search_trgm_idx' } : {}),
    ...(executed
      ? {
          'Actual Rows': loops ? 1 : 0,
          'Actual Loops': loops,
          'Rows Removed by Filter': loops ? 9 : 0,
          'Shared Hit Blocks': 3,
        }
      : {}),
  };
  const root: Record<string, unknown> = {
    'Node Type': 'Aggregate',
    'Plan Rows': 1,
    'Startup Cost': 0,
    'Total Cost': 101,
    Plans: [leaf],
    ...(executed
      ? { 'Actual Rows': 1, 'Actual Loops': 1, 'Shared Hit Blocks': 3, 'Temp Written Blocks': 2 }
      : {}),
  };
  return [{ Plan: root, ...(executed ? { 'Planning Time': 1, 'Execution Time': 3 } : {}) }];
}
type MockOptions = {
  malformedPlan?: boolean;
  restoreFail?: boolean;
  mismatch?: boolean;
  permissionFailure?: boolean;
  autoclose?: boolean;
  settingDrift?: boolean;
  abort?: AbortController;
};
function fakeRuntime(options: MockOptions = {}) {
  const trace: Array<{ sql: string; seqscan: string; params: unknown[] }> = [];
  const source = vi.fn();
  const runtime: AnalysisRuntime = {
    buildTicketListQuery: (_ctx, opts) => ({
      sql: 'SELECT list_result FROM ticket',
      countSql: 'SELECT count_result FROM ticket',
      combinedSql: 'SELECT combined_result FROM ticket',
      params: [opts.filter?.keyword, _ctx.principal.userId, ...(opts.filter?.state ?? [])],
      countParams: [opts.filter?.keyword, _ctx.principal.userId, ...(opts.filter?.state ?? [])],
      limit: 50,
    }),
    async withAppReadOnly(context, callback) {
      source(context);
      let seqscan = 'on';
      return callback({
        proof,
        async query(sql, params = []) {
          trace.push({ sql, seqscan, params });
          if (sql.includes('autoclose_disabled'))
            return { rows: [{ autoclose_disabled: !options.autoclose }] };
          if (sql.includes('server_version_num')) return { rows: [environment()] };
          if (sql.includes('FROM pg_index')) {
            if (options.permissionFailure) throw new Error('PRIVATE-catalog-error');
            return { rows: [index()] };
          }
          if (sql.includes('FROM pg_operator')) return { rows: [operator()] };
          if (sql.startsWith('SELECT state FROM')) return { rows: [{ state: 'assigned' }] };
          if (sql.includes('JOIN app_user')) return { rows: [{ code: 'requester' }] };
          if (sql.includes('set_config')) {
            if (options.restoreFail && params[0] === 'on') throw new Error('PRIVATE-restore-error');
            seqscan = String(params[0]);
            return { rows: [{ seqscan }] };
          }
          if (sql.includes("current_setting('enable_seqscan')"))
            return {
              rows: [
                {
                  seqscan,
                  indexscan: options.settingDrift && seqscan === 'off' ? 'off' : 'on',
                  bitmapscan: 'on',
                  jit: 'on',
                  row_security: 'on',
                },
              ],
            };
          if (sql.startsWith('EXPLAIN')) {
            const executed = sql.includes('ANALYZE');
            if (seqscan === 'off' && executed) throw new Error('PRIVATE-forbidden-execution');
            const document = plan(executed);
            if (!executed && options.malformedPlan)
              document[0].Plan['Node Type'] = 'PRIVATE-unknown';
            if (!executed && options.abort) options.abort.abort();
            return { rows: [{ 'QUERY PLAN': document }] };
          }
          const foreign = context.organizationId !== fixture.organizationId;
          if (sql === 'SELECT id FROM ticket WHERE organization_id=$1 AND id=$2')
            return { rows: foreign ? [] : [{ id: params[1] }] };
          const zero = params[0] === 'PRIVATE-zero' || foreign;
          if (sql.includes('count_result')) return { rows: [{ total: zero ? 0 : 1 }] };
          const value = row(params[1] === id(2));
          if (sql.includes('list_result')) return { rows: zero ? [] : [value] };
          if (sql.includes('combined_result')) {
            if (options.mismatch) value.created_at = String(value.created_at);
            return {
              rows: [
                {
                  ...(zero ? Object.fromEntries(Object.keys(value).map((k) => [k, null])) : value),
                  __solvi_total: zero ? 0 : 1,
                },
              ],
            };
          }
          throw new Error('PRIVATE-unexpected-query');
        },
      });
    },
  };
  return { runtime, trace, source };
}

describe('WP051 catalog facts', () => {
  it('records unhealthy/absent index and invisible statistics without pretending to know their cause', () => {
    expect(sanitizeSearchIndexCatalog('index', [{ ...index(), valid: false }])).toMatchObject({
      present: true,
      valid: false,
    });
    expect(sanitizeSearchIndexCatalog('index', [])).toEqual({ present: false });
    expect(
      sanitizeSearchIndexCatalog('environment', [{ ...environment(), estimated_rows: -1 }]),
    ).toMatchObject({
      estimatedRows: null,
      estimatedRowsKnown: false,
      statisticsVisibility: 'not-visible-or-absent',
    });
    expect(sanitizeSearchIndexCatalog('operator', [operator()])).toMatchObject({
      leakproof: false,
      procedure: 'texticlike',
    });
  });
  it.each(['role', 'collation_provider', 'estimated_rows'] as const)(
    'rejects unknown or malformed environment field %s',
    (key) => {
      expect(() =>
        sanitizeSearchIndexCatalog('environment', [
          { ...environment(), [key]: key === 'estimated_rows' ? -0.5 : 'PRIVATE-secret' },
        ]),
      ).toThrow('INDEX_CATALOG_INVALID');
    },
  );
  it('rejects unknown opclass, strings instead of booleans, unsafe role and unexpected procedure', () => {
    expect(() =>
      sanitizeSearchIndexCatalog('index', [{ ...index(), opclass: 'PRIVATE-secret' }]),
    ).toThrow('INDEX_CATALOG_INVALID');
    expect(() => sanitizeSearchIndexCatalog('index', [{ ...index(), ready: 'true' }])).toThrow(
      'INDEX_CATALOG_INVALID',
    );
    expect(() =>
      sanitizeSearchIndexCatalog('environment', [{ ...environment(), bypass_rls: true }]),
    ).toThrow('INDEX_CATALOG_INVALID');
    expect(() =>
      sanitizeSearchIndexCatalog('operator', [{ ...operator(), procedure: 'PRIVATE-secret' }]),
    ).toThrow('INDEX_CATALOG_INVALID');
  });
});
describe('WP051 actual versus plan-only evidence', () => {
  it('keeps execution metrics only in the actual plan, root buffers once and no raw predicates', () => {
    const actual = summarizeSearchIndexPlan(plan(true), true);
    expect(actual.ticketScans[0]).toMatchObject({
      loops: 1,
      returnedRows: 1,
      visitedRows: 10,
      searchPredicate: true,
    });
    expect(actual.rootBuffers).toMatchObject({ sharedHitBlocks: 3, tempWrittenBlocks: 2 });
    const costOnly = summarizeSearchIndexPlan(plan(false), false);
    expect(costOnly).not.toHaveProperty('executionMs');
    expect(costOnly).not.toHaveProperty('rootBuffers');
    expect(costOnly.ticketScans[0]).not.toHaveProperty('visitedRows');
    expect(JSON.stringify([actual, costOnly])).not.toContain('PRIVATE');
  });
  it('distinguishes planned GIN, unexecuted branch and executed GIN', () => {
    expect(summarizeSearchIndexPlan(plan(false, true), false)).toMatchObject({
      searchGinPlanned: true,
      searchGinExecuted: null,
    });
    expect(summarizeSearchIndexPlan(plan(true, true, 0), true)).toMatchObject({
      searchGinPlanned: true,
      searchGinExecuted: false,
    });
    expect(summarizeSearchIndexPlan(plan(true, true), true)).toMatchObject({
      searchGinPlanned: true,
      searchGinExecuted: true,
      eligibilityEstablished: false,
    });
  });
  it('classifies rejected plan fields without retaining their values in either mode', () => {
    const invalidFields: Array<[string, unknown, string]> = [
      ['Node Type', 'PRIVATE-node', 'INDEX_PLAN_NODE_REJECTED'],
      ['Index Name', 'private_secret_index', 'INDEX_PLAN_INDEX_REJECTED'],
      ['Relation Name', 'PRIVATE-relation', 'INDEX_PLAN_RELATION_REJECTED'],
      ['CTE Name', 'PRIVATE-cte', 'INDEX_PLAN_CTE_REJECTED'],
      ['Parent Relationship', 'PRIVATE-parent', 'INDEX_PLAN_PARENT_REJECTED'],
      ['Join Type', 'PRIVATE-join', 'INDEX_PLAN_JOIN_REJECTED'],
      ['Scan Direction', 'PRIVATE-direction', 'INDEX_PLAN_DIRECTION_REJECTED'],
      ['Subplan Name', 'PRIVATE-subplan', 'INDEX_PLAN_SUBPLAN_REJECTED'],
      ['Plan Rows', -1, 'INDEX_PLAN_NUMBER_INVALID'],
    ];
    for (const executed of [false, true]) {
      for (const [key, value, code] of invalidFields) {
        const doc = plan(executed);
        doc[0].Plan[key] = value;
        expect(() => summarizeSearchIndexPlan(doc, executed)).toThrow(new Error(code));
      }
    }
    expect(() => summarizeSearchIndexPlan(plan(true), false)).toThrow(
      'INDEX_PLAN_EXECUTION_UNEXPECTED',
    );
  });
  it('accepts only the existing group organization/code index and preserves plan-only semantics', () => {
    const doc = plan(false);
    doc[0].Plan = {
      'Node Type': 'Index Scan',
      'Relation Name': 'assignment_group',
      'Index Name': 'assignment_group_code_key',
      'Plan Rows': 2,
      'Startup Cost': 0,
      'Total Cost': 8,
      'Index Cond': 'PRIVATE-organization-predicate',
    };
    const result = summarizeSearchIndexPlan(doc, false);
    expect(result.indexes).toEqual(['assignment_group_code_key']);
    expect(result.searchGinPlanned).toBe(false);
    expect(result.searchGinExecuted).toBeNull();
    expect(result).not.toHaveProperty('executionMs');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    for (const name of ['assignment_group_code_key_unknown', 'assignment_group_active_idx']) {
      doc[0].Plan['Index Name'] = name;
      expect(() => summarizeSearchIndexPlan(doc, false)).toThrow('INDEX_PLAN_INDEX_REJECTED');
    }
  });
});
describe('WP051 bounded diagnostic protocol', () => {
  it('executes all three result forms, 28 distinct plans, own/foreign checks and restores only seqscan', async () => {
    const { runtime, trace } = fakeRuntime();
    const progress: string[] = [];
    const result = await analyzeSearchIndex(runtime, fixture, {
      onProgress: (s) => {
        progress.push(s);
      },
    });
    expect(result).toMatchObject({
      completed: true,
      equivalent: true,
      protocolCompleted: true,
      catalogComplete: true,
      restorationVerified: true,
      adoptionEstablished: false,
    });
    expect(result.conditions).toHaveLength(7);
    expect(result.readOnlyContexts).toHaveLength(11);
    expect(result.readOnlyContexts.every((entry) => entry.autocloseDisabled === true)).toBe(true);
    expect(result.boundaries).toHaveLength(2);
    expect(result.equalityControls).toHaveLength(2);
    expect(
      result.conditions.every(
        (c) =>
          c.setting.before?.seqscan === 'on' &&
          c.setting.during?.seqscan === 'off' &&
          c.setting.after?.seqscan === 'on',
      ),
    ).toBe(true);
    expect(trace.filter((x) => x.sql.startsWith('EXPLAIN (FORMAT JSON)'))).toHaveLength(14);
    expect(trace.filter((x) => x.sql.includes('EXPLAIN (ANALYZE'))).toHaveLength(16);
    expect(trace.filter((x) => x.sql.includes('set_config')).map((x) => x.params[0])).toEqual(
      Array.from({ length: 7 }, () => ['off', 'on']).flat(),
    );
    expect(progress).toHaveLength(10);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|05100000|enable_seqscan|search_text ~~\*/);
  });
  it('preserves native Date/string mismatch and stops before plan or setting mutation', async () => {
    const { runtime, trace } = fakeRuntime({ mismatch: true });
    const result = await analyzeSearchIndex(runtime, fixture);
    expect(result).toMatchObject({ completed: false, failureCode: 'INDEX_EQUIVALENCE_FAILED' });
    expect(requiredItem(result.conditions[0]).comparison?.fullRows).toBe(false);
    expect(trace.some((x) => x.sql.startsWith('EXPLAIN') || x.sql.includes('set_config'))).toBe(
      false,
    );
  });
  it('restores after invalid plan and preserves prior actual plans without raw failure details', async () => {
    const { runtime, trace } = fakeRuntime({ malformedPlan: true });
    const result = await analyzeSearchIndex(runtime, fixture);
    expect(result.failureCode).toBe('INDEX_PLAN_NODE_REJECTED');
    expect(requiredItem(result.conditions[0]).normal.count?.executed).toBe(true);
    expect(requiredItem(result.conditions[0]).setting.restored).toBe(true);
    expect(trace.at(-2)?.params).toEqual(['on']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('never reports restoration verified if restoration fails', async () => {
    const { runtime } = fakeRuntime({ restoreFail: true });
    const result = await analyzeSearchIndex(runtime, fixture);
    expect(result).toMatchObject({
      completed: false,
      restorationVerified: false,
      failureCode: 'INDEX_RESTORATION_FAILED',
    });
    expect(requiredItem(result.conditions[0]).setting.restored).toBe(false);
  });
  it('rejects another setting changing in the cost-control window and still restores seqscan', async () => {
    const { runtime } = fakeRuntime({ settingDrift: true });
    const result = await analyzeSearchIndex(runtime, fixture);
    expect(result.failureCode).toBe('INDEX_SETTINGS_INVALID');
    expect(requiredItem(result.conditions[0]).setting.restored).toBe(true);
  });
  it('rejects the special autoclose policy context before catalog or business queries', async () => {
    const { runtime, trace } = fakeRuntime({ autoclose: true });
    const result = await analyzeSearchIndex(runtime, fixture);
    expect(result.failureCode).toBe('INDEX_SETTINGS_INVALID');
    expect(trace).toHaveLength(1);
  });
  it('retains the completed catalog entry and marks missing observations without exposing the driver error', async () => {
    const { runtime } = fakeRuntime({ permissionFailure: true });
    const result = await analyzeSearchIndex(runtime, fixture);
    expect(result.catalogComplete).toBe(false);
    expect(result.catalog.environment?.available).toBe(true);
    expect(result.catalog.index?.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('attempts setting restoration even when abort arrives in plan-only EXPLAIN', async () => {
    const abort = new AbortController();
    const { runtime, trace } = fakeRuntime({ abort });
    const result = await analyzeSearchIndex(runtime, fixture, { signal: abort.signal });
    expect(result.failureCode).toBe('INDEX_ABORTED');
    expect(requiredItem(result.conditions[0]).setting.restored).toBe(true);
    expect(trace.at(-2)?.params).toEqual(['on']);
  });
  it('does not enter an app context if already aborted', async () => {
    const { runtime, source } = fakeRuntime();
    const abort = new AbortController();
    abort.abort();
    expect((await analyzeSearchIndex(runtime, fixture, { signal: abort.signal })).failureCode).toBe(
      'INDEX_ABORTED',
    );
    expect(source).not.toHaveBeenCalled();
  });
});
