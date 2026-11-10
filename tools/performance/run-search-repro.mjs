#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProfile, profileNames } from './profiles.mjs';
import { finalizeReport, prepareOutput } from './run-baseline.mjs';
import { prepareQueryFixture } from './run-list-diagnostic.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-050';
const optionNames = new Set(['profile', 'replica', 'output', 'exercise-cleanup']);
const codes = new Set([
  'UNKNOWN_ARGUMENT',
  'DUPLICATE_ARGUMENT',
  'MISSING_ARGUMENT',
  'PROFILE_REQUIRED',
  'UNKNOWN_PROFILE',
  'INVALID_PROFILE',
  'REPLICA_REQUIRED',
  'REPLICA_INVALID',
  'OUTPUT_INVALID',
  'EXERCISE_CLEANUP_INVALID',
  'OUTPUT_WORK_PACKAGE_REJECTED',
  'OUTPUT_OUTSIDE_EVIDENCE',
  'OUTPUT_SYMLINK',
  'OUTPUT_ALREADY_EXISTS',
  'FIXTURE_DATABASE_REJECTED',
  'FIXTURE_DATABASE_MISMATCH',
  'FIXTURE_SLA_POLICY_UNEXPECTED',
  'EXPECTED_CLEANUP_EXERCISE',
  'DIAGNOSTIC_INTERRUPTED',
  'DIAGNOSTIC_ANALYSIS_INCOMPLETE',
  'RUNTIME_INTERRUPTED',
  'SEARCH_REPRO_PRODUCT_SOURCE_UNAVAILABLE',
  'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
  'CLEANUP_FAILED',
]);
const stages = new Set([
  'preparation',
  'preflight',
  'copy-source',
  'compile-legacy-ticket-query',
  'compile-legacy-search-query',
  'compile-legacy-search-workload',
  'compile-legacy-search-prefix',
  'compile-legacy-search-048',
  'compile-legacy-search-049',
  'build-shared',
  'build-api',
  'build-web',
  'create-database',
  'start-api',
  'start-web',
  'ready',
  'fixture',
  'query-analysis',
  'repro-ready',
  ...['rare', 'zero', 'rare-state', 'zero-new', 'short-new'].flatMap((condition) =>
    ['plain', 'explain-off', 'explain-on'].map((phase) => `repro-${condition}-${phase}-completed`),
  ),
  'cleanup',
]);

const safeCode = (error) => {
  const value = error?.code ?? error?.message;
  return codes.has(value) ? value : 'DIAGNOSTIC_FAILED';
};

function validateOptions(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('UNKNOWN_ARGUMENT');
  }
  if (Reflect.ownKeys(args).some((key) => !optionNames.has(key))) {
    throw new Error('UNKNOWN_ARGUMENT');
  }
  if (typeof args.profile !== 'string' || !args.profile) throw new Error('PROFILE_REQUIRED');
  const profile = getProfile(args.profile);
  if (args.replica === undefined) throw new Error('REPLICA_REQUIRED');
  if (args.replica !== 1 && args.replica !== 2) throw new Error('REPLICA_INVALID');
  if (args.output !== undefined && (typeof args.output !== 'string' || !args.output.trim())) {
    throw new Error('OUTPUT_INVALID');
  }
  if (args['exercise-cleanup'] !== undefined && typeof args['exercise-cleanup'] !== 'boolean') {
    throw new Error('EXERCISE_CLEANUP_INVALID');
  }
  return profile;
}

export function parseSearchReproArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (typeof key !== 'string' || !key.startsWith('--') || !optionNames.has(key.slice(2))) {
      throw new Error('UNKNOWN_ARGUMENT');
    }
    const name = key.slice(2);
    if (Object.hasOwn(parsed, name)) throw new Error('DUPLICATE_ARGUMENT');
    if (key === '--exercise-cleanup') parsed[name] = true;
    else {
      const value = args[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new Error('MISSING_ARGUMENT');
      }
      if (key === '--replica') {
        if (value !== '1' && value !== '2') throw new Error('REPLICA_INVALID');
        parsed.replica = Number(value);
      } else parsed[name] = value;
    }
  }
  validateOptions(parsed);
  return parsed;
}

export async function executeSearchRepro(args) {
  const profile = validateOptions(args);
  const output = await prepareOutput(
    args.output,
    `${profile.name}-replica-${args.replica}`,
    workPackage,
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const report = {
    schemaVersion: 1,
    workPackage,
    startedAt: new Date().toISOString(),
    profile,
    replica: args.replica,
    measurementScope: 'sql-only',
    capacitySkipped: true,
    capacitySkipReason: 'sql-only-protocol',
    allRequestsSucceeded: false,
    adoptionEstablished: false,
    resourceObservationsComplete: false,
    interpretation: {
      model:
        'Five fixed SQL conditions in owned PostgreSQL RLS READ ONLY contexts; no HTTP workload.',
      protocol:
        'Plain SELECT and EXPLAIN TIMING OFF/ON are separate phases; replica controls only the preregistered ordering.',
      success:
        'Completed equivalent SQL and complete sampling protocol plus cleanup; resource availability, performance reproduction and adoption are separate.',
      resources:
        'Owned-container CPU/IO deltas include background work; unavailable observations do not become zero or invalidate otherwise completed SQL.',
      history:
        'WP049 acceptance remains on hold; this diagnostic cannot retrospectively pass it or establish statistical equivalence.',
      limits:
        'No HTTP capacity, normal-user regression, production, AWS, IdP, browser, availability or sizing acceptance.',
    },
    stages: [],
    success: false,
  };
  const progress = (stage) => {
    if (!stages.has(stage) || report.stages.length >= 128) return;
    report.stages.push({ stage, at: new Date().toISOString() });
    console.log(`search-repro: ${stage}`);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let runtime;
  try {
    const { createRuntime } = await import('./runtime.mjs');
    const { seedFixture } = await import('./fixture.mjs');
    const { analyzeSearchRepro } = await import('./search-repro-analysis.mjs');
    progress('preparation');
    try {
      runtime = await createRuntime({
        workPackage,
        onProgress: progress,
        signal: controller.signal,
      });
    } catch (error) {
      // Only the owned runtime factory supplies startup metadata/cleanup; later errors cannot replace it.
      if (error?.meta) report.runtime = error.meta;
      if (error?.cleanupReport) report.cleanup = error.cleanupReport;
      throw error;
    }
    report.runtime = runtime.meta;
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    progress('fixture');
    const fixture = await seedFixture(runtime.admin, profile, {
      createCredential: runtime.createCredential,
      databaseName: runtime.meta.database,
    });
    report.dataset = fixture.counts;
    report.fixtureAdjustments = await prepareQueryFixture(runtime, fixture);
    if (args['exercise-cleanup']) throw new Error('EXPECTED_CLEANUP_EXERCISE');
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    progress('query-analysis');
    report.queryAnalysis = await analyzeSearchRepro(runtime, fixture, {
      replica: args.replica,
      signal: controller.signal,
      onProgress: progress,
    });
    report.resourceObservationsComplete =
      report.queryAnalysis.resourceObservations?.complete === true;
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    if (
      report.queryAnalysis.completed !== true ||
      report.queryAnalysis.equivalent !== true ||
      report.queryAnalysis.protocolCompleted !== true
    ) {
      throw new Error('DIAGNOSTIC_ANALYSIS_INCOMPLETE');
    }
    report.success = true;
  } catch (error) {
    report.failureCode = controller.signal.aborted ? 'DIAGNOSTIC_INTERRUPTED' : safeCode(error);
  } finally {
    progress('cleanup');
    if (runtime) {
      try {
        report.cleanup = await runtime.cleanup();
      } catch {
        report.cleanup = { success: false, failureCode: 'CLEANUP_FAILED' };
      }
    }
    finalizeReport(report, controller.signal.aborted);
    if (report.interrupted) report.failureCode = 'DIAGNOSTIC_INTERRUPTED';
    report.finishedAt = new Date().toISOString();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(`search-repro: report ${relative(root, resolve(output, 'report.json'))}`);
    console.log(
      `search-repro: valid=${report.success}; resources=${report.resourceObservationsComplete}; cleanup=${report.cleanup?.success === true}; adoption=false`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseSearchReproArgs(process.argv.slice(2));
    if ('help' in args) {
      console.log(
        `Usage: node tools/performance/run-search-repro.mjs --profile ${profileNames.join('|')} --replica 1|2 [--output evidence/WP-P2-PERF-050/new-run] [--exercise-cleanup]`,
      );
    } else {
      const report = await executeSearchRepro(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`search-repro: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
