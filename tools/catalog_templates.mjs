/** Existing local synthetic users only. Never creates or changes credentials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { catalogTemplates, templateDefinition } from '../apps/web/src/lib/catalog-templates.ts';
export { catalogTemplates, templateDefinition };

const organizations = {
  acme: '00000000-0000-4000-9000-000000000001',
  beta: '00000000-0000-4000-9000-000000000002',
};
const base = 'http://127.0.0.1:3001';
export function deterministicKey(value) {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function localApi(path, actor, body, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  // Do not print request bodies, cookies, credentials or arbitrary response data.
  assert.equal(response.status, expected, `${path}: expected ${expected}, got ${response.status}`);
  return {
    data: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
export async function loginSynthetic(role, org = 'acme') {
  assert.ok(Object.hasOwn(organizations, org), 'acme/beta synthetic organization required');
  assert.ok(['org_admin', 'agent', 'requester', 'approver'].includes(role));
  const password = process.env.SOLVI_SMOKE_PASSWORD;
  assert.ok(password, 'SOLVI_SMOKE_PASSWORD required (existing development credential)');
  const actor = await localApi('/auth/login', null, {
    email: `${role}@${org}.example.test`,
    password,
  });
  if (!actor.data.organizationId) {
    assert.ok(actor.data.organizations.some((o) => o.id === organizations[org] && o.code === org));
    await localApi('/auth/organization', actor, { organizationId: organizations[org] });
  }
  actor.me = (await localApi('/auth/me', actor)).data;
  assert.equal(actor.me.organizationId, organizations[org]);
  actor.org = org;
  return actor;
}
export async function installTemplates(admin) {
  assert.equal(admin.me.organizationId, organizations[admin.org]);
  const { data } = await localApi('/catalog-admin', admin);
  // Require the existing independent, synthetic approver. Never pick an arbitrary person.
  const approver = await loginSynthetic('approver', admin.org);
  assert.ok(data.approvers.some((a) => a.id === approver.me.userId));
  const results = [];
  for (const template of catalogTemplates) {
    const existing = data.items.find((i) => i.code === template.code);
    if (existing) {
      results.push({
        code: template.code,
        id: existing.id,
        state: 'existing-kept',
        published: existing.active,
      });
      continue;
    }
    const created = await localApi('/catalog-admin', admin, {
      code: template.code,
      title: template.title,
      description: template.description,
      definition: templateDefinition(template, approver.me.userId),
      creationKey: deterministicKey(`SOLVI:UX-036:${admin.me.organizationId}:${template.code}`),
    });
    // A replay or interrupted prior install is kept as-is: no republishing an existing draft.
    if (!created.data.replayed) {
      await localApi(`/catalog-admin/${created.data.id}/publication`, admin, {
        expectedVersion: 1,
        state: 'published',
      });
    }
    results.push({
      code: template.code,
      id: created.data.id,
      state: created.data.replayed ? 'existing-kept' : 'created-published',
    });
  }
  return results;
}
