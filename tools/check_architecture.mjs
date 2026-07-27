#!/usr/bin/env node
/**
 * 禁止依存の検査(ADR-0001 / ADR-0006 / ADR-0007 / NFR-MNT-001)。
 *
 * モジュール境界は放っておくと数か月で腐る。特に危険なのは次の2つで、
 * どちらも「動くコード」として自然に書けてしまうため、レビューだけでは防げない。
 *   - Core API が外部管理APIを直接呼ぶ(Executor分離の迂回)
 *   - AI サービスから Executor や DB へ到達する(advisory-only の破壊)
 *
 * 使い方: node tools/check_architecture.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', 'docs', 'evidence']);

/**
 * ルール定義。
 * from: 対象ディレクトリ / deny: 禁止する import 指定のパターン / why: 根拠
 */
const RULES = [
  {
    from: 'services/api',
    deny: [/@solvi\/connectors/, /['"](okta|@okta\/|@microsoft\/microsoft-graph|@azure\/msal)/],
    why: 'Core API は外部管理APIを直接呼ばない。特権操作は services/executor 経由(ADR-0006)',
  },
  {
    from: 'services/worker',
    deny: [/@solvi\/connectors/, /['"](okta|@okta\/|@microsoft\/microsoft-graph)/],
    why: 'Worker は Command を発行するだけ。外部APIの呼び出しは Executor の責務(ADR-0006)',
  },
  {
    from: 'apps/web',
    deny: [/['"]pg['"]/, /@solvi\/connectors/, /services\/(api|executor|worker)\/src/],
    why: 'UI から DB や他サービスの内部実装へ直接依存しない(ADR-0001)',
  },
  {
    from: 'services/executor',
    deny: [/services\/api\/src/, /apps\/web/],
    why: 'Executor は Core の内部実装に依存しない。契約(packages/shared)経由にする',
  },
  {
    from: 'packages/shared',
    deny: [/@solvi\/(api|worker|executor|connectors|web)/, /['"]pg['"]/],
    why: '共有パッケージが個別サービスへ依存すると循環し、境界の意味がなくなる',
  },
];

function walk(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx|mts|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

/** import / require / dynamic import の行だけを抜き出す(コメント内の言及を拾わない) */
function importLines(source) {
  return source
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(
      ({ line }) =>
        /^import\s/.test(line) ||
        /^export\s+.*\sfrom\s/.test(line) ||
        /\brequire\(/.test(line) ||
        /\bimport\(/.test(line),
    );
}

const violations = [];
let filesChecked = 0;

for (const rule of RULES) {
  for (const file of walk(join(repoRoot, rule.from))) {
    filesChecked++;
    const source = readFileSync(file, 'utf8');
    for (const { line, no } of importLines(source)) {
      for (const pattern of rule.deny) {
        if (pattern.test(line)) {
          violations.push({
            file: relative(repoRoot, file),
            no,
            line,
            why: rule.why,
          });
        }
      }
    }
  }
}

console.log(`アーキテクチャ検査: ${filesChecked} ファイル / ${RULES.length} ルール`);

if (violations.length > 0) {
  console.error(`\n禁止依存: ${violations.length}件\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.no}`);
    console.error(`    ${v.line}`);
    console.error(`    → ${v.why}\n`);
  }
  console.error('境界を変更する場合は後継ADRを起票してください(AGENTS.md §1.9)。');
  process.exit(1);
}

console.log('OK: 禁止依存はありません。');
