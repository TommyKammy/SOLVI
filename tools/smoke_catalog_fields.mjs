/** WP-P2-UIX-040: additive synthetic fixtures only, with real API and app-role PostgreSQL reads. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const password = process.env.SOLVI_SMOKE_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
const base = new URL(process.env.SOLVI_API_BASE ?? 'http://127.0.0.1:3001');
if (
  !password ||
  !databaseUrl ||
  !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  base.protocol !== 'http:'
)
  throw new Error('Only the local synthetic API/database and a smoke password are supported');
const output = resolve(process.env.SOLVI_SMOKE_OUT ?? '.local/fix-040/catalog-fields-smoke.json');
const report = {
  workPackage: 'WP-P2-UIX-040',
  success: false,
  checks: [],
  createdCatalogs: 0,
  createdRequests: 0,
  retainedNonpublic: false,
};
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
let admin, catalogId;

async function api(path, actor, body, expected = 200) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${path}: expected HTTP ${expected}, received ${response.status}`,
  );
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login(email) {
  const actor = await api('/auth/login', null, { email, password });
  if (!actor.data.organizationId) {
    const organization = actor.data.organizations.find((item) => email.includes(`@${item.code}.`));
    assert.ok(organization, 'Synthetic organization must be present');
    await api('/auth/organization', actor, { organizationId: organization.id });
    actor.data.organizationId = organization.id;
  }
  return actor;
}
async function withOrganization(organizationId, run) {
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
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function check(name, run) {
  await run();
  report.checks.push({ name, passed: true });
}

try {
  admin = await login('org_admin@acme.example.test');
  const requester = await login('requester@acme.example.test');
  const approver = await login('approver@acme.example.test');
  const outsider = await login('org_admin@beta.example.test');
  const marker = `UI040-API-SYN-${Date.now()}`;
  const definition = {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成模擬対象（業務カテゴリとは別）',
    allowedDurations: [7, 30],
    maxReasonLength: 2000,
    category: '端末・機器',
    approval: { mode: 'fixed', approverId: approver.data.userId },
    sections: [
      { key: 'loan_info', title: '貸与情報', description: '合成データで確認します' },
      { key: 'extras', title: '周辺機器と確認' },
    ],
    fields: [
      {
        key: 'return_date',
        type: 'date',
        label: '返却予定日',
        required: true,
        minDate: '2026-01-01',
        maxDate: '2027-12-31',
        section: 'loan_info',
        visibleWhen: { field: 'loan_type', equals: '一時貸出' },
        helpText: '一時貸出の場合だけ入力します',
      },
      {
        key: 'loan_type',
        type: 'select',
        label: '貸与区分',
        required: true,
        options: ['標準貸与', '一時貸出'],
        section: 'loan_info',
      },
      {
        key: 'start_date',
        type: 'date',
        label: '開始希望日',
        required: true,
        minDate: '2026-01-01',
        maxDate: '2027-12-31',
        section: 'loan_info',
      },
      {
        key: 'quantity',
        type: 'number',
        label: '台数',
        required: true,
        min: 0,
        max: 10,
        section: 'loan_info',
        helpText: '0を含む有限数で確認します',
      },
      {
        key: 'devices',
        type: 'multiselect',
        label: '周辺機器',
        required: true,
        options: ['ディスプレイ', 'マウス', 'キーボード'],
        section: 'extras',
      },
      {
        key: 'team',
        type: 'text',
        label: '部署',
        required: true,
        maxLength: 80,
        section: 'loan_info',
      },
      {
        key: 'notes',
        type: 'textarea',
        label: '補足',
        required: false,
        maxLength: 500,
        section: 'extras',
      },
      {
        key: 'confirm',
        type: 'checkbox',
        label: '合成データの模擬申請であることを確認',
        required: true,
        section: 'extras',
      },
    ],
  };
  const content = {
    title: marker,
    description: '外部への操作を行わない優先度2の合成検証',
    definition,
  };
  const createBody = { ...content, code: `synth-fields-${Date.now()}`, creationKey: randomUUID() };

  await check('Authentication, authoring role and invalid definitions are enforced', async () => {
    await api('/catalog', null, undefined, 401);
    await api('/catalog-admin', requester, createBody, 403);
    const variants = [
      { ...definition, category: 'x'.repeat(81) },
      {
        ...definition,
        fields: [{ ...definition.fields[0], minDate: '2026-02-30' }, ...definition.fields.slice(1)],
      },
      {
        ...definition,
        fields: [
          { ...definition.fields[0], visibleWhen: { field: 'missing', equals: true } },
          ...definition.fields.slice(1),
        ],
      },
      {
        ...definition,
        fields: [
          {
            key: 'a',
            label: '合成A',
            type: 'checkbox',
            required: false,
            visibleWhen: { field: 'b', equals: true },
          },
          {
            key: 'b',
            label: '合成B',
            type: 'checkbox',
            required: false,
            visibleWhen: { field: 'a', equals: true },
          },
        ],
      },
      {
        ...definition,
        fields: [{ ...definition.fields[0], section: 'missing' }, ...definition.fields.slice(1)],
      },
    ];
    for (const invalid of variants)
      await api('/catalog-admin', admin, { ...createBody, definition: invalid }, 400);
  });
  catalogId = (await api('/catalog-admin', admin, createBody)).data.id;
  report.createdCatalogs = 1;
  report.catalogId = catalogId;
  const adminPath = `/catalog-admin/${catalogId}`;
  const detail = async () => (await api(adminPath, admin)).data;
  const published = async (actor = requester) =>
    (await api('/catalog', actor)).data.items.find((item) => item.id === catalogId);
  await check('New metadata persists only in the synthetic draft before publication', async () => {
    assert.deepEqual((await detail()).draft.definition, definition);
    assert.equal(await published(), undefined);
    await api(adminPath, outsider, undefined, 404);
    const stored = await withOrganization(admin.data.organizationId, (client) =>
      client.query(
        'SELECT definition FROM local_catalog_revision WHERE item_id=$1 AND revision=1',
        [catalogId],
      ),
    );
    assert.deepEqual(stored.rows[0].definition, definition);
  });
  await api(`${adminPath}/publication`, admin, { expectedVersion: 1, state: 'published' });
  await check(
    'Public category is independent from the simulation target and organization scoped',
    async () => {
      const item = await published();
      assert.equal(item.definition.category, '端末・機器');
      assert.notEqual(item.definition.category, item.definition.targetLabel);
      assert.equal(await published(outsider), undefined);
    },
  );
  const submittedValues = {
    loan_type: '標準貸与',
    start_date: '2026-11-15',
    return_date: 'HIDDEN-STale-SAMPLE',
    quantity: 0,
    devices: ['マウス', 'ディスプレイ'],
    team: '合成IT部署',
    notes: 'APIとPGの合成試験',
    confirm: true,
  };
  const submission = {
    itemId: catalogId,
    itemVersion: 1,
    reason: '合成の優先度2フォームを確認',
    durationDays: 7,
    approverId: approver.data.userId,
    values: submittedValues,
    idempotencyKey: randomUUID(),
  };
  await check(
    'Bypassing the client still rejects dates, numeric types/ranges and multiple choices',
    async () => {
      const invalidAnswers = [
        { ...submittedValues, start_date: '2026-02-30' },
        { ...submittedValues, start_date: '2025-12-31' },
        { ...submittedValues, quantity: -1 },
        { ...submittedValues, quantity: 10.01 },
        { ...submittedValues, quantity: '2' },
        { ...submittedValues, quantity: null },
        { ...submittedValues, quantity: '' },
        { ...submittedValues, devices: ['定義外'] },
        { ...submittedValues, devices: ['マウス', 'マウス'] },
        { ...submittedValues, devices: [] },
        { ...submittedValues, loan_type: '一時貸出', return_date: '' },
        { ...submittedValues, extra: true },
      ];
      for (const values of invalidAnswers)
        await api(
          '/service-requests',
          requester,
          { ...submission, values, idempotencyKey: randomUUID() },
          400,
        );
      await api('/service-requests', outsider, submission, 404);
    },
  );
  const requestId = (await api('/service-requests', requester, submission, 201)).data.id;
  report.createdRequests = 1;
  report.requestId = requestId;
  const requestPath = `/service-requests/${requestId}`;
  const requestDetail = async () => (await api(requestPath, requester)).data;
  const original = await requestDetail();
  await check(
    'The request snapshot normalizes values, preserves zero and drops hidden answers',
    async () => {
      const expectedValues = { ...submittedValues, devices: ['ディスプレイ', 'マウス'] };
      delete expectedValues.return_date;
      assert.deepEqual(original.request.snapshot.inputs.values, expectedValues);
      assert.deepEqual(original.request.snapshot.item.definition, definition);
      assert.equal(
        original.request.snapshotHash,
        createHash('sha256').update(canonical(original.request.snapshot)).digest('hex'),
      );
      const row = await withOrganization(admin.data.organizationId, (client) =>
        client.query('SELECT snapshot,snapshot_hash FROM local_service_request WHERE id=$1', [
          requestId,
        ]),
      );
      assert.deepEqual(row.rows[0].snapshot, original.request.snapshot);
      assert.equal(row.rows[0].snapshot_hash, original.request.snapshotHash);
      const replay = await api('/service-requests', requester, {
        ...submission,
        values: {
          ...submittedValues,
          return_date: 'another ignored hidden value',
          devices: ['ディスプレイ', 'マウス'],
        },
      });
      assert.equal(replay.data.id, requestId);
      assert.equal(replay.data.replayed, true);
      await api(
        '/service-requests',
        requester,
        { ...submission, values: { ...submittedValues, quantity: 1 } },
        409,
      );
    },
  );
  const revisedDefinition = {
    ...definition,
    category: '改訂後の合成カテゴリ',
    fields: definition.fields.map((field) =>
      field.key === 'quantity' ? { ...field, label: '改訂後台数', min: 1 } : field,
    ),
  };
  await api(`${adminPath}/save`, admin, {
    ...content,
    definition: revisedDefinition,
    expectedVersion: (await detail()).editVersion,
  });
  await api(`${adminPath}/publication`, admin, {
    expectedVersion: (await detail()).editVersion,
    state: 'published',
  });
  await check(
    'A newer catalog category and question definition do not change an existing request or hash',
    async () => {
      assert.equal((await published()).version, 2);
      assert.equal((await published()).definition.category, revisedDefinition.category);
      const unchanged = await requestDetail();
      assert.deepEqual(unchanged.request, original.request);
      assert.equal(unchanged.approval.id, original.approval.id);
      assert.deepEqual(unchanged.history, original.history);
      const revisions = await withOrganization(admin.data.organizationId, (client) =>
        client.query(
          'SELECT revision,snapshot,snapshot_hash FROM local_request_revision WHERE request_id=$1 ORDER BY revision',
          [requestId],
        ),
      );
      assert.equal(revisions.rows.length, 1);
      assert.deepEqual(revisions.rows[0].snapshot, original.request.snapshot);
      assert.equal(revisions.rows[0].snapshot_hash, original.request.snapshotHash);
    },
  );
  await check(
    'Cross-organization API and app-role RLS hide both catalog history and request snapshots',
    async () => {
      await api(requestPath, outsider, undefined, 404);
      await api(adminPath, outsider, undefined, 404);
      const hidden = await withOrganization(outsider.data.organizationId, async (client) => ({
        requests: (
          await client.query('SELECT id FROM local_service_request WHERE id=$1', [requestId])
        ).rowCount,
        requestRevisions: (
          await client.query('SELECT revision FROM local_request_revision WHERE request_id=$1', [
            requestId,
          ])
        ).rowCount,
        catalogRevisions: (
          await client.query('SELECT revision FROM local_catalog_revision WHERE item_id=$1', [
            catalogId,
          ])
        ).rowCount,
      }));
      assert.deepEqual(hidden, { requests: 0, requestRevisions: 0, catalogRevisions: 0 });
    },
  );
  report.success = true;
} catch (error) {
  report.failure = String(error.message).replaceAll(password, '<redacted>');
  process.exitCode = 1;
} finally {
  if (admin && catalogId) {
    try {
      const detail = (await api(`/catalog-admin/${catalogId}`, admin)).data;
      if (detail.active)
        await api(`/catalog-admin/${catalogId}/publication`, admin, {
          expectedVersion: detail.editVersion,
          state: 'unpublished',
        });
      report.retainedNonpublic = !(await api(`/catalog-admin/${catalogId}`, admin)).data.active;
    } catch {
      report.cleanupFailure = 'Could not confirm that the synthetic catalog is unpublished';
      report.success = false;
      process.exitCode = 1;
    }
  }
  await pool.end();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Catalog field API/PG smoke: ${report.success ? 'PASS' : 'FAIL'}; ${report.checks.length} checks; ${report.createdCatalogs} synthetic catalog, ${report.createdRequests} synthetic request; unpublished=${report.retainedNonpublic}`,
  );
  if (report.failure) console.log(report.failure);
}
