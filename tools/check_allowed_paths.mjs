#!/usr/bin/env node
/**
 * WPの「Allowed Paths」がリポジトリの実在構造を指しているか検査する。
 * WP-P0-DEV-005 Acceptance: 全WPの §4 がリポジトリ構造と一致すること。
 *
 * 判定規則:
 *  - 計画Vault相対のパス(`03_Requirements/...` `assets/...`)は docs/planning/ 配下として解決する。
 *  - ファイル指定はそのファイルが実在すること。
 *  - ディレクトリ指定は、WPが新規作成する下層は未存在でよいが、
 *    上位2セグメント(例 `services/worker`)が実在していること。
 *  - `*` を含むパスはグロブとして展開し、1件以上一致すること。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wpRoot = join(repoRoot, 'docs/planning/06_WorkPackages');

/** リポジトリ実体を指さない表記 */
const NOT_A_REPO_PATH = [/^\(/, /^evidence\//];
/** 計画Vault相対と判断するパターン */
const PLANNING_RELATIVE = /^(\d{2}_[A-Za-z_]+\/|assets\/|MANIFEST\.md$|AGENTS\.md$)/;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function extractAllowedPaths(text) {
  const section = text.split(/^## 4\. Scope \/ Allowed Paths$/m)[1];
  if (!section) return [];
  return [...section.split(/^## /m)[0].matchAll(/^-\s+`([^`]+)`/gm)].map((m) => m[1]);
}

function resolveGlob(pattern) {
  const [head, ...rest] = pattern.split('*');
  const baseDir = join(repoRoot, head);
  if (!existsSync(baseDir)) return [];
  const tail = rest.join('*').replace(/^\//, '');
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(baseDir, e.name, tail))
    .filter((p) => existsSync(p) || existsSync(dirname(p)));
}

/** @returns {string|null} 問題があれば理由、なければ null */
function validate(rawPath) {
  if (NOT_A_REPO_PATH.some((re) => re.test(rawPath))) return null;

  const path = PLANNING_RELATIVE.test(rawPath) ? `docs/planning/${rawPath}` : rawPath;

  if (path.includes('*')) {
    return resolveGlob(path).length > 0 ? null : 'グロブに一致するディレクトリがありません';
  }

  const abs = join(repoRoot, path.replace(/\/$/, ''));
  if (existsSync(abs)) return null;

  // 未作成の成果物でもよいが、置き場所が実在の構造に根ざしていることを求める。
  // ファイル: 親ディレクトリが実在すること。ディレクトリ: 上位2セグメントが実在すること。
  const segments = path.replace(/\/$/, '').split('/');
  if (segments.length === 1) return null; // リポジトリ直下に作られる成果物
  const isFile = extname(path) !== '' && !path.endsWith('/');
  const anchor = isFile
    ? dirname(abs)
    : join(repoRoot, ...segments.slice(0, Math.min(segments.length - 1, 2)));
  if (existsSync(anchor) && statSync(anchor).isDirectory()) return null;
  return `置き場所 ${anchor.replace(repoRoot + '/', '')} が存在しません`;
}

const problems = [];
let wps = 0;
let paths = 0;

for (const file of walk(wpRoot).filter((f) => /WP-P\d-[A-Z]+-\d{3}\.md$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  if (!/^status: "(baseline|accepted)"/m.test(text)) continue; // draft は対象外
  wps++;
  const wpId = file.split('/').pop().replace('.md', '');
  for (const p of extractAllowedPaths(text)) {
    paths++;
    const reason = validate(p);
    if (reason) problems.push(`${wpId}: ${p} — ${reason}`);
  }
}

console.log(`checked ${wps} baseline work packages, ${paths} allowed paths`);
if (problems.length > 0) {
  console.error(`\nリポジトリ構造と一致しないAllowed Path: ${problems.length}件`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('OK: すべてのAllowed Pathがリポジトリ構造と一致しています。');
