#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProfile, profileNames } from './profiles.mjs';
import { prepareOutput, finalizeReport } from './run-baseline.mjs';
import { parseDiagnosticArgs, prepareQueryFixture } from './run-list-diagnostic.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-046';

export const parseSearchArgs = parseDiagnosticArgs;

const FAILURE_CODES = new Set([
  'UNKNOWN_ARGUMENT',
  'DUPLICATE_ARGUMENT',
  'MISSING_ARGUMENT',
  'PROFILE_REQUIRED',
  'LABEL_REQUIRED',
  'UNKNOWN_PROFILE',
  'INVALID_PROFILE',
  'OUTPUT_WORK_PACKAGE_REJECTED',
  'OUTPUT_OUTSIDE_EVIDENCE',
  'OUTPUT_SYMLINK',
  'OUTPUT_ALREADY_EXISTS',
  'DIAGNOSTIC_INTERRUPTED',
  'EXPECTED_CLEANUP_EXERCISE',
  'DIAGNOSTIC_COMPARISON_INCOMPLETE',
  'DIAGNOSTIC_INCOMPLETE',
  'CLEANUP_FAILED',
  'RUNTIME_INTERRUPTED',
]);
function safeCode(error) {
  const value = error?.code ?? error?.message;
  return FAILURE_CODES.has(value) ? value : 'DIAGNOSTIC_FAILED';
}

export async function executeSearchDiagnostic(args) {
  if (!['before', 'after'].includes(args.label)) throw new Error('LABEL_REQUIRED');
  const profile = getProfile(args.profile);
  const output = await prepareOutput(args.output, `${args.label}-${profile.name}`, workPackage);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const report = {
    schemaVersion: 1,
    workPackage,
    label: args.label,
    startedAt: new Date().toISOString(),
    profile,
    interpretation: {
      model:
        'One identical agent principal and organization; keyword 合成性能問い合わせ 1; created_at DESC, id DESC; limit 50; independent sessions versus one session.',
      traffic:
        'Fixed simultaneous burst schedule, not 100 people or the normal think-time profile.',
      success:
        'Complete diagnostic collection, API contract probes, query equivalence and cleanup; inspect allRequestsSucceeded and projection work separately.',
      label: 'Comparison label is metadata only; it never switches product source or SQL.',
      runtime:
        'Compiled development API with real local authentication; production Web build; isolated PostgreSQL.',
      limits:
        'No production/AWS/IdP/browser/long-duration acceptance; no arbitrary DB or URL inputs.',
    },
    stages: [],
    success: false,
    allRequestsSucceeded: false,
  };
  const progress = (stage) => {
    if (typeof stage !== 'string' || !/^[a-zA-Z0-9_.:-]{1,90}$/.test(stage)) return;
    report.stages.push({ stage, at: new Date().toISOString() });
    console.log(`diagnostic: ${stage}`);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let runtime;
  try {
    const { createRuntime } = await import('./runtime.mjs');
    const { seedFixture } = await import('./fixture.mjs');
    const { runSearchComparison } = await import('./list-load.mjs');
    const { runSearchAnalysis } = await import('./search-analysis.mjs');
    runtime = await createRuntime({ workPackage, onProgress: progress, signal: controller.signal });
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
    report.comparison = await runSearchComparison({
      runtime,
      fixture,
      profile,
      signal: controller.signal,
      onProgress: progress,
    });
    report.allRequestsSucceeded = report.comparison.allRequestsSucceeded === true;
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    // An incomplete comparison can leave server-side work draining after client timeouts.
    // Never contaminate EXPLAIN measurements with those outstanding requests.
    if (report.comparison.comparisonCompleted !== true) {
      throw new Error('DIAGNOSTIC_COMPARISON_INCOMPLETE');
    }
    progress('query-analysis');
    report.queryAnalysis = await runSearchAnalysis({
      runtime,
      fixture,
      signal: controller.signal,
    });
    report.success =
      report.comparison.comparisonCompleted === true &&
      report.comparison.apiContractValid === true &&
      report.queryAnalysis.completed === true &&
      report.queryAnalysis.equivalent === true;
    if (!report.success) report.failureCode = 'DIAGNOSTIC_INCOMPLETE';
  } catch (error) {
    report.failureCode = controller.signal.aborted ? 'DIAGNOSTIC_INTERRUPTED' : safeCode(error);
    if (error.meta) report.runtime = error.meta;
    if (error.cleanupReport) report.cleanup = error.cleanupReport;
  } finally {
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
    console.log(`diagnostic: report ${relative(root, resolve(output, 'report.json'))}`);
    console.log(
      `diagnostic: valid=${report.success}; allRequestsSucceeded=${report.allRequestsSucceeded}; cleanup=${report.cleanup?.success === true}`,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseSearchArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        `Usage: node tools/performance/run-search-diagnostic.mjs --profile ${profileNames.join('|')} --label before|after [--output evidence/WP-P2-PERF-046/new-run] [--exercise-cleanup]`,
      );
    } else {
      const report = await executeSearchDiagnostic(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`diagnostic: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
