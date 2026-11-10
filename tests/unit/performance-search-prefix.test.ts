import { describe, expect, it, vi } from 'vitest';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import type { PerformanceFixture } from '../../tools/performance/fixture.mjs';
import type { ReadOnlyProof } from '../../tools/performance/list-query-analysis.mjs';
import {
  createSearchSemanticRuntime,
  type SearchCostQuery,
} from '../../tools/performance/search-cost-analysis.mjs';
import {
  analyzeSearchPrefix,
  analyzeSearchStatePrefix,
  assessPrefixCosts,
  assessPrefixFilters,
  assessStatePrefixCosts,
  createPrefixReferenceRuntime,
  preparePrefixCases,
  prefixBoundaryExpectation,
  summarizePrefixPlan,
  samplePrefixPlansValid,
  type PrefixCostTerm,
  type SearchPrefixRuntime,
  type SearchStatePrefixRuntime,
} from '../../tools/performance/search-prefix-analysis.mjs';

const id = (n: number) => `04800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
    userId: id(601),
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
const stamp = '2026-10-05 00:00:00.123456+00';
const row = () => ({
  id: id(1),
  organization_id: fixture.organizationId,
  requester_id: id(602),
  cursor_created_at: stamp,
  created_at: new Date(stamp),
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
const built = (name: string, combined = true): SearchCostQuery => ({
  sql: 'SELECT OLD_LIST FROM ticket',
  countSql: 'SELECT OLD_COUNT FROM ticket',
  params: [id(501), 50],
  countParams: [id(501)],
  limit: 50,
  ...(combined ? { combinedSql: `SELECT ${name} FROM ticket` } : {}),
});

function document(usable: boolean, bothBranches = false, probeRemoved = 0) {
  const scan = (loops: number, rows = 10) => ({
    'Node Type': 'Seq Scan',
    'Relation Name': 'ticket',
    'Actual Loops': loops,
    'Actual Rows': loops ? rows : 0,
    'Rows Removed by Filter': loops ? 90 : 0,
    Filter: "search_text ~~* 'PRIVATE-keyword'",
  });
  const producer = (name: string, rows: number, plans: Record<string, unknown>[]) => ({
    'Node Type': 'Result',
    'Subplan Name': `CTE ${name}`,
    'Actual Rows': rows,
    'Actual Loops': 1,
    Plans: plans,
  });
  const lookup = {
    'Node Type': 'Index Scan',
    'Relation Name': 'ticket',
    'Index Name': 'ticket_id_org_asset_key',
    'Index Cond': "id = 'PRIVATE-id'",
    'Actual Rows': 1,
    'Actual Loops': 3,
  };
  let page: Record<string, unknown> = {
    'Node Type': 'Nested Loop',
    'Actual Rows': 3,
    'Actual Loops': 1,
    Plans: [{ 'Node Type': 'Limit', 'Actual Rows': 3, 'Actual Loops': 1 }, lookup],
  };
  for (const alias of ['assignee', 'requester', 'assignee_group'])
    page = {
      'Node Type': 'Nested Loop',
      'Actual Rows': 3,
      'Actual Loops': 1,
      Plans: [
        page,
        { 'Node Type': 'Index Scan', Alias: alias, 'Actual Rows': 1, 'Actual Loops': 3 },
      ],
    };
  return [
    {
      Plan: {
        'Node Type': 'Nested Loop',
        'Actual Rows': 3,
        'Actual Loops': 1,
        Plans: [
          producer('probe_keys', 3, [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'ticket',
              'Index Name': 'ticket_list_org_idx',
              'Actual Rows': 3,
              'Actual Loops': 1,
              'Rows Removed by Filter': probeRemoved,
            },
          ]),
          producer('probe_evaluation', 3, [lookup]),
          producer('probe_status', 1, []),
          producer('matched', usable ? 0 : 10, [scan(!usable || bothBranches ? 1 : 0)]),
          producer('counted', 1, [scan(usable || bothBranches ? 1 : 0)]),
          page,
        ],
      },
      'Planning Time': 0.1,
      'Execution Time': 1,
    },
  ];
}

describe('WP048 prefix branch evidence', () => {
  it('requires every measured statement to have the expected known branch shape', () => {
    const statement = (
      expectedPrefix: boolean,
      branch: 'prefix' | 'fallback' | 'absent' | 'unproven',
      shapeMatchesExpectation = true,
    ) => ({
      completed: true,
      work: { prefix: { expectedPrefix, branch, shapeMatchesExpectation } },
    });
    for (const branch of ['prefix', 'fallback'] as const)
      expect(samplePrefixPlansValid({ statements: [statement(true, branch)] })).toBe(true);
    expect(
      samplePrefixPlansValid({
        statements: [statement(false, 'absent'), statement(false, 'absent')],
      }),
    ).toBe(true);
    expect(samplePrefixPlansValid({ statements: [statement(true, 'unproven')] })).toBe(false);
    expect(samplePrefixPlansValid({ statements: [statement(true, 'absent', false)] })).toBe(false);
    expect(samplePrefixPlansValid({ statements: [statement(false, 'prefix')] })).toBe(false);
    expect(
      samplePrefixPlansValid({
        statements: [statement(false, 'absent'), statement(true, 'unproven')],
      }),
    ).toBe(false);
    expect(samplePrefixPlansValid({ statements: [{ completed: true }] })).toBe(false);
    expect(samplePrefixPlansValid({ statements: [] })).toBe(false);
  });
  it.each([true, false])('records actual unused-branch zero loops, usable=%s', (usable) => {
    const result = summarizePrefixPlan(document(usable), 3);
    expect(result.present).toBe(true);
    expect(result.branch).toBe(usable ? 'prefix' : 'fallback');
    expect(result.matchedLoops).toBe(usable ? 0 : 1);
    expect(result.directCountLoops).toBe(usable ? 1 : 0);
    expect(result.pageUniqueLookupsBounded).toBe(true);
    expect(result.displayLookupsBounded).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('search_text');
  });
  it('does not claim short-circuiting if both underlying ticket branches execute', () => {
    expect(summarizePrefixPlan(document(true, true), 3).branch).toBe('unproven');
  });
  it('keeps authorization scan work visible even though the probe returns only three keys', () => {
    const result = summarizePrefixPlan(document(true, false, 997), 3);
    expect(result.probeRows).toBe(3);
    expect(result.probeVisitedRows).toBe(1000);
    expect(result.evaluationVisitedRows).toBe(3);
  });
  it('marks the old plan without prefix CTEs absent instead of inferring a fast branch', () => {
    expect(
      summarizePrefixPlan(
        [
          {
            Plan: { 'Node Type': 'Result', 'Actual Rows': 0, 'Actual Loops': 1 },
            'Planning Time': 0,
            'Execution Time': 0,
          },
        ],
        0,
      ).branch,
    ).toBe('absent');
  });
  it('rejects partial prefix plans and complete prefix disappearance when the SQL requires it', () => {
    const partial = document(true);
    partial[0]!.Plan.Plans = partial[0]!.Plan.Plans.filter(
      (node) => node['Subplan Name'] !== 'CTE probe_status',
    );
    const result = summarizePrefixPlan(partial, 3, true);
    expect(result.present).toBe(false);
    expect(result.branch).toBe('unproven');
    expect(result.shapeMatchesExpectation).toBe(false);
    const absent = [
      {
        Plan: { 'Node Type': 'Result', 'Actual Rows': 0, 'Actual Loops': 1 },
        'Planning Time': 0,
        'Execution Time': 0,
      },
    ];
    expect(summarizePrefixPlan(absent, 0, false).branch).toBe('absent');
    expect(summarizePrefixPlan(absent, 0, true).branch).toBe('unproven');
  });
});

describe('WP048 finite prefix oracle', () => {
  const definitions = preparePrefixCases(fixture);
  const get = (name: string) => definitions.find((item) => item.name === name)!;
  const expectCase = (name: string) => prefixBoundaryExpectation(get(name), stamp);
  it('covers 24 cases with both orders and all public/internal limit boundaries', () => {
    expect(definitions).toHaveLength(24);
    for (const direction of ['asc', 'desc'])
      for (const limit of [1, 50, 200]) {
        const result = expectCase(`all-${direction}-${limit}`);
        expect(result.usable).toBe(true);
        expect(result.total).toBe(9);
        expect(result.prefixRows).toBe(Math.min(limit, 9));
        expect(result.ids).toHaveLength(Math.min(limit, 9));
      }
  });
  it('rejects first, middle and NULL predicate rows without treating NULL as true', () => {
    for (const name of ['partial-first', 'partial-middle', 'null-keyword']) {
      const result = expectCase(name);
      expect(result.usable).toBe(false);
      expect(result.total).toBe(8);
      expect(result.ids).toHaveLength(3);
    }
    expect(expectCase('partial-first').ids[0]).toContain('000000000002');
    expect(expectCase('partial-middle').ids[0]).toContain('000000000001');
  });
  it('checks every individual filter independently including missing-policy SLA and date exclusions', () => {
    for (const item of definitions.filter((item) => item.name.startsWith('filter-')))
      expect(prefixBoundaryExpectation(item, stamp).usable).toBe(false);
    expect(expectCase('filter-sla-missing-policy').total).toBe(3);
    expect(
      expectCase('filter-sla-missing-policy').ids.some((value) => value.endsWith('000000000002')),
    ).toBe(true);
    expect(expectCase('filter-created-from').total).toBe(0);
    expect(expectCase('filter-created-to').total).toBe(0);
    expect(expectCase('filter-kind').total).toBe(1);
  });
  it('keeps own scope separate and preserves a nonzero total beyond the cursor terminal', () => {
    expect(expectCase('own-asc').total).toBe(8);
    const terminal = structuredClone(get('empty-prefix-terminal'));
    terminal.options.cursor = { createdAt: stamp, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
    expect(prefixBoundaryExpectation(terminal, stamp)).toEqual({
      total: 9,
      ids: [],
      usable: true,
      prefixRows: 0,
    });
    expect(expectCase('empty-prefix-zero')).toEqual({
      total: 0,
      ids: [],
      usable: true,
      prefixRows: 0,
    });
  });
});

describe('WP048 exact three-way runtime adapter', () => {
  function setup(alter046 = false) {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('OLD_COUNT')
        ? [{ total: 10 }]
        : sql.includes('OLD_LIST')
          ? [{ ...row(), ...(alter046 ? { created_at: new Date(stamp).toISOString() } : {}) }]
          : [{ ...row(), __solvi_total: 10 }],
    }));
    const runtime: SearchPrefixRuntime = {
      buildLegacySearchWorkloadQuery: () => built('ORIGINAL', false),
      buildLegacySearchPrefixQuery: () => built('PRIOR047'),
      buildTicketListQuery: () => built('CURRENT048'),
      withAppReadOnly: async (_context, callback) => callback({ query, proof }),
    };
    const reference = createPrefixReferenceRuntime(runtime, fixture);
    const adapted = createSearchSemanticRuntime(reference.runtime, fixture);
    return { query, runtime, reference, adapted };
  }
  it('executes the real 047 combined query and the two 046 statements in the same client', async () => {
    const { query, reference, adapted } = setup();
    await adapted.runtime.withAppReadOnly(
      { organizationId: fixture.organizationId, actorId: id(601) },
      async (client) => {
        const prior = adapted.runtime.buildLegacySearchQuery(ctx, {}),
          current = adapted.runtime.buildTicketListQuery(ctx, {});
        for (const candidate of [prior, current]) {
          expect((await client.query(candidate.sql, candidate.params)).rows).toEqual([row()]);
          expect((await client.query(candidate.countSql, candidate.countParams)).rows).toEqual([
            { total: 10 },
          ]);
        }
      },
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT PRIOR047 FROM ticket',
      'SELECT OLD_LIST FROM ticket',
      'SELECT OLD_COUNT FROM ticket',
      'SELECT CURRENT048 FROM ticket',
    ]);
    expect(reference.evidence.comparisons).toHaveLength(1);
    expect(reference.evidence.comparisons[0]!.comparison.equal).toBe(true);
    expect(reference.evidence.comparisons[0]!.contextIndex).toBe(0);
    expect(adapted.stats).toEqual({ combinedExecutions: 2, reusedTotals: 2 });
  });
  it('detects native-type differences in the 046 reference rather than silently comparing 047 twice', async () => {
    const { reference, adapted } = setup(true);
    await adapted.runtime.withAppReadOnly(
      { organizationId: fixture.organizationId, actorId: id(601) },
      async (client) => {
        const prior = adapted.runtime.buildLegacySearchQuery(ctx, {});
        await client.query(prior.sql, prior.params);
        await client.query(prior.countSql, prior.countParams);
      },
    );
    expect(reference.evidence.comparisons[0]!.comparison.fullRows).toBe(false);
    expect(reference.evidence.comparisons[0]!.comparison.equal).toBe(false);
    expect(JSON.stringify(reference.evidence)).not.toContain('PRIVATE');
  });
  it('counts duplicate next/terminal identities once even when baseline current equals 047', async () => {
    const { runtime, query } = setup();
    runtime.buildTicketListQuery = () => built('PRIOR047');
    const reference = createPrefixReferenceRuntime(runtime, fixture);
    const adapted = createSearchSemanticRuntime(reference.runtime, fixture);
    await adapted.runtime.withAppReadOnly(
      { organizationId: fixture.organizationId, actorId: id(601) },
      async (client) => {
        for (const _phase of ['next', 'terminal']) {
          const prior = adapted.runtime.buildLegacySearchQuery(ctx, {}),
            current = adapted.runtime.buildTicketListQuery(ctx, {});
          for (const query of [prior, current]) {
            await client.query(query.sql, query.params);
            await client.query(query.countSql, query.countParams);
          }
        }
      },
    );
    expect(reference.evidence.coverage).toEqual([
      { contextIndex: 0, expectedDistinctQueries: 1, comparedDistinctQueries: 1, complete: true },
    ]);
    expect(reference.evidence.comparisons).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('OLD_LIST'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('PRIOR047'))).toHaveLength(4);
  });
  it('fails closed if a scheduled reference query was never executed', async () => {
    const { reference, adapted } = setup();
    await expect(
      adapted.runtime.withAppReadOnly(
        { organizationId: fixture.organizationId, actorId: id(601) },
        async () => {
          adapted.runtime.buildLegacySearchQuery(ctx, {});
        },
      ),
    ).rejects.toThrow('PREFIX_REFERENCE_REQUIRED');
    expect(reference.evidence.coverage[0]).toEqual({
      contextIndex: 0,
      expectedDistinctQueries: 1,
      comparedDistinctQueries: 0,
      complete: false,
    });
  });
  it('returns a bounded safe aborted report without invoking runtime', async () => {
    const { runtime } = setup();
    const controller = new AbortController();
    controller.abort(new Error('PRIVATE-reason'));
    const result = await analyzeSearchPrefix(runtime, fixture, controller.signal);
    expect(result.completed).toBe(false);
    expect(result.failureCode).toBe('PREFIX_ABORTED');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('WP048 practical cost assessment', () => {
  const terms = (short: number) =>
    ['short', 'wide', 'rare', 'zero'].map((name) => ({
      name,
      completed: true,
      samples: Array.from({ length: 4 }, (_, index) => ({
        repetition: index + 1,
        completed: true,
        order: ['original046', 'prior047', 'candidate'],
        original046: { statements: [{ work: { plan: { executionMs: 100 } } }] },
        prior047: {
          statements: [{ work: { plan: { executionMs: name === 'short' ? 120 : 100 } } }],
        },
        candidate: {
          statements: [{ work: { plan: { executionMs: name === 'short' ? short : 104 } } }],
        },
      })),
    })) as unknown as PrefixCostTerm[];
  it('compares short against both fixed references and never labels SQL alone adopted', () => {
    const result = assessPrefixCosts(terms(104));
    expect(result.meetsSqlCriteria).toBe(true);
    expect(result.terms[0]!.versus046).toBe(1.04);
    expect(result.adoptionEstablished).toBe(false);
  });
  it('records failure of the 046 bound despite improving on the slower 047 reference', () => {
    const result = assessPrefixCosts(terms(106));
    expect(result.terms[0]!.withinBounds).toBe(false);
    expect(result.meetsSqlCriteria).toBe(false);
    expect(result.adoptionEstablished).toBe(false);
  });
  it('keeps repeated state-filter regression separate even if the four primary terms pass', () => {
    expect(assessPrefixCosts(terms(104)).meetsSqlCriteria).toBe(true);
    const filtered = terms(106)
      .slice(0, 2)
      .map((term, index) => ({ ...term, name: index === 0 ? 'short-new' : 'short-own' }));
    const result = assessPrefixFilters(filtered);
    expect(result.requiresAdoptionHold).toBe(true);
    expect(result.terms[0]!.repetitionsOver046ByFivePercent).toBe(4);
    expect(result.terms[0]!.observations[0]!.deltaMs).toBe(6);
    expect(result.terms[1]!.versus046).toBe(1.04);
    expect(result.adoptionEstablished).toBe(false);
  });
});

describe('WP049 fixed 048 reference and state work evidence', () => {
  const probeOf = (value: ReturnType<typeof document>) =>
    (value[0]!.Plan.Plans[0]!.Plans as Array<Record<string, unknown>>)[0]!;
  function stateDocument() {
    const value = document(true);
    const probe = probeOf(value);
    Object.assign(probe, {
      'Index Name': 'ticket_list_state_idx',
      'Index Cond': "((organization_id = 'PRIVATE-org') AND (state = 'PRIVATE-state'))",
    });
    return value;
  }
  it('requires one ordered state-index scan with both equalities and visible bounded work', () => {
    const value = stateDocument();
    const result = summarizePrefixPlan(value, 3, true, '049');
    expect(result.stateProbe).toMatchObject({ orderedStateIndex: true, visitsBounded: true });
    expect(result.stateProbe!.scans[0]).toMatchObject({
      indexName: 'ticket_list_state_idx',
      organizationEquality: true,
      stateEquality: true,
      loops: 1,
      visitedRows: 3,
      removedRows: 0,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(summarizePrefixPlan(value, 3, true).stateProbe).toBeUndefined();
  });
  it.each([
    ['wrong index', { 'Index Name': 'ticket_list_org_idx' }],
    ['unknown index', { 'Index Name': 'unknown_ticket_idx' }],
    ['bitmap scan', { 'Node Type': 'Bitmap Heap Scan' }],
    ['repeated scan', { 'Actual Loops': 2 }],
    ['missing organization', { 'Index Cond': "state = 'PRIVATE-state'" }],
    [
      'state ANY',
      { 'Index Cond': "organization_id = 'PRIVATE-org' AND state = ANY ('PRIVATE-array')" },
    ],
  ])('does not certify %s as the intended state probe', (_label, change) => {
    const value = stateDocument();
    Object.assign(probeOf(value), change);
    const result = summarizePrefixPlan(value, 3, true, '049');
    expect(result.stateProbe!.orderedStateIndex).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not confuse three returned keys with a scan of the entire population', () => {
    const value = stateDocument();
    Object.assign(probeOf(value), { 'Rows Removed by Filter': 99997 });
    const result = summarizePrefixPlan(value, 3, true, '049');
    expect(result.stateProbe!.scans[0]!.visitedRows).toBe(100000);
    expect(result.stateProbe!.visitsBounded).toBe(false);
  });
  it('retains 24 original cases and adds 22 bounded state scenarios with different 048/049 branch oracles', () => {
    const old = preparePrefixCases(fixture);
    const next = preparePrefixCases(fixture, '049');
    expect(next).toHaveLength(46);
    expect(next.slice(0, 24)).toEqual(old);
    for (const state of [
      'new',
      'assigned',
      'in_progress',
      'pending',
      'resolved',
      'closed',
      'cancelled',
      'merged',
    ]) {
      const definition = next.find((item) => item.name === `state-single-${state}`)!;
      const legacy = prefixBoundaryExpectation(definition, stamp);
      const candidate = prefixBoundaryExpectation(definition, stamp, '049');
      expect(candidate.total).toBe(2); // The third matching state belongs to the control organization.
      expect(candidate.ids).toEqual(legacy.ids);
      expect(candidate.usable).toBe(true);
      expect(legacy.usable).toBe(false);
    }
    for (const name of ['state-multiple', 'state-duplicate', 'state-own']) {
      const definition = next.find((item) => item.name === name)!;
      expect(prefixBoundaryExpectation(definition, stamp, '049')).toEqual(
        prefixBoundaryExpectation(definition, stamp),
      );
    }
    for (const name of ['state-other-filter', 'state-null-keyword']) {
      expect(
        prefixBoundaryExpectation(
          next.find((item) => item.name === name)!,
          stamp,
          '049',
        ).usable,
      ).toBe(false);
    }
    expect(
      prefixBoundaryExpectation(
        next.find((item) => item.name === 'state-empty')!,
        stamp,
        '049',
      ),
    ).toMatchObject({ total: 0, ids: [], usable: true, prefixRows: 0 });
  });
  it('preserves precise cursor values while skipping sparse earlier states and retaining terminal total', () => {
    const cases = preparePrefixCases(fixture, '049');
    for (const direction of ['asc', 'desc'] as const)
      for (const limit of [1, 50, 200]) {
        const definition = cases.find((item) => item.name === `state-gaps-${direction}-${limit}`)!;
        const all = prefixBoundaryExpectation(definition, stamp, '049');
        definition.options.cursor = { createdAt: stamp, id: all.ids.at(-1)! };
        const next = prefixBoundaryExpectation(definition, stamp, '049');
        expect(next.total).toBe(2);
        expect(next.ids.some((value) => all.ids.includes(value))).toBe(false);
        expect(definition.options.cursor.createdAt).toBe(stamp);
        if (limit > 1) expect(next.ids).toEqual([]);
      }
  });
  async function compare048(alter = false) {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('OLD_COUNT')
        ? [{ total: 10 }]
        : sql.includes('OLD_LIST')
          ? [row()]
          : [
              {
                ...row(),
                ...(alter && sql.includes('PRIOR048')
                  ? { created_at: new Date(stamp).toISOString() }
                  : {}),
                __solvi_total: 10,
              },
            ],
    }));
    const runtime: SearchStatePrefixRuntime = {
      buildLegacySearchWorkloadQuery: () => built('ORIGINAL', false),
      buildLegacySearchPrefixQuery: () => built('PRIOR047'),
      buildLegacySearch048Query: () => built('PRIOR048'),
      buildTicketListQuery: () => built('PRIOR048'),
      withAppReadOnly: async (_context, callback) => callback({ query, proof }),
    };
    const reference = createPrefixReferenceRuntime(runtime, fixture, undefined, '049');
    const adapted = createSearchSemanticRuntime(reference.runtime, fixture);
    await adapted.runtime.withAppReadOnly(
      { organizationId: fixture.organizationId, actorId: id(601) },
      async (client) => {
        for (const _phase of ['next', 'terminal']) {
          const old = adapted.runtime.buildLegacySearchQuery(ctx, {});
          const candidate = adapted.runtime.buildTicketListQuery(ctx, {});
          for (const item of [old, candidate]) {
            await client.query(item.sql, item.params);
            await client.query(item.countSql, item.countParams);
          }
        }
      },
    );
    return { query, reference, runtime };
  }
  it('executes fixed 048 as a distinct reference even when the current baseline is also 048', async () => {
    const { query, reference } = await compare048();
    expect(reference.evidence.coverage).toEqual([
      { contextIndex: 0, expectedDistinctQueries: 1, comparedDistinctQueries: 1, complete: true },
    ]);
    expect(reference.evidence.comparisons048).toHaveLength(1);
    expect(reference.evidence.comparisons048![0]!.comparison.equal).toBe(true);
    expect(reference.evidence.unchanged048!.every((item) => !item.eligible && item.equal)).toBe(
      true,
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT PRIOR047 FROM ticket',
      'SELECT OLD_LIST FROM ticket',
      'SELECT OLD_COUNT FROM ticket',
      'SELECT PRIOR048 FROM ticket',
      'SELECT PRIOR048 FROM ticket',
      'SELECT PRIOR047 FROM ticket',
      'SELECT PRIOR048 FROM ticket',
    ]);
  });
  it('rejects native Date-to-string changes in the fixed 048 reference without exposing values', async () => {
    const { reference } = await compare048(true);
    expect(reference.evidence.comparisons048![0]!.comparison.fullRows).toBe(false);
    expect(reference.evidence.comparisons048![0]!.comparison.equal).toBe(false);
    expect(JSON.stringify(reference.evidence)).not.toContain('PRIVATE');
  });
  it('preserves safe abort semantics in the new entry', async () => {
    const { runtime } = await compare048();
    const abort = new AbortController();
    abort.abort('PRIVATE');
    const report = await analyzeSearchStatePrefix(runtime, fixture, abort.signal);
    expect(report).toMatchObject({
      completed: false,
      equivalent: false,
      failureCode: 'PREFIX_ABORTED',
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it.each([
    ['auditor', false, true],
    ['platform_auditor', true, true],
    ['platform_admin', true, true],
    ['agent', false, true],
    ['requester', false, false],
  ] as Array<[RoleCode, boolean, boolean]>)(
    'classifies %s with the product organization-wide binding rules',
    (role, global, eligible) => {
      const runtime: SearchStatePrefixRuntime = {
        buildLegacySearchWorkloadQuery: () => built('ORIGINAL', false),
        buildLegacySearchPrefixQuery: () => built('PRIOR047'),
        buildLegacySearch048Query: () => built('PRIOR048'),
        buildTicketListQuery: () => ({
          ...built('CURRENT'),
          combinedSql: 'SELECT * FROM (WITH probe_keys AS MATERIALIZED (SELECT 1) SELECT 1) q',
        }),
        withAppReadOnly: async (_context, callback) =>
          callback({ query: async () => ({ rows: [] }), proof }),
      };
      const reference = createPrefixReferenceRuntime(runtime, fixture, undefined, '049');
      const now = new Date(stamp);
      const context: AuthzContext = {
        ...ctx,
        now,
        principal: {
          ...ctx.principal,
          bindings: [
            {
              roleCode: role,
              organizationId: global ? null : ctx.organizationId,
              validFrom: new Date(now),
              validUntil: new Date(now.getTime() + 1),
            },
          ],
        },
      };
      const options = { filter: { state: ['new' as const] } };
      reference.runtime.buildTicketListQuery(context, options);
      expect(reference.evidence.unchanged048!.at(-1)!.eligible).toBe(eligible);
      context.principal.bindings[0]!.validUntil = new Date(now);
      reference.runtime.buildTicketListQuery(context, options);
      expect(reference.evidence.unchanged048!.at(-1)!.eligible).toBe(false);
      context.principal.bindings[0]!.validUntil = null;
      context.principal.bindings[0]!.validFrom = new Date(now.getTime() + 1);
      reference.runtime.buildTicketListQuery(context, options);
      expect(reference.evidence.unchanged048!.at(-1)!.eligible).toBe(false);
    },
  );
  function costs(newCost = 104, additional = 104) {
    return [
      'short',
      'wide',
      'rare',
      'zero',
      'short-new',
      'short-own',
      'short-assigned',
      'rare-state',
      'zero-new',
    ].map((name) => ({
      name,
      completed: true,
      samples: Array.from({ length: 4 }, (_, index) => ({
        repetition: index + 1,
        order: ['original046', 'prior047', 'prior048', 'candidate'],
        completed: true,
        ...Object.fromEntries(
          ['original046', 'prior047', 'prior048', 'candidate'].map((side) => [
            side,
            {
              statements: [
                {
                  work: {
                    plan: {
                      executionMs:
                        side === 'candidate'
                          ? name === 'short-new'
                            ? newCost
                            : name === 'short-assigned'
                              ? additional
                              : 100
                          : side === 'prior048' && name === 'short-new'
                            ? 120
                            : 100,
                    },
                  },
                },
              ],
            },
          ]),
        ),
      })),
    })) as unknown as PrefixCostTerm[];
  }
  it('requires short-new improvement against048 and the046 bound without asserting adoption', () => {
    const terms = costs();
    const result = assessStatePrefixCosts(terms.slice(0, 4), terms.slice(4));
    expect(result.primary.meetsSqlCriteria).toBe(true);
    expect(result.filters.requiresAdoptionHold).toBe(false);
    expect(result.primary.adoptionEstablished).toBe(false);
    expect(result.filters.terms[0]).toMatchObject({ delta046Ms: 4, delta048Ms: -16 });
    const slower = costs(106);
    expect(
      assessStatePrefixCosts(slower.slice(0, 4), slower.slice(4)).primary.meetsSqlCriteria,
    ).toBe(false);
  });
  it('holds adoption for repeated additional-state regression and rejects missing measurements', () => {
    const terms = costs(104, 106);
    const result = assessStatePrefixCosts(terms.slice(0, 4), terms.slice(4));
    expect(result.primary.meetsSqlCriteria).toBe(true);
    expect(result.filters.requiresAdoptionHold).toBe(true);
    expect(
      result.filters.terms.find((item) => item.name === 'short-assigned')!
        .repetitionsOver048ByFivePercent,
    ).toBe(4);
    terms[0]!.samples.pop();
    expect(() => assessStatePrefixCosts(terms.slice(0, 4), terms.slice(4))).toThrow(
      'PREFIX_RESULT_INVALID',
    );
  });
});
