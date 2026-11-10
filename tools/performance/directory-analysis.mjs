import { performance } from 'node:perf_hooks';
import { sanitizeExplain, sanitizeReadOnlyProof } from './list-query-analysis.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMPTY_ORGANIZATION = '04500000-0000-4000-8000-000000000000';
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fields = [
  'userId',
  'displayName',
  'email',
  'status',
  'deactivatedAt',
  'roleCodes',
  'temporaryRoles',
  'openTicketCount',
].sort();
const failureCodes = new Set([
  'DIRECTORY_ANALYSIS_ABORTED',
  'DIRECTORY_ANALYSIS_TIME_LIMIT',
  'DIRECTORY_RUNTIME_REQUIRED',
  'DIRECTORY_FIXTURE_INVALID',
  'DIRECTORY_RLS_PROOF_INVALID',
  'DIRECTORY_BINDING_INVALID',
  'DIRECTORY_POPULATION_INVALID',
  'DIRECTORY_QUERY_COUNT_INVALID',
  'DIRECTORY_QUERY_REJECTED',
  'DIRECTORY_ROWS_INVALID',
  'DIRECTORY_PLAN_INVALID',
  'QUERY_PLAN_INVALID',
  'QUERY_READ_ONLY_PROOF_INVALID',
]);

/** Only role sets and ties under the existing status/display-name ORDER BY are unordered. */
export function canonicalDirectoryMembers(members) {
  check(Array.isArray(members), 'DIRECTORY_ROWS_INVALID');
  const ids = new Set();
  const groups = [];
  for (const member of members) {
    check(
      member &&
        same(Object.keys(member).sort(), fields) &&
        UUID.test(member.userId) &&
        !ids.has(member.userId) &&
        typeof member.displayName === 'string' &&
        typeof member.email === 'string' &&
        ['active', 'deactivated'].includes(member.status) &&
        (member.deactivatedAt === null ||
          (member.deactivatedAt instanceof Date &&
            Number.isFinite(member.deactivatedAt.getTime()))) &&
        Array.isArray(member.roleCodes) &&
        member.roleCodes.every((role) => typeof role === 'string') &&
        new Set(member.roleCodes).size === member.roleCodes.length &&
        Array.isArray(member.temporaryRoles) &&
        member.temporaryRoles.every(
          (role) =>
            role &&
            same(Object.keys(role).sort(), [
              'daysRemaining',
              'expiringSoon',
              'roleCode',
              'validUntil',
            ]) &&
            typeof role.roleCode === 'string' &&
            typeof role.validUntil === 'string' &&
            Number.isFinite(Date.parse(role.validUntil)) &&
            Number.isSafeInteger(role.daysRemaining) &&
            typeof role.expiringSoon === 'boolean',
        ) &&
        Number.isSafeInteger(member.openTicketCount) &&
        member.openTicketCount >= 0,
      'DIRECTORY_ROWS_INVALID',
    );
    ids.add(member.userId);
    const canonical = Object.fromEntries(
      Object.entries({
        ...member,
        roleCodes: [...member.roleCodes].sort(),
        temporaryRoles: member.temporaryRoles
          .map((role) =>
            Object.fromEntries(Object.entries(role).sort(([a], [b]) => a.localeCompare(b))),
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }).sort(([a], [b]) => a.localeCompare(b)),
    );
    const key = JSON.stringify([member.status, member.displayName]);
    if (groups.at(-1)?.key === key) groups.at(-1).members.push(canonical);
    else groups.push({ key, members: [canonical] });
  }
  return groups.flatMap((group) => group.members.sort((a, b) => a.userId.localeCompare(b.userId)));
}

export function compareDirectoryMembers(legacy, candidate) {
  const left = canonicalDirectoryMembers(legacy),
    right = canonicalDirectoryMembers(candidate);
  return {
    rows: left.length === right.length,
    idsAndOrder: same(
      left.map((row) => row.userId),
      right.map((row) => row.userId),
    ),
    fullFields: same(left, right),
    equal: same(left, right),
  };
}

/** No predicates, relation names, member identifiers or query text are retained. */
export function summarizeDirectoryPlans(documents) {
  check(
    Array.isArray(documents) && documents.length > 0 && documents.length <= 2,
    'DIRECTORY_PLAN_INVALID',
  );
  const plans = documents.map(sanitizeExplain);
  const flatten = (node) => [node, ...(node.children ?? []).flatMap(flatten)];
  const nodes = plans.flatMap((plan) => flatten(plan.plan));
  return {
    queryCount: plans.length,
    plans,
    executionMs: plans.reduce((sum, plan) => sum + plan.executionMs, 0),
    planningMs: plans.reduce((sum, plan) => sum + plan.planningMs, 0),
    rootSharedHits: plans.reduce((sum, plan) => sum + (plan.plan.sharedHitBlocks ?? 0), 0),
    rootSharedReads: plans.reduce((sum, plan) => sum + (plan.plan.sharedReadBlocks ?? 0), 0),
    scanLoops: nodes
      .filter((node) => /Scan$/.test(node.nodeType))
      .reduce((sum, node) => sum + (node.actualLoops ?? 0), 0),
    scanRowVisits: nodes
      .filter((node) => /Scan$/.test(node.nodeType))
      .reduce((sum, node) => sum + (node.actualLoops ?? 0) * (node.actualRows ?? 0), 0),
    aggregateLoops: nodes
      .filter((node) => node.nodeType === 'Aggregate')
      .reduce((sum, node) => sum + (node.actualLoops ?? 0), 0),
  };
}

const contextFor = (binding, organizationId) => ({
  organizationId,
  principal: {
    userId: binding.user_id,
    status: binding.status,
    bindings: [
      {
        roleCode: binding.code,
        organizationId: binding.organization_id,
        validFrom: binding.valid_from,
        validUntil: binding.valid_until,
      },
    ],
  },
});

export async function runDirectoryAnalysis({ runtime, fixture, signal }) {
  const started = performance.now();
  const report = {
    completed: false,
    equivalent: false,
    cases: [],
    readOnlyContexts: [],
    coverage: {
      actualRls: [
        'primary-organization',
        'control-organization',
        'organization-mismatch',
        'empty-context',
      ],
      separateSecurityTests: [
        'zero-count-boundary',
        'deactivated',
        'multiple-roles',
        'expired-binding',
        'snapshot',
        'deactivation-rollback',
      ],
      emptyContextIsDefenseProbe: true,
    },
  };
  const budget = () => {
    check(!signal?.aborted, 'DIRECTORY_ANALYSIS_ABORTED');
    check(performance.now() - started < 120_000, 'DIRECTORY_ANALYSIS_TIME_LIMIT');
  };
  try {
    budget();
    check(
      runtime &&
        typeof runtime.withAppReadOnly === 'function' &&
        typeof runtime.readDirectoryMembers === 'function',
      'DIRECTORY_RUNTIME_REQUIRED',
    );
    const actor = fixture.actors.find((value) => value.role === 'admin');
    check(
      actor &&
        [actor.userId, fixture.organizationId, fixture.controlOrganizationId].every((value) =>
          UUID.test(value),
        ) &&
        fixture.organizationId !== fixture.controlOrganizationId &&
        ![fixture.organizationId, fixture.controlOrganizationId].includes(EMPTY_ORGANIZATION),
      'DIRECTORY_FIXTURE_INVALID',
    );
    const query = async (client, sql, params = []) => {
      budget();
      const result = await client.query(sql, params);
      budget();
      return result;
    };
    const readOnly = (name, organizationId, actorId, callback) =>
      runtime.withAppReadOnly({ organizationId, actorId }, async (client) => {
        budget();
        const proof = sanitizeReadOnlyProof(client.proof);
        const rls = (
          await query(
            client,
            `SELECT row_security_active('public.app_user') AS users_active,
        row_security_active('public.role_binding') AS bindings_active,
        (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.app_user'::regclass) AS users_forced,
        (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.role_binding'::regclass) AS bindings_forced`,
          )
        ).rows[0];
        check(
          rls &&
            ['users_active', 'bindings_active', 'users_forced', 'bindings_forced'].every(
              (key) => rls[key] === true,
            ),
          'DIRECTORY_RLS_PROOF_INVALID',
        );
        const directoryRls = {
          usersActive: true,
          bindingsActive: true,
          usersForced: true,
          bindingsForced: true,
        };
        report.readOnlyContexts.push({ name, proof, directoryRls });
        return callback(client, proof, directoryRls);
      });
    const loadBinding = async (client, organizationId, actorId) => {
      const result = await query(
        client,
        `SELECT rb.user_id,rb.organization_id,r.code,rb.valid_from,rb.valid_until,u.status
        FROM role_binding rb JOIN role r ON r.id=rb.role_id JOIN app_user u ON u.id=rb.user_id
        WHERE rb.organization_id=$1 AND r.code='org_admin' AND u.status='active'
          AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now())
          AND ($2::uuid IS NULL OR rb.user_id=$2) ORDER BY rb.user_id LIMIT 1`,
        [organizationId, actorId ?? null],
      );
      const binding = result.rows[0];
      check(
        binding &&
          UUID.test(binding.user_id) &&
          binding.organization_id === organizationId &&
          binding.code === 'org_admin' &&
          binding.status === 'active' &&
          binding.valid_from instanceof Date &&
          (binding.valid_until === null || binding.valid_until instanceof Date),
        'DIRECTORY_BINDING_INVALID',
      );
      return binding;
    };
    const controlBinding = await readOnly(
      'discover-control-admin',
      fixture.controlOrganizationId,
      actor.userId,
      (client) => loadBinding(client, fixture.controlOrganizationId),
    );
    let primaryContext;
    const definitions = [
      {
        name: 'primary-organization',
        organizationId: fixture.organizationId,
        expected: fixture.counts.users,
      },
      {
        name: 'control-organization',
        organizationId: fixture.controlOrganizationId,
        expected: fixture.counts.controlUsers,
      },
      {
        name: 'organization-mismatch',
        organizationId: fixture.controlOrganizationId,
        expected: 0,
        defense: true,
      },
      { name: 'empty-context', organizationId: EMPTY_ORGANIZATION, expected: 0, defense: true },
    ];
    for (const definition of definitions) {
      budget();
      const item = {
        name: definition.name,
        mode: 'actual-table',
        rlsEvidence: true,
        defenseProbe: Boolean(definition.defense),
        completed: false,
        stage: 'open-context',
        legacy: {},
        candidate: {},
      };
      report.cases.push(item);
      const actorId =
        definition.name === 'control-organization' ? controlBinding.user_id : actor.userId;
      await readOnly(
        definition.name,
        definition.organizationId,
        actorId,
        async (client, proof, directoryRls) => {
          item.proof = proof;
          item.directoryRls = directoryRls;
          let context = primaryContext;
          if (!definition.defense) {
            const binding = await loadBinding(client, definition.organizationId, actorId);
            context = contextFor(binding, definition.organizationId);
            if (definition.name === 'primary-organization') primaryContext = context;
          }
          check(context, 'DIRECTORY_BINDING_INVALID');
          item.stage = 'membership-oracle';
          const membership = await query(
            client,
            `SELECT DISTINCT u.id FROM app_user u
          JOIN role_binding rb ON rb.user_id=u.id WHERE rb.organization_id=$1
          AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now()) ORDER BY u.id`,
            [context.organizationId],
          );
          const expectedIds = membership.rows.map((row) => row.id).sort();
          check(
            Number.isSafeInteger(definition.expected) &&
              expectedIds.length === definition.expected &&
              expectedIds.every((id) => UUID.test(id)),
            'DIRECTORY_POPULATION_INVALID',
          );
          item.stage = 'service-comparison';
          const left = await runtime.readDirectoryMembers('legacy', client, context);
          budget();
          const right = await runtime.readDirectoryMembers('candidate', client, context);
          budget();
          for (const [name, result] of [
            ['legacy', left],
            ['candidate', right],
          ]) {
            canonicalDirectoryMembers(result.members);
            check(
              Array.isArray(result.queries) &&
                (name === 'legacy'
                  ? result.queries.length === 1
                  : [1, 2].includes(result.queries.length)),
              'DIRECTORY_QUERY_COUNT_INVALID',
            );
            item[name].rows = result.members.length;
            item[name].queryCount = result.queries.length;
            item[name].observed = {
              zeroCounts: result.members.filter((m) => m.openTicketCount === 0).length,
              deactivated: result.members.filter((m) => m.status === 'deactivated').length,
              multipleRoles: result.members.filter((m) => m.roleCodes.length > 1).length,
            };
          }
          item.comparison = compareDirectoryMembers(left.members, right.members);
          item.comparison.expectedPopulation = [left, right].every((result) =>
            same(result.members.map((member) => member.userId).sort(), expectedIds),
          );
          item.comparison.equal &&= item.comparison.expectedPopulation;
          item.sqlChanged = !same(left.queries, right.queries);
          for (const [name, result] of [
            ['legacy', left],
            ['candidate', right],
          ]) {
            item.stage = `${name}-plans`;
            const plans = [];
            for (const built of result.queries) {
              check(
                typeof built.sql === 'string' &&
                  /^\s*SELECT\b/.test(built.sql) &&
                  !built.sql.includes(';') &&
                  Array.isArray(built.params),
                'DIRECTORY_QUERY_REJECTED',
              );
              plans.push(
                (
                  await query(
                    client,
                    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + built.sql,
                    built.params,
                  )
                ).rows[0]['QUERY PLAN'],
              );
              // Retain each sanitized result before the next statement can fail.
              // queryCount here is the completed subset; the case stays incomplete.
              item[name].work = summarizeDirectoryPlans(plans);
            }
          }
          item.completed = true;
          item.stage = 'complete';
        },
      );
    }
    report.equivalent =
      report.cases.length === 4 &&
      report.cases.every((item) => item.completed && item.comparison.equal);
    const primary = report.cases[0];
    report.optimization = {
      queryShapeChanged: primary.sqlChanged,
      legacyQueries: primary.legacy.queryCount,
      candidateQueries: primary.candidate.queryCount,
      legacyExecutionMs: primary.legacy.work.executionMs,
      candidateExecutionMs: primary.candidate.work.executionMs,
      legacyAggregateLoops: primary.legacy.work.aggregateLoops,
      candidateAggregateLoops: primary.candidate.work.aggregateLoops,
      legacyRootSharedHits: primary.legacy.work.rootSharedHits,
      candidateRootSharedHits: primary.candidate.work.rootSharedHits,
      bulkObserved:
        primary.sqlChanged &&
        primary.candidate.queryCount === 2 &&
        primary.candidate.work.aggregateLoops < primary.legacy.work.aggregateLoops,
    };
    report.completed = true;
  } catch (error) {
    report.failureCode = signal?.aborted
      ? 'DIRECTORY_ANALYSIS_ABORTED'
      : failureCodes.has(error?.message)
        ? error.message
        : 'DIRECTORY_ANALYSIS_FAILED';
  }
  report.elapsedMs = performance.now() - started;
  return report;
}
