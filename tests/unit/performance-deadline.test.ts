import { describe, expect, it, vi } from 'vitest';
import { buildListQuery } from '../../services/api/src/modules/ticket/ticket-query.js';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type {
  AnalysisClient,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import {
  buildDeadlineBoundaryQuery,
  checkDeadlineBoundary,
  compareDeadlineContracts,
  compareDeadlineResults,
  prepareDeadlineBoundary,
  runDeadlineAnalysis,
  summarizeDeadlinePlan,
  validateDeadlineResult,
  type DeadlineBoundary,
  type DeadlineRuntime,
} from '../../tools/performance/deadline-analysis.mjs';

const id = (n: number) => `04400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixture: PerformanceFixture = {
  organizationId: id(101),
  controlOrganizationId: id(102),
  controlTicketId: id(103),
  catalogItemId: id(104),
  serviceRequestId: id(105),
  actors: [
    {
      userId: id(201),
      email: 'private-agent@example.test',
      password: 'private-password',
      role: 'agent',
      ticketId: id(106),
      ticketSubject: 'private-body',
    },
    {
      userId: id(202),
      email: 'private-requester@example.test',
      password: 'private-password',
      role: 'requester',
      ticketId: id(106),
      ticketSubject: 'private-body',
    },
  ],
  counts: {
    users: 2,
    tickets: 10,
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
const rawPlan = (loops = 1000, rows = 1) => [
  {
    Plan: {
      'Node Type': 'Limit',
      'Actual Rows': 1,
      Plans: ['assignee', 'requester', 'assignee_group'].map((alias) => ({
        'Node Type': 'Index Scan',
        Alias: alias,
        'Actual Loops': loops,
        'Actual Rows': rows,
        'Index Name': alias === 'assignee_group' ? 'assignment_group_pkey' : 'app_user_pkey',
        'Index Cond': 'private-email-and-password',
      })),
    },
    'Planning Time': 0.1,
    'Execution Time': 0.5,
  },
];
const lateJoinPlan = (userRows = 1) => {
  let node: Record<string, unknown> = {
    'Node Type': 'Limit',
    'Actual Rows': 1,
    'Actual Loops': 1,
    Plans: [{ 'Node Type': 'Seq Scan', Alias: 't', 'Actual Rows': 1000, 'Actual Loops': 1 }],
  };
  for (const alias of ['assignee', 'requester', 'assignee_group']) {
    const group = alias === 'assignee_group';
    node = {
      'Node Type': group ? 'Hash Join' : 'Nested Loop',
      'Actual Rows': 1,
      'Actual Loops': 1,
      Plans: [
        node,
        {
          'Node Type': group || userRows > 1 ? 'Seq Scan' : 'Index Scan',
          Alias: alias,
          'Actual Rows': group ? 2 : userRows,
          'Actual Loops': 1,
        },
      ],
    };
  }
  return [{ Plan: node, 'Planning Time': 0.1, 'Execution Time': 0.5 }];
};
const rawRow = (changes: Record<string, unknown> = {}) => ({
  id: id(1),
  organization_id: fixture.organizationId,
  requester_id: fixture.actors[1]!.userId,
  cursor_created_at: '2026-10-04 00:00:00.123456+00',
  assignee_name: 'Agent',
  requester_name: 'Requester',
  assignee_group_name: 'Group',
  sla_elapsed_now: '61',
  remaining_seconds: '-1',
  response_target_minutes: 1,
  resolution_target_minutes: 1,
  sla_elapsed_seconds: 61,
  sla_clock_started_at: null,
  body: 'private-body',
  ...changes,
});

function boundaryRows(
  boundary: DeadlineBoundary,
  direction: 'asc' | 'desc',
  limit: number,
  own = false,
  empty = false,
) {
  // Explicit expected sequences avoid reproducing the implementation's comparator.
  const numbers = direction === 'asc' ? [8, 1, 2, 3, 5, 4, 10, 6, 7] : [10, 4, 5, 3, 2, 1, 8, 7, 6];
  const sequence = empty ? [] : numbers.filter((n) => !own || n !== 10);
  return {
    total: sequence.length,
    rows: sequence.slice(0, limit).map((n) => {
      const wanted = boundary.expected.find((row) => row.id === id(n))!;
      return rawRow({
        id: wanted.id,
        requester_id: wanted.requesterId,
        remaining_seconds:
          wanted.remainingSeconds === null ? null : String(wanted.remainingSeconds),
        sla_elapsed_now: String(wanted.elapsed),
        assignee_name: wanted.assigneeName,
        requester_name: wanted.requesterName,
        assignee_group_name: wanted.groupName,
      });
    }),
  };
}

function mockRuntime(
  options: {
    failExplain?: number;
    invalidProof?: boolean;
    mutateCandidate?: boolean;
    failCount?: boolean;
    requesterStaff?: boolean;
  } = {},
) {
  let contextIndex = -1,
    explainCount = 0,
    currentSide = 0;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let listOptions: { limit: number; direction: 'asc' | 'desc'; own: boolean; empty: boolean };
  const boundary = prepareDeadlineBoundary(fixture);
  const query = vi.fn(
    async (sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT rb.user_id'))
        return {
          rows: [
            { user_id: id(201), code: 'agent' },
            { user_id: id(202), code: 'requester' },
            ...(options.requesterStaff ? [{ user_id: id(202), code: 'platform_auditor' }] : []),
          ],
        };
      if (sql.startsWith('SELECT id FROM assignment_group')) return { rows: [{ id: id(20) }] };
      if (sql.startsWith('SELECT count(*)::int n FROM ticket')) return { rows: [{ n: 1 }] };
      if (sql.startsWith('EXPLAIN')) {
        if (++explainCount === options.failExplain) throw new Error('private-db-connection');
        return { rows: [{ 'QUERY PLAN': rawPlan() }] };
      }
      const synthetic =
        typeof params.at(-1) === 'string' && (params.at(-1) as string).startsWith('{');
      const empty = contextIndex === 13 || contextIndex === 15;
      const result = synthetic
        ? boundaryRows(
            boundary,
            listOptions.direction,
            listOptions.limit,
            listOptions.own,
            listOptions.empty,
          )
        : { total: empty ? 0 : 1, rows: empty ? [] : [rawRow()] };
      if (sql.includes('count(*)::int AS total')) {
        if (options.failCount) throw new Error('private-count-error');
        return { rows: [{ total: result.total }] };
      }
      currentSide += 1;
      if (options.mutateCandidate && currentSide % 2 === 0 && result.rows[0])
        result.rows[0].body = 'different-private-body';
      return { rows: result.rows };
    },
  );
  const runtime: DeadlineRuntime = {
    buildTicketListQuery(ctx, options) {
      listOptions = {
        limit: options.limit ?? 50,
        direction: options.sort?.direction ?? 'desc',
        own: ctx.principal.bindings[0]?.roleCode === 'requester',
        empty: options.filter?.state?.[0] === 'closed',
      };
      return buildListQuery(ctx, options);
    },
    buildLegacyTicketListQuery: buildListQuery,
    async withAppReadOnly<T>(
      _context: { organizationId: string; actorId: string },
      callback: (client: AnalysisClient) => Promise<T>,
    ): Promise<T> {
      contextIndex += 1;
      currentSide = 0;
      return callback({
        query,
        proof: options.invalidProof
          ? ({ ...proof, readOnly: false } as unknown as ReadOnlyProof)
          : proof,
      });
    },
  };
  return { runtime, query, queries };
}

describe('deadline list analysis', () => {
  it('compares complete field sets, values and types while ignoring SQL column insertion order', () => {
    const original = { rows: [rawRow()], total: 1 };
    const reordered = Object.fromEntries(Object.entries(rawRow()).reverse());
    expect(compareDeadlineResults(original, { rows: [reordered], total: 1 }).equal).toBe(true);
    for (const changed of [
      { ...rawRow(), extra: null },
      { ...rawRow(), remaining_seconds: -1 },
      { ...rawRow(), body: 'changed' },
    ])
      expect(compareDeadlineResults(original, { rows: [changed], total: 1 }).equal).toBe(false);
    const missing = { ...rawRow() } as Record<string, unknown>;
    delete missing.body;
    expect(compareDeadlineResults(original, { rows: [missing], total: 1 }).equal).toBe(false);
  });
  it('does not mistake a one-loop full-table scan for lookup work bounded by LIMIT', () => {
    expect(summarizeDeadlinePlan(rawPlan(5, 1), 5).boundedByReturnedRows).toBe(true);
    expect(summarizeDeadlinePlan(rawPlan(1000, 1), 5).boundedByReturnedRows).toBe(false);
    expect(summarizeDeadlinePlan(rawPlan(1, 4000), 5).boundedByReturnedRows).toBe(false);
    const clean = summarizeDeadlinePlan(rawPlan(5, 1), 5);
    expect(clean.displayLookups.map((value) => value.totalRows)).toEqual([5, 5, 5]);
    expect(JSON.stringify(clean)).not.toContain('private');
    expect(() => summarizeDeadlinePlan(rawPlan(Number.NaN), 5)).toThrow('QUERY_PLAN_INVALID');
    expect(
      summarizeDeadlinePlan(
        [{ Plan: { 'Node Type': 'Result' }, 'Planning Time': 0, 'Execution Time': 0 }],
        1,
      ).boundedByReturnedRows,
    ).toBe(false);
  });
  it('rejects malformed result shape, omitted fields and invalid raw SLA', () => {
    expect(validateDeadlineResult([rawRow()], 1, 1)).toMatchObject({ total: 1 });
    for (const [rows, total, limit] of [
      [[{}], 1, 1],
      [[rawRow()], '1', 1],
      [[rawRow()], 0, 1],
      [[rawRow()], 1, 0],
      [[rawRow({ remaining_seconds: 'not-a-number' })], 1, 1],
    ] as const)
      expect(() => validateDeadlineResult(rows, total, limit)).toThrow('DEADLINE_RESULT_INVALID');
  });
  it('distinguishes LIMIT-before-JOIN structure from full-scan cost and small group scans', () => {
    expect(summarizeDeadlinePlan(rawPlan(1, 1), 1).limitBeforeDisplayJoins).toBe(false);
    const smallGroup = summarizeDeadlinePlan(lateJoinPlan(), 1);
    expect(smallGroup).toMatchObject({
      limitBeforeDisplayJoins: true,
      userLookupsBoundedByReturnedRows: true,
      boundedByReturnedRows: false,
    });
    expect(
      smallGroup.displayLookups.find((lookup) => lookup.alias === 'assignee_group'),
    ).toMatchObject({ totalLoops: 1, totalRows: 2 });
    const largeUsers = summarizeDeadlinePlan(lateJoinPlan(4000), 1);
    expect(largeUsers).toMatchObject({
      limitBeforeDisplayJoins: true,
      userLookupsBoundedByReturnedRows: false,
      boundedByReturnedRows: false,
    });
    expect(
      largeUsers.displayLookups.find((lookup) => lookup.alias === 'requester')?.totalRows,
    ).toBe(4000);
  });
  it('requires exact count SQL, params and limit compatibility', () => {
    const ctx = {
      organizationId: fixture.organizationId,
      principal: { userId: id(201), status: 'active' as const, bindings: [] },
    };
    const built = buildListQuery(ctx, { sort: { column: 'deadline', direction: 'asc' }, limit: 5 });
    expect(Object.values(compareDeadlineContracts(built, built)).every(Boolean)).toBe(true);
    expect(
      compareDeadlineContracts(built, {
        ...built,
        countSql: built.countSql + ' ',
        limit: 6,
        params: [],
        countParams: [],
      }),
    ).toEqual({ countSql: false, countParams: false, params: false, limit: false });
  });
  it('uses full schema composite CTEs, bound data and transaction time without writes', () => {
    const boundary = prepareDeadlineBoundary(fixture),
      built = {
        sql: 'SELECT t.* FROM ticket t WHERE t.organization_id=$1',
        params: [fixture.organizationId],
      };
    const wrapped = buildDeadlineBoundaryQuery(built, boundary);
    expect(wrapped.sql).toMatch(/^SELECT \* FROM \(/);
    expect(wrapped.sql).toContain('NULL::public.ticket');
    expect(wrapped.sql).toContain(built.sql);
    expect(wrapped.sql).not.toContain(fixture.organizationId);
    expect(wrapped.params[0]).toBe(fixture.organizationId);
    expect(JSON.parse(wrapped.params[1] as string).tickets).toHaveLength(10);
    for (const sql of ['UPDATE ticket SET id=id', 'SELECT 1; DELETE FROM ticket'])
      expect(() => buildDeadlineBoundaryQuery({ sql, params: [] }, boundary)).toThrow(
        'DEADLINE_QUERY_REJECTED',
      );
  });
  it('checks NULL-last in both directions, id ties, paused/future clocks and LEFT JOIN null names against explicit sequences', () => {
    const boundary = prepareDeadlineBoundary(fixture);
    for (const direction of ['asc', 'desc'] as const)
      for (const limit of [1, 5, 50, 200]) {
        const result = boundaryRows(boundary, direction, limit);
        expect(checkDeadlineBoundary(result, boundary, { direction, limit })).toBe(true);
      }
    const wrong = boundaryRows(boundary, 'asc', 50);
    [wrong.rows[2], wrong.rows[3]] = [wrong.rows[3]!, wrong.rows[2]!];
    expect(checkDeadlineBoundary(wrong, boundary, { direction: 'asc', limit: 50 })).toBe(false);
    const future = boundaryRows(boundary, 'asc', 50);
    future.rows.find((row) => row.id === id(4))!.sla_elapsed_now = '-30';
    expect(checkDeadlineBoundary(future, boundary, { direction: 'asc', limit: 50 })).toBe(false);
    expect(
      checkDeadlineBoundary(boundaryRows(boundary, 'desc', 50, true), boundary, {
        direction: 'desc',
        limit: 50,
        requesterId: id(202),
      }),
    ).toBe(true);
    expect(
      checkDeadlineBoundary({ rows: [], total: 0 }, boundary, {
        direction: 'asc',
        limit: 50,
        empty: true,
      }),
    ).toBe(true);
  });
  it('accepts a complete unchanged before run without inventing projection improvement', async () => {
    const mock = mockRuntime();
    const report = await runDeadlineAnalysis({ runtime: mock.runtime, fixture });
    expect(report).toMatchObject({
      completed: true,
      equivalent: true,
      projection: { sqlChanged: false, confirmed: false, bounded: false },
    });
    expect(report.cases).toHaveLength(25);
    expect(report.readOnlyContexts).toHaveLength(26);
    expect(report.cases.filter((value) => value.rlsEvidence)).toHaveLength(15);
    expect(
      report.cases
        .filter((value) => value.mode === 'synthetic-cte')
        .every((value) => !value.rlsEvidence),
    ).toBe(true);
    expect(report.unchangedSorts).toHaveLength(9);
    expect(report.cursorRejections.every((value) => value.legacy && value.candidate)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private');
    expect(JSON.stringify(report)).not.toContain(fixture.organizationId);
    expect(mock.queries.every((value) => /^(SELECT|EXPLAIN)/.test(value.sql.trim()))).toBe(true);
  });
  it('retains a field mismatch as failed equivalence rather than an execution error', async () => {
    const report = await runDeadlineAnalysis({
      runtime: mockRuntime({ mutateCandidate: true }).runtime,
      fixture,
    });
    expect(report).toMatchObject({ completed: true, equivalent: false });
    expect(report.cases[0]?.comparison).toMatchObject({ equal: false, fullRows: false, ids: true });
  });
  it('keeps completed results and prior plans when a later EXPLAIN fails', async () => {
    const report = await runDeadlineAnalysis({
      runtime: mockRuntime({ failExplain: 3 }).runtime,
      fixture,
    });
    expect(report).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'DEADLINE_ANALYSIS_FAILED',
    });
    expect(report.cases[0]).toMatchObject({
      stage: 'candidate-list-explain',
      completed: false,
      comparison: { equal: true },
      legacy: { rows: 1, total: 1 },
      candidate: { rows: 1, total: 1 },
    });
    expect(report.cases[0]?.legacy.listPlan).toBeDefined();
    expect(report.cases[0]?.legacy.countPlan).toBeDefined();
    expect(report.cases[0]?.candidate.listPlan).toBeUndefined();
    const countFailure = await runDeadlineAnalysis({
      runtime: mockRuntime({ failCount: true }).runtime,
      fixture,
    });
    expect(countFailure.cases[0]).toMatchObject({ stage: 'legacy-count', legacy: { rows: 1 } });
  });
  it('fails closed before queries on invalid proof or a pre-aborted signal', async () => {
    const mock = mockRuntime({ invalidProof: true });
    expect(await runDeadlineAnalysis({ runtime: mock.runtime, fixture })).toMatchObject({
      completed: false,
      failureCode: 'QUERY_READ_ONLY_PROOF_INVALID',
    });
    expect(mock.query).not.toHaveBeenCalled();
    expect(
      await runDeadlineAnalysis({ runtime: mock.runtime, fixture, signal: AbortSignal.abort() }),
    ).toMatchObject({ completed: false, failureCode: 'DEADLINE_ABORTED' });
  });
  it('rejects a requester with an additional organization-wide or platform binding', async () => {
    const mock = mockRuntime({ requesterStaff: true });
    expect(await runDeadlineAnalysis({ runtime: mock.runtime, fixture })).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'DEADLINE_BINDINGS_INVALID',
      cases: [],
    });
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0]!.sql).toContain("u.status='active'");
    expect(mock.queries[0]!.sql).toContain('rb.organization_id IS NULL');
  });
});
