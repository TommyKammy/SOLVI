import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';
import { normalizeSearchCombinedRows } from './search-cost-analysis.mjs';
import { compareSearchResults } from './search-analysis.mjs';
import { discoverSearchTerms } from './search-capacity.mjs';

const check = (ok, code) => {
  if (!ok) throw new Error(code);
};
const number = (n) => Number.isFinite(n) && n >= 0;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const hash = (sql) => createHash('sha256').update(sql).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONDITIONS = ['short', 'wide', 'rare', 'zero', 'rare-state', 'zero-new', 'short-new'];
const STATES = [
  'new',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
  'cancelled',
  'merged',
];
const FAILURES = new Set([
  'INDEX_ABORTED',
  'INDEX_TIME_LIMIT',
  'INDEX_RUNTIME_REQUIRED',
  'INDEX_FIXTURE_INVALID',
  'INDEX_CATALOG_INVALID',
  'INDEX_SETTINGS_INVALID',
  'INDEX_RESTORATION_FAILED',
  'INDEX_QUERY_INVALID',
  'INDEX_RESULT_INVALID',
  'INDEX_EQUIVALENCE_FAILED',
  'INDEX_PLAN_INVALID',
  'INDEX_PLAN_NODE_REJECTED',
  'INDEX_PLAN_INDEX_REJECTED',
  'INDEX_PLAN_RELATION_REJECTED',
  'INDEX_PLAN_CTE_REJECTED',
  'INDEX_PLAN_PARENT_REJECTED',
  'INDEX_PLAN_JOIN_REJECTED',
  'INDEX_PLAN_DIRECTION_REJECTED',
  'INDEX_PLAN_SUBPLAN_REJECTED',
  'INDEX_PLAN_NUMBER_INVALID',
  'INDEX_PLAN_EXECUTION_UNEXPECTED',
  'INDEX_PROTOCOL_FAILED',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
  'SEARCH_COST_RESULT_INVALID',
]);
const safe = (error) => (FAILURES.has(error?.message) ? error.message : 'INDEX_DIAGNOSTIC_FAILED');
const NODES = new Set([
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
]);
const RELATIONS = new Set([
  'ticket',
  'app_user',
  'sla_policy',
  'assignment_group',
  'role_binding',
  'role',
  'organization',
]);
const CTES = new Set([
  'probe_keys',
  'probe_evaluation',
  'probe_status',
  'matched',
  'counted',
  'selected_keys',
  'page',
]);
const INDEXES = new Set([
  'ticket_pkey',
  'ticket_id_org_asset_key',
  'ticket_number_key',
  'ticket_list_org_idx',
  'ticket_list_state_idx',
  'ticket_org_state_idx',
  'ticket_search_trgm_idx',
  'ticket_list_requester_idx',
  'ticket_requester_idx',
  'ticket_list_assignee_idx',
  'ticket_assignee_idx',
  'ticket_subject_trgm_idx',
  'ticket_number_pattern_idx',
  'ticket_group_queue_idx',
  'app_user_pkey',
  'assignment_group_pkey',
  'assignment_group_code_key',
  'sla_policy_pkey',
  'sla_policy_org_priority_key',
  'role_binding_user_idx',
  'role_binding_org_idx',
  'role_binding_pkey',
  'role_binding_active_key',
  'role_pkey',
  'role_code_key',
  'role_id_scope_key',
  'organization_pkey',
]);

// Fixed catalog queries return no policy expressions, index definitions or locale strings.
const CATALOG = {
  environment: `SELECT current_setting('server_version_num')::int AS version,
    current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
    t.relowner=r.oid AS owns_ticket, t.relrowsecurity AS rls, t.relforcerowsecurity AS force_rls,
    row_security_active(t.oid) AS rls_active, t.reltuples::float8 AS estimated_rows,
    t.relpages AS estimated_pages, a.attstattarget AS statistics_target,
    c.collprovider AS collation_provider, c.collisdeterministic AS deterministic,
    c.collname='default' AND c.collnamespace='pg_catalog'::regnamespace AS default_collation,
    EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname='public' AND s.tablename='ticket'
      AND s.attname='search_text') AS visible_column_statistics,
    EXISTS (SELECT 1 FROM pg_stat_all_tables s WHERE s.relid=t.oid
      AND (s.last_analyze IS NOT NULL OR s.last_autoanalyze IS NOT NULL)) AS analyze_recorded
    FROM pg_class t JOIN pg_roles r ON r.rolname=current_user
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname='search_text' AND NOT a.attisdropped
    JOIN pg_collation c ON c.oid=a.attcollation WHERE t.oid='public.ticket'::regclass`,
  index: `SELECT i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
    i.indcheckxmin AS check_xmin, i.indnkeyatts AS key_columns, i.indnatts AS all_columns,
    i.indexprs IS NOT NULL AS expression, i.indpred IS NOT NULL AS partial,
    i.indkey[0]=a.attnum AS search_text_column, i.indcollation[0]=a.attcollation AS collation_matches,
    am.amname AS access_method, oc.opcname AS opclass, f.opfname AS opfamily,
    EXISTS (SELECT 1 FROM pg_amop ao JOIN pg_operator o ON o.oid=ao.amopopr
      WHERE ao.amopfamily=oc.opcfamily AND ao.amopmethod=am.oid AND ao.amoppurpose='s'
        AND o.oprnamespace='pg_catalog'::regnamespace AND o.oprname='~~*'
        AND ao.amoplefttype='text'::regtype AND ao.amoprighttype='text'::regtype) AS supports_ilike
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid
    JOIN pg_am am ON am.oid=x.relam JOIN pg_opclass oc ON oc.oid=i.indclass[0]
    JOIN pg_opfamily f ON f.oid=oc.opcfamily
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='search_text'
    WHERE i.indexrelid=to_regclass('public.ticket_search_trgm_idx')
      AND i.indrelid='public.ticket'::regclass`,
  operator: `SELECT o.oprname AS operator, p.proname AS procedure, p.proleakproof AS leakproof,
    p.provolatile AS volatility, p.proisstrict AS strict, p.prosecdef AS security_definer
    FROM pg_operator o JOIN pg_proc p ON p.oid=o.oprcode
    WHERE o.oprnamespace='pg_catalog'::regnamespace AND p.pronamespace='pg_catalog'::regnamespace
      AND o.oprname='~~*' AND o.oprleft='text'::regtype AND o.oprright='text'::regtype`,
};
const SETTINGS = `SELECT current_setting('enable_seqscan') AS seqscan,
  current_setting('enable_indexscan') AS indexscan, current_setting('enable_bitmapscan') AS bitmapscan,
  current_setting('jit') AS jit, current_setting('row_security') AS row_security`;
const SET_SEQUENCE = "SELECT set_config('enable_seqscan',$1,true) AS seqscan";
const EQUALITY = 'SELECT id FROM ticket WHERE organization_id=$1 AND id=$2';

/** Unknown values are rejected; a visible absence or unhealthy index remains an observation. */
export function sanitizeSearchIndexCatalog(kind, rows) {
  check(Array.isArray(rows), 'INDEX_CATALOG_INVALID');
  if (kind === 'index' && rows.length === 0) return { present: false };
  check(rows.length === 1 && rows[0] && typeof rows[0] === 'object', 'INDEX_CATALOG_INVALID');
  const row = rows[0];
  const bools = (keys) =>
    Object.fromEntries(
      keys.map((key) => {
        check(typeof row[key] === 'boolean', 'INDEX_CATALOG_INVALID');
        return [key, row[key]];
      }),
    );
  if (kind === 'environment') {
    check(
      Number.isInteger(row.version) &&
        row.version >= 160000 &&
        row.version < 170000 &&
        row.role === 'solvi_app' &&
        (row.estimated_rows === -1 || number(row.estimated_rows)) &&
        integer(row.estimated_pages) &&
        Number.isInteger(row.statistics_target) &&
        row.statistics_target >= -1 &&
        ['d', 'c', 'i'].includes(row.collation_provider),
      'INDEX_CATALOG_INVALID',
    );
    const result = {
      version: row.version,
      role: 'solvi_app',
      estimatedRows: row.estimated_rows === -1 ? null : row.estimated_rows,
      estimatedRowsKnown: row.estimated_rows !== -1,
      estimatedPages: row.estimated_pages,
      statisticsTarget: row.statistics_target,
      collationProvider: row.collation_provider,
      ...bools([
        'superuser',
        'bypass_rls',
        'owns_ticket',
        'rls',
        'force_rls',
        'rls_active',
        'deterministic',
        'default_collation',
        'visible_column_statistics',
        'analyze_recorded',
      ]),
      statisticsVisibility: row.visible_column_statistics ? 'visible' : 'not-visible-or-absent',
    };
    check(
      !result.superuser &&
        !result.bypass_rls &&
        !result.owns_ticket &&
        result.rls &&
        result.force_rls &&
        result.rls_active,
      'INDEX_CATALOG_INVALID',
    );
    return result;
  }
  if (kind === 'index') {
    check(
      row.access_method === 'gin' &&
        row.opclass === 'gin_trgm_ops' &&
        row.opfamily === 'gin_trgm_ops' &&
        integer(row.key_columns) &&
        row.key_columns > 0 &&
        integer(row.all_columns) &&
        row.all_columns >= row.key_columns,
      'INDEX_CATALOG_INVALID',
    );
    return {
      present: true,
      name: 'ticket_search_trgm_idx',
      accessMethod: 'gin',
      opclass: 'gin_trgm_ops',
      opfamily: 'gin_trgm_ops',
      keyColumns: row.key_columns,
      allColumns: row.all_columns,
      ...bools([
        'valid',
        'ready',
        'live',
        'check_xmin',
        'expression',
        'partial',
        'search_text_column',
        'collation_matches',
        'supports_ilike',
      ]),
    };
  }
  check(
    kind === 'operator' &&
      row.operator === '~~*' &&
      row.procedure === 'texticlike' &&
      ['i', 's', 'v'].includes(row.volatility),
    'INDEX_CATALOG_INVALID',
  );
  return {
    operator: '~~*',
    procedure: 'texticlike',
    volatility: row.volatility,
    ...bools(['leakproof', 'strict', 'security_definer']),
  };
}

/** Both modes use a closed tree; plan-only never receives invented execution/row/buffer values. */
export function summarizeSearchIndexPlan(document, executed) {
  check(
    typeof executed === 'boolean' &&
      Array.isArray(document) &&
      document.length === 1 &&
      document[0] &&
      typeof document[0] === 'object',
    'INDEX_PLAN_INVALID',
  );
  const root = document[0];
  if (!executed) check(root['Execution Time'] === undefined, 'INDEX_PLAN_EXECUTION_UNEXPECTED');
  let nodes = 0;
  const scans = [],
    indexes = new Set();
  let ginExecuted = false;
  const walk = (raw, depth = 0) => {
    check(raw && typeof raw === 'object' && depth <= 64 && ++nodes <= 512, 'INDEX_PLAN_INVALID');
    check(NODES.has(raw['Node Type']), 'INDEX_PLAN_NODE_REJECTED');
    const clean = { nodeType: raw['Node Type'] };
    for (const [source, target, values, rejection] of [
      ['Index Name', 'indexName', INDEXES, 'INDEX_PLAN_INDEX_REJECTED'],
      ['Relation Name', 'relationName', RELATIONS, 'INDEX_PLAN_RELATION_REJECTED'],
      ['CTE Name', 'cteName', CTES, 'INDEX_PLAN_CTE_REJECTED'],
      [
        'Parent Relationship',
        'relationship',
        new Set(['Outer', 'Inner', 'InitPlan', 'SubPlan', 'Member', 'Subquery']),
        'INDEX_PLAN_PARENT_REJECTED',
      ],
      [
        'Join Type',
        'joinType',
        new Set(['Inner', 'Left', 'Right', 'Full', 'Semi', 'Anti']),
        'INDEX_PLAN_JOIN_REJECTED',
      ],
      [
        'Scan Direction',
        'scanDirection',
        new Set(['Forward', 'Backward', 'NoMovement']),
        'INDEX_PLAN_DIRECTION_REJECTED',
      ],
    ])
      if (raw[source] !== undefined) {
        check(values.has(raw[source]), rejection);
        clean[target] = raw[source];
      }
    if (clean.indexName) indexes.add(clean.indexName);
    if (raw['Subplan Name'] !== undefined) {
      const name = raw['Subplan Name'];
      if (typeof name === 'string' && name.startsWith('CTE ')) {
        check(CTES.has(name.slice(4)), 'INDEX_PLAN_CTE_REJECTED');
        clean.cteProducer = name.slice(4);
      } else {
        check(
          typeof name === 'string' && /^(InitPlan|SubPlan) \d+( \(returns \$\d+\))?$/.test(name),
          'INDEX_PLAN_SUBPLAN_REJECTED',
        );
        clean.subplan = name.startsWith('InitPlan') ? 'InitPlan' : 'SubPlan';
      }
    }
    for (const [source, target] of [
      ['Plan Rows', 'plannedRows'],
      ['Startup Cost', 'startupCost'],
      ['Total Cost', 'totalCost'],
    ]) {
      check(number(raw[source]), 'INDEX_PLAN_NUMBER_INVALID');
      clean[target] = raw[source];
    }
    const numeric = [
      'Actual Rows',
      'Actual Loops',
      'Rows Removed by Filter',
      'Rows Removed by Index Recheck',
      'Exact Heap Blocks',
      'Lossy Heap Blocks',
    ];
    if (executed) {
      check(number(raw['Actual Rows']) && number(raw['Actual Loops']), 'INDEX_PLAN_NUMBER_INVALID');
      for (const key of numeric)
        if (raw[key] !== undefined) check(number(raw[key]), 'INDEX_PLAN_NUMBER_INVALID');
      clean.actualRows = raw['Actual Rows'];
      clean.actualLoops = raw['Actual Loops'];
      clean.removedByFilter = raw['Rows Removed by Filter'] ?? 0;
      clean.removedByIndexRecheck = raw['Rows Removed by Index Recheck'] ?? 0;
      clean.exactHeapBlocks = raw['Exact Heap Blocks'] ?? 0;
      clean.lossyHeapBlocks = raw['Lossy Heap Blocks'] ?? 0;
      if (clean.indexName === 'ticket_search_trgm_idx' && clean.actualLoops > 0) ginExecuted = true;
    } else
      check(
        numeric.every((key) => raw[key] === undefined),
        'INDEX_PLAN_EXECUTION_UNEXPECTED',
      );
    if (raw['Relation Name'] === 'ticket' && /Scan$/.test(clean.nodeType)) {
      const predicate = ['Filter', 'Index Cond', 'Recheck Cond'].some(
        (key) => typeof raw[key] === 'string' && /\bsearch_text\b/.test(raw[key]),
      );
      const scan = {
        nodeType: clean.nodeType,
        ...(clean.indexName ? { indexName: clean.indexName } : {}),
        searchPredicate: predicate,
      };
      if (executed)
        Object.assign(scan, {
          loops: clean.actualLoops,
          returnedRows: clean.actualRows * clean.actualLoops,
          visitedRows:
            (clean.actualRows + clean.removedByFilter + clean.removedByIndexRecheck) *
            clean.actualLoops,
          removedByFilter: clean.removedByFilter * clean.actualLoops,
          removedByIndexRecheck: clean.removedByIndexRecheck * clean.actualLoops,
          exactHeapBlocks: clean.exactHeapBlocks,
          lossyHeapBlocks: clean.lossyHeapBlocks,
        });
      scans.push(scan);
    }
    if (raw.Plans !== undefined) {
      check(Array.isArray(raw.Plans), 'INDEX_PLAN_INVALID');
      clean.children = raw.Plans.map((child) => walk(child, depth + 1));
    }
    return clean;
  };
  const plan = walk(root.Plan);
  if (executed) sanitizeExplain(document);
  const result = {
    executed,
    plan,
    indexes: [...indexes].sort(),
    searchGinPlanned: indexes.has('ticket_search_trgm_idx'),
    searchGinExecuted: executed ? ginExecuted : null,
    ticketScans: scans,
    eligibilityEstablished: false,
  };
  if (executed) {
    result.executionMs = root['Execution Time'];
    result.planningMs = root['Planning Time'];
    const buffers = {};
    for (const family of ['Shared', 'Local', 'Temp'])
      for (const kind of family === 'Temp'
        ? ['Read', 'Written']
        : ['Hit', 'Read', 'Dirtied', 'Written']) {
        const value = root.Plan[`${family} ${kind} Blocks`];
        check(value === undefined || integer(value), 'INDEX_PLAN_NUMBER_INVALID');
        buffers[family.toLowerCase() + kind + 'Blocks'] = value ?? 0;
      }
    result.rootBuffers = buffers;
  }
  return result;
}

function settings(rows) {
  check(Array.isArray(rows) && rows.length === 1, 'INDEX_SETTINGS_INVALID');
  return Object.fromEntries(
    ['seqscan', 'indexscan', 'bitmapscan', 'jit', 'row_security'].map((key) => {
      check(['on', 'off'].includes(rows[0]?.[key]), 'INDEX_SETTINGS_INVALID');
      return [key, rows[0][key]];
    }),
  );
}
function queryContract(built) {
  check(
    built &&
      built.limit === 50 &&
      Array.isArray(built.params) &&
      Array.isArray(built.countParams) &&
      ['sql', 'countSql', 'combinedSql'].every(
        (key) =>
          typeof built[key] === 'string' &&
          /^\s*SELECT\b/.test(built[key]) &&
          !built[key].includes(';'),
      ),
    'INDEX_QUERY_INVALID',
  );
  return {
    listSha256: hash(built.sql),
    countSha256: hash(built.countSql),
    combinedSha256: hash(built.combinedSql),
  };
}
const contextFor = (actor, organizationId) => ({
  organizationId,
  principal: {
    userId: actor.userId,
    status: 'active',
    bindings: [{ roleCode: actor.role, organizationId, validFrom: new Date(0), validUntil: null }],
  },
});

export async function analyzeSearchIndex(runtime, fixture, { signal, onProgress } = {}) {
  const start = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    protocolCompleted: false,
    catalogComplete: false,
    restorationVerified: false,
    adoptionEstablished: false,
    interpretation:
      'Observed RLS-active plans and catalog facts. Discouraging sequential scans is not forcing an index or proving ineligibility. No speed, adoption, HTTP or capacity conclusion.',
    conditions: [],
    boundaries: [],
    equalityControls: [],
    catalog: {},
    readOnlyContexts: [],
    hardCapMs: 360000,
  };
  const budget = () => {
    check(!signal?.aborted, 'INDEX_ABORTED');
    check(performance.now() - start < report.hardCapMs, 'INDEX_TIME_LIMIT');
  };
  const progress = async (stage) => {
    if (onProgress) await onProgress(stage);
    budget();
  };
  const read = async (name, context, callback) =>
    runtime.withAppReadOnly(context, async (client) => {
      budget();
      const proof = sanitizeReadOnlyProof(client.proof);
      const query = async (sql, params = []) => {
        budget();
        const result = await client.query(sql, params);
        budget();
        return result;
      };
      const special = (
        await query(
          "SELECT coalesce(current_setting('app.autoclose',true),'') <> 'on' AS autoclose_disabled",
        )
      ).rows;
      check(
        special.length === 1 && special[0].autoclose_disabled === true,
        'INDEX_SETTINGS_INVALID',
      );
      report.readOnlyContexts.push({ name, proof, autocloseDisabled: true });
      return callback(client, query, proof);
    });
  try {
    budget();
    check(
      runtime &&
        typeof runtime.withAppReadOnly === 'function' &&
        typeof runtime.buildTicketListQuery === 'function',
      'INDEX_RUNTIME_REQUIRED',
    );
    const actor = fixture?.actors?.find((a) => a.role === 'agent');
    const requester = fixture?.actors?.find((a) => a.role === 'requester');
    check(
      actor &&
        requester &&
        [
          actor.userId,
          requester.userId,
          actor.ticketId,
          requester.ticketId,
          fixture.organizationId,
          fixture.controlOrganizationId,
          fixture.controlTicketId,
        ].every((id) => UUID.test(id)) &&
        actor.userId !== requester.userId &&
        fixture.organizationId !== fixture.controlOrganizationId,
      'INDEX_FIXTURE_INVALID',
    );
    const discovery = await discoverSearchTerms(
      {
        ...runtime,
        withAppReadOnly: (context, callback) =>
          read('terms', context, (_client, query, proof) => callback({ query, proof })),
      },
      fixture,
      signal,
    );
    const terms = new Map(discovery.terms.map((term) => [term.key, term.keyword]));
    check(
      ['short', 'wide', 'rare', 'zero'].every((key) => typeof terms.get(key) === 'string'),
      'INDEX_FIXTURE_INVALID',
    );
    const ctx = contextFor(actor, fixture.organizationId);
    let rareState;
    await read(
      'catalog',
      { organizationId: fixture.organizationId, actorId: actor.userId },
      async (_client, query) => {
        for (const [kind, sql] of Object.entries(CATALOG)) {
          report.catalog[kind] = { available: false };
          const value = sanitizeSearchIndexCatalog(kind, (await query(sql)).rows);
          report.catalog[kind] = { available: true, ...value };
        }
        report.catalogComplete = true;
        const stateRows = (
          await query('SELECT state FROM ticket WHERE organization_id=$1 AND id=$2', [
            fixture.organizationId,
            actor.ticketId,
          ])
        ).rows;
        check(
          stateRows.length === 1 && STATES.includes(stateRows[0].state),
          'INDEX_FIXTURE_INVALID',
        );
        rareState = stateRows[0].state;
        const bindings = (
          await query(
            `SELECT r.code FROM role_binding rb JOIN role r ON r.id=rb.role_id
        JOIN app_user u ON u.id=rb.user_id WHERE rb.user_id=$1 AND u.status='active'
        AND (rb.organization_id=$2 OR rb.organization_id IS NULL) AND rb.valid_from<=now()
        AND (rb.valid_until IS NULL OR rb.valid_until>now())`,
            [requester.userId, fixture.organizationId],
          )
        ).rows;
        check(
          bindings.some((b) => b.code === 'requester') &&
            !bindings.some((b) =>
              ['agent', 'org_admin', 'platform_admin', 'auditor', 'platform_auditor'].includes(
                b.code,
              ),
            ),
          'INDEX_FIXTURE_INVALID',
        );
      },
    );
    await progress('index-catalog-completed');
    await progress('index-ready');
    const semantic = async (query, built, item, context, expected) => {
      item.binding = queryContract(built);
      const list = (await query(built.sql, built.params)).rows;
      const counts = (await query(built.countSql, built.countParams)).rows;
      check(counts.length === 1 && integer(counts[0]?.total), 'INDEX_RESULT_INVALID');
      const combined = normalizeSearchCombinedRows(
        (await query(built.combinedSql, built.params)).rows,
        built.limit,
      );
      item.comparison = compareSearchResults({ rows: list, total: counts[0].total }, combined);
      item.rows = combined.rows.length;
      item.total = combined.total;
      item.organization = combined.rows.every(
        (row) => row.organization_id === context.organizationId,
      );
      item.requester =
        context.principal.bindings[0].roleCode !== 'requester' ||
        combined.rows.every((row) => row.requester_id === requester.userId);
      item.expectedPopulation =
        expected === 'zero'
          ? combined.total === 0
          : expected === 'one'
            ? combined.total === 1
            : combined.total > 0;
      check(
        item.comparison.equal && item.organization && item.requester && item.expectedPopulation,
        'INDEX_EQUIVALENCE_FAILED',
      );
    };
    for (const name of CONDITIONS) {
      const base =
        name === 'rare-state' ? 'rare' : name.endsWith('-new') ? name.split('-')[0] : name;
      const filter = {
        keyword: terms.get(base),
        ...(name === 'rare-state'
          ? { state: [rareState] }
          : name.endsWith('-new')
            ? { state: ['new'] }
            : {}),
      };
      const built = runtime.buildTicketListQuery(ctx, {
        filter,
        sort: { column: 'created_at', direction: 'desc' },
        limit: 50,
      });
      const item = {
        name,
        completed: false,
        normal: {},
        discouragedSequentialScan: {},
        setting: { restored: false },
      };
      report.conditions.push(item);
      await read(
        name,
        { organizationId: fixture.organizationId, actorId: actor.userId },
        async (client, query, proof) => {
          item.proof = proof;
          const before = settings((await query(SETTINGS)).rows);
          item.setting.before = before;
          check(before.seqscan === 'on' && before.row_security === 'on', 'INDEX_SETTINGS_INVALID');
          await semantic(
            query,
            built,
            item,
            ctx,
            base === 'zero' ? 'zero' : base === 'rare' ? 'one' : 'positive',
          );
          for (const kind of ['count', 'combined']) {
            const sql = kind === 'count' ? built.countSql : built.combinedSql;
            const params = kind === 'count' ? built.countParams : built.params;
            item.normal[kind] = summarizeSearchIndexPlan(
              (await query('EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, FORMAT JSON) ' + sql, params))
                .rows[0]?.['QUERY PLAN'],
              true,
            );
          }
          let windowFailure;
          try {
            const changed = (await query(SET_SEQUENCE, ['off'])).rows;
            check(changed.length === 1 && changed[0].seqscan === 'off', 'INDEX_SETTINGS_INVALID');
            item.setting.during = settings((await query(SETTINGS)).rows);
            check(
              isDeepStrictEqual(item.setting.during, { ...before, seqscan: 'off' }),
              'INDEX_SETTINGS_INVALID',
            );
            for (const kind of ['count', 'combined']) {
              const sql = kind === 'count' ? built.countSql : built.combinedSql;
              const params = kind === 'count' ? built.countParams : built.params;
              item.discouragedSequentialScan[kind] = summarizeSearchIndexPlan(
                (await query('EXPLAIN (FORMAT JSON) ' + sql, params)).rows[0]?.['QUERY PLAN'],
                false,
              );
            }
          } catch (error) {
            item.failureCode = safe(error);
            windowFailure = error;
          } finally {
            // Attempt restoration even after abort/budget expiry; the runtime still owns rollback/end.
            try {
              const restored = (await client.query(SET_SEQUENCE, [before.seqscan])).rows;
              check(
                restored.length === 1 && restored[0].seqscan === before.seqscan,
                'INDEX_RESTORATION_FAILED',
              );
              item.setting.after = settings((await client.query(SETTINGS)).rows);
              item.setting.restored = isDeepStrictEqual(before, item.setting.after);
              check(item.setting.restored, 'INDEX_RESTORATION_FAILED');
            } catch {
              item.setting.restored = false;
              windowFailure = new Error('INDEX_RESTORATION_FAILED');
            }
          }
          if (windowFailure) throw windowFailure;
          item.completed = true;
        },
      );
      await progress(`index-${name}-completed`);
    }
    for (const name of ['own', 'foreign']) {
      const own = name === 'own';
      const context = own ? contextFor(requester, fixture.organizationId) : ctx;
      const item = { name, completed: false };
      report.boundaries.push(item);
      await read(
        name,
        {
          organizationId: own ? fixture.organizationId : fixture.controlOrganizationId,
          actorId: own ? requester.userId : actor.userId,
        },
        async (_client, query, proof) => {
          item.proof = proof;
          const built = runtime.buildTicketListQuery(context, {
            filter: { keyword: terms.get('short') },
            sort: { column: 'created_at', direction: 'desc' },
            limit: 50,
          });
          await semantic(query, built, item, context, own ? 'positive' : 'zero');
          const control = { name, completed: false };
          report.equalityControls.push(control);
          const id = own ? requester.ticketId : actor.ticketId;
          const params = [fixture.organizationId, id];
          const rows = (await query(EQUALITY, params)).rows;
          check(
            own ? rows.length === 1 && rows[0].id === id : rows.length === 0,
            'INDEX_EQUIVALENCE_FAILED',
          );
          control.rows = rows.length;
          control.plan = summarizeSearchIndexPlan(
            (await query('EXPLAIN (ANALYZE, TIMING OFF, BUFFERS, FORMAT JSON) ' + EQUALITY, params))
              .rows[0]?.['QUERY PLAN'],
            true,
          );
          control.completed = true;
          item.completed = true;
        },
      );
    }
    await progress('index-boundaries-completed');
    report.restorationVerified =
      report.conditions.length === 7 && report.conditions.every((item) => item.setting.restored);
    report.equivalent =
      report.conditions.length === 7 &&
      report.boundaries.length === 2 &&
      [...report.conditions, ...report.boundaries].every(
        (item) =>
          item.comparison?.equal && item.expectedPopulation && item.organization && item.requester,
      );
    report.protocolCompleted =
      report.restorationVerified &&
      report.equivalent &&
      report.conditions.every((item) => item.completed) &&
      report.boundaries.every((item) => item.completed) &&
      report.equalityControls.length === 2 &&
      report.equalityControls.every((item) => item.completed);
    check(report.protocolCompleted, 'INDEX_PROTOCOL_FAILED');
    report.completed = true;
  } catch (error) {
    report.failureCode = safe(error);
  }
  report.elapsedMs = performance.now() - start;
  return report;
}
