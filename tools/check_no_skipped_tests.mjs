#!/usr/bin/env node
/**
 * skip されたテストの検出(AGENTS.md §4)。
 *
 * 失敗するテストを skip して品質ゲートを通す行為は、テストがない状態より悪い。
 * 「通っている」という誤った安心を与えるためである。
 *
 * 意図的な skip を認めないわけではない。ただし **理由と再有効化の期限** を
 * コード内に書くことを必須にする。期限を過ぎた skip は失敗させる。
 *
 * 記法:
 *   // SKIP-UNTIL: 2026-09-30 Okta テストテナントの払い出し待ち(WP-P1-IDM-003)
 *   it.skip('...', ...)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  'docs',
  'evidence',
]);

const SKIP_PATTERNS = [
  /\b(it|test|describe)\.skip\s*\(/,
  /\b(it|test|describe)\.todo\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /@pytest\.mark\.skip/,
];
const ANNOTATION = /SKIP-UNTIL:\s*(\d{4}-\d{2}-\d{2})\s+(.+)/;

function walk(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(test|spec)\.(ts|tsx|js|mjs)$|_test\.py$|test_.*\.py$/.test(entry.name) ? [full] : [];
  });
}

const today = new Date().toISOString().slice(0, 10);
const problems = [];
const accepted = [];
let files = 0;

for (const file of walk(repoRoot)) {
  files++;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!SKIP_PATTERNS.some((p) => p.test(line))) return;

    // 直前5行以内に注釈があるか
    const context = lines.slice(Math.max(0, i - 5), i).join('\n');
    const match = ANNOTATION.exec(context);
    const location = `${relative(repoRoot, file)}:${i + 1}`;

    if (!match) {
      problems.push(`${location} — SKIP-UNTIL 注釈がありません(理由と再有効化期限が必要)`);
      return;
    }
    const [, deadline, reason] = match;
    if (deadline < today) {
      problems.push(`${location} — 期限切れの skip(${deadline}): ${reason}`);
    } else {
      accepted.push(`${location} — ${deadline} まで: ${reason}`);
    }
  });
}

console.log(`skip検査: ${files} テストファイル`);
for (const a of accepted) console.log(`  容認: ${a}`);

if (problems.length > 0) {
  console.error(`\n許可されない skip: ${problems.length}件\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nテストを skip する場合は、直前に理由と再有効化期限を書いてください:\n' +
      '  // SKIP-UNTIL: YYYY-MM-DD <理由と担当WP>',
  );
  process.exit(1);
}
console.log('OK: 未注釈・期限切れの skip はありません。');
