#!/usr/bin/env node
/**
 * 関連付けと統合の通し確認 (WP-P2-RELUI-012)
 *
 * `RelationService` は WP-P2-REL-009 で完成していたが、**呼び出す経路が無かった。**
 * 単体・統合テストが緑でも、経路が無ければ利用者からは存在しないのと同じである。
 *
 * したがってこの確認は**テスト用の道具を一切使わない**。
 * 実際に立っているAPIとWebへHTTPで話しかけ、担当者と依頼者が
 * 画面から辿れる状態になっているかだけを見る。
 */
const API = 'http://127.0.0.1:3001';
const WEB = 'http://127.0.0.1:3000';
const ORG = '00000000-0000-4000-9000-000000000001';

let failed = 0;
const check = (n, ok, d = '') => {
  process.stdout.write(`${ok ? 'OK  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}\n`);
  if (!ok) failed++;
};

async function login(email, organizationId = ORG) {
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

async function newTicket(cookie, subject) {
  const r = await call('/tickets', cookie, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'incident',
      subject,
      body: '関連付けの通し確認で作成しました。',
      impact: 'medium',
      urgency: 'medium',
    }),
  });
  if (r.status !== 201) throw new Error(`起票に失敗: ${r.status}`);
  return r.json();
}

const requester = await login('requester@acme.example.test');
const agent = await login('agent@acme.example.test');
const otherOrg = await login('agent@beta.example.test', '00000000-0000-4000-9000-000000000002');

// ---------------------------------------------------------------------------
// 1. 関連付け
// ---------------------------------------------------------------------------
const parent = await newTicket(agent, '通し確認: 拠点全体でネットワークが不通');
const child = await newTicket(agent, '通し確認: 3階のPCが繋がらない');

let r = await call(`/tickets/${parent.id}/relations`, agent, {
  method: 'POST',
  body: JSON.stringify({ relationType: 'parent_of', targetTicketNumber: child.number }),
});
check('受付番号で関連付けられる', r.status === 201, `status=${r.status}`);

r = await call(`/tickets/${parent.id}/relations`, agent);
let list = await r.json();
check('親から見て相手が子になる', list.items[0]?.role === 'child', list.items[0]?.role);
check('件名と番号の両方が返る', list.items[0]?.number === child.number, list.items[0]?.number);
check(
  '解除に使えるIDが含まれる',
  typeof list.items[0]?.relationId === 'string' && list.items[0].relationId.length === 36,
);

r = await call(`/tickets/${child.id}/relations`, agent);
check('子から見て相手が親になる', (await r.json()).items[0]?.role === 'parent');

// ---------------------------------------------------------------------------
// 2. 未解決の子の警告 — **止めずに知らせる**
// ---------------------------------------------------------------------------
r = await call(`/tickets/${parent.id}/relations`, agent);
list = await r.json();
check(
  '未解決の子が警告として返る',
  list.unresolvedChildren.length === 1,
  `${list.unresolvedChildren.length} 件`,
);

for (const [to, reason] of [
  ['assigned', 'assign'],
  ['in_progress', 'start'],
  ['resolved', 'resolve'],
]) {
  r = await call(`/tickets/${parent.id}/transitions`, agent, {
    method: 'POST',
    body: JSON.stringify({ to, reason }),
  });
}
check(
  '**子が未解決でも親を解決できる**(警告であって拒否ではない)',
  r.status === 200,
  `status=${r.status}`,
);

// ---------------------------------------------------------------------------
// 3. 越境しないこと
// ---------------------------------------------------------------------------
const foreign = await newTicket(otherOrg, '通し確認: 他組織のチケット');

// **受付番号は組織ごとの採番である。** 同じ番号が別の組織にも存在しうる。
// したがって「他組織の番号を引くと 400 になる」とは限らない —
// 自組織に同じ番号があれば、そちらが返る。それが正しい動作である。
// 確かめるべきは**他組織の行が返らないこと**。
r = await call(`/tickets/by-number/${foreign.number}`, agent);
if (r.status === 200) {
  const found = await r.json();
  check('**他組織の行は返らない**(同番号でも自組織のものが返る)', found.ticketId !== foreign.id);
  check('他組織の件名が漏れていない', found.subject !== '通し確認: 他組織のチケット');
} else {
  check('**他組織の番号は引けない**', r.status === 400, `status=${r.status}`);
  check('件名が漏れていない', !JSON.stringify(await r.json()).includes('他組織のチケット'));
}

r = await call(`/tickets/${parent.id}/relations`, agent, {
  method: 'POST',
  body: JSON.stringify({ relationType: 'related', targetTicketNumber: foreign.number }),
});
if (r.status === 201) {
  const linked = await r.json();
  check('**他組織のチケットには繋がらない**', linked.targetTicketId !== foreign.id);
  await call(`/relations/${linked.relationId}/delete`, agent, { method: 'POST' });
} else {
  check('**他組織のチケットとは関連付けできない**', r.status === 400, `status=${r.status}`);
}

r = await call(`/tickets/${parent.id}/relations`, agent, {
  method: 'POST',
  body: JSON.stringify({ relationType: 'related', targetTicketId: foreign.id }),
});
check('**UUID直指定でも越境できない**', r.status === 404, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 4. 依頼者は見えるが触れない
// ---------------------------------------------------------------------------
const own = await newTicket(requester, '通し確認: 依頼者の申告');
const dup = await newTicket(requester, '通し確認: 依頼者の申告(重複)');

r = await call(`/tickets/${own.id}/relations`, agent, {
  method: 'POST',
  body: JSON.stringify({ relationType: 'related', targetTicketNumber: dup.number }),
});
check('担当者が依頼者のチケットを関連付けられる', r.status === 201, `status=${r.status}`);

r = await call(`/tickets/${own.id}/relations`, requester);
check('依頼者にも関連が見える', (await r.json()).items.length === 1);

r = await call(`/tickets/${own.id}/relations`, requester, {
  method: 'POST',
  body: JSON.stringify({ relationType: 'related', targetTicketNumber: dup.number }),
});
check('**依頼者は関連付けできない**', r.status === 403, `status=${r.status}`);

r = await call(`/tickets/${own.id}/merge`, requester, {
  method: 'POST',
  body: JSON.stringify({ targetTicketNumber: dup.number, reason: '同じ件です' }),
});
check('**依頼者は統合できない**', r.status === 403, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 5. 統合 — 取り消せない操作
// ---------------------------------------------------------------------------
r = await call(`/tickets/${dup.id}/merge`, agent, {
  method: 'POST',
  body: JSON.stringify({ targetTicketNumber: own.number, reason: '' }),
});
check('**理由なしでは統合できない**', r.status === 400, `status=${r.status}`);

// 統合元にコメントを残しておく。統合後も消えないことを確かめるため。
await call(`/tickets/${dup.id}/comments`, agent, {
  method: 'POST',
  body: JSON.stringify({ visibility: 'public', body: '重複のため統合します。' }),
});

r = await call(`/tickets/${dup.id}/merge`, agent, {
  method: 'POST',
  body: JSON.stringify({ targetTicketNumber: own.number, reason: '同一利用者からの二重起票' }),
});
const merged = await r.json();
check('統合できる', r.status === 200, `status=${r.status}`);
check(
  '**やり取りは統合元に残る**',
  merged.retained?.comments === 1,
  `${merged.retained?.comments} 件`,
);

r = await call(`/tickets/${dup.id}`, agent);
check('統合元が merged になる', (await r.json()).state === 'merged');

r = await call(`/tickets/${dup.id}/comments`, requester);
check('**依頼者が統合元を開いても履歴が消えていない**', (await r.json()).items.length === 1);

r = await call(`/tickets/${own.id}/relations`, agent);
check(
  '統合先から統合元を辿れる',
  (await r.json()).items.some((i) => i.ticketId === dup.id),
);

r = await call(`/tickets/${dup.id}/merge`, agent, {
  method: 'POST',
  body: JSON.stringify({ targetTicketNumber: parent.number, reason: '二重統合' }),
});
check('**統合済みをさらに統合できない**', r.status === 409, `status=${r.status}`);

// ---------------------------------------------------------------------------
// 6. 解除
// ---------------------------------------------------------------------------
r = await call(`/tickets/${parent.id}/relations`, agent);
const relationId = (await r.json()).items[0].relationId;
r = await call(`/relations/${relationId}/delete`, agent, { method: 'POST' });
check('関連を解除できる', r.status === 204, `status=${r.status}`);
r = await call(`/tickets/${parent.id}/relations`, agent);
check('解除後は一覧から消える', (await r.json()).items.length === 0);

// ---------------------------------------------------------------------------
// 7. 画面が実際に描画される
//
// **APIが通ることと画面が出ることは別である。** サーバコンポーネントの
// 取得が失敗しても、APIのテストは緑のままになる。
// ---------------------------------------------------------------------------
const page = await fetch(`${WEB}/ops/${parent.id}`, { headers: { cookie: agent } });
const html = await page.text();
check('担当者の作業画面が開く', page.status === 200, `status=${page.status}`);
check('関連の見出しが出る', html.includes('関連する問い合わせ'));
check('統合への導線がある', html.includes('/merge'));

const mergePage = await fetch(`${WEB}/ops/${parent.id}/merge`, { headers: { cookie: agent } });
const mergeHtml = await mergePage.text();
check('統合の確認画面が開く', mergePage.status === 200, `status=${mergePage.status}`);
check('**取り消せないことが書かれている**', mergeHtml.includes('元に戻せません'));
check(
  '**1画面では完結しない**(相手を確認するまで実行ボタンが出ない)',
  !mergeHtml.includes('へ統合する</button>'),
);

const confirmPage = await fetch(
  `${WEB}/ops/${parent.id}/merge?target=${encodeURIComponent(own.number)}`,
  { headers: { cookie: agent } },
);
const confirmHtml = await confirmPage.text();
check('相手を指定すると確認表が出る', confirmHtml.includes('残る(統合先)'));
check(
  '**相手の件名が表示される**(番号の打ち間違いに気付ける)',
  confirmHtml.includes('依頼者の申告'),
);

process.stdout.write(
  failed === 0
    ? '\nOK: 関連付けと統合の通し確認はすべて期待どおりです\n'
    : `\n${failed} 件の問題があります\n`,
);
process.exit(failed === 0 ? 0 : 1);
