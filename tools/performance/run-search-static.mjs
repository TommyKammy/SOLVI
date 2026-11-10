#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareOutput, finalizeReport } from './run-baseline.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workPackage = 'WP-P2-PERF-053';
const corpusPath = 'evidence/WP-P2-PERF-053/20261006-approval/corpus.json';
const corpusSha256 = '3bc3df525b34729cf43bc16f33048719261f4016b6c979d026ab22b77b4a75ee';
const optionNames = new Set(['output', 'exercise-cleanup']);
const codes = new Set([
  'UNKNOWN_ARGUMENT',
  'DUPLICATE_ARGUMENT',
  'MISSING_ARGUMENT',
  'OUTPUT_INVALID',
  'EXERCISE_CLEANUP_INVALID',
  'OUTPUT_OUTSIDE_EVIDENCE',
  'OUTPUT_SYMLINK',
  'OUTPUT_ALREADY_EXISTS',
  'OUTPUT_WORK_PACKAGE_REJECTED',
  'STATIC_CORPUS_MISMATCH',
  'STATIC_PROOF_INCOMPLETE',
  'EXPECTED_CLEANUP_EXERCISE',
  'STATIC_INTERRUPTED',
  'STATIC_TIME_BUDGET_EXCEEDED',
  'CLEANUP_FAILED',
  'SEARCH_REPRO_PRODUCT_SOURCE_MISMATCH',
  'SEARCH_REPRO_PRODUCT_SOURCE_UNAVAILABLE',
  'STATIC_SOURCE_MISMATCH',
  'STATIC_API_START_FORBIDDEN',
  'STATIC_DEFINITION_MISMATCH',
]);
const stages = new Set([
  'preparation',
  'preflight',
  'copy-source',
  'build-shared',
  'build-api',
  'build-web',
  'create-database',
  'ready',
  'fixture',
  'fixture-ready',
  'query-analysis',
  'static-catalog-completed',
  'static-corpus-completed',
  'static-native-completed',
  'static-boundaries-completed',
  'static-plans-completed',
  'cleanup',
  'static-start',
  'static-catalog',
  'static-corpus',
  'static-native',
  'static-boundary',
  'static-plans',
  'static-complete',
  'static-failed',
]);
const safeCode = (error) => (codes.has(error?.message) ? error.message : 'STATIC_PROOF_FAILED');

function assertStaticInputs() {
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  try {
    const approval = readFileSync(
      resolve(root, 'evidence/WP-P2-PERF-053/20261006-approval/inputs.json'),
    );
    if (sha(approval) !== '4fc403c324d5ab3c716e3cf4a6f8579131ba4f1350cdbbc95468a49abc1d7403')
      throw new Error();
    const input = JSON.parse(approval);
    const manifest = readFileSync(resolve(root, input.sourceManifest.path));
    if (sha(manifest) !== input.sourceManifest.sha256) throw new Error();
    const sources = JSON.parse(manifest).sourceArtifacts;
    if (
      sources.length !== 12 ||
      sources.some((item) => sha(readFileSync(resolve(root, item.path))) !== item.sha256)
    )
      throw new Error();
    if (sha(readFileSync(resolve(root, input.rules.path))) !== input.rules.sha256)
      throw new Error();
    const prior = [];
    function walk(path) {
      for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
        const child = path + '/' + entry.name;
        if (child === 'evidence/WP-P2-PERF-053' || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) prior.push([child, sha(readFileSync(resolve(root, child)))]);
      }
    }
    walk('evidence');
    prior.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (
      prior.length !== input.priorEvidence.regularFiles ||
      sha(JSON.stringify(prior)) !== input.priorEvidence.sha256
    )
      throw new Error();
    return {
      sourceArtifacts: 12,
      priorEvidenceFiles: 991,
      priorEvidenceUnchanged: true,
      approvalInputsUnchanged: true,
    };
  } catch {
    throw new Error('STATIC_SOURCE_MISMATCH');
  }
}

function validateOptions(args) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Reflect.ownKeys(args).some((key) => !optionNames.has(key))
  )
    throw new Error('UNKNOWN_ARGUMENT');
  if (args.output !== undefined && (typeof args.output !== 'string' || !args.output.trim()))
    throw new Error('OUTPUT_INVALID');
  if (args['exercise-cleanup'] !== undefined && typeof args['exercise-cleanup'] !== 'boolean')
    throw new Error('EXERCISE_CLEANUP_INVALID');
  return args;
}

export function parseSearchStaticArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help') {
      if (args.length !== 1) throw new Error('UNKNOWN_ARGUMENT');
      return { help: true };
    }
    if (!['--output', '--exercise-cleanup'].includes(key)) throw new Error('UNKNOWN_ARGUMENT');
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error('DUPLICATE_ARGUMENT');
    if (key === '--exercise-cleanup') result[name] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT');
      result[name] = value;
    }
  }
  return validateOptions(result);
}

function publicRuntime(meta = {}) {
  const db = meta.databaseRuntime;
  const runtime = { mode: 'database-only', apiStarted: false, webStarted: false };
  if (typeof meta.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(meta.sourceRevision))
    runtime.sourceRevision = meta.sourceRevision;
  if (
    db &&
    db.bindHost === '127.0.0.1' &&
    Number.isInteger(db.port) &&
    db.port > 0 &&
    db.port <= 65535 &&
    /^[a-f0-9]{64}$/.test(db.containerId)
  ) {
    runtime.databaseRuntime = {
      containerId: db.containerId,
      port: db.port,
      bindHost: '127.0.0.1',
      cpuLimit: 2,
      memoryMiB: 1536,
      tmpfsMiB: 1024,
    };
  }
  if (
    Array.isArray(meta.sourceFiles) &&
    meta.sourceFiles.length > 0 &&
    meta.sourceFiles.length <= 10000 &&
    meta.sourceFiles.every(
      (item) =>
        typeof item.path === 'string' &&
        /^[a-zA-Z0-9_./@()[\]-]+$/.test(item.path) &&
        !item.path.startsWith('/') &&
        !item.path.split('/').includes('..') &&
        /^[a-f0-9]{64}$/.test(item.sha256),
    )
  ) {
    const files = meta.sourceFiles.map(({ path, sha256 }) => ({ path, sha256 }));
    const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if (fingerprint === meta.sourceManifestSha256) {
      runtime.sourceFiles = files;
      runtime.sourceManifestSha256 = fingerprint;
      runtime.sourceInventoryVerified = true;
    }
  }
  if (
    typeof meta.tempDirectory === 'string' &&
    /(?:^|\/)solvi-perf041-[a-zA-Z0-9_-]+$/.test(meta.tempDirectory)
  )
    runtime.tempDirectory = meta.tempDirectory;
  return runtime;
}

/** Dependency injection is for bounded CLI regression tests, never a command-line option. */
export async function executeSearchStatic(args, dependencies = {}) {
  validateOptions(args);
  const output = await (dependencies.prepareOutput ?? prepareOutput)(
    args.output,
    'static',
    workPackage,
  );
  const controller = new AbortController();
  let budgetExceeded = false;
  const interrupt = () => controller.abort();
  const budget = setTimeout(() => {
    budgetExceeded = true;
    controller.abort();
  }, 15 * 60_000);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const report = {
    schemaVersion: 1,
    workPackage,
    startedAt: new Date().toISOString(),
    success: false,
    protocol: {
      fixedCorpusPairs: 1034,
      maxTickets: 4096,
      maxPostingRows: 1_000_000,
      maxBodyCharacters: 2048,
      maxDatabaseBytes: 512 * 1024 * 1024,
      statementTimeoutMs: 30_000,
      readBudgetMs: 120_000,
      runBudgetMs: 15 * 60_000,
    },
    corpusSha256,
    authorizationAdoption: false,
    adoptionEstablished: false,
    httpAuthenticationExecuted: false,
  };
  let runtime;
  const progress = (stage) => {
    if (stage === 'start-api' || stage === 'start-web')
      throw new Error('STATIC_API_START_FORBIDDEN');
    if (!stages.has(stage)) return;
    report.lastStage = stage;
    (dependencies.onProgress ?? ((value) => console.log(`search-static: ${value}`)))(stage);
  };
  try {
    progress('preparation');
    report.inputs = assertStaticInputs();
    const bytes = await (dependencies.readCorpus ?? (() => readFile(resolve(root, corpusPath))))();
    if (createHash('sha256').update(bytes).digest('hex') !== corpusSha256)
      throw new Error('STATIC_CORPUS_MISMATCH');
    const corpus = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const module = dependencies.createRuntime ? undefined : await import('./runtime.mjs');
    const definition = (
      dependencies.fixtureDefinition ?? module?.staticSearchFixtureDefinition
    )?.();
    if (!definition || typeof definition !== 'object')
      throw new Error('STATIC_DEFINITION_MISMATCH');
    const definitionSha256 = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    report.fixtureDefinition = {
      definitionSha256,
      ticketRows: 4096,
      overriddenRows: 16,
      recipe: 'ADR0037-E3',
      privatePayloadPublished: false,
    };
    const saveDefinition =
      dependencies.writeReport ??
      ((path, value) => writeFile(path, value, { flag: 'wx', mode: 0o600 }));
    // The fixed recipe fingerprint is published before any DB resources are created; raw rows stay private.
    await saveDefinition(
      resolve(output, 'fixture-definition.json'),
      JSON.stringify(report.fixtureDefinition, null, 2) + '\n',
    );
    const factory = dependencies.createRuntime ?? module.createRuntime;
    try {
      runtime = await factory({ workPackage, signal: controller.signal, onProgress: progress });
    } catch (error) {
      // Startup failures are already cleaned by the owned factory; don't expose raw metadata.
      if (error?.meta) report.runtime = publicRuntime(error.meta);
      if (error?.cleanupReport) report.cleanup = error.cleanupReport;
      throw error;
    }
    report.runtime = publicRuntime(runtime.meta);
    if (!dependencies.createRuntime && report.runtime.sourceInventoryVerified !== true)
      throw new Error('STATIC_SOURCE_MISMATCH');
    if (controller.signal.aborted) throw new Error('STATIC_INTERRUPTED');
    progress('fixture');
    const fixture = await runtime.prepareStaticFixture();
    if (fixture?.definitionSha256 !== definitionSha256)
      throw new Error('STATIC_DEFINITION_MISMATCH');
    progress('fixture-ready');
    if (args['exercise-cleanup']) throw new Error('EXPECTED_CLEANUP_EXERCISE');
    if (controller.signal.aborted) throw new Error('STATIC_INTERRUPTED');
    progress('query-analysis');
    const analyze =
      dependencies.analyzeSearchStatic ??
      (await import('./search-static-analysis.mjs')).analyzeSearchStatic;
    report.queryAnalysis = await analyze({
      withReadOnly: runtime.withStaticReadOnly,
      buildTicketListQuery: runtime.buildTicketListQuery,
      fixture,
      corpus,
      signal: controller.signal,
      onProgress: progress,
    });
    if (controller.signal.aborted) throw new Error('STATIC_INTERRUPTED');
    const analysis = report.queryAnalysis;
    if (
      analysis.completed !== true ||
      analysis.equivalent !== true ||
      analysis.protocolCompleted !== true ||
      analysis.catalogComplete !== true ||
      analysis.indexProofComplete !== true ||
      analysis.authorizationAdoption !== false ||
      analysis.adoptionEstablished !== false
    )
      throw new Error('STATIC_PROOF_INCOMPLETE');
    report.success = true;
  } catch (error) {
    report.failureCode = controller.signal.aborted
      ? budgetExceeded
        ? 'STATIC_TIME_BUDGET_EXCEEDED'
        : 'STATIC_INTERRUPTED'
      : safeCode(error);
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
    if (controller.signal.aborted)
      report.failureCode = budgetExceeded ? 'STATIC_TIME_BUDGET_EXCEEDED' : 'STATIC_INTERRUPTED';
    report.finishedAt = new Date().toISOString();
    clearTimeout(budget);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const save =
      dependencies.writeReport ??
      ((path, value) => writeFile(path, value, { flag: 'wx', mode: 0o600 }));
    await save(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (!dependencies.quiet) {
      console.log(`search-static: report ${relative(root, resolve(output, 'report.json'))}`);
      console.log(
        `search-static: valid=${report.success}; cleanup=${report.cleanup?.success === true}; adoption=false`,
      );
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseSearchStaticArgs(process.argv.slice(2));
    if ('help' in args)
      console.log(
        'Usage: node tools/performance/run-search-static.mjs [--output evidence/WP-P2-PERF-053/new-run] [--exercise-cleanup]',
      );
    else process.exitCode = (await executeSearchStatic(args)).success ? 0 : 1;
  } catch (error) {
    console.error(`search-static: ${safeCode(error)}`);
    process.exitCode = 1;
  }
}
