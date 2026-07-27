#!/usr/bin/env node
/**
 * 添付の通し確認 (WP-P2-SCAN-011)
 *
 * 依頼者がファイルを添付し、スキャンを経て担当者が開くまでを実スタックで確かめる。
 * **EICAR を実際にアップロードし、開けないことを確認する**のが要点である。
 *
 * スキャンは**稼働中の worker に実際にやらせる**。テスト用のハーネスを
 * その場で組み立てると、確かめているのは配線ではなくハーネスになる。
 * worker は30秒ごとに走るため、状態が変わるまで待つ。
 */
const API = 'http://127.0.0.1:3001';
const ORG = '00000000-0000-4000-9000-000000000001';
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
  '',
);

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
const call = (p, cookie, init = {}) =>
  fetch(`${API}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
  });

const requester = await login('requester@acme.example.test');
const agent = await login('agent@acme.example.test');

// チケットを作る
let r = await call('/tickets', requester, {
  method: 'POST',
  body: JSON.stringify({
    kind: 'incident',
    subject: '添付テスト',
    body: '画面の写真を送ります。',
    impact: 'low',
    urgency: 'low',
  }),
});
const ticket = await r.json();
check('チケットを作成', r.status === 201, `status=${r.status}`);

/** アップロードURLを取得して実体を送る */
async function upload(
  cookie,
  fileName,
  content,
  contentType = 'text/plain',
  visibility = 'public',
) {
  const req = await call(`/tickets/${ticket.id}/attachments`, cookie, {
    method: 'POST',
    body: JSON.stringify({
      fileName,
      contentType,
      sizeBytes: Buffer.byteLength(content),
      visibility,
    }),
  });
  if (!req.ok) return { ok: false, status: req.status, problem: await req.json() };
  const { attachmentId, uploadUrl } = await req.json();
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: content,
    headers: { 'content-type': contentType },
  });
  return { ok: put.ok, attachmentId, putStatus: put.status };
}

// 1. 正常なファイル
const normal = await upload(requester, 'screenshot.txt', 'これは画面の説明です。');
check('依頼者がファイルを添付できる', normal.ok, `PUT=${normal.putStatus}`);

// 2. EICAR
const evil = await upload(requester, 'invoice.txt', EICAR);
check('EICAR もアップロード自体は通る(検疫は後段)', evil.ok, `PUT=${evil.putStatus}`);

// 3. 実行可能な拡張子は拒否される
const exe = await upload(requester, 'setup.exe', 'MZ', 'application/octet-stream');
check('**実行できる形式は受け付けない**', !exe.ok && exe.status === 400, `status=${exe.status}`);

// 4. スキャン前は開けない
r = await call(`/tickets/${ticket.id}/attachments`, requester);
let list = await r.json();
check(
  'スキャン前は downloadable=false',
  list.items.every((a) => a.downloadable === false),
);
r = await call(`/attachments/${normal.attachmentId}/download`, requester);
check('**スキャン前はダウンロードURLが出ない**', !r.ok, `status=${r.status}`);

// 5. worker がスキャンするのを待つ
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 対象の添付がすべて pending を脱するまで待つ。 */
async function waitForScan(cookie, ids, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await call(`/tickets/${ticket.id}/attachments`, cookie);
    const body = await res.json();
    const targets = body.items.filter((a) => ids.includes(a.id));
    if (targets.length === ids.length && targets.every((a) => a.scanStatus !== 'pending')) {
      return targets;
    }
    await wait(5000);
  }
  return null;
}

const scanned = await waitForScan(requester, [normal.attachmentId, evil.attachmentId]);
check(
  '**worker が実際にスキャンする**',
  scanned !== null,
  scanned ? scanned.map((a) => `${a.fileName}=${a.scanStatus}`).join(' ') : 'タイムアウト',
);
if (scanned) {
  check(
    '**EICAR が infected になる**',
    scanned.find((a) => a.id === evil.attachmentId)?.scanStatus === 'infected',
  );
}

// 6. スキャン後
r = await call(`/tickets/${ticket.id}/attachments`, requester);
list = await r.json();
const clean = list.items.find((a) => a.id === normal.attachmentId);
const infected = list.items.find((a) => a.id === evil.attachmentId);
check(
  '正常なファイルが開けるようになる',
  clean?.downloadable === true,
  `scanStatus=${clean?.scanStatus}`,
);
check(
  '**感染ファイルは開けないまま**',
  infected?.downloadable === false,
  `scanStatus=${infected?.scanStatus}`,
);

r = await call(`/attachments/${normal.attachmentId}/download`, requester);
check('正常なファイルのダウンロードURLが出る', r.ok, `status=${r.status}`);
if (r.ok) {
  const { url } = await r.json();
  const got = await fetch(url);
  check('**署名付きURLで実際に取得できる**', got.ok, `status=${got.status}`);
  check(
    '添付として扱われる',
    (got.headers.get('content-disposition') ?? '').includes('attachment'),
  );
}

r = await call(`/attachments/${evil.attachmentId}/download`, requester);
check('**感染ファイルのURLは出ない**', !r.ok, `status=${r.status}`);

// 7. 内部添付は依頼者に見えない
const internal = await upload(
  agent,
  'internal-note.txt',
  '担当者だけのメモ',
  'text/plain',
  'internal',
);
check('担当者が内部添付を追加できる', internal.ok);

r = await call(`/tickets/${ticket.id}/attachments`, requester);
const forRequester = await r.json();
check(
  '**内部添付が依頼者に見えない**',
  !forRequester.items.some((a) => a.id === internal.attachmentId),
  `${forRequester.items.length} 件`,
);

r = await call(`/tickets/${ticket.id}/attachments`, agent);
const forAgent = await r.json();
check(
  '担当者には内部添付が見える',
  forAgent.items.some((a) => a.id === internal.attachmentId),
);

// 依頼者は内部添付を追加できない
const badVis = await upload(requester, 'try.txt', 'x', 'text/plain', 'internal');
check('**依頼者は内部添付を追加できない**', !badVis.ok, `status=${badVis.status}`);

process.stdout.write(
  failed === 0
    ? '\nOK: 添付の通し確認はすべて期待どおりです\n'
    : `\n${failed} 件の問題があります\n`,
);
process.exit(failed === 0 ? 0 : 1);
