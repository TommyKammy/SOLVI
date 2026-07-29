#!/usr/bin/env node
/**
 * 担当グループの通し確認 (FR-TKT-003 / WP-P2-GRP-015)
 *
 * 要求は「担当 Group / User を設定」だが、実装は個人割当だけだった。
 * **ITSMの基本動作の欠落である。** 問い合わせはまずキューに入り、
 * そこから個人が引き受ける。
 *
 * ここでは実スタックへHTTPで話しかけ、**管理者がグループを作れること**まで
 * 確かめる。作る手段が無いグループ機能は、新しく構築した環境で使えない。
 */
const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';

let failed = 0;
const check = (n, ok, d = '') => {
  process.stdout.write(`${ok ? 'OK  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}\n`);
  if (!ok) failed++;
};

async function login(email, organizationId = ORG_A) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'local-dev-password-1', organizationId }),
  });
  if (!r.ok) throw new Error(`ログイン失敗 ${email}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

const call = (path, cookie, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });

const requester = await login('requester@acme.example.test');
const agent = await login('agent@acme.example.test');
const orgAdmin = await login('org_admin@acme.example.test');
const otherAdmin = await login('org_admin@beta.example.test', ORG_B);

// ---------------------------------------------------------------------------
// 1. 管理 — 作れなければ使えない
// ---------------------------------------------------------------------------
const suffix = Date.now().toString(36).slice(-6);
let r = await call('/groups', orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ code: `e2e-${suffix}`, name: `通し確認チーム ${suffix}` }),
});
check('**管理者がグループを作れる**', r.status === 201, `status=${r.status}`);
const created = await r.json();

r = await call('/groups', agent, {
  method: 'POST',
  body: JSON.stringify({ code: `e2e-x-${suffix}`, name: 'X' }),
});
check(
  '**担当者はグループを作れない**(体制を変えられるのは管理者)',
  r.status === 403,
  `status=${r.status}`,
);

r = await call('/groups', requester);
check('**依頼者はグループを見られない**', r.status === 403, `status=${r.status}`);

r = await call('/groups', agent);
const groups = await r.json();
check('担当者は振り先の候補を見られる', r.status === 200 && groups.items.length > 0);
check(
  '**シードにキューがある**(新規構築で画面から試せる)',
  groups.items.some((g) => g.code === 'helpdesk'),
  groups.items.map((g) => g.code).join(' / '),
);

// ---------------------------------------------------------------------------
// 2. メンバー
// ---------------------------------------------------------------------------
const me = await (await call('/auth/me', agent)).json();
r = await call(`/groups/${created.id}/members`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ userId: me.userId }),
});
check('メンバーを追加できる', r.status === 204, `status=${r.status}`);

r = await call('/groups/mine', agent);
const mine = await r.json();
check(
  '本人の所属を引ける(自分のキューの絞り込みに使う)',
  mine.items.some((g) => g.id === created.id),
  mine.items.map((g) => g.name).join(' / '),
);

// ---------------------------------------------------------------------------
// 3. 振り分け — 経路であって進行状態ではない
// ---------------------------------------------------------------------------
r = await call('/tickets', requester, {
  method: 'POST',
  body: JSON.stringify({
    kind: 'incident',
    subject: '通し確認: グループへ振る',
    body: '本文です。',
    impact: 'medium',
    urgency: 'medium',
  }),
});
const ticket = await r.json();

r = await call(`/tickets/${ticket.id}/group`, agent, {
  method: 'POST',
  body: JSON.stringify({ groupId: created.id }),
});
check('グループへ振れる', r.status === 200, `status=${r.status}`);

r = await call(`/tickets/${ticket.id}`, agent);
const afterRoute = await r.json();
check(
  '**振っても状態は動かない**(キューに入っただけで担当者は決まっていない)',
  afterRoute.state === 'new',
  afterRoute.state,
);

// 個人の担当を付けてから振り直しても、担当は外れない
await call(`/tickets/${ticket.id}/assignee`, agent, {
  method: 'POST',
  body: JSON.stringify({ assigneeId: me.userId }),
});
const helpdesk = groups.items.find((g) => g.code === 'helpdesk');
await call(`/tickets/${ticket.id}/group`, agent, {
  method: 'POST',
  body: JSON.stringify({ groupId: helpdesk.id }),
});
r = await call(`/tickets/${ticket.id}/workspace`, agent);
const ws = await r.json();
check(
  '**振り直しても個人の担当は外れない**',
  ws.ticket.assigneeId === me.userId && ws.ticket.assigneeGroupId === helpdesk.id,
  `assignee=${ws.ticket.assigneeId === me.userId} group=${ws.ticket.assigneeGroupId === helpdesk.id}`,
);
check('振り先の候補が作業画面の応答に含まれる', (ws.availableGroups ?? []).length > 0);

r = await call(`/tickets/${ticket.id}/group`, requester, {
  method: 'POST',
  body: JSON.stringify({ groupId: helpdesk.id }),
});
check('**依頼者は振れない**', r.status === 403, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 4. 越境しないこと
// ---------------------------------------------------------------------------
r = await call('/groups', otherAdmin, {
  method: 'POST',
  body: JSON.stringify({ code: `e2e-b-${suffix}`, name: '他組織のチーム' }),
});
const foreign = await r.json();

r = await call('/groups?includeInactive=1', orgAdmin);
const visible = await r.json();
check('**他組織のグループは見えない**', !visible.items.some((g) => g.id === foreign.id));

r = await call(`/tickets/${ticket.id}/group`, agent, {
  method: 'POST',
  body: JSON.stringify({ groupId: foreign.id }),
});
check('**他組織のグループへは振れない**', r.status === 400, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 5. キューの絞り込み
// ---------------------------------------------------------------------------
r = await call(`/tickets?group=${created.id}`, agent);
const byGroup = await r.json();
check('グループを指定して絞り込める', r.status === 200, `status=${r.status}`);
check('絞り込んだ条件が応答に含まれる', JSON.stringify(byGroup.appliedFilter).includes(created.id));

r = await call('/tickets?group=ungrouped', agent);
const ungrouped = await r.json();
check(
  '**グループ未割当を探せる**(誰も見ていないものを見つける)',
  ungrouped.items.every((t) => t.id !== ticket.id),
);

r = await call('/tickets?group=everything', agent);
check('知らない値は 400(黙って無視しない)', r.status === 400, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 6. 無効化 — 消さずに閉じる
// ---------------------------------------------------------------------------
r = await call(`/groups/${created.id}/active`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ active: false }),
});
check('運用から外せる', r.status === 204, `status=${r.status}`);

r = await call('/groups', agent);
check(
  '外したグループは振り先の候補に出ない',
  !(await r.json()).items.some((g) => g.id === created.id),
);

r = await call('/groups?includeInactive=1', orgAdmin);
check(
  '**消えてはいない**(過去のチケットが振り先を失わない)',
  (await r.json()).items.some((g) => g.id === created.id),
);

r = await call(`/tickets/${ticket.id}/group`, agent, {
  method: 'POST',
  body: JSON.stringify({ groupId: created.id }),
});
check('外したグループへは新しく振れない', r.status === 400, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 7. 画面
// ---------------------------------------------------------------------------
const opsPage = await fetch(`${WEB}/ops/${ticket.id}`, { headers: { cookie: agent } });
const opsHtml = await opsPage.text();
check('担当者の作業画面に振り先が出る', opsPage.status === 200 && opsHtml.includes('振り先'));
check('担当グループの現在値が出る', opsHtml.includes('担当グループ'));

const listPage = await fetch(`${WEB}/ops`, { headers: { cookie: agent } });
const listHtml = await listPage.text();
check('一覧にグループの絞り込みが出る', listHtml.includes('自分のグループ'));

const adminPage = await fetch(`${WEB}/ops/groups`, { headers: { cookie: orgAdmin } });
const adminHtml = await adminPage.text();
check('**管理画面がある**(作る手段が無い機能は使えない)', adminHtml.includes('グループを作る'));

const agentAdminPage = await fetch(`${WEB}/ops/groups`, { headers: { cookie: agent } });
check(
  '担当者には管理画面の中身を見せない',
  !(await agentAdminPage.text()).includes('グループを作る'),
);

process.stdout.write(
  failed === 0
    ? '\nOK: 担当グループの通し確認はすべて期待どおりです\n'
    : `\n${failed} 件の問題があります\n`,
);
process.exit(failed === 0 ? 0 : 1);
