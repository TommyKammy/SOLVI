import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  actorRoutes,
  assertLoopbackBase,
  login,
  percentile,
  requestSample,
  summarizeSamples,
  validateProfile,
} from './workload.mjs';

export const MAX_COMPARISON_MS = 180_000;
export const DEADLINE_LIST_PATH =
  '/tickets?limit=50&sort=deadline&state=new&state=assigned&state=in_progress';
export const SEARCH_KEYWORD = '合成性能問い合わせ 1';
export const SEARCH_LIST_PATH = `/tickets?limit=50&sort=newest&keyword=${encodeURIComponent(SEARCH_KEYWORD)}`;
const DEADLINE_STATES = ['new', 'assigned', 'in_progress'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METRICS_BYTES = 1024 * 1024;
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const histogram = () => ({ count: 0, sumMs: 0, buckets: [] });
const FAILURE_CODES = new Set([
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
  'LIST_SEARCH_FIXTURE_INVALID',
  'LIST_SEARCH_PROBES_FAILED',
  'LIST_SEARCH_PROBE_ACTOR_REQUIRED',
  'LIST_SESSIONS_NOT_DISTINCT',
  'LIST_SESSION_CARDINALITY_INVALID',
  'LIST_SESSION_COOKIE_INVALID',
  'LIST_STATE_WORK_PACKAGE_INVALID',
  'LIST_STATE_FIXTURE_INVALID',
  'LIST_STATE_PROBES_FAILED',
]);
const fixedCode = (error, fallback) =>
  FAILURE_CODES.has(error?.message) ? error.message : fallback;

/** Each response has its own database clock. Never compare SLA values across responses. */
export function validateDeadlineResponse(data, { scope, total, allowedIds, nullSla = false }) {
  if (
    !data ||
    data.scope !== scope ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    data.total !== total ||
    !Array.isArray(data.items) ||
    data.items.length !== Math.min(50, total) ||
    !Array.isArray(data.appliedFilter?.state) ||
    data.appliedFilter.state.length !== 3 ||
    !DEADLINE_STATES.every((state) => data.appliedFilter.state.includes(state))
  )
    return false;
  const ids = new Set();
  let previous;
  for (const item of data.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !UUID.test(item.id) ||
      ids.has(item.id) ||
      (allowedIds && !allowedIds.has(item.id)) ||
      typeof item.number !== 'string' ||
      item.number.length === 0 ||
      !['incident', 'request'].includes(item.kind) ||
      !DEADLINE_STATES.includes(item.state) ||
      typeof item.subject !== 'string' ||
      item.subject.length === 0 ||
      typeof item.body !== 'string' ||
      !['low', 'medium', 'high'].includes(item.impact) ||
      !['low', 'medium', 'high'].includes(item.urgency) ||
      !['low', 'medium', 'high', 'critical'].includes(item.priority) ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      !(
        item.resolvedAt === null ||
        (typeof item.resolvedAt === 'string' && Number.isFinite(Date.parse(item.resolvedAt)))
      ) ||
      typeof item.assigned !== 'boolean' ||
      !item.sla ||
      !(
        item.sla.remainingSeconds === null ||
        (typeof item.sla.remainingSeconds === 'number' &&
          Number.isFinite(item.sla.remainingSeconds))
      ) ||
      typeof item.sla.breached !== 'boolean' ||
      item.sla.breached !== (item.sla.remainingSeconds !== null && item.sla.remainingSeconds < 0) ||
      (nullSla && item.sla.remainingSeconds !== null)
    )
      return false;
    for (const field of ['assigneeName', 'assigneeGroupName', 'requesterName']) {
      if (
        scope === 'own'
          ? Object.hasOwn(item, field)
          : !(item[field] === null || typeof item[field] === 'string')
      )
        return false;
    }
    const remaining = item.sla.remainingSeconds;
    if (previous) {
      const prior = previous.sla.remainingSeconds;
      if (
        (prior === null && remaining !== null) ||
        (prior !== null && remaining !== null && prior > remaining) ||
        (prior === remaining && previous.id >= item.id)
      )
        return false;
    }
    ids.add(item.id);
    previous = item;
  }
  if (data.items.length === 50) {
    if (
      !data.nextCursor ||
      data.nextCursor.id !== previous.id ||
      typeof data.nextCursor.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(data.nextCursor.createdAt))
    )
      return false;
  } else if (data.nextCursor !== null) return false;
  return true;
}

function deadlineTotal(fixture) {
  const states = fixture.counts.states;
  check(
    Array.isArray(states) &&
      states.length > 0 &&
      new Set(states.map((row) => row.state)).size === states.length &&
      states.every((row) => Number.isSafeInteger(row.n) && row.n >= 0) &&
      states.reduce((sum, row) => sum + row.n, 0) === fixture.counts.tickets,
    'LIST_DEADLINE_FIXTURE_INVALID',
  );
  const total = states
    .filter((row) => DEADLINE_STATES.includes(row.state))
    .reduce((sum, row) => sum + row.n, 0);
  check(total >= 50, 'LIST_DEADLINE_FIXTURE_INVALID');
  return total;
}

/** The SQL oracle stays private; only its count is written to the report. */
function searchPage(rows, offset = 0, keyword = SEARCH_KEYWORD) {
  const page = rows.slice(offset, offset + 50);
  const last = page.at(-1);
  return {
    total: rows.length,
    keyword,
    ids: page.map((row) => row.id),
    cursor: page.length === 50 ? { id: last.id, createdAt: last.cursor_created_at } : null,
  };
}

async function readSearchRows(runtime, fixture, signal, requesterId = null) {
  const { rows } = await boundedQuery(
    runtime.admin,
    `SELECT id::text, created_at::text AS cursor_created_at FROM ticket
     WHERE organization_id=$1 AND search_text ILIKE $2
       AND ($3::uuid IS NULL OR requester_id=$3)
     ORDER BY created_at DESC, id DESC`,
    [fixture.organizationId, `%${SEARCH_KEYWORD}%`, requesterId],
    signal,
  );
  return checkedSearchRows(rows);
}

function checkedSearchRows(rows) {
  check(
    Array.isArray(rows) &&
      new Set(rows.map((row) => row.id)).size === rows.length &&
      rows.every(
        (row) =>
          typeof row.id === 'string' &&
          UUID.test(row.id) &&
          typeof row.cursor_created_at === 'string' &&
          Number.isFinite(Date.parse(row.cursor_created_at)),
      ),
    'LIST_SEARCH_FIXTURE_INVALID',
  );
  return rows;
}

export function validateSearchResponse(data, { scope, total, keyword, ids, cursor }) {
  if (
    !data ||
    data.scope !== scope ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    data.total !== total ||
    data.appliedFilter?.keyword !== keyword ||
    !Array.isArray(ids) ||
    !Array.isArray(data.items) ||
    data.items.length !== ids.length ||
    ids.length > Math.min(50, total) ||
    (ids.length === 50 ? !cursor || cursor.id !== ids.at(-1) : cursor !== null) ||
    new Set(ids).size !== ids.length
  )
    return false;
  for (const [index, item] of data.items.entries()) {
    if (
      !item ||
      item.id !== ids[index] ||
      !UUID.test(item.id) ||
      typeof item.number !== 'string' ||
      !item.number ||
      !['incident', 'request'].includes(item.kind) ||
      ![
        'new',
        'assigned',
        'in_progress',
        'pending',
        'resolved',
        'closed',
        'cancelled',
        'merged',
      ].includes(item.state) ||
      typeof item.subject !== 'string' ||
      !item.subject ||
      typeof item.body !== 'string' ||
      !['low', 'medium', 'high'].includes(item.impact) ||
      !['low', 'medium', 'high'].includes(item.urgency) ||
      !['low', 'medium', 'high', 'critical'].includes(item.priority) ||
      typeof item.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      !(
        item.resolvedAt === null ||
        (typeof item.resolvedAt === 'string' && Number.isFinite(Date.parse(item.resolvedAt)))
      ) ||
      typeof item.assigned !== 'boolean' ||
      !item.sla ||
      !(
        item.sla.remainingSeconds === null ||
        (typeof item.sla.remainingSeconds === 'number' &&
          Number.isFinite(item.sla.remainingSeconds))
      ) ||
      typeof item.sla.breached !== 'boolean' ||
      item.sla.breached !== (item.sla.remainingSeconds !== null && item.sla.remainingSeconds < 0)
    )
      return false;
    for (const field of ['assigneeName', 'assigneeGroupName', 'requesterName'])
      if (
        scope === 'own'
          ? Object.hasOwn(item, field)
          : !(item[field] === null || typeof item[field] === 'string')
      )
        return false;
  }
  return cursor === null
    ? data.nextCursor === null
    : data.nextCursor?.id === cursor.id && data.nextCursor?.createdAt === cursor.createdAt;
}

/** Existing fixed public search contract, reused by later isolated diagnostics. */
export async function verifySearchApiContract(runtime, fixture, profile, cookie, signal) {
  const rows = await readSearchRows(runtime, fixture, signal);
  check(rows.length > 50, 'LIST_SEARCH_FIXTURE_INVALID');
  return searchProbes(runtime, fixture, profile, cookie, signal, rows);
}

/** WP049 correctness probes only: fixed terms/states, real API, no arrival waves. */
export async function runSearchStateApiContract({ runtime, fixture, profile, signal }) {
  const result = { completed: false, valid: false, capacityMeasured: false, cases: [] };
  const timeout = AbortSignal.timeout(MAX_COMPARISON_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    check(runtime.meta?.workPackage === 'WP-P2-PERF-049', 'LIST_STATE_WORK_PACKAGE_INVALID');
    validateProfile(profile);
    runtime = {
      ...runtime,
      apiBase: assertLoopbackBase(runtime.apiBase),
      metricsBase: assertLoopbackBase(runtime.metricsBase),
    };
    check(!combined.aborted, 'LIST_ABORTED');
    const agent = fixture.actors.find((actor) => actor.role === 'agent');
    const requester = fixture.actors.find((actor) => actor.role === 'requester');
    const admin = fixture.actors.find((actor) => actor.role === 'admin');
    check(
      agent && requester && admin && agent.userId !== requester.userId,
      'LIST_SEARCH_PROBE_ACTOR_REQUIRED',
    );
    const agentCookie = await login(
      agent,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      combined,
    );
    const existing = await verifySearchApiContract(
      runtime,
      fixture,
      profile,
      agentCookie,
      combined,
    );
    result.cases.push(...existing.cases);
    check(existing.completed && existing.valid, 'LIST_STATE_PROBES_FAILED');
    const readStates = async (states, requesterId = null, keyword = '合') => {
      const rows = await boundedQuery(
        runtime.admin,
        `SELECT id::text, created_at::text AS cursor_created_at FROM ticket
         WHERE organization_id=$1 AND search_text ILIKE $2
           AND ($3::uuid IS NULL OR requester_id=$3) AND state=ANY($4::text[])
         ORDER BY created_at DESC,id DESC`,
        [fixture.organizationId, `%${keyword}%`, requesterId, states],
        combined,
      );
      return checkedSearchRows(rows.rows);
    };
    const state = ['new'];
    const multi = ['new', 'assigned'];
    const duplicate = ['new', 'new'];
    const rows = await readStates(state);
    const own = await readStates(state, requester.userId);
    const many = await readStates(multi);
    const missing = 'isolated-missing-state-049';
    const empty = await readStates(state, null, missing);
    check(
      rows.length > 50 && many.length >= rows.length && empty.length === 0,
      'LIST_STATE_FIXTURE_INVALID',
    );
    result.population = {
      organizationState: rows.length,
      requesterState: own.length,
      multiState: many.length,
      empty: empty.length,
    };
    const foreign = await boundedQuery(
      runtime.admin,
      'SELECT id::text FROM assignment_group WHERE organization_id=$1 ORDER BY id LIMIT 1',
      [fixture.controlOrganizationId],
      combined,
    );
    check(UUID.test(foreign.rows[0]?.id ?? ''), 'LIST_STATE_FIXTURE_INVALID');
    const requesterCookie = await login(
      requester,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      combined,
    );
    const adminCookie = await login(
      admin,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      combined,
    );
    const route = (states, keyword = '合') => {
      const query = new URLSearchParams({ limit: '50', sort: 'newest', keyword });
      for (const value of states) query.append('state', value);
      return `/tickets?${query}`;
    };
    const cursor = (row) =>
      new URLSearchParams({ cursorId: row.id, cursorCreatedAt: row.cursor_created_at });
    const validate =
      (scope, expectedRows, states, offset = 0, keyword = '合', noRows = false) =>
      (data) => {
        const expected = searchPage(expectedRows, offset, keyword);
        if (noRows) {
          expected.ids = [];
          expected.cursor = null;
        }
        return (
          validateSearchResponse(data, { scope, ...expected }) &&
          Array.isArray(data.appliedFilter?.state) &&
          data.appliedFilter.state.length === states.length &&
          states.every((value, index) => data.appliedFilter.state[index] === value) &&
          data.items.every((item) => states.includes(item.state))
        );
      };
    const probe = async (key, path, cookie, expectedStatus, validator) => {
      check(!combined.aborted, 'LIST_ABORTED');
      const sample = await requestSample({
        base: runtime.apiBase,
        route: { key, path, kind: 'api', expectedStatus, check: validator },
        cookie,
        timeoutMs: profile.requestTimeoutMs,
        signal: combined,
      });
      result.cases.push({ key, expectedStatus, valid: sample.outcome === 'success', sample });
    };
    await probe(
      'state-agent-newest',
      route(state),
      agentCookie,
      200,
      validate('organization', rows, state),
    );
    await probe(
      'state-admin-newest',
      route(state),
      adminCookie,
      200,
      validate('organization', rows, state),
    );
    await probe(
      'state-next-page',
      `${route(state)}&${cursor(rows[49])}`,
      agentCookie,
      200,
      validate('organization', rows, state, 50),
    );
    await probe(
      'state-terminal-page',
      `${route(state)}&${cursor(rows.at(-1))}`,
      agentCookie,
      200,
      validate('organization', rows, state, rows.length, '合', true),
    );
    await probe(
      'state-requester-own',
      route(state),
      requesterCookie,
      200,
      validate('own', own, state),
    );
    await probe(
      'state-requester-other',
      `${route(state)}&requester=${agent.userId}`,
      requesterCookie,
      200,
      validate('own', [], state),
    );
    await probe(
      'state-multiple',
      route(multi),
      agentCookie,
      200,
      validate('organization', many, multi),
    );
    await probe(
      'state-duplicate',
      route(duplicate),
      agentCookie,
      200,
      validate('organization', rows, duplicate),
    );
    await probe(
      'state-empty',
      route(state, missing),
      agentCookie,
      200,
      validate('organization', [], state, 0, missing),
    );
    await probe(
      'state-foreign-group',
      `${route(state)}&group=${foreign.rows[0].id}`,
      agentCookie,
      200,
      validate('organization', [], state),
    );
    await probe('state-unauthenticated', route(state), '', 401, (data) => data?.status === 401);
    await probe(
      'state-invalid',
      route(['invalid']),
      agentCookie,
      400,
      (data) => data?.status === 400,
    );
    // created_at ASC exists only in the internal builder, not the public list API.
    await probe(
      'state-unsupported-asc',
      route(state).replace('sort=newest', 'sort=asc'),
      agentCookie,
      400,
      (data) => data?.status === 400,
    );
    result.drain = await drain(runtime, combined);
    check(result.drain.drained, 'LIST_DRAIN_FAILED');
    result.completed = true;
    result.valid = result.cases.every((item) => item.valid);
  } catch (error) {
    result.failureCode = timeout.aborted
      ? 'LIST_HARD_CAP'
      : combined.aborted
        ? 'LIST_ABORTED'
        : fixedCode(error, 'LIST_STATE_PROBES_FAILED');
  }
  return result;
}

async function searchProbes(runtime, fixture, profile, agentCookie, signal, rows) {
  const result = { completed: false, valid: false, cases: [] };
  try {
    const requester = fixture.actors.find((actor) => actor.role === 'requester');
    const admin = fixture.actors.find((actor) => actor.role === 'admin');
    check(requester && admin, 'LIST_SEARCH_PROBE_ACTOR_REQUIRED');
    const own = await readSearchRows(runtime, fixture, signal, requester.userId);
    const foreign = await boundedQuery(
      runtime.admin,
      'SELECT id::text FROM assignment_group WHERE organization_id=$1 ORDER BY id LIMIT 1',
      [fixture.controlOrganizationId],
      signal,
    );
    check(UUID.test(foreign.rows[0]?.id ?? ''), 'LIST_SEARCH_FIXTURE_INVALID');
    const requesterCookie = await login(
      requester,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      signal,
    );
    const adminCookie = await login(
      admin,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      signal,
    );
    const probe = async (key, path, cookie, expectedStatus, validate) => {
      check(!signal.aborted, 'LIST_ABORTED');
      const sample = await requestSample({
        base: runtime.apiBase,
        route: { key, path, kind: 'api', expectedStatus, check: validate },
        cookie,
        timeoutMs: profile.requestTimeoutMs,
        signal,
      });
      result.cases.push({ key, expectedStatus, valid: sample.outcome === 'success', sample });
    };
    const validator = (scope, expected) => (data) =>
      validateSearchResponse(data, { scope, ...expected });
    await probe(
      'search-admin',
      SEARCH_LIST_PATH,
      adminCookie,
      200,
      validator('organization', searchPage(rows)),
    );
    await probe(
      'search-requester-own',
      SEARCH_LIST_PATH,
      requesterCookie,
      200,
      validator('own', searchPage(own)),
    );
    await probe(
      'search-unauthenticated',
      SEARCH_LIST_PATH,
      '',
      401,
      (data) => data?.status === 401,
    );
    await probe(
      'search-foreign-group',
      `${SEARCH_LIST_PATH}&group=${foreign.rows[0].id}`,
      agentCookie,
      200,
      validator('organization', searchPage([])),
    );
    const first = searchPage(rows);
    check(first.cursor && rows.length > 50, 'LIST_SEARCH_FIXTURE_INVALID');
    const cursor = new URLSearchParams({
      cursorCreatedAt: first.cursor.createdAt,
      cursorId: first.cursor.id,
    });
    await probe(
      'search-next-page',
      `${SEARCH_LIST_PATH}&${cursor}`,
      agentCookie,
      200,
      validator('organization', searchPage(rows, 50)),
    );
    const missing = 'isolated-missing-search-046';
    await probe(
      'search-empty',
      `/tickets?limit=50&sort=newest&keyword=${missing}`,
      agentCookie,
      200,
      validator('organization', searchPage([], 0, missing)),
    );
    await probe(
      'search-invalid-sort',
      `/tickets?limit=50&sort=unsupported&keyword=${encodeURIComponent(SEARCH_KEYWORD)}`,
      agentCookie,
      400,
      (data) => data?.status === 400,
    );
    result.completed = true;
    result.valid = result.cases.every((item) => item.valid);
  } catch (error) {
    result.failureCode = signal.aborted
      ? 'LIST_ABORTED'
      : fixedCode(error, 'LIST_SEARCH_PROBES_FAILED');
  }
  return result;
}

async function deadlineProbes(runtime, fixture, profile, agentCookie, signal) {
  const result = { completed: false, valid: false, cases: [] };
  try {
    const requester = fixture.actors.find((actor) => actor.role === 'requester');
    const admin = fixture.actors.find((actor) => actor.role === 'admin');
    check(requester && admin, 'LIST_DEADLINE_PROBE_ACTOR_REQUIRED');
    const own = await boundedQuery(
      runtime.admin,
      'SELECT id::text FROM ticket WHERE organization_id=$1 AND requester_id=$2 AND state=ANY($3::text[])',
      [fixture.organizationId, requester.userId, DEADLINE_STATES],
      signal,
    );
    const ownIds = new Set(own.rows.map((row) => row.id));
    check(
      ownIds.size > 0 &&
        ownIds.size === own.rows.length &&
        [...ownIds].every((id) => typeof id === 'string' && UUID.test(id)),
      'LIST_DEADLINE_PROBE_FIXTURE_INVALID',
    );
    const group = await boundedQuery(
      runtime.admin,
      'SELECT id::text FROM assignment_group WHERE organization_id=$1 ORDER BY id LIMIT 1',
      [fixture.controlOrganizationId],
      signal,
    );
    check(
      typeof group.rows[0]?.id === 'string' && UUID.test(group.rows[0].id),
      'LIST_DEADLINE_PROBE_FIXTURE_INVALID',
    );
    const critical = await boundedQuery(
      runtime.admin,
      "SELECT count(*)::int AS total FROM ticket WHERE organization_id=$1 AND state=ANY($2::text[]) AND priority='critical'",
      [fixture.organizationId, DEADLINE_STATES],
      signal,
    );
    const criticalTotal = critical.rows[0]?.total;
    check(
      Number.isSafeInteger(criticalTotal) && criticalTotal > 0,
      'LIST_DEADLINE_PROBE_FIXTURE_INVALID',
    );
    const requesterCookie = await login(
      requester,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      signal,
    );
    const adminCookie = await login(
      admin,
      fixture,
      runtime.apiBase,
      profile.requestTimeoutMs,
      signal,
    );
    const total = deadlineTotal(fixture);
    const probe = async (key, path, cookie, expectedStatus, validate) => {
      check(!signal.aborted, 'LIST_ABORTED');
      const sample = await requestSample({
        base: runtime.apiBase,
        route: { key, path, kind: 'api', expectedStatus, check: validate },
        cookie,
        timeoutMs: profile.requestTimeoutMs,
        signal,
      });
      result.cases.push({ key, expectedStatus, valid: sample.outcome === 'success', sample });
    };
    await probe('deadline-admin', DEADLINE_LIST_PATH, adminCookie, 200, (data) =>
      validateDeadlineResponse(data, { scope: 'organization', total }),
    );
    await probe('deadline-requester-own', DEADLINE_LIST_PATH, requesterCookie, 200, (data) =>
      validateDeadlineResponse(data, { scope: 'own', total: ownIds.size, allowedIds: ownIds }),
    );
    await probe(
      'deadline-unauthenticated',
      DEADLINE_LIST_PATH,
      '',
      401,
      (data) => data?.status === 401,
    );
    const cursor = new URLSearchParams({
      cursorCreatedAt: '2026-01-01T00:00:00.123456Z',
      cursorId: fixture.controlTicketId,
    });
    await probe(
      'deadline-cursor-rejected',
      `${DEADLINE_LIST_PATH}&${cursor}`,
      agentCookie,
      400,
      (data) => data?.status === 400,
    );
    await probe(
      'deadline-foreign-group',
      `${DEADLINE_LIST_PATH}&group=${group.rows[0].id}`,
      agentCookie,
      200,
      (data) => validateDeadlineResponse(data, { scope: 'organization', total: 0 }),
    );
    await probe(
      'deadline-missing-policy',
      `${DEADLINE_LIST_PATH}&priority=critical`,
      agentCookie,
      200,
      (data) =>
        validateDeadlineResponse(data, {
          scope: 'organization',
          total: criticalTotal,
          nullSla: true,
        }),
    );
    result.completed = true;
    result.valid = result.cases.every((item) => item.valid);
  } catch (error) {
    result.failureCode = signal.aborted
      ? 'LIST_ABORTED'
      : fixedCode(error, 'LIST_DEADLINE_PROBES_FAILED');
  }
  return result;
}

/** Allowlisted numbers only. Neither raw exposition nor label values leave this parser. */
export function parsePoolSnapshot(text) {
  const result = {
    valid: false,
    acquisitions: { success: histogram(), failure: histogram() },
    connections: { total: 0, idle: 0, waiting: 0, inUse: 0 },
  };
  const seen = new Set();
  const gauges = new Set();
  let malformed = false;
  for (const line of text.split('\n')) {
    const match = line.match(/^(solvi_db_pool_[a-z_]+)(?:\{([^}]*)\})?\s+(\S+)(?:\s+\S+)?$/);
    if (!match) continue;
    const [, name, labels = '', raw] = match;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      malformed = true;
      continue;
    }
    const gauge = name.match(/^solvi_db_pool_connections_(total|idle|waiting)$/);
    if (gauge) {
      if (!Number.isSafeInteger(value)) malformed = true;
      result.connections[gauge[1]] += value;
      gauges.add(gauge[1]);
      continue;
    }
    const metric = name.match(
      /^solvi_db_pool_acquire_duration(?:_milliseconds)?_(count|sum|bucket)$/,
    );
    if (!metric) continue;
    const outcome = labels.match(/(?:^|,)\s*outcome="(success|failure)"(?:,|$)/)?.[1];
    if (!outcome) {
      malformed = true;
      continue;
    }
    const target = result.acquisitions[outcome];
    if (metric[1] === 'bucket') {
      const bound = labels.match(/(?:^|,)\s*le="([^"]+)"(?:,|$)/)?.[1];
      if (!bound || (bound !== '+Inf' && (!Number.isFinite(Number(bound)) || Number(bound) < 0))) {
        malformed = true;
        continue;
      }
      if (!Number.isSafeInteger(value)) malformed = true;
      const existing = target.buckets.find((b) => b.le === bound);
      if (existing) existing.count += value;
      else target.buckets.push({ le: bound, count: value });
    } else {
      if (metric[1] === 'count' && !Number.isSafeInteger(value)) malformed = true;
      target[metric[1] === 'count' ? 'count' : 'sumMs'] += value;
      seen.add(`${outcome}:${metric[1]}`);
    }
  }
  for (const outcome of ['success', 'failure']) {
    const target = result.acquisitions[outcome];
    target.buckets.sort(
      (a, b) => Number(a.le.replace('+Inf', 'Infinity')) - Number(b.le.replace('+Inf', 'Infinity')),
    );
    if (seen.has(`${outcome}:count`) || seen.has(`${outcome}:sum`) || target.buckets.length) {
      if (
        !seen.has(`${outcome}:count`) ||
        !seen.has(`${outcome}:sum`) ||
        target.buckets.at(-1)?.le !== '+Inf' ||
        target.buckets.at(-1)?.count !== target.count
      )
        malformed = true;
      if (target.buckets.some((b, i) => i > 0 && b.count < target.buckets[i - 1].count))
        malformed = true;
    }
  }
  result.connections.inUse = result.connections.total - result.connections.idle;
  result.valid =
    !malformed && seen.has('success:count') && gauges.size === 3 && result.connections.inUse >= 0;
  return result;
}

/** Cumulative counters can reset; a negative delta invalidates the phase. */
export function poolDifference(before, after) {
  const result = { valid: before.valid && after.valid, success: histogram(), failure: histogram() };
  for (const outcome of ['success', 'failure']) {
    const first = before.acquisitions[outcome];
    const last = after.acquisitions[outcome];
    const target = result[outcome];
    target.count = last.count - first.count;
    target.sumMs = last.sumMs - first.sumMs;
    if (target.count < 0 || target.sumMs < -0.000001) result.valid = false;
    target.sumMs = Math.max(0, target.sumMs);
    const bounds = new Set([...first.buckets, ...last.buckets].map((b) => b.le));
    for (const le of bounds) {
      const count =
        (last.buckets.find((b) => b.le === le)?.count ?? 0) -
        (first.buckets.find((b) => b.le === le)?.count ?? 0);
      if (count < 0) result.valid = false;
      target.buckets.push({ le, count });
    }
    target.buckets.sort(
      (a, b) => Number(a.le.replace('+Inf', 'Infinity')) - Number(b.le.replace('+Inf', 'Infinity')),
    );
    if (
      target.buckets.some(
        (b, i) => b.count > target.count || (i > 0 && b.count < target.buckets[i - 1].count),
      )
    )
      result.valid = false;
  }
  return result;
}

export async function scrapePool(base, signal) {
  const response = await fetch(`${base}/metrics`, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
  });
  check(response.ok && response.body, 'LIST_POOL_UNAVAILABLE');
  let bytes = 0;
  let text = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      check(bytes <= METRICS_BYTES, 'LIST_POOL_RESPONSE_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const snapshot = parsePoolSnapshot(text);
  check(snapshot.valid, 'LIST_POOL_INVALID');
  return snapshot;
}

async function boundedQuery(admin, text, values, signal) {
  if (signal.aborted) throw new Error('LIST_ABORTED');
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = () => reject(new Error('LIST_ABORTED'));
  });
  signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    return await Promise.race([admin.query({ text, values, query_timeout: 2000 }), cancelled]);
  } finally {
    signal.removeEventListener('abort', rejectAbort);
  }
}

export async function verifySessions(admin, actor, fixture, cookies, signal) {
  const expected = cookies.length;
  check(expected > 0 && new Set(cookies).size === expected, 'LIST_SESSIONS_NOT_DISTINCT');
  const hashes = cookies.map((cookie) => {
    check(/^solvi_session[^=]*=[A-Za-z0-9_-]+$/.test(cookie), 'LIST_SESSION_COOKIE_INVALID');
    return createHash('sha256')
      .update(cookie.slice(cookie.indexOf('=') + 1))
      .digest('hex');
  });
  const { rows } = await boundedQuery(
    admin,
    `SELECT count(*)::int AS sessions,
    count(DISTINCT id)::int AS distinct_sessions, count(DISTINCT user_id)::int AS principals,
    count(*) FILTER (WHERE user_id=$2 AND organization_id=$3 AND revoked_at IS NULL
      AND absolute_expires_at>now() AND idle_expires_at>now())::int AS active_matching
    FROM session WHERE token_hash=ANY($1::text[])`,
    [hashes, actor.userId, fixture.organizationId],
    signal,
  );
  const row = rows[0];
  const verified =
    row?.sessions === expected &&
    row?.distinct_sessions === expected &&
    row?.principals === 1 &&
    row?.active_matching === expected;
  return {
    expected,
    sessions: Number(row?.sessions ?? 0),
    distinctSessions: Number(row?.distinct_sessions ?? 0),
    principals: Number(row?.principals ?? 0),
    activeMatching: Number(row?.active_matching ?? 0),
    verified,
  };
}

/** Fixed open burst: launch every planned item without waiting for a response. */
export async function runBurst({ count, send, signal, now = () => performance.now() }) {
  check(Number.isSafeInteger(count) && count > 0 && count <= 100, 'LIST_BURST_SIZE_INVALID');
  const started = now();
  const samples = [];
  const timing = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let sent = 0;
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    if (signal.aborted) break;
    const sentAtMs = now() - started;
    sent += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const entry = { index, plannedAtMs: 0, sentAtMs, latenessMs: sentAtMs, completedAtMs: null };
    timing.push(entry);
    const job = (async () => {
      try {
        const sample = await send(index);
        samples.push(sample);
      } catch {
        samples.push({
          route: 'api-ops-list',
          kind: 'api',
          status: null,
          outcome: signal.aborted ? 'aborted' : 'network_error',
          durationMs: now() - started - sentAtMs,
          bytes: 0,
        });
      } finally {
        entry.completedAtMs = now() - started;
        inFlight -= 1;
      }
    })();
    jobs.push(job);
  }
  await Promise.all(jobs);
  const elapsedMs = now() - started;
  const statusCounts = {};
  for (const sample of samples) {
    const key = sample.status === null ? 'no_response' : String(sample.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const lateness = timing.map((item) => item.latenessMs);
  return {
    planned: count,
    sent,
    completed: samples.length,
    unsent: count - sent,
    unfinished: sent - samples.length,
    maxInFlight,
    inFlight,
    statusCounts,
    unsuccessful: samples.filter((item) => item.outcome !== 'success').length,
    timing,
    latenessMs: {
      p50: percentile(lateness, 50),
      p95: percentile(lateness, 95),
      max: lateness.length ? Math.max(...lateness) : null,
    },
    ...summarizeSamples(samples, elapsedMs),
  };
}

export async function observePhase(runtime, signal, start) {
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
        'LIST_DB_SAMPLE_INVALID',
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

export async function drain(runtime, signal, samples) {
  const start = performance.now();
  let consecutive = 0;
  let lastAt = -1;
  let snapshot;
  while (!signal.aborted && performance.now() - start < 15_000) {
    if (samples) {
      const latest = samples.at(-1);
      if (latest && latest.atMs !== lastAt) {
        lastAt = latest.atMs;
        snapshot = latest;
        consecutive =
          latest.connections.waiting === 0 && latest.connections.inUse === 0 ? consecutive + 1 : 0;
      }
    } else {
      snapshot = await scrapePool(runtime.metricsBase, signal);
      consecutive =
        snapshot.connections.waiting === 0 && snapshot.connections.inUse === 0
          ? consecutive + 1
          : 0;
    }
    if (consecutive >= 2) return { drained: true, waitedMs: performance.now() - start, snapshot };
    await delay(250, undefined, { signal });
  }
  return { drained: false, waitedMs: performance.now() - start, snapshot };
}

/** Same principal/session-row contrast, never a simulation of 100 distinct users. */
export function runListComparison(options) {
  return runComparison(options, 'list');
}

/** WP044 only; callers cannot override the fixed route, states, ordering or limit. */
export function runDeadlineComparison(options) {
  return runComparison(options, 'deadline');
}

/** WP046 only; no caller-supplied query, URL, ordering or limit is accepted. */
export function runSearchComparison(options) {
  return runComparison(options, 'search');
}

async function runComparison(
  { runtime, fixture, profile, signal, onProgress = () => {} },
  queryKind,
) {
  const report = {
    comparisonCompleted: false,
    allRequestsSucceeded: false,
    model:
      'same agent principal; fixed simultaneous arrival schedule; A=one session, B=distinct sessions; not 100 distinct users or production acceptance',
    interpretation:
      'comparison completion is separate from HTTP/DTO/transport success; latencies are measurements without a burst SLO threshold',
    loginCompleted: 0,
    phases: [],
  };
  const hardStop = AbortSignal.timeout(MAX_COMPARISON_MS);
  const combined = signal ? AbortSignal.any([signal, hardStop]) : hardStop;
  try {
    const deadline = queryKind === 'deadline';
    const search = queryKind === 'search';
    validateProfile(profile);
    check(['smoke', 'baseline', 'growth'].includes(profile.name), 'LIST_PROFILE_INVALID');
    const count = profile.name === 'smoke' ? 12 : 100;
    check(profile.activeSessions === count, 'LIST_PROFILE_SESSION_COUNT_INVALID');
    runtime = {
      ...runtime,
      apiBase: assertLoopbackBase(runtime.apiBase),
      metricsBase: assertLoopbackBase(runtime.metricsBase),
    };
    const actor = fixture.actors.find((candidate) => candidate.role === 'agent');
    check(actor, 'LIST_AGENT_REQUIRED');
    const searchRows = search ? await readSearchRows(runtime, fixture, combined) : undefined;
    if (search) check(searchRows.length > 50, 'LIST_SEARCH_FIXTURE_INVALID');
    const route = deadline
      ? {
          key: 'api-deadline-list',
          path: DEADLINE_LIST_PATH,
          kind: 'api',
          check: (data) =>
            validateDeadlineResponse(data, {
              scope: 'organization',
              total: deadlineTotal(fixture),
            }),
        }
      : search
        ? {
            key: 'api-search-list',
            path: SEARCH_LIST_PATH,
            kind: 'api',
            check: (data) =>
              validateSearchResponse(data, { scope: 'organization', ...searchPage(searchRows) }),
          }
        : actorRoutes(actor, fixture).find((candidate) => candidate.key === 'api-ops-list');
    check(route, 'LIST_ROUTE_REQUIRED');
    if (deadline)
      report.deadlineContract = {
        limit: 50,
        sort: 'remaining_seconds ASC NULLS LAST, id ASC',
        states: [...DEADLINE_STATES],
        scope: 'organization',
        total: deadlineTotal(fixture),
        clock:
          'Each response is validated internally; no cross-response SLA timestamp equality is assumed.',
      };
    if (search)
      report.searchContract = {
        keyword: SEARCH_KEYWORD,
        limit: 50,
        sort: 'created_at DESC, id DESC',
        scope: 'organization',
        total: searchRows.length,
        oracle:
          'Private same-organization ordered IDs and exact pre-cursor count; no raw rows retained.',
        clock:
          'SLA values are validated within each response; full values are compared in the separate RR SQL analysis.',
      };
    report.principal = { role: 'agent', count: 1, organizationCount: 1 };
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
      check(!combined.aborted, 'LIST_ABORTED');
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
    check(report.sessionVerification.verified, 'LIST_SESSION_CARDINALITY_INVALID');
    report.initialDrain = await drain(runtime, combined);
    check(report.initialDrain.drained, 'LIST_DRAIN_FAILED');
    for (const [index, mode] of report.schedule.entries()) {
      check(!combined.aborted, 'LIST_ABORTED');
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
        check(phase.drain.drained, 'LIST_DRAIN_FAILED');
        phase.poolAfter = await scrapePool(runtime.metricsBase, combined);
        phase.poolDelta = poolDifference(phase.poolBefore, phase.poolAfter);
      } catch (error) {
        phase.failureCode = fixedCode(error, 'LIST_PHASE_FAILED');
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
      check(phase.observationValid, 'LIST_OBSERVATION_INVALID');
      check(
        phase.burst.unsent === 0 && phase.burst.unfinished === 0 && phase.burst.aborted === 0,
        'LIST_INCOMPLETE',
      );
    }
    report.comparisonCompleted =
      report.phases.length === report.schedule.length && !combined.aborted;
    report.allRequestsSucceeded =
      report.comparisonCompleted &&
      report.phases.every((phase) => phase.burst.successes === phase.burst.planned);
    if (deadline || search) {
      await onProgress(`${queryKind}-api-probes`);
      report.apiProbes = search
        ? await searchProbes(runtime, fixture, profile, cookies[0], combined, searchRows)
        : await deadlineProbes(runtime, fixture, profile, cookies[0], combined);
      report.apiContractValid = report.apiProbes.completed && report.apiProbes.valid;
      // Probe requests also pass through the real API pool. EXPLAIN cannot follow until drained.
      report.probeDrain = await drain(runtime, combined);
      check(report.probeDrain.drained, 'LIST_DRAIN_FAILED');
      check(!combined.aborted, 'LIST_ABORTED');
    }
  } catch (error) {
    report.comparisonCompleted = false;
    report.allRequestsSucceeded = false;
    report.failureCode = hardStop.aborted
      ? 'LIST_HARD_CAP'
      : combined.aborted
        ? 'LIST_ABORTED'
        : fixedCode(error, 'LIST_COMPARISON_FAILED');
  }
  return report;
}
