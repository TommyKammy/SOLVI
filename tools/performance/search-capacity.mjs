import { assertLoopbackBase, login, requestSample } from './workload.mjs';
import { getProfile } from './profiles.mjs';
import {
  drain,
  observePhase,
  poolDifference,
  runBurst,
  scrapePool,
  validateSearchResponse,
  verifySearchApiContract,
  verifySessions,
} from './list-load.mjs';
import { sanitizeReadOnlyProof } from './list-query-analysis.mjs';

export const MAX_SEARCH_CAPACITY_MS = 600_000;
export const SEARCH_TERMS = Object.freeze([
  Object.freeze({ key: 'short', keyword: '合' }),
  Object.freeze({ key: 'wide', keyword: '合成性能問い合わせ 1' }),
  Object.freeze({ key: 'rare', keyword: null }),
  Object.freeze({ key: 'zero', keyword: 'WP047不存在query-a879ef' }),
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CODES = new Set([
  'CAPACITY_ABORTED',
  'CAPACITY_HARD_CAP',
  'CAPACITY_PROFILE_INVALID',
  'CAPACITY_FIXTURE_INVALID',
  'CAPACITY_BINDING_INVALID',
  'CAPACITY_ORACLE_INVALID',
  'CAPACITY_DRAIN_FAILED',
  'CAPACITY_OBSERVATION_INVALID',
  'CAPACITY_INCOMPLETE',
  'CAPACITY_SESSION_INVALID',
  'CAPACITY_PREFLIGHT_INVALID',
  'CAPACITY_CONTRACT_INVALID',
]);
const check = (ok, code) => {
  if (!ok) throw new Error(code);
};
const safeCode = (error) => (CODES.has(error?.message) ? error.message : 'CAPACITY_FAILED');

function fixedProfile(profile) {
  const expected = getProfile(profile?.name);
  check(
    Object.keys(profile).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) =>
        key === 'roles'
          ? Object.keys(profile.roles ?? {}).length === 3 &&
            Object.entries(value).every(([role, count]) => profile.roles[role] === count)
          : profile[key] === value,
      ),
    'CAPACITY_PROFILE_INVALID',
  );
  return expected;
}

/** Two fixed passes expose order/warm-cache effects without changing resources or the dataset. */
export function searchCapacitySchedule(profile) {
  const fixed = fixedProfile(profile);
  const levels = fixed.name === 'smoke' ? [3, 6, 9, 12] : [10, 25, 50, 100];
  return ['ascending', 'descending'].flatMap((pass) =>
    (pass === 'ascending' ? levels : [...levels].reverse()).flatMap((count) =>
      (pass === 'ascending' ? SEARCH_TERMS : [...SEARCH_TERMS].reverse()).map(({ key }) => ({
        pass,
        count,
        term: key,
      })),
    ),
  );
}

export function searchCapacityPath(keyword) {
  check(
    typeof keyword === 'string' &&
      (SEARCH_TERMS.some((term) => term.keyword === keyword) || /^PERF041-\d{7}$/.test(keyword)),
    'CAPACITY_FIXTURE_INVALID',
  );
  return `/tickets?limit=50&sort=newest&keyword=${encodeURIComponent(keyword)}`;
}

/** Synthetic values remain private; callers may persist only the term keys and sanitized proof. */
export async function discoverSearchTerms(runtime, fixture, signal) {
  const actor = fixture?.actors?.find((value) => value.role === 'agent');
  check(
    actor && [actor.userId, actor.ticketId, fixture.organizationId].every((id) => UUID.test(id)),
    'CAPACITY_FIXTURE_INVALID',
  );
  check(!signal?.aborted, 'CAPACITY_ABORTED');
  return runtime.withAppReadOnly(
    { organizationId: fixture.organizationId, actorId: actor.userId },
    async (client) => {
      const proof = sanitizeReadOnlyProof(client.proof);
      const bindings = await client.query(
        "SELECT r.code FROM role_binding rb JOIN role r ON r.id=rb.role_id JOIN app_user u ON u.id=rb.user_id WHERE rb.organization_id=$1 AND rb.user_id=$2 AND r.code='agent' AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now()) AND u.status='active'",
        [fixture.organizationId, actor.userId],
      );
      check(
        bindings.rows.some((row) => row.code === 'agent'),
        'CAPACITY_BINDING_INVALID',
      );
      const result = await client.query(
        'SELECT number FROM ticket WHERE organization_id=$1 AND id=$2',
        [fixture.organizationId, actor.ticketId],
      );
      check(
        result.rows.length === 1 && /^PERF041-\d{7}$/.test(result.rows[0].number),
        'CAPACITY_FIXTURE_INVALID',
      );
      check(!signal?.aborted, 'CAPACITY_ABORTED');
      return {
        proof,
        terms: SEARCH_TERMS.map((term) => ({
          ...term,
          keyword: term.keyword ?? result.rows[0].number,
        })),
      };
    },
  );
}

async function readOracles(runtime, fixture, terms, signal) {
  const actor = fixture.actors.find((value) => value.role === 'agent');
  return runtime.withAppReadOnly(
    { organizationId: fixture.organizationId, actorId: actor.userId },
    async (client) => {
      const proof = sanitizeReadOnlyProof(client.proof);
      const oracles = new Map();
      for (const term of terms) {
        check(!signal.aborted, 'CAPACITY_ABORTED');
        // All allowed terms are literal synthetic inputs; still escape the ILIKE metacharacters.
        const pattern = `%${term.keyword.replace(/[\\%_]/g, '\\$&')}%`;
        const values = [fixture.organizationId, pattern];
        const counts = await client.query(
          'SELECT count(*)::int AS total FROM ticket WHERE organization_id=$1 AND search_text ILIKE $2',
          values,
        );
        const page = await client.query(
          'SELECT id::text, created_at::text AS cursor_created_at FROM ticket WHERE organization_id=$1 AND search_text ILIKE $2 ORDER BY created_at DESC,id DESC LIMIT 50',
          values,
        );
        const total = counts.rows[0]?.total;
        check(
          counts.rows.length === 1 &&
            Number.isSafeInteger(total) &&
            total >= 0 &&
            page.rows.length === Math.min(50, total) &&
            new Set(page.rows.map((row) => row.id)).size === page.rows.length &&
            page.rows.every(
              (row) =>
                UUID.test(row.id) &&
                typeof row.cursor_created_at === 'string' &&
                Number.isFinite(Date.parse(row.cursor_created_at)),
            ),
          'CAPACITY_ORACLE_INVALID',
        );
        check(
          term.key === 'zero' ? total === 0 : term.key === 'rare' ? total === 1 : total > 50,
          'CAPACITY_ORACLE_INVALID',
        );
        const last = page.rows.at(-1);
        oracles.set(term.key, {
          scope: 'organization',
          keyword: term.keyword,
          total,
          ids: page.rows.map((row) => row.id),
          cursor:
            page.rows.length === 50 ? { id: last.id, createdAt: last.cursor_created_at } : null,
        });
      }
      return { proof, oracles };
    },
  );
}

export async function runSearchCapacity({
  runtime,
  fixture,
  profile,
  signal,
  onProgress = () => {},
}) {
  const start = performance.now();
  const hardStop = AbortSignal.timeout(MAX_SEARCH_CAPACITY_MS);
  const combined = signal ? AbortSignal.any([signal, hardStop]) : hardStop;
  const report = {
    completed: false,
    allRequestsSucceeded: false,
    apiContractValid: false,
    model:
      'Same agent principal and organization, independent real sessions, fixed simultaneous API arrivals; not distinct users or active-browser capacity.',
    interpretation:
      'Successful-response latency excludes failed requests; completion, API contract, and all-request success are separate.',
    loginCompleted: 0,
    hardCapMs: MAX_SEARCH_CAPACITY_MS,
    phases: [],
    preflight: [],
  };
  try {
    check(!combined.aborted, 'CAPACITY_ABORTED');
    const fixed = fixedProfile(profile);
    const schedule = searchCapacitySchedule(fixed);
    const count = fixed.activeSessions;
    runtime = {
      ...runtime,
      apiBase: assertLoopbackBase(runtime.apiBase),
      metricsBase: assertLoopbackBase(runtime.metricsBase),
    };
    report.scope =
      fixed.name === 'smoke'
        ? 'reduced synthetic smoke: 3/6/9/12 arrivals'
        : '10/25/50/100 simultaneous arrivals';
    report.schedule = schedule;
    report.plannedRequests = schedule.reduce((sum, phase) => sum + phase.count, 0);
    const discovery = await discoverSearchTerms(runtime, fixture, combined);
    report.bindingProof = discovery.proof;
    const { proof, oracles } = await readOracles(runtime, fixture, discovery.terms, combined);
    report.oracleProof = proof;
    report.searchContracts = discovery.terms.map(({ key }) => ({
      term: key,
      total: oracles.get(key).total,
      limit: 50,
      scope: 'organization',
      sort: 'created_at DESC,id DESC',
    }));
    const routes = new Map(
      discovery.terms.map(({ key, keyword }) => [
        key,
        {
          key: `api-search-${key}`,
          kind: 'api',
          path: searchCapacityPath(keyword),
          check: (data) => validateSearchResponse(data, oracles.get(key)),
        },
      ]),
    );
    const actor = fixture.actors.find((value) => value.role === 'agent');
    const cookies = [];
    await onProgress('capacity-login');
    for (let i = 0; i < count; i += 1) {
      check(!combined.aborted, 'CAPACITY_ABORTED');
      cookies.push(await login(actor, fixture, runtime.apiBase, fixed.requestTimeoutMs, combined));
      report.loginCompleted += 1;
    }
    report.sessionVerification = await verifySessions(
      runtime.admin,
      actor,
      fixture,
      cookies,
      combined,
    );
    check(report.sessionVerification.verified, 'CAPACITY_SESSION_INVALID');
    for (const route of routes.values()) {
      const sample = await requestSample({
        base: runtime.apiBase,
        route,
        cookie: cookies[0],
        timeoutMs: fixed.requestTimeoutMs,
        signal: combined,
      });
      report.preflight.push({
        term: route.key.slice('api-search-'.length),
        sample,
        valid: sample.outcome === 'success',
      });
      check(sample.outcome === 'success', 'CAPACITY_PREFLIGHT_INVALID');
    }
    report.apiProbes = await verifySearchApiContract(runtime, fixture, fixed, cookies[0], combined);
    report.apiContractValid = report.apiProbes.completed && report.apiProbes.valid;
    check(report.apiContractValid, 'CAPACITY_CONTRACT_INVALID');
    report.initialDrain = await drain(runtime, combined);
    check(report.initialDrain.drained, 'CAPACITY_DRAIN_FAILED');
    for (const [index, entry] of schedule.entries()) {
      check(!combined.aborted, 'CAPACITY_ABORTED');
      await onProgress(`capacity-wave-${index + 1}-${entry.term}-${entry.count}`);
      const phase = {
        index: index + 1,
        ...entry,
        sessionCount: entry.count,
        startedAt: new Date().toISOString(),
        observationValid: false,
      };
      report.phases.push(phase);
      let observer;
      try {
        phase.poolBefore = await scrapePool(runtime.metricsBase, combined);
        observer = await observePhase(runtime, combined, performance.now());
        phase.burst = await runBurst({
          count: entry.count,
          signal: combined,
          send: (i) =>
            requestSample({
              base: runtime.apiBase,
              route: routes.get(entry.term),
              cookie: cookies[i],
              timeoutMs: fixed.requestTimeoutMs,
              signal: combined,
            }),
        });
        phase.drain = await drain(runtime, combined);
        check(phase.drain.drained, 'CAPACITY_DRAIN_FAILED');
        phase.poolAfter = await scrapePool(runtime.metricsBase, combined);
        phase.poolDelta = poolDifference(phase.poolBefore, phase.poolAfter);
      } catch (error) {
        phase.failureCode = safeCode(error);
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
      check(phase.observationValid, 'CAPACITY_OBSERVATION_INVALID');
      check(
        phase.burst.unsent === 0 && phase.burst.unfinished === 0 && phase.burst.aborted === 0,
        'CAPACITY_INCOMPLETE',
      );
    }
    report.completed = report.phases.length === schedule.length && !combined.aborted;
    report.allRequestsSucceeded =
      report.completed &&
      report.phases.every((phase) => phase.burst.successes === phase.burst.planned);
  } catch (error) {
    report.failureCode = hardStop.aborted
      ? 'CAPACITY_HARD_CAP'
      : combined.aborted
        ? 'CAPACITY_ABORTED'
        : safeCode(error);
  }
  report.elapsedMs = performance.now() - start;
  return report;
}
