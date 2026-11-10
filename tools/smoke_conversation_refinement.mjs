/** New synthetic localhost tickets only. No resets/deletes/external operations. */
import assert from 'node:assert/strict';
const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
async function api(path, actor, body, scope) {
  const r = await fetch('http://127.0.0.1:3001' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(actor ? { cookie: actor.cookie } : {}),
      ...(scope ? { 'x-solvi-form-scope': scope } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: r.status,
    data: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email, orgCode) {
  const a = await api('/auth/login', null, { email, password });
  assert.equal(a.status, 200);
  if (!a.data.organizationId) {
    const org = a.data.organizations.find((o) => o.code === orgCode);
    assert.equal((await api('/auth/organization', a, { organizationId: org.id })).status, 200);
    a.data.organizationId = org.id;
  }
  a.scope = `${a.data.organizationId}:${a.data.userId}`;
  return a;
}
const staff = await login('agent@acme.example.test', 'acme');
const owner = await login('requester@acme.example.test', 'acme');
const outsider = await login('requester@beta.example.test', 'beta');
const marker = 'CONV-SYN-' + Date.now();
const created = await api(
  '/tickets',
  owner,
  {
    kind: 'incident',
    subject: marker + ' 会話保護',
    body: '合成の会話競合確認。実障害なし。',
    impact: 'low',
    urgency: 'low',
  },
  owner.scope,
);
assert.equal(created.status, 201);
const path = '/tickets/' + created.data.id;
const workspace = async () => {
  const r = await api(path + '/workspace', staff);
  assert.equal(r.status, 200);
  return r.data;
};
const conversation = async (actor = staff) => {
  const r = await api(path + '/comments', actor);
  assert.equal(r.status, 200);
  return r.data;
};
const post = (actor, body, context, visibility = 'public', scope = actor.scope) =>
  api(path + '/comments', actor, { body, visibility, replyContext: context }, scope);
let w = await workspace();
assert.equal((await api(path + '/take', staff, { expectedVersion: w.ticket.version })).status, 200);
w = await workspace();
assert.equal(
  (
    await api(path + '/transitions', staff, {
      to: 'in_progress',
      reason: 'start',
      expectedVersion: w.ticket.version,
    })
  ).status,
  200,
);
w = await workspace();
const stateBefore = w.replyContext;
assert.equal(
  (
    await api(path + '/assessment', staff, {
      impact: 'low',
      urgency: 'medium',
      reason: '合成の版更新',
      expectedVersion: w.ticket.version,
    })
  ).status,
  200,
);
assert.equal((await post(staff, '古い状態の公開返信は保存されない', stateBefore)).status, 409);
assert.equal(
  (await post(staff, '古い状態の内部メモは保存されない', stateBefore, 'internal')).status,
  409,
);
assert.equal((await conversation()).items.length, 0);
const ownerBefore = await conversation(owner);
assert.equal(
  (
    await post(
      staff,
      '合成内部のみ・状態版を更新しない',
      (await conversation()).replyContext,
      'internal',
    )
  ).status,
  201,
);
const ownerAfter = await conversation(owner);
assert.deepEqual(ownerAfter.replyContext, ownerBefore.replyContext);
assert.equal(ownerAfter.items.length, 0);
assert.equal((await post(owner, '合成本人の補足', ownerAfter.replyContext)).status, 201);
const current = await conversation();
const race = await Promise.all([
  post(staff, '合成の並行返信A', current.replyContext),
  post(staff, '合成の並行返信B', current.replyContext),
]);
assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
assert.equal((await conversation()).items.length, 3);
const staleResolve = await api(
  path + '/resolve',
  staff,
  {
    body: '古い会話では解決しない',
    visibility: 'public',
    expectedVersion: current.replyContext.ticketVersion,
    replyContext: current.replyContext,
  },
  staff.scope,
);
assert.equal(staleResolve.status, 409);
assert.equal((await workspace()).ticket.state, 'in_progress');
const beforeWrongScope = await conversation();
assert.equal(
  (
    await post(
      staff,
      '別利用者の期待値では保存しない',
      beforeWrongScope.replyContext,
      'public',
      owner.scope,
    )
  ).status,
  409,
);
assert.equal((await api(path + '/comments', outsider)).status, 404);
assert.equal((await conversation()).items.length, 3);
let listed = await api('/tickets?keyword=' + marker, staff);
assert.equal(listed.status, 200);
assert.ok(listed.data.items[0].assigneeName);
assert.ok(listed.data.items[0].requesterName);
const ownerListed = await api('/tickets?keyword=' + marker, owner);
assert.equal(ownerListed.data.items[0].assigneeName, undefined);
assert.equal(ownerListed.data.items[0].requesterName, undefined);
w = await workspace();
assert.equal(
  (
    await api(path + '/transitions', staff, {
      to: 'pending',
      reason: 'wait_requester',
      expectedVersion: w.ticket.version,
    })
  ).status,
  200,
);
listed = await api('/tickets?keyword=' + marker, staff);
assert.equal(listed.data.items[0].pendingReason, 'wait_requester');
assert.equal(
  (await post(owner, '合成本人の最新補足で対応再開', (await conversation(owner)).replyContext))
    .status,
  201,
);
w = await workspace();
assert.equal(w.ticket.state, 'in_progress');
assert.equal(
  (
    await api(
      path + '/resolve',
      staff,
      {
        body: '合成の明示解決',
        visibility: 'public',
        expectedVersion: w.ticket.version,
        replyContext: w.replyContext,
      },
      staff.scope,
    )
  ).status,
  200,
);
assert.equal((await workspace()).ticket.state, 'resolved');
console.log(
  JSON.stringify(
    {
      ok: true,
      ticketId: created.data.id,
      number: created.data.number,
      staleStateRejected: true,
      staleConversationRejected: true,
      concurrentPostsAccepted: 1,
      requesterContextHidesInternal: true,
      scopeMismatchRejected: true,
      staffNamesOnly: true,
      requesterResumptionPreserved: true,
      freshResolveSaved: true,
    },
    null,
    2,
  ),
);
