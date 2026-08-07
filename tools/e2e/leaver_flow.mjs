#!/usr/bin/env node
/**
 * 退職者のアクセス停止の通し確認 (FR-IDM-007 / FR-IDM-008 / WP-P1-IDM-011)
 *
 * `SessionService.deactivateUser` は WP-P1-IDM-009 で作られていたが
 * **呼ぶ経路が無かった。** 退職者のアカウントは有効なまま残り続けていた。
 *
 * ここで確かめるのは3つ。
 *
 *   1. **止めたらログインできない**(受入基準)
 *   2. **持っていたセッションもその場で切れる**(FR-IDM-008)
 *   3. **履歴と担当は消えない**(受入基準)
 *
 * 実スタックへHTTPで話しかける。**画面まで見る** —
 * APIだけ通っていて画面から使えない状態を作らないため。
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

async function login(email, password = 'local-dev-password-1', organizationId = ORG_A) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, organizationId }),
  });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}

const call = (path, cookie, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });

const orgAdmin = (await login('org_admin@acme.example.test')).cookie;
const agent = (await login('agent@acme.example.test')).cookie;
const requester = (await login('requester@acme.example.test')).cookie;

// ---------------------------------------------------------------------------
// 1. 一覧 — 誰が在籍しているかが見えなければ止めようがない
// ---------------------------------------------------------------------------
let r = await call('/users', orgAdmin);
const list = r.ok ? await r.json() : { items: [] };
check('管理者は在籍者を見られる', r.status === 200 && list.items.length > 0, `status=${r.status}`);

r = await call('/users', agent);
check('**担当者は在籍者の一覧を見られない**(名簿になる)', r.status === 403, `status=${r.status}`);

r = await call('/users', requester);
check('依頼者も見られない', r.status === 403, `status=${r.status}`);

const target = list.items.find((m) => m.email === 'approver@acme.example.test');
check('停止の対象を一覧から特定できる', Boolean(target), target ? '' : 'approver が見つからない');
if (!target) process.exit(1);

check(
  '一覧に状態が出る',
  target.status === 'active',
  `status=${target.status}(先に止まったままなら復帰させてください)`,
);
check('一覧に対応中の件数が出る(停止前の判断材料)', typeof target.openTicketCount === 'number');

// ---------------------------------------------------------------------------
// 2. 停止の前に — 本人はログインでき、セッションも生きている
// ---------------------------------------------------------------------------
const before = await login('approver@acme.example.test');
check('停止前はログインできる', before.status === 200, `status=${before.status}`);

r = await call('/auth/me', before.cookie);
check('停止前のセッションは有効', r.status === 200, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 3. 停止
// ---------------------------------------------------------------------------
r = await call(`/users/${target.userId}/deactivate`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ reason: '' }),
});
check('**理由なしでは止められない**', r.status === 400, `status=${r.status}`);

r = await call(`/users/${target.userId}/deactivate`, agent, {
  method: 'POST',
  body: JSON.stringify({ reason: '止めたい' }),
});
check('**担当者は止められない**', r.status === 403, `status=${r.status}`);

r = await call(`/users/${target.userId}/deactivate`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ reason: '通し確認: 2026-08-31 付で退職' }),
});
const stopped = r.ok ? await r.json() : {};
check('管理者が止められる', r.status === 200, `status=${r.status}`);
check(
  '**その場でセッションが切れる**(FR-IDM-008)',
  stopped.revokedSessions >= 1,
  `revoked=${stopped.revokedSessions}`,
);
check('残っている対応中の件数を返す', typeof stopped.openTicketCount === 'number');

// ---------------------------------------------------------------------------
// 4. 止めた効果 — 受入基準そのもの
// ---------------------------------------------------------------------------
const after = await login('approver@acme.example.test');
check('**止めたらログインできない**(受入基準)', after.status === 401, `status=${after.status}`);

r = await call('/auth/me', before.cookie);
check('**止める前に持っていたセッションも使えない**', r.status === 401, `status=${r.status}`);

r = await call('/users', orgAdmin);
const afterList = await r.json();
const stoppedMember = afterList.items.find((m) => m.userId === target.userId);
check('一覧に「停止中」として残る(消えない)', stoppedMember?.status === 'deactivated');
check('停止日時が記録される', Boolean(stoppedMember?.deactivatedAt));

r = await call(`/users/${target.userId}/deactivate`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ reason: '二度目' }),
});
check('二度止めると 409', r.status === 409, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 5. 画面 — APIだけ通っていて画面から使えない状態を作らない
// ---------------------------------------------------------------------------
async function page(path, cookie) {
  const res = await fetch(`${WEB}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, html: res.ok ? await res.text() : '' };
}

const adminWeb = await page('/ops/users', orgAdmin);
check('管理画面が開く', adminWeb.status === 200, `status=${adminWeb.status}`);
check('画面に在籍者が並ぶ', adminWeb.html.includes('approver@acme.example.test'));
check(
  '**止まっていることが文言で分かる**(色や薄さだけに頼らない)',
  adminWeb.html.includes('アクセス停止中'),
);
check(
  '止める理由の入力欄がある',
  adminWeb.html.includes('止める理由') || adminWeb.html.includes('戻す理由'),
);

const agentWeb = await page('/ops/users', agent);
check(
  '担当者には管理画面の中身が出ない',
  !agentWeb.html.includes('approver@acme.example.test'),
  `status=${agentWeb.status}`,
);

const opsWeb = await page('/ops', orgAdmin);
check(
  '**一覧から管理画面へ辿れる**(経路が無い画面は無いのと同じ)',
  opsWeb.html.includes('/ops/users'),
);

// ---------------------------------------------------------------------------
// 6. 期限つきの役割 (FR-IDM-006 / WP-P1-IDM-014)
// ---------------------------------------------------------------------------
// 兼務・出向の期限は静かに来る。**切れてから気付く状態を作らない。**
// シードは acme の担当者へ beta の依頼者役を90日期限で与えている。
const betaAdmin = (await login('org_admin@beta.example.test', 'local-dev-password-1', ORG_B))
  .cookie;
r = await call('/users', betaAdmin);
const betaList = r.ok ? await r.json() : { items: [] };
const withTemporary = betaList.items.filter((m) => (m.temporaryRoles ?? []).length > 0);
check(
  '**期限つきの役割が一覧に出る**',
  withTemporary.length > 0,
  `該当 ${withTemporary.length} 件`,
);
check(
  '期限つきの役割に期限日が付く',
  withTemporary.every((m) => m.temporaryRoles.every((t) => typeof t.validUntil === 'string')),
);

const betaWeb = await page('/ops/users', betaAdmin);
check('画面にも期限が出る', betaWeb.html.includes('まで'), `status=${betaWeb.status}`);

// 期限の無い役割を期限つきとして出さない。
const permanentOnly = betaList.items.filter((m) => (m.temporaryRoles ?? []).length === 0);
check(
  '**期限の無い役割を期限つきとして出さない**',
  permanentOnly.length > 0,
  `該当 ${permanentOnly.length} 件`,
);

// ---------------------------------------------------------------------------
// 7. 利用者を作る (WP-P1-IDM-016)
// ---------------------------------------------------------------------------
// **これまで人を作る経路が無かった。** 役割は配れるようになったが、
// 配る相手をシードとSQLでしか用意できなかった。
const newEmail = `e2e-newcomer-${Date.now().toString(36)}@acme.example.test`;

r = await call('/users', agent, {
  method: 'POST',
  body: JSON.stringify({
    email: newEmail,
    displayName: '通し確認の新人',
    roleCode: 'requester',
    reason: '担当者が作る',
  }),
});
check('**担当者は利用者を作れない**', r.status === 403, `status=${r.status}`);

r = await call('/users', orgAdmin, {
  method: 'POST',
  body: JSON.stringify({
    email: 'not-an-email',
    displayName: '形式不正',
    roleCode: 'requester',
    reason: '検査',
  }),
});
check('メールの形式を見る', r.status === 400, `status=${r.status}`);

r = await call('/users', orgAdmin, {
  method: 'POST',
  body: JSON.stringify({
    email: newEmail,
    displayName: '通し確認の新人',
    roleCode: 'platform_admin',
    reason: '奪取の試み',
  }),
});
check('**platform ロールでは作れない**', r.status === 400, `status=${r.status}`);

r = await call('/users', orgAdmin, {
  method: 'POST',
  body: JSON.stringify({
    email: newEmail,
    displayName: '通し確認の新人',
    roleCode: 'requester',
    reason: '通し確認: 入社',
  }),
});
check('**管理者が利用者を作れる**', r.status === 201, `status=${r.status}`);
const newcomer = r.ok ? await r.json() : {};

r = await call('/users', orgAdmin, {
  method: 'POST',
  body: JSON.stringify({
    email: newEmail,
    displayName: '重複',
    roleCode: 'requester',
    reason: '二重作成',
  }),
});
check('同じ組織の重複は 409', r.status === 409, `status=${r.status}`);

r = await call('/users', orgAdmin);
const afterCreate = await r.json();
const made = afterCreate.items.find((m) => m.userId === newcomer.userId);
check('作った利用者が一覧に出る', Boolean(made), made ? '' : '見つからない');
check('最初の役割が付いている', (made?.roleCodes ?? []).includes('requester'));

// **作っただけでは入れない。**
const tryLogin = await login(newEmail, 'local-dev-password-1');
check(
  '**作っただけではログインできない**(資格情報は別の手順)',
  tryLogin.status === 401,
  `status=${tryLogin.status}`,
);

const createWeb = await page('/ops/users', orgAdmin);
check('画面に利用者を追加する導線がある', createWeb.html.includes('利用者を追加する'));
check(
  '**資格情報が別手順であることを画面が言う**',
  createWeb.html.includes('資格情報の設定は別の手順です'),
);

// 後始末: 作った利用者を止める(消す経路は無い — 履歴を残す設計)
r = await call(`/users/${newcomer.userId}/deactivate`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ reason: '通し確認の後始末' }),
});
check('作った利用者を止められる', r.status === 200, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 8. 役割の付与と取り消し (WP-P1-IDM-015)
// ---------------------------------------------------------------------------
// **これまで役割を配る経路が無かった。** シードとSQLでしか付けられず、
// 新しく構築した環境では誰にも権限を与えられなかった。
const requesterUser = list.items.find((m) => m.email === 'requester@acme.example.test');

r = await call(`/users/${requesterUser.userId}/roles`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ roleCode: 'platform_admin', reason: '奪取の試み' }),
});
check(
  '**platform ロールは配れない**(二重承認が要る / 02.18 §2)',
  r.status === 400,
  `status=${r.status}`,
);

r = await call(`/users/${requesterUser.userId}/roles`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ roleCode: 'auditor', reason: '' }),
});
check('理由なしでは配れない', r.status === 400, `status=${r.status}`);

r = await call(`/users/${requesterUser.userId}/roles`, agent, {
  method: 'POST',
  body: JSON.stringify({ roleCode: 'auditor', reason: '担当者が配る' }),
});
check('**担当者は役割を配れない**', r.status === 403, `status=${r.status}`);

r = await call(`/users/${requesterUser.userId}/roles`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ roleCode: 'auditor', reason: '通し確認: 監査担当を追加' }),
});
check('管理者が役割を配れる', r.status === 204, `status=${r.status}`);

r = await call('/users', orgAdmin);
const afterGrant = await r.json();
check(
  '与えた役割が一覧に出る',
  afterGrant.items.find((m) => m.userId === requesterUser.userId).roleCodes.includes('auditor'),
);

// 期限つき
r = await call(`/users/${requesterUser.userId}/roles`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({
    roleCode: 'approver',
    reason: '通し確認: 期限つき',
    validUntil: '2026-12-31',
  }),
});
check('**期限つきで配れる**(兼務・出向)', r.status === 204, `status=${r.status}`);

r = await call('/users', orgAdmin);
const withTemp = (await r.json()).items.find((m) => m.userId === requesterUser.userId);
check(
  '期限つきの役割として一覧に出る',
  (withTemp.temporaryRoles ?? []).some((t) => t.roleCode === 'approver'),
);

// 取り消し
r = await call(`/users/${requesterUser.userId}/roles/revoke`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ roleCode: 'auditor', reason: '通し確認の後始末' }),
});
check('管理者が役割を取り消せる', r.status === 204, `status=${r.status}`);

r = await call(`/users/${requesterUser.userId}/roles/revoke`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ roleCode: 'approver', reason: '通し確認の後始末' }),
});
check('期限つきの役割も取り消せる', r.status === 204, `status=${r.status}`);

r = await call('/users', orgAdmin);
const afterRevoke = (await r.json()).items.find((m) => m.userId === requesterUser.userId);
check('取り消した役割は一覧から消える', !afterRevoke.roleCodes.includes('auditor'));
check('取り消した期限つきの役割も消える', (afterRevoke.temporaryRoles ?? []).length === 0);

const roleWeb = await page('/ops/users', orgAdmin);
check('画面に役割を変える導線がある', roleWeb.html.includes('役割を変える'));
check(
  '**配れない役割の理由が書いてある**(選べないだけでは諦め方が分からない)',
  roleWeb.html.includes('二重承認'),
);

// ---------------------------------------------------------------------------
// 9. 復帰 — 通し確認の後始末でもある
// ---------------------------------------------------------------------------
r = await call(`/users/${target.userId}/reactivate`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ reason: '' }),
});
check('理由なしでは戻せない', r.status === 400, `status=${r.status}`);

r = await call(`/users/${target.userId}/reactivate`, orgAdmin, {
  method: 'POST',
  body: JSON.stringify({ reason: '通し確認の後始末' }),
});
check('管理者が戻せる', r.status === 204, `status=${r.status}`);

const back = await login('approver@acme.example.test');
check('戻すとログインできる', back.status === 200, `status=${back.status}`);

r = await call('/auth/me', before.cookie);
check(
  '**停止中に失効したセッションは戻らない**(盗まれた可能性を残さない)',
  r.status === 401,
  `status=${r.status}`,
);

process.stdout.write(failed === 0 ? '\n通し確認: すべて OK\n' : `\n通し確認: ${failed} 件 NG\n`);
process.exit(failed === 0 ? 0 : 1);
