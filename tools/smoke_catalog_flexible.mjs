/** WP042: one new synthetic catalog, two requests, loopback API/PG only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const password = process.env.SOLVI_SMOKE_PASSWORD;
const database = process.env.DATABASE_URL;
const base = new URL(process.env.SOLVI_API_BASE ?? 'http://127.0.0.1:3001');
if (
  !password ||
  !database ||
  !['localhost', '127.0.0.1'].includes(new URL(database).hostname) ||
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  base.protocol !== 'http:'
)
  throw new Error('Only local synthetic credentials and loopback API/PG are supported');
const output = resolve(process.env.SOLVI_SMOKE_OUT ?? 'evidence/WP-P2-UIX-042/api-smoke.json');
const report = {
  workPackage: 'WP-P2-UIX-042',
  success: false,
  checks: [],
  catalogIds: [],
  requestIds: [],
  catalogsUnpublished: false,
};
const pool = new pg.Pool({ connectionString: database, max: 1 });
let admin, catalogId;
async function api(path, actor, body, status = 200) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status, `${path}: expected ${status}, received ${response.status}`);
  const text = await response.text();
  return {
    data: text ? JSON.parse(text) : {},
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(email) {
  const actor = await api('/auth/login', null, { email, password });
  if (!actor.data.organizationId) {
    const organization = actor.data.organizations.find((entry) =>
      email.includes(`@${entry.code}.`),
    );
    assert.ok(organization);
    await api('/auth/organization', actor, { organizationId: organization.id });
    actor.data.organizationId = organization.id;
  }
  return actor;
}
async function check(name, run) {
  await run();
  report.checks.push({ name, passed: true });
}
async function orgQuery(organizationId, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.current_org',$1,true)", [organizationId]);
    return await run(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
try {
  admin = await login('org_admin@acme.example.test');
  const requester = await login('requester@acme.example.test');
  const approver = await login('approver@acme.example.test');
  const agent = await login('agent@acme.example.test');
  const beta = await login('org_admin@beta.example.test');
  const marker = `UI042-SYN-${Date.now()}`;
  const definition = {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成機器',
    allowedDurations: [7, 30],
    maxReasonLength: 30,
    requestFields: { reason: false, duration: false },
    approval: { mode: 'fixed', approverId: approver.data.userId },
    fields: [
      {
        key: 'items',
        label: '必要な機器',
        type: 'multiselect',
        required: true,
        options: ['PC', 'マウス'],
      },
      {
        key: 'application',
        label: '申請内容',
        type: 'select',
        required: true,
        options: ['Web解除', 'USB利用'],
        visibleWhen: { field: 'items', contains: 'PC' },
      },
      {
        key: 'url',
        label: '対象URL',
        type: 'text',
        required: true,
        maxLength: 100,
        visibleWhen: { field: 'application', equals: 'Web解除' },
      },
      {
        key: 'date',
        label: '対象日',
        type: 'date',
        required: true,
        visibleWhen: { field: 'application', equals: 'Web解除' },
      },
    ],
  };
  const content = {
    code: `ui042-${Date.now()}`,
    title: marker,
    description: 'ローカル合成フォームの検証',
    definition,
    creationKey: randomUUID(),
  };
  await check(
    'Strict definition rejects unknown flags, mixed operators and invalid membership before writes',
    async () => {
      for (const changed of [
        { ...definition, requestFields: { reason: 'false' } },
        {
          ...definition,
          fields: definition.fields.map((field) =>
            field.key === 'application'
              ? { ...field, visibleWhen: { field: 'items', contains: 'PC', equals: 'PC' } }
              : field,
          ),
        },
        {
          ...definition,
          fields: definition.fields.map((field) =>
            field.key === 'application'
              ? { ...field, visibleWhen: { field: 'items', contains: '未知' } }
              : field,
          ),
        },
      ])
        await api('/catalog-admin', admin, { ...content, definition: changed }, 400);
    },
  );
  catalogId = (await api('/catalog-admin', admin, content)).data.id;
  report.catalogIds.push(catalogId);
  const detail = async () => (await api(`/catalog-admin/${catalogId}`, admin)).data;
  await check('OFF flags and contains conditions survive save/reload and publication', async () => {
    assert.deepEqual((await detail()).draft.definition.requestFields, definition.requestFields);
    assert.deepEqual((await detail()).draft.definition.fields[1].visibleWhen, {
      field: 'items',
      contains: 'PC',
    });
    await api(`/catalog-admin/${catalogId}/publication`, admin, {
      expectedVersion: (await detail()).editVersion,
      state: 'published',
    });
  });
  const originalInput = {
    itemId: catalogId,
    itemVersion: 1,
    idempotencyKey: randomUUID(),
    approverId: approver.data.userId,
    values: {
      items: ['マウス'],
      application: 'Web解除',
      url: 'https://example.test/stale',
      date: '2026-11-11',
    },
  };
  await check(
    'OFF inputs and hidden descendants are omitted despite stale extra API values',
    async () => {
      const created = (
        await api(
          '/service-requests',
          requester,
          { ...originalInput, reason: '古い理由', durationDays: -7 },
          201,
        )
      ).data;
      report.requestIds.push(created.id);
      const request = (await api(`/service-requests/${created.id}`, requester)).data;
      assert.deepEqual(request.request.snapshot.inputs, { values: { items: ['マウス'] } });
      const replay = (
        await api('/service-requests', requester, {
          ...originalInput,
          reason: '別の古い値',
          durationDays: 365,
        })
      ).data;
      assert.equal(replay.id, created.id);
      assert.equal(replay.replayed, true);
      const ticket = (await api(`/tickets/${created.ticketId}/workspace`, agent)).data;
      assert.doesNotMatch(ticket.ticket.body, /理由:|利用日数:|undefined/);
    },
  );
  const firstId = report.requestIds[0];
  await check(
    'Contains checks canonical trimmed selection and server enforces visible descendants',
    async () => {
      await api(
        '/service-requests',
        requester,
        {
          ...originalInput,
          idempotencyKey: randomUUID(),
          values: { items: [' PC '], application: 'Web解除' },
        },
        400,
      );
      await api(
        '/service-requests',
        requester,
        { ...originalInput, idempotencyKey: randomUUID(), values: { items: ['未知'] } },
        400,
      );
    },
  );
  await api(`/service-requests/${firstId}/decisions`, approver, {
    expectedVersion: 1,
    decision: 'approve',
    reason: '合成入力を確認',
  });
  const first = (await api(`/service-requests/${firstId}`, requester)).data;
  const before = await orgQuery(
    admin.data.organizationId,
    async (client) =>
      (
        await client.query(
          'SELECT snapshot,snapshot_hash FROM local_request_revision WHERE request_id=$1 AND revision=1',
          [firstId],
        )
      ).rows[0],
  );
  assert.equal(
    createHash('sha256').update(canonical(before.snapshot)).digest('hex'),
    before.snapshot_hash,
  );
  const legacyDefinition = { ...definition };
  delete legacyDefinition.requestFields;
  await check(
    'New publication preserves old request snapshot/hash/approval and original-key replay',
    async () => {
      await api(`/catalog-admin/${catalogId}/save`, admin, {
        title: marker + ' v2',
        description: content.description,
        definition: legacyDefinition,
        expectedVersion: (await detail()).editVersion,
      });
      await api(`/catalog-admin/${catalogId}/publication`, admin, {
        expectedVersion: (await detail()).editVersion,
        state: 'published',
      });
      const after = (await api(`/service-requests/${firstId}`, requester)).data;
      assert.deepEqual(after.request, first.request);
      assert.deepEqual(after.approval, first.approval);
      assert.deepEqual(after.history, first.history);
      const replay = (await api('/service-requests', requester, originalInput)).data;
      assert.equal(replay.id, firstId);
      assert.equal(replay.replayed, true);
      const row = await orgQuery(
        admin.data.organizationId,
        async (client) =>
          (
            await client.query(
              'SELECT snapshot,snapshot_hash FROM local_request_revision WHERE request_id=$1 AND revision=1',
              [firstId],
            )
          ).rows[0],
      );
      assert.deepEqual(row, before);
    },
  );
  await check(
    'Request edit uses its frozen OFF definition, invalidates approval and retains prior history',
    async () => {
      await api(`/service-requests/${firstId}/edit`, requester, {
        expectedVersion: first.request.version,
        approverId: approver.data.userId,
        values: { items: ['マウス'] },
      });
      const revised = (await api(`/service-requests/${firstId}`, requester)).data;
      assert.equal(revised.request.snapshot.item.version, 1);
      assert.deepEqual(revised.request.snapshot.inputs, { values: { items: ['マウス'] } });
      assert.deepEqual(revised.history[0].inputs, first.history[0].inputs);
      assert.equal(revised.history[0].state, 'invalidated');
      await api(`/service-requests/${firstId}/decisions`, approver, {
        expectedVersion: revised.request.version,
        decision: 'approve',
        reason: '固定版を再確認',
      });
    },
  );
  await check(
    'Successful local simulation omits absent duration in receipt and completion comment',
    async () => {
      const approved = (await api(`/service-requests/${firstId}`, requester)).data;
      const result = (
        await api(`/service-requests/${firstId}/simulate`, agent, {
          expectedVersion: approved.request.version,
        })
      ).data;
      assert.equal(result.receipt.result.durationDays, undefined);
      assert.equal(result.receipt.result.externalChanges, 0);
      const completed = (await api(`/service-requests/${firstId}`, requester)).data;
      assert.equal(completed.request.state, 'completed');
      const comments = await orgQuery(
        admin.data.organizationId,
        async (client) =>
          (
            await client.query('SELECT body FROM ticket_comment WHERE ticket_id=$1', [
              completed.request.ticketId,
            ])
          ).rows,
      );
      assert.ok(comments.length > 0);
      assert.ok(comments.some((comment) => comment.body.includes('ローカル模擬実行が完了')));
      for (const comment of comments) assert.doesNotMatch(comment.body, /利用日数:|undefined/);
    },
  );
  const secondInput = {
    ...originalInput,
    itemVersion: 2,
    idempotencyKey: randomUUID(),
    reason: '合成利用理由',
    durationDays: 7,
    values: {
      items: [' PC ', 'マウス'],
      application: 'Web解除',
      url: 'https://example.test/target',
      date: '2026-11-11',
    },
  };
  await check(
    'Absent flags retain legacy required reason/day validation through direct API',
    async () => {
      for (const changed of [
        { reason: undefined },
        { reason: ' ' },
        { reason: 'x'.repeat(31) },
        { durationDays: undefined },
        { durationDays: 8 },
        { durationDays: '7' },
        { durationDays: 7.5 },
      ])
        await api('/service-requests', requester, { ...secondInput, ...changed }, 400);
      const created = (await api('/service-requests', requester, secondInput, 201)).data;
      report.requestIds.push(created.id);
      const request = (await api(`/service-requests/${created.id}`, requester)).data;
      assert.equal(request.request.snapshot.inputs.reason, secondInput.reason);
      assert.equal(request.request.snapshot.inputs.durationDays, 7);
      assert.deepEqual(request.request.snapshot.inputs.values.items, ['PC', 'マウス']);
      assert.equal(request.request.snapshot.item.definition.requestFields, undefined);
    },
  );
  await check('Deselecting an item in an edit prunes its complete descendant chain', async () => {
    const id = report.requestIds[1];
    await api(`/service-requests/${id}/edit`, requester, {
      reason: '編集後の理由',
      durationDays: 30,
      approverId: approver.data.userId,
      expectedVersion: 1,
      values: { ...secondInput.values, items: ['マウス'] },
    });
    const request = (await api(`/service-requests/${id}`, requester)).data;
    assert.deepEqual(request.request.snapshot.inputs.values, { items: ['マウス'] });
    assert.equal(request.history[0].inputs.values.application, 'Web解除');
    assert.equal(request.history[0].inputs.reason, secondInput.reason);
  });
  await check(
    'Cross-organization API hides catalog/request and RLS hides all three request tables',
    async () => {
      await api(`/catalog-admin/${catalogId}`, beta, undefined, 404);
      for (const id of report.requestIds)
        await api(`/service-requests/${id}`, beta, undefined, 404);
      await orgQuery(beta.data.organizationId, async (client) => {
        for (const [table, key] of [
          ['local_service_request', 'id'],
          ['local_request_revision', 'request_id'],
          ['local_request_approval', 'request_id'],
        ]) {
          const result = await client.query(
            `SELECT count(*)::int AS count FROM ${table} WHERE ${key}=ANY($1::uuid[])`,
            [report.requestIds],
          );
          assert.equal(result.rows[0].count, 0);
        }
      });
    },
  );
  report.success = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (admin && catalogId) {
    try {
      const detail = (await api(`/catalog-admin/${catalogId}`, admin)).data;
      await api(`/catalog-admin/${catalogId}/publication`, admin, {
        expectedVersion: detail.editVersion,
        state: 'unpublished',
      });
      report.catalogsUnpublished = true;
    } catch {
      report.cleanup =
        'Synthetic catalog unpublication failed; reconcile reported catalog ID before rerunning';
      report.success = false;
      process.exitCode = 1;
    }
  }
  await pool.end();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      success: report.success,
      checks: report.checks.length,
      newCatalogs: report.catalogIds.length,
      newRequests: report.requestIds.length,
      catalogsUnpublished: report.catalogsUnpublished,
      ...(report.error ? { error: report.error } : {}),
    }),
  );
}
