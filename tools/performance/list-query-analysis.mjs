import { performance } from 'node:perf_hooks';

const requireCondition = (condition, code) => {
  if (!condition) throw new Error(code);
};
const NODE_TYPES = new Set([
  'Limit',
  'Result',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'BitmapAnd',
  'BitmapOr',
  'Nested Loop',
  'Hash Join',
  'Merge Join',
  'Hash',
  'Sort',
  'Incremental Sort',
  'Aggregate',
  'Group',
  'Gather',
  'Gather Merge',
  'Materialize',
  'Memoize',
  'Append',
  'Merge Append',
  'Subquery Scan',
  'CTE Scan',
  'Function Scan',
  'Values Scan',
  'Unique',
  'WindowAgg',
  'SetOp',
  'LockRows',
]);
const NUMBER_FIELDS = {
  'Plan Rows': 'plannedRows',
  'Actual Rows': 'actualRows',
  'Actual Loops': 'actualLoops',
  'Actual Startup Time': 'actualStartupMs',
  'Actual Total Time': 'actualTotalMs',
  'Rows Removed by Filter': 'rowsRemovedByFilter',
  'Rows Removed by Join Filter': 'rowsRemovedByJoinFilter',
  'Shared Hit Blocks': 'sharedHitBlocks',
  'Shared Read Blocks': 'sharedReadBlocks',
  'Shared Dirtied Blocks': 'sharedDirtiedBlocks',
  'Shared Written Blocks': 'sharedWrittenBlocks',
  'Temp Read Blocks': 'tempReadBlocks',
  'Temp Written Blocks': 'tempWrittenBlocks',
  'Sort Space Used': 'sortSpaceKb',
};

/** Keep numerical plan evidence, never predicates, literals, output columns or SQL text. */
export function sanitizeExplain(document) {
  requireCondition(Array.isArray(document) && document.length === 1, 'QUERY_PLAN_INVALID');
  const root = document[0];
  let count = 0;
  const node = (value, depth) => {
    requireCondition(
      value && typeof value === 'object' && depth <= 64 && ++count <= 512,
      'QUERY_PLAN_INVALID',
    );
    requireCondition(NODE_TYPES.has(value['Node Type']), 'QUERY_PLAN_INVALID');
    const clean = { nodeType: value['Node Type'] };
    if (value['Index Name'] !== undefined) {
      requireCondition(
        typeof value['Index Name'] === 'string' &&
          /^[a-z][a-z0-9_]{0,127}$/.test(value['Index Name']),
        'QUERY_PLAN_INVALID',
      );
      clean.indexName = value['Index Name'];
    }
    for (const [key, target] of Object.entries(NUMBER_FIELDS)) {
      if (value[key] === undefined) continue;
      requireCondition(Number.isFinite(value[key]) && value[key] >= 0, 'QUERY_PLAN_INVALID');
      clean[target] = value[key];
    }
    if (value.Plans !== undefined) {
      requireCondition(Array.isArray(value.Plans), 'QUERY_PLAN_INVALID');
      clean.children = value.Plans.map((child) => node(child, depth + 1));
    }
    return clean;
  };
  requireCondition(root && typeof root === 'object', 'QUERY_PLAN_INVALID');
  const clean = { plan: node(root.Plan, 0) };
  for (const [key, target] of [
    ['Planning Time', 'planningMs'],
    ['Execution Time', 'executionMs'],
  ]) {
    requireCondition(Number.isFinite(root[key]) && root[key] >= 0, 'QUERY_PLAN_INVALID');
    clean[target] = root[key];
  }
  return clean;
}

// This is the fixed WP044 deadline control, never a query rewrite. Match both
// ordering levels and the complete display-join shell; the inner source/WHERE
// must also be the unmodified COUNT source, so a filter after LIMIT is rejected.
function isProjectedDeadlineControl(built) {
  const normalized = built.sql.trim().replace(/\s+/g, ' ');
  const shape = new RegExp(
    [
      '^SELECT selected\\.\\*,',
      'assignee\\.display_name AS assignee_name, requester\\.display_name AS requester_name,',
      'assignee_group\\.name AS assignee_group_name FROM \\(',
      'SELECT t\\.\\*, t\\.created_at::text AS cursor_created_at,',
      '(.+ AS sla_elapsed_now, CASE WHEN p\\.resolution_target_minutes IS NULL THEN NULL',
      'ELSE p\\.resolution_target_minutes \\* 60 - .+ END AS remaining_seconds,',
      'p\\.response_target_minutes, p\\.resolution_target_minutes)',
      '(FROM ticket t LEFT JOIN sla_policy p ON p\\.organization_id = t\\.organization_id',
      'AND p\\.priority = t\\.priority WHERE .+)',
      'ORDER BY remaining_seconds (ASC|DESC) NULLS LAST, t\\.id \\3',
      'LIMIT \\$(\\d+) \\) selected',
      'LEFT JOIN app_user assignee ON assignee\\.id=selected\\.assignee_id',
      'LEFT JOIN app_user requester ON requester\\.id=selected\\.requester_id',
      'LEFT JOIN assignment_group assignee_group ON assignee_group\\.id=selected\\.assignee_group_id',
      'AND assignee_group\\.organization_id=selected\\.organization_id',
      'ORDER BY selected\\.remaining_seconds \\3 NULLS LAST, selected\\.id \\3$',
    ].join(' '),
  );
  const match = normalized.match(shape);
  return Boolean(
    match &&
    !/\b(?:SELECT|JOIN|ORDER BY|LIMIT)\b/.test(match[1]) &&
    !/\b(?:SELECT|ORDER BY|LIMIT)\b/.test(match[2]) &&
    Number(match[4]) === built.params.length &&
    built.countSql.trim().replace(/\s+/g, ' ') === `SELECT count(*)::int AS total ${match[2]}`,
  );
}

// WP046 keeps the WP042 NULL-order experiment on the exact selected-page shell.
// The outer order is unchanged; only the inner created-at NULL placement is varied.
function isProjectedSearchOrder(built) {
  const normalized = built.sql.trim().replace(/\s+/g, ' ');
  const shape = new RegExp(
    [
      '^SELECT selected\\.\\*,',
      'assignee\\.display_name AS assignee_name, requester\\.display_name AS requester_name,',
      'assignee_group\\.name AS assignee_group_name FROM \\(',
      'SELECT t\\.\\*, t\\.created_at::text AS cursor_created_at,',
      '(.+ AS sla_elapsed_now, CASE WHEN p\\.resolution_target_minutes IS NULL THEN NULL',
      'ELSE p\\.resolution_target_minutes \\* 60 - .+ END AS remaining_seconds,',
      'p\\.response_target_minutes, p\\.resolution_target_minutes)',
      '(FROM ticket t LEFT JOIN sla_policy p ON p\\.organization_id = t\\.organization_id',
      'AND p\\.priority = t\\.priority WHERE .+)',
      'ORDER BY t\\.created_at (ASC|DESC)(?: NULLS LAST)?, t\\.id \\3',
      'LIMIT \\$(\\d+) \\) selected',
      'LEFT JOIN app_user assignee ON assignee\\.id=selected\\.assignee_id',
      'LEFT JOIN app_user requester ON requester\\.id=selected\\.requester_id',
      'LEFT JOIN assignment_group assignee_group ON assignee_group\\.id=selected\\.assignee_group_id',
      'AND assignee_group\\.organization_id=selected\\.organization_id',
      'ORDER BY selected\\.created_at \\3, selected\\.id \\3$',
    ].join(' '),
  );
  const match = normalized.match(shape);
  if (
    !match ||
    /\b(?:SELECT|JOIN|ORDER BY|LIMIT)\b/.test(match[1]) ||
    /\b(?:SELECT|ORDER BY|LIMIT)\b/.test(match[2]) ||
    Number(match[4]) !== built.params.length
  )
    return false;
  const countSource = built.countSql
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^SELECT count\(\*\)::int AS total /, '');
  const keyword = countSource.match(/\bt\.search_text ILIKE \$(\d+)\b/);
  const n = built.countParams.length;
  if (
    !keyword ||
    Number(keyword[1]) > n ||
    typeof built.countParams[Number(keyword[1]) - 1] !== 'string' ||
    JSON.stringify(built.params.slice(0, n)) !== JSON.stringify(built.countParams)
  )
    return false;
  if (built.params.length === n + 1) return match[2] === countSource;
  if (built.params.length !== n + 3) return false;
  const comparison = match[3] === 'DESC' ? '<' : '>';
  return (
    match[2] ===
    `${countSource} AND (t.created_at, t.id) ${comparison} ($${n + 1}::timestamptz, $${n + 2}::uuid)`
  );
}

/** Reconstruct both variants even after the approved production builder is changed. */
export function createOrderingVariants(built) {
  requireCondition(
    built &&
      typeof built.sql === 'string' &&
      /^\s*SELECT\b/.test(built.sql) &&
      !built.sql.includes(';') &&
      typeof built.countSql === 'string' &&
      /^\s*SELECT\s+count\(\*\)::int AS total\b/.test(built.countSql) &&
      !built.countSql.includes(';') &&
      Array.isArray(built.params) &&
      Array.isArray(built.countParams),
    'QUERY_VARIANT_REJECTED',
  );
  let pattern = /ORDER BY t\.created_at (ASC|DESC)(?: NULLS LAST)?, t\.id \1(?=\s+LIMIT \$\d+\s*$)/;
  let match = built.sql.match(pattern);
  if (!match && isProjectedSearchOrder(built)) {
    pattern =
      /ORDER BY t\.created_at (ASC|DESC)(?: NULLS LAST)?, t\.id \1(?=\s+LIMIT \$\d+\s+\) selected)/;
    match = built.sql.match(pattern);
  }
  if (!match) {
    // Only deadline is a supported unchanged control. Unknown SQL must not be rewritten.
    requireCondition(
      /ORDER BY remaining_seconds (ASC|DESC) NULLS LAST, t\.id \1\s+LIMIT \$\d+\s*$/.test(
        built.sql,
      ) || isProjectedDeadlineControl(built),
      'QUERY_VARIANT_REJECTED',
    );
    return { legacy: { ...built }, candidate: { ...built }, changed: false };
  }
  const direction = match[1];
  return {
    legacy: {
      ...built,
      sql: built.sql.replace(
        pattern,
        `ORDER BY t.created_at ${direction} NULLS LAST, t.id ${direction}`,
      ),
    },
    candidate: {
      ...built,
      sql: built.sql.replace(pattern, `ORDER BY t.created_at ${direction}, t.id ${direction}`),
    },
    changed: true,
  };
}

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const SLA_FIELDS = [
  'sla_elapsed_now',
  'remaining_seconds',
  'response_target_minutes',
  'resolution_target_minutes',
  'sla_elapsed_seconds',
  'sla_clock_started_at',
];
export function compareQueryResults(legacy, candidate) {
  const project = (rows, fields) => rows.map((row) => fields.map((key) => row[key]));
  const checks = {
    ids: equal(project(legacy.rows, ['id']), project(candidate.rows, ['id'])),
    fullCursor: equal(
      project(legacy.rows, ['cursor_created_at', 'id']),
      project(candidate.rows, ['cursor_created_at', 'id']),
    ),
    rawSla: equal(project(legacy.rows, SLA_FIELDS), project(candidate.rows, SLA_FIELDS)),
    total: legacy.total === candidate.total,
    fullRows: equal(legacy.rows, candidate.rows),
  };
  return { equal: Object.values(checks).every(Boolean), ...checks };
}

const walkPlan = (node) => [node, ...(node.children ?? []).flatMap(walkPlan)];
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
const safeError = (error) =>
  /^QUERY_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'QUERY_ANALYSIS_FAILED';

/** Runtime proof is checked and copied by an exact allowlist; no connection identity escapes. */
export function sanitizeReadOnlyProof(proof) {
  const expected = {
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
  requireCondition(
    proof && Object.entries(expected).every(([key, value]) => proof[key] === value),
    'QUERY_READ_ONLY_PROOF_INVALID',
  );
  return expected;
}

export async function runQueryAnalysis({ runtime, fixture, signal }) {
  const report = {
    completed: false,
    equivalent: false,
    adoptedCandidate: false,
    cases: [],
    readOnlyContexts: [],
  };
  const start = performance.now();
  const checkBudget = () => {
    requireCondition(!signal?.aborted, 'QUERY_ANALYSIS_ABORTED');
    requireCondition(performance.now() - start < 120_000, 'QUERY_ANALYSIS_TIME_LIMIT');
  };
  try {
    checkBudget();
    requireCondition(
      typeof runtime.withAppReadOnly === 'function' &&
        typeof runtime.buildTicketListQuery === 'function',
      'QUERY_RUNTIME_REQUIRED',
    );
    const staff = fixture.actors.find((actor) => actor.role === 'agent');
    const requester = fixture.actors.find((actor) => actor.role === 'requester');
    requireCondition(staff && requester, 'QUERY_ACTORS_REQUIRED');
    const staffContext = contextFor(staff, fixture.organizationId);
    const requesterContext = contextFor(requester, fixture.organizationId);
    const readOnly = (name, context, callback) =>
      runtime.withAppReadOnly(context, async (client) => {
        report.readOnlyContexts.push({ name, proof: sanitizeReadOnlyProof(client.proof) });
        report.writeProbe = { readOnlyWriteRejected: true, sqlState: '25006' };
        return callback(client);
      });
    const query = async (client, sql, params = []) => {
      checkBudget();
      const result = await client.query(sql, params);
      checkBudget();
      return result;
    };
    let groupId;
    await readOnly(
      'fixture-bindings',
      { organizationId: fixture.organizationId, actorId: staff.userId },
      async (client) => {
        const bindings = await query(
          client,
          `SELECT rb.user_id,r.code FROM role_binding rb JOIN role r ON r.id=rb.role_id WHERE rb.organization_id=$1 AND rb.user_id=ANY($2::uuid[]) AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now())`,
          [fixture.organizationId, [staff.userId, requester.userId]],
        );
        requireCondition(
          bindings.rows.some((row) => row.user_id === staff.userId && row.code === 'agent') &&
            bindings.rows.some(
              (row) => row.user_id === requester.userId && row.code === 'requester',
            ),
          'QUERY_ACTOR_BINDINGS_MISMATCH',
        );
        const groups = await query(
          client,
          'SELECT id FROM assignment_group WHERE organization_id=$1 ORDER BY code LIMIT 1',
          [fixture.organizationId],
        );
        groupId = groups.rows[0]?.id;
        requireCondition(groupId, 'QUERY_GROUP_REQUIRED');
      },
    );
    const newest = { column: 'created_at', direction: 'desc' };
    const definitions = [
      {
        name: 'staff-newest',
        ctx: staffContext,
        options: { sort: newest, limit: 50 },
        boundary: true,
      },
      {
        name: 'staff-oldest',
        ctx: staffContext,
        options: { sort: { column: 'created_at', direction: 'asc' }, limit: 50 },
      },
      {
        name: 'staff-active',
        ctx: staffContext,
        options: {
          sort: newest,
          filter: { state: ['new', 'assigned', 'in_progress', 'pending'] },
          limit: 50,
        },
      },
      {
        name: 'staff-unassigned',
        ctx: staffContext,
        options: { sort: newest, filter: { unassignedOnly: true }, limit: 50 },
      },
      {
        name: 'staff-keyword',
        ctx: staffContext,
        options: { sort: newest, filter: { keyword: '合成性能問い合わせ 1' }, limit: 50 },
      },
      {
        name: 'staff-group',
        ctx: staffContext,
        options: { sort: newest, filter: { assigneeGroupIds: [groupId] }, limit: 50 },
      },
      {
        name: 'staff-deadline',
        ctx: staffContext,
        options: {
          sort: { column: 'deadline', direction: 'asc' },
          filter: { state: ['new', 'assigned', 'in_progress'] },
          limit: 50,
        },
      },
      {
        name: 'deadline-null-last',
        ctx: staffContext,
        nullPlacement: true,
        options: {
          sort: { column: 'deadline', direction: 'asc' },
          filter: { assigneeId: staff.userId, state: ['assigned', 'in_progress'] },
          limit: 200,
        },
      },
      {
        name: 'requester-own',
        ctx: requesterContext,
        options: { sort: newest, limit: 50 },
        requesterOnly: true,
      },
      {
        name: 'organization-mismatch',
        ctx: staffContext,
        organizationId: fixture.controlOrganizationId,
        options: { sort: newest, limit: 50 },
        mismatch: true,
      },
    ];
    for (const definition of definitions) {
      checkBudget();
      // Persist completed evidence incrementally; a later failed EXPLAIN must not erase it.
      const item = {
        name: definition.name,
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
        async (client) => {
          item.stage = 'results';
          if (definition.mismatch) {
            const control = await query(
              client,
              'SELECT count(*)::int n FROM ticket WHERE id=$1 AND organization_id=$2',
              [fixture.controlTicketId, fixture.controlOrganizationId],
            );
            requireCondition(control.rows[0]?.n === 1, 'QUERY_CONTROL_TICKET_MISSING');
          }
          const variants = createOrderingVariants(
            runtime.buildTicketListQuery(definition.ctx, definition.options),
          );
          const execute = async (built) => {
            const rows = (await query(client, built.sql, built.params)).rows;
            const total = (await query(client, built.countSql, built.countParams)).rows[0]?.total;
            requireCondition(
              Array.isArray(rows) && Number.isSafeInteger(total) && total >= rows.length,
              'QUERY_RESULTS_INVALID',
            );
            for (const row of rows)
              requireCondition(
                typeof row.id === 'string' &&
                  typeof row.cursor_created_at === 'string' &&
                  row.cursor_created_at.length > 0 &&
                  SLA_FIELDS.every((field) => Object.hasOwn(row, field)),
                'QUERY_RESULTS_INVALID',
              );
            return { rows, total };
          };
          const explain = async (sql, params) => {
            const result = await query(
              client,
              'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql,
              params,
            );
            return sanitizeExplain(result.rows[0]?.['QUERY PLAN']);
          };
          const legacy = await execute(variants.legacy);
          Object.assign(item.legacy, { rows: legacy.rows.length, total: legacy.total });
          const candidate = await execute(variants.candidate);
          Object.assign(item.candidate, { rows: candidate.rows.length, total: candidate.total });
          const comparison = compareQueryResults(legacy, candidate);
          comparison.organization = [...legacy.rows, ...candidate.rows].every(
            (row) => row.organization_id === fixture.organizationId,
          );
          comparison.requester =
            !definition.requesterOnly ||
            [...legacy.rows, ...candidate.rows].every(
              (row) => row.requester_id === requester.userId,
            );
          comparison.expectedPopulation = definition.mismatch
            ? legacy.total === 0 && candidate.total === 0
            : legacy.rows.length > 0;
          if (definition.name === 'staff-newest')
            comparison.expectedPopulation &&= legacy.total === fixture.counts.tickets;
          let nullPlacement;
          if (definition.nullPlacement) {
            const nullRows = legacy.rows.filter((row) => row.remaining_seconds === null).length;
            const firstNull = legacy.rows.findIndex((row) => row.remaining_seconds === null);
            nullPlacement = {
              nullRows,
              nonNullRows: legacy.rows.length - nullRows,
              wholePopulation: legacy.rows.length === legacy.total,
              nullsLast:
                firstNull >= 0 &&
                legacy.rows.slice(firstNull).every((row) => row.remaining_seconds === null),
            };
            comparison.nullPlacement =
              nullPlacement.nullRows > 0 &&
              nullPlacement.nonNullRows > 0 &&
              nullPlacement.wholePopulation &&
              nullPlacement.nullsLast;
          }
          comparison.equal = Object.values(comparison).every(Boolean);
          item.comparison = comparison;
          if (nullPlacement) item.nullPlacement = nullPlacement;
          item.stage = 'legacy-list-explain';
          item.legacy.listPlan = await explain(variants.legacy.sql, variants.legacy.params);
          item.stage = 'legacy-count-explain';
          item.legacy.countPlan = await explain(
            variants.legacy.countSql,
            variants.legacy.countParams,
          );
          item.stage = 'candidate-list-explain';
          item.candidate.listPlan = await explain(
            variants.candidate.sql,
            variants.candidate.params,
          );
          item.stage = 'candidate-count-explain';
          item.candidate.countPlan = await explain(
            variants.candidate.countSql,
            variants.candidate.countParams,
          );
          if (definition.boundary) {
            item.stage = 'boundary';
            const last = legacy.rows.at(-1);
            requireCondition(last, 'QUERY_BOUNDARY_MISSING');
            const nextVariants = createOrderingVariants(
              runtime.buildTicketListQuery(definition.ctx, {
                ...definition.options,
                cursor: { createdAt: last.cursor_created_at, id: last.id },
              }),
            );
            const oldPage = await execute(nextVariants.legacy);
            const newPage = await execute(nextVariants.candidate);
            const boundaryComparison = compareQueryResults(oldPage, newPage);
            const firstIds = new Set(legacy.rows.map((row) => row.id));
            report.boundary = {
              ...boundaryComparison,
              nonempty: oldPage.rows.length > 0,
              disjoint: oldPage.rows.every((row) => !firstIds.has(row.id)),
              totalStable: oldPage.total === legacy.total,
            };
            report.boundary.equal = Object.values(report.boundary).every(Boolean);
          }
          item.stage = 'complete';
          item.completed = true;
        },
      );
    }
    report.equivalent =
      report.cases.every((item) => item.comparison.equal) && report.boundary?.equal === true;
    const newestCase = report.cases.find((item) => item.name === 'staff-newest');
    const legacyNodes = walkPlan(newestCase.legacy.listPlan.plan);
    const candidateNodes = walkPlan(newestCase.candidate.listPlan.plan);
    const sortCount = (nodes) =>
      nodes.filter((node) => ['Sort', 'Incremental Sort'].includes(node.nodeType)).length;
    const usesIndex = (nodes) =>
      nodes.some(
        (node) =>
          ['Index Scan', 'Index Only Scan'].includes(node.nodeType) &&
          node.indexName === 'ticket_list_org_idx',
      );
    const confirmed =
      sortCount(legacyNodes) > sortCount(candidateNodes) && usesIndex(candidateNodes);
    report.hypothesis = {
      confirmed,
      reason: confirmed ? 'ORDERING_INDEX_PLAN_CONFIRMED' : 'ORDERING_INDEX_PLAN_NOT_CONFIRMED',
      legacyNewestSortNodes: sortCount(legacyNodes),
      candidateNewestSortNodes: sortCount(candidateNodes),
      legacyNewestIndexScan: usesIndex(legacyNodes),
      candidateNewestIndexScan: usesIndex(candidateNodes),
    };
    report.adoptedCandidate = report.equivalent && confirmed;
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted ? 'QUERY_ANALYSIS_ABORTED' : safeError(error);
  }
  report.elapsedMs = performance.now() - start;
  return report;
}
