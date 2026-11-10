/** Additive synthetic smoke: FR-TKT-003, FR-CAT-001/002, NFR-UX-001/002. No cleanup or credentials writes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  catalogTemplates,
  installTemplates,
  localApi,
  loginSynthetic,
} from './catalog_templates.mjs';

const admin = await loginSynthetic('org_admin');
const agent = await loginSynthetic('agent');
const requester = await loginSynthetic('requester');
const approver = await loginSynthetic('approver');
const outsider = await loginSynthetic('requester', 'beta');
const marker = `UX036-${Date.now()}`;
async function web(path, actor) {
  const response = await fetch('http://127.0.0.1:3000' + path, {
    headers: { cookie: actor.cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `Web ${path}: ${response.status}`);
  return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}
// Management APIs remain admin-only.
for (const actor of [agent, requester]) {
  await localApi('/users', actor, undefined, 403);
  await localApi('/catalog-admin', actor, undefined, 403);
  await localApi('/groups', actor, { code: 'forbidden-' + Date.now(), name: marker }, 403);
}
const previous = (await localApi('/catalog-admin', admin)).data.items;
const before = await Promise.all(
  previous.map(async (i) => (await localApi(`/catalog-admin/${i.id}`, admin)).data),
);
const installed = await installTemplates(admin);
const afterFirst = await Promise.all(
  installed.map(async (i) => (await localApi(`/catalog-admin/${i.id}`, admin)).data),
);
assert.deepEqual(
  (await installTemplates(admin)).map((i) => i.id),
  installed.map((i) => i.id),
);
assert.deepEqual(
  await Promise.all(
    installed.map(async (i) => (await localApi(`/catalog-admin/${i.id}`, admin)).data),
  ),
  afterFirst,
);
assert.deepEqual(
  await Promise.all(
    previous.map(async (i) => (await localApi(`/catalog-admin/${i.id}`, admin)).data),
  ),
  before,
);

const group = (
  await localApi(
    '/groups',
    admin,
    { code: 'ux036-' + Date.now(), name: marker + ' 合成グループ' },
    201,
  )
).data;
const create = async (suffix) =>
  (
    await localApi(
      '/users',
      admin,
      {
        email: `${marker.toLowerCase()}-${suffix}@acme.example.test`,
        displayName: `${marker} ${suffix}`,
        roleCode: 'requester',
        reason: '合成データのメンバー選択確認',
      },
      201,
    )
  ).data.userId;
const active = await create('active');
const stopped = await create('stopped');
const expired = await create('expired');
await localApi(`/users/${stopped}/deactivate`, admin, {
  reason: '新規作成した合成利用者の停止確認',
});
await localApi(
  `/users/${expired}/roles/revoke`,
  admin,
  {
    roleCode: 'requester',
    reason: '新規作成した合成利用者の所属失効確認',
  },
  204,
);
const memberPath = `/groups/${group.id}/members`;
for (const actor of [agent, requester]) await localApi(memberPath, actor, { userId: active }, 403);
for (const userId of [stopped, expired, outsider.me.userId])
  await localApi(memberPath, admin, { userId }, 400);
await localApi(memberPath, admin, { userId: active }, 204);
await localApi(memberPath, admin, { userId: active }, 204);
assert.equal(
  (await localApi(memberPath, admin)).data.items.filter((p) => p.userId === active).length,
  1,
);
let html = await web(`/ops/groups/${group.id}?q=${encodeURIComponent(marker)}`, admin);
assert.ok(
  html.includes('所属済み') &&
    html.includes('停止中') &&
    html.includes('名前・メールで在籍者を検索'),
);
assert.ok(!html.includes(`${marker} expired`));
await localApi(`${memberPath}/remove`, admin, { userId: active }, 204);
assert.equal((await localApi(memberPath, admin)).data.items.length, 0);
html = await web(`/ops/groups/${group.id}?q=${encodeURIComponent(marker + ' active')}`, admin);
assert.ok(html.includes('追加可能 1人') || /追加可能\s*(?:<!--.*?-->\s*)*1/.test(html));
await localApi(`/groups/${group.id}/active`, admin, { active: false }, 204);
await localApi(memberPath, admin, { userId: active }, 404);
assert.ok((await web(`/ops/groups/${group.id}`, admin)).includes('このグループは無効'));

const portal = await web('/portal', requester);
assert.ok(portal.includes('種類から申請する') && portal.includes('メニューにない依頼・一般相談'));
assert.ok(!portal.includes('aria-label="組織の管理"'));
html = await web('/ops', admin);
assert.ok(
  html.includes('aria-label="組織の管理"') &&
    html.includes('在籍者の管理') &&
    html.includes('担当グループ'),
);
assert.ok(!(await web('/ops', agent)).includes('aria-label="組織の管理"'));
const catalog = (await localApi('/catalog', requester)).data;
const requestIds = [];
for (const template of catalogTemplates) {
  const id = installed.find((i) => i.code === template.code).id;
  const item = catalog.items.find((i) => i.id === id);
  assert.ok(
    item,
    'Template must be published. Existing private code is deliberately never republished.',
  );
  assert.ok(portal.includes(template.title) && portal.includes(`/catalog/${id}`));
  assert.ok(
    (await web(`/catalog/${id}`, requester)).includes(
      '実アカウント作成・Box権限付与・機器の貸出は行いません',
    ),
  );
  const values = Object.fromEntries(
    item.definition.fields.map((f) => [
      f.key,
      f.type === 'checkbox'
        ? true
        : f.type === 'select'
          ? f.options[0]
          : f.key.includes('date') || ['loan_start'].includes(f.key)
            ? '2026-10-05'
            : `合成-${f.key}`,
    ]),
  );
  const input = {
    itemId: id,
    itemVersion: item.version,
    reason: marker + ' 合成申請',
    durationDays: item.definition.allowedDurations[0],
    approverId: item.definition.approval.approverId,
    idempotencyKey: randomUUID(),
    values,
  };
  await localApi(
    '/service-requests',
    requester,
    { ...input, values: {}, idempotencyKey: randomUUID() },
    400,
  );
  await localApi('/service-requests', outsider, input, 404);
  const result = await localApi('/service-requests', requester, input, 201);
  const path = `/service-requests/${result.data.id}`;
  await localApi('/service-requests', requester, input); // Same request key remains one request.
  const detail = (await localApi(path, requester)).data;
  assert.deepEqual(detail.request.snapshot.inputs.values, values);
  await localApi(
    path + '/decisions',
    requester,
    { decision: 'approve', expectedVersion: detail.request.version },
    403,
  );
  await localApi(path + '/decisions', approver, {
    decision: 'approve',
    expectedVersion: detail.request.version,
  });
  const approved = (await localApi(path, agent)).data;
  await localApi(path + '/simulate', agent, { expectedVersion: approved.request.version });
  const final = (await localApi(path, requester)).data;
  assert.equal(final.request.state, 'completed');
  assert.equal(final.receipt.simulation, true);
  assert.equal(final.receipt.result.externalChanges, 0);
  assert.equal((await localApi(`/tickets/${result.data.ticketId}`, agent)).data.state, 'resolved');
  requestIds.push(result.data.id);
}
// Independent PostgreSQL connection: read-only persistence and duplicate audit check.
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SELECT set_config('app.current_org',$1,true)", [admin.me.organizationId]);
  assert.equal(
    Number(
      (
        await client.query(
          "SELECT count(*) FROM audit_event WHERE target_id=$1 AND event_type='org.member.added'",
          [group.id],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await client.query(
          'SELECT count(*) FROM local_simulation_receipt WHERE request_id=ANY($1::uuid[]) AND simulation',
          [requestIds],
        )
      ).rows[0].count,
    ),
    3,
  );
  await client.query('COMMIT');
} finally {
  await client.end();
}
console.log(
  JSON.stringify(
    {
      result: 'passed',
      marker,
      templates: installed.map((t) => ({ code: t.code, id: t.id })),
      groupId: group.id,
      requests: requestIds,
      checks: [
        'admin-only navigation/API',
        'search/select/current/disabled/duplicate/expired/cross-org/inactive',
        'idempotent templates/existing catalog unchanged',
        'three forms/approval/simulation/resolved tickets',
        'independent PostgreSQL persistence',
      ],
      browser: 'unavailable; authenticated HTTP only',
      credentialsChanged: false,
      externalChanges: 0,
    },
    null,
    2,
  ),
);
