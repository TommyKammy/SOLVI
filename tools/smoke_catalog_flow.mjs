/** Additive local fixtures only; never reset or delete data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD が必要です');
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))
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
const owner = await login('requester@acme.example.test'),
  approver = await login('approver@acme.example.test'),
  agent = await login('agent@acme.example.test'),
  admin = await login('org_admin@acme.example.test'),
  outsider = await login('requester@beta.example.test');
const catalog = (await api('/catalog', owner)).data,
  item = catalog.items[0],
  approverId = catalog.approvers[0].id;
assert.equal((await api('/catalog', null)).status, 401);
const base = {
  itemId: item.id,
  itemVersion: item.version,
  reason: '合成データ: ローカル承認フロー確認',
  durationDays: 7,
  approverId,
  idempotencyKey: randomUUID(),
};
assert.equal((await api('/service-requests', owner, { ...base, durationDays: 99 })).status, 400);
assert.equal(
  (await api('/service-requests', owner, { ...base, approverId: owner.data.userId })).status,
  403,
);
assert.equal((await api('/service-requests', outsider, base)).status, 404);
const concurrent = await Promise.all([
  api('/service-requests', owner, base),
  api('/service-requests', owner, base),
]);
assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 201]);
assert.equal(concurrent[0].data.id, concurrent[1].data.id);
const id = concurrent[0].data.id,
  ticketId = concurrent[0].data.ticketId,
  path = '/service-requests/' + id;
assert.equal((await api('/service-requests', owner, { ...base, reason: '別の内容' })).status, 409);
async function detail(actor = owner) {
  const r = await api(path, actor);
  assert.equal(r.status, 200);
  return r.data;
}
async function command(suffix, actor, body, status = 200) {
  const r = await api(path + suffix, actor, body);
  assert.equal(r.status, status, JSON.stringify(r.data));
  return r;
}
assert.equal((await api(path, outsider)).status, 404);
assert.equal(
  (await api('/service-requests', outsider)).data.items.some((r) => r.id === id),
  false,
);
await command(
  '/edit',
  agent,
  { reason: '別の人の変更', durationDays: 1, approverId, expectedVersion: 1 },
  404,
);
await command('/decisions', owner, { decision: 'approve', expectedVersion: 1 }, 403);
await command('/decisions', admin, { decision: 'approve', expectedVersion: 1 }, 403);
await command('/simulate', owner, { expectedVersion: 1 }, 403);
await command('/simulate', agent, { expectedVersion: 1 }, 409);
await command('/decisions', approver, { decision: 'reject', expectedVersion: 1 }, 400);
await command('/decisions', approver, {
  decision: 'reject',
  reason: '理由を具体化してください',
  expectedVersion: 1,
});
assert.equal((await detail()).approval.reason, '理由を具体化してください');
await command('/simulate', agent, { expectedVersion: 2 }, 409);
await command('/edit', owner, {
  reason: '修正済みの利用理由',
  durationDays: 7,
  approverId,
  expectedVersion: 2,
});
await command('/decisions', approver, { decision: 'approve', expectedVersion: 2 }, 409);
await command('/decisions', approver, { decision: 'approve', expectedVersion: 3 });
await command('/edit', owner, {
  reason: '承認後に期間を変更',
  durationDays: 30,
  approverId,
  expectedVersion: 4,
});
let d = await detail();
assert.equal(d.request.revision, 3);
assert.deepEqual(
  d.history.map((h) => h.state),
  ['rejected', 'invalidated', 'pending'],
);
await command('/simulate', agent, { expectedVersion: 5 }, 409);
await command('/decisions', approver, { decision: 'approve', expectedVersion: 5 });
await command('/decisions', approver, {
  decision: 'revoke',
  expectedVersion: 6,
  reason: '計画変更',
});
await command('/simulate', agent, { expectedVersion: 7 }, 409);
await command('/edit', owner, {
  reason: '取り消し後の再申請',
  durationDays: 1,
  approverId,
  expectedVersion: 7,
});
await command('/decisions', approver, { decision: 'approve', expectedVersion: 8 });
const executions = await Promise.all([
  api(path + '/simulate', agent, { expectedVersion: 9 }),
  api(path + '/simulate', agent, { expectedVersion: 9 }),
]);
assert.deepEqual(
  executions.map((r) => r.status),
  [200, 200],
);
assert.equal(executions[0].data.receipt.id, executions[1].data.receipt.id);
assert.deepEqual(executions.map((r) => r.data.replayed).sort(), [false, true]);
d = await detail();
assert.equal(d.request.state, 'completed');
assert.equal(d.receipt.result.externalChanges, 0);
assert.equal(d.receipt.result.durationDays, 1);
assert.equal((await api('/tickets/' + ticketId, owner)).data.state, 'resolved');
const comments = (await api('/tickets/' + ticketId + '/comments', owner)).data.items;
assert.equal(comments.filter((c) => c.body.includes(d.receipt.id)).length, 1);
await command(
  '/edit',
  owner,
  { reason: '完了後変更', durationDays: 1, approverId, expectedVersion: 10 },
  409,
);
assert.equal(
  (await command('/simulate', agent, { expectedVersion: 9 })).data.receipt.id,
  d.receipt.id,
);
assert.equal((await api('/service-requests', owner, base)).data.id, id);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [outsider.data.organizationId]);
  assert.equal(
    (await c.query('SELECT id FROM local_service_request WHERE id=$1', [id])).rowCount,
    0,
  );
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.current_org',$1,true)", [owner.data.organizationId]);
  assert.equal(
    (await c.query('SELECT id FROM local_simulation_receipt WHERE request_id=$1', [id])).rowCount,
    1,
  );
  assert.equal(
    (await c.query('SELECT revision FROM local_request_revision WHERE request_id=$1', [id]))
      .rowCount,
    4,
  );
  const events = (
    await c.query(
      "SELECT event_type FROM audit_event WHERE target_id=$1 AND event_type LIKE 'request.%'",
      [id],
    )
  ).rows;
  assert.equal(events.length, 10);
  await c.query('ROLLBACK');
  // Isolated synthetic fixtures simulate persisted corruption/expiry, never real users.
  for (const fault of ['expired', 'hash']) {
    const fresh = await api('/service-requests', owner, { ...base, idempotencyKey: randomUUID() });
    assert.equal(fresh.status, 201);
    const fixturePath = '/service-requests/' + fresh.data.id;
    assert.equal(
      (await api(fixturePath + '/decisions', approver, { decision: 'approve', expectedVersion: 1 }))
        .status,
      200,
    );
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_org',$1,true)", [owner.data.organizationId]);
    if (fault === 'expired')
      await c.query(
        "UPDATE local_request_approval SET expires_at=clock_timestamp()-interval '1 minute' WHERE request_id=$1",
        [fresh.data.id],
      );
    else
      await c.query(
        "UPDATE local_service_request SET snapshot=jsonb_set(snapshot,'{inputs,reason}','\"injected synthetic mismatch\"'::jsonb) WHERE id=$1",
        [fresh.data.id],
      );
    await c.query('COMMIT');
    assert.equal((await api(fixturePath + '/simulate', agent, { expectedVersion: 2 })).status, 409);
    const refused = (await api(fixturePath, owner)).data;
    assert.equal(refused.receipt, null);
    assert.equal(
      (await api('/tickets/' + fresh.data.ticketId + '/comments', owner)).data.items.length,
      0,
    );
  }
  for (const table of ['local_request_revision', 'local_simulation_receipt']) {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_org',$1,true)", [owner.data.organizationId]);
    await assert.rejects(
      c.query(`UPDATE ${table} SET snapshot_hash=repeat('0',64) WHERE request_id=$1`, [id]),
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
      requestId: id,
      ticketId,
      receiptId: d.receipt.id,
      checks: [
        'same-key concurrent submission creates one request',
        'validation, self-approval and role boundaries',
        'cross-organization API and DB RLS',
        'rejection reason and retry',
        'content change invalidates approval; stale version conflict',
        'approval revocation, expiry and hash mismatch block execution',
        'concurrent execution returns one immutable receipt and one comment',
        'completion resolves ticket and refuses edits',
        'revision history and audit persisted; app cannot update history/receipt',
      ],
    },
    null,
    2,
  ),
);
