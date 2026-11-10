import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';
import {
  buildDeadlineBoundaryQuery,
  compareDeadlineContracts,
  compareDeadlineResults,
  prepareDeadlineBoundary,
  summarizeDeadlinePlan,
  validateDeadlineResult,
} from './deadline-analysis.mjs';

export const SEARCH_KEYWORD = '合成性能問い合わせ 1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const check = (value, code) => {
  if (!value) throw new Error(code);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failures = new Set([
  'SEARCH_ABORTED',
  'SEARCH_TIME_LIMIT',
  'SEARCH_RUNTIME_REQUIRED',
  'SEARCH_FIXTURE_INVALID',
  'SEARCH_BINDINGS_INVALID',
  'SEARCH_GROUP_REQUIRED',
  'SEARCH_CONTROL_REQUIRED',
  'SEARCH_RESULT_INVALID',
  'SEARCH_QUERY_REJECTED',
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

export const compareSearchContracts = compareDeadlineContracts;
/** Ignore object key order while preserving Date, NULL and missing-field types. */
export function compareSearchResults(legacy, candidate) {
  const comparison = compareDeadlineResults(legacy, candidate);
  comparison.fullRows = isDeepStrictEqual(legacy.rows, candidate.rows);
  const sla = (rows) =>
    rows.map((row) => [
      row.sla_elapsed_now,
      row.remaining_seconds,
      row.response_target_minutes,
      row.resolution_target_minutes,
      row.sla_elapsed_seconds,
      row.sla_clock_started_at,
    ]);
  comparison.rawSla = isDeepStrictEqual(sla(legacy.rows), sla(candidate.rows));
  comparison.total =
    Number.isSafeInteger(legacy.total) &&
    legacy.total >= 0 &&
    Number.isSafeInteger(candidate.total) &&
    candidate.total >= 0 &&
    legacy.total === candidate.total;
  comparison.equal = Object.entries(comparison).every(([key, value]) => key === 'equal' || value);
  return comparison;
}
export const summarizeSearchPlan = summarizeDeadlinePlan;

/** CTE-only rows: deliberately missing labels and tied, full-precision creation timestamps. */
export function prepareSearchBoundary(fixture) {
  const boundary = prepareDeadlineBoundary(fixture);
  boundary.tickets.forEach((ticket, index) => {
    ticket.subject = '合成検索境界 ' + (index + 1);
    ticket.body = index === 0 ? '文字どおり 100%_\\ を含む' : 'Synthetic boundary';
    if (index === 1) ticket.body += ' 希少語';
    ticket.search_text = `${ticket.number} ${ticket.subject} ${ticket.body}`;
  });
  const absentRequester = boundary.tickets[9].requester_id;
  boundary.users = boundary.users.filter((user) => user.id !== absentRequester);
  boundary.expected = boundary.expected.map((row) => ({
    ...row,
    requesterName: row.requesterId === absentRequester ? null : row.requesterName,
  }));
  return boundary;
}

/** Independent expected IDs, label NULLs and SLA values; never treat these CTEs as RLS proof. */
export function checkSearchBoundary(result, boundary, options) {
  const keyword = (options.keyword ?? '').trim().toLowerCase();
  const eligible = boundary.expected.filter((row) => {
    const ticket = boundary.tickets.find((value) => value.id === row.id);
    return (
      ticket.search_text.toLowerCase().includes(keyword) &&
      (!options.requesterId || row.requesterId === options.requesterId)
    );
  });
  const ordered = eligible.sort((a, b) =>
    options.direction === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id),
  );
  const page = ordered
    .filter((row) =>
      !options.cursorId
        ? true
        : options.direction === 'asc'
          ? row.id > options.cursorId
          : row.id < options.cursorId,
    )
    .slice(0, options.limit);
  return (
    result.total === eligible.length &&
    same(
      result.rows.map((row) => row.id),
      page.map((row) => row.id),
    ) &&
    result.rows.every((row, index) => {
      const expected = page[index];
      return (
        (row.remaining_seconds === null ? null : Number(row.remaining_seconds)) ===
          expected.remainingSeconds &&
        Number(row.sla_elapsed_now) === expected.elapsed &&
        row.assignee_name === expected.assigneeName &&
        row.requester_name === expected.requesterName &&
        row.assignee_group_name === expected.groupName
      );
    })
  );
}

export async function runSearchAnalysis({ runtime, fixture, signal }) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    cases: [],
    readOnlyContexts: [],
    unchangedSorts: [],
  };
  const budget = () => {
    check(!signal?.aborted, 'SEARCH_ABORTED');
    check(performance.now() - started < 180_000, 'SEARCH_TIME_LIMIT');
  };
  try {
    budget();
    check(
      runtime &&
        ['withAppReadOnly', 'buildTicketListQuery', 'buildLegacySearchQuery'].every(
          (name) => typeof runtime[name] === 'function',
        ),
      'SEARCH_RUNTIME_REQUIRED',
    );
    const staff = fixture?.actors?.find((actor) => actor.role === 'agent');
    const requester = fixture?.actors?.find((actor) => actor.role === 'requester');
    check(
      staff &&
        requester &&
        [
          staff.userId,
          requester.userId,
          fixture.organizationId,
          fixture.controlOrganizationId,
          fixture.controlTicketId,
        ].every((value) => UUID.test(value)) &&
        fixture.organizationId !== fixture.controlOrganizationId,
      'SEARCH_FIXTURE_INVALID',
    );
    const staffCtx = contextFor(staff, fixture.organizationId);
    const requesterCtx = contextFor(requester, fixture.organizationId);
    const query = async (client, sql, params = []) => {
      budget();
      check(
        /^\s*SELECT\b|^EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\) SELECT\b/.test(sql) &&
          !sql.includes(';'),
        'SEARCH_QUERY_REJECTED',
      );
      const result = await client.query(sql, params);
      budget();
      return result;
    };
    const readOnly = (name, context, callback) =>
      runtime.withAppReadOnly(context, async (client) => {
        budget();
        const proof = sanitizeReadOnlyProof(client.proof);
        report.readOnlyContexts.push({ name, proof });
        return callback(client, proof);
      });
    let groupId, rare;
    await readOnly(
      'fixture-bindings',
      { organizationId: fixture.organizationId, actorId: staff.userId },
      async (client) => {
        const bindings = (
          await query(
            client,
            "SELECT rb.user_id,r.code FROM role_binding rb JOIN role r ON r.id=rb.role_id JOIN app_user u ON u.id=rb.user_id WHERE (rb.organization_id=$1 OR rb.organization_id IS NULL) AND rb.user_id=ANY($2::uuid[]) AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now()) AND u.status='active'",
            [fixture.organizationId, [staff.userId, requester.userId]],
          )
        ).rows;
        check(
          bindings.some((row) => row.user_id === staff.userId && row.code === 'agent') &&
            bindings.some((row) => row.user_id === requester.userId && row.code === 'requester') &&
            !bindings.some(
              (row) =>
                row.user_id === requester.userId &&
                ['agent', 'org_admin', 'auditor', 'platform_admin', 'platform_auditor'].includes(
                  row.code,
                ),
            ),
          'SEARCH_BINDINGS_INVALID',
        );
        groupId = (
          await query(
            client,
            'SELECT id FROM assignment_group WHERE organization_id=$1 AND active ORDER BY code LIMIT 1',
            [fixture.organizationId],
          )
        ).rows[0]?.id;
        check(UUID.test(groupId), 'SEARCH_GROUP_REQUIRED');
        rare = (
          await query(client, 'SELECT number FROM ticket WHERE organization_id=$1 AND id=$2', [
            fixture.organizationId,
            staff.ticketId,
          ])
        ).rows[0]?.number;
        check(typeof rare === 'string' && rare.length > 0, 'SEARCH_FIXTURE_INVALID');
      },
    );
    for (const direction of ['asc', 'desc']) {
      for (const column of ['updated_at', 'priority', 'number', 'deadline']) {
        const options = {
          sort: { column, direction },
          filter: { keyword: SEARCH_KEYWORD },
          limit: 50,
        };
        const legacy = runtime.buildLegacySearchQuery(staffCtx, options);
        const candidate = runtime.buildTicketListQuery(staffCtx, options);
        report.unchangedSorts.push({
          name: `${column}-${direction}`,
          sql: legacy.sql === candidate.sql,
          ...compareSearchContracts(legacy, candidate),
        });
      }
      for (const [name, keyword] of [
        ['absent', undefined],
        ['empty', ''],
        ['whitespace', '  \t '],
      ]) {
        const options = {
          sort: { column: 'created_at', direction },
          filter: { keyword },
          limit: 50,
        };
        const legacy = runtime.buildLegacySearchQuery(staffCtx, options);
        const candidate = runtime.buildTicketListQuery(staffCtx, options);
        report.unchangedSorts.push({
          name: `created-${name}-${direction}`,
          sql: legacy.sql === candidate.sql,
          ...compareSearchContracts(legacy, candidate),
        });
      }
    }
    const optionsFor = (keyword, direction = 'desc', limit = 50) => ({
      sort: { column: 'created_at', direction },
      filter: { keyword },
      limit,
    });
    const definitions = [];
    for (const direction of ['asc', 'desc'])
      for (const limit of [1, 50, 200])
        definitions.push({
          name: `staff-${direction}-${limit}`,
          ctx: staffCtx,
          options: optionsFor(SEARCH_KEYWORD, direction, limit),
          pagination: true,
        });
    for (const [name, keyword, empty] of [
      ['short', '合', false],
      ['wide', '合成性能問い合わせ', false],
      ['rare', rare, false],
      ['empty', 'WP046不存在query-a879ef', true],
      ['literal', '%_\\', true],
    ])
      definitions.push({ name, ctx: staffCtx, options: optionsFor(keyword), empty });
    for (const direction of ['asc', 'desc'])
      definitions.push({
        name: `requester-${direction}`,
        ctx: requesterCtx,
        requesterOnly: true,
        options: optionsFor('合成性能問い合わせ', direction),
      });
    definitions.push(
      {
        name: 'group',
        ctx: staffCtx,
        options: {
          ...optionsFor(SEARCH_KEYWORD),
          filter: { keyword: SEARCH_KEYWORD, assigneeGroupIds: [groupId] },
        },
      },
      {
        name: 'ungrouped',
        ctx: staffCtx,
        options: {
          ...optionsFor('合成性能問い合わせ'),
          filter: { keyword: '合成性能問い合わせ', ungroupedOnly: true },
        },
      },
      {
        name: 'combined-filter',
        ctx: staffCtx,
        options: {
          ...optionsFor('合成性能問い合わせ'),
          filter: {
            keyword: '合成性能問い合わせ',
            unassignedOnly: true,
            state: ['new', 'assigned', 'in_progress'],
            priority: ['low'],
          },
        },
      },
      {
        name: 'organization-mismatch',
        ctx: staffCtx,
        organizationId: fixture.controlOrganizationId,
        empty: true,
        options: optionsFor(SEARCH_KEYWORD),
      },
    );
    const boundary = prepareSearchBoundary(fixture);
    for (const direction of ['asc', 'desc'])
      for (const limit of [1, 50, 200])
        definitions.push({
          name: `boundary-${direction}-${limit}`,
          ctx: staffCtx,
          boundary,
          options: optionsFor('合成検索境界', direction, limit),
          pagination: true,
        });
    for (const [name, keyword, empty] of [
      ['literal', '%_\\', false],
      ['rare', '希少語', false],
      ['empty', '不存在', true],
    ])
      definitions.push({
        name: `boundary-${name}`,
        ctx: staffCtx,
        boundary,
        options: optionsFor(keyword),
        empty,
      });
    definitions.push({
      name: 'boundary-requester',
      ctx: requesterCtx,
      requesterOnly: true,
      boundary,
      options: optionsFor('合成検索境界'),
    });
    for (const definition of definitions) {
      budget();
      const item = {
        name: definition.name,
        mode: definition.boundary ? 'synthetic-cte' : 'actual-table',
        rlsEvidence: !definition.boundary,
        completed: false,
        stage: 'context',
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
            check(control.rows[0]?.n === 1, 'SEARCH_CONTROL_REQUIRED');
          }
          const wrap = (built) =>
            definition.boundary ? buildDeadlineBoundaryQuery(built, definition.boundary) : built;
          const build = (side, options) =>
            (side === 'legacy' ? runtime.buildLegacySearchQuery : runtime.buildTicketListQuery)(
              definition.ctx,
              options,
            );
          const execute = async (built, side, phase = 'first') => {
            item.stage = `${side}-${phase}-list`;
            const list = wrap({ sql: built.sql, params: built.params });
            const rows = (await query(client, list.sql, list.params)).rows;
            if (phase === 'first') item[side].rows = rows.length;
            item.stage = `${side}-${phase}-count`;
            const count = wrap({ sql: built.countSql, params: built.countParams });
            const totals = (await query(client, count.sql, count.params)).rows;
            check(totals.length === 1, 'SEARCH_RESULT_INVALID');
            const result = validateDeadlineResult(rows, totals[0].total, built.limit);
            if (phase === 'first') item[side].total = result.total;
            return result;
          };
          const legacy = build('legacy', definition.options),
            candidate = build('candidate', definition.options);
          item.contract = compareSearchContracts(legacy, candidate);
          item.sqlChanged = legacy.sql !== candidate.sql;
          const left = await execute(legacy, 'legacy'),
            right = await execute(candidate, 'candidate');
          const boundaryCheck = (result, options) =>
            !definition.boundary ||
            checkSearchBoundary(result, boundary, {
              keyword: options.filter.keyword,
              direction: options.sort.direction,
              limit: options.limit,
              requesterId: definition.requesterOnly ? requester.userId : undefined,
              cursorId: options.cursor?.id,
            });
          item.comparison = {
            ...compareSearchResults(left, right),
            organization: [...left.rows, ...right.rows].every(
              (row) => row.organization_id === fixture.organizationId,
            ),
            requester:
              !definition.requesterOnly ||
              [...left.rows, ...right.rows].every((row) => row.requester_id === requester.userId),
            expectedPopulation: definition.empty
              ? left.total === 0 &&
                right.total === 0 &&
                left.rows.length === 0 &&
                right.rows.length === 0
              : [left, right].every(
                  (result) =>
                    result.total > 0 && result.rows.length === Math.min(result.total, legacy.limit),
                ),
            boundary: [left, right].every((result) => boundaryCheck(result, definition.options)),
          };
          if (definition.pagination && left.rows.length > 0) {
            item.pagination = {};
            const cursorFor = (row) => ({ id: row.id, createdAt: row.cursor_created_at });
            const nextOptions = { ...definition.options, cursor: cursorFor(left.rows.at(-1)) };
            const nextLegacy = build('legacy', nextOptions),
              nextCandidate = build('candidate', nextOptions);
            const nextLeft = await execute(nextLegacy, 'legacy', 'next'),
              nextRight = await execute(nextCandidate, 'candidate', 'next');
            item.pagination.next = {
              ...compareSearchResults(nextLeft, nextRight),
              contract: Object.values(compareSearchContracts(nextLegacy, nextCandidate)).every(
                Boolean,
              ),
              unchangedTotal: nextLeft.total === left.total && nextRight.total === right.total,
              expectedRows: [nextLeft, nextRight].every(
                (result) =>
                  result.rows.length ===
                  Math.min(Math.max(left.total - left.rows.length, 0), legacy.limit),
              ),
              noOverlap: [...nextLeft.rows, ...nextRight.rows].every(
                (row) => !left.rows.some((first) => first.id === row.id),
              ),
              boundary: [nextLeft, nextRight].every((result) => boundaryCheck(result, nextOptions)),
            };
            const reverseOptions = {
              ...definition.options,
              sort: {
                column: 'created_at',
                direction: definition.options.sort.direction === 'asc' ? 'desc' : 'asc',
              },
              limit: 1,
            };
            const reverseLegacy = build('legacy', reverseOptions),
              reverseCandidate = build('candidate', reverseOptions);
            const lastLeft = await execute(reverseLegacy, 'legacy', 'last-anchor'),
              lastRight = await execute(reverseCandidate, 'candidate', 'last-anchor');
            check(
              lastLeft.rows.length === 1 && lastRight.rows.length === 1,
              'SEARCH_RESULT_INVALID',
            );
            item.pagination.lastAnchor = {
              ...compareSearchResults(lastLeft, lastRight),
              contract: Object.values(
                compareSearchContracts(reverseLegacy, reverseCandidate),
              ).every(Boolean),
            };
            const terminalOptions = { ...definition.options, cursor: cursorFor(lastLeft.rows[0]) };
            const terminalLegacy = build('legacy', terminalOptions),
              terminalCandidate = build('candidate', terminalOptions);
            const terminalLeft = await execute(terminalLegacy, 'legacy', 'terminal'),
              terminalRight = await execute(terminalCandidate, 'candidate', 'terminal');
            item.pagination.terminal = {
              ...compareSearchResults(terminalLeft, terminalRight),
              contract: Object.values(
                compareSearchContracts(terminalLegacy, terminalCandidate),
              ).every(Boolean),
              empty: terminalLeft.rows.length === 0 && terminalRight.rows.length === 0,
              unchangedTotal:
                terminalLeft.total === left.total && terminalRight.total === right.total,
              boundary: [terminalLeft, terminalRight].every((result) =>
                boundaryCheck(result, terminalOptions),
              ),
            };
          }
          item.comparison.equal =
            Object.values(item.comparison).every(Boolean) &&
            Object.values(item.contract).every(Boolean) &&
            (!item.pagination ||
              Object.values(item.pagination).every((phase) => Object.values(phase).every(Boolean)));
          for (const [side, built] of [
            ['legacy', legacy],
            ['candidate', candidate],
          ]) {
            item.stage = `${side}-list-explain`;
            const list = wrap({ sql: built.sql, params: built.params });
            const document = (
              await query(
                client,
                'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + list.sql.trimStart(),
                list.params,
              )
            ).rows[0]?.['QUERY PLAN'];
            item[side].listPlan = sanitizeExplain(document);
            item[side].displayJoins = summarizeSearchPlan(document, item[side].rows);
            item.stage = `${side}-count-explain`;
            const count = wrap({ sql: built.countSql, params: built.countParams });
            item[side].countPlan = sanitizeExplain(
              (
                await query(
                  client,
                  'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + count.sql.trimStart(),
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
      report.cases.length === definitions.length &&
      report.cases.every((item) => item.completed && item.comparison.equal) &&
      report.unchangedSorts.every((item) =>
        Object.entries(item).every(([key, value]) => key === 'name' || value === true),
      );
    const primary = report.cases.filter((item) =>
      ['staff-asc-50', 'staff-desc-50'].includes(item.name),
    );
    const work = (side) =>
      side.displayJoins.displayLookups
        .filter((value) => value.alias !== 'assignee_group')
        .reduce((sum, value) => sum + value.totalRows, 0);
    report.optimization = {
      comparisons: primary.map((item) => ({
        name: item.name,
        legacyUserRows: work(item.legacy),
        candidateUserRows: work(item.candidate),
        legacyListMs: item.legacy.listPlan.executionMs,
        candidateListMs: item.candidate.listPlan.executionMs,
        legacyCountMs: item.legacy.countPlan.executionMs,
        candidateCountMs: item.candidate.countPlan.executionMs,
      })),
      sqlChanged: primary.every((item) => item.sqlChanged),
      limitBeforeDisplayJoins: primary.every(
        (item) => item.candidate.displayJoins.limitBeforeDisplayJoins,
      ),
      userLookupsBounded: primary.every(
        (item) => item.candidate.displayJoins.userLookupsBoundedByReturnedRows,
      ),
      userLookupsReduced: primary.every((item) => work(item.candidate) < work(item.legacy)),
    };
    report.optimization.confirmed =
      report.equivalent &&
      ['sqlChanged', 'limitBeforeDisplayJoins', 'userLookupsBounded', 'userLookupsReduced'].every(
        (key) => report.optimization[key],
      );
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted
      ? 'SEARCH_ABORTED'
      : failures.has(error?.message)
        ? error.message
        : 'SEARCH_ANALYSIS_FAILED';
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
