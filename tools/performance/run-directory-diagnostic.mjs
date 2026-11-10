#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProfile, profileNames } from './profiles.mjs';
import { prepareOutput, finalizeReport } from './run-baseline.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-045';

export function parseDirectoryArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { help: true };
    if (
      !['--profile', '--label', '--output', '--exercise-cleanup', '--security-checks'].includes(key)
    ) {
      throw new Error('UNKNOWN_ARGUMENT');
    }
    const name = key.slice(2);
    if (Object.hasOwn(parsed, name)) throw new Error('DUPLICATE_ARGUMENT');
    if (key === '--exercise-cleanup' || key === '--security-checks') parsed[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
      parsed[name] = value;
    }
  }
  if (!parsed.profile) throw new Error('PROFILE_REQUIRED');
  getProfile(parsed.profile);
  if (!['before', 'after'].includes(parsed.label)) throw new Error('LABEL_REQUIRED');
  validateSecurityOptions(parsed);
  return parsed;
}

function validateSecurityOptions(args) {
  if (args['security-checks'] !== undefined && args['security-checks'] !== true)
    throw new Error('SECURITY_CHECKS_INVALID');
  if (args['security-checks'] && (args.profile !== 'smoke' || args.label !== 'after'))
    throw new Error('SECURITY_CHECKS_AFTER_SMOKE_ONLY');
}

const FAILURE_CODES = new Set([
  'UNKNOWN_ARGUMENT',
  'DUPLICATE_ARGUMENT',
  'MISSING_ARGUMENT',
  'PROFILE_REQUIRED',
  'LABEL_REQUIRED',
  'SECURITY_CHECKS_INVALID',
  'SECURITY_CHECKS_AFTER_SMOKE_ONLY',
  'UNKNOWN_PROFILE',
  'INVALID_PROFILE',
  'OUTPUT_WORK_PACKAGE_REJECTED',
  'OUTPUT_OUTSIDE_EVIDENCE',
  'OUTPUT_SYMLINK',
  'OUTPUT_ALREADY_EXISTS',
  'DIAGNOSTIC_INTERRUPTED',
  'EXPECTED_CLEANUP_EXERCISE',
  'DIAGNOSTIC_COMPARISON_INCOMPLETE',
  'SECURITY_REQUIRES_COMPLETE_ANALYSIS',
  'DIRECTORY_STATE_PROBES_FAILED',
  'DIAGNOSTIC_INCOMPLETE',
  'CLEANUP_FAILED',
  'RUNTIME_INTERRUPTED',
]);
function safeCode(error) {
  const value = error?.code ?? error?.message;
  return FAILURE_CODES.has(value) ? value : 'DIAGNOSTIC_FAILED';
}

export async function executeDirectoryDiagnostic(args) {
  if (!['before', 'after'].includes(args.label)) throw new Error('LABEL_REQUIRED');
  validateSecurityOptions(args);
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
        'One identical organization administrator and organization; full /users roster; independent sessions versus one session.',
      traffic:
        'Fixed simultaneous burst schedule, not 100 people or the normal think-time profile.',
      success:
        'Complete diagnostic collection, API contract probes, query equivalence and cleanup; inspect allRequestsSucceeded and query work separately; security suite is optional and recorded separately.',
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
    const { runDirectoryComparison, runDirectoryStateProbes } =
      await import('./directory-load.mjs');
    const { runDirectoryAnalysis } = await import('./directory-analysis.mjs');
    runtime = await createRuntime({ workPackage, onProgress: progress, signal: controller.signal });
    report.runtime = runtime.meta;
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    progress('fixture');
    const fixture = await seedFixture(runtime.admin, profile, {
      createCredential: runtime.createCredential,
      databaseName: runtime.meta.database,
    });
    report.dataset = fixture.counts;
    if (args['exercise-cleanup']) throw new Error('EXPECTED_CLEANUP_EXERCISE');
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    report.comparison = await runDirectoryComparison({
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
    report.queryAnalysis = await runDirectoryAnalysis({
      runtime,
      fixture,
      signal: controller.signal,
    });
    if (args['security-checks']) {
      if (report.queryAnalysis.completed !== true || report.queryAnalysis.equivalent !== true)
        throw new Error('SECURITY_REQUIRES_COMPLETE_ANALYSIS');
      if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
      progress('directory-security-checks');
      report.stateProbes = await runDirectoryStateProbes({
        runtime,
        fixture,
        profile,
        signal: controller.signal,
      });
      if (report.stateProbes.completed !== true || report.stateProbes.valid !== true)
        throw new Error('DIRECTORY_STATE_PROBES_FAILED');
      report.securityChecks = await runtime.runDirectorySecurityTests();
    }
    report.success =
      report.comparison.comparisonCompleted === true &&
      report.comparison.apiContractValid === true &&
      report.queryAnalysis.completed === true &&
      report.queryAnalysis.equivalent === true &&
      (!args['security-checks'] ||
        (report.securityChecks.completed === true && report.securityChecks.success === true));
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
    const args = parseDirectoryArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        `Usage: node tools/performance/run-directory-diagnostic.mjs --profile ${profileNames.join('|')} --label before|after [--output evidence/WP-P2-PERF-045/new-run] [--exercise-cleanup] [--security-checks (after/smoke only)]`,
      );
    } else {
      const report = await executeDirectoryDiagnostic(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`diagnostic: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
