import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';
import { buildDeadlineBoundaryQuery, validateDeadlineResult } from './deadline-analysis.mjs';
import {
  compareSearchResults,
  prepareSearchBoundary,
  runSearchAnalysis,
} from './search-analysis.mjs';
import { discoverSearchTerms } from './search-capacity.mjs';
import {
  createSearchSemanticRuntime,
  isUniqueTicketIdLookup,
  measureSearchStatements,
  normalizeSearchCombinedRows,
  summarizeSearchCostPlan,
} from './search-cost-analysis.mjs';

const EXPLAIN = 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ';
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const contextFor = (actor, organizationId) => ({
  organizationId,
  principal: {
    userId: actor.userId,
    status: 'active',
    bindings: [{ roleCode: actor.role, organizationId, validFrom: new Date(0), validUntil: null }],
  },
});
const failures = new Set([
  'PREFIX_ABORTED',
  'PREFIX_TIME_LIMIT',
  'PREFIX_RUNTIME_REQUIRED',
  'PREFIX_RESULT_INVALID',
  'PREFIX_SEMANTICS_FAILED',
  'PREFIX_REFERENCE_REQUIRED',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
]);
const nodesUnder = (node) => [node, ...(node.Plans ?? []).flatMap(nodesUnder)];
const isTicket = (node) =>
  node['Relation Name'] === 'ticket' ||
  (node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'ticket');
const workOf = (node) => {
  const rows = node['Actual Rows'],
    loops = node['Actual Loops'];
  const removed =
    (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0);
  check(
    [rows, loops, removed].every((value) => Number.isFinite(value) && value >= 0),
    'QUERY_PLAN_INVALID',
  );
  return {
    nodeType: node['Node Type'],
    rows,
    loops,
    returnedRows: rows * loops,
    visitedRows: (rows + removed) * loops,
    uniqueIdLookup: isUniqueTicketIdLookup(node),
  };
};

/** Fixed CTE labels only; never publish predicates, SQL, terms, or parameter values. */
export function summarizePrefixPlan(document, returnedRows, expectedPrefix, profile = '048') {
  const sanitized = sanitizeExplain(document);
  const all = nodesUnder(document[0].Plan);
  const names = ['probe_keys', 'probe_evaluation', 'probe_status', 'matched', 'counted'];
  const ctes = Object.fromEntries(
    names.map((name) => {
      const producers = all.filter((node) => node['Subplan Name'] === `CTE ${name}`);
      return [
        name,
        {
          producers: producers.map(workOf),
          ticketScans: producers.flatMap(nodesUnder).filter(isTicket).map(workOf),
        },
      ];
    }),
  );
  const main = [];
  const outside = (node) => {
    if (typeof node['Subplan Name'] === 'string' && node['Subplan Name'].startsWith('CTE ')) return;
    if (isTicket(node)) main.push(workOf(node));
    for (const child of node.Plans ?? []) outside(child);
  };
  outside(document[0].Plan);
  const sum = (items, key) => items.reduce((value, item) => value + item[key], 0);
  const present = names.every((name) => ctes[name].producers.length === 1);
  const anyPrefix = names.some(
    (name) => name.startsWith('probe_') && ctes[name].producers.length > 0,
  );
  const shapeMatchesExpectation =
    expectedPrefix === undefined ? present || !anyPrefix : expectedPrefix ? present : !anyPrefix;
  const matchedLoops = sum(ctes.matched.ticketScans, 'loops');
  const directCountLoops = sum(ctes.counted.ticketScans, 'loops');
  const branch = !present
    ? anyPrefix || expectedPrefix
      ? 'unproven'
      : 'absent'
    : matchedLoops === 0 && directCountLoops === 1
      ? 'prefix'
      : matchedLoops === 1 && directCountLoops === 0
        ? 'fallback'
        : 'unproven';
  const display = summarizeSearchCostPlan(document, returnedRows).displayLookups;
  const stateProbe =
    profile === '049'
      ? {
          scans: all
            .filter((node) => node['Subplan Name'] === 'CTE probe_keys')
            .flatMap(nodesUnder)
            .filter(isTicket)
            .map((node) => ({
              ...workOf(node),
              indexName: [
                'ticket_list_state_idx',
                'ticket_list_org_idx',
                'ticket_list_requester_idx',
              ].includes(node['Index Name'])
                ? node['Index Name']
                : null,
              orderedIndexScan: ['Index Scan', 'Index Only Scan'].includes(node['Node Type']),
              organizationEquality: /\borganization_id\s*=\s*[^=]/.test(node['Index Cond'] ?? ''),
              stateEquality: /\bstate\s*=(?!\s*ANY\b)\s*[^=]/i.test(node['Index Cond'] ?? ''),
              removedRows:
                ((node['Rows Removed by Filter'] ?? 0) +
                  (node['Rows Removed by Index Recheck'] ?? 0)) *
                node['Actual Loops'],
              heapFetches: node['Heap Fetches'] ?? 0,
            })),
        }
      : undefined;
  if (stateProbe) {
    stateProbe.orderedStateIndex =
      stateProbe.scans.length === 1 &&
      stateProbe.scans.every(
        (scan) =>
          scan.indexName === 'ticket_list_state_idx' &&
          scan.orderedIndexScan &&
          scan.organizationEquality &&
          scan.stateEquality &&
          scan.loops === 1,
      );
    stateProbe.visitsBounded =
      stateProbe.scans.length === 1 &&
      stateProbe.scans[0].visitedRows <= sum(ctes.probe_keys.producers, 'returnedRows') &&
      stateProbe.scans[0].removedRows === 0;
  }
  return {
    present,
    expectedPrefix: expectedPrefix ?? null,
    shapeMatchesExpectation,
    ctes,
    branch,
    matchedLoops,
    directCountLoops,
    probeRows: sum(ctes.probe_keys.producers, 'returnedRows'),
    probeVisitedRows: sum(ctes.probe_keys.ticketScans, 'visitedRows'),
    evaluationVisitedRows: sum(ctes.probe_evaluation.ticketScans, 'visitedRows'),
    ...(stateProbe ? { stateProbe } : {}),
    pageTicketScans: main,
    pageUniqueLookupsBounded:
      (returnedRows === 0 || main.length > 0) &&
      main.every((item) => item.uniqueIdLookup) &&
      sum(main, 'visitedRows') <= returnedRows &&
      sum(main, 'loops') <= returnedRows,
    displayLookupsBounded: display
      .filter((item) => item.alias !== 'assignee_group')
      .every(
        (item) =>
          item.observed && item.totalLoops <= returnedRows && item.totalRows <= returnedRows,
      ),
    tempReadBlocks: sanitized.plan.tempReadBlocks ?? 0,
    tempWrittenBlocks: sanitized.plan.tempWrittenBlocks ?? 0,
  };
}
const expectsPrefix = (built) =>
  /\bprobe_keys\s+AS\s+MATERIALIZED\s*\(/i.test(built.combinedSql ?? '');
const usesStatePrefix = (built) =>
  /\bt\.state\s*=/.test(
    (built.combinedSql ?? '')
      .split('probe_evaluation AS MATERIALIZED')[0]
      .split('probe_keys AS MATERIALIZED')[1] ?? '',
  );
const organizationContext = (ctx) => {
  const now = ctx.now ?? new Date();
  return (
    ctx.principal.status === 'active' &&
    ctx.principal.bindings.some(
      (binding) =>
        ['agent', 'org_admin', 'auditor', 'platform_admin', 'platform_auditor'].includes(
          binding.roleCode,
        ) &&
        (binding.organizationId === null || binding.organizationId === ctx.organizationId) &&
        binding.validFrom <= now &&
        (binding.validUntil === null || binding.validUntil > now),
    )
  );
};
const summarize =
  (built, profile = '048') =>
  (document, rows) => ({
    ...summarizeSearchCostPlan(document, rows),
    prefix: summarizePrefixPlan(document, rows, expectsPrefix(built), profile),
  });

/** Add the 046 oracle inside each existing 047/048 comparison's same RR client. */
export function createPrefixReferenceRuntime(runtime, fixture, budget = () => {}, profile = '048') {
  check(['048', '049'].includes(profile), 'PREFIX_RUNTIME_REQUIRED');
  const registry = [],
    current = [];
  const boundary = prepareSearchBoundary(fixture);
  const evidence = { comparisons: [], plans: [], coverage: [] };
  if (profile === '049') {
    evidence.comparisons048 = [];
    evidence.unchanged048 = [];
  }
  let contextIndex = 0;
  let scheduled;
  const variants = (built) => {
    const list = { sql: built.combinedSql ?? built.sql, params: built.params };
    const count = { sql: built.countSql, params: built.countParams };
    return [
      { list, count, combined: Boolean(built.combinedSql), limit: built.limit },
      {
        list: buildDeadlineBoundaryQuery(list, boundary),
        count: buildDeadlineBoundaryQuery(count, boundary),
        combined: Boolean(built.combinedSql),
        limit: built.limit,
      },
    ];
  };
  const adapted = {
    buildLegacySearchWorkloadQuery(ctx, options) {
      const original = runtime.buildLegacySearchWorkloadQuery(ctx, options);
      const prior = runtime.buildLegacySearchPrefixQuery(ctx, options);
      const left = variants(original),
        right = variants(prior);
      const reference048 =
        profile === '049' ? variants(runtime.buildLegacySearch048Query(ctx, options)) : undefined;
      const key = JSON.stringify([right[0].list.sql, right[0].list.params]);
      scheduled?.add(key);
      for (let index = 0; index < 2; index++)
        registry.push({
          prior: right[index],
          original: left[index],
          reference048: reference048?.[index],
          key,
        });
      return prior;
    },
    buildTicketListQuery(ctx, options) {
      const built = runtime.buildTicketListQuery(ctx, options);
      if (profile === '049') {
        const reference = runtime.buildLegacySearch048Query(ctx, options);
        const eligible =
          organizationContext(ctx) && options.filter?.state?.length === 1 && expectsPrefix(built);
        evidence.unchanged048.push({ eligible, equal: isDeepStrictEqual(reference, built) });
      }
      for (const variant of variants(built))
        current.push({ ...variant, expectsPrefix: expectsPrefix(built) });
      return built;
    },
    withAppReadOnly(context, callback) {
      const ordinal = contextIndex++;
      return runtime.withAppReadOnly(context, async (client) => {
        const checked = new Set(),
          counts = new Map();
        const expected = new Set();
        scheduled = expected;
        const facade = {
          proof: client.proof,
          async query(sql, params = []) {
            budget();
            const result = await client.query(sql, params);
            budget();
            const entry = registry.find(
              (item) =>
                item.prior.list.sql === sql && isDeepStrictEqual(item.prior.list.params, params),
            );
            if (entry && !checked.has(entry.key)) {
              check(entry.prior.combined && !entry.original.combined, 'PREFIX_REFERENCE_REQUIRED');
              const prior = normalizeSearchCombinedRows(result.rows, entry.prior.limit);
              const rows = (await client.query(entry.original.list.sql, entry.original.list.params))
                .rows;
              budget();
              const totals = (
                await client.query(entry.original.count.sql, entry.original.count.params)
              ).rows;
              budget();
              check(totals.length === 1, 'PREFIX_RESULT_INVALID');
              const original = validateDeadlineResult(rows, totals[0].total, entry.original.limit);
              evidence.comparisons.push({
                contextIndex: ordinal,
                comparison: compareSearchResults(original, prior),
                originalStatements: 2,
                priorStatements: 1,
              });
              if (entry.reference048) {
                check(entry.reference048.combined, 'PREFIX_REFERENCE_REQUIRED');
                const reference = normalizeSearchCombinedRows(
                  (await client.query(entry.reference048.list.sql, entry.reference048.list.params))
                    .rows,
                  entry.reference048.limit,
                );
                budget();
                evidence.comparisons048.push({
                  contextIndex: ordinal,
                  comparison: compareSearchResults(original, reference),
                  statements: 1,
                });
              }
              checked.add(entry.key);
            }
            const selected = current.find(
              (item) => item.list.sql === sql && isDeepStrictEqual(item.list.params, params),
            );
            if (selected)
              counts.set(
                JSON.stringify([selected.list.sql, params]),
                selected.combined
                  ? normalizeSearchCombinedRows(result.rows, selected.limit).rows.length
                  : result.rows.length,
              );
            if (sql.startsWith(EXPLAIN)) {
              const selectedPlan = current.find(
                (item) =>
                  EXPLAIN + item.list.sql.trimStart() === sql &&
                  isDeepStrictEqual(item.list.params, params),
              );
              if (selectedPlan) {
                const count = counts.get(JSON.stringify([selectedPlan.list.sql, params]));
                check(Number.isSafeInteger(count), 'PREFIX_RESULT_INVALID');
                evidence.plans.push({
                  contextIndex: ordinal,
                  plan: summarizePrefixPlan(
                    result.rows[0]?.['QUERY PLAN'],
                    count,
                    selectedPlan.expectsPrefix,
                    profile,
                  ),
                });
              }
            }
            return result;
          },
        };
        let result;
        let coverage;
        try {
          result = await callback(facade);
        } finally {
          scheduled = undefined;
          coverage = {
            contextIndex: ordinal,
            expectedDistinctQueries: expected.size,
            comparedDistinctQueries: checked.size,
            complete:
              expected.size === checked.size && [...expected].every((key) => checked.has(key)),
          };
          evidence.coverage.push(coverage);
        }
        check(coverage.complete, 'PREFIX_REFERENCE_REQUIRED');
        return result;
      });
    },
  };
  return { runtime: adapted, evidence };
}

export function preparePrefixCases(fixture, profile = '048') {
  const staff = fixture.actors.find((actor) => actor.role === 'agent');
  const requester = fixture.actors.find((actor) => actor.role === 'requester');
  const base = prepareSearchBoundary(fixture);
  const definitions = [];
  const add = (
    name,
    {
      direction = 'asc',
      limit = 50,
      filter = {},
      own = false,
      change,
      terminal = false,
      cursorIndex,
    } = {},
  ) => {
    const boundary = structuredClone(base);
    if (change) change(boundary);
    definitions.push({
      name,
      boundary,
      ctx: contextFor(own ? requester : staff, fixture.organizationId),
      own,
      terminal,
      ...(cursorIndex === undefined ? {} : { cursorIndex }),
      options: {
        sort: { column: 'created_at', direction },
        limit,
        filter: { keyword: '合成検索境界', ...filter },
      },
    });
  };
  for (const direction of ['asc', 'desc'])
    for (const limit of [1, 50, 200]) add(`all-${direction}-${limit}`, { direction, limit });
  for (const direction of ['asc', 'desc']) add(`own-${direction}`, { direction, own: true });
  add('partial-first', {
    limit: 3,
    change: (data) => {
      data.tickets[0].search_text = '除外';
    },
  });
  add('partial-middle', {
    limit: 3,
    change: (data) => {
      data.tickets[1].search_text = '除外';
    },
  });
  add('null-keyword', {
    limit: 3,
    change: (data) => {
      data.tickets[0].search_text = null;
    },
  });
  const filters = [
    ['state', { state: ['pending'] }],
    ['kind', { kind: ['request'] }],
    ['priority', { priority: ['critical'] }],
    ['assignee', { assigneeId: base.tickets[7].assignee_id }],
    ['unassigned', { unassignedOnly: true }],
    ['group', { assigneeGroupIds: [base.tickets[4].assignee_group_id] }],
    ['ungrouped', { ungroupedOnly: true }],
    ['requester', { requesterId: base.tickets[9].requester_id }],
    ['created-from', { createdFrom: new Date('2100-01-01T00:00:00Z') }],
    ['created-to', { createdTo: new Date('2000-01-01T00:00:00Z') }],
    ['sla-missing-policy', { slaBreachedOnly: true }],
  ];
  for (const [name, filter] of filters)
    add(`filter-${name}`, {
      filter,
      change:
        name === 'kind'
          ? (data) => {
              data.tickets[7].kind = 'request';
            }
          : name === 'ungrouped'
            ? (data) => {
                data.tickets[0].assignee_group_id = null;
              }
            : name === 'sla-missing-policy'
              ? (data) => {
                  data.tickets[1].sla_elapsed_seconds = 61;
                  const paused = data.expected.find((row) => row.id === data.tickets[1].id);
                  paused.remainingSeconds = -1;
                  paused.elapsed = 61;
                }
              : undefined,
    });
  add('empty-prefix-zero', {
    change: (data) => {
      data.tickets = [];
      data.expected = [];
    },
  });
  add('empty-prefix-terminal', { terminal: true });
  if (profile === '049') {
    const states = [
      'new',
      'assigned',
      'in_progress',
      'pending',
      'resolved',
      'closed',
      'cancelled',
      'merged',
    ];
    const gaps = (state) => (data) =>
      data.tickets.forEach((ticket, index) => {
        ticket.state = index % 3 === 2 ? state : state === 'closed' ? 'new' : 'closed';
      });
    for (const state of states)
      add(`state-single-${state}`, {
        limit: 3,
        filter: { state: [state] },
        change: gaps(state),
      });
    for (const direction of ['asc', 'desc'])
      for (const limit of [1, 50, 200])
        add(`state-gaps-${direction}-${limit}`, {
          direction,
          limit,
          filter: { state: ['new'] },
          change: gaps('new'),
        });
    add('state-multiple', { limit: 3, filter: { state: ['new', 'pending'] }, change: gaps('new') });
    add('state-duplicate', { limit: 3, filter: { state: ['new', 'new'] }, change: gaps('new') });
    add('state-own', { limit: 3, own: true, filter: { state: ['new'] }, change: gaps('new') });
    add('state-other-filter', {
      limit: 3,
      filter: { state: ['new'], priority: ['critical'] },
      change: gaps('new'),
    });
    add('state-null-keyword', {
      limit: 3,
      filter: { state: ['new'] },
      change: (data) => {
        gaps('new')(data);
        data.tickets[2].search_text = null;
      },
    });
    add('state-empty', {
      filter: { state: ['new'] },
      change: (data) => {
        data.tickets.forEach((ticket) => {
          ticket.state = 'closed';
        });
      },
    });
    add('state-terminal', { filter: { state: ['new'] }, terminal: true, change: gaps('new') });
    add('state-after-cursor', {
      limit: 1,
      filter: { state: ['new'] },
      cursorIndex: 3,
      change: gaps('new'),
    });
  }
  return definitions;
}

/** Independent finite fixture oracle; all fixture timestamps are the same transaction-relative hour. */
export function prefixBoundaryExpectation(definition, createdAt, profile = '048') {
  const { boundary, options, ctx, own } = definition;
  const f = options.filter ?? {};
  const authorized = boundary.tickets.filter(
    (ticket) =>
      ticket.organization_id === ctx.organizationId &&
      (!own || ticket.requester_id === ctx.principal.userId),
  );
  const matches = (ticket) => {
    const expected = boundary.expected.find((item) => item.id === ticket.id);
    return (
      typeof ticket.search_text === 'string' &&
      ticket.search_text.toLowerCase().includes((f.keyword ?? '').trim().toLowerCase()) &&
      (!f.state?.length || f.state.includes(ticket.state)) &&
      (!f.kind?.length || f.kind.includes(ticket.kind)) &&
      (!f.priority?.length || f.priority.includes(ticket.priority)) &&
      (f.unassignedOnly
        ? ticket.assignee_id === null
        : f.assigneeId === undefined || ticket.assignee_id === f.assigneeId) &&
      (!f.requesterId || ticket.requester_id === f.requesterId) &&
      (!f.assigneeGroupIds?.length || f.assigneeGroupIds.includes(ticket.assignee_group_id)) &&
      (!f.ungroupedOnly || ticket.assignee_group_id === null) &&
      (!f.slaBreachedOnly ||
        (expected?.remainingSeconds !== null && expected?.remainingSeconds < 0)) &&
      (!f.createdFrom || new Date(createdAt) >= f.createdFrom) &&
      (!f.createdTo || new Date(createdAt) <= f.createdTo)
    );
  };
  const direction = options.sort.direction;
  const order = (rows) =>
    [...rows].sort((a, b) =>
      direction === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id),
    );
  const afterCursor = (ticket) =>
    !options.cursor ||
    (direction === 'asc' ? ticket.id > options.cursor.id : ticket.id < options.cursor.id);
  const statePrefix = profile === '049' && !own && f.state?.length === 1;
  const prefix = order(authorized)
    .filter((ticket) => !statePrefix || ticket.state === f.state[0])
    .filter(afterCursor)
    .slice(0, options.limit);
  const eligible = authorized.filter(matches);
  return {
    total: eligible.length,
    ids: order(eligible)
      .filter(afterCursor)
      .slice(0, options.limit)
      .map((ticket) => ticket.id),
    usable: prefix.every(matches),
    prefixRows: prefix.length,
  };
}

const wrapBuilt = (built, boundary) => {
  const list = buildDeadlineBoundaryQuery({ sql: built.sql, params: built.params }, boundary);
  const count = buildDeadlineBoundaryQuery(
    { sql: built.countSql, params: built.countParams },
    boundary,
  );
  const combined = built.combinedSql
    ? buildDeadlineBoundaryQuery({ sql: built.combinedSql, params: built.params }, boundary)
    : undefined;
  return {
    ...built,
    sql: list.sql,
    params: combined?.params ?? list.params,
    countSql: count.sql,
    countParams: count.params,
    ...(combined ? { combinedSql: combined.sql } : {}),
  };
};
const builders = (runtime, profile = '048') => ({
  original046: runtime.buildLegacySearchWorkloadQuery,
  prior047: runtime.buildLegacySearchPrefixQuery,
  ...(profile === '049' ? { prior048: runtime.buildLegacySearch048Query } : {}),
  candidate: runtime.buildTicketListQuery,
});

export function assessPrefixCosts(diagnostics) {
  const terms = diagnostics.map((term) => {
    const averages = Object.fromEntries(
      ['original046', 'prior047', 'candidate'].map((side) => [
        side,
        term.samples.reduce(
          (sum, sample) =>
            sum +
            sample[side].statements.reduce(
              (time, statement) => time + statement.work.plan.executionMs,
              0,
            ),
          0,
        ) / term.samples.length,
      ]),
    );
    const withinBounds =
      term.name === 'short'
        ? averages.candidate < averages.prior047 &&
          averages.candidate <= averages.original046 * 1.05
        : averages.candidate <= averages.prior047 * 1.05;
    return {
      name: term.name,
      averagesMs: averages,
      withinBounds,
      versus046: averages.original046 === 0 ? null : averages.candidate / averages.original046,
      versus047: averages.prior047 === 0 ? null : averages.candidate / averages.prior047,
    };
  });
  return {
    terms,
    meetsSqlCriteria: terms.length === 4 && terms.every((term) => term.withinBounds),
    adoptionEstablished: false,
    interpretation: 'Predeclared practical bounds; not statistical equivalence or HTTP acceptance.',
  };
}

/** Two filter observations are separate from the preregistered four-term bounds. */
export function assessPrefixFilters(diagnostics) {
  const terms = assessPrefixCosts(diagnostics).terms.map((term, index) => {
    const observations = diagnostics[index].samples.map((sample) => {
      const total = (side) =>
        sample[side].statements.reduce(
          (sum, statement) => sum + statement.work.plan.executionMs,
          0,
        );
      const original046Ms = total('original046'),
        candidateMs = total('candidate');
      return {
        repetition: sample.repetition,
        original046Ms,
        candidateMs,
        deltaMs: candidateMs - original046Ms,
        over046ByFivePercent: candidateMs > original046Ms * 1.05,
      };
    });
    const { withinBounds: _fourTermBound, ...values } = term;
    return {
      ...values,
      observations,
      repetitionsOver046ByFivePercent: observations.filter((item) => item.over046ByFivePercent)
        .length,
    };
  });
  const state = terms.find((term) => term.name === 'short-new');
  return {
    terms,
    requiresAdoptionHold: !state || state.repetitionsOver046ByFivePercent >= 2,
    repeatedRegressionDefinition:
      'More than 5% above 046 in at least two of four state-filter repetitions.',
    adoptionEstablished: false,
  };
}

/** Closed WP049 gates; the four primary terms and state observations remain distinct. */
export function assessStatePrefixCosts(diagnostics, filterDiagnostics) {
  const variants = ['original046', 'prior047', 'prior048', 'candidate'];
  const names = [
    'short',
    'wide',
    'rare',
    'zero',
    'short-new',
    'short-own',
    'short-assigned',
    'rare-state',
    'zero-new',
  ];
  const input = [...diagnostics, ...filterDiagnostics];
  check(
    input.length === names.length &&
      new Set(input.map((term) => term.name)).size === names.length &&
      names.every((name) => input.some((term) => term.name === name)),
    'PREFIX_RESULT_INVALID',
  );
  const terms = input.map((term) => {
    check(term.samples.length === 4, 'PREFIX_RESULT_INVALID');
    const observations = term.samples.map((sample) => {
      const executionMs = Object.fromEntries(
        variants.map((side) => {
          const statements = sample[side]?.statements;
          check(
            statements?.length > 0 &&
              statements.every(
                (statement) =>
                  Number.isFinite(statement.work?.plan?.executionMs) &&
                  statement.work.plan.executionMs >= 0,
              ),
            'PREFIX_RESULT_INVALID',
          );
          return [
            side,
            statements.reduce((sum, statement) => sum + statement.work.plan.executionMs, 0),
          ];
        }),
      );
      return {
        repetition: sample.repetition,
        executionMs,
        delta046Ms: executionMs.candidate - executionMs.original046,
        delta048Ms: executionMs.candidate - executionMs.prior048,
        over048ByFivePercent: executionMs.candidate > executionMs.prior048 * 1.05,
      };
    });
    const averagesMs = Object.fromEntries(
      variants.map((side) => [
        side,
        observations.reduce((sum, item) => sum + item.executionMs[side], 0) / observations.length,
      ]),
    );
    return {
      name: term.name,
      averagesMs,
      observations,
      versus046:
        averagesMs.original046 === 0 ? null : averagesMs.candidate / averagesMs.original046,
      versus047: averagesMs.prior047 === 0 ? null : averagesMs.candidate / averagesMs.prior047,
      versus048: averagesMs.prior048 === 0 ? null : averagesMs.candidate / averagesMs.prior048,
      delta046Ms: averagesMs.candidate - averagesMs.original046,
      delta048Ms: averagesMs.candidate - averagesMs.prior048,
      withinBounds:
        term.name === 'short-new'
          ? averagesMs.candidate < averagesMs.prior048 &&
            averagesMs.candidate <= averagesMs.original046 * 1.05
          : averagesMs.candidate <= averagesMs.prior048 * 1.05,
      repetitionsOver048ByFivePercent: observations.filter((item) => item.over048ByFivePercent)
        .length,
    };
  });
  const state = terms.find((term) => term.name === 'short-new');
  const primary = terms.filter((term) => ['short', 'wide', 'rare', 'zero'].includes(term.name));
  const filters = terms.filter((term) => !primary.includes(term));
  return {
    primary: {
      terms: primary,
      meetsSqlCriteria: primary.every((term) => term.withinBounds) && state.withinBounds,
      stateWithinBounds: state.withinBounds,
      adoptionEstablished: false,
      interpretation:
        'Predeclared practical SQL bounds against fixed 046/048; not statistical equivalence or HTTP acceptance.',
    },
    filters: {
      terms: filters,
      requiresAdoptionHold:
        !state.withinBounds ||
        filters.some(
          (term) =>
            ['short-assigned', 'rare-state', 'zero-new'].includes(term.name) &&
            term.repetitionsOver048ByFivePercent >= 2,
        ),
      repeatedRegressionDefinition:
        'More than 5% above 048 in at least two of four additional state-filter repetitions; own observations retain absolute differences.',
      adoptionEstablished: false,
    },
  };
}

export function samplePrefixPlansValid(sample) {
  return (
    Boolean(sample?.statements?.length) &&
    sample.statements.every((statement) => {
      const prefix = statement.work?.prefix;
      return (
        statement.completed === true &&
        prefix?.shapeMatchesExpectation === true &&
        (prefix.expectedPrefix === true
          ? ['prefix', 'fallback'].includes(prefix.branch)
          : prefix.expectedPrefix === false && prefix.branch === 'absent')
      );
    })
  );
}

export function analyzeSearchPrefix(runtime, fixture, signal) {
  return analyzePrefix(runtime, fixture, signal, '048');
}

export function analyzeSearchStatePrefix(runtime, fixture, signal) {
  return analyzePrefix(runtime, fixture, signal, '049');
}

async function analyzePrefix(runtime, fixture, signal, profile) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    cases: [],
    readOnlyContexts: [],
    unchangedSorts: [],
    reference046Comparisons: [],
    semanticBranchPlans: [],
    prefixCases: [],
    diagnostics: [],
    filterDiagnostics: [],
  };
  const budget = () => {
    check(!signal?.aborted, 'PREFIX_ABORTED');
    check(performance.now() - started < 360_000, 'PREFIX_TIME_LIMIT');
  };
  try {
    budget();
    check(
      runtime &&
        [
          'withAppReadOnly',
          'buildLegacySearchWorkloadQuery',
          'buildLegacySearchPrefixQuery',
          'buildTicketListQuery',
          ...(profile === '049' ? ['buildLegacySearch048Query'] : []),
        ].every((key) => typeof runtime[key] === 'function'),
      'PREFIX_RUNTIME_REQUIRED',
    );
    const references = createPrefixReferenceRuntime(runtime, fixture, budget, profile);
    report.reference046Comparisons = references.evidence.comparisons;
    report.referenceCoverage = references.evidence.coverage;
    report.semanticBranchPlans = references.evidence.plans;
    if (profile === '049') {
      report.reference048Comparisons = references.evidence.comparisons048;
      report.unchanged048 = references.evidence.unchanged048;
    }
    const adapted = createSearchSemanticRuntime(references.runtime, fixture, budget);
    const semantic = await runSearchAnalysis({ runtime: adapted.runtime, fixture, signal });
    report.cases = semantic.cases.map((item) => {
      const rename = ({ countPlan, ...side }) => ({ ...side, referenceCountPlan: countPlan });
      return { ...item, legacy: rename(item.legacy), candidate: rename(item.candidate) };
    });
    report.readOnlyContexts.push(...semantic.readOnlyContexts);
    report.unchangedSorts = semantic.unchangedSorts;
    report.semanticExecution = {
      ...adapted.stats,
      legacyIs047: true,
      additionalSameSnapshotReferenceIs046: true,
      referenceCountPlansAreSeparateDiagnostics: true,
      ...(profile === '049' ? { additionalSameSnapshotReferenceIs048: true } : {}),
    };
    if (semantic.failureCode) report.semanticFailureCode = semantic.failureCode;
    report.expectedReferenceComparisons = references.evidence.coverage.reduce(
      (sum, item) => sum + item.expectedDistinctQueries,
      0,
    );
    check(
      semantic.completed &&
        semantic.equivalent &&
        references.evidence.coverage.filter((item) => item.expectedDistinctQueries > 0).length ===
          semantic.cases.length &&
        references.evidence.coverage.every((item) => item.complete) &&
        report.reference046Comparisons.length === report.expectedReferenceComparisons &&
        report.reference046Comparisons.every((item) => item.comparison.equal) &&
        (profile !== '049' ||
          (report.reference048Comparisons.length === report.expectedReferenceComparisons &&
            report.reference048Comparisons.every((item) => item.comparison.equal) &&
            report.unchanged048.every((item) => item.eligible || item.equal))) &&
        report.semanticBranchPlans.every((item) => item.plan.shapeMatchesExpectation),
      'PREFIX_SEMANTICS_FAILED',
    );
    const build = builders(runtime, profile);
    const sides = Object.keys(build);
    const definitions = preparePrefixCases(fixture, profile);
    for (const definition of definitions) {
      budget();
      const item = {
        name: definition.name,
        mode: 'synthetic-cte',
        rlsEvidence: false,
        completed: false,
        sides: {},
      };
      report.prefixCases.push(item);
      await runtime.withAppReadOnly(
        { organizationId: definition.ctx.organizationId, actorId: definition.ctx.principal.userId },
        async (client) => {
          item.proof = sanitizeReadOnlyProof(client.proof);
          report.readOnlyContexts.push({ name: `prefix-${definition.name}`, proof: item.proof });
          const createdAt = (await client.query("SELECT (now()-interval '1 hour')::text AS stamp"))
            .rows[0]?.stamp;
          check(typeof createdAt === 'string', 'PREFIX_RESULT_INVALID');
          if (definition.terminal || definition.cursorIndex !== undefined) {
            const all = definition.boundary.tickets.filter(
              (ticket) => ticket.organization_id === definition.ctx.organizationId,
            );
            definition.options.cursor = {
              createdAt,
              id: all
                .map((ticket) => ticket.id)
                .sort()
                .at(
                  definition.cursorIndex ?? (definition.options.sort.direction === 'asc' ? -1 : 0),
                ),
            };
          }
          const expected = prefixBoundaryExpectation(definition, createdAt);
          item.expected = {
            total: expected.total,
            rows: expected.ids.length,
            usable: expected.usable,
            prefixRows: expected.prefixRows,
          };
          const results = {};
          for (const side of sides) {
            item.sides[side] = {};
            const query = wrapBuilt(
              build[side](definition.ctx, definition.options),
              definition.boundary,
            );
            results[side] = await measureSearchStatements({
              client,
              built: query,
              order: ['list', 'count'],
              sample: item.sides[side],
              budget,
              summarizePlan: summarize(query, profile),
            });
            if (profile === '049') {
              const sideExpected = prefixBoundaryExpectation(
                definition,
                createdAt,
                side === 'candidate' && usesStatePrefix(query) ? '049' : '048',
              );
              const prefix = item.sides[side].statements[0].work.prefix;
              item.sides[side].branchMatchesExpected =
                prefix.shapeMatchesExpectation &&
                (prefix.expectedPrefix
                  ? prefix.branch === (sideExpected.usable ? 'prefix' : 'fallback')
                  : prefix.branch === 'absent');
              if (side === 'candidate') {
                item.expected.usable = sideExpected.usable;
                item.expected.prefixRows = sideExpected.prefixRows;
                item.statePrefixEligible =
                  !definition.own && definition.options.filter.state?.length === 1;
                item.statePrefixPresent = usesStatePrefix(query);
                item.unchangedFrom048 =
                  item.statePrefixEligible ||
                  isDeepStrictEqual(
                    query,
                    wrapBuilt(
                      build.prior048(definition.ctx, definition.options),
                      definition.boundary,
                    ),
                  );
              }
            }
          }
          item.comparisons = {
            prior: compareSearchResults(results.original046, results.prior047),
            candidate: compareSearchResults(results.original046, results.candidate),
            ...(profile === '049'
              ? { prior048: compareSearchResults(results.original046, results.prior048) }
              : {}),
          };
          item.expectedValues = Object.values(results).every(
            (result) =>
              result.total === expected.total &&
              isDeepStrictEqual(
                result.rows.map((row) => row.id),
                expected.ids,
              ),
          );
          const prefix = item.sides.candidate.statements[0].work.prefix;
          item.branchApplicable = prefix.expectedPrefix === true;
          item.branchMatchesExpected =
            prefix.shapeMatchesExpectation &&
            (prefix.expectedPrefix
              ? prefix.branch === (item.expected.usable ? 'prefix' : 'fallback')
              : prefix.branch === 'absent');
          item.completed = true;
        },
      );
    }
    const discovery = await discoverSearchTerms(runtime, fixture, signal);
    report.readOnlyContexts.push({
      name: 'prefix-term-discovery',
      proof: sanitizeReadOnlyProof(discovery.proof),
    });
    const actor = fixture.actors.find((value) => value.role === 'agent');
    const requester = fixture.actors.find((value) => value.role === 'requester');
    const short = discovery.terms.find((term) => term.key === 'short')?.keyword;
    check(typeof short === 'string' && requester, 'PREFIX_RESULT_INVALID');
    let rareState;
    if (profile === '049')
      await runtime.withAppReadOnly(
        { organizationId: fixture.organizationId, actorId: actor.userId },
        async (client) => {
          report.readOnlyContexts.push({
            name: 'state-rare-discovery',
            proof: sanitizeReadOnlyProof(client.proof),
          });
          const result = await client.query(
            'SELECT state FROM ticket WHERE organization_id=$1 AND id=$2',
            [fixture.organizationId, actor.ticketId],
          );
          budget();
          check(
            result.rows.length === 1 &&
              [
                'new',
                'assigned',
                'in_progress',
                'pending',
                'resolved',
                'closed',
                'cancelled',
                'merged',
              ].includes(result.rows[0].state),
            'PREFIX_RESULT_INVALID',
          );
          rareState = result.rows[0].state;
        },
      );
    const terms = [
      ...discovery.terms.map((term) => ({ ...term, actor })),
      { key: 'short-new', keyword: short, actor, filter: { state: ['new'] }, additional: true },
      { key: 'short-own', keyword: short, actor: requester, filter: {}, additional: true },
      ...(profile === '049'
        ? [
            {
              key: 'short-assigned',
              keyword: short,
              actor,
              filter: { state: ['assigned'] },
              additional: true,
            },
            {
              key: 'rare-state',
              keyword: discovery.terms.find((term) => term.key === 'rare').keyword,
              actor,
              filter: { state: [rareState] },
              additional: true,
            },
            {
              key: 'zero-new',
              keyword: discovery.terms.find((term) => term.key === 'zero').keyword,
              actor,
              filter: { state: ['new'] },
              additional: true,
            },
          ]
        : []),
    ];
    for (const term of terms) {
      const ctx = contextFor(term.actor, fixture.organizationId);
      const item = { name: term.key, completed: false, samples: [] };
      (term.additional ? report.filterDiagnostics : report.diagnostics).push(item);
      await runtime.withAppReadOnly(
        { organizationId: fixture.organizationId, actorId: term.actor.userId },
        async (client) => {
          item.proof = sanitizeReadOnlyProof(client.proof);
          report.readOnlyContexts.push({ name: `prefix-cost-${term.key}`, proof: item.proof });
          const options = {
            sort: { column: 'created_at', direction: 'desc' },
            filter: { keyword: term.keyword, ...term.filter },
            limit: 50,
          };
          for (let repetition = 0; repetition < 4; repetition++) {
            const order = repetition % 2 ? [...sides].reverse() : [...sides];
            const sample = { repetition: repetition + 1, order, completed: false };
            item.samples.push(sample);
            const results = {};
            for (const side of order) {
              sample[side] = {};
              const query = build[side](ctx, options);
              results[side] = await measureSearchStatements({
                client,
                built: query,
                order: repetition % 2 ? ['count', 'list'] : ['list', 'count'],
                sample: sample[side],
                budget,
                summarizePlan: summarize(query, profile),
              });
            }
            sample.comparisons = {
              prior: compareSearchResults(results.original046, results.prior047),
              candidate: compareSearchResults(results.original046, results.candidate),
              ...(profile === '049'
                ? { prior048: compareSearchResults(results.original046, results.prior048) }
                : {}),
            };
            sample.expectedPopulation = ['rare', 'rare-state'].includes(term.key)
              ? results.original046.total === 1
              : ['zero', 'zero-new'].includes(term.key)
                ? results.original046.total === 0
                : results.original046.total > 0;
            sample.completed = true;
          }
          item.completed = true;
        },
      );
    }
    report.equivalent =
      report.prefixCases.length === definitions.length &&
      report.prefixCases.every(
        (item) =>
          item.completed &&
          item.expectedValues &&
          item.branchMatchesExpected &&
          item.comparisons.prior.equal &&
          item.comparisons.candidate.equal &&
          (profile !== '049' ||
            (item.comparisons.prior048.equal &&
              item.unchangedFrom048 &&
              sides.every((side) => item.sides[side].branchMatchesExpected))),
      ) &&
      report.diagnostics.length === 4 &&
      report.filterDiagnostics.length === (profile === '049' ? 5 : 2) &&
      [...report.diagnostics, ...report.filterDiagnostics].every(
        (item) =>
          item.completed &&
          item.samples.length === 4 &&
          item.samples.every(
            (sample) =>
              sample.completed &&
              sample.expectedPopulation &&
              sample.comparisons.prior.equal &&
              sample.comparisons.candidate.equal &&
              (profile !== '049' || sample.comparisons.prior048.equal) &&
              sides.every((side) => samplePrefixPlansValid(sample[side])),
          ),
      );
    const costPlans = report.diagnostics.flatMap((item) =>
      item.samples.map((sample) => ({
        name: item.name,
        rows: sample.candidate.rows,
        plan: sample.candidate.statements[0].work.prefix,
      })),
    );
    report.optimization = {
      prefixPresent: costPlans.every(({ plan }) => plan.present),
      branchExclusive: costPlans.every(({ plan }) => ['prefix', 'fallback'].includes(plan.branch)),
      shortUsesPrefix: costPlans
        .filter(({ name }) => name === 'short')
        .every(({ plan }) => plan.branch === 'prefix'),
      shortTempZero: costPlans
        .filter(({ name }) => name === 'short')
        .every(({ plan }) => plan.tempReadBlocks === 0 && plan.tempWrittenBlocks === 0),
      probeBounded: costPlans.every(({ plan }) => plan.probeRows <= 50),
      pageLookupsBounded: costPlans.every(
        ({ plan }) => plan.pageUniqueLookupsBounded && plan.displayLookupsBounded,
      ),
      syntheticBranchesVerified: report.prefixCases.every(
        (item) => item.branchApplicable && item.branchMatchesExpected,
      ),
    };
    report.optimization.confirmed =
      report.equivalent && Object.values(report.optimization).every(Boolean);
    if (profile === '049') {
      const statePlans = report.filterDiagnostics
        .find((term) => term.name === 'short-new')
        .samples.map((sample) => sample.candidate.statements[0].work.prefix);
      report.optimization.stateIndexProbe = statePlans.every(
        (plan) =>
          plan.stateProbe?.orderedStateIndex &&
          plan.stateProbe.visitsBounded &&
          plan.probeRows <= 50,
      );
      report.optimization.stateShortCircuited = statePlans.every(
        (plan) =>
          plan.branch === 'prefix' && plan.matchedLoops === 0 && plan.directCountLoops === 1,
      );
      report.optimization.stateTempZero = statePlans.every(
        (plan) => plan.tempReadBlocks === 0 && plan.tempWrittenBlocks === 0,
      );
      report.optimization.statePageBounded = statePlans.every(
        (plan) => plan.pageUniqueLookupsBounded && plan.displayLookupsBounded,
      );
      report.optimization.confirmed =
        report.equivalent &&
        Object.entries(report.optimization)
          .filter(([key]) => key !== 'confirmed')
          .every(([, value]) => value);
      const assessment = assessStatePrefixCosts(report.diagnostics, report.filterDiagnostics);
      report.assessment = assessment.primary;
      report.filterAssessment = assessment.filters;
    } else {
      report.assessment = assessPrefixCosts(report.diagnostics);
      report.filterAssessment = assessPrefixFilters(report.filterDiagnostics);
    }
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted
      ? 'PREFIX_ABORTED'
      : failures.has(error?.message)
        ? error.message
        : 'PREFIX_ANALYSIS_FAILED';
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
