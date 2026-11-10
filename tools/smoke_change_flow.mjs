/** Local additive synthetic Change flow. No resets, existing-user mutation or external execution. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password || !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('Local DB and SOLVI_SMOKE_PASSWORD required');
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
  auditor = await login('auditor@acme.example.test'),
  beta = await login('agent@beta.example.test');
const marker = 'CHG-SYN-' + Date.now();
const t = await api('/tickets', requester, {
  kind: 'incident',
  subject: marker + ' 合成変更の起点',
  body: '外部操作なし・合成検証のみ',
  impact: 'low',
  urgency: 'low',
});
assert.equal(t.status, 201);
const assetBody = {
  assetTag: marker + '-SAAS',
  name: '合成の変更対象サービス',
  kind: 'saas',
  state: 'stocked',
  model: 'Synthetic Service',
  vendor: 'Synthetic vendor',
  serialNumber: '',
  hostname: '',
  assignedUserId: null,
  location: '合成',
  internalNotes: '非公開の合成メモ',
  reason: '合成登録',
};
const asset = await api('/assets', staff, assetBody),
  other = await api('/assets', beta, assetBody);
assert.equal(asset.status, 201);
assert.equal(other.status, 201);
let plan = {
  type: 'normal',
  title: marker + ' 合成計画',
  ticketId: t.data.id,
  assetIds: [asset.data.id],
  ownerId: staff.data.userId,
  approverId: approver.data.userId,
  purpose: '合成監視の見直し',
  impact: '合成資産のみ・外部変更0件',
  risk: 'low',
  implementationPlan: '仮の実施順を記録',
  testPlan: '仮の通知と復旧を検証',
  backoutPlan: '仮の旧設定へ戻す',
  plannedStart: new Date(Date.now() - 60000).toISOString(),
  plannedEnd: new Date(Date.now() + 3600000).toISOString(),
};
const createBody = { ...plan, creationKey: randomUUID() };
const created = await Promise.all([
  api('/changes', staff, createBody),
  api('/changes', staff, createBody),
]);
for (const r of created) assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(created[0].data.id, created[1].data.id);
assert.equal(created.filter((r) => r.data.replayed).length, 1);
const id = created[0].data.id,
  path = '/changes/' + id;
assert.equal((await api('/changes', staff, { ...createBody, title: '異なる入力' })).status, 409);
assert.equal((await api('/changes', requester, createBody)).status, 403);
assert.equal((await api('/changes', null)).status, 401);
assert.equal((await api('/changes', requester)).status, 403);
for (const actor of [requester, approver, beta]) assert.equal((await api(path, actor)).status, 404);
assert.equal(
  (await api('/changes', staff, { ...plan, assetIds: [other.data.id], creationKey: randomUUID() }))
    .status,
  404,
);
assert.equal(
  (
    await api('/changes', staff, {
      ...plan,
      approverId: staff.data.userId,
      creationKey: randomUUID(),
    })
  ).status,
  403,
);
async function detail(actor = staff, changeId = id) {
  const r = await api('/changes/' + changeId, actor);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
let d = await detail();
function commandBody(extra = {}, value = d) {
  return {
    expectedVersion: value.change.version,
    commandKey: randomUUID(),
    reason: '合成検証',
    ...extra,
  };
}
function reviewBody(value = d) {
  return { approvalId: value.change.currentApprovalId, snapshotHash: value.change.snapshotHash };
}
async function command(action, body, actor = staff, status = 200, changeId = id) {
  const r = await api('/changes/' + changeId + '/' + action, actor, body);
  assert.equal(r.status, status, JSON.stringify({ action, ...r }));
  if (status === 200 && changeId === id) d = await detail();
  return r;
}
await command('edit', commandBody({ ...plan, backoutPlan: '' }));
await command('submit', commandBody(), staff, 400);
await command('edit', commandBody(plan));
await command('submit', commandBody());
const ap = await detail(approver);
assert.equal(ap.ticketCanOpen, false);
assert.equal(ap.assetAccess[0].canOpen, false);
assert.equal(ap.change.snapshot.assets[0].internalNotes, undefined);
await command('approve', commandBody(reviewBody()), staff, 403);
await command('reject', commandBody({ ...reviewBody(), reason: '' }), approver, 400);
await command(
  'approve',
  commandBody({ ...reviewBody(), snapshotHash: '0'.repeat(64) }),
  approver,
  409,
);
await command(
  'reject',
  commandBody({ ...reviewBody(), reason: '合成のテスト計画を改善' }),
  approver,
);
assert.equal(d.change.state, 'rejected');
await command('edit', commandBody({ ...plan, testPlan: '通知と復旧の両方を合成で確認' }));
await command('submit', commandBody());
await command('approve', commandBody(reviewBody()), approver);
const replacement = await api('/assets', staff, {
  ...assetBody,
  assetTag: marker + '-REPLACEMENT',
  reason: '合成の別対象',
});
assert.equal(replacement.status, 201);
const obsolete = reviewBody();
await command('edit', commandBody({ ...plan, impact: '影響を再確認した合成計画' }));
assert.equal(d.change.currentApprovalId, null);
assert.equal(d.change.state, 'draft');
assert.equal((await api(path, approver)).status, 404);
assert.equal(d.approvals.filter((a) => a.decision === 'approved').length, 1);
await command('schedule', commandBody({ ...obsolete, confirmed: true }), staff, 422);
await command('edit', commandBody({ ...plan, assetIds: [replacement.data.id] }));
assert(
  !(await api('/assets/' + asset.data.id + '/changes', staff)).data.items.some((c) => c.id === id),
);
assert(
  (await api('/assets/' + replacement.data.id + '/changes', staff)).data.items.some(
    (c) => c.id === id,
  ),
);
await command('edit', commandBody(plan));
assert(d.revisions.some((v) => v.snapshot.assets[0].id === replacement.data.id));
await command('submit', commandBody());
await command('approve', commandBody(reviewBody()), approver);
assert.equal(
  (
    await api('/assets/' + asset.data.id + '/edit', staff, {
      ...assetBody,
      state: 'repair',
      reason: '承認後に合成台帳を更新',
      expectedVersion: 1,
    })
  ).status,
  200,
);
await command('schedule', commandBody({ ...reviewBody(), confirmed: true }), staff, 409);
d = await detail();
assert(d.readiness.issues.some((s) => s.includes('対象資産')));
await command('edit', commandBody(plan));
assert.equal(d.change.snapshot.assets[0].version, 2);
await command('submit', commandBody());
await command('approve', commandBody(reviewBody()), approver);
await command('schedule', commandBody({ ...reviewBody(), confirmed: false }), staff, 400);
const scheduled = await command('schedule', commandBody({ ...reviewBody(), confirmed: true }));
assert.equal(scheduled.data.state, 'scheduled');
// Same asset, overlapping approved plan requires the current conflict list to be acknowledged.
const overlap = await api('/changes', staff, {
  ...plan,
  title: marker + ' 重複する合成予定',
  creationKey: randomUUID(),
});
assert.equal(overlap.status, 200);
const oid = overlap.data.id;
let od = await detail(staff, oid);
await command('submit', commandBody({}, od), staff, 200, oid);
od = await detail(staff, oid);
await command('approve', commandBody(reviewBody(od), od), approver, 200, oid);
od = await detail(staff, oid);
assert.equal(od.conflicts[0].id, id);
await command(
  'schedule',
  commandBody({ ...reviewBody(od), confirmed: true, conflictIds: [] }, od),
  staff,
  409,
  oid,
);
await command(
  'schedule',
  commandBody({ ...reviewBody(od), confirmed: true, conflictIds: [id] }, od),
  staff,
  200,
  oid,
);
od = await detail(staff, oid);
await command('cancel', commandBody({}, od), staff, 200, oid);
// Future window cannot be started early. No clocks or existing users are altered.
const future = await api('/changes', staff, {
  ...plan,
  title: marker + ' 将来の合成予定',
  plannedStart: new Date(Date.now() + 7200000).toISOString(),
  plannedEnd: new Date(Date.now() + 10800000).toISOString(),
  creationKey: randomUUID(),
});
assert.equal(future.status, 200);
const fid = future.data.id;
let fd = await detail(staff, fid);
await command('submit', commandBody({}, fd), staff, 200, fid);
fd = await detail(staff, fid);
await command('approve', commandBody(reviewBody(fd), fd), approver, 200, fid);
fd = await detail(staff, fid);
await command('schedule', commandBody({ ...reviewBody(fd), confirmed: true }, fd), staff, 200, fid);
fd = await detail(staff, fid);
await command('start', commandBody({ ...reviewBody(fd), confirmed: true }, fd), staff, 409, fid);
await command('cancel', commandBody({}, fd), staff, 200, fid);
const startBody = commandBody({ ...reviewBody(), confirmed: true });
const starts = await Promise.all([
  api(path + '/start', staff, startBody),
  api(path + '/start', staff, startBody),
]);
for (const r of starts) assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(starts.filter((r) => r.data.replayed).length, 1);
d = await detail();
assert.equal(d.change.state, 'in_progress');
await command('edit', commandBody(plan), staff, 422);
await command('start', { ...startBody, commandKey: randomUUID() }, staff, 409);
// Drift after start must not prevent recording the outcome of the approved snapshot.
assert.equal(
  (
    await api('/assets/' + asset.data.id + '/edit', staff, {
      ...assetBody,
      state: 'stocked',
      reason: '開始後の合成台帳更新',
      expectedVersion: 2,
    })
  ).status,
  200,
);
const resultBody = commandBody({
  outcome: 'failed',
  summary: '合成例: 検証で問題を発見',
  testResults: '仮の復旧通知が出なかった',
  backoutPerformed: true,
  backoutReason: '旧設定へ戻したものとして記録',
});
const results = await Promise.all([
  api(path + '/result', staff, resultBody),
  api(path + '/result', staff, resultBody),
]);
for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(results[0].data.resultId, results[1].data.resultId);
assert.equal(results.filter((r) => r.data.replayed).length, 1);
d = await detail();
assert.equal(d.result.simulation, true);
assert.equal(d.result.externalChanges, 0);
assert.equal(d.result.snapshotHash, d.change.snapshotHash);
assert.equal(d.result.revision, d.change.revision);
assert.equal(d.result.outcome, 'failed');
await command('result', { ...resultBody, summary: '別の結果' }, staff, 409);
assert((await api('/changes?needsPir=1&q=' + marker, staff)).data.items.some((c) => c.id === id));
assert(
  (await api('/tickets/' + t.data.id + '/changes', staff)).data.items.some((c) => c.id === id),
);
assert(
  (await api('/assets/' + asset.data.id + '/changes', staff)).data.items.some((c) => c.id === id),
);
assert.equal((await api('/assets/' + asset.data.id + '/changes', beta)).status, 404);
assert.equal((await api('/changes?q=' + marker, beta)).data.total, 0);
assert.equal((await api(path, auditor)).status, 200);
await command(
  'pir',
  commandBody({
    rootCause: '合成の監視条件不足',
    lessons: '復旧の通知まで事前確認',
    prevention: '仮の確認項目を追加',
  }),
  auditor,
  403,
);
const pirBody = commandBody({
  rootCause: '合成の監視条件不足',
  lessons: '復旧の通知まで事前確認',
  prevention: '仮の確認項目を追加',
});
const pirs = await Promise.all([
  api(path + '/pir', staff, pirBody),
  api(path + '/pir', staff, pirBody),
]);
for (const r of pirs) assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(pirs[0].data.pirId, pirs[1].data.pirId);
assert.equal(pirs.filter((r) => r.data.replayed).length, 1);
d = await detail();
assert.equal(d.change.state, 'failed');
assert(d.pir);
assert.equal((await api('/changes?needsPir=1&q=' + marker, staff)).data.total, 0);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const tables = [
  'local_change',
  'local_change_revision',
  'local_change_asset',
  'local_change_approval',
  'local_change_decision',
  'local_change_event',
  'local_change_result',
  'local_change_pir',
];
let eventCount;
try {
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [beta.data.organizationId]);
  for (const table of tables) assert.equal((await c.query('SELECT * FROM ' + table)).rowCount, 0);
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [staff.data.organizationId]);
  eventCount = (await c.query('SELECT * FROM local_change_event WHERE change_id=$1', [id]))
    .rowCount;
  assert.equal(eventCount, d.change.version);
  assert.equal(
    (
      await c.query("SELECT * FROM audit_event WHERE target_id=$1 AND event_type LIKE 'change.%'", [
        id,
      ])
    ).rowCount,
    eventCount,
  );
  for (const table of ['local_change_result', 'local_change_pir'])
    assert.equal(
      (await c.query('SELECT * FROM ' + table + ' WHERE change_id=$1', [id])).rowCount,
      1,
    );
  await c.query('ROLLBACK');
  for (const table of tables.filter((t) => !['local_change', 'local_change_asset'].includes(t))) {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_org',$1,true)", [staff.data.organizationId]);
    await assert.rejects(
      c.query('UPDATE ' + table + ' SET organization_id=organization_id'),
      (e) => e.code === '42501',
    );
    await c.query('ROLLBACK');
  }
} finally {
  await c.end();
}
console.log(
  JSON.stringify(
    {
      ok: true,
      marker,
      changeId: id,
      changeNumber: d.change.number,
      ticketId: t.data.id,
      assetId: asset.data.id,
      overlapChangeId: oid,
      futureChangeId: fid,
      version: d.change.version,
      revision: d.change.revision,
      eventCount,
      approvals: d.approvals.length,
      externalChanges: d.result.externalChanges,
      checks: [
        'draft/incomplete submission/rejection/edit/reapproval',
        'self approval and reviewed hash refused',
        'content/target revision invalidates old approval; inactive links and old target history retained',
        'asset drift before start refused; repin and reapproval',
        'overlap recheck and explicit acknowledged IDs; future window refused',
        'parallel create/start/result/PIR replay once; conflicting payload/version refused',
        'post-start asset drift allows frozen synthetic result',
        'failed/PIR queue and ticket/asset links',
        'requester/auditor/approver scopes; other organization API and all eight RLS tables',
        'immutable histories; one audit per event; one result and PIR',
      ],
    },
    null,
    2,
  ),
);
