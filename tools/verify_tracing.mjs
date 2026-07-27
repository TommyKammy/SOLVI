#!/usr/bin/env node
/**
 * トレースが実スタックで機能することの検証(WP-P1-OBS-005 / TL-12)。
 *
 * 単体テストはインメモリのエクスポータで伝播を確認する。
 * ここは「実際にJaegerへ届き、サービス名が付いて検索できるか」を見る。
 * 計装は設定を1つ間違えるだけで無言で無効になるため、経路の疎通を確認する。
 */
const JAEGER = process.env.JAEGER_QUERY_URL ?? 'http://localhost:16686';
const API = `http://localhost:${process.env.API_PORT ?? 3001}`;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK  ' : '  NG  '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[1] リクエストを発生させる');
const correlationId = `trace-verify-${Date.now()}`;
try {
  // 404を意図的に起こす。エラー経路も計装されていることを確認する。
  const res = await fetch(`${API}/no-such-endpoint`, {
    headers: { 'x-correlation-id': correlationId },
  });
  record('APIへのリクエスト', res.status === 404, `status=${res.status}`);
} catch (error) {
  record('APIへのリクエスト', false, error.message);
}

console.log('\n[2] Jaegerへ到達するまで待つ');
// BatchSpanProcessor の既定スケジュール(5秒)より長く待つ。
// 短いと「計装は動いているのにトレースが無い」と誤判定する。
await sleep(8000);

console.log('\n[3] サービスがJaegerに登録されている');
try {
  const res = await fetch(`${JAEGER}/api/services`);
  const body = await res.json();
  const services = body.data ?? [];
  for (const expected of ['solvi-api']) {
    record(
      `${expected} が登録されている`,
      services.includes(expected),
      `services=${services.join(', ')}`,
    );
  }
} catch (error) {
  record('Jaegerのサービス一覧', false, error.message);
}

console.log('\n[4] トレースが記録されている');
try {
  const res = await fetch(`${JAEGER}/api/traces?service=solvi-api&limit=20`);
  const body = await res.json();
  const traces = body.data ?? [];
  record('solvi-api のトレースが存在する', traces.length > 0, `${traces.length} 件`);

  if (traces.length > 0) {
    const spans = traces.flatMap((t) => t.spans);
    record('スパンに service.name が付いている', spans.length > 0, `${spans.length} spans`);

    // ヘルスチェックが除外されていること(ノイズでトレースが埋まらない)
    const healthSpans = spans.filter((s) =>
      (s.tags ?? []).some(
        (tag) => tag.key === 'http.target' && String(tag.value).includes('healthz'),
      ),
    );
    record(
      'ヘルスチェックがトレースに含まれない',
      healthSpans.length === 0,
      `${healthSpans.length} 件`,
    );
  }
} catch (error) {
  record('トレースの取得', false, error.message);
}

console.log('\n[5] ログに trace id が載っている');
try {
  const { execFileSync } = await import('node:child_process');
  const logs = execFileSync(
    'docker',
    ['compose', 'logs', '--no-log-prefix', '--tail', '200', 'api'],
    {
      encoding: 'utf8',
    },
  );
  const withTrace = logs
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.traceId);
  record('trace id を含むログ行がある', withTrace.length > 0, `${withTrace.length} 行`);

  // 秘密が漏れていないことの実地確認
  const leaked = logs.match(/postgres:\/\/[^:]+:[^@]+@|eyJ[A-Za-z0-9_-]{10,}\./);
  record(
    'ログに接続文字列やJWTが出ていない',
    leaked === null,
    leaked ? leaked[0].slice(0, 30) : '',
  );
} catch (error) {
  record('ログの検査', false, error.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件が期待どおり`);
if (failed.length > 0) {
  console.error('\n失敗:');
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail ?? ''}`);
  process.exit(1);
}
