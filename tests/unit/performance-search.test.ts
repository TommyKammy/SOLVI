import { describe, expect, it } from 'vitest';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type {
  BuiltQuery,
  ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type {
  QueryResultData,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import {
  SEARCH_KEYWORD,
  checkSearchBoundary,
  compareSearchContracts,
  compareSearchResults,
  prepareSearchBoundary,
  runSearchAnalysis,
  summarizeSearchPlan,
  type SearchBoundary,
  type SearchRuntime,
} from '../../tools/performance/search-analysis.mjs';

const id = (n: number) => `04600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture: PerformanceFixture = {
  organizationId: id(501),
  controlOrganizationId: id(502),
  controlTicketId: id(503),
  catalogItemId: id(504),
  serviceRequestId: id(505),
  actors: [
    {
      userId: id(601),
      email: 'PRIVATE-agent@example.test',
      password: 'PRIVATE-password',
      role: 'agent',
      ticketId: id(1),
      ticketSubject: 'PRIVATE-subject',
    },
    {
      userId: id(602),
      email: 'PRIVATE-requester@example.test',
      password: 'PRIVATE-password',
      role: 'requester',
      ticketId: id(1),
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
const cursorTimestamp = '2026-10-05 00:00:00.123456+00';
function row(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: id(1),
    organization_id: fixture.organizationId,
    requester_id: fixture.actors[1]!.userId,
    cursor_created_at: cursorTimestamp,
    created_at: new Date(cursorTimestamp),
    assignee_name: 'PRIVATE-agent',
    requester_name: 'PRIVATE-requester',
    assignee_group_name: 'PRIVATE-group',
    sla_elapsed_now: 20,
    remaining_seconds: 40,
    response_target_minutes: 1,
    resolution_target_minutes: 1,
    sla_elapsed_seconds: 20,
    sla_clock_started_at: null,
    subject: 'PRIVATE-subject',
    body: 'PRIVATE-body',
    kind: 'incident',
    state: 'new',
    ...changes,
  };
}
function plan(projected: boolean, returned: number, candidates: number, fullUserScan = false) {
  let node: Record<string, unknown> = {
    'Node Type': 'Seq Scan',
    'Actual Rows': candidates,
    'Actual Loops': 1,
    Filter: 'PRIVATE-query-and-secret',
  };
  if (projected)
    node = { 'Node Type': 'Limit', 'Actual Rows': returned, 'Actual Loops': 1, Plans: [node] };
  for (const alias of ['assignee', 'requester', 'assignee_group']) {
    const group = alias === 'assignee_group';
    node = {
      'Node Type': group ? 'Hash Join' : 'Nested Loop',
      'Actual Rows': projected ? returned : candidates,
      'Actual Loops': 1,
      Plans: [
        node,
        {
          'Node Type': group || fullUserScan ? 'Seq Scan' : 'Index Scan',
          Alias: alias,
          'Actual Rows': group ? 2 : fullUserScan ? 4000 : 1,
          'Actual Loops': group || fullUserScan ? 1 : projected ? returned : candidates,
          'Index Cond': 'PRIVATE-email',
        },
      ],
    };
  }
  if (!projected)
    node = { 'Node Type': 'Limit', 'Actual Rows': returned, 'Actual Loops': 1, Plans: [node] };
  return [{ Plan: node, 'Planning Time': 0.1, 'Execution Time': projected ? 1 : 10 }];
}
function boundaryRows(boundary: SearchBoundary): Record<string, unknown>[] {
  return boundary.expected.map((expected) => {
    const ticket = boundary.tickets.find((ticket) => ticket.id === expected.id)!;
    return row({
      ...ticket,
      requester_id: expected.requesterId,
      assignee_name: expected.assigneeName,
      requester_name: expected.requesterName,
      assignee_group_name: expected.groupName,
      remaining_seconds: expected.remainingSeconds,
      sla_elapsed_now: expected.elapsed,
    });
  });
}
type Payload = { ctx: AuthzContext; options: ListOptions };
type FakeOptions = {
  before?: boolean;
  alteredField?: boolean;
  invalidRow?: boolean;
  badProof?: boolean;
  badBinding?: boolean;
  failCandidateCountPlan?: boolean;
  brokenCursor?: boolean;
  emptyExpected?: boolean;
  abort?: AbortController;
  unsafeSql?: boolean;
  stringCount?: boolean;
};
function fakeRuntime(settings: FakeOptions = {}): SearchRuntime {
  const boundary = prepareSearchBoundary(fixture);
  const data = Array.from({ length: 350 }, (_, index) => {
    const n = index + 1;
    return row({
      id: id(n),
      number: `PERF046-${String(n).padStart(7, '0')}`,
      search_text: `PERF046-${String(n).padStart(7, '0')} 合成性能問い合わせ ${n}`,
      requester_id: n % 2 ? fixture.actors[1]!.userId : fixture.actors[0]!.userId,
      assignee_group_id: n % 3 ? id(701) : null,
      assignee_id: n % 5 ? fixture.actors[0]!.userId : null,
      priority: n % 4 ? 'high' : 'low',
      state: ['new', 'assigned', 'in_progress'][n % 3],
    });
  });
  const build = (ctx: AuthzContext, options: ListOptions, candidate: boolean): BuiltQuery => {
    const payload = { ctx, options };
    const effective =
      options.sort?.column === 'created_at' && Boolean(options.filter?.keyword?.trim());
    return {
      sql: settings.unsafeSql
        ? 'SELECT unsafe; DELETE FROM ticket'
        : `SELECT ${candidate && effective && !settings.before ? 'candidate' : 'legacy'} FROM ticket t`,
      countSql: 'SELECT count(*)::int AS total FROM ticket t',
      params: [payload],
      countParams: [payload],
      limit: options.limit ?? 50,
    };
  };
  return {
    buildLegacySearchQuery: (ctx, options) => build(ctx, options, false),
    buildTicketListQuery: (ctx, options) => build(ctx, options, true),
    withAppReadOnly: async (context, callback) => {
      let activeCandidate = false;
      return callback({
        proof: settings.badProof
          ? ({ ...proof, readOnly: false } as unknown as ReadOnlyProof)
          : proof,
        query: async (sql, params = []) => {
          if (sql.includes('SELECT rb.user_id'))
            return {
              rows: settings.badBinding
                ? []
                : [
                    { user_id: fixture.actors[0]!.userId, code: 'agent' },
                    { user_id: fixture.actors[1]!.userId, code: 'requester' },
                  ],
            };
          if (sql.startsWith('SELECT id FROM assignment_group')) return { rows: [{ id: id(701) }] };
          if (sql.startsWith('SELECT number FROM ticket'))
            return { rows: [{ number: 'PERF046-0000001' }] };
          if (sql.startsWith('SELECT count(*)::int n FROM ticket')) return { rows: [{ n: 1 }] };
          const { ctx, options } = params[0] as Payload;
          const synthetic = sql.includes('jsonb_array_elements');
          const keyword = options.filter?.keyword?.trim().toLowerCase() ?? '';
          let eligible = (synthetic ? boundaryRows(boundary) : data).filter(
            (value) =>
              context.organizationId === fixture.organizationId &&
              value.organization_id === ctx.organizationId &&
              String(value.search_text).toLowerCase().includes(keyword) &&
              (ctx.principal.bindings[0]!.roleCode !== 'requester' ||
                value.requester_id === ctx.principal.userId) &&
              (!options.filter?.assigneeGroupIds ||
                options.filter.assigneeGroupIds.includes(String(value.assignee_group_id))) &&
              (!options.filter?.ungroupedOnly || value.assignee_group_id === null) &&
              (!options.filter?.unassignedOnly || value.assignee_id === null) &&
              (!options.filter?.priority ||
                options.filter.priority.includes(value.priority as 'low')),
          );
          if (settings.emptyExpected && keyword === SEARCH_KEYWORD) eligible = [];
          const total = eligible.length;
          eligible.sort((a, b) =>
            options.sort?.direction === 'asc'
              ? String(a.id).localeCompare(String(b.id))
              : String(b.id).localeCompare(String(a.id)),
          );
          const page = eligible
            .filter(
              (value) =>
                !options.cursor ||
                (options.sort?.direction === 'asc'
                  ? String(value.id) > options.cursor.id
                  : String(value.id) < options.cursor.id),
            )
            .slice(0, options.limit ?? 50);
          const count = sql.includes('SELECT count(*)::int AS total');
          if (!count) activeCandidate = sql.includes('SELECT candidate');
          if (sql.startsWith('EXPLAIN')) {
            if (count && activeCandidate && settings.failCandidateCountPlan)
              throw new Error('PRIVATE-driver-password');
            return {
              rows: [
                {
                  'QUERY PLAN': count
                    ? [
                        {
                          Plan: { 'Node Type': 'Aggregate', 'Actual Rows': 1, 'Actual Loops': 1 },
                          'Planning Time': 0.1,
                          'Execution Time': 3,
                        },
                      ]
                    : plan(activeCandidate, page.length, total),
                },
              ],
            };
          }
          if (count) return { rows: [{ total: settings.stringCount ? String(total) : total }] };
          if (settings.abort) settings.abort.abort();
          const rows = page.map((value) => ({ ...value }));
          if (activeCandidate && rows.length && settings.alteredField)
            rows[0]!.extra = 'PRIVATE-extra';
          if (activeCandidate && rows.length && settings.invalidRow) delete rows[0]!.id;
          if (activeCandidate && options.cursor && settings.brokenCursor && rows.length)
            rows[0]!.cursor_created_at = cursorTimestamp.replace('123456', '123000');
          return { rows };
        },
      });
    },
  };
}

describe('search projection diagnostics', () => {
  it('compares all fields, types and microsecond cursor bytes while ignoring column order only', () => {
    const original = row();
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    expect(
      compareSearchResults({ rows: [original], total: 1 }, { rows: [reversed], total: 1 }).equal,
    ).toBe(true);
    for (const changes of [
      { extra: 1 },
      { remaining_seconds: '40' },
      { cursor_created_at: cursorTimestamp.replace('123456', '123000') },
    ])
      expect(
        compareSearchResults(
          { rows: [original], total: 1 },
          { rows: [{ ...original, ...changes }], total: 1 },
        ).equal,
      ).toBe(false);
  });
  it('preserves Date versus ISO string, nested types, NULL versus undefined and field presence', () => {
    const original = row({
      sla_clock_started_at: new Date(cursorTimestamp),
      metadata: { when: new Date(cursorTimestamp) },
    });
    for (const changes of [
      { created_at: new Date(cursorTimestamp).toISOString() },
      { sla_clock_started_at: new Date(cursorTimestamp).toISOString() },
      { remaining_seconds: '40' },
      { remaining_seconds: null },
      { sla_clock_started_at: undefined },
      { metadata: { when: new Date(cursorTimestamp).toISOString() } },
      { optional: undefined },
    ])
      expect(
        compareSearchResults(
          { rows: [original], total: 1 },
          { rows: [{ ...original, ...changes }], total: 1 },
        ),
      ).toMatchObject({ equal: false, fullRows: false });
    const nullClock = row({ sla_clock_started_at: null });
    expect(
      compareSearchResults(
        { rows: [nullClock], total: 1 },
        { rows: [{ ...nullClock, sla_clock_started_at: undefined }], total: 1 },
      ),
    ).toMatchObject({ equal: false, rawSla: false, fullRows: false });
    expect(
      compareSearchResults(
        { rows: [original], total: 1 },
        { rows: [structuredClone(original)], total: 1 },
      ).equal,
    ).toBe(true);
  });
  it('rejects noninteger or nonnumeric COUNT values even if both sides match', () => {
    const result = { rows: [row()], total: 1 };
    for (const total of ['1', null, undefined, -1, 1.5, Number.NaN]) {
      const invalid = { ...result, total } as unknown as QueryResultData;
      expect(compareSearchResults(result, invalid)).toMatchObject({ total: false, equal: false });
      expect(compareSearchResults(invalid, invalid)).toMatchObject({ total: false, equal: false });
    }
  });
  it('requires exact count SQL, parameters and limit even when the projection may change', () => {
    const ctx: AuthzContext = {
      organizationId: fixture.organizationId,
      principal: { userId: fixture.actors[0]!.userId, status: 'active', bindings: [] },
    };
    const built = fakeRuntime().buildLegacySearchQuery(ctx, { limit: 50 });
    expect(
      Object.values(compareSearchContracts(built, { ...built, sql: 'SELECT changed' })).every(
        Boolean,
      ),
    ).toBe(true);
    expect(compareSearchContracts(built, { ...built, countSql: 'SELECT 0' }).countSql).toBe(false);
    expect(compareSearchContracts(built, { ...built, countParams: [] }).countParams).toBe(false);
  });
  it('separates small group scans from user lookup reduction and rejects full-user scans as bounded work', () => {
    const result = summarizeSearchPlan(plan(true, 1, 1000), 1);
    expect(result.limitBeforeDisplayJoins).toBe(true);
    expect(result.userLookupsBoundedByReturnedRows).toBe(true);
    expect(result.boundedByReturnedRows).toBe(false);
    expect(
      summarizeSearchPlan(plan(true, 50, 1000, true), 50).userLookupsBoundedByReturnedRows,
    ).toBe(false);
    expect(summarizeSearchPlan(plan(false, 50, 1000), 50).limitBeforeDisplayJoins).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('has independent literal, absent-label, tie-order and unchanged-total boundary expectations', () => {
    const boundary = prepareSearchBoundary(fixture);
    const rows = boundaryRows(boundary).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const all: QueryResultData = { rows, total: 9 };
    expect(
      checkSearchBoundary(all, boundary, { keyword: '合成検索境界', direction: 'asc', limit: 50 }),
    ).toBe(true);
    expect(rows.some((value) => value.requester_name === null)).toBe(true);
    expect(
      checkSearchBoundary({ rows: [rows[0]!], total: 1 }, boundary, {
        keyword: '%_\\',
        direction: 'asc',
        limit: 50,
      }),
    ).toBe(true);
    expect(
      checkSearchBoundary({ rows: rows.slice(1), total: 9 }, boundary, {
        keyword: '合成検索境界',
        direction: 'asc',
        limit: 50,
        cursorId: String(rows[0]!.id),
      }),
    ).toBe(true);
    expect(
      checkSearchBoundary({ ...all, rows: [...rows].reverse() }, boundary, {
        keyword: '合成検索境界',
        direction: 'asc',
        limit: 50,
      }),
    ).toBe(false);
    expect(
      checkSearchBoundary({ rows: [{ ...rows[0], assignee_name: null }], total: 1 }, boundary, {
        keyword: '%_\\',
        direction: 'asc',
        limit: 50,
      }),
    ).toBe(false);
  });
  it('collects 17 real-table and 10 CTE cases with complete paging proof without leaking fixture data', async () => {
    const result = await runSearchAnalysis({ runtime: fakeRuntime(), fixture });
    expect(result).toMatchObject({
      completed: true,
      equivalent: true,
      optimization: { confirmed: true },
    });
    expect(result.cases).toHaveLength(27);
    expect(result.cases.filter((item) => item.rlsEvidence)).toHaveLength(17);
    expect(result.readOnlyContexts).toHaveLength(28);
    expect(result.unchangedSorts).toHaveLength(14);
    expect(result.cases.filter((item) => item.pagination)).toHaveLength(12);
    for (const item of result.cases.filter((item) => item.pagination)) {
      expect(item.pagination?.next?.unchangedTotal).toBe(true);
      expect(item.pagination?.terminal?.empty).toBe(true);
      expect(item.pagination?.terminal?.unchangedTotal).toBe(true);
    }
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|SELECT|合成性能問い合わせ|04600000|04400000/,
    );
  });
  it('accepts identical before builders without claiming a projection improvement', async () => {
    const result = await runSearchAnalysis({ runtime: fakeRuntime({ before: true }), fixture });
    expect(result).toMatchObject({
      completed: true,
      equivalent: true,
      optimization: { sqlChanged: false, confirmed: false },
    });
  });
  it.each([{ alteredField: true }, { brokenCursor: true }, { emptyExpected: true }])(
    'does not turn inequality or missing nonempty fixture into an all-pass %j',
    async (settings) => {
      const result = await runSearchAnalysis({ runtime: fakeRuntime(settings), fixture });
      expect(result.completed).toBe(true);
      expect(result.equivalent).toBe(false);
      expect(result.optimization?.confirmed).toBe(false);
    },
  );
  it('retains comparison and list plan when candidate COUNT EXPLAIN fails', async () => {
    const result = await runSearchAnalysis({
      runtime: fakeRuntime({ failCandidateCountPlan: true }),
      fixture,
    });
    expect(result).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'SEARCH_ANALYSIS_FAILED',
    });
    expect(result.cases[0]).toMatchObject({
      completed: false,
      stage: 'candidate-count-explain',
      comparison: { equal: true },
    });
    expect(result.cases[0]!.candidate.listPlan).toBeDefined();
    expect(result.cases[0]!.candidate.countPlan).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each([
    { badProof: true },
    { badBinding: true },
    { invalidRow: true },
    { unsafeSql: true },
    { stringCount: true },
  ])('fails closed for malformed proof, binding, rows or SQL %j', async (settings) => {
    const result = await runSearchAnalysis({ runtime: fakeRuntime(settings), fixture });
    expect(result.completed).toBe(false);
    expect(result.equivalent).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('honors cancellation during a query and retains the active case without publishing raw exceptions', async () => {
    const abort = new AbortController();
    const result = await runSearchAnalysis({
      runtime: fakeRuntime({ abort }),
      fixture,
      signal: abort.signal,
    });
    expect(result).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'SEARCH_ABORTED',
    });
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.completed).toBe(false);
  });
});
