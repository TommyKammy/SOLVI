import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';
import { normalizeSearchCombinedRows } from './search-cost-analysis.mjs';
import { compareSearchResults } from './search-analysis.mjs';
import { summarizePrefixPlan } from './search-prefix-analysis.mjs';
import { discoverSearchTerms } from './search-capacity.mjs';

const check = (value, code) => {
  if (!value) throw new Error(code);
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const FAILURES = new Set([
  'REPRO_ABORTED',
  'REPRO_TIME_LIMIT',
  'REPRO_RUNTIME_REQUIRED',
  'REPRO_BINDING_INVALID',
  'REPRO_ORACLE_FAILED',
  'REPRO_PROTOCOL_FAILED',
  'REPRO_PLAN_INVALID',
  'REPRO_RESOURCE_INVALID',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
]);
const CONDITIONS = ['rare', 'zero', 'rare-state', 'zero-new', 'short-new'];
const CPU = [
  'usage_usec',
  'user_usec',
  'system_usec',
  'nr_periods',
  'nr_throttled',
  'throttled_usec',
];
const IO = ['rbytes', 'wbytes', 'rios', 'wios'];
const UNAVAILABLE = new Set([
  'CGROUP_UNAVAILABLE',
  'CGROUP_READ_TIMEOUT',
  'CGROUP_READ_FAILED',
  'CGROUP_PAYLOAD_INVALID',
  'CGROUP_OUTPUT_TOO_LARGE',
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
const RELATIONS = new Set([
  'ticket',
  'app_user',
  'sla_policy',
  'assignment_group',
  'role_binding',
  'role',
  'organization',
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

export function searchReproSchedule(replica) {
  check(replica === 1 || replica === 2, 'REPRO_PROTOCOL_FAILED');
  return {
    conditions: replica === 1 ? [...CONDITIONS] : [...CONDITIONS].reverse(),
    phases:
      replica === 1
        ? ['plain', 'explain-off', 'explain-on']
        : ['plain', 'explain-on', 'explain-off'],
    warmupPairs: 2,
    measuredPairs: { plain: 24, 'explain-off': 8, 'explain-on': 8 },
    orders: replica === 1 ? ['AB', 'BA', 'BA', 'AB'] : ['BA', 'AB', 'AB', 'BA'],
  };
}

const paramType = (value, depth = 0) => {
  check(depth < 8, 'REPRO_BINDING_INVALID');
  if (value === null) return 'null';
  if (value instanceof Date) {
    check(Number.isFinite(value.getTime()), 'REPRO_BINDING_INVALID');
    return 'date';
  }
  if (Array.isArray(value)) {
    check(value.length <= 64, 'REPRO_BINDING_INVALID');
    return { type: 'array', items: value.map((item) => paramType(item, depth + 1)) };
  }
  check(
    ['string', 'number', 'boolean', 'undefined'].includes(typeof value) &&
      (typeof value !== 'number' || Number.isFinite(value)),
    'REPRO_BINDING_INVALID',
  );
  return typeof value;
};

export function searchReproBinding(a, b, current, negativeControl) {
  for (const query of [a, b, current])
    check(
      query &&
        typeof query.combinedSql === 'string' &&
        /^\s*SELECT\b/.test(query.combinedSql) &&
        !query.combinedSql.includes(';') &&
        query.limit === 50 &&
        Array.isArray(query.params) &&
        query.params.length <= 32,
      'REPRO_BINDING_INVALID',
    );
  const result = {
    aSqlSha256: hash(a.combinedSql),
    bSqlSha256: hash(b.combinedSql),
    sqlIdentical: a.combinedSql === b.combinedSql,
    typedParamsEqual: isDeepStrictEqual(a.params, b.params),
    paramTypes: a.params.map((value) => paramType(value)),
    currentMatchesFixed049: isDeepStrictEqual(b, current),
    negativeControl,
  };
  check(
    result.typedParamsEqual &&
      result.currentMatchesFixed049 &&
      result.sqlIdentical === negativeControl,
    'REPRO_BINDING_INVALID',
  );
  return result;
}

/** Only known identifiers are retained. Runtime values and all predicate text are omitted. */
export function summarizeSearchReproPlan(document, returnedRows) {
  const sanitized = sanitizeExplain(document);
  const node = (raw, clean) => {
    const value = { nodeType: clean.nodeType };
    for (const [field, target, allowed] of [
      ['Index Name', 'indexName', INDEXES],
      ['Relation Name', 'relationName', RELATIONS],
      ['CTE Name', 'cteName', CTES],
      ['Join Type', 'joinType', new Set(['Inner', 'Left', 'Right', 'Full', 'Semi', 'Anti'])],
      [
        'Parent Relationship',
        'relationship',
        new Set(['Outer', 'Inner', 'InitPlan', 'SubPlan', 'Member', 'Subquery']),
      ],
      ['Scan Direction', 'scanDirection', new Set(['Forward', 'Backward', 'NoMovement'])],
      ['Strategy', 'strategy', new Set(['Plain', 'Sorted', 'Hashed', 'Mixed'])],
    ])
      if (raw[field] !== undefined) {
        check(allowed.has(raw[field]), 'REPRO_PLAN_INVALID');
        value[target] = raw[field];
      }
    if (raw['Subplan Name'] !== undefined) {
      const label = raw['Subplan Name'];
      if (typeof label === 'string' && label.startsWith('CTE ')) {
        check(CTES.has(label.slice(4)), 'REPRO_PLAN_INVALID');
        value.cteProducer = label.slice(4);
      } else {
        check(
          typeof label === 'string' && /^(InitPlan|SubPlan) \d+( \(returns \$\d+\))?$/.test(label),
          'REPRO_PLAN_INVALID',
        );
        value.subplan = label.startsWith('InitPlan') ? 'InitPlan' : 'SubPlan';
      }
    }
    if (raw.Plans)
      value.children = raw.Plans.map((child, index) => node(child, clean.children[index]));
    return value;
  };
  const structure = node(document[0].Plan, sanitized.plan);
  const prefix = summarizePrefixPlan(document, returnedRows, true, '049');
  check(
    prefix.shapeMatchesExpectation && ['prefix', 'fallback'].includes(prefix.branch),
    'REPRO_PLAN_INVALID',
  );
  const aggregate = (scans) => ({
    scans: scans.length,
    loops: scans.reduce((sum, scan) => sum + scan.loops, 0),
    returnedRows: scans.reduce((sum, scan) => sum + scan.returnedRows, 0),
    visitedRows: scans.reduce((sum, scan) => sum + scan.visitedRows, 0),
    removedRows: scans.reduce((sum, scan) => sum + scan.visitedRows - scan.returnedRows, 0),
  });
  const rootBuffers = {};
  for (const family of ['Shared', 'Local', 'Temp'])
    for (const kind of family === 'Temp'
      ? ['Read', 'Written']
      : ['Hit', 'Read', 'Dirtied', 'Written']) {
      const raw = document[0].Plan[`${family} ${kind} Blocks`];
      check(raw === undefined || counter(raw), 'REPRO_PLAN_INVALID');
      rootBuffers[family.toLowerCase() + kind + 'Blocks'] = raw ?? 0;
    }
  return {
    structure,
    structureSha256: hash(JSON.stringify(structure)),
    planningMs: sanitized.planningMs,
    executionMs: sanitized.executionMs,
    work: {
      branch: prefix.branch,
      rootBuffers,
      probe: aggregate(prefix.ctes.probe_keys.ticketScans),
      evaluation: aggregate(prefix.ctes.probe_evaluation.ticketScans),
      matched: aggregate(prefix.ctes.matched.ticketScans),
      count: aggregate(prefix.ctes.counted.ticketScans),
      page: aggregate(prefix.pageTicketScans),
      probeRows: prefix.probeRows,
      matchedLoops: prefix.matchedLoops,
      directCountLoops: prefix.directCountLoops,
      stateIndexProbe: prefix.stateProbe.orderedStateIndex,
      pageLookupsBounded: prefix.pageUniqueLookupsBounded && prefix.displayLookupsBounded,
    },
  };
}

export function sanitizeSearchReproResources(value) {
  check(
    value &&
      typeof value.available === 'boolean' &&
      typeof value.capturedAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.capturedAt) &&
      Number.isFinite(Date.parse(value.capturedAt)) &&
      nonnegative(value.durationMs),
    'REPRO_RESOURCE_INVALID',
  );
  const base = {
    available: value.available,
    capturedAt: value.capturedAt,
    durationMs: value.durationMs,
  };
  if (!value.available)
    return {
      ...base,
      reason: UNAVAILABLE.has(value.reason) ? value.reason : 'RESOURCE_UNAVAILABLE',
    };
  check(value.source === 'cgroup-v2' && counter(value.devices), 'REPRO_RESOURCE_INVALID');
  const cpu = {},
    io = {};
  for (const field of CPU) {
    check(
      counter(value.cpu?.[field]) || (CPU.indexOf(field) >= 3 && value.cpu?.[field] === null),
      'REPRO_RESOURCE_INVALID',
    );
    cpu[field] = value.cpu[field];
  }
  for (const field of IO) {
    check(counter(value.io?.[field]), 'REPRO_RESOURCE_INVALID');
    io[field] = value.io[field];
  }
  return { ...base, source: 'cgroup-v2', cpu, io, devices: value.devices };
}

export function searchReproResourceDelta(before, after) {
  if (!before.available || !after.available)
    return { available: false, reason: 'RESOURCE_UNAVAILABLE' };
  const elapsedMs = Date.parse(after.capturedAt) - Date.parse(before.capturedAt);
  let unavailable = false,
    regression = false;
  const difference = (a, b, fields) =>
    Object.fromEntries(
      fields.map((key) => {
        if (a[key] === null || b[key] === null) {
          unavailable = true;
          return [key, null];
        }
        const delta = b[key] - a[key];
        if (delta < 0) {
          regression = true;
          return [key, null];
        }
        return [key, delta];
      }),
    );
  const cpu = difference(before.cpu, after.cpu, CPU),
    io = difference(before.io, after.io, IO);
  const reason =
    regression || elapsedMs < 0
      ? 'COUNTER_REGRESSION'
      : before.devices !== after.devices
        ? 'DEVICE_SET_CHANGED'
        : unavailable
          ? 'COUNTER_UNAVAILABLE'
          : undefined;
  return {
    available: reason === undefined,
    ...(reason ? { reason } : {}),
    elapsedMs: elapsedMs < 0 ? null : elapsedMs,
    cpu,
    io,
  };
}

const describe = (values) => {
  check(values.length > 0 && values.every(Number.isFinite), 'REPRO_PROTOCOL_FAILED');
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
};

export function summarizeSearchReproPairs(samples, phase) {
  check(
    ['plain', 'explain-off', 'explain-on'].includes(phase) &&
      samples.length > 0 &&
      samples.every((sample) => sample.completed),
    'REPRO_PROTOCOL_FAILED',
  );
  const field = phase === 'plain' ? 'wallMs' : 'executionMs';
  const group = (items) => {
    if (!items.length) return null;
    const a = items.map((sample) => sample.A[field]),
      b = items.map((sample) => sample.B[field]);
    check([...a, ...b].every(nonnegative), 'REPRO_PROTOCOL_FAILED');
    const ratios = a.flatMap((value, index) => (value === 0 ? [] : [b[index] / value]));
    const aStats = describe(a),
      bStats = describe(b);
    return {
      A: aStats,
      B: bStats,
      pairedDeltaMs: describe(a.map((value, index) => b[index] - value)),
      pairedRatio: ratios.length ? describe(ratios) : null,
      ratioUnavailable: a.filter((value) => value === 0).length,
      ratioOfMeans: aStats.mean === 0 ? null : bStats.mean / aStats.mean,
      overFivePercent: a.filter((value, index) => b[index] > value * 1.05).length,
    };
  };
  return {
    metric: phase === 'plain' ? 'client-wall-ms' : 'statement-execution-ms',
    all: group(samples),
    AB: group(samples.filter((sample) => sample.order === 'AB')),
    BA: group(samples.filter((sample) => sample.order === 'BA')),
  };
}

export async function analyzeSearchRepro(runtime, fixture, { replica, signal, onProgress } = {}) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    protocolCompleted: false,
    replica,
    conditions: [],
    readOnlyContexts: [],
    structures: {},
    summary: [],
    adoptionEstablished: false,
    resourceObservations: { complete: false, expectedWindows: 15, windows: [] },
    hardCapMs: 360_000,
    interpretation:
      'Warm-cache paired diagnostic on synthetic data. No independent-sample confidence interval, per-query CPU attribution, capacity or adoption claim.',
  };
  const budget = () => {
    check(!signal?.aborted, 'REPRO_ABORTED');
    check(performance.now() - started < report.hardCapMs, 'REPRO_TIME_LIMIT');
  };
  const progress = async (stage) => {
    if (onProgress) await onProgress(stage);
    budget();
  };
  try {
    budget();
    const schedule = searchReproSchedule(replica);
    report.schedule = schedule;
    check(
      runtime &&
        [
          'withAppReadOnly',
          'buildLegacySearch048Query',
          'buildLegacySearch049Query',
          'buildTicketListQuery',
          'readDatabaseResources',
        ].every((name) => typeof runtime[name] === 'function'),
      'REPRO_RUNTIME_REQUIRED',
    );
    const discovery = await discoverSearchTerms(runtime, fixture, signal);
    report.readOnlyContexts.push({
      name: 'term-discovery',
      proof: sanitizeReadOnlyProof(discovery.proof),
    });
    const actor = fixture.actors.find((value) => value.role === 'agent');
    check(actor, 'REPRO_ORACLE_FAILED');
    const context = {
      organizationId: fixture.organizationId,
      principal: {
        userId: actor.userId,
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
    const readContext = { organizationId: fixture.organizationId, actorId: actor.userId };
    let state;
    await runtime.withAppReadOnly(readContext, async (client) => {
      report.readOnlyContexts.push({
        name: 'rare-state-discovery',
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
        'REPRO_ORACLE_FAILED',
      );
      state = result.rows[0].state;
    });
    const keyword = (key) => {
      const value = discovery.terms.find((term) => term.key === key)?.keyword;
      check(typeof value === 'string', 'REPRO_ORACLE_FAILED');
      return value;
    };
    const definitions = {
      rare: { keyword: keyword('rare') },
      zero: { keyword: keyword('zero') },
      'rare-state': { keyword: keyword('rare'), state: [state] },
      'zero-new': { keyword: keyword('zero'), state: ['new'] },
      'short-new': { keyword: keyword('short'), state: ['new'] },
    };
    await progress('repro-ready');
    for (const condition of schedule.conditions) {
      const item = { name: condition, completed: false, phases: [] };
      report.conditions.push(item);
      await runtime.withAppReadOnly(readContext, async (client) => {
        item.proof = sanitizeReadOnlyProof(client.proof);
        report.readOnlyContexts.push({ name: condition, proof: item.proof });
        const options = {
          sort: { column: 'created_at', direction: 'desc' },
          limit: 50,
          filter: definitions[condition],
        };
        const queries = {
          A: runtime.buildLegacySearch048Query(context, options),
          B: runtime.buildLegacySearch049Query(context, options),
        };
        item.binding = searchReproBinding(
          queries.A,
          queries.B,
          runtime.buildTicketListQuery(context, options),
          ['rare', 'zero'].includes(condition),
        );
        let reference;
        const read = async (side) => {
          budget();
          const now = performance.now();
          const result = await client.query(queries[side].combinedSql, queries[side].params);
          const wallMs = performance.now() - now;
          budget();
          return { result: normalizeSearchCombinedRows(result.rows, 50), wallMs };
        };
        for (const phase of schedule.phases) {
          const entry = { name: phase, completed: false, warmup: [], samples: [] };
          item.phases.push(entry);
          const oracleReads = {};
          for (const side of schedule.orders[0]) oracleReads[side] = await read(side);
          const left = oracleReads.A,
            right = oracleReads.B;
          entry.oracle = {
            comparison: compareSearchResults(left.result, right.result),
            order: schedule.orders[0],
            excludedFromMeasurement: true,
            stableSnapshot:
              reference === undefined || compareSearchResults(reference, left.result).equal,
            expectedPopulation: condition.startsWith('rare')
              ? left.result.total === 1
              : condition.startsWith('zero')
                ? left.result.total === 0
                : left.result.total > 0,
            rows: left.result.rows.length,
            total: left.result.total,
          };
          check(
            entry.oracle.comparison.equal &&
              entry.oracle.stableSnapshot &&
              entry.oracle.expectedPopulation,
            'REPRO_ORACLE_FAILED',
          );
          reference ??= left.result;
          const executePair = async (target, index) => {
            const order = schedule.orders[index % 4];
            const sample = {
              pair: index + 1,
              order,
              completed: false,
              verification: phase === 'plain' ? 'native-result' : 'phase-oracle-and-plan',
            };
            target.push(sample);
            const privateResults = {};
            for (const side of order) {
              if (phase === 'plain') {
                const result = await read(side);
                privateResults[side] = result.result;
                sample[side] = {
                  wallMs: result.wallMs,
                  rows: result.result.rows.length,
                  total: result.result.total,
                };
              } else {
                budget();
                const sql = `EXPLAIN (ANALYZE, BUFFERS, TIMING ${phase === 'explain-off' ? 'OFF' : 'ON'}, FORMAT JSON) ${queries[side].combinedSql.trimStart()}`;
                const now = performance.now();
                const result = await client.query(sql, queries[side].params);
                const wallMs = performance.now() - now;
                budget();
                const plan = summarizeSearchReproPlan(
                  result.rows[0]?.['QUERY PLAN'],
                  entry.oracle.rows,
                );
                check(
                  condition !== 'short-new' || side !== 'B' || plan.work.branch === 'prefix',
                  'REPRO_PLAN_INVALID',
                );
                check(
                  Object.keys(report.structures).length < 128 ||
                    report.structures[plan.structureSha256],
                  'REPRO_PLAN_INVALID',
                );
                report.structures[plan.structureSha256] ??= plan.structure;
                sample[side] = {
                  wallMs,
                  executionMs: plan.executionMs,
                  planningMs: plan.planningMs,
                  structureSha256: plan.structureSha256,
                  work: plan.work,
                };
              }
            }
            if (phase === 'plain') {
              sample.comparison = compareSearchResults(privateResults.A, privateResults.B);
              sample.stableSnapshot = compareSearchResults(reference, privateResults.A).equal;
              check(sample.comparison.equal && sample.stableSnapshot, 'REPRO_ORACLE_FAILED');
            }
            sample.completed = true;
          };
          for (let index = 0; index < schedule.warmupPairs; index++)
            await executePair(entry.warmup, index);
          const window = { condition, phase, completed: false };
          report.resourceObservations.windows.push(window);
          window.before = sanitizeSearchReproResources(await runtime.readDatabaseResources());
          budget();
          const measurementStart = performance.now();
          try {
            for (let index = 0; index < schedule.measuredPairs[phase]; index++)
              await executePair(entry.samples, index);
          } finally {
            window.measurementWallMs = performance.now() - measurementStart;
            window.after = sanitizeSearchReproResources(await runtime.readDatabaseResources());
            window.delta = searchReproResourceDelta(window.before, window.after);
            window.completed = true;
          }
          budget();
          entry.summary = summarizeSearchReproPairs(entry.samples, phase);
          entry.completed = true;
          await progress(`repro-${condition}-${phase}-completed`);
        }
        item.completed = true;
      });
      report.summary.push({
        condition,
        phases: item.phases.map((phase) => ({ phase: phase.name, ...phase.summary })),
      });
    }
    report.protocolCompleted =
      report.conditions.length === 5 &&
      report.conditions.every(
        (condition) =>
          condition.completed &&
          condition.phases.length === 3 &&
          condition.phases.every(
            (phase) =>
              phase.completed &&
              phase.warmup.length === 2 &&
              phase.warmup.every((sample) => sample.completed) &&
              phase.samples.length === schedule.measuredPairs[phase.name] &&
              phase.samples.every((sample) => sample.completed),
          ),
      );
    check(report.protocolCompleted, 'REPRO_PROTOCOL_FAILED');
    report.resourceObservations.complete =
      report.resourceObservations.windows.length === 15 &&
      report.resourceObservations.windows.every(
        (window) => window.completed && window.delta?.available,
      );
    report.equivalent = true;
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted
      ? 'REPRO_ABORTED'
      : FAILURES.has(error?.message)
        ? error.message
        : 'REPRO_ANALYSIS_FAILED';
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
