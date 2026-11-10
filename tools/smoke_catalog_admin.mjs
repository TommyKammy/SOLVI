/** Additive local catalog authoring/approval walkthrough. No existing-user changes or external calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('Local database and smoke password required');
async function api(path, actor, body, status = 200) {
  const r = await fetch('http://127.0.0.1:3001' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  assert.equal(r.status, status, JSON.stringify({ path, data }));
  return { data, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function login(email) {
  const a = await api('/auth/login', null, { email, password });
  if (!a.data.organizationId) {
    const org = a.data.organizations.find((o) => email.includes('@' + o.code + '.'));
    await api('/auth/organization', a, { organizationId: org.id });
    a.data.organizationId = org.id;
  }
  return a;
}
const admin = await login('org_admin@acme.example.test'),
  staff = await login('agent@acme.example.test'),
  requester = await login('requester@acme.example.test'),
  approver = await login('approver@acme.example.test'),
  beta = await login('org_admin@beta.example.test'),
  betaApprover = await login('approver@beta.example.test'),
  auditor = await login('auditor@acme.example.test');
const marker = 'CAT-ADMIN-SYN-' + Date.now();
const def = {
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象だけ',
  allowedDurations: [1, 7, 30],
  maxReasonLength: 2000,
  approval: { mode: 'fixed', approverId: approver.data.userId },
  fields: [
    { key: 'team', type: 'text', label: '利用部署', required: true, maxLength: 80 },
    {
      key: 'purpose',
      type: 'select',
      label: '利用目的',
      required: true,
      options: ['障害検証', '運用改善'],
    },
    { key: 'notes', type: 'textarea', label: '補足事項', required: false, maxLength: 500 },
    { key: 'confirm', type: 'checkbox', label: '合成申請であることを確認', required: true },
  ],
};
const body = {
  code: 'synth-' + Date.now(),
  title: marker + ' 合成申請',
  description: '外部変更を伴わない型付きフォーム確認',
  definition: def,
  creationKey: randomUUID(),
};
for (const a of [requester, staff, approver, auditor]) await api('/catalog-admin', a, null, 403);
await api('/catalog-admin', null, null, 401);
for (const bad of [requester.data.userId, betaApprover.data.userId, randomUUID()])
  await api(
    '/catalog-admin',
    admin,
    {
      ...body,
      creationKey: randomUUID(),
      definition: { ...def, approval: { mode: 'fixed', approverId: bad } },
    },
    400,
  );
await api(
  '/catalog-admin',
  admin,
  { ...body, creationKey: randomUUID(), definition: { ...def, action: 'real.group.grant' } },
  400,
);
await api(
  '/catalog-admin',
  admin,
  {
    ...body,
    creationKey: randomUUID(),
    definition: { ...def, fields: [def.fields[0], def.fields[0]] },
  },
  400,
);
const creates = await Promise.all([
  api('/catalog-admin', admin, body),
  api('/catalog-admin', admin, body),
]);
assert.equal(creates[0].data.id, creates[1].data.id);
assert.equal(creates.filter((r) => r.data.replayed).length, 1);
const id = creates[0].data.id;
await api(
  '/catalog-admin',
  admin,
  {
    ...body,
    definition: { ...def, approval: { mode: 'fixed', approverId: betaApprover.data.userId } },
  },
  409,
);
const detail = async () => (await api('/catalog-admin/' + id, admin)).data;
const portal = async () => (await api('/catalog', requester)).data.items.find((i) => i.id === id);
assert.equal(await portal(), undefined);
await api('/catalog-admin/' + id, beta, null, 404);
const submit = {
  itemId: id,
  itemVersion: 1,
  idempotencyKey: randomUUID(),
  reason: '合成の業務確認',
  durationDays: 7,
  approverId: approver.data.userId,
  values: { team: '合成IT部', purpose: '障害検証', notes: '保存する任意の長文', confirm: true },
};
await api('/service-requests', requester, submit, 404);
await api('/catalog-admin/' + id + '/publication', admin, {
  expectedVersion: 1,
  state: 'published',
});
assert.equal((await portal()).version, 1);
for (const [values, status] of [
  [{}, 400],
  [{ ...submit.values, purpose: '定義外の候補' }, 400],
  [{ ...submit.values, team: true }, 400],
  [{ ...submit.values, team: 'x'.repeat(81) }, 400],
  [{ ...submit.values, confirm: false }, 400],
  [{ ...submit.values, undeclared: 'x' }, 400],
])
  await api(
    '/service-requests',
    requester,
    { ...submit, idempotencyKey: randomUUID(), values },
    status,
  );
await api(
  '/service-requests',
  requester,
  { ...submit, idempotencyKey: randomUUID(), approverId: betaApprover.data.userId },
  403,
);
await api('/service-requests', approver, { ...submit, idempotencyKey: randomUUID() }, 403);
await api('/service-requests', beta, { ...submit, idempotencyKey: randomUUID() }, 404);
const request = (await api('/service-requests', requester, submit, 201)).data,
  requestId = request.id;
const qdetail = async () => (await api('/service-requests/' + requestId, requester)).data;
const original = await qdetail();
assert.deepEqual(original.request.snapshot.inputs.values, submit.values);
assert.equal(original.request.snapshot.item.version, 1);
const def2 = {
  ...def,
  allowedDurations: [30],
  maxReasonLength: 60,
  fields: [
    { ...def.fields[0], label: '改訂された部署名' },
    { ...def.fields[1], options: ['新候補', '別候補'] },
    def.fields[2],
    def.fields[3],
    {
      key: 'new_required',
      type: 'text',
      label: '新規受付だけの項目',
      required: true,
      maxLength: 60,
    },
  ],
};
const d = await detail();
assert.equal(d.editVersion, 2);
await api('/catalog-admin/' + id + '/save', admin, {
  title: marker + ' 改訂版',
  description: body.description,
  definition: def2,
  expectedVersion: 2,
});
await api(
  '/catalog-admin/' + id + '/save',
  admin,
  { title: '古い画面', description: body.description, definition: def2, expectedVersion: 2 },
  409,
);
assert.equal((await portal()).version, 1);
assert.equal((await detail()).draft.revision, 2);
await api('/catalog-admin/' + id + '/publication', admin, {
  expectedVersion: 3,
  state: 'published',
});
assert.equal((await portal()).version, 2);
await api('/service-requests', requester, { ...submit, idempotencyKey: randomUUID() }, 409);
let unchanged = await qdetail();
assert.deepEqual(unchanged.request, original.request);
assert.equal(unchanged.approval.id, original.approval.id);
await api('/catalog-admin/' + id + '/publication', admin, {
  expectedVersion: 4,
  state: 'unpublished',
});
assert.equal(await portal(), undefined);
await api(
  '/service-requests',
  requester,
  { ...submit, itemVersion: 2, idempotencyKey: randomUUID() },
  404,
);
assert.deepEqual((await qdetail()).request, original.request);
await api(
  '/service-requests/' + requestId + '/edit',
  requester,
  {
    reason: '合成の旧定義を継続',
    durationDays: 7,
    approverId: approver.data.userId,
    values: { ...submit.values, new_required: '旧版に追加不可' },
    expectedVersion: 1,
  },
  400,
);
await api(
  '/service-requests/' + requestId + '/edit',
  requester,
  {
    reason: '合成の旧定義を継続',
    durationDays: 7,
    approverId: betaApprover.data.userId,
    values: submit.values,
    expectedVersion: 1,
  },
  403,
);
await api('/service-requests/' + requestId + '/edit', requester, {
  reason: 'x'.repeat(70),
  durationDays: 7,
  approverId: approver.data.userId,
  values: submit.values,
  expectedVersion: 1,
});
const revised = await qdetail();
assert.equal(revised.request.snapshot.item.version, 1);
assert.equal(revised.request.revision, 2);
assert.equal(revised.history[0].state, 'invalidated');
assert.equal(revised.history[0].item.definition.fields[0].label, '利用部署');
await api('/service-requests/' + requestId + '/decisions', approver, {
  expectedVersion: 2,
  decision: 'approve',
  reason: '保存した旧定義と追加値を確認',
});
const results = await Promise.all([
  api('/service-requests/' + requestId + '/simulate', staff, { expectedVersion: 3 }),
  api('/service-requests/' + requestId + '/simulate', staff, { expectedVersion: 3 }),
]);
assert.equal(results[0].data.receipt.id, results[1].data.receipt.id);
const completed = await qdetail();
assert.equal(completed.request.state, 'completed');
assert.equal(completed.receipt.result.externalChanges, 0);
assert.equal(completed.receipt.snapshotHash, completed.request.snapshotHash);
const ticket = (await api('/tickets/' + request.ticketId + '/workspace', staff)).data;
assert.equal(ticket.ticket.state, 'resolved');
assert.equal((await api('/service-requests', requester, submit, 200)).data.id, requestId);
await api(
  '/service-requests',
  requester,
  { ...submit, values: { ...submit.values, notes: '別入力' } },
  409,
);
await api('/catalog-admin/' + id + '/publication', admin, {
  expectedVersion: 5,
  state: 'published',
});
const previewRequest = (
  await api(
    '/service-requests',
    requester,
    {
      ...submit,
      itemVersion: 2,
      idempotencyKey: randomUUID(),
      durationDays: 30,
      values: { ...submit.values, purpose: '新候補', new_required: '公開版2の合成入力' },
    },
    201,
  )
).data;
const preview = (await api('/service-requests/' + previewRequest.id, requester)).data;
assert.equal(preview.request.snapshot.item.version, 2);
assert.equal(preview.request.snapshot.item.definition.fields[0].label, '改訂された部署名');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [admin.data.organizationId]);
  assert.equal(
    (await c.query('SELECT * FROM local_catalog_revision WHERE item_id=$1', [id])).rowCount,
    2,
  );
  assert.equal(
    (
      await c.query("SELECT * FROM audit_event WHERE target_id=$1 AND event_type='catalog.saved'", [
        id,
      ])
    ).rowCount,
    2,
  );
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [beta.data.organizationId]);
  assert.equal(
    (await c.query('SELECT * FROM local_catalog_revision WHERE item_id=$1', [id])).rowCount,
    0,
  );
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [admin.data.organizationId]);
  await assert.rejects(
    c.query("UPDATE local_catalog_revision SET title='changed' WHERE item_id=$1", [id]),
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
      itemId: id,
      completedRequestId: requestId,
      completedTicketId: request.ticketId,
      previewRequestId: previewRequest.id,
      receiptId: completed.receipt.id,
      checks: [
        'admin role/org and publication boundaries',
        'ineligible candidate: no approver role, outside organization and unknown account refused',
        'typed required values, choices, limits, unknown keys, fixed approver substitution and self approval refused',
        'draft edits keep published projection; publish/unpublish retain original request/hash/approval',
        'old snapshot edits use original definition and invalidate previous approval',
        'independent approval -> concurrent simulation receipt -> resolved ticket/external changes zero',
        'new version applies to new request only; creation/request replay and stale edits',
        'revision RLS/immutability and audit counts',
      ],
    },
    null,
    2,
  ),
);
