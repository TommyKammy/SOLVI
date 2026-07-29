#!/usr/bin/env node
/**
 * 往復の通し確認 (WP-P2-OPSUI-010)
 *
 * 依頼者と担当者が画面だけでやり取りを完結できるかを、実スタックで確かめる。
 * **内部メモが依頼者側の応答に一切現れないこと**が最大の検査項目である。
 */
const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
const ORG = '00000000-0000-4000-9000-000000000001';
const SECRET = '本人の設定ミスと思われる。以前も同様の連絡あり。';

let failed = 0;
const check = (n, ok, d = '') => {
  process.stdout.write(`${ok ? 'OK  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}\n`);
  if (!ok) failed++;
};

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'local-dev-password-1', organizationId: ORG }),
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

// 1. 依頼者が申告する
let r = await call('/tickets', requester, {
  method: 'POST',
  body: JSON.stringify({
    kind: 'incident',
    subject: '往復テスト: メールが送れない',
    body: '送信ボタンを押すとエラーになります。',
    impact: 'medium',
    urgency: 'high',
  }),
});
check('依頼者が申告できる', r.status === 201, `status=${r.status}`);
const ticket = await r.json();

// 2. 担当者が引き受けて着手する
r = await call(`/tickets/${ticket.id}/workspace`, agent);
const ws = await r.json();
check('担当者が作業画面を取得できる', r.status === 200, `status=${r.status}`);
check(
  '実行できる操作が算出される',
  ws.availableActions.some((a) => a.to === 'assigned'),
  ws.availableActions.map((a) => a.label).join(' / '),
);
check(
  '**new から resolved は選択肢に出ない**',
  !ws.availableActions.some((a) => a.to === 'resolved'),
);

r = await call(`/tickets/${ticket.id}/transitions`, agent, {
  method: 'POST',
  body: JSON.stringify({ to: 'assigned', reason: 'assign' }),
});
check('引受で状態が変わる', r.status === 200 && (await r.json()).state === 'assigned');

// 3. 担当者が内部メモを書く
r = await call(`/tickets/${ticket.id}/comments`, agent, {
  method: 'POST',
  body: JSON.stringify({ visibility: 'internal', body: SECRET }),
});
check('担当者が内部メモを書ける', r.status === 201, `status=${r.status}`);

// 4. 担当者が公開コメントを書く
r = await call(`/tickets/${ticket.id}/comments`, agent, {
  method: 'POST',
  body: JSON.stringify({ visibility: 'public', body: '設定を確認しています。' }),
});
check('担当者が公開コメントを書ける', r.status === 201, `status=${r.status}`);

// 5. **依頼者の応答に内部メモが現れない**
r = await call(`/tickets/${ticket.id}/comments`, requester);
const forRequester = await r.json();
const requesterText = JSON.stringify(forRequester);
check('**依頼者の応答に内部メモの本文が無い**', !requesterText.includes('設定ミス'));
check(
  '**内部メモが件数にも現れない**',
  forRequester.items.length === 1,
  `${forRequester.items.length} 件`,
);
check('公開コメントは届く', requesterText.includes('設定を確認'));

// 担当者には見える
r = await call(`/tickets/${ticket.id}/comments`, agent);
const forAgent = await r.json();
check('担当者には内部メモが見える', JSON.stringify(forAgent).includes('設定ミス'));
check('担当者には2件見える', forAgent.items.length === 2, `${forAgent.items.length} 件`);

// 6. 依頼者が返信する
r = await call(`/tickets/${ticket.id}/comments`, requester, {
  method: 'POST',
  body: JSON.stringify({ visibility: 'public', body: 'ありがとうございます。お待ちします。' }),
});
check('依頼者が返信できる', r.status === 201, `status=${r.status}`);

// 依頼者は内部メモを書けない
r = await call(`/tickets/${ticket.id}/comments`, requester, {
  method: 'POST',
  body: JSON.stringify({ visibility: 'internal', body: '内部メモのつもり' }),
});
check('**依頼者は内部メモを書けない**', r.status === 403, `status=${r.status}`);

// 7. 解決まで進める
for (const [to, reason] of [
  ['in_progress', 'start'],
  ['resolved', 'resolve'],
]) {
  r = await call(`/tickets/${ticket.id}/transitions`, agent, {
    method: 'POST',
    body: JSON.stringify({ to, reason }),
  });
  check(`${to} へ遷移できる`, r.status === 200, `status=${r.status}`);
}

// 8. 画面が返る
for (const [name, path, cookie] of [
  ['担当者の一覧', '/ops', agent],
  ['担当者の作業画面', `/ops/${ticket.id}`, agent],
  ['依頼者の詳細画面', `/tickets/${ticket.id}`, requester],
]) {
  const res = await fetch(`${WEB}${path}`, { headers: { cookie }, redirect: 'manual' });
  const html = res.ok ? await res.text() : '';
  check(name, res.status === 200, `status=${res.status}`);
  if (name === '依頼者の詳細画面' && html) {
    check('**依頼者の画面HTMLに内部メモが無い**', !html.includes('設定ミス'));
  }
  if (name === '担当者の作業画面' && html) {
    check('担当者の画面に内部メモの区別表示がある', html.includes('内部メモ'));
  }
}

// ---------------------------------------------------------------------------
// 見立ての見直し (WP-P2-PRIO-013)
//
// **優先度は入力ではない。** 影響度×緊急度から導かれる。
// 直接書き換えられると同じ入力から同じ優先度が出なくなり、
// SLA計測と監査の前提が崩れる。
// ---------------------------------------------------------------------------
r = await call(`/tickets/${ticket.id}/workspace`, agent);
const beforeAssess = await r.json();
check(
  '優先度が規則どおりだと画面へ伝わる',
  beforeAssess.priorityIsDerived === true,
  String(beforeAssess.priorityIsDerived),
);

r = await call(`/tickets/${ticket.id}/assessment`, agent, {
  method: 'POST',
  body: JSON.stringify({
    impact: 'high',
    urgency: 'high',
    reason: '3部署で同じ事象を確認',
    priority: 'low',
  }),
});
const assessed = await r.json();
check('見立てを見直せる', r.status === 200, `status=${r.status}`);
check(
  '**優先度は規則から導かれる**(送った priority は効かない)',
  assessed.priority === 'critical',
  assessed.priority,
);

r = await call(`/tickets/${ticket.id}/assessment`, agent, {
  method: 'POST',
  body: JSON.stringify({ impact: 'high', urgency: 'high', reason: '同じ値' }),
});
check('**変更が無ければ拒否する**(黙って成功にしない)', r.status === 400, `status=${r.status}`);

r = await call(`/tickets/${ticket.id}/assessment`, requester, {
  method: 'POST',
  body: JSON.stringify({ impact: 'low', urgency: 'low', reason: '下げてほしい' }),
});
check('**依頼者は見直せない**', r.status === 403, `status=${r.status}`);

const opsPage = await fetch(`${WEB}/ops/${ticket.id}`, { headers: { cookie: agent } });
const opsHtml = await opsPage.text();
check('担当者の画面に見立てが出る', opsHtml.includes('見立て'), `status=${opsPage.status}`);
check(
  '**優先度の根拠が書かれている**(誰かが決めた値に見せない)',
  opsHtml.includes('から決まっています'),
);
check('優先度の入力欄は無い', !opsHtml.includes('name="priority"'));

// ---------------------------------------------------------------------------
// 解決後の扱い (FR-TKT-012 / WP-P2-CLOSE-014)
//
// 要求は「Closed(Resolved後14日で自動)」。状態機械に規則はあったが
// **実行する者が居らず、解決済みは永久に resolved のまま残っていた。**
// さらにその遷移が担当者の選択肢として画面に出ていた。
// ---------------------------------------------------------------------------
r = await call(`/tickets/${ticket.id}/workspace`, agent);
const resolvedWs = await r.json();
const reasons = resolvedWs.availableActions.map((a) => a.reason);
check(
  '**auto_close が選択肢に出ない**(自動遷移は押すものではない)',
  !reasons.includes('auto_close'),
  reasons.join(' / '),
);
check('完了にする操作は出る', reasons.includes('close'));
check(
  '**内部の状態名が画面へ出ない**(すべての選択肢に訳がある)',
  resolvedWs.availableActions.every((a) => !/^[a-z_]+ \(/.test(a.label)),
  resolvedWs.availableActions.map((a) => a.label).join(' / '),
);

// 依頼者が再開できる。これが無いと同じ件で新規に起票し直すしかなく履歴が分断される。
r = await call(`/tickets/${ticket.id}/transitions`, requester, {
  method: 'POST',
  body: JSON.stringify({ to: 'in_progress', reason: 'reopen' }),
});
check('**依頼者が自分のチケットを再開できる**', r.status === 200, `status=${r.status}`);
r = await call(`/tickets/${ticket.id}`, requester);
check('再開後は対応中に戻る', (await r.json()).state === 'in_progress');

// 依頼者の画面に導線がある
const reResolve = [['resolved', 'resolve']];
for (const [to, reason] of reResolve) {
  await call(`/tickets/${ticket.id}/transitions`, agent, {
    method: 'POST',
    body: JSON.stringify({ to, reason }),
  });
}
const requesterPage = await fetch(`${WEB}/tickets/${ticket.id}`, {
  headers: { cookie: requester },
});
const requesterHtml = await requesterPage.text();
check('依頼者の画面が開く', requesterPage.status === 200, `status=${requesterPage.status}`);
check('**解決済みなら再開の導線が出る**', requesterHtml.includes('まだ解決していないと伝える'));
check('期限の説明がある', requesterHtml.includes('14日'));

process.stdout.write(`\nTICKET_ID=${ticket.id}\n`);
process.stdout.write(
  failed === 0
    ? '\nOK: 往復の通し確認はすべて期待どおりです\n'
    : `\n${failed} 件の問題があります\n`,
);
process.exit(failed === 0 ? 0 : 1);
