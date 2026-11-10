import { performance } from 'node:perf_hooks';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';

export const OVERVIEW_METRICS = ['open', 'unassigned', 'mine', 'pending', 'breached', 'critical'];
const OPEN_STATES = ['new', 'assigned', 'in_progress', 'pending'];
// Matches the empty-membership sentinel in the existing list route.
const NO_MATCH_UUID = '00000000-0000-4000-8000-0000000000ff';
const UNKNOWN_GROUP = '04300000-0000-4000-8000-999999999999';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const zeros = () => Object.fromEntries(OVERVIEW_METRICS.map((key) => [key, 0]));
const safeError = (error) => {
  const allowed = new Set([
    'QUERY_PLAN_INVALID',
    'QUERY_READ_ONLY_PROOF_INVALID',
    'OVERVIEW_RUNTIME_REQUIRED',
    'OVERVIEW_ACTORS_REQUIRED',
    'OVERVIEW_FIXTURE_INVALID',
    'OVERVIEW_BINDINGS_MISMATCH',
    'OVERVIEW_GROUPS_REQUIRED',
    'OVERVIEW_MEMBERSHIP_INVALID',
    'OVERVIEW_CONTROL_MISSING',
    'OVERVIEW_COUNTS_INVALID',
    'OVERVIEW_QUERY_REJECTED',
    'OVERVIEW_ANALYSIS_ABORTED',
    'OVERVIEW_ANALYSIS_TIME_LIMIT',
  ]);
  return allowed.has(error?.message) ? error.message : 'OVERVIEW_ANALYSIS_FAILED';
};

export function sanitizeOverviewCounts(value) {
  check(
    value &&
      typeof value === 'object' &&
      Object.keys(value).length === OVERVIEW_METRICS.length &&
      OVERVIEW_METRICS.every(
        (key) => Object.hasOwn(value, key) && Number.isSafeInteger(value[key]) && value[key] >= 0,
      ),
    'OVERVIEW_COUNTS_INVALID',
  );
  const counts = Object.fromEntries(OVERVIEW_METRICS.map((key) => [key, value[key]]));
  check(
    OVERVIEW_METRICS.every((key) => counts[key] <= counts.open),
    'OVERVIEW_COUNTS_INVALID',
  );
  return counts;
}

export function compareOverviewCounts(legacy, aggregate, expected) {
  const left = sanitizeOverviewCounts(legacy);
  const right = sanitizeOverviewCounts(aggregate);
  const metrics = Object.fromEntries(
    OVERVIEW_METRICS.map((key) => [key, left[key] === right[key]]),
  );
  const expectedPopulation = expected
    ? OVERVIEW_METRICS.every((key) => left[key] === expected[key] && right[key] === expected[key])
    : left.open > 0 && right.open > 0;
  return {
    equal: Object.values(metrics).every(Boolean) && expectedPopulation,
    metrics,
    expectedPopulation,
  };
}

const contextFor = (actor, organizationId) => ({
  organizationId,
  principal: {
    userId: actor.userId,
    status: 'active',
    bindings: [
      {
        roleCode: actor.role === 'admin' ? 'org_admin' : actor.role,
        organizationId,
        validFrom: new Date(0),
        validUntil: null,
      },
    ],
  },
});

/** Pure synthetic rows only: these cases never create or modify a database fixture. */
export function prepareOverviewCases({ fixture }) {
  const actor = fixture.actors.find((value) => value.role === 'agent');
  check(
    actor && UUID.test(actor.userId) && UUID.test(fixture.organizationId),
    'OVERVIEW_ACTORS_REQUIRED',
  );
  const policy = {
    organization_id: fixture.organizationId,
    priority: 'low',
    response_target_minutes: 1,
    resolution_target_minutes: 1,
  };
  const ticket = (changes = {}) => ({
    organization_id: fixture.organizationId,
    requester_id: actor.userId,
    state: 'new',
    priority: 'low',
    assignee_id: null,
    assignee_group_id: null,
    sla_elapsed_seconds: 60,
    clock_age_seconds: null,
    ...changes,
  });
  const edge = (name, tickets, expected, policies = [policy]) => ({
    name,
    tickets,
    policies,
    expected: { ...zeros(), ...expected },
  });
  return [
    edge('sla-exact-paused', [ticket()], { open: 1, unassigned: 1 }),
    edge(
      'sla-overdue-paused',
      [ticket({ state: 'in_progress', assignee_id: actor.userId, sla_elapsed_seconds: 61 })],
      { open: 1, mine: 1, breached: 1 },
    ),
    edge(
      'sla-exact-running',
      [ticket({ state: 'in_progress', sla_elapsed_seconds: 10, clock_age_seconds: 50 })],
      { open: 1, unassigned: 1 },
    ),
    edge(
      'sla-overdue-running',
      [ticket({ state: 'assigned', sla_elapsed_seconds: 10, clock_age_seconds: 51 })],
      { open: 1, unassigned: 1, breached: 1 },
    ),
    edge(
      'pending-paused',
      [
        ticket({ state: 'pending' }),
        ticket({ state: 'pending', assignee_id: actor.userId, sla_elapsed_seconds: 61 }),
      ],
      { open: 2, unassigned: 1, mine: 1, pending: 2, breached: 1 },
    ),
    edge(
      'sla-missing-policy',
      [ticket({ priority: 'critical', sla_elapsed_seconds: 999999 })],
      { open: 1, unassigned: 1, critical: 1 },
      [],
    ),
    edge(
      'terminal-only',
      ['resolved', 'closed', 'cancelled', 'merged'].map((state) =>
        ticket({ state, priority: 'critical', sla_elapsed_seconds: 999999 }),
      ),
      {},
    ),
    edge('empty', [], {}),
  ];
}

/** Shadow only the two read sources, preserving the actual compiled predicates and parameters. */
export function buildOverviewEdgeQuery(built, edge) {
  check(
    built &&
      typeof built.sql === 'string' &&
      /^\s*SELECT\b/.test(built.sql) &&
      !built.sql.includes(';') &&
      Array.isArray(built.params),
    'OVERVIEW_QUERY_REJECTED',
  );
  const parameter = `$${built.params.length + 1}::jsonb`;
  return {
    sql: `SELECT * FROM (
      WITH ticket AS (
        SELECT x.organization_id::uuid AS organization_id, x.requester_id::uuid AS requester_id,
          x.state, x.priority, x.assignee_id::uuid AS assignee_id,
          x.assignee_group_id::uuid AS assignee_group_id, x.sla_elapsed_seconds,
          CASE WHEN x.clock_age_seconds IS NULL THEN NULL
            ELSE now() - x.clock_age_seconds * interval '1 second' END AS sla_clock_started_at
        FROM jsonb_to_recordset(${parameter}->'tickets') AS x(
          organization_id text, requester_id text, state text, priority text,
          assignee_id text, assignee_group_id text, sla_elapsed_seconds int, clock_age_seconds int)
      ), sla_policy AS (
        SELECT x.organization_id::uuid AS organization_id, x.priority,
          x.response_target_minutes, x.resolution_target_minutes
        FROM jsonb_to_recordset(${parameter}->'policies') AS x(
          organization_id text, priority text, response_target_minutes int, resolution_target_minutes int)
      ) ${built.sql}
    ) AS overview_edge`,
    params: [...built.params, JSON.stringify({ tickets: edge.tickets, policies: edge.policies })],
  };
}

// Resolve exactly the pre-existing GroupService.myGroups population under the app RLS role.
const membershipSql = `SELECT g.id FROM assignment_group g
  JOIN assignment_group_member m ON m.group_id=g.id
  WHERE m.user_id=$1 AND g.active ORDER BY g.name`;
const validGroupRows = (rows) => {
  check(Array.isArray(rows) && rows.every((row) => UUID.test(row.id)), 'OVERVIEW_GROUPS_REQUIRED');
  return rows.map((row) => row.id);
};

export async function runOverviewAnalysis({ runtime, fixture, signal }) {
  const started = performance.now();
  const report = { completed: false, equivalent: false, cases: [], readOnlyContexts: [] };
  const budget = () => {
    check(!signal?.aborted, 'OVERVIEW_ANALYSIS_ABORTED');
    check(performance.now() - started < 120_000, 'OVERVIEW_ANALYSIS_TIME_LIMIT');
  };
  try {
    budget();
    check(
      runtime &&
        ['withAppReadOnly', 'buildTicketListQuery', 'buildTicketOverviewQuery'].every(
          (name) => typeof runtime[name] === 'function',
        ),
      'OVERVIEW_RUNTIME_REQUIRED',
    );
    const staff = fixture.actors.find((actor) => actor.role === 'agent');
    const administrator = fixture.actors.find((actor) => actor.role === 'admin');
    check(staff && administrator, 'OVERVIEW_ACTORS_REQUIRED');
    check(
      [
        fixture.organizationId,
        fixture.controlOrganizationId,
        fixture.controlTicketId,
        staff.userId,
        administrator.userId,
      ].every((id) => UUID.test(id)),
      'OVERVIEW_FIXTURE_INVALID',
    );
    check(
      Array.isArray(fixture.counts.states) &&
        fixture.counts.states.every((row) => Number.isSafeInteger(row.n) && row.n >= 0),
      'OVERVIEW_FIXTURE_INVALID',
    );
    const expectedOpen = fixture.counts.states
      .filter((row) => OPEN_STATES.includes(row.state))
      .reduce((total, row) => total + row.n, 0);
    check(expectedOpen > 0, 'OVERVIEW_FIXTURE_INVALID');
    const query = async (client, sql, params = []) => {
      budget();
      const result = await client.query(sql, params);
      budget();
      return result;
    };
    const readOnly = (name, context, callback) =>
      runtime.withAppReadOnly(context, async (client) => {
        const proof = sanitizeReadOnlyProof(client.proof);
        report.readOnlyContexts.push({ name, proof });
        return callback(client, proof);
      });
    let groupId;
    let controlGroupId;
    await readOnly(
      'fixture-bindings',
      { organizationId: fixture.organizationId, actorId: staff.userId },
      async (client) => {
        const bindings = await query(
          client,
          `SELECT rb.user_id,r.code FROM role_binding rb JOIN role r ON r.id=rb.role_id JOIN app_user u ON u.id=rb.user_id
        WHERE rb.organization_id=$1 AND rb.user_id=ANY($2::uuid[]) AND rb.valid_from<=now()
        AND (rb.valid_until IS NULL OR rb.valid_until>now()) AND u.status='active'`,
          [fixture.organizationId, [staff.userId, administrator.userId]],
        );
        check(
          bindings.rows.some((row) => row.user_id === staff.userId && row.code === 'agent') &&
            bindings.rows.some(
              (row) => row.user_id === administrator.userId && row.code === 'org_admin',
            ),
          'OVERVIEW_BINDINGS_MISMATCH',
        );
        groupId = validGroupRows(
          (
            await query(
              client,
              'SELECT id FROM assignment_group WHERE organization_id=$1 AND active ORDER BY code LIMIT 1',
              [fixture.organizationId],
            )
          ).rows,
        )[0];
        check(groupId, 'OVERVIEW_GROUPS_REQUIRED');
        const reserved = await query(
          client,
          'SELECT count(*)::int n FROM assignment_group WHERE id=ANY($1::uuid[])',
          [[NO_MATCH_UUID, UNKNOWN_GROUP]],
        );
        check(reserved.rows[0]?.n === 0, 'OVERVIEW_FIXTURE_INVALID');
      },
    );
    await readOnly(
      'control-population',
      { organizationId: fixture.controlOrganizationId, actorId: staff.userId },
      async (client) => {
        controlGroupId = validGroupRows(
          (
            await query(
              client,
              'SELECT id FROM assignment_group WHERE organization_id=$1 AND active ORDER BY code LIMIT 1',
              [fixture.controlOrganizationId],
            )
          ).rows,
        )[0];
        check(controlGroupId, 'OVERVIEW_GROUPS_REQUIRED');
        const control = await query(
          client,
          'SELECT count(*)::int n FROM ticket WHERE id=$1 AND organization_id=$2',
          [fixture.controlTicketId, fixture.controlOrganizationId],
        );
        check(control.rows[0]?.n === 1, 'OVERVIEW_CONTROL_MISSING');
      },
    );
    const definitions = [
      { name: 'all', actor: staff, expectedOpen },
      { name: 'mine', actor: staff, group: 'mine', hasMembership: true },
      { name: 'ungrouped', actor: staff, group: 'ungrouped' },
      { name: 'specified-group', actor: staff, group: groupId },
      { name: 'other-organization-group', actor: staff, group: controlGroupId, expected: zeros() },
      { name: 'unknown-group', actor: staff, group: UNKNOWN_GROUP, expected: zeros() },
      {
        name: 'no-membership',
        actor: administrator,
        group: 'mine',
        hasMembership: false,
        expected: zeros(),
      },
      {
        name: 'organization-rls-mismatch',
        actor: staff,
        organizationId: fixture.controlOrganizationId,
        expected: zeros(),
      },
      ...prepareOverviewCases({ fixture }).map((edge) => ({
        name: edge.name,
        actor: staff,
        edge,
        expected: edge.expected,
      })),
    ];
    for (const definition of definitions) {
      budget();
      const apiComparable = [
        'all',
        'mine',
        'ungrouped',
        'specified-group',
        'other-organization-group',
        'unknown-group',
      ].includes(definition.name);
      const item = {
        name: definition.name,
        mode: definition.edge ? 'synthetic-cte' : 'actual-table',
        rlsEvidence: !definition.edge,
        apiComparable,
        actorRole: definition.actor.role,
        ...(apiComparable ? { options: definition.group ? { group: definition.group } : {} } : {}),
        stage: 'context',
        completed: false,
        legacy: { counts: {}, plans: {} },
        aggregate: {},
      };
      report.cases.push(item);
      await readOnly(
        definition.name,
        {
          organizationId: definition.organizationId ?? fixture.organizationId,
          actorId: definition.actor.userId,
        },
        async (client, proof) => {
          item.proof = proof;
          const ctx = contextFor(definition.actor, fixture.organizationId);
          const groupFilter = {};
          if (definition.group === 'mine') {
            item.stage = 'memberships';
            const ids = validGroupRows(
              (await query(client, membershipSql, [definition.actor.userId])).rows,
            );
            check(ids.length > 0 === definition.hasMembership, 'OVERVIEW_MEMBERSHIP_INVALID');
            groupFilter.assigneeGroupIds = ids.length ? ids : [NO_MATCH_UUID];
            item.membershipCount = ids.length;
          } else if (definition.group === 'ungrouped') groupFilter.ungroupedOnly = true;
          else if (definition.group) groupFilter.assigneeGroupIds = [definition.group];
          const wrap = (built) =>
            definition.edge ? buildOverviewEdgeQuery(built, definition.edge) : built;
          const explain = async (built) => {
            const result = await query(
              client,
              'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + built.sql,
              built.params,
            );
            return sanitizeExplain(result.rows[0]?.['QUERY PLAN']);
          };
          const legacyQueries = {};
          for (const metric of OVERVIEW_METRICS) {
            const filter = {
              ...groupFilter,
              state: metric === 'pending' ? ['pending'] : OPEN_STATES,
            };
            if (metric === 'unassigned') filter.unassignedOnly = true;
            if (metric === 'mine') filter.assigneeId = definition.actor.userId;
            if (metric === 'breached') filter.slaBreachedOnly = true;
            if (metric === 'critical') filter.priority = ['critical'];
            const built = runtime.buildTicketListQuery(ctx, { filter, limit: 1 });
            legacyQueries[metric] = wrap({ sql: built.countSql, params: built.countParams });
            item.stage = `legacy-${metric}-count`;
            const result = await query(
              client,
              legacyQueries[metric].sql,
              legacyQueries[metric].params,
            );
            check(
              result.rows.length === 1 &&
                Number.isSafeInteger(result.rows[0].total) &&
                result.rows[0].total >= 0,
              'OVERVIEW_COUNTS_INVALID',
            );
            item.legacy.counts[metric] = result.rows[0].total;
          }
          const aggregate = wrap(
            runtime.buildTicketOverviewQuery(ctx, { group: definition.group }),
          );
          item.stage = 'aggregate-count';
          const result = await query(client, aggregate.sql, aggregate.params);
          check(result.rows.length === 1, 'OVERVIEW_COUNTS_INVALID');
          item.aggregate.counts = sanitizeOverviewCounts(result.rows[0]);
          item.comparison = compareOverviewCounts(
            item.legacy.counts,
            item.aggregate.counts,
            definition.expected,
          );
          if (definition.expectedOpen !== undefined) {
            item.comparison.expectedPopulation &&=
              item.legacy.counts.open === definition.expectedOpen &&
              item.aggregate.counts.open === definition.expectedOpen;
            item.comparison.equal &&= item.comparison.expectedPopulation;
          }
          for (const metric of OVERVIEW_METRICS) {
            item.stage = `legacy-${metric}-explain`;
            item.legacy.plans[metric] = await explain(legacyQueries[metric]);
          }
          item.stage = 'aggregate-explain';
          item.aggregate.plan = await explain(aggregate);
          item.completed = true;
          item.stage = 'complete';
        },
      );
    }
    report.completed = true;
    report.equivalent = report.cases.every(
      (item) => item.completed && item.comparison?.equal === true,
    );
  } catch (error) {
    report.failureCode = signal?.aborted ? 'OVERVIEW_ANALYSIS_ABORTED' : safeError(error);
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
