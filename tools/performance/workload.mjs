import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_WORKLOAD_MS = 180_000;
const MAX_SAMPLES = 100_000;
const guard = (condition, code) => {
  if (!condition) throw new Error(code);
};

export function validateProfile(profile) {
  const integer = (key, min, max) =>
    guard(
      Number.isSafeInteger(profile?.[key]) && profile[key] >= min && profile[key] <= max,
      'WORKLOAD_PROFILE_REJECTED',
    );
  integer('users', 100, 4000);
  integer('tickets', 100, 100_000);
  integer('activeSessions', 3, 100);
  integer('warmupMs', 0, 10_000);
  integer('durationMs', 1000, 60_000);
  integer('thinkTimeMs', 100, 10_000);
  integer('requestTimeoutMs', 100, 10_000);
  integer('seed', 0, 0x7fffffff);
  guard(
    typeof profile.name === 'string' && /^[a-z0-9-]{1,40}$/.test(profile.name),
    'WORKLOAD_PROFILE_REJECTED',
  );
  guard(
    profile.roles && Object.keys(profile.roles).sort().join(',') === 'admin,agent,requester',
    'WORKLOAD_PROFILE_REJECTED',
  );
  guard(
    Object.values(profile.roles).every((n) => Number.isSafeInteger(n) && n > 0),
    'WORKLOAD_PROFILE_REJECTED',
  );
  guard(
    Object.values(profile.roles).reduce((a, b) => a + b, 0) === profile.activeSessions,
    'WORKLOAD_PROFILE_REJECTED',
  );
  guard(
    profile.users > profile.activeSessions && profile.tickets >= profile.users,
    'WORKLOAD_PROFILE_REJECTED',
  );
  return profile;
}

export function assertLoopbackBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WORKLOAD_BASE_REJECTED');
  }
  guard(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      /^\d+$/.test(url.port) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'WORKLOAD_BASE_REJECTED',
  );
  return url.origin;
}

export function percentile(values, percent) {
  guard(Number.isFinite(percent) && percent >= 0 && percent <= 100, 'WORKLOAD_PERCENTILE_REJECTED');
  guard(
    values.every((v) => Number.isFinite(v) && v >= 0),
    'WORKLOAD_SAMPLE_REJECTED',
  );
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((sorted.length * percent) / 100) - 1)];
}

export function summarizeSamples(samples, elapsedMs) {
  guard(Number.isFinite(elapsedMs) && elapsedMs > 0, 'WORKLOAD_DURATION_REJECTED');
  const successes = samples.filter((s) => s.outcome === 'success');
  const durations = successes.map((s) => s.durationMs);
  const failures = samples.filter(
    (s) => s.outcome !== 'success' && s.outcome !== 'timeout' && s.outcome !== 'aborted',
  );
  return {
    requests: samples.length,
    successes: successes.length,
    failures: failures.length,
    timeouts: samples.filter((s) => s.outcome === 'timeout').length,
    aborted: samples.filter((s) => s.outcome === 'aborted').length,
    failureRate: samples.length ? (samples.length - successes.length) / samples.length : null,
    bytes: samples.reduce((n, s) => n + s.bytes, 0),
    elapsedMs,
    rps: (samples.length * 1000) / elapsedMs,
    successfulRps: (successes.length * 1000) / elapsedMs,
    successfulLatencyMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
      max: durations.length ? Math.max(...durations) : null,
    },
    outcomes: Object.fromEntries(
      [
        'success',
        'http_error',
        'invalid_response',
        'too_large',
        'network_error',
        'timeout',
        'aborted',
      ].map((key) => [key, samples.filter((s) => s.outcome === key).length]),
    ),
  };
}

export function validateResponse(route, response, text) {
  if (response.redirected || response.status !== (route.expectedStatus ?? 200)) return false;
  const type = response.headers.get('content-type') ?? '';
  if (route.kind === 'ssr') {
    if (
      !type.includes('text/html') ||
      !/<main\b[^>]*\bid="main"/.test(text) ||
      /\brole="alert"/.test(text)
    )
      return false;
    const heading = text
      .match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]
      .replace(/<[^>]*>/g, '')
      .trim();
    return (
      heading === route.heading && (route.markers ?? []).every((marker) => text.includes(marker))
    );
  }
  if (!type.includes('json')) return false;
  try {
    return Boolean(route.check(JSON.parse(text)));
  } catch {
    return false;
  }
}

async function boundedBody(response, onBytes = () => {}) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('WORKLOAD_BODY_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(bytes);
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('WORKLOAD_BODY_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

/** Cookie and response bodies never become fields of the returned sample. */
export async function requestSample({ base, route, cookie, timeoutMs, signal, fetchImpl = fetch }) {
  const origin = assertLoopbackBase(base);
  guard(
    route.path.startsWith('/') &&
      !route.path.startsWith('//') &&
      !route.path.includes('\\') &&
      new URL(route.path, origin).origin === origin,
    'WORKLOAD_PATH_REJECTED',
  );
  guard(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10_000,
    'WORKLOAD_TIMEOUT_REJECTED',
  );
  const start = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  let bytes = 0;
  let status = null;
  let outcome;
  try {
    const response = await fetchImpl(origin + route.path, {
      headers: { cookie },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    status = response.status;
    const body = await boundedBody(response, (received) => {
      bytes = received;
    });
    if (response.status !== (route.expectedStatus ?? 200)) outcome = 'http_error';
    else outcome = validateResponse(route, response, body.text) ? 'success' : 'invalid_response';
  } catch (error) {
    outcome = signal?.aborted
      ? 'aborted'
      : timeout.aborted
        ? 'timeout'
        : error.message === 'WORKLOAD_BODY_TOO_LARGE'
          ? 'too_large'
          : 'network_error';
  }
  return {
    route: route.key,
    kind: route.kind,
    outcome,
    status,
    bytes,
    durationMs: performance.now() - start,
  };
}

const list = (data) =>
  data &&
  Array.isArray(data.items) &&
  Number.isSafeInteger(data.total) &&
  data.total >= data.items.length;
const ticketDto = (item) =>
  item &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id ?? '') &&
  typeof item.subject === 'string' &&
  item.subject.length > 0 &&
  ['incident', 'request'].includes(item.kind) &&
  ['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled'].includes(
    item.state,
  );
// Every unfiltered fixture ticket page is known to have records; an empty success is invalid.
const ticketList = (data) => list(data) && data.items.length > 0 && data.items.every(ticketDto);
const page = (key, path, heading, markers = []) => ({ key, path, kind: 'ssr', heading, markers });
const api = (key, path, check) => ({ key, path, kind: 'api', check });

export function actorRoutes(actor, fixture) {
  guard(/^[0-9a-f-]{36}$/.test(actor.ticketId ?? ''), 'WORKLOAD_TICKET_ID_REQUIRED');
  const common = [
    page('portal', '/portal', 'あなたのITサポート', ['あなたの問い合わせ', 'サービスを探す']),
    page('request-form', '/tickets/new?kind=request', 'IT サービスを依頼する', ['<form']),
    page('ticket-detail', `/tickets/${actor.ticketId}`, actor.ticketSubject, ['やり取り']),
    api(
      'api-ticket-detail',
      `/tickets/${actor.ticketId}`,
      (d) => ticketDto(d) && d.id === actor.ticketId && d.subject === actor.ticketSubject,
    ),
    api(
      'api-ticket-list',
      '/tickets?limit=10',
      (d) => ticketList(d) && d.scope === (actor.role === 'requester' ? 'own' : 'organization'),
    ),
    api(
      'api-catalog',
      '/catalog',
      (d) => Array.isArray(d?.items) && d.items.some((i) => i.id === fixture.catalogItemId),
    ),
  ];
  if (actor.role === 'requester') return common;
  const staff = [
    page('ops', '/ops', '問い合わせの一覧', ['問い合わせの絞り込み']),
    page('overview', '/ops/overview', '運営状況', ['現在の件数', '解決期限の確認']),
    page('inbox', '/inbox', '業務受信箱', ['自分への承認']),
    api(
      'api-ops-list',
      '/tickets?limit=50',
      (d) => ticketList(d) && d.scope === 'organization' && d.total === fixture.counts.tickets,
    ),
    api('api-inbox', '/inbox', (d) => list(d) && d.counts && Number.isSafeInteger(d.counts.ticket)),
  ];
  if (actor.role === 'agent') return staff;
  guard(actor.role === 'admin', 'WORKLOAD_ROLE_REJECTED');
  return [
    ...staff,
    page('users', '/ops/users', '利用者管理', ['在籍者']),
    page('approvals', '/requests?view=approvals', '申請の状況', ['合成サービス申請']),
    api(
      'api-users',
      '/users',
      (d) =>
        Array.isArray(d?.items) &&
        d.items.length === fixture.counts.users &&
        d.items.every((u) => typeof u.userId === 'string'),
    ),
    api(
      'api-approvals',
      '/service-requests?view=approvals',
      (d) => list(d) && d.items.some((i) => i.id === fixture.serviceRequestId),
    ),
  ];
}

export async function login(actor, fixture, apiBase, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: actor.email,
      password: actor.password,
      organizationId: fixture.organizationId,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await boundedBody(response);
  guard(response.status === 200 && !response.redirected, 'WORKLOAD_LOGIN_FAILED');
  let data;
  try {
    data = JSON.parse(body.text);
  } catch {
    throw new Error('WORKLOAD_LOGIN_FAILED');
  }
  guard(
    data.userId === actor.userId && data.organizationId === fixture.organizationId,
    'WORKLOAD_LOGIN_IDENTITY_MISMATCH',
  );
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  guard(/^solvi_session[^=]*=[A-Za-z0-9_-]+$/.test(cookie ?? ''), 'WORKLOAD_LOGIN_COOKIE_MISSING');
  return cookie;
}

/** Bounded closed-loop virtual users, not browser rendering or an open arrival-rate test. */
export async function runWorkload({
  profile,
  fixture,
  apiBase,
  webBase,
  onProgress = () => {},
  signal,
}) {
  validateProfile(profile);
  apiBase = assertLoopbackBase(apiBase);
  webBase = assertLoopbackBase(webBase);
  guard(fixture.actors?.length === profile.activeSessions, 'WORKLOAD_ACTOR_COUNT_MISMATCH');
  const users = new Set(fixture.actors.map((a) => a.userId));
  guard(users.size === profile.activeSessions, 'WORKLOAD_ACTORS_NOT_DISTINCT');
  const deadline = AbortSignal.timeout(MAX_WORKLOAD_MS);
  const callerSignal = signal;
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const sessions = [];
  const report = {
    completed: false,
    measurementValid: false,
    loginCompleted: 0,
    uniqueUsers: users.size,
    model: 'closed-loop independent synthetic sessions; SSR full HTTP bodies, not browser paint',
    isolation: { checked: 0, denied: 0 },
  };
  try {
    await onProgress('login');
    for (const actor of fixture.actors) {
      if (signal?.aborted) throw new Error('WORKLOAD_ABORTED');
      const cookie = await login(actor, fixture, apiBase, profile.requestTimeoutMs, signal);
      sessions.push({ actor, cookie, routes: actorRoutes(actor, fixture) });
      report.loginCompleted += 1;
    }
    guard(
      new Set(sessions.map((s) => s.cookie)).size === profile.activeSessions,
      'WORKLOAD_SESSIONS_NOT_DISTINCT',
    );
    await onProgress('login-complete');
    for (const session of [
      sessions.find((s) => s.actor.role === 'requester'),
      sessions.find((s) => s.actor.role === 'admin'),
    ]) {
      const probe = await requestSample({
        base: apiBase,
        cookie: session.cookie,
        timeoutMs: profile.requestTimeoutMs,
        signal,
        route: {
          ...api(
            'isolation-probe',
            `/tickets/${fixture.controlTicketId}`,
            (d) => d?.status === 404,
          ),
          expectedStatus: 404,
        },
      });
      report.isolation.checked += 1;
      if (probe.outcome === 'success') report.isolation.denied += 1;
    }
    guard(report.isolation.denied === 2, 'WORKLOAD_ISOLATION_CHECK_FAILED');
    const phase = async (durationMs, stage) => {
      await onProgress(stage);
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const samples = [];
      await Promise.all(
        sessions.map(async (session, actorIndex) => {
          let turn = profile.seed + actorIndex;
          // Stagger the initial requests deterministically instead of synchronizing every user.
          await delay((actorIndex * 37 + profile.seed) % profile.thinkTimeMs, undefined, {
            signal,
          }).catch(() => undefined);
          while (!signal?.aborted && performance.now() - start < durationMs) {
            const route = session.routes[turn++ % session.routes.length];
            const sample = await requestSample({
              base: route.kind === 'ssr' ? webBase : apiBase,
              route,
              cookie: session.cookie,
              timeoutMs: profile.requestTimeoutMs,
              signal,
            });
            guard(samples.length < MAX_SAMPLES, 'WORKLOAD_SAMPLE_LIMIT');
            samples.push(sample);
            const remaining = durationMs - (performance.now() - start);
            if (remaining > 0)
              await delay(Math.min(profile.thinkTimeMs, remaining), undefined, { signal }).catch(
                () => undefined,
              );
          }
        }),
      );
      const elapsedMs = performance.now() - start;
      const byRoute = [...new Set(samples.map((s) => s.route))].sort().map((key) => {
        const subset = samples.filter((s) => s.route === key);
        return { route: key, kind: subset[0].kind, ...summarizeSamples(subset, elapsedMs) };
      });
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        ...summarizeSamples(samples, elapsedMs),
        byRoute,
        byTransport: ['ssr', 'api'].map((kind) => ({
          kind,
          ...summarizeSamples(
            samples.filter((s) => s.kind === kind),
            elapsedMs,
          ),
        })),
      };
    };
    report.warmup = profile.warmupMs
      ? await phase(profile.warmupMs, 'warmup')
      : { requests: 0, failures: 0, timeouts: 0 };
    report.measurement = await phase(profile.durationMs, 'measurement');
    if (signal?.aborted) throw new Error('WORKLOAD_ABORTED');
    await onProgress('same-session-diagnostic');
    const diagnosticSession = sessions.find((s) => s.actor.role === 'agent');
    const start = performance.now();
    const samples = await Promise.all(
      Array.from({ length: profile.activeSessions }, () =>
        requestSample({
          base: apiBase,
          route: diagnosticSession.routes.find((r) => r.key === 'api-ops-list'),
          cookie: diagnosticSession.cookie,
          timeoutMs: profile.requestTimeoutMs,
          signal,
        }),
      ),
    );
    report.sameSessionDiagnostic = {
      sessionCount: 1,
      parallelRequests: profile.activeSessions,
      ...summarizeSamples(samples, performance.now() - start),
    };
    report.diagnosticValid = report.sameSessionDiagnostic.failureRate === 0;
    if (!report.diagnosticValid)
      report.sameSessionDiagnostic.failureCode = report.sameSessionDiagnostic.timeouts
        ? 'WORKLOAD_DIAGNOSTIC_TIMEOUT'
        : 'WORKLOAD_DIAGNOSTIC_FAILED';
    if (signal?.aborted) throw new Error('WORKLOAD_ABORTED');
    const expected = [...new Set(sessions.flatMap((s) => s.routes.map((r) => r.key)))].sort();
    report.missingSuccessfulRoutes = expected.filter(
      (key) => !report.measurement.byRoute.some((r) => r.route === key && r.successes > 0),
    );
    report.completed = !signal?.aborted;
    report.measurementValid =
      report.completed &&
      report.measurement.failureRate === 0 &&
      report.missingSuccessfulRoutes.length === 0;
    await onProgress('complete');
  } catch (error) {
    report.failureCode = callerSignal?.aborted
      ? 'WORKLOAD_ABORTED'
      : deadline.aborted
        ? 'WORKLOAD_DEADLINE_EXCEEDED'
        : /^WORKLOAD_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'WORKLOAD_FAILED';
  } finally {
    sessions.length = 0;
  }
  return report;
}
