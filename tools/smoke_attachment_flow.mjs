/** Adds synthetic fixtures only; no deletion, reset, external calls, or secret output. */
import assert from 'node:assert/strict';
import { S3CompatibleStorage } from '@solvi/shared';

const base = 'http://127.0.0.1:3001';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD が必要です');
async function api(path, cookie, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email) {
  const r = await api('/auth/login', null, { email, password });
  assert.equal(r.status, 200);
  if (!r.data.organizationId) {
    const org = r.data.organizations.find((o) => email.includes(`@${o.code}.`));
    assert.ok(org);
    assert.equal(
      (await api('/auth/organization', r.cookie, { organizationId: org.id })).status,
      200,
    );
  }
  return r.cookie;
}
const requester = await login('requester@acme.example.test');
const agent = await login('agent@acme.example.test');
const outsider = await login('requester@beta.example.test');
const t = await api('/tickets', requester, {
  kind: 'incident',
  subject: '添付検証: 接続エラー',
  body: '合成ファイルのみを使用します。',
  impact: 'low',
  urgency: 'low',
});
assert.equal(t.status, 201);
const id = t.data.id;
const bytes = Buffer.from('SOLVI attachment smoke: synthetic data only.\n');
const metadata = {
  fileName: '検証ログ.txt',
  contentType: 'text/plain',
  sizeBytes: bytes.length,
  visibility: 'public',
};
assert.equal((await api(`/tickets/${id}/attachments`, outsider, metadata)).status, 404);
assert.equal(
  (await api(`/tickets/${id}/attachments`, requester, { ...metadata, visibility: 'internal' }))
    .status,
  403,
);
const uploaded = [];
async function upload(cookie, meta, data = bytes) {
  const r = await api(`/tickets/${id}/attachments`, cookie, meta);
  assert.equal(r.status, 201);
  assert.equal((await api(`/attachments/${r.data.attachmentId}/download`, cookie)).status, 409);
  assert.equal(
    (
      await fetch(r.data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': meta.contentType, origin: 'https://invalid.example.test' },
        body: data,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(r.data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': meta.contentType },
        body: data,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(r.data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': meta.contentType },
        body: data,
      })
    ).status,
    409,
  );
  uploaded.push(r.data.attachmentId);
  return r.data.attachmentId;
}
const publicId = await upload(requester, metadata);
const internalId = await upload(agent, {
  ...metadata,
  fileName: '担当者メモ.txt',
  visibility: 'internal',
});
const mismatchId = await upload(requester, {
  ...metadata,
  fileName: 'サイズ不一致.txt',
  sizeBytes: bytes.length + 1,
});
// Standard harmless anti-malware test string, generated in memory; never a real malware sample.
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const infectedId = await upload(
  requester,
  { ...metadata, fileName: '検査用.txt', sizeBytes: eicar.length },
  eicar,
);
let list;
const until = Date.now() + 150000;
while (Date.now() < until) {
  list = await api(`/tickets/${id}/attachments`, agent);
  assert.equal(list.status, 200);
  const statuses = new Map(list.data.items.map((a) => [a.id, a.scanStatus]));
  if (
    statuses.get(publicId) === 'clean' &&
    statuses.get(internalId) === 'clean' &&
    statuses.get(infectedId) === 'infected'
  )
    break;
  await new Promise((r) => setTimeout(r, 3000));
}
const statuses = new Map(list.data.items.map((a) => [a.id, a.scanStatus]));
assert.equal(statuses.get(publicId), 'clean');
assert.equal(statuses.get(internalId), 'clean');
assert.equal(statuses.get(infectedId), 'infected');
assert.equal(statuses.get(mismatchId), 'pending');
const ownList = await api(`/tickets/${id}/attachments`, requester);
assert.equal(
  ownList.data.items.some((a) => a.id === internalId),
  false,
);
for (const [cookie, attachmentId, expected] of [
  [outsider, publicId, 404],
  [requester, internalId, 404],
  [requester, mismatchId, 409],
  [requester, infectedId, 409],
])
  assert.equal((await api(`/attachments/${attachmentId}/download`, cookie)).status, expected);
assert.equal((await api(`/tickets/${id}/attachments`, outsider)).status, 404);
const download = await api(`/attachments/${publicId}/download`, requester);
assert.equal(download.status, 200);
const response = await fetch(download.data.url);
assert.equal(response.status, 200);
assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
assert.ok(response.headers.get('content-disposition').startsWith('attachment;'));
const tampered = new URL(download.data.url);
tampered.searchParams.set('X-Amz-Expires', '599');
assert.equal((await fetch(tampered)).status, 403);
const storage = new S3CompatibleStorage({
  endpoint: 'http://127.0.0.1:9100',
  bucket: process.env.S3_BUCKET_ATTACHMENTS,
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY,
  region: process.env.S3_REGION,
});
const expired = storage.presignGet('nonexistent-smoke-key', 1, 'expired.txt');
await new Promise((r) => setTimeout(r, 2100));
assert.equal((await fetch(expired.url)).status, 403);
assert.equal((await fetch('http://127.0.0.1:9100/unsigned/object')).status, 403);
console.log(
  JSON.stringify(
    {
      ok: true,
      ticketId: id,
      publicId,
      internalId,
      checks: [
        'upload/list/download bytes',
        'real ClamAV clean + EICAR quarantine',
        'pending size mismatch refused',
        'other organization 404',
        'internal hidden from requester',
        'pending download 409',
        'one-time immutable upload 409',
        'invalid origin/signature/expiry/unsigned refused',
      ],
    },
    null,
    2,
  ),
);
