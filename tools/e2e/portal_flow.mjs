/** ログイン → 起票 → 参照 の通し確認 (WP-P2-PORTAL-002) */
const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
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

// 3. 正しい資格情報でログイン。**組織IDは送らない。**
//
// かつて画面は利用者に組織IDのUUIDを手入力させていた。
// 利用者が知っているのは「自分がどの会社の人間か」だけであり、
// 所属はシステムが役割束縛として持っている (WP-P1-IDM-010)。
r = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'requester@acme.example.test',
    password: 'local-dev-password-1',
  }),
});
check('ログイン成功', r.status === 200, `status=${r.status}`);
const setCookie = r.headers.get('set-cookie') ?? '';
check('HttpOnly が付く', /HttpOnly/i.test(setCookie));
check('SameSite=Lax が付く', /SameSite=Lax/i.test(setCookie));
const loginBody = await r.json();
check(
  '**組織を指定せずに所属が決まる**',
  loginBody.organizationId === ORG,
  String(loginBody.organizationId),
);
check(
  '所属組織が名前つきで返る',
  (loginBody.organizations ?? []).every((o) => (o.name ?? '').length > 0),
);
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

// ---------------------------------------------------------------------------
// 兼務者は組織を選ぶまで業務APIを使えない (WP-P1-IDM-010)
// ---------------------------------------------------------------------------
r = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // シードの acme agent は beta の requester も兼ねる
  body: JSON.stringify({ email: 'agent@acme.example.test', password: 'local-dev-password-1' }),
});
const dual = await r.json();
const dualCookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
check(
  '**兼務者は組織が決まらない**(勝手に選ばない)',
  dual.organizationId === null,
  String(dual.organizationId),
);
check('選択肢が2件返る', (dual.organizations ?? []).length === 2);

r = await fetch(`${API}/auth/me`, { headers: { cookie: dualCookie } });
const denied = await r.json();
check(
  '**未選択のまま業務APIを呼ぶと専用の型で拒否される**',
  r.status === 403 && String(denied.type).endsWith('/organization-not-selected'),
  `status=${r.status} type=${String(denied.type).split('/').pop()}`,
);

r = await fetch(`${API}/auth/organizations`, { headers: { cookie: dualCookie } });
const orgList = await r.json();
check(
  '未選択でも組織一覧は取れる(行き止まりを作らない)',
  r.status === 200 && orgList.organizations.length === 2,
);

r = await fetch(`${API}/auth/organization`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: dualCookie },
  body: JSON.stringify({ organizationId: orgList.organizations[0].id }),
});
check('組織を選べる', r.status === 200, `status=${r.status}`);
r = await fetch(`${API}/auth/me`, { headers: { cookie: dualCookie } });
check(
  '選択後は業務APIが通る',
  r.status === 200 && (await r.json()).organizationId === orgList.organizations[0].id,
);

r = await fetch(`${API}/auth/organization`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: dualCookie },
  body: JSON.stringify({ organizationId: '00000000-0000-4000-9000-000000000099' }),
});
check('**所属していない組織へは切り替えられない**', r.status === 403, `status=${r.status}`);

const loginPage = await fetch(`${WEB}/login`);
check('**ログイン画面に組織IDの入力欄が無い**', !(await loginPage.text()).includes('組織ID'));

const selectPage = await fetch(`${WEB}/select-organization`, { headers: { cookie: dualCookie } });
const selectHtml = await selectPage.text();
check('組織の選択画面が開く', selectPage.status === 200, `status=${selectPage.status}`);
check('**組織を名前で選ばせる**', selectHtml.includes('サンプル株式会社'));

console.log(
  failed === 0 ? '\nOK: 通し確認はすべて期待どおりです' : `\n${failed} 件の問題があります`,
);
process.exit(failed === 0 ? 0 : 1);
