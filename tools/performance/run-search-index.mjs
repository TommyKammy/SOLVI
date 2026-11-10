#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProfile, profileNames } from './profiles.mjs';
import { finalizeReport, prepareOutput } from './run-baseline.mjs';
import { prepareQueryFixture } from './run-list-diagnostic.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-051';
const optionNames = new Set(['profile', 'output', 'exercise-cleanup']);
const codes = new Set([
  'UNKNOWN_ARGUMENT',
  'DUPLICATE_ARGUMENT',
  'MISSING_ARGUMENT',
  'PROFILE_REQUIRED',
  'UNKNOWN_PROFILE',
  'INVALID_PROFILE',
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
  'DIAGNOSTIC_CATALOG_INCOMPLETE',
  'DIAGNOSTIC_RESTORATION_UNVERIFIED',
  'RUNTIME_INTERRUPTED',
  'SEARCH_REPRO_PRODUCT_SOURCE_UNAVAILABLE',
  'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
  'CLEANUP_FAILED',
]);
const stages = new Set([
  'preparation',
  'preflight',
  'copy-source',
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
  'index-ready',
  'index-catalog-completed',
  ...['short', 'wide', 'rare', 'zero', 'rare-state', 'zero-new', 'short-new'].map(
    (condition) => `index-${condition}-completed`,
  ),
  'index-boundaries-completed',
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
  if (args.output !== undefined && (typeof args.output !== 'string' || !args.output.trim())) {
    throw new Error('OUTPUT_INVALID');
  }
  if (args['exercise-cleanup'] !== undefined && typeof args['exercise-cleanup'] !== 'boolean') {
    throw new Error('EXERCISE_CLEANUP_INVALID');
  }
  return profile;
}

export function parseSearchIndexArgs(args) {
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
      parsed[name] = value;
    }
  }
  validateOptions(parsed);
  return parsed;
}

export async function executeSearchIndex(args) {
  const profile = validateOptions(args);
  const output = await prepareOutput(args.output, profile.name, workPackage);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const report = {
    schemaVersion: 1,
    workPackage,
    startedAt: new Date().toISOString(),
    profile,
    measurementScope: 'sql-and-catalog',
    capacitySkipped: true,
    capacitySkipReason: 'sql-only-protocol',
    allRequestsSucceeded: false,
    adoptionEstablished: false,
    catalogComplete: false,
    restorationVerified: false,
    interpretation: {
      model:
        'Seven fixed SQL conditions, catalog observations and own/foreign boundaries in owned PostgreSQL RLS READ ONLY contexts; no HTTP workload.',
      protocol:
        'Normal EXPLAIN ANALYZE TIMING OFF and transaction-local enable_seqscan=off plan-only controls are separate; no timing acceptance.',
      success:
        'Completed equivalent SQL, full protocol and catalog observations, verified setting restoration and cleanup; catalog health and optimization adoption are separate.',
      catalog:
        'Unavailable catalog observations fail completion while retaining completed SQL; observed unhealthy indexes or absent statistics remain diagnostic findings.',
      controls:
        'Disabling sequential-scan preference locally neither forces an index nor proves index eligibility; no production setting recommendation.',
      history: 'WP049 acceptance remains on hold; no retrospective performance acceptance.',
      limits:
        'No HTTP capacity, normal-user regression, production, AWS, IdP, browser, availability or sizing acceptance.',
    },
    stages: [],
    success: false,
  };
  const progress = (stage) => {
    if (!stages.has(stage) || report.stages.length >= 128) return;
    report.stages.push({ stage, at: new Date().toISOString() });
    console.log(`search-index: ${stage}`);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let runtime;
  try {
    const { createRuntime } = await import('./runtime.mjs');
    const { seedFixture } = await import('./fixture.mjs');
    const { analyzeSearchIndex } = await import('./search-index-analysis.mjs');
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
    report.queryAnalysis = await analyzeSearchIndex(runtime, fixture, {
      signal: controller.signal,
      onProgress: progress,
    });
    report.catalogComplete = report.queryAnalysis.catalogComplete === true;
    report.restorationVerified = report.queryAnalysis.restorationVerified === true;
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    if (
      report.queryAnalysis.completed !== true ||
      report.queryAnalysis.equivalent !== true ||
      report.queryAnalysis.protocolCompleted !== true
    ) {
      throw new Error('DIAGNOSTIC_ANALYSIS_INCOMPLETE');
    }
    if (!report.restorationVerified) throw new Error('DIAGNOSTIC_RESTORATION_UNVERIFIED');
    if (!report.catalogComplete) throw new Error('DIAGNOSTIC_CATALOG_INCOMPLETE');
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
    console.log(`search-index: report ${relative(root, resolve(output, 'report.json'))}`);
    console.log(
      `search-index: valid=${report.success}; catalog=${report.catalogComplete}; restored=${report.restorationVerified}; cleanup=${report.cleanup?.success === true}; adoption=false`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseSearchIndexArgs(process.argv.slice(2));
    if ('help' in args) {
      console.log(
        `Usage: node tools/performance/run-search-index.mjs --profile ${profileNames.join('|')} [--output evidence/WP-P2-PERF-051/new-run] [--exercise-cleanup]`,
      );
    } else {
      const report = await executeSearchIndex(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`search-index: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
