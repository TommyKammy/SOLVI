/** Local additive synthetic records only. No resets, credential changes or external actions. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD is required');
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('Local database only');
async function api(path, actor, body, status = 200) {
  const response = await fetch('http://127.0.0.1:3001' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login(email) {
  const actor = await api('/auth/login', null, { email, password });
  if (!actor.data.organizationId) {
    const org = actor.data.organizations.find((o) => email.includes(`@${o.code}.`));
    await api('/auth/organization', actor, { organizationId: org.id });
    actor.data.organizationId = org.id;
  }
  return actor;
}
const owner = await login('requester@acme.example.test');
const agent = await login('agent@acme.example.test');
const approver = await login('approver@acme.example.test');
const outsider = await login('requester@beta.example.test');
const ticket = (
  await api(
    '/tickets',
    owner,
    {
      kind: 'incident',
      subject: 'REFINE-SYN 返信による対応再開',
      body: '合成データ: 接続タイムアウトの日常対応確認',
      impact: 'low',
      urgency: 'low',
    },
    201,
  )
).data;
const path = '/tickets/' + ticket.id;
async function workspace() {
  return (await api(path + '/workspace', agent)).data;
}
async function transition(to, reason) {
  return api(path + '/transitions', agent, { to, reason });
}
await api(path + '/take', agent, { expectedVersion: (await workspace()).ticket.version });
await transition('in_progress', 'start');
await transition('pending', 'wait_requester');
await api(
  path + '/comments',
  agent,
  { visibility: 'internal', body: 'REFINE-SYN 内部だけの確認事項' },
  201,
);
assert.equal((await workspace()).ticket.state, 'pending');
await api(
  path + '/comments',
  agent,
  { visibility: 'public', body: 'REFINE-SYN エラーを教えてください' },
  201,
);
assert.equal((await workspace()).ticket.state, 'pending');
await api(path + '/comments', outsider, { visibility: 'public', body: 'REFINE-SYN 他組織' }, 404);
await api(path + '/transitions', owner, { to: 'in_progress', reason: 'resume' }, 404);
await Promise.all([
  api(path + '/comments', owner, { visibility: 'public', body: 'REFINE-SYN 本人返信1' }, 201),
  api(path + '/comments', owner, { visibility: 'public', body: 'REFINE-SYN 本人返信2' }, 201),
]);
assert.equal((await workspace()).ticket.state, 'in_progress');
assert.equal((await workspace()).ticket.pendingReason, null);
const visible = (await api(path + '/comments', owner)).data.items;
assert.equal(
  visible.some((c) => c.visibility === 'internal'),
  false,
);
assert.equal(visible.filter((c) => c.authorIsRequester).length, 2);
await transition('pending', 'wait_external');
await api(
  path + '/comments',
  owner,
  { visibility: 'public', body: 'REFINE-SYN 外部待ちへの補足' },
  201,
);
assert.equal((await workspace()).ticket.state, 'pending');
assert.equal((await workspace()).ticket.pendingReason, 'wait_external');
await transition('in_progress', 'resume');
await api(path + '/resolve', agent, {
  body: 'REFINE-SYN 合成確認は完了しました',
  expectedVersion: (await workspace()).ticket.version,
});
await api(
  path + '/comments',
  owner,
  { visibility: 'public', body: 'REFINE-SYN 解決後の補足' },
  201,
);
assert.equal((await workspace()).ticket.state, 'resolved');

const catalog = (await api('/catalog', owner)).data;
const item = catalog.items.find(
  (candidate) =>
    !candidate.definition.fields?.length && candidate.definition.allowedDurations.includes(7),
);
assert.ok(item, 'Existing simple local simulation catalog required');
const approverId = catalog.approvers.find((candidate) => candidate.id === approver.data.userId)?.id;
assert.ok(approverId, 'Existing local approver required');
const inputs = {
  itemId: item.id,
  itemVersion: item.version,
  reason: 'REFINE-SYN 一覧から判断・再申請',
  durationDays: 7,
  approverId,
  idempotencyKey: randomUUID(),
};
const request = (await api('/service-requests', owner, inputs, 201)).data;
const requestPath = '/service-requests/' + request.id;
const number = (await api('/tickets/' + request.ticketId, owner)).data.number;
const search = '&q=' + encodeURIComponent(number);
assert.equal((await api('/service-requests?view=mine' + search, owner)).data.total, 1);
let list = (await api('/service-requests?view=approvals' + search, approver)).data;
assert.equal(list.total, 1);
assert.equal(list.items[0].id, request.id);
assert.equal(
  (await api('/service-requests?q=' + encodeURIComponent(number), outsider)).data.total,
  0,
);
await api('/service-requests?view=unexpected', owner, undefined, 400);
await api(requestPath + '/decisions', approver, {
  decision: 'reject',
  reason: 'REFINE-SYN 利用目的の補足が必要です',
  expectedVersion: 1,
});
list = (await api('/service-requests?state=rejected' + search, owner)).data;
assert.equal(list.items[0].decisionReason, 'REFINE-SYN 利用目的の補足が必要です');
assert.match(list.items[0].nextAction, /修正/);
assert.equal((await api('/service-requests?view=approvals' + search, approver)).data.total, 0);
await api(requestPath + '/simulate', agent, { expectedVersion: 2 }, 409);
await api(requestPath + '/edit', owner, {
  reason: 'REFINE-SYN 理由を補足して再申請',
  durationDays: 7,
  approverId,
  expectedVersion: 2,
});
assert.equal((await api('/service-requests?view=approvals' + search, approver)).data.total, 1);
list = (await api('/service-requests?page=2' + search, owner)).data;
assert.equal(list.total, 1);
assert.equal(list.items.length, 0);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN READ ONLY');
  await db.query("SELECT set_config('app.current_org',$1,true)", [owner.data.organizationId]);
  const persisted = (
    await db.query('SELECT state, pending_reason, sla_clock_started_at FROM ticket WHERE id=$1', [
      ticket.id,
    ])
  ).rows[0];
  assert.equal(persisted.state, 'resolved');
  assert.equal(persisted.pending_reason, null);
  assert.equal(persisted.sla_clock_started_at, null);
  const events = (
    await db.query(
      "SELECT actor_id FROM audit_event WHERE target_id=$1 AND event_type='ticket.transitioned' AND action='resume'",
      [ticket.id],
    )
  ).rows;
  assert.equal(events.filter((e) => e.actor_id === owner.data.userId).length, 1);
  assert.equal(events.filter((e) => e.actor_id === agent.data.userId).length, 1);
  await db.query('ROLLBACK');
} finally {
  await db.end();
}
console.log(
  JSON.stringify(
    {
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      requestId: request.id,
      requestNumber: number,
      checks: [
        'requester wait resumes once with concurrent replies',
        'staff/internal/external/resolved do not auto-resume',
        'direct requester transition still forbidden',
        'internal comment stays private',
        'requester author classification',
        'org isolation and filters',
        'reject/edit returns to approver worklist',
        'pagination total',
        'persisted state and audit',
      ],
      retainedSyntheticRecords: true,
      externalChanges: 0,
    },
    null,
    2,
  ),
);
