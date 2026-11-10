/** Local, additive synthetic assets/tickets; never resets or deletes data. */
import assert from 'node:assert/strict';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD が必要です');
if (!['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('local DB only');
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
    const o = r.data.organizations.find((o) => email.includes(`@${o.code}.`));
    assert.equal((await api('/auth/organization', r, { organizationId: o.id })).status, 200);
    r.data.organizationId = o.id;
  }
  return r;
}
const staff = await login('agent@acme.example.test'),
  owner = await login('requester@acme.example.test'),
  other = await login('approver@acme.example.test'),
  auditor = await login('auditor@acme.example.test'),
  outsider = await login('requester@beta.example.test'),
  betaStaff = await login('agent@beta.example.test');
const marker = 'AST' + Date.now(),
  base = {
    assetTag: marker + '-PC',
    name: '合成データ: 検証用ノートPC',
    kind: 'pc',
    state: 'in_use',
    model: 'Synthetic Notebook',
    serialNumber: marker + '-SERIAL',
    hostname: marker.toLowerCase(),
    vendor: 'Synthetic vendor',
    assignedUserId: owner.data.userId,
    location: '合成の保管場所',
    internalNotes: '担当者限定の合成メモ',
    reason: '検証用の初回登録',
  };
assert.equal((await api('/assets', null)).status, 401);
assert.equal((await api('/assets', owner, base)).status, 403);
assert.equal((await api('/assets/options', owner)).status, 403);
for (const kind of ['pc', 'server', 'vm', 'network', 'mobile', 'saas'])
  assert.equal(
    (
      await api('/assets', staff, {
        ...base,
        kind,
        model: '',
        serialNumber: '',
        hostname: '',
        vendor: '',
      })
    ).status,
    400,
  );
assert.equal(
  (await api('/assets', staff, { ...base, assignedUserId: outsider.data.userId })).status,
  400,
);
assert.equal((await api('/assets', staff, { ...base, sourceKind: 'external' })).status, 400);
assert.equal((await api('/assets', staff, { ...base, assignedUserId: null })).status, 400);
const created = await api('/assets', staff, base);
assert.equal(created.status, 201, JSON.stringify(created.data));
const id = created.data.id,
  path = '/assets/' + id;
assert.equal(
  (
    await api('/assets', staff, {
      ...base,
      assetTag: base.assetTag.toLowerCase(),
      serialNumber: marker + '-different',
    })
  ).status,
  409,
);
assert.equal(
  (
    await api('/assets', staff, {
      ...base,
      assetTag: marker + '-different',
      serialNumber: base.serialNumber.toLowerCase(),
    })
  ).status,
  409,
);
const betaAsset = await api('/assets', betaStaff, {
  ...base,
  assignedUserId: outsider.data.userId,
});
assert.equal(betaAsset.status, 201);
async function detail(actor = staff) {
  const r = await api(path, actor);
  assert.equal(r.status, 200);
  return r.data;
}
let d = await detail(owner);
assert.equal(d.asset.internalNotes, undefined);
assert.equal(d.asset.location, undefined);
assert.deepEqual(d.revisions, []);
assert.equal(d.canManage, false);
assert.equal((await api(path, other)).status, 404);
assert.equal((await api(path, outsider)).status, 404);
assert.equal((await api('/assets?q=' + marker, other)).data.total, 0);
assert.equal((await api(path + '/edit', owner, { ...base, expectedVersion: 1 })).status, 403);
assert.equal((await api(path, auditor)).data.revisions.length, 1);
assert.equal((await api('/assets', auditor, base)).status, 403);
async function ticket(actor, subject) {
  const r = await api('/tickets', actor, {
    kind: 'incident',
    subject,
    body: '資産関連の合成検証のみ',
    impact: 'low',
    urgency: 'low',
  });
  assert.equal(r.status, 201);
  return r.data.id;
}
const ticketId = await ticket(owner, marker + ' 対象PCの不調'),
  otherTicket = await ticket(other, marker + ' 別の依頼者'),
  ticketPath = '/tickets/' + ticketId + '/assets';
assert.equal((await api(ticketPath, owner, { assetId: id, reason: '不正な関連' })).status, 403);
assert.equal(
  (await api(ticketPath, staff, { assetId: betaAsset.data.id, reason: '別組織' })).status,
  404,
);
assert.equal((await api(ticketPath, outsider)).status, 404);
const links = await Promise.all([
  api(ticketPath, staff, { assetId: id, reason: '対象端末' }),
  api(ticketPath, staff, { assetId: id, reason: '対象端末' }),
]);
assert.deepEqual(
  links.map((r) => r.status),
  [200, 200],
);
assert.deepEqual(links.map((r) => r.data.replayed).sort(), [false, true]);
let related = (await api(ticketPath, staff)).data;
assert.equal(related.items.length, 1);
assert.equal(related.history.length, 1);
assert.equal(related.items[0].linkVersion, 1);
assert.equal((await api(ticketPath, owner)).data.items[0].canOpen, true);
const unlinkPath = ticketPath + '/' + id + '/unlink';
assert.equal(
  (await api(unlinkPath, staff, { expectedVersion: 1, reason: '確認後に解除' })).status,
  200,
);
assert.equal(
  (await api(unlinkPath, staff, { expectedVersion: 1, reason: '再送' })).data.replayed,
  true,
);
assert.equal((await api(ticketPath, staff, { assetId: id, reason: '再調査対象' })).status, 200);
assert.equal(
  (await api(unlinkPath, staff, { expectedVersion: 1, reason: '古い解除' })).status,
  409,
);
assert.equal((await api(ticketPath, staff)).data.history.length, 3);
assert.equal(
  (await api('/tickets/' + otherTicket + '/assets', staff, { assetId: id, reason: '関連調査' }))
    .status,
  200,
);
assert.equal((await detail(owner)).tickets.length, 1);
const edit = {
  ...base,
  state: 'repair',
  assignedUserId: other.data.userId,
  reason: '修理・利用者の変更',
  expectedVersion: 1,
};
assert.equal((await api(path + '/edit', staff, edit)).status, 200);
assert.equal((await api(path, owner)).status, 404);
d = await detail(other);
assert.equal(d.asset.state, 'repair');
assert.equal(d.tickets.length, 1);
assert.equal(d.tickets[0].id, otherTicket);
assert.deepEqual(d.relationHistory, []);
related = (await api(ticketPath, owner)).data;
assert.equal(related.items[0].canOpen, false);
assert.equal(related.items[0].serialNumber, undefined);
assert.equal(related.items[0].assignedUserName, undefined);
assert.deepEqual(related.history, []);
const race = await Promise.all([
  api(path + '/edit', staff, { ...edit, name: '合成の名前訂正', expectedVersion: 2 }),
  api(path + '/edit', staff, { ...edit, name: '合成の名前訂正', expectedVersion: 2 }),
]);
assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
d = await detail();
assert.equal(d.asset.version, 3);
assert.equal(d.revisions.find((v) => v.version === 1).snapshot.assignedUserId, owner.data.userId);
assert.equal(
  (
    await api(path + '/edit', staff, {
      ...edit,
      state: 'retired',
      assignedUserId: null,
      reason: '検証用の廃止',
      expectedVersion: 3,
    })
  ).status,
  200,
);
assert.equal(
  (await api(path + '/edit', staff, { ...base, reason: '再稼働を試す', expectedVersion: 4 }))
    .status,
  409,
);
const thirdTicket = await ticket(owner, marker + ' 廃止後の新規関係拒否');
assert.equal(
  (await api('/tickets/' + thirdTicket + '/assets', staff, { assetId: id, reason: '廃止対象' }))
    .status,
  409,
);
assert.equal((await api(ticketPath, owner)).data.items[0].state, 'retired');
d = await detail();
assert.equal(d.tickets.length, 2);
assert.equal(d.revisions.length, 4);
assert.equal((await api(path, other)).status, 404);
for (const kind of ['server', 'vm', 'network', 'mobile', 'saas']) {
  const r = await api('/assets', staff, {
    ...base,
    assetTag: marker + '-' + kind,
    kind,
    state: 'stocked',
    assignedUserId: null,
    serialNumber: ['vm', 'saas'].includes(kind) ? '' : marker + '-' + kind + '-SERIAL',
  });
  assert.equal(r.status, 201);
}
const list = (await api('/assets?q=' + marker, staff)).data;
assert.equal(list.total, 6);
assert.equal(list.items.length, 6);
assert.equal((await api('/assets?q=' + marker + '&page=2', staff)).data.items.length, 0);
assert.equal((await api('/assets?q=' + marker + '&kind=mobile', staff)).data.total, 1);
assert.equal((await api('/assets?q=' + marker + '&state=retired', staff)).data.total, 1);
assert.equal((await api('/assets?q=' + marker + '&assignment=unassigned', staff)).data.total, 6);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [outsider.data.organizationId]);
  for (const table of ['asset', 'asset_revision', 'asset_ticket_link', 'asset_ticket_event']) {
    const key = table === 'asset' ? 'id' : 'asset_id';
    assert.equal((await c.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [id])).rowCount, 0);
  }
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [staff.data.organizationId]);
  assert.equal(
    (
      await c.query(
        "SELECT event_type FROM audit_event WHERE target_id=$1 AND event_type LIKE 'asset.%'",
        [id],
      )
    ).rowCount,
    8,
  );
  await c.query('ROLLBACK');
  for (const table of ['asset_revision', 'asset_ticket_event']) {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_org',$1,true)", [staff.data.organizationId]);
    await assert.rejects(
      c.query(`UPDATE ${table} SET reason='overwrite' WHERE asset_id=$1`, [id]),
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
      assetId: id,
      ticketId,
      otherTicketId: otherTicket,
      checks: [
        'six asset kinds and required attributes',
        'organization-scoped case-insensitive tag/serial uniqueness',
        'active same-organization assignment',
        'staff writes; auditor read-only; requester current owner only',
        'internal fields/history and other tickets excluded from requester',
        'concurrent update conflict and immutable prior assignment',
        'concurrent linking one event; unlink/relink history; stale unlink refused',
        'retirement clears assignment and retains assets and ticket relations',
        'search/type/state/assignment filters and page offset',
        'API organization boundaries and RLS on all four tables',
        'same-transaction audit; app cannot overwrite history',
      ],
    },
    null,
    2,
  ),
);
