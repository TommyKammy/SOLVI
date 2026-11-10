import { describe, expect, it, vi } from 'vitest';
import { buildListQuery } from '../../services/api/src/modules/ticket/ticket-query.js';
import { buildTicketOverviewQuery } from '../../services/api/src/modules/ticket/overview-query.js';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type {
  AnalysisClient,
  ReadOnlyProof,
} from '../../tools/performance/list-query-analysis.mjs';
import {
  OVERVIEW_METRICS,
  buildOverviewEdgeQuery,
  compareOverviewCounts,
  prepareOverviewCases,
  runOverviewAnalysis,
  sanitizeOverviewCounts,
  type OverviewCounts,
  type OverviewEdgeCase,
  type OverviewRuntime,
} from '../../tools/performance/overview-analysis.mjs';

const uuid = (n: number) => `04300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const zero: OverviewCounts = {
  open: 0,
  unassigned: 0,
  mine: 0,
  pending: 0,
  breached: 0,
  critical: 0,
};
const positive: OverviewCounts = {
  open: 10,
  unassigned: 2,
  mine: 3,
  pending: 1,
  breached: 2,
  critical: 1,
};
const fixture: PerformanceFixture = {
  organizationId: uuid(1),
  controlOrganizationId: uuid(2),
  controlTicketId: uuid(3),
  catalogItemId: uuid(4),
  serviceRequestId: uuid(5),
  actors: [
    {
      userId: uuid(10),
      email: 'secret-agent@example.test',
      password: 'secret-password',
      role: 'agent',
      ticketId: uuid(6),
      ticketSubject: 'private-body',
    },
    {
      userId: uuid(11),
      email: 'secret-admin@example.test',
      password: 'secret-password',
      role: 'admin',
      ticketId: uuid(6),
      ticketSubject: 'private-body',
    },
  ],
  counts: {
    users: 2,
    tickets: 10,
    states: [
      { state: 'new', n: 9 },
      { state: 'pending', n: 1 },
    ],
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
const ctx: AuthzContext = {
  organizationId: fixture.organizationId,
  principal: {
    userId: uuid(10),
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
const plan = [
  {
    Plan: {
      'Node Type': 'Aggregate',
      'Actual Rows': 1,
      Filter: 'private-body',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'private-table', 'Shared Hit Blocks': 4 },
      ],
    },
    'Planning Time': 0.1,
    'Execution Time': 0.2,
    Query: 'private SQL',
  },
];

/** Independent specification evaluator for the small synthetic rows, not a SQL emulator. */
function edgeCounts(edge: OverviewEdgeCase): OverviewCounts {
  const result = { ...zero };
  for (const ticket of edge.tickets) {
    if (!['new', 'assigned', 'in_progress', 'pending'].includes(ticket.state)) continue;
    result.open += 1;
    if (ticket.assignee_id === null) result.unassigned += 1;
    if (ticket.assignee_id === ctx.principal.userId) result.mine += 1;
    if (ticket.state === 'pending') result.pending += 1;
    if (ticket.priority === 'critical') result.critical += 1;
    const target = edge.policies.find(
      (policy) =>
        policy.organization_id === ticket.organization_id && policy.priority === ticket.priority,
    )?.resolution_target_minutes;
    if (
      target !== undefined &&
      ticket.sla_elapsed_seconds + Math.max(0, ticket.clock_age_seconds ?? 0) > target * 60
    )
      result.breached += 1;
  }
  return result;
}

function mockRuntime(
  options: {
    failExplain?: number;
    aggregateOverride?: unknown;
    invalidProof?: boolean;
    failCountMetric?: string;
    emptyPositive?: boolean;
  } = {},
) {
  let contextIndex = -1;
  let explains = 0;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(
    async (sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
      calls.push({ sql, params });
      if (sql.includes('SELECT rb.user_id,r.code'))
        return {
          rows: [
            { user_id: uuid(10), code: 'agent' },
            { user_id: uuid(11), code: 'org_admin' },
          ],
        };
      if (sql.startsWith('SELECT id FROM assignment_group'))
        return { rows: [{ id: contextIndex === 0 ? uuid(20) : uuid(21) }] };
      if (sql.startsWith('SELECT count(*)::int n FROM assignment_group'))
        return { rows: [{ n: 0 }] };
      if (sql.startsWith('SELECT count(*)::int n FROM ticket')) return { rows: [{ n: 1 }] };
      if (sql.startsWith('SELECT g.id'))
        return { rows: params[0] === uuid(11) ? [] : [{ id: uuid(20) }] };
      if (sql.startsWith('EXPLAIN')) {
        explains += 1;
        if (explains === options.failExplain) throw new Error('private-driver-url-and-password');
        return { rows: [{ 'QUERY PLAN': plan }] };
      }
      const edgeValue = params.at(-1);
      const synthetic =
        typeof edgeValue === 'string' && edgeValue.startsWith('{')
          ? (JSON.parse(edgeValue) as OverviewEdgeCase)
          : undefined;
      const counts = synthetic
        ? edgeCounts(synthetic)
        : contextIndex >= 6 || options.emptyPositive
          ? zero
          : positive;
      if (sql.includes(' AS total ')) {
        const metric = sql.includes('t.assignee_id IS NULL')
          ? 'unassigned'
          : sql.includes('t.assignee_id = $')
            ? 'mine'
            : sql.includes('p.resolution_target_minutes IS NOT NULL')
              ? 'breached'
              : params.some(
                    (param) => Array.isArray(param) && param.length === 1 && param[0] === 'pending',
                  )
                ? 'pending'
                : params.some(
                      (param) =>
                        Array.isArray(param) && param.length === 1 && param[0] === 'critical',
                    )
                  ? 'critical'
                  : 'open';
        if (metric === options.failCountMetric) throw new Error('private-query-params');
        return { rows: [{ total: counts[metric] }] };
      }
      return {
        rows: [
          options.aggregateOverride === undefined
            ? counts
            : (options.aggregateOverride as Record<string, unknown>),
        ],
      };
    },
  );
  const runtime: OverviewRuntime = {
    buildTicketListQuery: buildListQuery,
    buildTicketOverviewQuery,
    async withAppReadOnly<T>(
      _context: { organizationId: string; actorId: string },
      callback: (client: AnalysisClient) => Promise<T>,
    ): Promise<T> {
      contextIndex += 1;
      return callback({
        query,
        proof: options.invalidProof
          ? ({ ...proof, bypassRls: true } as unknown as ReadOnlyProof)
          : proof,
      });
    },
  };
  return { runtime, calls, query };
}

describe('overview comparison harness', () => {
  it('accepts only all six nonnegative integral bounded counts', () => {
    expect(sanitizeOverviewCounts(zero)).toEqual(zero);
    for (const bad of [
      null,
      {},
      { ...positive, other: 1 },
      { ...positive, mine: '3' },
      { ...positive, breached: -1 },
      { ...positive, pending: 0.5 },
      { ...positive, open: Infinity },
      { ...positive, critical: 11 },
    ]) {
      expect(() => sanitizeOverviewCounts(bad)).toThrow('OVERVIEW_COUNTS_INVALID');
    }
  });

  it('checks every metric and explicit expected population, rejecting vacuous equality', () => {
    expect(compareOverviewCounts(positive, positive)).toMatchObject({
      equal: true,
      expectedPopulation: true,
    });
    expect(compareOverviewCounts(zero, zero).equal).toBe(false);
    expect(compareOverviewCounts(zero, zero, zero).equal).toBe(true);
    for (const metric of OVERVIEW_METRICS.filter((value) => value !== 'open')) {
      const result = compareOverviewCounts(positive, {
        ...positive,
        [metric]: positive[metric] + 1,
      });
      expect(result.equal).toBe(false);
      expect(result.metrics[metric]).toBe(false);
    }
  });

  it('prepares independent boundary populations without calling the runtime or mutating the fixture', () => {
    const original = JSON.stringify(fixture);
    const runtime = mockRuntime();
    const edges = prepareOverviewCases({ runtime: runtime.runtime, fixture });
    expect(runtime.query).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture)).toBe(original);
    expect(edges.map((edge) => edge.name)).toEqual([
      'sla-exact-paused',
      'sla-overdue-paused',
      'sla-exact-running',
      'sla-overdue-running',
      'pending-paused',
      'sla-missing-policy',
      'terminal-only',
      'empty',
    ]);
    for (const edge of edges) expect(edgeCounts(edge)).toEqual(edge.expected);
    expect(
      edges
        .find((edge) => edge.name === 'pending-paused')
        ?.tickets.every((ticket) => ticket.clock_age_seconds === null),
    ).toBe(true);
  });

  it('wraps the actual compiled query with bound CTE rows and a SELECT entrypoint', () => {
    const edge = prepareOverviewCases({ fixture })[2]!;
    const built = buildTicketOverviewQuery(ctx);
    const wrapped = buildOverviewEdgeQuery(built, edge);
    expect(wrapped.sql).toMatch(/^SELECT \* FROM \(/);
    expect(wrapped.sql).toContain(built.sql);
    expect(wrapped.sql).toContain(
      `jsonb_to_recordset($${built.params.length + 1}::jsonb->'tickets')`,
    );
    expect(wrapped.sql).toContain("now() - x.clock_age_seconds * interval '1 second'");
    expect(wrapped.params.slice(0, -1)).toEqual(built.params);
    expect(JSON.parse(wrapped.params.at(-1) as string)).toEqual({
      tickets: edge.tickets,
      policies: edge.policies,
    });
    expect(wrapped.sql).not.toContain(fixture.organizationId);
    for (const sql of [
      'UPDATE ticket SET state=state',
      'SELECT 1; SELECT 2',
      'WITH bad AS (DELETE FROM ticket) SELECT 1',
    ])
      expect(() => buildOverviewEdgeQuery({ sql, params: [] }, edge)).toThrow(
        'OVERVIEW_QUERY_REJECTED',
      );
  });

  it('records real and CTE cases separately with complete proof and sanitized plans', async () => {
    const mock = mockRuntime();
    const report = await runOverviewAnalysis({ runtime: mock.runtime, fixture });
    expect(report).toMatchObject({ completed: true, equivalent: true });
    expect(report.cases).toHaveLength(16);
    expect(report.readOnlyContexts).toHaveLength(18);
    expect(
      report.cases
        .slice(0, 6)
        .every((item) => item.apiComparable && item.actorRole === 'agent' && item.options),
    ).toBe(true);
    expect(
      report.cases.slice(6).every((item) => !item.apiComparable && item.options === undefined),
    ).toBe(true);
    expect(report.cases.every((item) => item.proof?.readOnlyWriteSqlState === '25006')).toBe(true);
    expect(report.cases.filter((item) => item.rlsEvidence)).toHaveLength(8);
    expect(
      report.cases
        .filter((item) => item.mode === 'synthetic-cte')
        .every((item) => !item.rlsEvidence),
    ).toBe(true);
    expect(report.cases.find((item) => item.name === 'no-membership')).toMatchObject({
      membershipCount: 0,
      aggregate: { counts: zero },
    });
    expect(
      mock.calls.some((call) =>
        call.params.some(
          (value) => Array.isArray(value) && value.includes('00000000-0000-4000-8000-0000000000ff'),
        ),
      ),
    ).toBe(true);
    const output = JSON.stringify(report);
    for (const privateValue of [
      'private',
      'secret',
      'SELECT',
      fixture.actors[0]!.userId,
      fixture.organizationId,
    ])
      expect(output).not.toContain(privateValue);
    expect(mock.calls.every((call) => /^(SELECT|EXPLAIN)/.test(call.sql))).toBe(true);
  });

  it('retains counts, comparison, and earlier EXPLAIN evidence when a later plan fails', async () => {
    const report = await runOverviewAnalysis({
      runtime: mockRuntime({ failExplain: 3 }).runtime,
      fixture,
    });
    expect(report).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'OVERVIEW_ANALYSIS_FAILED',
    });
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      stage: 'legacy-mine-explain',
      completed: false,
      legacy: { counts: positive },
      aggregate: { counts: positive },
      comparison: { equal: true },
    });
    expect(Object.keys(report.cases[0]!.legacy.plans)).toEqual(['open', 'unassigned']);
    expect(JSON.stringify(report)).not.toContain('private-driver');
  });

  it('retains already acquired metrics when a later count fails', async () => {
    const report = await runOverviewAnalysis({
      runtime: mockRuntime({ failCountMetric: 'mine' }).runtime,
      fixture,
    });
    expect(report.cases[0]).toMatchObject({
      stage: 'legacy-mine-count',
      legacy: { counts: { open: 10, unassigned: 2 } },
    });
    expect(report.cases[0]!.legacy.counts.mine).toBeUndefined();
    expect(report.failureCode).toBe('OVERVIEW_ANALYSIS_FAILED');
  });

  it('rejects invalid aggregate data and preserves a valid mismatch without disguising success', async () => {
    const malformed = await runOverviewAnalysis({
      runtime: mockRuntime({ aggregateOverride: { ...positive, mine: '3' } }).runtime,
      fixture,
    });
    expect(malformed).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'OVERVIEW_COUNTS_INVALID',
    });
    const mismatch = await runOverviewAnalysis({
      runtime: mockRuntime({ aggregateOverride: { ...positive, mine: 2 } }).runtime,
      fixture,
    });
    expect(mismatch).toMatchObject({ completed: true, equivalent: false });
    expect(mismatch.cases[0]?.comparison?.metrics.mine).toBe(false);
    const vacuous = await runOverviewAnalysis({
      runtime: mockRuntime({ emptyPositive: true }).runtime,
      fixture,
    });
    expect(vacuous.equivalent).toBe(false);
    expect(vacuous.cases[0]?.comparison?.expectedPopulation).toBe(false);
  });

  it('fails closed on missing RLS proof and does no work for a pre-aborted signal', async () => {
    const invalid = mockRuntime({ invalidProof: true });
    expect(await runOverviewAnalysis({ runtime: invalid.runtime, fixture })).toMatchObject({
      completed: false,
      failureCode: 'QUERY_READ_ONLY_PROOF_INVALID',
      cases: [],
    });
    expect(invalid.query).not.toHaveBeenCalled();
    const aborted = mockRuntime();
    expect(
      await runOverviewAnalysis({ runtime: aborted.runtime, fixture, signal: AbortSignal.abort() }),
    ).toMatchObject({ completed: false, failureCode: 'OVERVIEW_ANALYSIS_ABORTED', cases: [] });
    expect(aborted.query).not.toHaveBeenCalled();
  });
});
