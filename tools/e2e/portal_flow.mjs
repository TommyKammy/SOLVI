/** ログイン → 起票 → 参照 の通し確認 (WP-P2-PORTAL-002) */
const API = 'http://127.0.0.1:3001';
const ORG = '00000000-0000-4000-9000-000000000001';
const step = (n, ok, detail = '') =>
  console.log(`${ok ? 'OK  ' : 'NG  '} ${n}${detail ? ' — ' + detail : ''}`);
let failed = 0;
const check = (n, ok, d) => {
  step(n, ok, d);
  if (!ok) failed++;
};

// 1. 未認証ではチケット一覧が見えない
let r = await fetch(`${API}/tickets`);
check('未認証で /tickets が 401', r.status === 401, `status=${r.status}`);

// 2. 誤ったパスワードは 401、理由を返さない
r = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'requester@acme.example.test',
    password: 'wrong',
    organizationId: ORG,
  }),
});
const wrongBody = await r.json();
check('誤パスワードで 401', r.status === 401, `status=${r.status}`);
check(
  '失敗理由を返さない',
  !JSON.stringify(wrongBody).match(/パスワード|存在|ロック/),
  JSON.stringify(wrongBody).slice(0, 80),
);

// 3. 正しい資格情報でログイン
r = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'requester@acme.example.test',
    password: 'local-dev-password-1',
    organizationId: ORG,
  }),
});
check('ログイン成功', r.status === 200, `status=${r.status}`);
const setCookie = r.headers.get('set-cookie') ?? '';
check('HttpOnly が付く', /HttpOnly/i.test(setCookie));
check('SameSite=Lax が付く', /SameSite=Lax/i.test(setCookie));
const loginBody = await r.json();
check(
  '本文にトークンを含めない',
  !JSON.stringify(loginBody).includes(setCookie.split('=')[1]?.split(';')[0] ?? 'x'),
);
const cookie = setCookie.split(';')[0];

// 4. 他組織を名乗るログインは失敗する
r = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'requester@acme.example.test',
    password: 'local-dev-password-1',
    organizationId: '00000000-0000-4000-9000-000000000002',
  }),
});
check('他組織を名乗るログインを拒否', r.status === 401, `status=${r.status}`);

// 5. 起票
r = await fetch(`${API}/tickets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({
    kind: 'incident',
    subject: '通しテスト: ログインできない',
    body: '朝からエラーが出ます。',
    impact: 'medium',
    urgency: 'high',
  }),
});
check('起票が 201', r.status === 201, `status=${r.status}`);
const ticket = await r.json();
check(
  '受付番号が返る',
  typeof ticket.number === 'string' && ticket.number.length > 0,
  ticket.number,
);
check('担当者IDを返さない', !('assigneeId' in ticket) && !('requesterId' in ticket));
check('優先度が導出されている', typeof ticket.priority === 'string', ticket.priority);

// 6. 入力不備はまとめて返る
r = await fetch(`${API}/tickets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ kind: 'nope', subject: '', body: '', impact: 'x', urgency: 'y' }),
});
const problem = await r.json();
check('不正入力が 400', r.status === 400, `status=${r.status}`);
check(
  '誤りをまとめて返す',
  (problem.errors ?? []).length >= 5,
  `${(problem.errors ?? []).length} 件`,
);
check(
  'Problem Details 形式',
  typeof problem.type === 'string' && typeof problem.title === 'string',
);

// 7. 一覧と個別取得
r = await fetch(`${API}/tickets`, { headers: { cookie } });
const list = await r.json();
check(
  '一覧が取得できる',
  r.status === 200 && list.items.length > 0,
  `${list.items?.length} 件 scope=${list.scope}`,
);
check('依頼者の可視範囲は own', list.scope === 'own', list.scope);

r = await fetch(`${API}/tickets/${ticket.id}`, { headers: { cookie } });
check('個別取得できる', r.status === 200, `status=${r.status}`);

// 8. 存在しないIDは 404
r = await fetch(`${API}/tickets/00000000-0000-4000-9000-0000000000ff`, { headers: { cookie } });
check('存在しないIDは 404', r.status === 404, `status=${r.status}`);

// 9. ログアウトでセッションが失効する
r = await fetch(`${API}/auth/logout`, { method: 'POST', headers: { cookie } });
check('ログアウトが 204', r.status === 204, `status=${r.status}`);
r = await fetch(`${API}/tickets`, { headers: { cookie } });
check('**ログアウト後は同じCookieで通らない**', r.status === 401, `status=${r.status}`);

// 10. 画面が返る
for (const [name, path] of [
  ['ログイン画面', '/login'],
  ['ポータルトップ(未認証はログインへ)', '/'],
]) {
  const res = await fetch(`http://127.0.0.1:3000${path}`, { redirect: 'manual' });
  check(
    name,
    res.status === 200 || res.status === 307 || res.status === 302,
    `status=${res.status}`,
  );
}

console.log(
  failed === 0 ? '\nOK: 通し確認はすべて期待どおりです' : `\n${failed} 件の問題があります`,
);
process.exit(failed === 0 ? 0 : 1);
