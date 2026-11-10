import { describe, expect, it, vi } from 'vitest';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type {
  AnalysisClient,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import { buildDeadlineBoundaryQuery } from '../../tools/performance/deadline-analysis.mjs';
import {
  compareSearchResults,
  prepareSearchBoundary,
} from '../../tools/performance/search-analysis.mjs';
import {
  createSearchSemanticRuntime,
  measureSearchStatements,
  normalizeSearchCombinedRows,
  runSearchCostAnalysis,
  summarizeSearchCostPlan,
  type SearchCostQuery,
  type SearchCostRuntime,
  type SearchCostSample,
} from '../../tools/performance/search-cost-analysis.mjs';

const id = (n: number) => `04700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture: PerformanceFixture = {
  organizationId: id(501),
  controlOrganizationId: id(502),
  controlTicketId: id(503),
  catalogItemId: id(504),
  serviceRequestId: id(505),
  actors: [
    {
      userId: id(601),
      role: 'agent',
      email: 'PRIVATE-email',
      password: 'PRIVATE-password',
      ticketId: id(1),
      ticketSubject: 'PRIVATE-subject',
    },
    {
      userId: id(602),
      role: 'requester',
      email: 'PRIVATE-email',
      password: 'PRIVATE-password',
      ticketId: id(2),
      ticketSubject: 'PRIVATE-subject',
    },
  ],
  counts: {
    users: 2,
    tickets: 350,
    states: [],
    usersByStatus: [],
    roles: [],
    priorities: [],
    assignment: [],
    groups: 2,
    memberships: 1,
    comments: 0,
    catalog: 0,
    approvals: 0,
    credentials: 2,
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
const ctx: AuthzContext = {
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
};
const timestamp = '2026-10-05 00:00:00.123456+00';
const row = () => ({
  id: id(1),
  organization_id: fixture.organizationId,
  requester_id: id(602),
  cursor_created_at: timestamp,
  created_at: new Date(timestamp),
  assignee_name: 'PRIVATE-name',
  requester_name: null,
  assignee_group_name: null,
  sla_elapsed_now: 1,
  remaining_seconds: null,
  response_target_minutes: null,
  resolution_target_minutes: null,
  sla_elapsed_seconds: 1,
  sla_clock_started_at: new Date(timestamp),
});
const built: SearchCostQuery = {
  sql: 'SELECT original FROM ticket',
  params: [fixture.organizationId, 50],
  countSql: 'SELECT count(*)::int AS total FROM ticket',
  countParams: [fixture.organizationId],
  limit: 50,
  combinedSql: 'SELECT combined FROM ticket',
};

function plan(
  combined = false,
  duplicatePredicate = false,
  options: {
    predicateLoops?: number;
    fullPageScan?: boolean;
    pageIndexName?: string;
    pageIndexCond?: string;
  } = {},
) {
  const scan = {
    'Node Type': 'Seq Scan',
    'Relation Name': 'ticket',
    Alias: 't',
    'Actual Loops': options.predicateLoops ?? 1,
    'Actual Rows': 10,
    'Rows Removed by Filter': 90,
    Filter: "search_text ~~* 'PRIVATE-term'",
    'Subplan Name': combined ? 'CTE matched' : undefined,
  };
  let page: Record<string, unknown> = {
    'Node Type': 'Limit',
    'Actual Rows': 1,
    'Actual Loops': 1,
    Plans: [
      { 'Node Type': 'CTE Scan', 'CTE Name': 'matched', 'Actual Rows': 10, 'Actual Loops': 1 },
    ],
  };
  page = {
    'Node Type': 'Nested Loop',
    'Actual Rows': 1,
    'Actual Loops': 1,
    Plans: [
      page,
      {
        'Node Type': options.fullPageScan ? 'Seq Scan' : 'Index Scan',
        'Relation Name': 'ticket',
        'Index Name': options.pageIndexName ?? 'ticket_pkey',
        'Actual Rows': 1,
        'Actual Loops': 1,
        'Rows Removed by Filter': options.fullPageScan ? 99999 : 0,
        'Index Cond': options.pageIndexCond ?? "id = 'PRIVATE-id'",
      },
    ],
  };
  for (const alias of ['assignee', 'requester', 'assignee_group']) {
    page = {
      'Node Type': 'Nested Loop',
      'Actual Rows': 1,
      'Actual Loops': 1,
      Plans: [
        page,
        { 'Node Type': 'Index Scan', Alias: alias, 'Actual Rows': 1, 'Actual Loops': 1 },
      ],
    };
  }
  return [
    {
      Plan: {
        'Node Type': 'Nested Loop',
        'Actual Rows': 1,
        'Actual Loops': 1,
        'Shared Hit Blocks': 100,
        'Temp Read Blocks': 3,
        'Temp Written Blocks': 4,
        Plans: [
          scan,
          ...(duplicatePredicate ? [{ ...scan }] : []),
          { 'Node Type': 'CTE Scan', 'CTE Name': 'matched', 'Actual Rows': 10, 'Actual Loops': 1 },
          page,
        ],
      },
      'Planning Time': 0.1,
      'Execution Time': 2,
    },
  ];
}

describe('WP047 native combined results', () => {
  it('preserves Date identities and full cursor text while removing only private total', () => {
    const native = row();
    const input = { ...native, __solvi_total: 10 };
    const result = normalizeSearchCombinedRows([input], 50);
    expect(result).toEqual({ rows: [native], total: 10 });
    expect(result.rows[0]!.created_at).toBe(native.created_at);
    expect(result.rows[0]!.cursor_created_at).toBe(timestamp);
    expect(input.__solvi_total).toBe(10);
    expect(Object.hasOwn(result.rows[0]!, '__solvi_total')).toBe(false);
    expect(
      compareSearchResults(result, {
        rows: [{ ...native, created_at: native.created_at.toISOString() }],
        total: 10,
      }).equal,
    ).toBe(false);
  });
  it('preserves nonzero exact total at an empty cursor terminal', () => {
    expect(
      normalizeSearchCombinedRows(
        [
          {
            ...Object.fromEntries(Object.keys(row()).map((key) => [key, null])),
            __solvi_total: 100,
          },
        ],
        50,
      ),
    ).toEqual({ rows: [], total: 100 });
  });
  it.each(
    [
      [],
      [{ ...row(), __solvi_total: '10' }],
      [{ ...row(), __solvi_total: -1 }],
      [
        { ...row(), __solvi_total: 2 },
        { ...row(), __solvi_total: 3 },
      ],
      [
        { id: null, cursor_created_at: null, __solvi_total: 2 },
        { ...row(), __solvi_total: 2 },
      ],
      [{ id: null, cursor_created_at: 'PRIVATE-malformed', __solvi_total: 2 }],
      [{ __solvi_total: 0 }],
      [{ ...row(), __solvi_total: 0 }],
    ].map((input) => ({ input })),
  )('rejects malformed, mixed or inconsistent envelopes', ({ input }) => {
    expect(() => normalizeSearchCombinedRows(input, 50)).toThrow();
  });
});

describe('WP047 semantic runtime adapter', () => {
  function setup() {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ ...row(), __solvi_total: 10 }],
    }));
    const runtime: SearchCostRuntime = {
      buildTicketListQuery: () => built,
      buildLegacySearchWorkloadQuery: () => ({ ...built, combinedSql: undefined }),
      withAppReadOnly: async (_context, callback) => callback({ query, proof }),
    };
    return { query, runtime, adapted: createSearchSemanticRuntime(runtime, fixture) };
  }
  it('executes actual combined SQL once and gets the count from that exact result', async () => {
    const { query, adapted } = setup();
    const candidate = adapted.runtime.buildTicketListQuery(ctx, {});
    await adapted.runtime.withAppReadOnly(
      { organizationId: fixture.organizationId, actorId: id(601) },
      async (client) => {
        const result = await client.query(candidate.sql, candidate.params);
        const count = await client.query(candidate.countSql, candidate.countParams);
        expect(result.rows).toEqual([row()]);
        expect(count.rows).toEqual([{ total: 10 }]);
      },
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(built.combinedSql, built.params);
    expect(adapted.stats).toEqual({ combinedExecutions: 1, reusedTotals: 1 });
  });
  it('wraps and executes the combined SQL inside synthetic shadow tables', async () => {
    const { query, adapted } = setup();
    const candidate = adapted.runtime.buildTicketListQuery(ctx, {});
    // The SQL wrapper uses only table data, not the search-specific expected-name oracle.
    const boundary = { ...prepareSearchBoundary(fixture), expected: [] };
    const list = buildDeadlineBoundaryQuery(
      { sql: candidate.sql, params: candidate.params },
      boundary,
    );
    const count = buildDeadlineBoundaryQuery(
      { sql: candidate.countSql, params: candidate.countParams },
      boundary,
    );
    await adapted.runtime.withAppReadOnly(
      { organizationId: fixture.organizationId, actorId: id(601) },
      async (client) => {
        expect((await client.query(list.sql, list.params)).rows).toEqual([row()]);
        expect((await client.query(count.sql, count.params)).rows).toEqual([{ total: 10 }]);
      },
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(list.sql, list.params);
    expect(list.sql).toContain(built.combinedSql);
  });
  it('does not return a cached total for a different SQL or parameter set', async () => {
    const { adapted } = setup();
    const candidate = adapted.runtime.buildTicketListQuery(ctx, {});
    await expect(
      adapted.runtime.withAppReadOnly(
        { organizationId: fixture.organizationId, actorId: id(601) },
        async (client) => {
          await client.query(candidate.sql, candidate.params);
          await client.query(candidate.countSql, ['different-org']);
        },
      ),
    ).rejects.toThrow('SEARCH_COST_ADAPTER_SEQUENCE');
  });
});

describe('WP047 statement costs', () => {
  it('distinguishes one predicate scan from selected-ticket PK fetches and records spill', () => {
    const work = summarizeSearchCostPlan(plan(true), 1);
    expect(work.predicateScanNodes).toBe(1);
    expect(work.predicateScannedOnce).toBe(true);
    expect(work.predicateRowsVisited).toBe(100);
    expect(work.pageTicketRows).toBe(1);
    expect(work.pageTicketLookupsBounded).toBe(true);
    expect(work.materializedOnce).toBe(true);
    expect(work.matchedReused).toBe(true);
    expect(work.limitBeforeDisplayJoins).toBe(true);
    expect(work.resources).toEqual({
      sharedHitBlocks: 100,
      sharedReadBlocks: 0,
      tempReadBlocks: 3,
      tempWrittenBlocks: 4,
    });
    expect(JSON.stringify(work)).not.toMatch(/PRIVATE|search_text|"Filter"|"Index Cond"/);
    expect(summarizeSearchCostPlan(plan(true, true), 1).predicateScanNodes).toBe(2);
  });
  it('does not call one predicate plan node executed twice a single scan', () => {
    const work = summarizeSearchCostPlan(plan(true, false, { predicateLoops: 2 }), 1);
    expect(work.predicateScanNodes).toBe(1);
    expect(work.predicateRowsVisited).toBe(200);
    expect(work.predicateScannedOnce).toBe(false);
  });
  it('rejects a full page-table scan even when filtering returns only the selected row', () => {
    const work = summarizeSearchCostPlan(plan(true, false, { fullPageScan: true }), 1);
    expect(work.pageTicketRows).toBe(1);
    expect(work.pageTicketLookups[0]!.visitedRows).toBe(100000);
    expect(work.pageTicketLookups[0]!.uniqueIdLookup).toBe(false);
    expect(work.pageTicketLookupsBounded).toBe(false);
  });
  it.each(['ticket_pkey', 'ticket_id_org_asset_key'])(
    'accepts bounded id equality through existing unique index %s',
    (pageIndexName) => {
      const work = summarizeSearchCostPlan(plan(true, false, { pageIndexName }), 1);
      expect(work.pageTicketLookups[0]!.uniqueIdLookup).toBe(true);
      expect(work.pageTicketLookupsBounded).toBe(true);
    },
  );
  it.each(['ticket_list_org_idx', 'unknown_ticket_unique_index'])(
    'rejects non-allowlisted index %s even with bounded id equality',
    (pageIndexName) => {
      const work = summarizeSearchCostPlan(plan(true, false, { pageIndexName }), 1);
      expect(work.pageTicketRows).toBe(1);
      expect(work.pageTicketLookups[0]!.uniqueIdLookup).toBe(false);
      expect(work.pageTicketLookupsBounded).toBe(false);
    },
  );
  it('still requires id equality when the composite unique index is selected', () => {
    const work = summarizeSearchCostPlan(
      plan(true, false, {
        pageIndexName: 'ticket_id_org_asset_key',
        pageIndexCond: "organization_id = 'PRIVATE-org'",
      }),
      1,
    );
    expect(work.pageTicketLookups[0]!.uniqueIdLookup).toBe(false);
    expect(work.pageTicketLookupsBounded).toBe(false);
  });
  it('decodes combined results and records the composite unique lookup without leaking conditions', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('EXPLAIN')
        ? [{ 'QUERY PLAN': plan(true, false, { pageIndexName: 'ticket_id_org_asset_key' }) }]
        : [{ ...row(), __solvi_total: 10 }],
    }));
    const sample: SearchCostSample = {};
    const result = await measureSearchStatements({
      client: { query },
      built,
      order: ['list', 'count'],
      sample,
    });
    expect(result).toEqual({ rows: [row()], total: 10 });
    expect(sample.statements).toHaveLength(1);
    expect(sample.statements![0]!.work?.pageTicketLookups[0]!.uniqueIdLookup).toBe(true);
    expect(sample.statements![0]!.work?.pageTicketLookupsBounded).toBe(true);
    expect(JSON.stringify(sample)).not.toContain('PRIVATE');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('retains the completed first statement and measured partial second statement on explain failure', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('EXPLAIN') && sql.includes('count(*)'))
        throw new Error('PRIVATE-db-error');
      return {
        rows: sql.startsWith('EXPLAIN')
          ? [{ 'QUERY PLAN': plan() }]
          : sql.includes('count(*)')
            ? [{ total: 10 }]
            : [row()],
      };
    });
    const sample: SearchCostSample = {};
    await expect(
      measureSearchStatements({
        client: { query },
        built: { ...built, combinedSql: undefined },
        order: ['list', 'count'],
        sample,
      }),
    ).rejects.toThrow('PRIVATE-db-error');
    expect(sample.statements).toHaveLength(2);
    expect(sample.statements![0]!.completed).toBe(true);
    expect(sample.statements![0]!.work?.predicateRowsVisited).toBe(100);
    expect(sample.statements![1]!.completed).toBe(false);
    expect(sample.statements![1]!.wallMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(sample)).not.toContain('PRIVATE');
  });
  it('executes the requested old count/list order and combined exactly once plus one EXPLAIN', async () => {
    const query: AnalysisClient['query'] = vi.fn(async (sql) => ({
      rows: sql.startsWith('EXPLAIN')
        ? [{ 'QUERY PLAN': plan(true) }]
        : sql === built.combinedSql
          ? [{ ...row(), __solvi_total: 10 }]
          : sql.includes('count(*)')
            ? [{ total: 10 }]
            : [row()],
    }));
    const oldSample: SearchCostSample = {},
      newSample: SearchCostSample = {};
    const old = await measureSearchStatements({
      client: { query },
      built: { ...built, combinedSql: undefined },
      order: ['count', 'list'],
      sample: oldSample,
    });
    const next = await measureSearchStatements({
      client: { query },
      built,
      order: ['count', 'list'],
      sample: newSample,
    });
    expect(oldSample.order).toEqual(['count', 'list']);
    expect(newSample.order).toEqual(['combined']);
    expect(compareSearchResults(old, next).equal).toBe(true);
    expect(query).toHaveBeenCalledTimes(6);
  });
  it('rejects before querying when aborted and returns only a safe fixed failure code', async () => {
    const controller = new AbortController();
    controller.abort(new Error('PRIVATE-secret'));
    const runtime: SearchCostRuntime = {
      buildTicketListQuery: () => built,
      buildLegacySearchWorkloadQuery: () => built,
      withAppReadOnly: vi.fn(),
    };
    const result = await runSearchCostAnalysis({ runtime, fixture, signal: controller.signal });
    expect(result.completed).toBe(false);
    expect(result.failureCode).toBe('SEARCH_COST_ABORTED');
    expect(runtime.withAppReadOnly).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
