#!/usr/bin/env node
/**
 * 画面応答の実測 (NFR-PERF-001 / WP-P2-PERF-020)
 *
 * 要求は「主要5画面 **p95 ≤1.5秒 @同時50ユーザ**」。
 * **一度も測っていなかった。** 台帳には Should として並んでいたが、
 * 数値の根拠がどこにも無い。
 *
 * 使い方:
 *   node tools/measure_screen_latency.mjs [--users 50] [--rounds 4]
 *
 * ## この数値が何を意味しないか
 *
 * **本番の値ではない。** 測る先は開発機の Colima 上のコンテナであり、
 * Next.js は開発モードで動いている(要求ごとに再コンパイルしうる)。
 *
 * したがって画面の値は**上限の目安**にすぎない。
 * 一方 API は素の Node で動くため、こちらの値は素性が近い。
 * **両方を出して、どちらが遅いのかを分けて見る。**
 */
const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
const ORG = '00000000-0000-4000-9000-000000000001';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const USERS = arg('users', 50);
const ROUNDS = arg('rounds', 4);
const THRESHOLD_MS = 1500;

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'local-dev-password-1', organizationId: ORG }),
  });
  if (!r.ok) throw new Error(`ログイン失敗 ${email}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

/** p95 は「95%の要求がこれ以下」。**平均は出さない** — 遅い側が見えない。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main() {
  const agent = await login('agent@acme.example.test');
  const requester = await login('requester@acme.example.test');

  // 詳細画面に使うチケットは**依頼者自身のもの**を取る。
  // 担当者の一覧から拾うと他人の問い合わせになり、404 を測ることになる。
  const own = await (
    await fetch(`${API}/tickets?limit=1`, { headers: { cookie: requester } })
  ).json();
  let ticketId = own.items?.[0]?.id;
  if (!ticketId) {
    // 無ければ作る。**測る対象が無いことを理由に測らないのは本末転倒である。**
    const created = await fetch(`${API}/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: requester },
      body: JSON.stringify({
        kind: 'request',
        subject: '応答測定のための問い合わせ',
        body: '測定のために作成した合成データです。',
        impact: 'medium',
        urgency: 'medium',
      }),
    });
    ticketId = (await created.json()).id;
  }

  const { total } = await (
    await fetch(`${API}/tickets?limit=1`, { headers: { cookie: agent } })
  ).json();

  /**
   * 測る対象。
   *
   * **承認画面は存在しない**(Phase 4 の範囲)。
   * 5画面のうち4画面しか測れないことを、数に含めずに明記する。
   */
  const targets = [
    { name: 'Portalトップ', kind: 'web', url: `${WEB}/`, cookie: requester },
    {
      name: '申請フォーム',
      kind: 'web',
      url: `${WEB}/tickets/new?kind=request`,
      cookie: requester,
    },
    { name: 'チケット詳細', kind: 'web', url: `${WEB}/tickets/${ticketId}`, cookie: requester },
    { name: 'Ops一覧', kind: 'web', url: `${WEB}/ops`, cookie: agent },
    // API 側。素の Node なので、本番に近い素性で読める。
    { name: 'API: 一覧', kind: 'api', url: `${API}/tickets?limit=20`, cookie: agent },
    {
      name: 'API: 作業画面',
      kind: 'api',
      url: `${API}/tickets/${ticketId}/workspace`,
      cookie: agent,
    },
  ];

  process.stdout.write(
    `対象: ${USERS} 同時 × ${ROUNDS} 周 / チケット総数 ${total ?? '?'} 件\n` +
      `閾値: p95 ≤ ${THRESHOLD_MS}ms\n\n`,
  );

  const results = [];
  for (const target of targets) {
    const samples = [];
    let errors = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      // **同時に投げる。** 順番に投げると同時実行の影響が測れない。
      await Promise.all(
        Array.from({ length: USERS }, async () => {
          const started = performance.now();
          try {
            const res = await fetch(target.url, { headers: { cookie: target.cookie } });
            // 本文を読み切るまでが応答である。**ヘッダだけで止めない。**
            await res.arrayBuffer();
            if (!res.ok) errors += 1;
          } catch {
            errors += 1;
          }
          samples.push(performance.now() - started);
        }),
      );
    }

    samples.sort((a, b) => a - b);
    results.push({
      name: target.name,
      kind: target.kind,
      count: samples.length,
      errors,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples[samples.length - 1] ?? 0,
    });
  }

  const ms = (v) => `${Math.round(v).toString().padStart(6)}ms`;
  process.stdout.write('画面/経路              件数   err     p50     p95     p99     max  判定\n');
  for (const r of results) {
    const pass = r.errors === 0 && r.p95 <= THRESHOLD_MS;
    process.stdout.write(
      `${r.name.padEnd(20)} ${String(r.count).padStart(5)} ${String(r.errors).padStart(5)} ` +
        `${ms(r.p50)} ${ms(r.p95)} ${ms(r.p99)} ${ms(r.max)}  ${pass ? 'OK' : 'NG'}\n`,
    );
  }

  // **遅いことと、失敗したことを混ぜない。**
  // 混ぜると「エラーで速く返った」を「速い」と読み、
  // あるいは「壊れている」を「遅い」と診断する。
  const broken = results.filter((r) => r.errors > 0);
  const slowWeb = results.filter((r) => r.kind === 'web' && r.errors === 0 && r.p95 > THRESHOLD_MS);
  const slowApi = results.filter((r) => r.kind === 'api' && r.errors === 0 && r.p95 > THRESHOLD_MS);

  process.stdout.write(
    '\n**測っていない画面がある。** 承認画面は未実装(Phase 4)であり、\n' +
      '要求が挙げる5画面のうち4画面しか測っていない。\n' +
      '\n**この数値は本番の値ではない。** 開発機の Colima 上で、\n' +
      'Next.js は開発モードで動いている(要求ごとに再コンパイルしうる)。\n' +
      '画面の値は上限の目安であり、API の値のほうが素性が近い。\n',
  );

  if (broken.length > 0) {
    // **測れていない。** 応答が返らなかったものの時間に意味は無い。
    process.stdout.write(
      `\n**測定になっていない**: ${broken.map((r) => `${r.name}(${r.errors}件失敗)`).join(', ')}\n` +
        '応答が返らなかった要求の時間に意味は無い。原因を直してから測り直すこと。\n',
    );
    process.exit(1);
  }
  if (slowApi.length > 0) {
    process.stdout.write(`\nAPI が閾値を超えた: ${slowApi.map((r) => r.name).join(', ')}\n`);
    process.exit(1);
  }
  if (slowWeb.length > 0) {
    // **開発モードの画面が遅いことを「不合格」と断じない。**
    // 断じると、環境の違いを製品の欠陥として記録することになる。
    process.stdout.write(
      `\n画面が閾値を超えた(開発モード): ${slowWeb.map((r) => r.name).join(', ')}\n` +
        '本番構成での再測定が要る。ここでは判定を保留する。\n',
    );
    process.exit(0);
  }
  process.stdout.write('\nすべて閾値内\n');
}

await main();
