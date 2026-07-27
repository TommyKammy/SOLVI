#!/usr/bin/env node
/**
 * コンテナイメージが digest 固定されているかを検査する(NFR-SEC-008 / AGENTS.md §1.14 / 脅威 T-21)。
 *
 * tag だけの参照は、同じ tag が別の中身に差し替わっても気付けない。
 * 供給網の汚染はビルドの再現性が失われた瞬間に検知不能になるため、CIで機械的に止める。
 *
 * 対象: Dockerfile* の FROM 行、docker-compose*.yml の image 行、GitHub Actions の container 指定。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'docs']);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const DIGEST = /@sha256:[0-9a-f]{64}/;
const problems = [];
let checked = 0;

for (const file of walk(repoRoot)) {
  const name = basename(file);
  const isDockerfile = /^Dockerfile(\.|$)/.test(name);
  const isCompose = /^docker-compose.*\.ya?ml$/.test(name);
  const isWorkflow = file.includes('.github/workflows') && /\.ya?ml$/.test(name);
  if (!isDockerfile && !isCompose && !isWorkflow) continue;
  if (statSync(file).isDirectory()) continue;

  const rel = file.replace(`${repoRoot}/`, '');
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return;

    if (isDockerfile && /^FROM\s+/i.test(trimmed)) {
      // 多段ビルドの内部ステージ参照(FROM base AS deps)は digest 不要
      const ref = trimmed.split(/\s+/)[1];
      const isLocalStage = !ref.includes('/') && !ref.includes(':') && !ref.includes('@');
      if (isLocalStage) return;
      checked++;
      if (!DIGEST.test(ref)) problems.push(`${rel}:${i + 1} FROM ${ref}`);
      return;
    }

    if ((isCompose || isWorkflow) && /^image:\s*\S/.test(trimmed)) {
      const ref = trimmed.replace(/^image:\s*/, '').replace(/['"]/g, '');
      // ビルドで生成する自前イメージ(build: 指定と併記)は対象外にできないため、
      // レジストリ参照の形をしているものだけを対象にする。
      if (ref.startsWith('${')) return;
      checked++;
      if (!DIGEST.test(ref)) problems.push(`${rel}:${i + 1} image: ${ref}`);
    }
  });
}

console.log(`checked ${checked} image references`);
if (problems.length > 0) {
  console.error(`\ndigest 固定されていないイメージ参照: ${problems.length}件`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\n`docker image inspect <ref> --format "{{index .RepoDigests 0}}"` で digest を取得し、',
  );
  console.error('`image:tag@sha256:...` の形式で固定してください。');
  process.exit(1);
}
console.log('OK: すべてのイメージ参照が digest 固定されています。');
