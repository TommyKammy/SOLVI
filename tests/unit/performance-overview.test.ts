import React, { createElement, type AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { format } from 'node:url';
import type { LinkProps } from 'next/link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const homeApi = vi.hoisted(() => ({
  listGroups: vi.fn(),
  ticketOverview: vi.fn(),
  listTickets: vi.fn(),
  inbox: vi.fn(),
}));
const homeSession = vi.hoisted(() => ({
  current: {
    userId: '04300000-0000-4000-8000-000000000010',
    organizationId: '04300000-0000-4000-8000-000000000001',
    roles: [
      {
        roleCode: 'agent',
        organizationId: '04300000-0000-4000-8000-000000000001',
      },
    ],
  },
}));
const inboxOpenCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../apps/web/src/lib/api', () => ({
  api: homeApi,
  requireSession: vi.fn(async () => homeSession.current),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch: _prefetch,
    ...props
  }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & LinkProps) =>
    createElement('a', { ...props, href: typeof href === 'string' ? href : format(href) }),
}));
vi.mock('../../apps/web/src/components/OperationsGroupSelect', async () => {
  const ReactModule = await import('react');
  return {
    OperationsGroupSelect: (props: { selectedGroup: string }) =>
      ReactModule.createElement(
        'select',
        { id: 'overview-group', name: 'group', defaultValue: props.selectedGroup },
        ReactModule.createElement('option', { value: '' }, '組織全体'),
      ),
  };
});
vi.mock('../../apps/web/src/components/InboxOpenForm', async () => {
  const ReactModule = await import('react');
  return {
    InboxOpenForm: (props: {
      item: { kind: string; id: string; eventKey: string; nextAction: string };
    }) => {
      inboxOpenCalls.push(props.item);
      return ReactModule.createElement(
        'form',
        { 'data-inbox-open': 'true' },
        ReactModule.createElement('input', {
          type: 'hidden',
          name: 'kind',
          value: props.item.kind,
        }),
        ReactModule.createElement('input', { type: 'hidden', name: 'id', value: props.item.id }),
        ReactModule.createElement('input', {
          type: 'hidden',
          name: 'eventKey',
          value: props.item.eventKey,
        }),
        ReactModule.createElement('button', { type: 'submit' }, props.item.nextAction),
      );
    },
  };
});

const { default: OperationsOverview } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<React.ReactNode>;
}>('../../apps/web/src/app/ops/overview/page');

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

// WP-P2-UIX-045: the home page must not add data API calls while replacing
// the overview's counts/deadlines/charts with personal work, approval, and status.
describe('UI v2 home page request budget', () => {
  const orgId = uuid(1);
  const agent = {
    userId: uuid(10),
    organizationId: orgId,
    roles: [{ roleCode: 'agent', organizationId: orgId }],
  };
  const homeCounts = { open: 6, unassigned: 1, mine: 4, pending: 1, breached: 2, critical: 1 };
  const ticket = (n: number, remainingSeconds: number | null, subject: string) => ({
    id: uuid(100 + n),
    number: `#10${n}`,
    kind: 'incident',
    state: 'new',
    subject,
    body: '合成データ',
    impact: 'medium',
    urgency: 'medium',
    priority: 'medium',
    createdAt: '2026-11-18T00:00:00.000Z',
    resolvedAt: null,
    assigned: true,
    assigneeName: '合成 担当者',
    assigneeGroupName: '合成グループ',
    ...(remainingSeconds === null
      ? {}
      : { sla: { remainingSeconds, breached: remainingSeconds < 0 } }),
  });
  const approval = {
    kind: 'request_approval',
    id: uuid(201),
    number: 'REQ-201',
    title: '合成の承認依頼',
    state: 'pending',
    stateLabel: '自分への承認依頼',
    scopeLabel: '指名された承認者',
    nextAction: '申請を確認して承認・却下する',
    href: `/requests/${uuid(201)}`,
    waiting: false,
    eventKey: 'a'.repeat(64),
    updatedAt: '2026-11-18T04:00:00.000Z',
    unread: false,
    deadline: {
      label: '承認期限',
      status: 'upcoming',
      at: '2026-11-19T05:00:00.000Z',
      remainingSeconds: 86400,
    },
  };
  const notification = {
    ...approval,
    kind: 'ticket',
    id: uuid(202),
    number: 'INC-202',
    title: '合成の通知',
    state: 'new',
    stateLabel: '受付済み',
    scopeLabel: '自分の担当',
    nextAction: '対応・返信を確認する',
    href: `/ops/${uuid(202)}`,
    unread: true,
    deadline: { label: '初回応答SLA', status: 'none', at: null, remainingSeconds: null },
  };
  const inbox = {
    items: [approval, notification],
    total: 2,
    unread: 1,
    page: 1,
    pageSize: 25,
    asOf: '2026-11-18T05:00:00.000Z',
    canIncludeUnassigned: true,
    counts: { ticket: 1, approval: 1, change: 0 },
    appliedFilter: { kind: 'all', q: '', unread: '0', unassigned: '0', page: 1 },
  };
  const work = {
    items: [
      ticket(1, -7200, '期限を過ぎた合成チケット'),
      ticket(2, 3 * 3600, '今日が期限の合成チケット'),
      ticket(3, 25 * 3600, '今週が期限の合成チケット'),
      ticket(4, 6 * 24 * 3600, '来週が期限の合成チケット'),
      ticket(5, null, '期限が未設定の合成チケット'),
    ],
    total: 5,
    scope: 'organization',
    appliedFilter: {},
    nextCursor: null,
  };

  const renderHome = async () =>
    renderToStaticMarkup(await OperationsOverview({ searchParams: Promise.resolve({}) }));

  beforeEach(() => {
    homeSession.current = agent;
    homeApi.listGroups.mockReset().mockResolvedValue({
      ok: true,
      data: { items: [{ id: uuid(20), name: '合成グループ' }] },
    });
    homeApi.ticketOverview
      .mockReset()
      .mockResolvedValue({ ok: true, data: { scope: 'organization', counts: homeCounts } });
    homeApi.listTickets.mockReset().mockResolvedValue({ ok: true, data: work });
    homeApi.inbox.mockReset().mockResolvedValue({ ok: true, data: inbox });
    inboxOpenCalls.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T05:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps four data calls and renders the three deadline groups in JST order', async () => {
    const html = await renderHome();
    expect(
      [homeApi.listGroups, homeApi.ticketOverview, homeApi.listTickets, homeApi.inbox].map(
        (fn) => fn.mock.calls.length,
      ),
    ).toEqual([1, 1, 1, 1]);
    expect(homeApi.listTickets.mock.calls[0]?.[0]).toBe(50);
    expect([...(homeApi.listTickets.mock.calls[0]?.[1] as URLSearchParams)]).toEqual([
      ['state', 'new'],
      ['state', 'assigned'],
      ['state', 'in_progress'],
      ['state', 'pending'],
      ['assignment', 'mine'],
      ['sort', 'deadline'],
    ]);
    expect(html).toContain('解決期限超過');
    expect(html).toContain('2時間超過');
    expect(html).toContain('今日 17:00');
    expect(html).toContain('11月19日(木)');
    expect(html).toContain('今日の対応は <strong class="home-count">5</strong>件です');
    expect(html.indexOf('id="home-work-overdue"')).toBeLessThan(
      html.indexOf('id="home-work-today"'),
    );
    expect(html.indexOf('id="home-work-today"')).toBeLessThan(html.indexOf('id="home-work-week"'));
    expect(html).toContain(`/ops/${uuid(101)}`);
    expect(html).toContain('内容を確認して承認判断する');
    expect(html).toContain(`href="/requests/${uuid(201)}"`);
    expect(html).toContain('承認の確定は承認者が行います');
    expect(html).not.toContain('/decisions');
    expect(html).toContain('合成の通知');
  });

  it('does not say there are no approvals when the total exceeds the loaded page', async () => {
    homeApi.inbox.mockResolvedValue({
      ok: true,
      data: {
        ...inbox,
        items: [notification],
        total: 1,
        unread: 1,
        counts: { ticket: 1, approval: 2, change: 0 },
      },
    });
    const html = await renderHome();
    expect(html).toContain('承認待ちが <strong>2</strong>件あります');
    expect(html).toContain('href="/inbox?kind=approval"');
    expect(html).not.toContain('あなたの承認待ちはありません');
  });

  it('counts the heading exactly when every assigned ticket is loaded', async () => {
    const paused = { ...ticket(6, 3 * 3600, 'SLAが止まっている合成チケット'), state: 'pending' };
    const items = [...work.items, paused];
    homeApi.listTickets.mockResolvedValue({
      ok: true,
      data: { ...work, items, total: items.length },
    });
    const html = await renderHome();
    expect(html).toContain('id="home-work-paused"');
    expect(html).toContain('計測停止中（SLA停止）');
    expect(html).toContain('SLA停止');
    // 全6件を読み込んでいるため、停止中1件を除いた5件が正確な見出しの件数。
    expect(html).toContain('今日の対応は <strong class="home-count">5</strong>件です');
    expect(html).not.toContain('期限の近い50件のうち');
    const pausedTitle = html.indexOf('SLAが止まっている合成チケット');
    expect(pausedTitle).toBeGreaterThan(html.indexOf('id="home-work-paused"'));
    expect(html.indexOf('SLAが止まっている合成チケット', pausedTitle + 1)).toBe(-1);
  });

  it('counts only the loaded range and links to the full list when truncated', async () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      index === 49
        ? {
            ...ticket(300 + index, 3 * 3600, 'SLAが止まっている合成チケット'),
            state: 'pending',
          }
        : ticket(300 + index, 6 * 24 * 3600, `期限が先の合成チケット ${index}`),
    );
    homeApi.listTickets.mockResolvedValue({
      ok: true,
      data: { ...work, items, total: 51 },
    });
    const html = await renderHome();
    // 全51件ではなく、読み込んだ50件のうち停止中1件を除いた49件。
    expect(html).toContain(
      '期限の近い50件のうち、対応中は <strong class="home-count">49</strong>件です',
    );
    expect(html).not.toContain('今日の対応は <strong class="home-count">');
    expect(html).toContain('全51件のうち、期限の近い50件だけを読み込み');
    expect(html).toContain('全件を期限順の一覧で確認する');
    expect(html).toContain('href="/ops?state=new');
  });

  it('records read through the existing inbox action before opening a notification', async () => {
    const html = await renderHome();
    expect(inboxOpenCalls).toHaveLength(1);
    expect(inboxOpenCalls[0]).toMatchObject({
      kind: 'ticket',
      id: notification.id,
      eventKey: notification.eventKey,
    });
    expect(html).toContain('data-inbox-open="true"');
    expect(html).toContain(`value="${notification.eventKey}"`);
    expect(html).not.toContain(`href="${notification.href}"`);
  });

  it('keeps each section visible when one source fails', async () => {
    homeApi.listTickets.mockResolvedValue({
      ok: false,
      problem: { status: 503, title: '合成の失敗' },
    });
    const workFailed = await renderHome();
    expect(workFailed).toContain('自分に割り当てられたチケットを表示できません');
    expect(workFailed).toContain('合成の承認依頼');
    expect(workFailed).toContain('解決期限超過');

    homeApi.listTickets.mockResolvedValue({ ok: true, data: work });
    homeApi.ticketOverview.mockResolvedValue({
      ok: false,
      problem: { status: 503, title: '合成の失敗' },
    });
    const overviewFailed = await renderHome();
    expect(overviewFailed).toContain('担当グループの件数を表示できません');
    expect(overviewFailed).toContain('期限を過ぎた合成チケット');

    homeApi.ticketOverview.mockResolvedValue({
      ok: true,
      data: { scope: 'organization', counts: homeCounts },
    });
    homeApi.inbox.mockResolvedValue({ ok: false, problem: { status: 503, title: '合成の失敗' } });
    const inboxFailed = await renderHome();
    expect(inboxFailed).toContain('承認待ちと通知');
    expect(inboxFailed).toContain('取得できませんでした。再読み込みをお試しください。');
    expect(inboxFailed).toContain('期限を過ぎた合成チケット');
  });

  it('shows an empty state for each empty section', async () => {
    homeApi.ticketOverview.mockResolvedValue({
      ok: true,
      data: { scope: 'organization', counts: { ...homeCounts, open: 0, breached: 0 } },
    });
    homeApi.listTickets.mockResolvedValue({
      ok: true,
      data: { ...work, items: [], total: 0 },
    });
    homeApi.inbox.mockResolvedValue({
      ok: true,
      data: {
        ...inbox,
        items: [],
        total: 0,
        unread: 0,
        counts: { ticket: 0, approval: 0, change: 0 },
      },
    });
    const html = await renderHome();
    expect(html).toContain('自分に割り当てられた未完了のチケットはありません');
    expect(html).toContain('あなたの承認待ちはありません');
    expect(html).toContain('新しい通知はありません');
    expect(html).toContain('この範囲に未完了のチケットはありません');
  });

  it('does not load any home data for a non-staff user', async () => {
    homeSession.current = {
      userId: uuid(11),
      organizationId: orgId,
      roles: [{ roleCode: 'requester', organizationId: orgId }],
    };
    const html = await renderHome();
    expect(html).toContain('この画面を表示する権限がありません');
    expect(homeApi.listGroups).not.toHaveBeenCalled();
    expect(homeApi.ticketOverview).not.toHaveBeenCalled();
    expect(homeApi.listTickets).not.toHaveBeenCalled();
    expect(homeApi.inbox).not.toHaveBeenCalled();
  });
});
