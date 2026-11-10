/** 非破壊のローカル確認。合成チケット2件を追加し、削除しない。 */
import assert from 'node:assert/strict';
import pg from 'pg';

const base = process.env.SOLVI_SMOKE_API ?? 'http://127.0.0.1:3001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw new Error('ローカル API のみ指定できます');
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password)
  throw new Error('SOLVI_SMOKE_PASSWORD に既存 seed の開発用パスワードを指定してください');
async function request(path, cookie, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email) {
  const result = await request('/auth/login', null, { email, password });
  assert.equal(result.status, 200);
  if (!result.data.organizationId) {
    const organization = result.data.organizations.find((o) => email.includes(`@${o.code}.`));
    assert.ok(organization);
    assert.equal(
      (await request('/auth/organization', result.cookie, { organizationId: organization.id }))
        .status,
      200,
    );
    result.data.organizationId = organization.id;
  }
  return result;
}
const requester = await login('requester@acme.example.test');
const agent = await login('agent@acme.example.test');
const outsider = await login('requester@beta.example.test');
const fixture = {
  kind: 'incident',
  subject: 'ローカル検証: VPN に接続できない',
  body: '合成データ。再接続すると認証エラーになります。',
  impact: 'low',
  urgency: 'high',
};
const created = await request('/tickets', requester.cookie, fixture);
assert.equal(created.status, 201);
const id = created.data.id;
await request('/tickets', requester.cookie, {
  ...fixture,
  kind: 'request',
  subject: 'ローカル検証: モニターの手配',
  urgency: 'low',
});
let workspace = (await request(`/tickets/${id}/workspace`, agent.cookie)).data;
assert.equal(
  (
    await request(`/tickets/${id}/take`, agent.cookie, {
      expectedVersion: workspace.ticket.version,
    })
  ).status,
  200,
);
workspace = (await request(`/tickets/${id}/workspace`, agent.cookie)).data;
assert.equal(workspace.ticket.state, 'assigned');
assert.equal(workspace.ticket.assigneeId, agent.data.userId);
assert.equal(
  (
    await request(`/tickets/${id}/transitions`, agent.cookie, {
      to: 'in_progress',
      reason: 'start',
      expectedVersion: workspace.ticket.version,
    })
  ).status,
  200,
);
workspace = (await request(`/tickets/${id}/workspace`, agent.cookie)).data;
const resolveBody = {
  body: 'VPN 設定を修正しました。再接続できるか確認してください。',
  visibility: 'public',
  expectedVersion: workspace.ticket.version,
};
assert.equal((await request(`/tickets/${id}/resolve`, outsider.cookie, resolveBody)).status, 404);
assert.equal((await request(`/tickets/${id}/resolve`, requester.cookie, resolveBody)).status, 404);
assert.equal(
  (
    await request(`/tickets/${id}/resolve`, agent.cookie, {
      ...resolveBody,
      visibility: 'internal',
    })
  ).status,
  400,
);
assert.equal(
  (await request(`/tickets/${id}/resolve`, agent.cookie, { ...resolveBody, body: '   ' })).status,
  400,
);
assert.equal(
  (await request(`/tickets/${id}/resolve`, agent.cookie, { ...resolveBody, expectedVersion: '' }))
    .status,
  400,
);
assert.equal((await request(`/tickets/${id}`, agent.cookie)).data.state, 'in_progress');
const concurrent = await Promise.all([
  request(`/tickets/${id}/resolve`, agent.cookie, resolveBody),
  request(`/tickets/${id}/resolve`, agent.cookie, resolveBody),
]);
assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
assert.equal((await request(`/tickets/${id}`, requester.cookie)).data.state, 'resolved');
let comments = (await request(`/tickets/${id}/comments`, requester.cookie)).data.items;
assert.equal(comments.length, 1);
assert.equal(comments[0].body, resolveBody.body);
await request(`/tickets/${id}/comments`, agent.cookie, {
  visibility: 'internal',
  body: '内部の調査メモ（合成データ）',
});
assert.equal((await request(`/tickets/${id}/comments`, requester.cookie)).data.items.length, 1);
assert.equal((await request(`/tickets/${id}/comments`, agent.cookie)).data.items.length, 2);
assert.equal(
  (
    await request(`/tickets/${id}/transitions`, requester.cookie, {
      to: 'in_progress',
      reason: 'reopen',
    })
  ).status,
  200,
);
assert.equal((await request(`/tickets/${id}`, requester.cookie)).data.state, 'in_progress');
const first = (await request('/tickets?limit=1', requester.cookie)).data;
assert.ok(first.nextCursor);
const query = new URLSearchParams({
  limit: '1',
  cursorCreatedAt: first.nextCursor.createdAt,
  cursorId: first.nextCursor.id,
});
const second = (await request(`/tickets?${query}`, requester.cookie)).data;
assert.notEqual(first.items[0].id, second.items[0].id);
assert.equal(first.total, second.total);
// 別の DB 接続から永続化と監査・Outbox の記録を読む。更新は行わない。
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT set_config($1, $2, true)', ['app.current_org', agent.data.organizationId]);
  const stored = await db.query('SELECT state, first_responded_at FROM ticket WHERE id = $1', [id]);
  assert.equal(stored.rows[0].state, 'in_progress');
  assert.ok(stored.rows[0].first_responded_at);
  const audit = await db.query(
    "SELECT count(*)::int AS n FROM audit_event WHERE target_id = $1 AND event_type = 'ticket.comment.added'",
    [id],
  );
  assert.equal(audit.rows[0].n, 2);
  await db.query('ROLLBACK');
} finally {
  await db.end();
}
console.log(
  JSON.stringify(
    {
      passed: true,
      ticketId: id,
      ticketNumber: created.data.number,
      checks: [
        '作成・割当・対応開始',
        '公開返信と解決の一括保存',
        '同時送信は一方200・他方409、返信1件',
        '越境404・依頼者の解決404',
        '内部メモ・空本文・版未指定400',
        '内部メモの非公開',
        '依頼者による再開',
        'カーソルの重複なし・件数維持',
        '別DB接続で永続化・監査・初回応答を確認',
      ],
    },
    null,
    2,
  ),
);
