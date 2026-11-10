/** Additive local inbox checks; no external notifications, resets or existing-user changes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password || !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('Local DB and smoke password required');
async function api(path, actor, body) {
  const r = await fetch('http://127.0.0.1:3001' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email) {
  const r = await api('/auth/login', null, { email, password });
  assert.equal(r.status, 200);
  if (!r.data.organizationId) {
    const o = r.data.organizations.find((o) => email.includes('@' + o.code + '.'));
    assert.equal((await api('/auth/organization', r, { organizationId: o.id })).status, 200);
    r.data.organizationId = o.id;
  }
  return r;
}
const staff = await login('agent@acme.example.test'),
  requester = await login('requester@acme.example.test'),
  approver = await login('approver@acme.example.test'),
  admin = await login('org_admin@acme.example.test'),
  beta = await login('agent@beta.example.test'),
  betaApprover = await login('approver@beta.example.test'),
  auditor = await login('auditor@acme.example.test');
const marker = 'INBOX-SYN-' + Date.now();
async function inbox(actor = staff, params = { q: marker }) {
  const r = await api('/inbox?' + new URLSearchParams(params), actor);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
function item(list, id, kind) {
  return list.items.find((i) => i.id === id && (!kind || i.kind === kind));
}
async function read(actor, entry, status = 200) {
  const r = await api('/inbox/read', actor, {
    kind: entry.kind,
    id: entry.id,
    eventKey: entry.eventKey,
  });
  assert.equal(r.status, status, JSON.stringify(r.data));
  return r;
}
async function ticket(title) {
  const r = await api('/tickets', requester, {
    kind: 'incident',
    subject: marker + ' ' + title,
    body: '受信箱の合成本文。一覧には含めない',
    impact: 'low',
    urgency: 'low',
  });
  assert.equal(r.status, 201);
  return r.data.id;
}
async function workspace(id) {
  return (await api('/tickets/' + id + '/workspace', staff)).data;
}
async function transition(id, to, reason) {
  const w = await workspace(id),
    r = await api('/tickets/' + id + '/transitions', staff, {
      to,
      reason,
      expectedVersion: w.ticket.version,
    });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
assert.equal((await api('/inbox', null)).status, 401);
for (const a of [requester, auditor]) assert.equal((await api('/inbox', a)).status, 403);
assert.equal((await api('/inbox?userId=' + staff.data.userId, staff)).status, 400);
const id = await ticket('担当への問い合わせ'),
  unassigned = await ticket('担当未定');
assert.equal(item(await inbox(), id), undefined);
assert(item(await inbox(staff, { q: marker, unassigned: '1' }), unassigned));
let w = await workspace(id);
assert.equal(
  (await api('/tickets/' + id + '/take', staff, { expectedVersion: w.ticket.version })).status,
  200,
);
let entry = item(await inbox(), id);
assert(entry?.unread);
assert(entry.deadline.remainingSeconds > 0);
assert.equal(entry.title, marker + ' 担当への問い合わせ');
assert.equal(entry.body, undefined);
assert.equal(JSON.stringify(entry).includes('合成本文'), false);
assert.equal((await inbox(approver)).items.length, 0);
assert.equal((await inbox(beta, { q: marker, unassigned: '1' })).items.length, 0);
await read(admin, entry, 404);
await read(beta, entry, 404);
const requestBody = { kind: entry.kind, id: entry.id, eventKey: entry.eventKey };
const reads = await Promise.all([
  api('/inbox/read', staff, requestBody),
  api('/inbox/read', staff, requestBody),
]);
for (const r of reads) assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(reads[0].data.receiptId, reads[1].data.receiptId);
assert.equal(reads.filter((r) => r.data.replayed).length, 1);
const receiptId = reads[0].data.receiptId;
assert.equal(item(await inbox(), id).unread, false);
assert.equal(item(await inbox(staff, { q: marker, unread: '1' }), id), undefined);
assert.equal((await read(staff, entry)).data.replayed, true);
assert.equal(item(await inbox(), id).eventKey, entry.eventKey);
assert.equal(
  (
    await api('/tickets/' + id + '/comments', requester, {
      visibility: 'public',
      body: '合成の追加連絡',
    })
  ).status,
  201,
);
const commented = item(await inbox(), id);
assert(commented.unread);
assert.notEqual(commented.eventKey, entry.eventKey);
await read(staff, entry, 409);
await read(staff, commented);
await transition(id, 'in_progress', 'start');
await transition(id, 'pending', 'wait_requester');
const paused = item(await inbox(), id);
assert.equal(paused.deadline.status, 'paused');
const again = item(await inbox(), id);
assert.equal(again.deadline.remainingSeconds, paused.deadline.remainingSeconds);
assert.equal(again.eventKey, paused.eventKey);
await transition(id, 'in_progress', 'resume');
w = await workspace(id);
assert.equal(
  (
    await api('/tickets/' + id + '/resolve', staff, {
      expectedVersion: w.ticket.version,
      visibility: 'public',
      body: '合成の解決',
    })
  ).status,
  200,
);
assert.equal(item(await inbox(), id), undefined);
await read(staff, paused, 404);
assert.equal(
  (await api('/tickets/' + id + '/transitions', requester, { to: 'in_progress', reason: 'reopen' }))
    .status,
  200,
);
assert(item(await inbox(), id)?.unread);
const beforeTransfer = item(await inbox(), id);
w = await workspace(id);
assert.equal(
  (
    await api('/tickets/' + id + '/assignee', staff, {
      assigneeId: admin.data.userId,
      expectedVersion: w.ticket.version,
    })
  ).status,
  200,
);
assert.equal(item(await inbox(), id), undefined);
assert(item(await inbox(admin), id));
await read(staff, beforeTransfer, 404);
w = await workspace(id);
assert.equal(
  (
    await api('/tickets/' + id + '/assignee', staff, {
      assigneeId: staff.data.userId,
      expectedVersion: w.ticket.version,
    })
  ).status,
  200,
);
// Catalog: only the current designated approver, with no request body copied.
const catalog = (await api('/catalog', requester)).data,
  ci = catalog.items[0];
const rq = await api('/service-requests', requester, {
  itemId: ci.id,
  itemVersion: ci.version,
  approverId: approver.data.userId,
  durationDays: 1,
  reason: marker + ' 本文を一覧へ複製しない',
  idempotencyKey: randomUUID(),
});
assert.equal(rq.status, 201);
const rid = rq.data.id;
const allApprovals = await inbox(approver, { kind: 'approval' }),
  reqItem = item(allApprovals, rid);
assert(reqItem);
assert.equal(reqItem.kind, 'request_approval');
assert.equal(JSON.stringify(reqItem).includes('複製しない'), false);
assert.equal(item(await inbox(staff, { kind: 'approval' }), rid), undefined);
assert.equal(item(await inbox(betaApprover, { kind: 'approval' }), rid), undefined);
await read(approver, reqItem);
assert.equal(item(await inbox(approver, { q: reqItem.number }), rid).unread, false);
assert.equal(
  (
    await api('/service-requests/' + rid + '/decisions', approver, {
      decision: 'approve',
      expectedVersion: 1,
      reason: '合成確認',
    })
  ).status,
  200,
);
assert.equal(item(await inbox(approver, { q: reqItem.number }), rid), undefined);
await read(approver, reqItem, 404);
assert.equal(
  (await api('/service-requests/' + rid + '/simulate', staff, { expectedVersion: 2 })).status,
  200,
);
assert.equal(
  item(await inbox(staff, { q: reqItem.number, unassigned: '1' }), rq.data.ticketId),
  undefined,
);
// Change: approval queue, owner waiting, completion/PIR removal, and an expired draft.
const a = await api('/assets', staff, {
  assetTag: marker + '-SAAS',
  name: '合成の受信箱対象',
  kind: 'saas',
  state: 'stocked',
  model: 'Synthetic Service',
  vendor: 'Synthetic Vendor',
  assignedUserId: null,
  reason: '合成対象登録',
});
assert.equal(a.status, 201);
const plan = {
  type: 'normal',
  title: marker + ' 変更の確認',
  ticketId: id,
  assetIds: [a.data.id],
  ownerId: staff.data.userId,
  approverId: approver.data.userId,
  purpose: '合成',
  impact: '外部変更0件',
  risk: 'low',
  implementationPlan: '合成手順',
  testPlan: '合成検証',
  backoutPlan: '合成切戻し',
  plannedStart: new Date(Date.now() - 60000).toISOString(),
  plannedEnd: new Date(Date.now() + 3600000).toISOString(),
};
const ch = await api('/changes', staff, { ...plan, creationKey: randomUUID() });
assert.equal(ch.status, 200);
const chid = ch.data.id;
async function detail() {
  return (await api('/changes/' + chid, staff)).data;
}
async function cmd(action, extra = {}, actor = staff) {
  const d = await detail(),
    review = ['approve', 'reject', 'schedule', 'start'].includes(action)
      ? { approvalId: d.change.currentApprovalId, snapshotHash: d.change.snapshotHash }
      : {};
  const r = await api('/changes/' + chid + '/' + action, actor, {
    expectedVersion: d.change.version,
    commandKey: randomUUID(),
    reason: '合成受信箱確認',
    ...review,
    ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
await cmd('submit');
const changeApproval = item(await inbox(approver, { q: marker, kind: 'approval' }), chid);
assert(changeApproval);
assert.equal(changeApproval.scopeLabel, '指名された承認者');
assert.equal((await inbox(approver, { q: marker, kind: 'change' })).total, 0);
assert(item(await inbox(), chid).waiting);
await read(approver, changeApproval);
await cmd('approve', {}, approver);
assert.equal(item(await inbox(approver, { q: marker }), chid), undefined);
await read(approver, changeApproval, 404);
await cmd('schedule', { confirmed: true });
assert.equal(item(await inbox(), chid).deadline.status, 'within');
await cmd('start', { confirmed: true });
await cmd('result', {
  outcome: 'failed',
  summary: '合成失敗',
  testResults: '仮の確認失敗',
  backoutPerformed: true,
  backoutReason: '合成切戻し',
});
const pir = item(await inbox(), chid);
assert.equal(pir.state, 'failed');
assert(pir.nextAction.includes('PIR'));
assert.equal(pir.stateLabel, '失敗記録済み・PIR待ち');
await cmd('pir', { rootCause: '合成原因', lessons: '合成教訓', prevention: '合成再発防止' });
assert.equal(item(await inbox(), chid), undefined);
await read(staff, pir, 404);
const expired = await api('/changes', staff, {
  ...plan,
  title: marker + ' 期限超過の下書き',
  plannedStart: new Date(Date.now() - 7200000).toISOString(),
  plannedEnd: new Date(Date.now() - 3600000).toISOString(),
  creationKey: randomUUID(),
});
assert.equal(expired.status, 200);
const expiredItem = item(await inbox(), expired.data.id);
assert.equal(expiredItem.deadline.status, 'overdue');
assert.equal((await inbox()).items[0].id, expired.data.id);
assert.equal(
  (
    await api('/changes/' + expired.data.id + '/cancel', staff, {
      expectedVersion: 1,
      commandKey: randomUUID(),
      reason: '合成取消',
    })
  ).status,
  200,
);
assert.equal(item(await inbox(), expired.data.id), undefined);
await read(staff, expiredItem, 404);
// Keep one synthetic future Change/approval pair for the Mac browser walkthrough.
const preview = await api('/changes', staff, {
  ...plan,
  title: marker + ' ブラウザ用の開始予定',
  plannedStart: new Date(Date.now() + 1800000).toISOString(),
  plannedEnd: new Date(Date.now() + 5400000).toISOString(),
  creationKey: randomUUID(),
});
assert.equal(preview.status, 200);
const previewId = preview.data.id;
assert.equal(
  (
    await api('/changes/' + previewId + '/submit', staff, {
      expectedVersion: 1,
      commandKey: randomUUID(),
      reason: '合成画面確認',
    })
  ).status,
  200,
);
const pendingCatalog = await api('/service-requests', requester, {
  itemId: ci.id,
  itemVersion: ci.version,
  approverId: approver.data.userId,
  durationDays: 1,
  reason: '合成ブラウザ確認だけ',
  idempotencyKey: randomUUID(),
});
assert.equal(pendingCatalog.status, 201);
const candidate = item(await inbox(), id);
assert.equal(
  (
    await api('/inbox/read', staff, {
      kind: candidate.kind,
      id: candidate.id,
      eventKey: candidate.eventKey,
      userId: approver.data.userId,
    })
  ).status,
  400,
);
assert.equal((await inbox(staff, { q: marker, page: '2' })).items.length, 0);
assert.equal((await inbox(staff, { q: '存在しない合成業務-' + marker })).total, 0);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  await c.query(
    "SELECT set_config('app.current_org',$1,true),set_config('app.inbox_user',$2,true)",
    [staff.data.organizationId, staff.data.userId],
  );
  assert.equal(
    (await c.query('SELECT * FROM work_inbox_read_receipt WHERE id=$1', [receiptId])).rowCount,
    1,
  );
  assert.equal(
    (
      await c.query("SELECT * FROM audit_event WHERE target_id=$1 AND event_type='inbox.read'", [
        receiptId,
      ])
    ).rowCount,
    1,
  );
  await c.query('ROLLBACK');
  for (const [org, user] of [
    [beta.data.organizationId, staff.data.userId],
    [staff.data.organizationId, admin.data.userId],
  ]) {
    await c.query('BEGIN');
    await c.query(
      "SELECT set_config('app.current_org',$1,true),set_config('app.inbox_user',$2,true)",
      [org, user],
    );
    assert.equal(
      (await c.query('SELECT * FROM work_inbox_read_receipt WHERE id=$1', [receiptId])).rowCount,
      0,
    );
    await c.query('ROLLBACK');
  }
  await c.query('BEGIN');
  await c.query(
    "SELECT set_config('app.current_org',$1,true),set_config('app.inbox_user',$2,true)",
    [staff.data.organizationId, staff.data.userId],
  );
  await assert.rejects(
    c.query("UPDATE work_inbox_read_receipt SET event_key='overwrite' WHERE id=$1", [receiptId]),
    (e) => e.code === '42501',
  );
  await c.query('ROLLBACK');
} finally {
  await c.end();
}
console.log(
  JSON.stringify(
    {
      ok: true,
      marker,
      ticketId: id,
      unassignedTicketId: unassigned,
      completedCatalogId: rid,
      finishedChangeId: chid,
      previewChangeId: previewId,
      previewCatalogId: pendingCatalog.data.id,
      receiptId,
      checks: [
        'own/unassigned ticket scope; approver/auditor/requester/other-organization gates',
        'stable event keys; parallel read one immutable receipt and one audit',
        'new comment unread; stale read refused; read is not completion',
        'SLA paused preserves remaining time; resolve/reopen and reassignment queue changes',
        'catalog and change current designated approval only; decision/completion removes work',
        'failed result is recorded/PIR work; PIR/cancel removes it',
        'deadline overdue and scheduled window; search/group/count/page/empty states',
        'organization AND actor RLS; receipts append-only; no body/internal notes copied',
      ],
    },
    null,
    2,
  ),
);
