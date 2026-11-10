#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProfile, profileNames } from './profiles.mjs';
import { prepareOutput, finalizeReport } from './run-baseline.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-042';

export function parseDiagnosticArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') return { help: true };
    if (!['--profile', '--label', '--output', '--exercise-cleanup'].includes(key)) {
      throw new Error('UNKNOWN_ARGUMENT');
    }
    const name = key.slice(2);
    if (Object.hasOwn(parsed, name)) throw new Error('DUPLICATE_ARGUMENT');
    if (key === '--exercise-cleanup') parsed[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
      parsed[name] = value;
    }
  }
  if (!parsed.profile) throw new Error('PROFILE_REQUIRED');
  getProfile(parsed.profile);
  if (!['before', 'after'].includes(parsed.label)) throw new Error('LABEL_REQUIRED');
  return parsed;
}

function safeCode(error) {
  const value = error?.code ?? error?.message;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,90}$/.test(value)
    ? value
    : 'DIAGNOSTIC_FAILED';
}

/** Only the newly owned seeded database is accepted; a missing SLA policy exercises NULLs. */
export async function prepareQueryFixture(runtime, fixture) {
  if (!/^solvi_perf041_\d+_[a-f0-9]{12}$/.test(runtime.meta.database)) {
    throw new Error('FIXTURE_DATABASE_REJECTED');
  }
  const identity = await runtime.admin.query('SELECT current_database() AS database');
  if (identity.rows[0]?.database !== runtime.meta.database) {
    throw new Error('FIXTURE_DATABASE_MISMATCH');
  }
  const removed = await runtime.admin.query(
    "DELETE FROM sla_policy WHERE organization_id=$1 AND priority='critical'",
    [fixture.organizationId],
  );
  if (removed.rowCount !== 1) throw new Error('FIXTURE_SLA_POLICY_UNEXPECTED');
  for (const table of ['ticket', 'app_user', 'role_binding', 'sla_policy', 'assignment_group']) {
    await runtime.admin.query(`ANALYZE ${table}`);
  }
  return { missingCriticalSlaPolicyRows: removed.rowCount, statistics: 'explicit-analyze' };
}

export async function executeListDiagnostic(args) {
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
        'One identical agent principal, organization and list URL; independent sessions versus one session.',
      traffic:
        'Fixed simultaneous burst schedule, not 100 people or the normal think-time profile.',
      success:
        'Complete diagnostic collection, query equivalence and cleanup; inspect allRequestsSucceeded separately.',
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
    const { runListComparison } = await import('./list-load.mjs');
    const { runQueryAnalysis } = await import('./list-query-analysis.mjs');
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
    report.comparison = await runListComparison({
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
    report.queryAnalysis = await runQueryAnalysis({ runtime, fixture, signal: controller.signal });
    report.success =
      report.comparison.comparisonCompleted === true &&
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
    const args = parseDiagnosticArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        `Usage: node tools/performance/run-list-diagnostic.mjs --profile ${profileNames.join('|')} --label before|after [--output evidence/WP-P2-PERF-042/new-run] [--exercise-cleanup]`,
      );
    } else {
      const report = await executeListDiagnostic(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`diagnostic: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
