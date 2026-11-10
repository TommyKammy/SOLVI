import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';
import { buildDeadlineBoundaryQuery, validateDeadlineResult } from './deadline-analysis.mjs';
import {
  compareSearchResults,
  prepareSearchBoundary,
  runSearchAnalysis,
  summarizeSearchPlan,
} from './search-analysis.mjs';
import { discoverSearchTerms } from './search-capacity.mjs';

const TOTAL = '__solvi_total';
// Existing id PK and UNIQUE(id, organization_id), defined in migrations 0004 / 0028.
const UNIQUE_TICKET_ID_INDEXES = new Set(['ticket_pkey', 'ticket_id_org_asset_key']);
const SENTINEL_FIELDS = [
  'id',
  'organization_id',
  'requester_id',
  'created_at',
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
const EXPLAIN = 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ';
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const failures = new Set([
  'SEARCH_COST_ABORTED',
  'SEARCH_COST_TIME_LIMIT',
  'SEARCH_COST_RUNTIME_REQUIRED',
  'SEARCH_COST_RESULT_INVALID',
  'SEARCH_COST_QUERY_REJECTED',
  'SEARCH_COST_ADAPTER_SEQUENCE',
  'SEARCH_COST_CATALOG_INVALID',
  'SEARCH_COST_SEMANTICS_FAILED',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
]);
const contextFor = (actor, organizationId) => ({
  organizationId,
  principal: {
    userId: actor.userId,
    status: 'active',
    bindings: [{ roleCode: actor.role, organizationId, validFrom: new Date(0), validUntil: null }],
  },
});

/** Preserve pg-native values. Only the private count column is removed. */
export function normalizeSearchCombinedRows(rows, limit) {
  check(Array.isArray(rows) && rows.length > 0, 'SEARCH_COST_RESULT_INVALID');
  const total = rows[0]?.[TOTAL];
  check(Number.isSafeInteger(total) && total >= 0, 'SEARCH_COST_RESULT_INVALID');
  check(
    rows.every((row) => row && Object.hasOwn(row, TOTAL) && row[TOTAL] === total),
    'SEARCH_COST_RESULT_INVALID',
  );
  if (rows.some((row) => row.id === null)) {
    check(
      rows.length === 1 &&
        SENTINEL_FIELDS.every((field) => Object.hasOwn(rows[0], field)) &&
        Object.entries(rows[0]).every(([key, value]) => key === TOTAL || value === null),
      'SEARCH_COST_RESULT_INVALID',
    );
    return { rows: [], total };
  }
  return validateDeadlineResult(
    rows.map((row) => {
      const copy = { ...row };
      delete copy[TOTAL];
      return copy;
    }),
    total,
    limit,
  );
}

/** Reuse all 046 cases, executing combined SQL explicitly, including the CTE boundary. */
export function createSearchSemanticRuntime(runtime, fixture, budget = () => {}) {
  const registry = [];
  const boundary = prepareSearchBoundary(fixture);
  const stats = { combinedExecutions: 0, reusedTotals: 0 };
  const adaptQuery = (built) => {
    if (!built.combinedSql) return built;
    const list = { sql: built.combinedSql, params: built.params };
    const count = { sql: built.countSql, params: built.countParams };
    registry.push(
      { list, count, limit: built.limit },
      {
        list: buildDeadlineBoundaryQuery(list, boundary),
        count: buildDeadlineBoundaryQuery(count, boundary),
        limit: built.limit,
      },
    );
    return { ...built, sql: built.combinedSql };
  };
  const adapted = {
    buildLegacySearchQuery: (ctx, options) =>
      adaptQuery(runtime.buildLegacySearchWorkloadQuery(ctx, options)),
    buildTicketListQuery(ctx, options) {
      return adaptQuery(runtime.buildTicketListQuery(ctx, options));
    },
    withAppReadOnly(context, callback) {
      return runtime.withAppReadOnly(context, async (client) => {
        let pending;
        const facade = {
          proof: client.proof,
          async query(sql, params = []) {
            budget();
            if (pending) {
              check(
                sql === pending.count.sql && isDeepStrictEqual(params, pending.count.params),
                'SEARCH_COST_ADAPTER_SEQUENCE',
              );
              const total = pending.total;
              pending = undefined;
              stats.reusedTotals++;
              return { rows: [{ total }] };
            }
            const entry = registry.find(
              (item) => item.list.sql === sql && isDeepStrictEqual(item.list.params, params),
            );
            const result = await client.query(sql, params);
            budget();
            if (!entry) return result;
            const semantic = normalizeSearchCombinedRows(result.rows, entry.limit);
            pending = { count: entry.count, total: semantic.total };
            stats.combinedExecutions++;
            return { ...result, rows: semantic.rows };
          },
        };
        const result = await callback(facade);
        check(!pending, 'SEARCH_COST_ADAPTER_SEQUENCE');
        return result;
      });
    },
  };
  return { runtime: adapted, stats };
}

export function isUniqueTicketIdLookup(node) {
  return (
    node['Node Type'] === 'Index Scan' &&
    UNIQUE_TICKET_ID_INDEXES.has(node['Index Name']) &&
    typeof node['Index Cond'] === 'string' &&
    /\bid\b\s*=/.test(node['Index Cond'])
  );
}

/** A predicate scan and the later page PK fetch are different kinds of work. */
export function summarizeSearchCostPlan(document, returnedRows) {
  const plan = sanitizeExplain(document);
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(document[0].Plan);
  const predicate = (node) =>
    node['Relation Name'] === 'ticket' &&
    ['Filter', 'Index Cond', 'Recheck Cond'].some(
      (key) => typeof node[key] === 'string' && /\bsearch_text\b/.test(node[key]),
    );
  const metric = (node) => {
    const loops = node['Actual Loops'];
    const rows = node['Actual Rows'];
    const removed = node['Rows Removed by Filter'] ?? 0;
    const rechecked = node['Rows Removed by Index Recheck'] ?? 0;
    check(
      [loops, rows, removed, rechecked].every((value) => Number.isFinite(value) && value >= 0),
      'QUERY_PLAN_INVALID',
    );
    return {
      nodeType: node['Node Type'],
      actualLoops: loops,
      actualRows: rows,
      returnedRows: loops * rows,
      // This is scan work, not an exact count of ILIKE function evaluations.
      visitedRows: loops * (rows + removed + rechecked),
    };
  };
  const searchScans = nodes.filter(predicate).map(metric);
  const pageTicketLookups = nodes
    .filter((node) => node['Relation Name'] === 'ticket' && !predicate(node))
    .map((node) => ({
      ...metric(node),
      uniqueIdLookup: isUniqueTicketIdLookup(node),
    }));
  const matchedProducers = nodes
    .filter((node) => node['Subplan Name'] === 'CTE matched')
    .map(metric);
  const matchedReaders = nodes
    .filter((node) => node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'matched')
    .map(metric);
  const display = summarizeSearchPlan(document, returnedRows);
  const resources = Object.fromEntries(
    ['sharedHitBlocks', 'sharedReadBlocks', 'tempReadBlocks', 'tempWrittenBlocks'].map((key) => [
      key,
      plan.plan[key] ?? 0,
    ]),
  );
  return {
    plan,
    resources,
    searchScans,
    predicateScanNodes: searchScans.length,
    predicateScannedOnce: searchScans.length === 1 && searchScans[0].actualLoops === 1,
    predicateRowsVisited: searchScans.reduce((sum, item) => sum + item.visitedRows, 0),
    pageTicketLookups,
    pageTicketRows: pageTicketLookups.reduce((sum, item) => sum + item.returnedRows, 0),
    pageTicketLookupsBounded:
      (returnedRows === 0 || pageTicketLookups.length > 0) &&
      pageTicketLookups.reduce((sum, item) => sum + item.visitedRows, 0) <= returnedRows &&
      pageTicketLookups.reduce((sum, item) => sum + item.actualLoops, 0) <= returnedRows &&
      pageTicketLookups.every(
        (item) =>
          item.uniqueIdLookup &&
          item.actualLoops <= returnedRows &&
          item.visitedRows <= returnedRows,
      ),
    matchedProducers,
    matchedReaders,
    materializedOnce: matchedProducers.length === 1 && matchedProducers[0].actualLoops === 1,
    matchedReused: matchedReaders.length >= 2,
    limitBeforeDisplayJoins: display.limitBeforeDisplayJoins,
    userLookupsBounded: display.userLookupsBoundedByReturnedRows,
    displayLookups: display.displayLookups,
  };
}

/** Mutate the supplied sample after each completed statement to retain partial evidence. */
export async function measureSearchStatements({
  client,
  built,
  order,
  sample,
  budget = () => {},
  summarizePlan = summarizeSearchCostPlan,
}) {
  const combined = Boolean(built.combinedSql);
  sample.mode = combined ? 'combined' : 'separate';
  sample.order = combined ? ['combined'] : [...order];
  sample.statements = [];
  let rows, total;
  for (const kind of sample.order) {
    budget();
    const sql =
      kind === 'combined' ? built.combinedSql : kind === 'list' ? built.sql : built.countSql;
    const params = kind === 'count' ? built.countParams : built.params;
    check(/^\s*SELECT\b/.test(sql) && !sql.includes(';'), 'SEARCH_COST_QUERY_REJECTED');
    const statement = { kind, completed: false };
    sample.statements.push(statement);
    const started = performance.now();
    const result = await client.query(sql, params);
    statement.wallMs = performance.now() - started;
    budget();
    if (kind === 'combined') {
      const normalized = normalizeSearchCombinedRows(result.rows, built.limit);
      rows = normalized.rows;
      total = normalized.total;
    } else if (kind === 'list') {
      rows = result.rows;
    } else {
      check(result.rows.length === 1, 'SEARCH_COST_RESULT_INVALID');
      total = result.rows[0].total;
      check(Number.isSafeInteger(total) && total >= 0, 'SEARCH_COST_RESULT_INVALID');
    }
    statement.returnedRows = result.rows.length;
    const document = (await client.query(EXPLAIN + sql.trimStart(), params)).rows[0]?.[
      'QUERY PLAN'
    ];
    budget();
    statement.work = summarizePlan(document, kind === 'count' ? 0 : rows.length);
    statement.completed = true;
  }
  const result = validateDeadlineResult(rows, total, built.limit);
  sample.rows = result.rows.length;
  sample.total = result.total;
  sample.completed = true;
  return result;
}

const catalogSql = `SELECT
  EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='ticket_search_trgm_idx' AND i.indisvalid AND i.indisready) AS gin_valid,
  (SELECT p.proleakproof FROM pg_operator o JOIN pg_proc p ON p.oid=o.oprcode
    WHERE o.oprname='~~*' AND o.oprleft='text'::regtype AND o.oprright='text'::regtype
    AND o.oprnamespace='pg_catalog'::regnamespace) AS ilike_leakproof,
  current_setting('work_mem') AS work_mem`;

export async function runSearchCostAnalysis({ runtime, fixture, signal }) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    cases: [],
    readOnlyContexts: [],
    unchangedSorts: [],
    diagnostics: [],
  };
  const budget = () => {
    check(!signal?.aborted, 'SEARCH_COST_ABORTED');
    check(performance.now() - started < 300_000, 'SEARCH_COST_TIME_LIMIT');
  };
  try {
    budget();
    check(
      runtime &&
        ['withAppReadOnly', 'buildTicketListQuery', 'buildLegacySearchWorkloadQuery'].every(
          (key) => typeof runtime[key] === 'function',
        ),
      'SEARCH_COST_RUNTIME_REQUIRED',
    );
    const adapted = createSearchSemanticRuntime(runtime, fixture, budget);
    const semantic = await runSearchAnalysis({ runtime: adapted.runtime, fixture, signal });
    // Count plans in the reused 046 analyzer are independent reference diagnostics.
    // A combined candidate's real count is from the same statement as its page.
    report.cases = semantic.cases.map((item) => {
      const { countPlan, ...candidate } = item.candidate;
      return { ...item, candidate: { ...candidate, referenceCountPlan: countPlan } };
    });
    report.readOnlyContexts.push(...semantic.readOnlyContexts);
    report.unchangedSorts = semantic.unchangedSorts;
    report.semanticExecution = {
      ...adapted.stats,
      referenceCountPlansAreSeparateDiagnostics: true,
    };
    report.semanticCompleted = semantic.completed;
    if (semantic.failureCode) report.semanticFailureCode = semantic.failureCode;
    check(semantic.completed && semantic.equivalent, 'SEARCH_COST_SEMANTICS_FAILED');
    const discovery = await discoverSearchTerms(runtime, fixture, signal);
    report.readOnlyContexts.push({
      name: 'cost-term-discovery',
      proof: sanitizeReadOnlyProof(discovery.proof),
    });
    const actor = fixture.actors.find((item) => item.role === 'agent');
    const ctx = contextFor(actor, fixture.organizationId);
    for (const term of discovery.terms) {
      budget();
      check(['short', 'wide', 'rare', 'zero'].includes(term.key), 'SEARCH_COST_RESULT_INVALID');
      const item = { name: term.key, completed: false, samples: [] };
      report.diagnostics.push(item);
      await runtime.withAppReadOnly(
        { organizationId: fixture.organizationId, actorId: actor.userId },
        async (client) => {
          item.proof = sanitizeReadOnlyProof(client.proof);
          report.readOnlyContexts.push({ name: `cost-${term.key}`, proof: item.proof });
          if (!report.catalog) {
            const row = (await client.query(catalogSql)).rows[0];
            check(
              typeof row?.gin_valid === 'boolean' &&
                typeof row.ilike_leakproof === 'boolean' &&
                /^\d+(kB|MB|GB|B)$/.test(row.work_mem),
              'SEARCH_COST_CATALOG_INVALID',
            );
            report.catalog = {
              searchGinValid: row.gin_valid,
              textIlikeLeakproof: row.ilike_leakproof,
              workMem: row.work_mem,
              indexNonuseCauseEstablished: false,
            };
          }
          const options = {
            filter: { keyword: term.keyword },
            sort: { column: 'created_at', direction: 'desc' },
            limit: 50,
          };
          const legacy = runtime.buildLegacySearchWorkloadQuery(ctx, options);
          const candidate = runtime.buildTicketListQuery(ctx, options);
          for (let repetition = 0; repetition < 4; repetition++) {
            const sample = {
              repetition: repetition + 1,
              completed: false,
              order: repetition % 2 ? ['candidate', 'legacy'] : ['legacy', 'candidate'],
              legacy: {},
              candidate: {},
            };
            item.samples.push(sample);
            const results = {};
            for (const side of sample.order) {
              results[side] = await measureSearchStatements({
                client,
                built: side === 'legacy' ? legacy : candidate,
                order: repetition % 2 ? ['count', 'list'] : ['list', 'count'],
                sample: sample[side],
                budget,
              });
            }
            sample.comparison = compareSearchResults(results.legacy, results.candidate);
            sample.expectedPopulation =
              term.key === 'zero'
                ? results.legacy.total === 0
                : term.key === 'rare'
                  ? results.legacy.total === 1
                  : results.legacy.total > 0;
            sample.completed = true;
          }
          item.completed = true;
        },
      );
    }
    report.equivalent =
      semantic.equivalent &&
      report.diagnostics.length === 4 &&
      new Set(report.diagnostics.map((item) => item.name)).size === 4 &&
      report.diagnostics.every(
        (item) =>
          item.completed &&
          item.samples.length === 4 &&
          item.samples.every(
            (sample) => sample.completed && sample.comparison.equal && sample.expectedPopulation,
          ),
      );
    const samples = report.diagnostics.flatMap((item) => item.samples);
    report.optimization = {
      combinedUsed: samples.every((sample) => sample.candidate.mode === 'combined'),
      predicateScannedOnce: samples.every(
        (sample) =>
          sample.candidate.statements.length === 1 &&
          sample.candidate.statements[0].work.predicateScannedOnce,
      ),
      matchedMaterializedOnce: samples.every(
        (sample) =>
          sample.candidate.statements.length === 1 &&
          sample.candidate.statements[0].work.materializedOnce,
      ),
      matchedReused: samples.every(
        (sample) =>
          sample.candidate.statements.length === 1 &&
          sample.candidate.statements[0].work.matchedReused,
      ),
      pageLookupsBounded: samples.every((sample) =>
        sample.candidate.statements.every((statement) => statement.work.pageTicketLookupsBounded),
      ),
      displayLookupsBounded: samples
        .filter((sample) => sample.candidate.rows > 0)
        .every((sample) =>
          sample.candidate.statements
            .filter((statement) => statement.kind !== 'count')
            .every(
              (statement) =>
                statement.work.limitBeforeDisplayJoins && statement.work.userLookupsBounded,
            ),
        ),
      predicateWorkReduced: samples.every(
        (sample) =>
          sample.candidate.statements.reduce(
            (sum, statement) => sum + statement.work.predicateRowsVisited,
            0,
          ) <
          sample.legacy.statements.reduce(
            (sum, statement) => sum + statement.work.predicateRowsVisited,
            0,
          ),
      ),
    };
    report.optimization.confirmed =
      report.equivalent && Object.values(report.optimization).every(Boolean);
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted
      ? 'SEARCH_COST_ABORTED'
      : failures.has(error?.message)
        ? error.message
        : 'SEARCH_COST_ANALYSIS_FAILED';
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
