#!/usr/bin/env node
/**
 * 画面の状態表示の通し確認 (NFR-UX-004 / 11.11 / WP-P2-UISTATE-018)
 *
 * `loading.tsx` / `error.tsx` / `not-found.tsx` が1つも無かった。
 * さらに **APIが落ちていると全画面が黙ってログイン画面へ送られていた。**
 * 利用者はログアウトさせられたと思い、そのログイン画面でも同じ理由で失敗する。
 * 画面上は「パスワードが違う」ようにしか見えない。
 *
 * **APIを実際に止めて確かめる。** 止めずに確かめられるのは
 * 「文言が書いてある」ことまでで、「そのとき何が起きるか」ではない。
 *
 * 使い方: node tools/e2e/ui_state_flow.mjs
 * (docker が必要。止めたAPIは必ず戻す)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
const ORG = '00000000-0000-4000-9000-000000000001';

let failed = 0;
const check = (n, ok, d = '') => {
  process.stdout.write(`${ok ? 'OK  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}\n`);
  if (!ok) failed++;
};

/**
 * 配信された本文に文言が含まれるか。
 *
 * **`<script>` を落として判定してはいけない。** not-found / error の境界は
 * flight payload として script の中で配信され、ブラウザが描く。
 * script を落とすと「配信されているのに無い」と誤判定する。
 *
 * 「配信された」ことしか言えない点は承知している。
 * **実際に見えるか**は `check_accessibility.mjs`(実ブラウザ)が受け持つ。
 */
const delivered = (html, text) => html.includes(text);

async function page(path, cookie = '') {
  const res = await fetch(`${WEB}${path}`, { headers: { cookie }, redirect: 'manual' });
  const html = res.status === 200 ? await res.text() : '';
  return { status: res.status, location: res.headers.get('location') ?? '', html };
}

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'agent@acme.example.test',
    password: 'local-dev-password-1',
    organizationId: ORG,
  }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

// ---------------------------------------------------------------------------
// 1. 見つからない — 以前は本文が空だった
// ---------------------------------------------------------------------------
const missing = await page('/ops/00000000-0000-4000-8000-000000000404', cookie);
check('存在しないチケットは 404', missing.status === 404, `status=${missing.status}`);

const missingBody = await (
  await fetch(`${WEB}/ops/00000000-0000-4000-8000-000000000404`, {
    headers: { cookie },
  })
).text();
check(
  '**404に本文がある**(以前はヘッダだけの空白ページだった)',
  delivered(missingBody, '見つかりませんでした'),
);
check(
  '404から戻る導線がある',
  delivered(missingBody, '対応待ちの一覧') && delivered(missingBody, '問い合わせの一覧'),
);
check(
  '**「存在しません」と断言しない**(他組織のチケットも404で返すため)',
  !delivered(missingBody, '存在しません'),
);

const noRoute = await (await fetch(`${WEB}/does-not-exist-at-all`, { headers: { cookie } })).text();
check('存在しないURLでも同じ画面が出る', delivered(noRoute, '見つかりませんでした'));

// ---------------------------------------------------------------------------
// 2. 期限切れ — なぜ戻されたのかを言う
// ---------------------------------------------------------------------------
const stale = await page('/ops', 'solvi_session=this-token-does-not-exist');
check(
  '**失効したセッションは理由つきでログイン画面へ**',
  stale.status === 307 && stale.location.includes('expired=1'),
  `status=${stale.status} location=${stale.location}`,
);

const anonymous = await page('/ops');
check(
  '一度も入っていない人には期限切れと言わない',
  anonymous.status === 307 && !anonymous.location.includes('expired'),
  `location=${anonymous.location}`,
);

const expiredScreen = await (await fetch(`${WEB}/login?expired=1`)).text();
check('ログイン画面が期限切れを説明する', delivered(expiredScreen, '有効期限が切れました'));
check(
  '期限切れの説明を「ログインできませんでした」と混ぜない',
  !delivered(expiredScreen, 'パスワードが正しくありません'),
);

// ---------------------------------------------------------------------------
// 3. 競合 — 二人が同じ問い合わせを開いている
// ---------------------------------------------------------------------------
const created = await (
  await fetch(`${API}/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      kind: 'incident',
      subject: '通し確認: 同時に触る',
      body: '本文です。',
      impact: 'medium',
      urgency: 'medium',
    }),
  })
).json();

const workspace = await (
  await fetch(`${API}/tickets/${created.id}/workspace`, { headers: { cookie } })
).json();
const staleVersion = workspace.ticket.version;
check('作業画面が版を返す', typeof staleVersion === 'string' && staleVersion.length > 0);

// 先に別の操作が入る。**実際に値が変わる操作にする** —
// 何も変わらない操作では版が動かず、競合を作れない。
const groups = await (await fetch(`${API}/groups`, { headers: { cookie } })).json();
const targetGroup = groups.items.find((g) => g.id);
let r = await fetch(`${API}/tickets/${created.id}/group`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ groupId: targetGroup.id, expectedVersion: staleVersion }),
});
check('先に操作したほうは通る', r.status === 200, `status=${r.status}`);

// 古い版のまま送る
r = await fetch(`${API}/tickets/${created.id}/assignee`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ assigneeId: null, expectedVersion: staleVersion }),
});
const staleProblem = r.status === 409 ? await r.json() : {};
check('**古い版で送ると 409**', r.status === 409, `status=${r.status}`);
check(
  '**業務規則の競合と別の型で返す**',
  typeof staleProblem.type === 'string' && staleProblem.type.endsWith('/stale'),
  `type=${staleProblem.type}`,
);
check(
  '何が起きたかを日本語で書く',
  (staleProblem.title ?? '').includes('他の人が変更しました'),
  `title=${staleProblem.title}`,
);

// 版を渡さなければ止めない(定期処理・API直叩き)
r = await fetch(`${API}/tickets/${created.id}/assignee`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ assigneeId: null }),
});
check('**版を送らない呼び出しは素通しする**', r.status === 200, `status=${r.status}`);

// 画面: 競合の告知
const stalePage = await (
  await fetch(`${WEB}/ops/${created.id}?stale=1`, { headers: { cookie } })
).text();
check(
  '画面が競合を専用の文面で伝える',
  delivered(stalePage, '他の人がこの問い合わせを変更しました'),
);
check(
  '**「もう一度押す」ではなく「読み直す」と言う**',
  delivered(stalePage, '内容を確認したうえで'),
);
check('作業画面のフォームが版を持っている', delivered(stalePage, 'expectedVersion'));

// ---------------------------------------------------------------------------
// 4. 基盤が落ちているとき — **実際に止めて確かめる**
// ---------------------------------------------------------------------------
process.stdout.write('\n--- APIを停止して確認します ---\n');
await run('docker', ['stop', 'solvi-api-1']);
try {
  const down = await page('/ops', cookie);
  check(
    '**APIが落ちていてもログイン画面へ送らない**',
    down.status === 307 && down.location === '/unavailable',
    `status=${down.status} location=${down.location}`,
  );

  const downBody = await (await fetch(`${WEB}/unavailable`, { headers: { cookie } })).text();
  check('接続できない旨が日本語で出る', delivered(downBody, 'ただいま接続できません'));
  check(
    '**「ログアウトされたわけではない」と明示する**',
    delivered(downBody, 'ログアウトされたわけではありません'),
  );
  // 出口は1つで足りる。復旧していれば最初の画面が開き、
  // していなければまたここへ戻る。**同じ場所へのリンクを2つ並べない。**
  check(
    '**再試行と出口を兼ねるリンクがある**',
    delivered(downBody, 'もう一度読み込む') && delivered(downBody, 'href="/"'),
  );
  check('復旧後にログインし直さなくてよいと書いてある', delivered(downBody, 'ログインし直さずに'));
  check(
    '**内部のホスト名やポートを出さない**',
    !delivered(downBody, 'api:3001') && !delivered(downBody, 'ECONNREFUSED'),
  );
} finally {
  process.stdout.write('--- APIを再開します ---\n');
  await run('docker', ['start', 'solvi-api-1']);
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${API}/healthz`)).ok) break;
    } catch {
      /* まだ起きていない */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------------------
// 5. 復旧したら元通りに使える
// ---------------------------------------------------------------------------
const recovered = await page('/ops', cookie);
check(
  '復旧後は同じセッションでそのまま使える',
  recovered.status === 200,
  `status=${recovered.status}`,
);

process.stdout.write(failed === 0 ? '\n通し確認: すべて OK\n' : `\n通し確認: ${failed} 件 NG\n`);
process.exit(failed === 0 ? 0 : 1);
