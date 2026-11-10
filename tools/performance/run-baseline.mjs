#!/usr/bin/env node
import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getProfile, profileNames } from './profiles.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--help') return { help: true };
    if (!['--profile', '--output', '--exercise-cleanup'].includes(key)) {
      throw new Error('UNKNOWN_ARGUMENT');
    }
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error('DUPLICATE_ARGUMENT');
    if (key === '--exercise-cleanup') result[name] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
      result[name] = value;
    }
  }
  if (!result.profile) throw new Error('PROFILE_REQUIRED');
  getProfile(result.profile);
  return result;
}

export async function prepareOutput(requested, profile, workPackage = 'WP-P2-PERF-041') {
  if (
    ![
      'WP-P2-PERF-041',
      'WP-P2-PERF-042',
      'WP-P2-PERF-043',
      'WP-P2-PERF-044',
      'WP-P2-PERF-045',
      'WP-P2-PERF-046',
      'WP-P2-PERF-047',
      'WP-P2-PERF-048',
      'WP-P2-PERF-049',
      'WP-P2-PERF-050',
      'WP-P2-PERF-051',
      'WP-P2-PERF-053',
    ].includes(workPackage)
  ) {
    throw new Error('OUTPUT_WORK_PACKAGE_REJECTED');
  }
  const evidenceRoot = resolve(root, 'evidence', workPackage);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = resolve(root, requested ?? `evidence/${workPackage}/${profile}-${stamp}`);
  const suffix = relative(evidenceRoot, output);
  if (
    !suffix ||
    suffix.startsWith(`..${sep}`) ||
    suffix === '..' ||
    resolve(evidenceRoot, suffix) !== output
  ) {
    throw new Error('OUTPUT_OUTSIDE_EVIDENCE');
  }
  let current = output;
  while (current !== dirname(current)) {
    if (existsSync(current) && (await lstat(current)).isSymbolicLink()) {
      throw new Error('OUTPUT_SYMLINK');
    }
    if (current === root.replace(/\/$/, '')) break;
    current = dirname(current);
  }
  if (existsSync(output)) throw new Error('OUTPUT_ALREADY_EXISTS');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  try {
    // The leaf is an atomic claim: concurrent runs must not share one report directory.
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('OUTPUT_ALREADY_EXISTS');
    throw error;
  }
  return output;
}

function safeCode(error) {
  const value = typeof error?.code === 'string' ? error.code : error?.message;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,95}$/.test(value)
    ? value
    : 'BASELINE_FAILED';
}

/** Aggregates only; never collects SQL text, PIDs, user identifiers or credentials. */
export function observeDatabase(admin) {
  const samples = [];
  let errors = 0;
  let stopped = false;
  const cancel = new AbortController();
  const stopMarker = Symbol('observation-stopped');
  let notifyStop;
  const stopRequested = new Promise((resolveStop) => {
    notifyStop = resolveStop;
  });
  const done = (async () => {
    while (!stopped) {
      try {
        const result = await Promise.race([
          admin.query(`
          SELECT count(*)::int AS connections,
                 count(*) FILTER (WHERE state = 'active')::int AS active,
                 count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
                 count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_waiting
          FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid()`),
          stopRequested,
        ]);
        if (result === stopMarker) break;
        const { rows } = result;
        samples.push({ at: new Date().toISOString(), ...rows[0] });
      } catch {
        errors += 1;
      }
      try {
        await delay(1000, undefined, { signal: cancel.signal });
      } catch {
        break;
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      cancel.abort();
      notifyStop(stopMarker);
      await done;
      return { samples, errors, scope: 'owned database only; one-second aggregate samples' };
    },
  };
}

export function parsePoolMetrics(text) {
  const lines = text.split('\n').filter((line) => /^solvi_db_pool_[a-z_]+(?:\{|\s)/.test(line));
  const counts = lines.filter((line) =>
    /^solvi_db_pool_acquire_duration[a-z_]*_count(?:\{|\s)/.test(line),
  );
  const acquisitionCount = counts.reduce(
    (sum, line) => sum + Number(line.trim().split(/\s+/).at(-1)),
    0,
  );
  const complete =
    counts.length > 0 &&
    Number.isFinite(acquisitionCount) &&
    ['total', 'idle', 'waiting'].every((name) =>
      lines.some((line) => new RegExp(`^solvi_db_pool_connections_${name}(?:\\{|\\s)`).test(line)),
    );
  return { lines, acquisitionCount, complete };
}

async function scrapePool(metricsBase) {
  try {
    const response = await fetch(`${metricsBase}/metrics`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { available: false };
    const text = await response.text();
    return {
      available: true,
      // These metric families are defined without IDs or user-controlled labels.
      ...parsePoolMetrics(text),
    };
  } catch {
    return { available: false };
  }
}

export function finalizeReport(report, wasInterrupted) {
  report.interrupted = wasInterrupted;
  report.success = report.success && report.cleanup?.success === true && !wasInterrupted;
  if (wasInterrupted) report.failureCode = 'BASELINE_INTERRUPTED';
  else if (report.cleanup?.success !== true && !report.failureCode)
    report.failureCode = 'CLEANUP_FAILED';
  return report;
}

export async function executeBaseline(args) {
  const profile = getProfile(args.profile);
  const workPackage = args.workPackage === undefined ? 'WP-P2-PERF-041' : args.workPackage;
  const output = await prepareOutput(args.output, profile.name, workPackage);
  const report = {
    schemaVersion: 1,
    workPackage,
    startedAt: new Date().toISOString(),
    profile,
    executionMode: {
      web: 'production build/start, SSR HTTP responses; no browser rendering measurement',
      api: 'compiled entry, NODE_ENV=development, no watcher, real local login; production local-auth guard unchanged',
      data: 'isolated synthetic PostgreSQL; no existing .env or production data',
    },
    limitations: [
      '100 active sessions is a provisional synthetic model, not a confirmed production workload.',
      'Closed-loop think-time traffic; throughput falls under saturation. Not a fixed-arrival-rate test.',
      'Not a production API/IdP, AWS, browser-rendering, availability or GA-8 acceptance result; local workflows require development mode.',
      'Pool and DB sampling are included in measured overhead; no CPU sizing claim.',
    ],
    stages: [],
    success: false,
  };
  let runtime;
  let observer;
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const progress = (stage) => {
    if (typeof stage !== 'string' || !/^[a-zA-Z0-9_.:-]{1,90}$/.test(stage)) return;
    report.stages.push({ stage, at: new Date().toISOString() });
    console.log(`baseline: ${stage}`);
  };
  try {
    const { createRuntime } = await import('./runtime.mjs');
    const { seedFixture } = await import('./fixture.mjs');
    const { runWorkload } = await import('./workload.mjs');
    runtime = await createRuntime({ onProgress: progress, signal: controller.signal, workPackage });
    report.runtime = runtime.meta;
    if (controller.signal.aborted) throw new Error('BASELINE_INTERRUPTED');
    progress('fixture');
    const fixture = await seedFixture(runtime.admin, profile, {
      createCredential: runtime.createCredential,
      databaseName: runtime.meta.database,
    });
    report.dataset = fixture.counts;
    if (args['exercise-cleanup']) throw new Error('EXPECTED_CLEANUP_EXERCISE');
    if (controller.signal.aborted) throw new Error('BASELINE_INTERRUPTED');
    report.poolBefore = await scrapePool(runtime.metricsBase);
    observer = observeDatabase(runtime.admin);
    report.workload = await runWorkload({
      profile,
      fixture,
      apiBase: runtime.apiBase,
      webBase: runtime.webBase,
      onProgress: progress,
      signal: controller.signal,
    });
    report.database = await observer.stop();
    observer = undefined;
    const { rows } = await runtime.admin.query(
      `SELECT count(*)::int AS sessions, count(DISTINCT user_id)::int AS users,
              count(*) FILTER (WHERE revoked_at IS NULL AND absolute_expires_at > now()
                               AND idle_expires_at > now())::int AS active
       FROM session WHERE user_id = ANY($1::uuid[])`,
      [fixture.actors.map((actor) => actor.userId)],
    );
    report.independentSessions = { ...rows[0], expected: profile.activeSessions };
    report.independentSessions.verified =
      rows[0].sessions === profile.activeSessions &&
      rows[0].users === profile.activeSessions &&
      rows[0].active === profile.activeSessions;
    report.poolAfter = await scrapePool(runtime.metricsBase);
    report.success =
      report.workload.measurementValid === true &&
      report.independentSessions.verified &&
      report.database.errors === 0 &&
      report.database.samples.length > 0 &&
      report.poolAfter.available &&
      report.poolAfter.complete &&
      report.poolAfter.acquisitionCount > (report.poolBefore.acquisitionCount ?? 0) &&
      !controller.signal.aborted;
    if (!report.success) report.failureCode = 'MEASUREMENT_INVALID';
  } catch (error) {
    report.failureCode = controller.signal.aborted ? 'BASELINE_INTERRUPTED' : safeCode(error);
    if (error.cleanupReport) report.cleanup = error.cleanupReport;
  } finally {
    if (observer) {
      try {
        report.database = await observer.stop();
      } catch {
        report.success = false;
        report.failureCode ??= 'OBSERVATION_STOP_FAILED';
      }
    }
    if (runtime) {
      try {
        report.cleanup = await runtime.cleanup();
      } catch {
        report.cleanup = { success: false, failureCode: 'CLEANUP_FAILED' };
      }
    }
    finalizeReport(report, controller.signal.aborted);
    report.finishedAt = new Date().toISOString();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`baseline: report ${relative(root, resolve(output, 'report.json'))}`);
    console.log(
      `baseline: ${report.success ? 'measurement-valid' : 'measurement-invalid'}; cleanup=${report.cleanup?.success === true}`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        `Usage: node tools/performance/run-baseline.mjs --profile ${profileNames.join('|')} [--output evidence/WP-P2-PERF-041/new-run] [--exercise-cleanup]`,
      );
    } else {
      const report = await executeBaseline(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`baseline: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
