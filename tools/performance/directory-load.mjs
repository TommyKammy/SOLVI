import { setTimeout as delay } from 'node:timers/promises';
import { assertLoopbackBase, login, requestSample, validateProfile } from './workload.mjs';
import {
  MAX_COMPARISON_MS,
  verifySessions,
  runBurst,
  scrapePool,
  poolDifference,
  drain,
} from './list-load.mjs';

export const DIRECTORY_LIST_PATH = '/users';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = new Set([
  'platform_admin',
  'org_admin',
  'agent',
  'approver',
  'auditor',
  'platform_auditor',
  'requester',
]);
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const FAILURE_CODES = new Set([
  'DIRECTORY_ABORTED',
  'DIRECTORY_ADMIN_REQUIRED',
  'DIRECTORY_API_PROBES_FAILED',
  'DIRECTORY_COMPARISON_FAILED',
  'DIRECTORY_DB_SAMPLE_INVALID',
  'DIRECTORY_DRAIN_FAILED',
  'DIRECTORY_FIXTURE_COUNT_INVALID',
  'DIRECTORY_FIXTURE_DTO_INVALID',
  'DIRECTORY_HARD_CAP',
  'DIRECTORY_INCOMPLETE',
  'DIRECTORY_OBSERVATION_INVALID',
  'DIRECTORY_PHASE_FAILED',
  'DIRECTORY_PROBE_ACTOR_REQUIRED',
  'DIRECTORY_PROFILE_INVALID',
  'DIRECTORY_PROFILE_SESSION_COUNT_INVALID',
  'DIRECTORY_SESSION_CARDINALITY_INVALID',
  'DIRECTORY_STATE_ACTOR_INVALID',
  'DIRECTORY_STATE_DATABASE_MISMATCH',
  'DIRECTORY_STATE_DATABASE_REJECTED',
  'DIRECTORY_STATE_PROBES_FAILED',
  'DIRECTORY_STATE_RESPONSE_INVALID',
  'DIRECTORY_STATE_SETUP_INVALID',
  'LIST_ABORTED',
  'LIST_AGENT_REQUIRED',
  'LIST_BURST_SIZE_INVALID',
  'LIST_COMPARISON_FAILED',
  'LIST_DB_SAMPLE_INVALID',
  'LIST_DEADLINE_FIXTURE_INVALID',
  'LIST_DEADLINE_PROBES_FAILED',
  'LIST_DEADLINE_PROBE_ACTOR_REQUIRED',
  'LIST_DEADLINE_PROBE_FIXTURE_INVALID',
  'LIST_DRAIN_FAILED',
  'LIST_HARD_CAP',
  'LIST_INCOMPLETE',
  'LIST_OBSERVATION_INVALID',
  'LIST_PHASE_FAILED',
  'LIST_POOL_INVALID',
  'LIST_POOL_RESPONSE_TOO_LARGE',
  'LIST_POOL_UNAVAILABLE',
  'LIST_PROFILE_INVALID',
  'LIST_PROFILE_SESSION_COUNT_INVALID',
  'LIST_ROUTE_REQUIRED',
  'LIST_SESSIONS_NOT_DISTINCT',
  'LIST_SESSION_CARDINALITY_INVALID',
  'LIST_SESSION_COOKIE_INVALID',
]);
const fixedCode = (error, fallback) =>
  FAILURE_CODES.has(error?.message) ? error.message : fallback;

/** Internal oracle stays in memory; identifiers, names, roles and addresses are never reported. */
export async function readDirectoryExpectation(runtime, fixture, signal) {
  const { rows } = await boundedQuery(
    runtime.admin,
    `SELECT u.id AS user_id,u.display_name,u.primary_email,u.status,u.deactivated_at,
      array_remove(array_agg(DISTINCT r.code),NULL) AS role_codes,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object('roleCode',r.code,'validUntil',rb.valid_until))
        FILTER (WHERE rb.valid_until IS NOT NULL),'[]'::jsonb) AS temporary_roles
    FROM app_user u JOIN role_binding rb ON rb.user_id=u.id AND rb.organization_id=$1
    LEFT JOIN role r ON r.id=rb.role_id
    WHERE rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now())
    GROUP BY u.id,u.display_name,u.primary_email,u.status,u.deactivated_at
    ORDER BY u.status,u.display_name`,
    [fixture.organizationId],
    signal,
  );
  check(rows.length === fixture.counts.users && rows.length > 0, 'DIRECTORY_FIXTURE_COUNT_INVALID');
  const members = new Map();
  const order = [];
  for (const row of rows) {
    check(
      typeof row.user_id === 'string' &&
        UUID.test(row.user_id) &&
        !members.has(row.user_id) &&
        typeof row.display_name === 'string' &&
        typeof row.primary_email === 'string' &&
        ['active', 'deactivated'].includes(row.status) &&
        Array.isArray(row.role_codes) &&
        row.role_codes.every((role) => ROLES.has(role)) &&
        Array.isArray(row.temporary_roles),
      'DIRECTORY_FIXTURE_DTO_INVALID',
    );
    const deactivatedAt =
      row.deactivated_at === null ? null : new Date(row.deactivated_at).toISOString();
    const temporaryRoles = row.temporary_roles.map((role) => {
      check(
        ROLES.has(role.roleCode) &&
          typeof role.validUntil === 'string' &&
          Number.isFinite(Date.parse(role.validUntil)),
        'DIRECTORY_FIXTURE_DTO_INVALID',
      );
      return { roleCode: role.roleCode, validUntil: new Date(role.validUntil).toISOString() };
    });
    members.set(row.user_id, {
      displayName: row.display_name,
      email: row.primary_email,
      status: row.status,
      deactivatedAt,
      roleCodes: [...new Set(row.role_codes)].sort(),
      temporaryRoles,
    });
    order.push({ status: row.status, displayName: row.display_name });
  }
  return { members, order };
}

/** Names with identical database sort keys may exchange positions; membership may not. */
export function validateDirectoryResponse(data, expected) {
  if (
    !data ||
    !Array.isArray(data.items) ||
    data.items.length !== expected.members.size ||
    data.items.length !== expected.order.length
  )
    return false;
  const seen = new Set();
  for (const [index, item] of data.items.entries()) {
    if (
      !item ||
      typeof item.userId !== 'string' ||
      !UUID.test(item.userId) ||
      seen.has(item.userId)
    )
      return false;
    const member = expected.members.get(item.userId);
    const order = expected.order[index];
    if (
      !member ||
      item.displayName !== member.displayName ||
      item.email !== member.email ||
      item.status !== member.status ||
      item.deactivatedAt !== member.deactivatedAt ||
      item.status !== order.status ||
      item.displayName !== order.displayName ||
      !Number.isSafeInteger(item.openTicketCount) ||
      item.openTicketCount < 0 ||
      !Array.isArray(item.roleCodes) ||
      item.roleCodes.length !== member.roleCodes.length ||
      new Set(item.roleCodes).size !== item.roleCodes.length ||
      [...item.roleCodes].sort().some((role, i) => role !== member.roleCodes[i]) ||
      !Array.isArray(item.temporaryRoles) ||
      item.temporaryRoles.length !== member.temporaryRoles.length
    )
      return false;
    const temporary = new Set();
    let lastUntil = '';
    for (const role of item.temporaryRoles) {
      if (!role || typeof role !== 'object') return false;
      const key = `${role.roleCode}:${role.validUntil}`;
      if (
        temporary.has(key) ||
        !member.temporaryRoles.some(
          (known) => known.roleCode === role.roleCode && known.validUntil === role.validUntil,
        ) ||
        !Number.isSafeInteger(role.daysRemaining) ||
        role.daysRemaining < 0 ||
        typeof role.expiringSoon !== 'boolean' ||
        role.validUntil < lastUntil
      )
        return false;
      temporary.add(key);
      lastUntil = role.validUntil;
    }
    seen.add(item.userId);
  }
  return seen.size === expected.members.size;
}

async function runApiProbes(runtime, fixture, profile, cookie, expected, signal) {
  const report = {
    completed: false,
    valid: false,
    cases: [],
    statefulProof:
      'Expired/deactivated/platform actor coverage is collected separately by the optional isolated security suite.',
  };
  try {
    const probe = async (key, session, expectedStatus, validate) => {
      check(!signal.aborted, 'DIRECTORY_ABORTED');
      const sample = await requestSample({
        base: runtime.apiBase,
        route: { key, path: DIRECTORY_LIST_PATH, kind: 'api', expectedStatus, check: validate },
        cookie: session,
        timeoutMs: profile.requestTimeoutMs,
        signal,
      });
      report.cases.push({ key, expectedStatus, valid: sample.outcome === 'success', sample });
    };
    await probe('directory-admin', cookie, 200, (data) =>
      validateDirectoryResponse(data, expected),
    );
    for (const role of ['requester', 'agent']) {
      const actor = fixture.actors.find((item) => item.role === role);
      check(actor, 'DIRECTORY_PROBE_ACTOR_REQUIRED');
      const session = await login(
        actor,
        fixture,
        runtime.apiBase,
        profile.requestTimeoutMs,
        signal,
      );
      await probe(`directory-${role}-denied`, session, 403, (data) => data?.status === 403);
    }
    await probe('directory-unauthenticated', '', 401, (data) => data?.status === 401);
    report.completed = true;
    report.valid = report.cases.every((item) => item.valid);
  } catch (error) {
    report.failureCode = signal.aborted
      ? 'DIRECTORY_ABORTED'
      : fixedCode(error, 'DIRECTORY_API_PROBES_FAILED');
  }
  return report;
}

/** Destructive synthetic setup is confined to the owned DB, after all measurements/analysis. */
export async function runDirectoryStateProbes({ runtime, fixture, profile, signal }) {
  const hardStop = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, hardStop]) : hardStop;
  const report = {
    completed: false,
    valid: false,
    cases: [],
    timing:
      'After comparison and SQL analysis; before isolated security suites; owned synthetic database only.',
    measuredFixtureUsers: fixture.counts.users,
  };
  const query = (text, values = []) => boundedQuery(runtime.admin, text, values, combined);
  try {
    assertLoopbackBase(runtime.apiBase);
    check(
      /^solvi_perf041_\d+_[a-f0-9]{12}$/.test(runtime.meta?.database ?? ''),
      'DIRECTORY_STATE_DATABASE_REJECTED',
    );
    const identity = await query('SELECT current_database() AS database');
    check(
      identity.rows[0]?.database === runtime.meta.database,
      'DIRECTORY_STATE_DATABASE_MISMATCH',
    );
    const actor = fixture.actors.find((item) => item.role === 'admin');
    check(
      actor && UUID.test(actor.userId) && UUID.test(fixture.organizationId),
      'DIRECTORY_STATE_ACTOR_INVALID',
    );
    const cookie = await login(actor, fixture, runtime.apiBase, profile.requestTimeoutMs, combined);
    // Keep organization membership while the administrator binding becomes expired.
    // These writes are test preparation, not evidence of the business mutation/audit path.
    await query('BEGIN');
    try {
      await query("SET LOCAL statement_timeout = '2s'");
      const membership = await query(
        `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source)
        SELECT gen_random_uuid(),$1,r.id,r.scope,$2,'seed' FROM role r WHERE r.code='requester'
        AND NOT EXISTS (SELECT 1 FROM role_binding rb WHERE rb.user_id=$1 AND rb.organization_id=$2 AND rb.role_id=r.id
          AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now())) RETURNING id`,
        [actor.userId, fixture.organizationId],
      );
      check(membership.rows.length <= 1, 'DIRECTORY_STATE_SETUP_INVALID');
      const expired = await query(
        `UPDATE role_binding rb SET valid_from=LEAST(rb.valid_from,now()-interval '2 minutes'),valid_until=now()-interval '1 minute'
        FROM role r WHERE rb.role_id=r.id AND r.code='org_admin' AND rb.user_id=$1 AND rb.organization_id=$2
        AND (rb.valid_until IS NULL OR rb.valid_until>now()) RETURNING rb.id`,
        [actor.userId, fixture.organizationId],
      );
      check(expired.rows.length === 1, 'DIRECTORY_STATE_SETUP_INVALID');
      await query('COMMIT');
      report.preparation = {
        organizationMembershipAdded: membership.rows.length,
        administratorBindingsExpired: expired.rows.length,
      };
    } catch (error) {
      await runtime.admin.query({ text: 'ROLLBACK', values: [], query_timeout: 2000 });
      throw error;
    }
    const probe = async (key, expectedStatus, validate) => {
      check(!combined.aborted, 'DIRECTORY_ABORTED');
      const sample = await requestSample({
        base: runtime.apiBase,
        route: { key, path: DIRECTORY_LIST_PATH, kind: 'api', expectedStatus, check: validate },
        cookie,
        timeoutMs: profile.requestTimeoutMs,
        signal: combined,
      });
      const valid = sample.outcome === 'success';
      report.cases.push({ key, expectedStatus, valid, sample });
      check(valid, 'DIRECTORY_STATE_RESPONSE_INVALID');
    };
    await probe('directory-expired-administrator', 403, (data) => data?.status === 403);
    const platform = await query(
      `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source)
      SELECT gen_random_uuid(),$1,id,scope,NULL,'seed' FROM role WHERE code='platform_admin' RETURNING id`,
      [actor.userId],
    );
    check(platform.rows.length === 1, 'DIRECTORY_STATE_SETUP_INVALID');
    report.preparation.platformBindingsAdded = platform.rows.length;
    const expected = await readDirectoryExpectation(runtime, fixture, combined);
    report.postPreparationRosterUsers = expected.members.size;
    await probe('directory-platform-administrator', 200, (data) =>
      validateDirectoryResponse(data, expected),
    );
    const stopped = await query(
      `UPDATE app_user SET status='deactivated',deactivated_at=now()
      WHERE id=$1 AND status='active' RETURNING id`,
      [actor.userId],
    );
    check(stopped.rows.length === 1, 'DIRECTORY_STATE_SETUP_INVALID');
    report.preparation.usersDeactivated = stopped.rows.length;
    await probe('directory-deactivated-administrator', 401, (data) => data?.status === 401);
    report.drain = await drain(runtime, combined);
    check(report.drain.drained, 'DIRECTORY_DRAIN_FAILED');
    report.completed = true;
    report.valid = true;
  } catch (error) {
    report.failureCode = combined.aborted
      ? 'DIRECTORY_ABORTED'
      : fixedCode(error, 'DIRECTORY_STATE_PROBES_FAILED');
  }
  return report;
}

async function boundedQuery(admin, text, values, signal) {
  if (signal.aborted) throw new Error('DIRECTORY_ABORTED');
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(new Error('DIRECTORY_ABORTED'));
  });
  signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    return await Promise.race([admin.query({ text, values, query_timeout: 2000 }), cancelled]);
  } finally {
    signal.removeEventListener('abort', rejectAbort);
  }
}

async function observePhase(runtime, signal, start) {
  const cancel = new AbortController();
  const combined = AbortSignal.any([signal, cancel.signal]);
  const pool = [];
  const database = [];
  let poolErrors = 0;
  let databaseErrors = 0;
  const loop = async (interval, read, collect, failed) => {
    let scheduled = performance.now();
    while (!combined.aborted) {
      try {
        const value = await read(signal);
        collect({ atMs: performance.now() - start, ...value });
      } catch {
        if (!combined.aborted) failed();
      }
      scheduled += interval;
      if (scheduled < performance.now()) scheduled = performance.now();
      try {
        await delay(Math.max(1, scheduled - performance.now()), undefined, { signal: combined });
      } catch {
        break;
      }
    }
  };
  const poolDone = loop(
    250,
    (s) => scrapePool(runtime.metricsBase, s),
    (sample) => pool.push({ atMs: sample.atMs, connections: sample.connections }),
    () => {
      poolErrors += 1;
    },
  );
  const dbDone = loop(
    500,
    async (s) => {
      const { rows } = await boundedQuery(
        runtime.admin,
        `SELECT count(*)::int AS connections,
      count(*) FILTER (WHERE state='active')::int AS active,
      count(*) FILTER (WHERE state='idle in transaction')::int AS idle_in_transaction,
      count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiting
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`,
        [],
        s,
      );
      const row = rows[0];
      check(
        row &&
          ['connections', 'active', 'idle_in_transaction', 'lock_waiting'].every(
            (key) => Number.isSafeInteger(row[key]) && row[key] >= 0,
          ),
        'DIRECTORY_DB_SAMPLE_INVALID',
      );
      return {
        connections: row.connections,
        active: row.active,
        idleInTransaction: row.idle_in_transaction,
        lockWaiting: row.lock_waiting,
      };
    },
    (sample) => database.push(sample),
    () => {
      databaseErrors += 1;
    },
  );
  return {
    pool,
    async stop() {
      cancel.abort();
      await Promise.all([poolDone, dbDone]);
      return {
        poolIntervalMs: 250,
        databaseIntervalMs: 500,
        pool,
        database,
        poolErrors,
        databaseErrors,
      };
    },
  };
}

export async function runDirectoryComparison({
  runtime,
  fixture,
  profile,
  signal,
  onProgress = () => {},
}) {
  const report = {
    comparisonCompleted: false,
    allRequestsSucceeded: false,
    model:
      'same organization administrator principal; fixed simultaneous arrival schedule; A=one session, B=distinct sessions; not 100 distinct users or production acceptance',
    interpretation:
      'comparison completion is separate from HTTP/DTO/transport success; latencies are measurements without a burst SLO threshold',
    loginCompleted: 0,
    phases: [],
  };
  const hardStop = AbortSignal.timeout(MAX_COMPARISON_MS);
  const combined = signal ? AbortSignal.any([signal, hardStop]) : hardStop;
  try {
    validateProfile(profile);
    check(['smoke', 'baseline', 'growth'].includes(profile.name), 'DIRECTORY_PROFILE_INVALID');
    const count = profile.name === 'smoke' ? 12 : 100;
    check(profile.activeSessions === count, 'DIRECTORY_PROFILE_SESSION_COUNT_INVALID');
    runtime = {
      ...runtime,
      apiBase: assertLoopbackBase(runtime.apiBase),
      metricsBase: assertLoopbackBase(runtime.metricsBase),
    };
    const actor = fixture.actors.find((candidate) => candidate.role === 'admin');
    check(actor, 'DIRECTORY_ADMIN_REQUIRED');
    const expected = await readDirectoryExpectation(runtime, fixture, combined);
    const route = {
      key: 'api-directory-list',
      path: DIRECTORY_LIST_PATH,
      kind: 'api',
      check: (data) => validateDirectoryResponse(data, expected),
    };
    report.directoryContract = {
      members: expected.members.size,
      path: DIRECTORY_LIST_PATH,
      roster:
        'Exact organization membership, status, identity fields, active roles and database name order; nonnegative integer assignment counts.',
      countEquivalence:
        'Exact old/new assignment count values are verified separately by the SQL/service analysis.',
    };
    report.principal = { role: 'org_admin', count: 1, organizationCount: 1 };
    report.route = { key: route.key, path: route.path };
    report.schedule = Array.from({ length: profile.name === 'smoke' ? 1 : 2 }, () => [
      'A',
      'B',
      'B',
      'A',
    ]).flat();
    report.requestsPerPhase = count;
    report.plannedArrivalOffsetsMs = Array(count).fill(0);
    report.hardCapMs = MAX_COMPARISON_MS;
    const cookies = [];
    await onProgress('comparison-login');
    for (let index = 0; index < count; index += 1) {
      check(!combined.aborted, 'DIRECTORY_ABORTED');
      cookies.push(
        await login(actor, fixture, runtime.apiBase, profile.requestTimeoutMs, combined),
      );
      report.loginCompleted += 1;
    }
    report.sessionVerification = await verifySessions(
      runtime.admin,
      actor,
      fixture,
      cookies,
      combined,
    );
    check(report.sessionVerification.verified, 'DIRECTORY_SESSION_CARDINALITY_INVALID');
    report.initialDrain = await drain(runtime, combined);
    check(report.initialDrain.drained, 'DIRECTORY_DRAIN_FAILED');
    for (const [index, mode] of report.schedule.entries()) {
      check(!combined.aborted, 'DIRECTORY_ABORTED');
      await onProgress(`comparison-phase-${index + 1}-${mode}`);
      const phase = {
        index: index + 1,
        mode,
        sessionCount: mode === 'A' ? 1 : count,
        startedAt: new Date().toISOString(),
        observationValid: false,
      };
      report.phases.push(phase);
      let observer;
      try {
        phase.poolBefore = await scrapePool(runtime.metricsBase, combined);
        const start = performance.now();
        observer = await observePhase(runtime, combined, start);
        phase.burst = await runBurst({
          count,
          signal: combined,
          send: (requestIndex) =>
            requestSample({
              base: runtime.apiBase,
              route,
              cookie: cookies[mode === 'A' ? 0 : requestIndex],
              timeoutMs: profile.requestTimeoutMs,
              signal: combined,
            }),
        });
        phase.drain = await drain(runtime, combined, observer.pool);
        check(phase.drain.drained, 'DIRECTORY_DRAIN_FAILED');
        phase.poolAfter = await scrapePool(runtime.metricsBase, combined);
        phase.poolDelta = poolDifference(phase.poolBefore, phase.poolAfter);
      } catch (error) {
        phase.failureCode = fixedCode(error, 'DIRECTORY_PHASE_FAILED');
        throw error;
      } finally {
        if (observer) phase.observations = await observer.stop();
        phase.finishedAt = new Date().toISOString();
      }
      phase.observationValid =
        phase.poolDelta?.valid === true &&
        phase.poolDelta.success.count + phase.poolDelta.failure.count > 0 &&
        phase.observations.poolErrors === 0 &&
        phase.observations.databaseErrors === 0 &&
        phase.observations.pool.length > 0 &&
        phase.observations.database.length > 0;
      check(phase.observationValid, 'DIRECTORY_OBSERVATION_INVALID');
      check(
        phase.burst.unsent === 0 && phase.burst.unfinished === 0 && phase.burst.aborted === 0,
        'DIRECTORY_INCOMPLETE',
      );
    }
    report.comparisonCompleted =
      report.phases.length === report.schedule.length && !combined.aborted;
    report.allRequestsSucceeded =
      report.comparisonCompleted &&
      report.phases.every((phase) => phase.burst.successes === phase.burst.planned);
    await onProgress('directory-api-probes');
    report.apiProbes = await runApiProbes(
      runtime,
      fixture,
      profile,
      cookies[0],
      expected,
      combined,
    );
    report.apiContractValid = report.apiProbes.completed && report.apiProbes.valid;
    report.probeDrain = await drain(runtime, combined);
    check(report.probeDrain.drained, 'DIRECTORY_DRAIN_FAILED');
    check(!combined.aborted, 'DIRECTORY_ABORTED');
  } catch (error) {
    report.comparisonCompleted = false;
    report.allRequestsSucceeded = false;
    report.failureCode = hardStop.aborted
      ? 'DIRECTORY_HARD_CAP'
      : combined.aborted
        ? 'DIRECTORY_ABORTED'
        : fixedCode(error, 'DIRECTORY_COMPARISON_FAILED');
  }
  return report;
}
