#!/usr/bin/env node
/**
 * ローカルスタックに対する境界検証。
 *
 * ここで検査するのは機能ではなく **境界** である。
 *  - Executor がホストへ公開されていないこと(ADR-0006)
 *  - AI サービスから Executor / DB / Core API へ到達できないこと(AGENTS.md §1.3、脅威 T-13)
 *  - 相関IDが応答へ返ること(NFR-OPS-003)
 *  - 依存先が落ちているとき readyz が 503 を返すこと(fail closed)
 *
 * 使い方: node tools/verify_boundaries.mjs
 */
import { execFileSync } from 'node:child_process';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK  ' : '  NG  '} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.text();
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

console.log('\n[1] サービスの健全性');
for (const [name, port] of [
  ['api', 3001],
  ['worker', 3002],
  ['ai-advisor', 3004],
]) {
  try {
    const res = await fetchJson(`http://localhost:${port}/healthz`);
    record(`${name} healthz`, res.status === 200, `status=${res.status}`);
  } catch (error) {
    record(`${name} healthz`, false, error.message);
  }
}

console.log('\n[2] readyz が依存先を見ていること');
for (const [name, port] of [
  ['api', 3001],
  ['worker', 3002],
]) {
  try {
    const res = await fetchJson(`http://localhost:${port}/readyz`);
    const parsed = JSON.parse(res.body);
    const hasPostgres = parsed.dependencies?.some((d) => d.name === 'postgres' && d.status === 'up');
    record(`${name} readyz が postgres を確認`, res.status === 200 && hasPostgres);
  } catch (error) {
    record(`${name} readyz`, false, error.message);
  }
}

console.log('\n[3] Executor がホストへ公開されていないこと(ADR-0006)');
try {
  await fetchJson('http://localhost:3003/healthz');
  record('executor はホストから到達不可', false, 'ホストから到達できてしまいます');
} catch {
  record('executor はホストから到達不可', true, 'compose では expose のみ');
}

console.log('\n[4] AI サービスの到達範囲(AGENTS.md §1.3 / 脅威 T-13)');
const probe = `
import socket, json
out = {}
for host, port in [('executor', 3003), ('postgres', 5432), ('api', 3001)]:
    s = socket.socket(); s.settimeout(2)
    try:
        s.connect((host, port)); out[host] = 'reachable'
    except Exception as e:
        out[host] = type(e).__name__
    finally:
        s.close()
print(json.dumps(out))
`;
try {
  const raw = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'ai-advisor', 'python', '-c', probe],
    { encoding: 'utf8' },
  );
  const reach = JSON.parse(raw.trim().split('\n').pop());
  for (const host of ['executor', 'postgres', 'api']) {
    record(`ai-advisor → ${host} 到達不可`, reach[host] !== 'reachable', reach[host]);
  }
} catch (error) {
  record('ai-advisor のネットワーク検査', false, error.message);
}

console.log('\n[5] 相関ID(NFR-OPS-003)');
try {
  const res = await fetchJson('http://localhost:3001/healthz', {
    headers: { 'x-correlation-id': 'verify-boundaries-0001' },
  });
  record(
    '受信した相関IDが応答に返る',
    res.headers.get('x-correlation-id') === 'verify-boundaries-0001',
    res.headers.get('x-correlation-id') ?? 'なし',
  );
  const res2 = await fetchJson('http://localhost:3001/healthz', {
    headers: { 'x-correlation-id': '../../etc/passwd' },
  });
  const issued = res2.headers.get('x-correlation-id');
  record(
    '不正な形式の相関IDは採番し直す',
    issued !== '../../etc/passwd' && /^[A-Za-z0-9-]{8,64}$/.test(issued ?? ''),
    issued ?? 'なし',
  );
} catch (error) {
  record('相関ID', false, error.message);
}

console.log('\n[6] エラー表現が RFC 9457 であること(ADR-0017)');
try {
  const res = await fetchJson('http://localhost:3001/no-such-endpoint');
  const problem = JSON.parse(res.body);
  record(
    '未知のエンドポイントが problem+json を返す',
    res.status === 404 &&
      res.headers.get('content-type')?.includes('application/problem+json') &&
      typeof problem.type === 'string' &&
      typeof problem.title === 'string',
    `status=${res.status} type=${problem.type}`,
  );
  record('problem に相関IDが含まれる', typeof problem.correlationId === 'string');
} catch (error) {
  record('エラー表現', false, error.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件が期待どおり`);
if (failed.length > 0) {
  console.error('\n失敗:');
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail ?? ''}`);
  process.exit(1);
}
