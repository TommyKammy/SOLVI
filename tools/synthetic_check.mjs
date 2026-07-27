#!/usr/bin/env node
/**
 * 合成監視 (WP-P2-SLO-008 / NFR-OPS-001)
 *
 * なぜ内部メトリクスだけでは足りないか。
 *
 * 内部メトリクスは「アプリが受け取ったリクエスト」しか数えない。
 * LB・DNS・リバースプロキシ・認証基盤が落ちていると、リクエストは
 * アプリに届かないので、エラー率は 0% のまま、レイテンシも正常のままになる。
 * **数字は全部健全なのに、誰も使えていない**という状態が成立する。
 *
 * 合成監視は外側から実際に叩く。届かなければ届かないと言う。
 *
 * 2つのモードがある。
 *   --once   1回だけ実行し、失敗があれば非0で終了する(手動確認・CI用)
 *   (既定)  一定間隔で実行し続け、Prometheus形式で結果を公開する
 */

import http from 'node:http';

const API_BASE = process.env.SYNTHETIC_API_BASE ?? 'http://api:3001';
/**
 * 合成監視用のアカウント。
 *
 * **専用のアカウントを使う。** 実在の利用者の資格情報を使い回すと、
 * その人が退職・無効化された瞬間に監視が落ちる。しかも原因が
 * 「監視の設定」であることに気付くまで時間がかかる。
 */
const SYNTHETIC_EMAIL = process.env.SYNTHETIC_EMAIL;
const SYNTHETIC_PASSWORD = process.env.SYNTHETIC_PASSWORD;
const SYNTHETIC_ORG = process.env.SYNTHETIC_ORG;
const WEB_BASE = process.env.SYNTHETIC_WEB_BASE ?? 'http://web:3000';
const PORT = Number(process.env.SYNTHETIC_PORT ?? 9465);
const INTERVAL_MS = Number(process.env.SYNTHETIC_INTERVAL_MS ?? 60_000);
/** 1回のチェックの上限。これを超えたら失敗として扱う。 */
const TIMEOUT_MS = Number(process.env.SYNTHETIC_TIMEOUT_MS ?? 10_000);

/**
 * @typedef {{ name: string, run: () => Promise<void> }} Check
 * @typedef {{ name: string, ok: boolean, durationMs: number, error?: string }} Result
 */

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** @type {Check[]} */
const CHECKS = [
  {
    // 依頼者が最初に触れる画面。ここが落ちていれば業務は始まらない。
    name: 'portal_top',
    run: async () => {
      const res = await fetchWithTimeout(WEB_BASE + '/');
      if (!res.ok) throw new Error(`status ${res.status}`);
    },
  },
  {
    // APIの依存(DB・オブジェクトストレージ)を含めた到達性。
    // /healthz ではなく /readyz を見る。プロセスが生きているかではなく、
    // **仕事ができる状態か**を確かめたい。
    name: 'api_ready',
    run: async () => {
      const res = await fetchWithTimeout(API_BASE + '/readyz');
      if (!res.ok) throw new Error(`status ${res.status}`);
    },
  },
];

/**
 * 未実装のため実行できないチェック。
 *
 * **成功として扱わない。** 「導線が確認できていない」ことを
 * 明示的に記録し、監視できているつもりになるのを防ぐ。
 */
/**
 * 資格情報が設定されていない場合に実行できないチェック。
 *
 * **成功として扱わない。** 「導線が確認できていない」ことを明示的に記録し、
 * 監視できているつもりになるのを防ぐ。
 */
const SKIPPED = credentialsConfigured()
  ? []
  : [
      {
        name: 'login',
        reason: 'SYNTHETIC_EMAIL / SYNTHETIC_PASSWORD / SYNTHETIC_ORG が未設定',
      },
      {
        name: 'ticket_create',
        reason: 'ログインできないため実行できない(同上)',
      },
    ];

function credentialsConfigured() {
  return Boolean(SYNTHETIC_EMAIL && SYNTHETIC_PASSWORD && SYNTHETIC_ORG);
}

if (credentialsConfigured()) {
  CHECKS.push(
    {
      // 認証が通らなければ、他が健全でも誰も業務を進められない。
      name: 'login',
      run: async () => {
        const res = await fetchWithTimeout(API_BASE + '/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: SYNTHETIC_EMAIL,
            password: SYNTHETIC_PASSWORD,
            organizationId: SYNTHETIC_ORG,
          }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        if (!res.headers.get('set-cookie')) throw new Error('セッションCookieが発行されない');
      },
    },
    {
      // SOLVIの存在理由そのもの。ここが通らなければ何も受け付けられていない。
      name: 'ticket_create',
      run: async () => {
        const login = await fetchWithTimeout(API_BASE + '/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: SYNTHETIC_EMAIL,
            password: SYNTHETIC_PASSWORD,
            organizationId: SYNTHETIC_ORG,
          }),
        });
        if (!login.ok) throw new Error(`login status ${login.status}`);
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

        const created = await fetchWithTimeout(API_BASE + '/tickets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            kind: 'request',
            // **合成監視であることが一目で分かる件名にする。**
            // 実際の問い合わせと混ざると、担当者が対応してしまう。
            subject: '[合成監視] 定期疎通確認 — 対応不要',
            body: '合成監視が自動生成した確認用のチケットです。対応は不要です。',
            impact: 'low',
            urgency: 'low',
          }),
        });
        if (created.status !== 201) throw new Error(`status ${created.status}`);

        // 後片付けとしてログアウトし、セッションを溜めない。
        await fetchWithTimeout(API_BASE + '/auth/logout', {
          method: 'POST',
          headers: { cookie },
        }).catch(() => undefined);
      },
    },
  );
}

/** @returns {Promise<Result[]>} */
async function runAll() {
  return Promise.all(
    CHECKS.map(async (check) => {
      const started = Date.now();
      try {
        await check.run();
        return { name: check.name, ok: true, durationMs: Date.now() - started };
      } catch (error) {
        return {
          name: check.name,
          ok: false,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/**
 * Prometheus テキスト形式。
 *
 * ラベルには check 名しか入れない。エラー内容をラベルにすると、
 * エラーメッセージの種類だけ時系列が増えて監視基盤を壊す。
 * 内容はログで見る。
 */
function renderMetrics(results, lastRunAt) {
  const lines = [
    '# HELP solvi_synthetic_success 合成監視の成否 (1=成功, 0=失敗)',
    '# TYPE solvi_synthetic_success gauge',
    ...results.map((r) => `solvi_synthetic_success{check="${r.name}"} ${r.ok ? 1 : 0}`),
    '# HELP solvi_synthetic_duration_seconds 合成監視の所要時間',
    '# TYPE solvi_synthetic_duration_seconds gauge',
    ...results.map(
      (r) => `solvi_synthetic_duration_seconds{check="${r.name}"} ${r.durationMs / 1000}`,
    ),
    '# HELP solvi_synthetic_skipped 未実装により実行できないチェック',
    '# TYPE solvi_synthetic_skipped gauge',
    ...SKIPPED.map((s) => `solvi_synthetic_skipped{check="${s.name}"} 1`),
    '# HELP solvi_synthetic_last_run_timestamp_seconds 最後に実行した時刻',
    '# TYPE solvi_synthetic_last_run_timestamp_seconds gauge',
    `solvi_synthetic_last_run_timestamp_seconds ${Math.floor(lastRunAt / 1000)}`,
  ];
  return lines.join('\n') + '\n';
}

function logResult(results) {
  for (const r of results) {
    const payload = {
      level: r.ok ? 'info' : 'error',
      message: 'synthetic check',
      check: r.name,
      ok: r.ok,
      durationMs: r.durationMs,
      ...(r.error ? { errorMessage: r.error } : {}),
      timestamp: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  }
}

const once = process.argv.includes('--once');

if (once) {
  const results = await runAll();
  logResult(results);
  for (const s of SKIPPED) {
    process.stdout.write(
      JSON.stringify({
        level: 'warn',
        message: 'synthetic check skipped',
        check: s.name,
        reason: s.reason,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.stderr.write(`失敗: ${failed.map((f) => f.name).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`OK: ${results.length} 件の合成監視が成功しました\n`);
  process.stdout.write(`未実行: ${SKIPPED.map((s) => s.name).join(', ')}\n`);
  process.exit(0);
}

let latest = await runAll();
let lastRunAt = Date.now();
logResult(latest);

setInterval(async () => {
  latest = await runAll();
  lastRunAt = Date.now();
  logResult(latest);
}, INTERVAL_MS);

http
  .createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics(latest, lastRunAt));
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(PORT, () => {
    process.stdout.write(
      JSON.stringify({
        level: 'info',
        message: 'synthetic monitor started',
        port: PORT,
        intervalMs: INTERVAL_MS,
        checks: CHECKS.map((c) => c.name),
        skipped: SKIPPED.map((s) => s.name),
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  });
