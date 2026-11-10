/** Additive localhost-only history check. Existing data is never edited/deleted. */
import assert from 'node:assert/strict';
import { assetFieldChanges } from '../apps/web/src/lib/asset-history.ts';

const password = process.env.SOLVI_SMOKE_PASSWORD;
assert.ok(password, 'SOLVI_SMOKE_PASSWORD is required');
async function api(path, actor, body) {
  const response = await fetch('http://127.0.0.1:3001' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email) {
  const actor = await api('/auth/login', null, { email, password });
  assert.equal(actor.status, 200);
  if (!actor.data.organizationId) {
    const org = actor.data.organizations.find((org) => org.code === 'acme');
    assert.ok(org);
    assert.equal((await api('/auth/organization', actor, { organizationId: org.id })).status, 200);
  }
  return actor;
}
const staff = await login('agent@acme.example.test');
const owner = await login('requester@acme.example.test');
const marker = 'POLISH-SYN-' + Date.now();
const base = {
  assetTag: marker,
  name: '合成端末: 履歴の前後比較',
  kind: 'pc',
  state: 'in_use',
  model: 'Synthetic Notebook',
  serialNumber: marker + '-SERIAL',
  hostname: 'synthetic-before',
  vendor: 'Synthetic vendor A',
  assignedUserId: owner.data.userId,
  location: '合成保管庫A',
  internalNotes: '履歴比較の合成メモ。実端末ではありません。',
  reason: '前後比較確認の初回登録',
};
const created = await api('/assets', staff, base);
assert.equal(created.status, 201);
const path = '/assets/' + created.data.id;
const first = await api(path, staff);
assert.equal(first.status, 200);
assert.equal(first.data.revisions.length, 1);
const update = {
  ...base,
  state: 'repair',
  hostname: 'synthetic-after',
  vendor: 'Synthetic vendor B',
  reason: '合成の修理受付: 状態・ホスト名・提供元の3項目を変更',
  expectedVersion: 1,
};
assert.equal((await api(path + '/edit', staff, update)).status, 200);
const reread = await api(path, staff);
assert.equal(reread.status, 200);
assert.equal(reread.data.asset.version, 2);
const [after, before] = reread.data.revisions;
assert.deepEqual(before.snapshot, first.data.revisions[0].snapshot);
assert.deepEqual(assetFieldChanges(before.snapshot, after.snapshot), [
  { label: '状態', before: '使用中', after: '修理中' },
  { label: 'ホスト名', before: 'synthetic-before', after: 'synthetic-after' },
  { label: 'メーカー・提供元', before: 'Synthetic vendor A', after: 'Synthetic vendor B' },
]);
// A name-only display change is not a user reassignment; IDs identify relationships.
assert.deepEqual(
  assetFieldChanges(before.snapshot, { ...before.snapshot, assignedUserName: '合成表示名訂正' }),
  [],
);
assert.equal(
  assetFieldChanges({ ...before.snapshot, location: undefined }, before.snapshot)[0].before,
  '未記録',
);
const requester = await api(path, owner);
assert.equal(requester.status, 200);
assert.deepEqual(requester.data.revisions, []);
assert.equal(requester.data.asset.internalNotes, undefined);
assert.equal(requester.data.asset.location, undefined);
assert.equal(requester.data.canManage, false);
console.log(
  JSON.stringify(
    {
      ok: true,
      assetId: created.data.id,
      assetTag: marker,
      version: reread.data.asset.version,
      changedFields: 3,
      originalRevisionPreserved: true,
      requesterHistoryHidden: true,
      url: 'http://127.0.0.1:3000' + path,
    },
    null,
    2,
  ),
);
