import { performance } from 'node:perf_hooks';
import {
  compareQueryResults,
  sanitizeExplain,
  sanitizeReadOnlyProof,
} from './list-query-analysis.mjs';

const check = (value, code) => {
  if (!value) throw new Error(code);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ACTIVE = ['new', 'assigned', 'in_progress'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIASES = ['assignee', 'requester', 'assignee_group'];
const REQUIRED_FIELDS = [
  'id',
  'organization_id',
  'requester_id',
  'cursor_created_at',
  'assignee_name',
  'requester_name',
  'assignee_group_name',
  'sla_elapsed_now',
  'remaining_seconds',
  'response_target_minutes',
  'resolution_target_minutes',
  'sla_elapsed_seconds',
  'sla_clock_started_at',
];
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
const failureCodes = new Set([
  'DEADLINE_ABORTED',
  'DEADLINE_TIME_LIMIT',
  'DEADLINE_RUNTIME_REQUIRED',
  'DEADLINE_FIXTURE_INVALID',
  'DEADLINE_BINDINGS_INVALID',
  'DEADLINE_GROUP_REQUIRED',
  'DEADLINE_CONTROL_REQUIRED',
  'DEADLINE_RESULT_INVALID',
  'DEADLINE_PLAN_INVALID',
  'DEADLINE_QUERY_REJECTED',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
]);

/** Compare the parts this optimization is not allowed to change, without retaining parameters. */
export function compareDeadlineContracts(legacy, candidate) {
  return {
    countSql: legacy.countSql === candidate.countSql,
    countParams: equal(legacy.countParams, candidate.countParams),
    params: equal(legacy.params, candidate.params),
    limit: legacy.limit === candidate.limit,
  };
}

/** Only fixed display-join aliases and numerical work escape the raw plan. */
export function summarizeDeadlinePlan(document, returnedRows) {
  const plan = sanitizeExplain(document);
  check(Number.isSafeInteger(returnedRows) && returnedRows >= 0, 'DEADLINE_PLAN_INVALID');
  const scans = Object.fromEntries(ALIASES.map((alias) => [alias, []]));
  const joinsAfterLimit = new Set();
  const descendants = (node) => [node, ...(node.Plans ?? []).flatMap(descendants)];
  const walk = (node) => {
    if (ALIASES.includes(node.Alias)) {
      check(
        Number.isFinite(node['Actual Loops']) &&
          node['Actual Loops'] >= 0 &&
          Number.isFinite(node['Actual Rows']) &&
          node['Actual Rows'] >= 0,
        'DEADLINE_PLAN_INVALID',
      );
      scans[node.Alias].push({
        nodeType: node['Node Type'],
        actualLoops: node['Actual Loops'],
        actualRows: node['Actual Rows'],
        totalRows: node['Actual Loops'] * node['Actual Rows'],
      });
    }
    if (['Nested Loop', 'Hash Join', 'Merge Join'].includes(node['Node Type'])) {
      const branches = (node.Plans ?? []).map(descendants);
      for (let i = 0; i < branches.length; i++) {
        if (
          !branches[i].some(
            (value) => value['Node Type'] === 'Limit' && value['Actual Rows'] <= returnedRows,
          )
        )
          continue;
        for (let j = 0; j < branches.length; j++)
          if (j !== i) {
            for (const value of branches[j])
              if (ALIASES.includes(value.Alias)) joinsAfterLimit.add(value.Alias);
          }
      }
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(document[0].Plan);
  const displayLookups = ALIASES.map((alias) => ({
    alias,
    scans: scans[alias],
    observed: scans[alias].length > 0,
    totalLoops: scans[alias].reduce((sum, scan) => sum + scan.actualLoops, 0),
    totalRows: scans[alias].reduce((sum, scan) => sum + scan.totalRows, 0),
  }));
  // A full-table hash scan can have one loop: loop count alone is not a bounded lookup proof.
  const boundedByReturnedRows = displayLookups.every(
    (value) =>
      value.observed && value.totalLoops <= returnedRows && value.totalRows <= returnedRows,
  );
  return {
    plan,
    displayLookups,
    boundedByReturnedRows,
    limitBeforeDisplayJoins: ALIASES.every((alias) => joinsAfterLimit.has(alias)),
    userLookupsBoundedByReturnedRows: displayLookups
      .filter((value) => value.alias !== 'assignee_group')
      .every(
        (value) =>
          value.observed && value.totalLoops <= returnedRows && value.totalRows <= returnedRows,
      ),
  };
}

/** Runtime row validation is intentionally independent from the comparison itself. */
export function validateDeadlineResult(rows, total, limit) {
  check(
    Array.isArray(rows) &&
      Number.isSafeInteger(total) &&
      total >= 0 &&
      rows.length <= limit &&
      rows.length <= total,
    'DEADLINE_RESULT_INVALID',
  );
  for (const row of rows)
    check(
      row &&
        REQUIRED_FIELDS.every((field) => Object.hasOwn(row, field)) &&
        UUID.test(row.id) &&
        typeof row.cursor_created_at === 'string' &&
        row.cursor_created_at.length > 0 &&
        (row.remaining_seconds === null ||
          (row.remaining_seconds !== '' && Number.isFinite(Number(row.remaining_seconds)))),
      'DEADLINE_RESULT_INVALID',
    );
  return { rows, total };
}

/** SQL projection order is not a DTO contract; retain every field, value, type and row order. */
export function compareDeadlineResults(legacy, candidate) {
  const canonical = (result) => ({
    ...result,
    rows: result.rows.map((row) =>
      Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
    ),
  });
  return compareQueryResults(canonical(legacy), canonical(candidate));
}

export function prepareDeadlineBoundary(fixture) {
  const staff = fixture.actors.find((actor) => actor.role === 'agent');
  const requester = fixture.actors.find((actor) => actor.role === 'requester');
  check(
    staff &&
      requester &&
      UUID.test(fixture.organizationId) &&
      UUID.test(fixture.controlOrganizationId),
    'DEADLINE_FIXTURE_INVALID',
  );
  const id = (n) => `04400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tickets = Array.from({ length: 10 }, (_, index) => ({
    id: id(index + 1),
    organization_id: fixture.organizationId,
    requester_id: requester.userId,
    number: 'DEADLINE-' + (index + 1),
    subject: 'Synthetic deadline',
    body: 'Synthetic boundary',
    kind: 'incident',
    state: 'in_progress',
    priority: 'low',
    assignee_id: staff.userId,
    assignee_group_id: id(20),
    sla_elapsed_seconds: 60,
    clock_age_seconds: null,
  }));
  Object.assign(tickets[0], { sla_elapsed_seconds: 61 });
  Object.assign(tickets[1], { state: 'pending' });
  Object.assign(tickets[2], { sla_elapsed_seconds: 10, clock_age_seconds: 50 });
  Object.assign(tickets[3], { sla_elapsed_seconds: 0, clock_age_seconds: -30 });
  Object.assign(tickets[4], {
    state: 'pending',
    sla_elapsed_seconds: 5,
    assignee_group_id: id(21),
  });
  Object.assign(tickets[5], { priority: 'critical', assignee_id: null });
  Object.assign(tickets[6], { priority: 'critical' });
  Object.assign(tickets[7], { sla_elapsed_seconds: 65, assignee_id: id(999) });
  Object.assign(tickets[8], {
    organization_id: fixture.controlOrganizationId,
    sla_elapsed_seconds: 999999,
  });
  Object.assign(tickets[9], { requester_id: id(102), priority: 'high', sla_elapsed_seconds: 0 });
  const remaining = new Map([
    [1, -1],
    [2, 0],
    [3, 0],
    [4, 60],
    [5, 55],
    [6, null],
    [7, null],
    [8, -5],
    [10, 120],
  ]);
  const elapsed = new Map([
    [1, 61],
    [2, 60],
    [3, 60],
    [4, 0],
    [5, 5],
    [6, 60],
    [7, 60],
    [8, 65],
    [10, 0],
  ]);
  return {
    tickets,
    policies: ['low', 'high'].map((priority) => ({
      organization_id: fixture.organizationId,
      priority,
      response_target_minutes: 1,
      resolution_target_minutes: priority === 'low' ? 1 : 2,
    })),
    users: [
      { id: staff.userId, display_name: 'Synthetic agent' },
      { id: requester.userId, display_name: 'Synthetic requester' },
      { id: id(102), display_name: 'Other requester' },
    ],
    groups: [
      { id: id(20), organization_id: fixture.organizationId, name: 'Synthetic group' },
      {
        id: id(21),
        organization_id: fixture.controlOrganizationId,
        name: 'Other organization group',
      },
    ],
    expected: [...remaining].map(([n, value]) => ({
      id: id(n),
      remainingSeconds: value,
      elapsed: elapsed.get(n),
      requesterId: n === 10 ? id(102) : requester.userId,
      assigneeName: n === 6 || n === 8 ? null : 'Synthetic agent',
      requesterName: n === 10 ? 'Other requester' : 'Synthetic requester',
      groupName: n === 5 ? null : 'Synthetic group',
    })),
  };
}

/** The actual table composite preserves every t.* column, including nullable schema fields. */
export function buildDeadlineBoundaryQuery(built, boundary) {
  check(
    built &&
      typeof built.sql === 'string' &&
      /^\s*SELECT\b/.test(built.sql) &&
      !built.sql.includes(';') &&
      Array.isArray(built.params),
    'DEADLINE_QUERY_REJECTED',
  );
  const json = `$${built.params.length + 1}::jsonb`;
  return {
    sql: `SELECT * FROM (
      WITH ticket AS (
        SELECT r.* FROM jsonb_array_elements(${json}->'tickets') AS x(value)
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.ticket, x.value || jsonb_build_object(
          'created_at', now() - interval '1 hour', 'updated_at', now(),
          'sla_clock_started_at', CASE WHEN x.value->>'clock_age_seconds' IS NULL THEN NULL
            ELSE now() - (x.value->>'clock_age_seconds')::int * interval '1 second' END)) AS r
      ), sla_policy AS (
        SELECT x.organization_id::uuid AS organization_id,x.priority,x.response_target_minutes,x.resolution_target_minutes
        FROM jsonb_to_recordset(${json}->'policies') AS x(organization_id text,priority text,response_target_minutes int,resolution_target_minutes int)
      ), app_user AS (
        SELECT x.id::uuid AS id,x.display_name FROM jsonb_to_recordset(${json}->'users') AS x(id text,display_name text)
      ), assignment_group AS (
        SELECT x.id::uuid AS id,x.organization_id::uuid AS organization_id,x.name
        FROM jsonb_to_recordset(${json}->'groups') AS x(id text,organization_id text,name text)
      ) ${built.sql}
    ) AS deadline_boundary`,
    params: [
      ...built.params,
      JSON.stringify({
        tickets: boundary.tickets,
        policies: boundary.policies,
        users: boundary.users,
        groups: boundary.groups,
      }),
    ],
  };
}

export function checkDeadlineBoundary(
  result,
  boundary,
  { direction, limit, requesterId, empty = false },
) {
  const expected = boundary.expected
    .filter((row) => !empty && (!requesterId || row.requesterId === requesterId))
    .sort((a, b) => {
      if (a.remainingSeconds === null && b.remainingSeconds !== null) return 1;
      if (a.remainingSeconds !== null && b.remainingSeconds === null) return -1;
      const delta =
        a.remainingSeconds === b.remainingSeconds
          ? a.id.localeCompare(b.id)
          : a.remainingSeconds - b.remainingSeconds;
      return direction === 'asc' ? delta : -delta;
    });
  return (
    result.total === expected.length &&
    result.rows.length === Math.min(limit, expected.length) &&
    result.rows.every((row, index) => {
      const wanted = expected[index];
      return (
        row.id === wanted.id &&
        (row.remaining_seconds === null ? null : Number(row.remaining_seconds)) ===
          wanted.remainingSeconds &&
        Number(row.sla_elapsed_now) === wanted.elapsed &&
        row.assignee_name === wanted.assigneeName &&
        row.requester_name === wanted.requesterName &&
        row.assignee_group_name === wanted.groupName
      );
    })
  );
}

export async function runDeadlineAnalysis({ runtime, fixture, signal }) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    cases: [],
    readOnlyContexts: [],
    unchangedSorts: [],
    cursorRejections: [],
  };
  const budget = () => {
    check(!signal?.aborted, 'DEADLINE_ABORTED');
    check(performance.now() - started < 120_000, 'DEADLINE_TIME_LIMIT');
  };
  try {
    budget();
    check(
      runtime &&
        ['withAppReadOnly', 'buildTicketListQuery', 'buildLegacyTicketListQuery'].every(
          (name) => typeof runtime[name] === 'function',
        ),
      'DEADLINE_RUNTIME_REQUIRED',
    );
    const staff = fixture.actors.find((actor) => actor.role === 'agent');
    const requester = fixture.actors.find((actor) => actor.role === 'requester');
    check(
      staff &&
        requester &&
        [
          staff.userId,
          requester.userId,
          fixture.organizationId,
          fixture.controlOrganizationId,
          fixture.controlTicketId,
        ].every((value) => UUID.test(value)),
      'DEADLINE_FIXTURE_INVALID',
    );
    const staffCtx = contextFor(staff, fixture.organizationId);
    const requesterCtx = contextFor(requester, fixture.organizationId);
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
    await readOnly(
      'fixture-bindings',
      { organizationId: fixture.organizationId, actorId: staff.userId },
      async (client) => {
        const result = await query(
          client,
          "SELECT rb.user_id,r.code FROM role_binding rb JOIN role r ON r.id=rb.role_id JOIN app_user u ON u.id=rb.user_id WHERE (rb.organization_id=$1 OR rb.organization_id IS NULL) AND rb.user_id=ANY($2::uuid[]) AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now()) AND u.status='active'",
          [fixture.organizationId, [staff.userId, requester.userId]],
        );
        check(
          result.rows.some((row) => row.user_id === staff.userId && row.code === 'agent') &&
            result.rows.some(
              (row) => row.user_id === requester.userId && row.code === 'requester',
            ) &&
            !result.rows.some(
              (row) =>
                row.user_id === requester.userId &&
                ['agent', 'org_admin', 'auditor', 'platform_admin', 'platform_auditor'].includes(
                  row.code,
                ),
            ),
          'DEADLINE_BINDINGS_INVALID',
        );
        groupId = (
          await query(
            client,
            'SELECT id FROM assignment_group WHERE organization_id=$1 AND active ORDER BY code LIMIT 1',
            [fixture.organizationId],
          )
        ).rows[0]?.id;
        check(UUID.test(groupId), 'DEADLINE_GROUP_REQUIRED');
      },
    );
    const filter = { state: ACTIVE };
    for (const column of ['created_at', 'updated_at', 'priority', 'number'])
      for (const direction of ['asc', 'desc']) {
        const options = { sort: { column, direction }, filter, limit: 50 };
        const legacy = runtime.buildLegacyTicketListQuery(staffCtx, options),
          candidate = runtime.buildTicketListQuery(staffCtx, options);
        report.unchangedSorts.push({
          name: `${column}-${direction}`,
          sql: legacy.sql === candidate.sql,
          ...compareDeadlineContracts(legacy, candidate),
        });
      }
    const cursor = { createdAt: '2026-10-04 00:00:00.123456+00', id: fixture.controlTicketId };
    const cursorOptions = { filter, limit: 50, cursor };
    const oldCursor = runtime.buildLegacyTicketListQuery(staffCtx, cursorOptions),
      newCursor = runtime.buildTicketListQuery(staffCtx, cursorOptions);
    report.unchangedSorts.push({
      name: 'created_at-cursor',
      sql: oldCursor.sql === newCursor.sql,
      ...compareDeadlineContracts(oldCursor, newCursor),
    });
    for (const direction of ['asc', 'desc']) {
      const rejects = (build) => {
        try {
          build(staffCtx, { sort: { column: 'deadline', direction }, cursor });
          return false;
        } catch (error) {
          return error?.status === 400;
        }
      };
      report.cursorRejections.push({
        direction,
        legacy: rejects(runtime.buildLegacyTicketListQuery),
        candidate: rejects(runtime.buildTicketListQuery),
      });
    }
    const boundary = prepareDeadlineBoundary(fixture);
    const definitions = [];
    for (const direction of ['asc', 'desc'])
      for (const limit of [1, 5, 50, 200])
        definitions.push({
          name: `staff-${direction}-${limit}`,
          ctx: staffCtx,
          options: { sort: { column: 'deadline', direction }, filter, limit },
        });
    for (const direction of ['asc', 'desc'])
      definitions.push({
        name: `requester-${direction}`,
        ctx: requesterCtx,
        requesterOnly: true,
        options: { sort: { column: 'deadline', direction }, limit: 50 },
      });
    for (const [name, extra, empty] of [
      ['group', { assigneeGroupIds: [groupId] }, false],
      ['ungrouped', { ungroupedOnly: true }, false],
      ['empty', { keyword: 'WP044 impossible synthetic query 9ef873' }, true],
      [
        'combined-filter',
        { unassignedOnly: true, priority: ['low'], keyword: '合成性能問い合わせ' },
        false,
      ],
    ])
      definitions.push({
        name,
        ctx: staffCtx,
        empty,
        options: {
          sort: { column: 'deadline', direction: 'asc' },
          filter: { ...filter, ...extra },
          limit: 50,
        },
      });
    definitions.push({
      name: 'organization-mismatch',
      ctx: staffCtx,
      empty: true,
      organizationId: fixture.controlOrganizationId,
      options: { sort: { column: 'deadline', direction: 'asc' }, filter, limit: 50 },
    });
    for (const direction of ['asc', 'desc'])
      for (const limit of [1, 5, 50, 200])
        definitions.push({
          name: `boundary-${direction}-${limit}`,
          ctx: staffCtx,
          boundary,
          options: { sort: { column: 'deadline', direction }, limit },
        });
    definitions.push({
      name: 'boundary-requester',
      ctx: requesterCtx,
      requesterOnly: true,
      boundary,
      options: { sort: { column: 'deadline', direction: 'desc' }, limit: 50 },
    });
    definitions.push({
      name: 'boundary-empty',
      ctx: staffCtx,
      empty: true,
      boundary,
      options: {
        sort: { column: 'deadline', direction: 'asc' },
        filter: { state: ['closed'] },
        limit: 50,
      },
    });
    for (const definition of definitions) {
      budget();
      const item = {
        name: definition.name,
        mode: definition.boundary ? 'synthetic-cte' : 'actual-table',
        rlsEvidence: !definition.boundary,
        stage: 'context',
        completed: false,
        legacy: {},
        candidate: {},
      };
      report.cases.push(item);
      await readOnly(
        definition.name,
        {
          organizationId: definition.organizationId ?? fixture.organizationId,
          actorId: definition.ctx.principal.userId,
        },
        async (client, proof) => {
          item.proof = proof;
          if (definition.organizationId) {
            const control = await query(
              client,
              'SELECT count(*)::int n FROM ticket WHERE id=$1 AND organization_id=$2',
              [fixture.controlTicketId, fixture.controlOrganizationId],
            );
            check(control.rows[0]?.n === 1, 'DEADLINE_CONTROL_REQUIRED');
          }
          const legacy = runtime.buildLegacyTicketListQuery(definition.ctx, definition.options),
            candidate = runtime.buildTicketListQuery(definition.ctx, definition.options);
          item.contract = compareDeadlineContracts(legacy, candidate);
          item.sqlChanged = legacy.sql !== candidate.sql;
          const wrap = (built) =>
            definition.boundary ? buildDeadlineBoundaryQuery(built, definition.boundary) : built;
          const execute = async (built, side) => {
            item.stage = `${side}-list`;
            const list = wrap({ sql: built.sql, params: built.params });
            const rows = (await query(client, list.sql, list.params)).rows;
            item[side].rows = rows.length;
            item.stage = `${side}-count`;
            const count = wrap({ sql: built.countSql, params: built.countParams });
            const totals = (await query(client, count.sql, count.params)).rows;
            check(totals.length === 1, 'DEADLINE_RESULT_INVALID');
            const result = validateDeadlineResult(rows, totals[0].total, built.limit);
            item[side].total = result.total;
            return result;
          };
          const left = await execute(legacy, 'legacy'),
            right = await execute(candidate, 'candidate');
          item.comparison = compareDeadlineResults(left, right);
          item.comparison.organization = [...left.rows, ...right.rows].every(
            (row) => row.organization_id === fixture.organizationId,
          );
          item.comparison.requester =
            !definition.requesterOnly ||
            [...left.rows, ...right.rows].every((row) => row.requester_id === requester.userId);
          item.comparison.expectedPopulation = definition.empty
            ? left.total === 0 && right.total === 0
            : left.rows.length === Math.min(left.total, legacy.limit) &&
              left.rows.length > 0 &&
              right.rows.length === Math.min(right.total, candidate.limit);
          if (definition.boundary)
            item.comparison.boundary = [left, right].every((value) =>
              checkDeadlineBoundary(value, boundary, {
                direction: definition.options.sort.direction,
                limit: legacy.limit,
                requesterId: definition.requesterOnly ? requester.userId : undefined,
                empty: definition.empty,
              }),
            );
          item.comparison.equal =
            Object.values(item.comparison).every(Boolean) &&
            Object.values(item.contract).every(Boolean);
          for (const [side, built] of [
            ['legacy', legacy],
            ['candidate', candidate],
          ]) {
            item.stage = `${side}-list-explain`;
            const list = wrap({ sql: built.sql, params: built.params });
            const document = (
              await query(
                client,
                'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + list.sql,
                list.params,
              )
            ).rows[0]?.['QUERY PLAN'];
            item[side].listPlan = sanitizeExplain(document);
            if (!definition.boundary)
              item[side].displayJoins = summarizeDeadlinePlan(document, item[side].rows);
            item.stage = `${side}-count-explain`;
            const count = wrap({ sql: built.countSql, params: built.countParams });
            item[side].countPlan = sanitizeExplain(
              (
                await query(
                  client,
                  'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + count.sql,
                  count.params,
                )
              ).rows[0]?.['QUERY PLAN'],
            );
          }
          item.completed = true;
          item.stage = 'complete';
        },
      );
    }
    report.equivalent =
      report.cases.every((item) => item.completed && item.comparison.equal) &&
      report.unchangedSorts.every(({ name: _name, ...checks }) =>
        Object.values(checks).every(Boolean),
      ) &&
      report.cursorRejections.every((item) => item.legacy && item.candidate);
    const primary = report.cases.filter((item) => /^staff-(asc|desc)-/.test(item.name));
    report.projection = {
      sqlChanged: primary.every((item) => item.sqlChanged),
      bounded: primary.every((item) => item.candidate.displayJoins.boundedByReturnedRows),
      legacyBounded: primary.every((item) => item.legacy.displayJoins.boundedByReturnedRows),
    };
    const fifty = primary.filter((item) => item.name.endsWith('-50'));
    const userWork = (side) =>
      side.displayJoins.displayLookups
        .filter((value) => value.alias !== 'assignee_group')
        .reduce((sum, value) => sum + value.totalRows, 0);
    report.projection.limitBeforeDisplayJoins = fifty.every(
      (item) => item.candidate.displayJoins.limitBeforeDisplayJoins,
    );
    report.projection.userLookupsReduced = fifty.every(
      (item) =>
        item.candidate.displayJoins.userLookupsBoundedByReturnedRows &&
        userWork(item.candidate) < userWork(item.legacy),
    );
    report.projection.fiftyRowComparison = fifty.map((item) => ({
      name: item.name,
      legacyUserRows: userWork(item.legacy),
      candidateUserRows: userWork(item.candidate),
    }));
    report.projection.confirmed =
      report.equivalent &&
      report.projection.sqlChanged &&
      report.projection.limitBeforeDisplayJoins &&
      report.projection.userLookupsReduced;
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted
      ? 'DEADLINE_ABORTED'
      : failureCodes.has(error?.message)
        ? error.message
        : 'DEADLINE_ANALYSIS_FAILED';
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
