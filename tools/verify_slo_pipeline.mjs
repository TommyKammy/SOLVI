#!/usr/bin/env node
/**
 * SLO配線の検証 (WP-P2-SLO-008)
 *
 * **定義しただけで動いていない状態を検出する**ことが目的である。
 *
 * WP-P1-OBS-005 は計器(Counter / Histogram)を定義したが MeterProvider を
 * 繋いでいなかった。`metrics.getMeter()` が NoopMeterProvider を返すため、
 * `recordHttpRequest()` などの呼び出しはすべて黙って捨てられていた。
 * 例外も警告も出ず、単体テストは自前のインメモリリーダーを使うので全て緑だった。
 * トレースでも同じ形の欠陥が起き、`verify_tracing.mjs` で初めて見つかった。
 *
 * 「単体テストが通る」と「本番の経路で実際に出ている」は別の主張である。
 * この検査は後者だけを確かめる。稼働中のスタックに対して実行すること。
 */

const PROM = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const API_METRICS = process.env.API_METRICS_URL ?? 'http://127.0.0.1:9464/metrics';
const API_BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

let failures = 0;

function check(ok, label, detail = '') {
  const mark = ok ? 'OK  ' : 'NG  ';
  process.stdout.write(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
}

async function promQuery(expr) {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`);
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`);
  const body = await res.json();
  return body.data?.result ?? [];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdout.write('SLO配線の検証\n\n');

// ---------------------------------------------------------------------------
// 1. メトリクスがプロセスから実際に出ているか
//
// ここが本題。MeterProvider が未設定なら solvi_* は1行も現れない。
// ---------------------------------------------------------------------------
process.stdout.write('1. アプリからのメトリクス公開\n');

// 既知のルートへ1回叩いてから読む。無トラフィックだと系列が生まれず、
// 「配線が切れている」と「まだ誰も使っていない」を区別できない。
await fetch(`${API_BASE}/tickets`, {
  headers: { 'x-correlation-id': 'verify-slo-pipeline' },
}).catch(() => undefined);
await wait(1500);

let metricsText = '';
try {
  metricsText = await (await fetch(API_METRICS)).text();
  check(true, 'api の /metrics に到達できる');
} catch (error) {
  check(false, 'api の /metrics に到達できる', error.message);
}

const families = new Set(
  metricsText
    .split('\n')
    .filter((l) => l.startsWith('# TYPE'))
    .map((l) => l.split(' ')[2]),
);

check(
  families.has('solvi_http_requests_total'),
  'solvi_http_requests_total が公開されている',
  families.size === 0 ? 'メトリクスが1件も出ていない (METRICS_PORT 未設定を疑う)' : '',
);
check(families.has('solvi_http_duration'), 'solvi_http_duration が公開されている');

// ヘルスチェックが SLI の分母を汚していないこと。
// 混ざると可用性が水増しされ、p95 が薄まる。
const healthSeries = metricsText
  .split('\n')
  .filter((l) => l.startsWith('solvi_http_') && /http_route="\/(healthz|readyz|metrics)"/.test(l));
check(
  healthSeries.length === 0,
  'ヘルスチェックが SLI の系列に混ざっていない',
  healthSeries.length > 0 ? `${healthSeries.length} 系列が混入` : '',
);

// ---------------------------------------------------------------------------
// 2. Prometheus が実際にスクレイプできているか
//
// メトリクスが出ていても、到達できなければ SLO は判定できない。
// ---------------------------------------------------------------------------
process.stdout.write('\n2. Prometheus のスクレイプ\n');

let targets = [];
try {
  const res = await fetch(`${PROM}/api/v1/targets`);
  targets = (await res.json()).data?.activeTargets ?? [];
  check(true, 'Prometheus に到達できる');
} catch (error) {
  check(false, 'Prometheus に到達できる', error.message);
}

const solviTargets = targets.filter((t) => String(t.labels.job).startsWith('solvi-'));
check(
  solviTargets.length > 0,
  'solvi-* のスクレイプ対象が設定されている',
  `${solviTargets.length} 件`,
);

for (const t of solviTargets) {
  check(t.health === 'up', `${t.labels.job} をスクレイプできている`, t.lastError || '');
}

// ---------------------------------------------------------------------------
// 3. アラートルールが読み込まれ、評価されているか
//
// 構文エラーがあると Prometheus はそのファイルを丸ごと無視する。
// 「アラートを書いた」だけでは鳴る保証にならない。
// ---------------------------------------------------------------------------
process.stdout.write('\n3. アラートルール\n');

let groups = [];
try {
  const res = await fetch(`${PROM}/api/v1/rules`);
  groups = (await res.json()).data?.groups ?? [];
} catch (error) {
  check(false, 'ルール一覧を取得できる', error.message);
}

const rules = groups.flatMap((g) => g.rules ?? []);
const ruleNames = new Set(rules.map((r) => r.name));

const EXPECTED_ALERTS = [
  'SolviErrorBudgetBurnFast',
  'SolviErrorBudgetBurnSlow',
  'SolviLatencyP95Degraded',
  'SolviOutboxLagHigh',
  'SolviAuthzDenialSpike',
  'SolviTargetDown',
  'SolviNoTraffic',
  'SolviSyntheticCheckFailing',
  'SolviAttachmentScanStalled',
];

for (const name of EXPECTED_ALERTS) {
  check(ruleNames.has(name), `${name} が読み込まれている`);
}

const broken = rules.filter((r) => r.health && r.health !== 'ok');
check(
  broken.length === 0,
  'すべてのルールが正常に評価されている',
  broken.map((r) => `${r.name}: ${r.lastError}`).join(' / '),
);

// 各アラートに runbook の参照があること。
// 参照の無いアラートは、鳴った人が何をすべきか分からず放置される。
const missingRunbook = rules
  .filter((r) => r.type === 'alerting')
  .filter((r) => !r.annotations?.runbook);
check(
  missingRunbook.length === 0,
  'すべてのアラートに runbook の参照がある',
  missingRunbook.map((r) => r.name).join(', '),
);

// ---------------------------------------------------------------------------
// 4. 合成監視
// ---------------------------------------------------------------------------
process.stdout.write('\n4. 合成監視\n');

const synthetic = await promQuery('solvi_synthetic_success');
check(
  synthetic.length > 0,
  '合成監視の結果が Prometheus に入っている',
  `${synthetic.length} チェック`,
);

const skipped = await promQuery('solvi_synthetic_skipped');
if (skipped.length > 0) {
  process.stdout.write(
    `  注記 未実行のチェックがある: ${skipped.map((s) => s.metric.check).join(', ')}\n` +
      '       (成功として扱っていない。WP-P1-IDM-003 完了後に有効化すること)\n',
  );
}

// ---------------------------------------------------------------------------
process.stdout.write('\n');
if (failures > 0) {
  process.stdout.write(`${failures} 件の問題があります\n`);
  process.exit(1);
}
process.stdout.write('OK: SLOの配線は期待どおりです\n');
