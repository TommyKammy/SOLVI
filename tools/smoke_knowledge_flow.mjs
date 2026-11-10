/** Non-destructive local knowledge lifecycle and boundary checks. */
import assert from 'node:assert/strict';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD が必要です');
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('local DB only');
async function request(path, cookie, body) {
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
  const r = await request('/auth/login', null, { email, password });
  assert.equal(r.status, 200);
  if (!r.data.organizationId) {
    const o = r.data.organizations.find((o) => email.includes(`@${o.code}.`));
    assert.equal(
      (await request('/auth/organization', r.cookie, { organizationId: o.id })).status,
      200,
    );
    r.data.organizationId = o.id;
  }
  return r;
}
const agent = await login('agent@acme.example.test'),
  admin = await login('org_admin@acme.example.test'),
  requester = await login('requester@acme.example.test'),
  outsider = await login('requester@beta.example.test');
const marker = 'KB' + Date.now();
const content = {
  title: `VPN の接続を確認する ${marker}`,
  body: '1. ネットワークを確認する\n2. VPN を再接続する\n3. 解消しない場合はサポートへ連絡する',
  tags: 'VPN 接続 ネットワーク',
  audience: 'organization',
};
assert.equal((await request('/knowledge', requester.cookie, content)).status, 403);
const created = await request('/knowledge', agent.cookie, content);
assert.equal(created.status, 201);
const id = created.data.id;
let version = 1;
const path = '/knowledge/' + id;
assert.equal((await request(path, requester.cookie)).status, 404);
assert.equal((await request(path + '?manage=1', outsider.cookie)).status, 403);
assert.equal((await request(path, outsider.cookie)).status, 404);
assert.equal((await request(path + '?manage=1', requester.cookie)).status, 403);
assert.equal((await request('/knowledge?q=' + marker, requester.cookie)).data.items.length, 0);
assert.equal(
  (await request(path + '/actions', admin.cookie, { action: 'publish', expectedVersion: version }))
    .status,
  409,
);
async function action(action, extra = {}) {
  const r = await request(path + '/actions', admin.cookie, {
    action,
    expectedVersion: version,
    ...extra,
  });
  assert.equal(r.status, 200);
  version = r.data.version;
  return r;
}
await action('review');
assert.equal(
  (await request(path + '/actions', agent.cookie, { action: 'publish', expectedVersion: version }))
    .status,
  403,
);
await action('publish');
const published = version;
assert.equal((await request(path, requester.cookie)).data.article.body, content.body);
assert.equal((await request('/knowledge?q=' + marker, requester.cookie)).data.items.length, 1);
const revised = {
  ...content,
  title: `非公開の編集中 ${marker}`,
  body: 'まだ公開していない変更',
  expectedVersion: version,
};
const saved = await request(path + '/save', agent.cookie, revised);
assert.equal(saved.status, 200);
version = saved.data.version;
const publicView = (await request(path, requester.cookie)).data.article;
assert.equal(publicView.body, content.body);
assert.equal(publicView.version, published);
assert.equal(publicView.state, 'published');
assert.equal(
  (
    await request('/knowledge?q=' + encodeURIComponent('非公開の編集中'), requester.cookie)
  ).data.items.some((a) => a.id === id),
  false,
);
assert.equal(
  (await request(path + '/actions', admin.cookie, { action: 'publish', expectedVersion: version }))
    .status,
  409,
);
const race = await Promise.all([
  request(path + '/save', agent.cookie, { ...content, expectedVersion: version }),
  request(path + '/save', agent.cookie, { ...content, expectedVersion: version }),
]);
assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
version = race.find((r) => r.status === 200).data.version;
await action('review');
await action('publish');
await action('retire');
assert.equal((await request(path, requester.cookie)).status, 404);
await action('restore', { restoreVersion: 1 });
assert.equal((await request(path, requester.cookie)).status, 404);
assert.equal((await request(path + '?manage=1', agent.cookie)).data.article.body, content.body);
await action('review');
await action('publish');
assert.equal((await request(path, requester.cookie)).status, 200);
const staff = await request('/knowledge', agent.cookie, {
  ...content,
  title: '担当者用 ' + marker,
  audience: 'staff',
});
assert.equal(staff.status, 201);
let sv = (
  await request('/knowledge/' + staff.data.id + '/actions', admin.cookie, {
    action: 'review',
    expectedVersion: 1,
  })
).data.version;
assert.equal(
  (
    await request('/knowledge/' + staff.data.id + '/actions', admin.cookie, {
      action: 'publish',
      expectedVersion: sv,
    })
  ).status,
  200,
);
assert.equal((await request('/knowledge/' + staff.data.id, requester.cookie)).status, 404);
assert.equal((await request('/knowledge/' + staff.data.id, agent.cookie)).status, 200);
assert.equal((await request('/knowledge?q=' + marker, requester.cookie)).data.items.length, 1);
assert.equal((await request('/knowledge?q=' + marker, outsider.cookie)).data.items.length, 0);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org',$1,true)", [
    outsider.data.organizationId,
  ]);
  assert.equal(
    (await client.query('SELECT id FROM knowledge_article WHERE id=$1', [id])).rowCount,
    0,
  );
  await client.query('ROLLBACK');
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org',$1,true)", [agent.data.organizationId]);
  const versions = await client.query(
    'SELECT number,title,body FROM knowledge_version WHERE article_id=$1 ORDER BY number',
    [id],
  );
  assert.equal(versions.rows[0].body, content.body);
  assert.equal(versions.rows.length, version);
  const audit = await client.query(
    "SELECT event_type FROM audit_event WHERE target_id=$1 AND event_type LIKE 'article.%'",
    [id],
  );
  assert.equal(audit.rowCount, version);
  let refused = false;
  try {
    await client.query(
      "UPDATE knowledge_version SET body='unauthorized overwrite' WHERE article_id=$1 AND number=1",
      [id],
    );
  } catch (e) {
    assert.equal(e.code, '42501');
    refused = true;
  }
  assert.ok(refused);
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
console.log(
  JSON.stringify(
    {
      ok: true,
      articleId: id,
      staffArticleId: staff.data.id,
      versions: version,
      checks: [
        'draft/review/publish/retire/restore',
        'admin publication only',
        'published snapshot retained during edit',
        'no draft metadata leak',
        'stale concurrent save 409',
        'retired restore stays private until republish',
        'staff audience requester 404',
        'other organization search zero + detail404 + DB RLS zero',
        'immutable versions + same-transaction audit',
      ],
    },
    null,
    2,
  ),
);
