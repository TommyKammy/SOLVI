import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'd28b95edb49e900a8004b96c9d2536fd000468a5';
const leaf = 'evidence/WP-P3-KNWEDIT-083/20261010/';
const args = process.argv.slice(2);
const verifyOnly = args.length === 1 && args[0] === '--verify';
assert.ok(verifyOnly || (args.length === 2 && args[0] === '--output'));
const output = verifyOnly ? null : resolve(root, args[1]);
if (output) {
  const within = relative(resolve(root, leaf), output);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  assert.equal(realpathSync(dirname(output)), dirname(output));
}
const git = (...argv) =>
  execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 16000000 });
const old = (path) =>
  execFileSync('git', ['show', base + ':' + path], { cwd: root, maxBuffer: 16000000 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowed = new Set([
  'apps/web/src/app/knowledge/[id]/page.tsx',
  'apps/web/src/components/KnowledgeEditor.tsx',
  'apps/web/src/components/KnowledgeEditor.module.css',
  'apps/web/src/components/KnowledgeManagement.tsx',
  'tests/unit/knowledge-edit-ui.test.ts',
  'tests/unit/knowledge-detail-recovery-ui.test.ts',
  'tools/check_knowledge_edit_ui.mjs',
  'tools/knowledge_edit_fixture.mjs',
  'tools/knowledge_edit_scope.mjs',
  'docs/planning/04_Development/04.28_Knowledge_Editing_CSV_Inspection_Group_Plan.md',
  'docs/planning/06_WorkPackages/P3_Knowledge/WP-P3-KNWEDIT-083.md',
  'docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md',
  'docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md',
  'docs/planning/11_UI_UX/11.11_UI_State_and_Error_Model.md',
]);
const changed = [
  ...new Set(
    (git('diff', '--name-only', base) + git('ls-files', '--others', '--exclude-standard'))
      .trim()
      .split('\n')
      .filter(Boolean),
  ),
];
assert.ok(
  changed.every((path) => allowed.has(path) || path.startsWith('evidence/WP-P3-KNWEDIT-083/')),
);
const protectedPaths = [
  'apps/web/src/lib/api.ts',
  'apps/web/src/app/knowledge/actions.ts',
  'apps/web/src/components/FeedbackForm.tsx',
  'apps/web/src/components/ContextLink.tsx',
  'apps/web/src/app/knowledge/new/page.tsx',
  'apps/web/src/app/globals.css',
];
const protection = protectedPaths.map((path) => {
  const value = sha(readFileSync(resolve(root, path)));
  assert.equal(value, sha(old(path)));
  return { path, sha256: value, unchanged: true };
});
const pagePath = 'apps/web/src/app/knowledge/[id]/page.tsx';
const page = readFileSync(resolve(root, pagePath), 'utf8'),
  basePage = old(pagePath).toString();
const failure = (s) =>
  s.slice(s.indexOf('  const session ='), s.indexOf('  const { article, versions }'));
const publicBranch = (s) => s.slice(s.lastIndexOf('      ) : ('));
assert.equal(failure(page), failure(basePage));
assert.equal(publicBranch(page), publicBranch(basePage));
const oldFiles = git('ls-tree', '-r', '--name-only', base, 'evidence')
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort();
const tree = createHash('sha256');
for (const path of oldFiles) {
  const bytes = readFileSync(resolve(root, path));
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  // One repository batch inventory; compare each immutable prior blob without opening services.
  tree.update(path + '\0' + sha(bytes) + '\n');
  assert.equal(blob.length, 40);
}
const inventory = new Map(
  git('ls-tree', '-r', base, 'evidence')
    .trim()
    .split('\n')
    .map((line) => {
      const [metadata, path] = line.split('\t');
      return [path, metadata.split(' ')[2]];
    }),
);
for (const path of oldFiles) {
  const bytes = readFileSync(resolve(root, path));
  assert.equal(
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    inventory.get(path),
  );
}
let ui;
try {
  const runtime = JSON.parse(readFileSync(resolve(root, leaf + 'ui-06/runtime.json'), 'utf8'));
  const checks = JSON.parse(readFileSync(resolve(root, leaf + 'ui-06/ui/report.json'), 'utf8'));
  const quality = JSON.parse(
    readFileSync(resolve(root, leaf + 'quality-native-ready.json'), 'utf8'),
  );
  assert.equal(runtime.success, true);
  assert.equal(checks.success, true);
  assert.equal(quality.success, true);
  for (const artifact of [runtime, quality, checks])
    assert.equal(artifact.workPackage, 'WP-P3-KNWEDIT-083');
  for (const artifact of [runtime, quality]) assert.equal(artifact.baselineRevision, base);
  const commands = [
    [
      'targeted',
      'rtk npx vitest run tests/unit/knowledge-edit-ui.test.ts tests/unit/knowledge-detail-recovery-ui.test.ts',
    ],
    ['unit', 'rtk npm run test:unit'],
    ['typecheck', 'rtk npm run typecheck'],
    ['lint', 'rtk npm run lint'],
    ['format', 'rtk npm run format:check'],
    ['planning', 'rtk npm run check:all'],
    ['diff', 'rtk git diff --check'],
  ];
  assert.deepEqual(
    quality.results.map((item) => [item.name, item.command]),
    commands,
  );
  assert.ok(quality.results.every((item) => item.exitCode === 0 && item.signal === null));
  const qualityPaths = [
    'apps/web/src/components/KnowledgeEditor.tsx',
    'apps/web/src/components/KnowledgeEditor.module.css',
    'apps/web/src/app/knowledge/[id]/page.tsx',
    'tests/unit/knowledge-edit-ui.test.ts',
    'tests/unit/knowledge-detail-recovery-ui.test.ts',
    'tools/check_knowledge_edit_ui.mjs',
    'tools/knowledge_edit_fixture.mjs',
    leaf + 'run-ui.mjs',
  ];
  assert.deepEqual(quality.hashes.map((item) => item.path).sort(), qualityPaths.sort());
  assert.ok(runtime.source.length > 100);
  for (const set of [runtime.source, quality.hashes]) {
    assert.equal(new Set(set.map((item) => item.path)).size, set.length);
    assert.ok(
      set.every(
        (item) =>
          typeof item.path === 'string' &&
          !isAbsolute(item.path) &&
          item.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
          /^[a-f0-9]{64}$/.test(item.sha256),
      ),
    );
  }
  for (const path of [
    pagePath,
    'apps/web/src/components/KnowledgeEditor.tsx',
    'apps/web/src/components/KnowledgeEditor.module.css',
    'apps/web/src/lib/api.ts',
    'tools/check_knowledge_edit_ui.mjs',
    'tools/knowledge_edit_fixture.mjs',
    leaf + 'run-ui.mjs',
  ])
    assert.ok(runtime.source.some((item) => item.path === path));
  assert.equal(checks.expectedChecks, 23);
  assert.equal(checks.checks.length, 23);
  assert.equal(new Set(checks.checks.map((item) => item.name)).size, 23);
  assert.ok(checks.checks.every((item) => item.passed === true));
  assert.equal(checks.accessibility.length, 25);
  assert.equal(checks.screenshots.length, 25);
  assert.ok(checks.accessibility.every((item) => item.violations.length === 0));
  assert.equal(new Set(checks.screenshots.map((item) => item.path)).size, 25);
  for (const image of checks.screenshots) {
    assert.match(image.path, /^[a-z0-9_-]+\.png$/);
    assert.equal(
      readFileSync(resolve(root, leaf + 'ui-06/ui/' + image.path))
        .subarray(0, 8)
        .toString('hex'),
      '89504e470d0a1a0a',
    );
  }
  for (const key of ['unknownReads', 'unexpectedWrites', 'foreignOrigin', 'downloads'])
    assert.equal(checks.browserRequests[key], 0);
  assert.equal(checks.browserRequests.allowedActions, 8);
  assert.equal(checks.prefetch.attempted, checks.prefetch.blocked);
  assert.equal(checks.prefetch.forwarded, 0);
  for (const observed of [checks.api, runtime.fixture]) {
    assert.equal(observed.unexpectedMutations, 0);
    assert.equal(observed.unknownReads, 0);
    assert.equal(observed.allowedWrites, 8);
    assert.equal(observed.writes.length, 8);
    assert.deepEqual(
      observed.writes.map((item) => [item.route, item.status]),
      [
        ['save', 400],
        ['save', 409],
        ['save', 503],
        ['save', 200],
        ['review', 503],
        ['review', 200],
        ['create', 201],
        ['save', 200],
      ],
    );
    assert.ok(
      observed.writes.every(
        (item) =>
          item.bodyValid === true && item.expectedVersionValid === true && item.completed === true,
      ),
    );
    assert.equal(observed.writes.filter((item) => item.releaseControlled === true).length, 2);
  }
  assert.equal(checks.browserClosed, true);
  for (const key of [
    'fixture',
    'temporarySourceRemoved',
    'childrenReaped',
    'listenersFree',
    'primaryNextMetadataUnchanged',
    'protectedListenersUnchanged',
    'success',
  ])
    assert.equal(runtime.cleanup[key], true);
  assert.deepEqual(runtime.cleanup.errors, []);
  assert.deepEqual(runtime.fixtureClose, {
    closed: true,
    pendingTimers: 0,
    databaseStarted: false,
  });
  for (const item of [...runtime.source, ...quality.hashes])
    assert.equal(sha(readFileSync(resolve(root, item.path))), item.sha256);
  ui = {
    accepted: true,
    checks: checks.checks.length,
    sourceFiles: runtime.source.length,
    qualitySources: quality.hashes.length,
    currentHashesMatch: true,
  };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  ui = { accepted: false, reason: 'NOT_YET_CAPTURED' };
}
const report = {
  workPackage: 'WP-P3-KNWEDIT-083',
  baselineRevision: base,
  changed,
  allowed: true,
  protection,
  existingFailureAndPublicBranchUnchanged: true,
  oldEvidence: { count: oldFiles.length, treeSha256: tree.digest('hex'), blobsMatchBaseline: true },
  ui,
  sourceScopeValid: true,
  formalDone: false,
};
if (output)
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(
  JSON.stringify(
    verifyOnly ? report : { scope: true, oldEvidence: oldFiles.length, ui: ui.accepted },
  ) + '\n',
);
