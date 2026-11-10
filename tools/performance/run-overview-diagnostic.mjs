#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { getProfile, profileNames } from './profiles.mjs';
import { prepareOutput, finalizeReport } from './run-baseline.mjs';
import { actorRoutes, login, requestSample, summarizeSamples } from './workload.mjs';
import { drain, scrapePool, poolDifference, runBurst, verifySessions } from './list-load.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-043';
const metrics = ['open', 'unassigned', 'mine', 'pending', 'breached', 'critical'];
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
const safeCode = (error) =>
  /^[A-Z][A-Z0-9_]{2,90}$/.test(error?.code ?? error?.message ?? '')
    ? (error.code ?? error.message)
    : 'OVERVIEW_DIAGNOSTIC_FAILED';

export function parseOverviewArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { help: true };
    check(
      ['--profile', '--label', '--output', '--exercise-cleanup'].includes(key),
      'UNKNOWN_ARGUMENT',
    );
    const name = key.slice(2);
    check(!Object.hasOwn(result, name), 'DUPLICATE_ARGUMENT');
    if (key === '--exercise-cleanup') result[name] = true;
    else {
      const value = args[++i];
      check(value && !value.startsWith('--'), 'MISSING_ARGUMENT');
      result[name] = value;
    }
  }
  check(result.profile, 'PROFILE_REQUIRED');
  getProfile(result.profile);
  check(['before', 'after'].includes(result.label), 'LABEL_REQUIRED');
  return result;
}

async function workload(runtime, fixture, profile, signal, progress, report) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const count = profile.name === 'smoke' ? 3 : 10;
  const sequentialCount = profile.name === 'smoke' ? 3 : 20;
  const actor = fixture.actors.find((a) => a.role === 'agent');
  const route = actorRoutes(actor, fixture).find((r) => r.path === '/ops/overview');
  check(actor && route, 'OVERVIEW_ACTOR_ROUTE_REQUIRED');
  report.model =
    'Same agent principal; sequential overview SSR plus two fixed bursts with distinct sessions; not 100 people or production acceptance.';
  report.planned = { warmup: 2, sequential: sequentialCount, burstSize: count, bursts: 2 };
  report.phases = [];
  progress('overview-login');
  const cookies = [];
  for (let i = 0; i < count; i++)
    cookies.push(await login(actor, fixture, runtime.apiBase, profile.requestTimeoutMs, combined));
  report.sessions = await verifySessions(runtime.admin, actor, fixture, cookies, combined);
  check(report.sessions.verified, 'OVERVIEW_SESSIONS_INVALID');
  const sample = (index) =>
    requestSample({
      base: runtime.webBase,
      route,
      cookie: cookies[index],
      timeoutMs: profile.requestTimeoutMs,
      signal: combined,
    });
  const idle = async () => {
    const result = await drain(runtime, combined);
    check(result.drained, 'OVERVIEW_DRAIN_FAILED');
    return result;
  };
  await idle();
  report.warmup = [];
  for (let i = 0; i < 2; i++) report.warmup.push(await sample(0));
  check(
    report.warmup.every((s) => s.outcome === 'success'),
    'OVERVIEW_WARMUP_FAILED',
  );
  await idle();
  for (const name of ['sequential', 'burst-1', 'burst-2']) {
    progress(`overview-${name}`);
    const phase = { name, completed: false };
    report.phases.push(phase);
    phase.poolBefore = await scrapePool(runtime.metricsBase, combined);
    const start = performance.now();
    if (name === 'sequential') {
      phase.samples = [];
      for (let i = 0; i < sequentialCount; i++) {
        check(!combined.aborted, 'OVERVIEW_WORKLOAD_ABORTED');
        phase.samples.push(await sample(0));
      }
      phase.summary = summarizeSamples(phase.samples, performance.now() - start);
    } else phase.burst = await runBurst({ count, signal: combined, send: (i) => sample(i) });
    phase.drain = await idle();
    phase.poolAfter = await scrapePool(runtime.metricsBase, combined);
    phase.poolDelta = poolDifference(phase.poolBefore, phase.poolAfter);
    check(phase.poolDelta.valid, 'OVERVIEW_POOL_DELTA_INVALID');
    phase.completed = true;
  }
  report.completed = true;
  report.allRequestsSucceeded = report.phases.every((p) =>
    p.summary
      ? p.summary.requests === sequentialCount && p.summary.successes === sequentialCount
      : p.burst.unsuccessful === 0 && p.burst.unsent === 0 && p.burst.unfinished === 0,
  );
}

export async function createProbeCredential(runtime, account) {
  check(/^solvi_perf041_\d+_[a-f0-9]{12}$/.test(runtime.meta.database), 'PROBE_DATABASE_REJECTED');
  const identity = await runtime.admin.query('SELECT current_database() AS database');
  check(identity.rows[0]?.database === runtime.meta.database, 'PROBE_DATABASE_MISMATCH');
  await runtime.admin.query('BEGIN');
  try {
    const created = await runtime.createCredential({
      userId: account.userId,
      subject: account.email,
      password: account.password,
    });
    check(created.ok, 'PROBE_CREDENTIAL_REJECTED');
    await runtime.admin.query('COMMIT');
  } catch (error) {
    await runtime.admin.query('ROLLBACK');
    throw error;
  }
}

async function apiProbes(runtime, fixture, analysis, profile, signal, report) {
  const actor = fixture.actors.find((a) => a.role === 'agent');
  const agentCookie = await login(
    actor,
    fixture,
    runtime.apiBase,
    profile.requestTimeoutMs,
    signal,
  );
  report.cases = [];
  const validCounts = (data) =>
    data?.scope === 'organization' &&
    metrics.every((key) => Number.isSafeInteger(data.counts?.[key]) && data.counts[key] >= 0);
  async function probe(name, path, expectedStatus, cookie, expectedCounts) {
    let counts;
    const sample = await requestSample({
      base: runtime.apiBase,
      cookie,
      timeoutMs: profile.requestTimeoutMs,
      signal,
      route: {
        key: name,
        kind: 'api',
        path,
        expectedStatus,
        check: (data) => {
          if (expectedStatus !== 200) return data?.status === expectedStatus;
          if (!validCounts(data)) return false;
          counts = Object.fromEntries(metrics.map((key) => [key, data.counts[key]]));
          return !expectedCounts || metrics.every((key) => counts[key] === expectedCounts[key]);
        },
      },
    });
    report.cases.push({ name, expectedStatus, ...sample, ...(counts ? { counts } : {}) });
    check(sample.outcome === 'success', 'OVERVIEW_API_PROBE_FAILED');
  }
  const comparable = analysis.cases.filter((item) => item.apiComparable);
  check(comparable.length >= 6, 'OVERVIEW_API_CASES_MISSING');
  for (const item of comparable) {
    const query = new URLSearchParams();
    if (item.options?.group) query.set('group', item.options.group);
    await probe(
      item.name,
      `/tickets/overview${query.size ? `?${query}` : ''}`,
      200,
      agentCookie,
      item.aggregate.counts,
    );
  }
  for (const query of ['group=invalid', 'group=mine&group=ungrouped', 'state=new'])
    await probe(`invalid-${query}`, `/tickets/overview?${query}`, 400, agentCookie);
  await probe('unauthenticated', '/tickets/overview', 401, '');
  for (const role of ['requester', 'admin']) {
    const account = fixture.actors.find((a) => a.role === role);
    const cookie = await login(account, fixture, runtime.apiBase, profile.requestTimeoutMs, signal);
    await probe(role, '/tickets/overview', role === 'admin' ? 200 : 403, cookie);
  }
  // Only seed accounts in the new owned DB; use the application's sole credential writer.
  report.syntheticCredentialsReset = 0;
  for (const role of ['approver', 'auditor']) {
    const result = await runtime.admin.query(
      `SELECT u.id,u.primary_email FROM app_user u JOIN role_binding rb ON rb.user_id=u.id
       JOIN role r ON r.id=rb.role_id WHERE rb.organization_id=$1 AND u.status='active'
       AND rb.valid_from<=now() AND (rb.valid_until IS NULL OR rb.valid_until>now())
       GROUP BY u.id,u.primary_email HAVING bool_and(r.code=$2) ORDER BY u.id LIMIT 1`,
      [fixture.organizationId, role],
    );
    check(result.rows.length === 1, 'PROBE_ROLE_ACTOR_REQUIRED');
    const row = result.rows[0];
    const account = { userId: row.id, email: row.primary_email, role: 'requester' };
    Object.defineProperty(account, 'password', {
      value: randomBytes(32).toString('base64url'),
      enumerable: false,
    });
    await createProbeCredential(runtime, account);
    report.syntheticCredentialsReset++;
    const cookie = await login(account, fixture, runtime.apiBase, profile.requestTimeoutMs, signal);
    await probe(role, '/tickets/overview', 403, cookie);
  }
  report.completed = true;
}

export async function executeOverviewDiagnostic(args) {
  const profile = getProfile(args.profile);
  check(['before', 'after'].includes(args.label), 'LABEL_REQUIRED');
  const output = await prepareOutput(args.output, `${args.label}-${profile.name}`, workPackage);
  const report = {
    schemaVersion: 1,
    workPackage,
    label: args.label,
    profile,
    startedAt: new Date().toISOString(),
    success: false,
    stages: [],
    limits: [
      'Isolated synthetic DB, compiled development API/local auth, production Web SSR HTTP. Not browser rendering, AWS or production capacity acceptance.',
      'The before Web retains six list calls; the additive overview API may already be present but unused by Web.',
    ],
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const progress = (stage) => {
    if (!/^[a-zA-Z0-9_.:-]{1,90}$/.test(stage)) return;
    report.stages.push({ stage, at: new Date().toISOString() });
    console.log(`overview: ${stage}`);
  };
  let runtime;
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const { createRuntime } = await import('./runtime.mjs');
    const { seedFixture } = await import('./fixture.mjs');
    const { runOverviewAnalysis } = await import('./overview-analysis.mjs');
    runtime = await createRuntime({ workPackage, onProgress: progress, signal: controller.signal });
    report.runtime = runtime.meta;
    progress('fixture');
    const fixture = await seedFixture(runtime.admin, profile, {
      createCredential: runtime.createCredential,
      databaseName: runtime.meta.database,
    });
    report.dataset = fixture.counts;
    for (const table of [
      'ticket',
      'app_user',
      'role_binding',
      'sla_policy',
      'assignment_group',
      'assignment_group_member',
    ])
      await runtime.admin.query(`ANALYZE ${table}`);
    report.fixtureStatistics = 'explicit-analyze; original policies retained';
    if (args['exercise-cleanup']) throw new Error('EXPECTED_CLEANUP_EXERCISE');
    report.workload = {};
    await workload(runtime, fixture, profile, controller.signal, progress, report.workload);
    progress('overview-query-analysis');
    report.analysis = await runOverviewAnalysis({ runtime, fixture, signal: controller.signal });
    check(report.analysis.completed && report.analysis.equivalent, 'OVERVIEW_ANALYSIS_FAILED');
    progress('overview-api-probes');
    report.apiProbes = {};
    await apiProbes(
      runtime,
      fixture,
      report.analysis,
      profile,
      controller.signal,
      report.apiProbes,
    );
    report.success = report.workload.completed && report.apiProbes.completed;
    report.allRequestsSucceeded = report.workload.allRequestsSucceeded;
  } catch (error) {
    report.failureCode = controller.signal.aborted ? 'OVERVIEW_INTERRUPTED' : safeCode(error);
    if (error.meta) report.runtime = error.meta;
    if (error.cleanupReport) report.cleanup = error.cleanupReport;
  } finally {
    try {
      if (runtime) report.cleanup = await runtime.cleanup();
    } catch {
      report.cleanup = { success: false, failureCode: 'CLEANUP_FAILED' };
    }
    finalizeReport(report, controller.signal.aborted);
    if (report.interrupted) report.failureCode = 'OVERVIEW_INTERRUPTED';
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`overview: report ${relative(root, resolve(output, 'report.json'))}`);
    console.log(
      `overview: valid=${report.success}; allRequestsSucceeded=${report.allRequestsSucceeded}; cleanup=${report.cleanup?.success === true}`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseOverviewArgs(process.argv.slice(2));
    if (args.help)
      console.log(
        `Usage: node tools/performance/run-overview-diagnostic.mjs --profile ${profileNames.join('|')} --label before|after [--output evidence/WP-P2-PERF-043/new-run] [--exercise-cleanup]`,
      );
    else process.exitCode = (await executeOverviewDiagnostic(args)).success ? 0 : 1;
  } catch (error) {
    console.error(`overview: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
