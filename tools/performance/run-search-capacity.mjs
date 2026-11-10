#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProfile, profileNames } from './profiles.mjs';
import { prepareOutput, finalizeReport } from './run-baseline.mjs';
import { parseDiagnosticArgs, prepareQueryFixture } from './run-list-diagnostic.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_WORK_PACKAGE = 'WP-P2-PERF-047';
function searchMode(args) {
  const workPackage = args.workPackage === undefined ? DEFAULT_WORK_PACKAGE : args.workPackage;
  if (!['WP-P2-PERF-047', 'WP-P2-PERF-048', 'WP-P2-PERF-049'].includes(workPackage)) {
    throw new Error('SEARCH_WORK_PACKAGE_REJECTED');
  }
  if (args['sql-only'] !== undefined && typeof args['sql-only'] !== 'boolean') {
    throw new Error('SQL_ONLY_MODE_REJECTED');
  }
  const sqlOnly = args['sql-only'] === true;
  if (sqlOnly && workPackage === 'WP-P2-PERF-047') throw new Error('SQL_ONLY_MODE_REJECTED');
  if (args['contract-only'] !== undefined && typeof args['contract-only'] !== 'boolean') {
    throw new Error('CONTRACT_ONLY_MODE_REJECTED');
  }
  const contractOnly = args['contract-only'] === true;
  if (contractOnly && workPackage !== 'WP-P2-PERF-049')
    throw new Error('CONTRACT_ONLY_MODE_REJECTED');
  if (sqlOnly && contractOnly) throw new Error('DIAGNOSTIC_MODES_CONFLICT');
  if (workPackage === 'WP-P2-PERF-049' && !sqlOnly && !contractOnly)
    throw new Error('SEARCH_049_MODE_REQUIRED');
  return { workPackage, sqlOnly, contractOnly };
}

export function parseSearchCapacityArgs(args) {
  const ordinary = [];
  const extra = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--work-package' || key === '--sql-only' || key === '--contract-only') {
      const property = key === '--work-package' ? 'workPackage' : key.slice(2);
      if (Object.hasOwn(extra, property)) throw new Error('DUPLICATE_ARGUMENT');
      if (key !== '--work-package') extra[property] = true;
      else {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
        extra[property] = value;
      }
    } else {
      ordinary.push(key);
      if (['--profile', '--label', '--output'].includes(key)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
        ordinary.push(value);
      }
    }
  }
  const parsed = parseDiagnosticArgs(ordinary);
  if (parsed.help) return parsed;
  const result = { ...parsed, ...extra };
  searchMode(result);
  return result;
}
const CODES = new Set([
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
  'DIAGNOSTIC_INCOMPLETE',
  'DIAGNOSTIC_ANALYSIS_INCOMPLETE',
  'CLEANUP_FAILED',
  'RUNTIME_INTERRUPTED',
  'SEARCH_WORK_PACKAGE_REJECTED',
  'SQL_ONLY_MODE_REJECTED',
  'CONTRACT_ONLY_MODE_REJECTED',
  'DIAGNOSTIC_MODES_CONFLICT',
  'SEARCH_049_MODE_REQUIRED',
]);
const safeCode = (error) =>
  CODES.has(error?.code ?? error?.message) ? (error.code ?? error.message) : 'DIAGNOSTIC_FAILED';

export async function executeSearchCapacity(args) {
  if (!['before', 'after'].includes(args.label)) throw new Error('LABEL_REQUIRED');
  const { workPackage, sqlOnly, contractOnly } = searchMode(args);
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
    measurementScope: sqlOnly ? 'sql-only' : contractOnly ? 'sql-and-contract' : 'sql-and-http',
    capacitySkipped: sqlOnly || contractOnly,
    ...(sqlOnly || contractOnly
      ? { capacitySkipReason: sqlOnly ? 'sql-only-requested' : 'contract-only-requested' }
      : {}),
    interpretation: {
      model: sqlOnly
        ? 'RLS READ ONLY SQL contexts and four fixed synthetic search terms; no HTTP sessions or arrival waves measured.'
        : contractOnly
          ? 'RLS READ ONLY SQL contexts and fixed authenticated API correctness probes; no capacity arrival waves measured.'
          : 'One agent and organization; four fixed synthetic search terms; independent real sessions; simultaneous API arrival waves.',
      traffic: sqlOnly
        ? 'HTTP capacity was not measured in this SQL-only diagnostic.'
        : contractOnly
          ? 'Sequential correctness probes only; HTTP capacity was not measured.'
          : '10/25/50/100 arrivals ascending and descending (smoke 3/6/9/12); not 100 active browsers or the normal user workload.',
      success: sqlOnly
        ? 'SQL analysis/equivalence and cleanup only; neither HTTP success nor optimization adoption is established.'
        : contractOnly
          ? 'SQL analysis/equivalence, API contract correctness and cleanup only; neither HTTP capacity nor optimization adoption is established.'
          : 'SQL analysis/equivalence, complete observed waves, API proof and cleanup; HTTP success and optimization adoption are separate.',
      label: 'Metadata only; the label never changes source or SQL.',
      runtime:
        'Compiled development API/local authentication; production Web build; fixed-resource isolated PostgreSQL.',
      limits:
        'No production/AWS/IdP/browser/long-duration acceptance or arbitrary DB/URL/keyword inputs.',
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
    const { runSearchCapacity } = await import('./search-capacity.mjs');
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
    // SQL measurements precede any HTTP load; each analysis callback closes its owned reader.
    progress('query-analysis');
    if (workPackage === 'WP-P2-PERF-049') {
      const { analyzeSearchStatePrefix } = await import('./search-prefix-analysis.mjs');
      report.queryAnalysis = await analyzeSearchStatePrefix(runtime, fixture, controller.signal);
    } else if (workPackage === 'WP-P2-PERF-048') {
      const { analyzeSearchPrefix } = await import('./search-prefix-analysis.mjs');
      report.queryAnalysis = await analyzeSearchPrefix(runtime, fixture, controller.signal);
    } else {
      const { runSearchCostAnalysis } = await import('./search-cost-analysis.mjs');
      report.queryAnalysis = await runSearchCostAnalysis({
        runtime,
        fixture,
        signal: controller.signal,
      });
    }
    if (controller.signal.aborted) throw new Error('DIAGNOSTIC_INTERRUPTED');
    if (report.queryAnalysis.completed !== true || report.queryAnalysis.equivalent !== true) {
      throw new Error('DIAGNOSTIC_ANALYSIS_INCOMPLETE');
    }
    if (sqlOnly) report.success = true;
    else if (contractOnly) {
      progress('api-contract');
      const { runSearchStateApiContract } = await import('./list-load.mjs');
      report.apiContract = await runSearchStateApiContract({
        runtime,
        fixture,
        profile,
        signal: controller.signal,
      });
      report.success =
        report.apiContract.completed === true &&
        report.apiContract.valid === true &&
        report.apiContract.capacityMeasured === false &&
        report.apiContract.drain?.drained === true;
    } else {
      progress('capacity');
      report.capacity = await runSearchCapacity({
        runtime,
        fixture,
        profile,
        signal: controller.signal,
        onProgress: progress,
      });
      report.allRequestsSucceeded = report.capacity.allRequestsSucceeded === true;
      report.success =
        report.capacity.completed === true && report.capacity.apiContractValid === true;
    }
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
    const args = parseSearchCapacityArgs(process.argv.slice(2));
    if (args.help)
      console.log(
        `Usage: node tools/performance/run-search-capacity.mjs --profile ${profileNames.join('|')} --label before|after [--work-package WP-P2-PERF-047|WP-P2-PERF-048|WP-P2-PERF-049] [--sql-only (WP048/049 only) | --contract-only (WP049 only)] [--output evidence/<selected-work-package>/new-run] [--exercise-cleanup]`,
      );
    else {
      const report = await executeSearchCapacity(args);
      process.exitCode = report.success ? 0 : 1;
    }
  } catch (error) {
    console.error(`diagnostic: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
