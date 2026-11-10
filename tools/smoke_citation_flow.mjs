import assert from 'node:assert/strict';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD が必要です');
async function api(path, cookie, body) {
  const r = await fetch('http://127.0.0.1:3001' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
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
    assert.equal((await api('/auth/organization', r.cookie, { organizationId: o.id })).status, 200);
  }
  return r.cookie;
}
const requester = await login('requester@acme.example.test'),
  agent = await login('agent@acme.example.test'),
  admin = await login('org_admin@acme.example.test'),
  outsider = await login('requester@beta.example.test');
const content = {
  title: '引用検証: VPN の確認手順',
  body: '引用時の元の本文。再接続して状態を確認してください。',
  tags: 'VPN',
  audience: 'organization',
};
async function article(c) {
  const r = await api('/knowledge', agent, c);
  assert.equal(r.status, 201);
  let v = (
    await api(`/knowledge/${r.data.id}/actions`, admin, { action: 'review', expectedVersion: 1 })
  ).data.version;
  v = (
    await api(`/knowledge/${r.data.id}/actions`, admin, { action: 'publish', expectedVersion: v })
  ).data.version;
  return { id: r.data.id, version: v };
}
const a = await article(content),
  staff = await article({ ...content, audience: 'staff' });
const t = await api('/tickets', requester, {
  kind: 'incident',
  subject: '引用検証: VPN 接続',
  body: '合成データのみです。',
  impact: 'low',
  urgency: 'low',
});
assert.equal(t.status, 201);
const id = t.data.id;
let w = (await api(`/tickets/${id}/workspace`, agent)).data;
await api(`/tickets/${id}/take`, agent, { expectedVersion: w.ticket.version });
w = (await api(`/tickets/${id}/workspace`, agent)).data;
assert.equal(
  (
    await api(`/tickets/${id}/transitions`, agent, {
      to: 'in_progress',
      reason: 'start',
      expectedVersion: w.ticket.version,
    })
  ).status,
  200,
);
w = (await api(`/tickets/${id}/workspace`, agent)).data;
const reply = {
  body: 'この記事の手順で確認してください。',
  visibility: 'public',
  citation: { articleId: a.id, version: a.version },
};
assert.equal(
  (
    await api(`/tickets/${id}/resolve`, agent, {
      ...reply,
      expectedVersion: w.ticket.version,
      citation: { articleId: a.id, version: 1 },
    })
  ).status,
  409,
);
assert.equal((await api(`/tickets/${id}`, requester)).data.state, 'in_progress');
assert.equal((await api(`/tickets/${id}/comments`, requester)).data.items.length, 0);
assert.equal((await api(`/tickets/${id}/comments`, requester, reply)).status, 403);
assert.equal(
  (
    await api(`/tickets/${id}/comments`, agent, {
      ...reply,
      citation: { articleId: staff.id, version: staff.version },
    })
  ).status,
  403,
);
const internal = await api(`/tickets/${id}/comments`, agent, {
  ...reply,
  visibility: 'internal',
  citation: { articleId: staff.id, version: staff.version },
});
assert.equal(internal.status, 201);
assert.equal(
  (await api(`/tickets/${id}/comments/${internal.data.id}/citation`, requester)).status,
  404,
);
w = (await api(`/tickets/${id}/workspace`, agent)).data;
const resolved = await api(`/tickets/${id}/resolve`, agent, {
  ...reply,
  expectedVersion: w.ticket.version,
});
assert.equal(resolved.status, 200);
const comment = resolved.data.comment;
assert.equal(comment.citation.version, a.version);
const citationPath = `/tickets/${id}/comments/${comment.id}/citation`;
assert.equal((await api(citationPath, requester)).data.body, content.body);
assert.equal((await api(citationPath, outsider)).status, 404);
assert.equal(
  (
    await api(
      `/tickets/00000000-0000-4000-9000-000000000001/comments/${comment.id}/citation`,
      agent,
    )
  ).status,
  404,
);
let v = (
  await api(`/knowledge/${a.id}/save`, agent, {
    ...content,
    body: '改訂した新しい本文',
    expectedVersion: a.version,
  })
).data.version;
v = (await api(`/knowledge/${a.id}/actions`, admin, { action: 'review', expectedVersion: v })).data
  .version;
v = (await api(`/knowledge/${a.id}/actions`, admin, { action: 'publish', expectedVersion: v })).data
  .version;
assert.equal((await api(citationPath, requester)).data.body, content.body);
assert.equal((await api(citationPath, requester)).data.version, a.version);
assert.equal((await api(`/tickets/${id}/comments`, agent, reply)).status, 409);
assert.equal(
  (await api(`/knowledge/${a.id}/actions`, admin, { action: 'retire', expectedVersion: v })).status,
  200,
);
assert.equal((await api(citationPath, requester)).status, 404);
assert.equal((await api(citationPath, agent)).data.body, content.body);
const list = (await api(`/tickets/${id}/comments`, requester)).data.items;
assert.equal(list.length, 1);
assert.equal(list[0].citation.available, false);
assert.equal(list[0].citation.title, null);
assert.equal(list[0].citation.version, a.version);
assert.equal(
  (
    await api(`/tickets/${id}/comments`, agent, {
      ...reply,
      citation: { articleId: a.id, version: v },
    })
  ).status,
  404,
);
console.log(
  JSON.stringify(
    {
      ok: true,
      ticketId: id,
      commentId: comment.id,
      articleId: a.id,
      citedVersion: a.version,
      checks: [
        'quote and resolution atomic',
        'invalid quote rolls back resolution and comment',
        'immutable old content after article republication',
        'old/retired publication refused for new citation',
        'staff article refused in public reply',
        'internal note hidden',
        'requester cannot create citation',
        'cross organization and wrong ticket 404',
        'retirement hides public citation title/body but retains ID/version',
      ],
    },
    null,
    2,
  ),
);
