/** Additive, loopback-only synthetic CSV workflow. No reset, delete or real data. */
import assert from 'node:assert/strict';
import pg from 'pg';
const password = process.env.SOLVI_SMOKE_PASSWORD;
if (!password) throw new Error('SOLVI_SMOKE_PASSWORD required');
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))
  throw new Error('local DB only');
async function api(path, actor, body) {
  const r = await fetch('http://127.0.0.1:3001' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(actor ? { cookie: actor.cookie } : {}) },
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
    assert.equal((await api('/auth/organization', r, { organizationId: o.id })).status, 200);
    r.data.organizationId = o.id;
  }
  return r;
}
const staff = await login('agent@acme.example.test'),
  owner = await login('requester@acme.example.test'),
  auditor = await login('auditor@acme.example.test'),
  betaStaff = await login('agent@beta.example.test');
const marker = 'CSV' + Date.now(),
  sourceKey = marker.toLowerCase();
const fields = [
  'externalId',
  'assetTag',
  'name',
  'kind',
  'state',
  'model',
  'serialNumber',
  'hostname',
  'vendor',
  'assignedUserEmail',
];
const headers = [
  '外部番号',
  'タグ',
  '名称',
  '種別',
  '状態',
  'モデル',
  'シリアル',
  'ホスト',
  'メーカー',
  '利用者',
];
const mapping = Object.fromEntries(fields.map((f, i) => [f, headers[i]]));
const enc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
const csv = (rows) =>
  '\uFEFF' + [headers, ...rows].map((r) => r.map(enc).join(',')).join('\r\n') + '\r\n';
const base = {
  assetTag: marker + '-MANUAL',
  name: '合成: 元の資産',
  kind: 'pc',
  state: 'in_use',
  model: 'Synthetic Model',
  serialNumber: marker + '-SERIAL-M',
  hostname: marker.toLowerCase() + '-m',
  vendor: 'Synthetic',
  assignedUserId: owner.data.userId,
  location: '未対応列は保持する合成場所',
  internalNotes: 'CSVにない内部メモ',
  reason: '合成の初期登録',
};
const manual = await api('/assets', staff, base);
assert.equal(manual.status, 201);
const omitted = await api('/assets', staff, {
  ...base,
  assetTag: marker + '-OMITTED',
  serialNumber: marker + '-OMITTED-S',
});
assert.equal(omitted.status, 201);
const records = [
  [
    'local-manual',
    base.assetTag,
    '合成: 更新対象',
    'pc',
    'repair',
    base.model,
    base.serialNumber,
    base.hostname,
    base.vendor,
    'requester@acme.example.test',
  ],
  [
    'pc1',
    marker + '-NEW',
    '合成, "引用符"と\n改行',
    'pc',
    'in_use',
    'Synthetic Model',
    marker + '-NEW-S',
    marker.toLowerCase(),
    'Synthetic',
    'requester@acme.example.test',
  ],
  ['bad1', marker + '-BAD', '必須不足', 'pc', 'stocked', '', '', '', '', ''],
  [
    'duplicate',
    marker + '-DUP1',
    '重複外部ID1',
    'saas',
    'stocked',
    'Synthetic SaaS',
    '',
    '',
    'Synthetic',
    '',
  ],
  [
    'duplicate',
    marker + '-DUP2',
    '重複外部ID2',
    'saas',
    'stocked',
    'Synthetic SaaS',
    '',
    '',
    'Synthetic',
    '',
  ],
  [
    'serial1',
    marker + '-S1',
    '重複シリアル1',
    'mobile',
    'stocked',
    'Synthetic Phone',
    marker + '-DUP-S',
    '',
    '',
    '',
  ],
  [
    'serial2',
    marker + '-S2',
    '重複シリアル2',
    'mobile',
    'stocked',
    'Synthetic Phone',
    (marker + '-DUP-S').toLowerCase(),
    '',
    '',
    '',
  ],
  [
    'foreign',
    marker + '-FOREIGN',
    '別組織の利用者',
    'saas',
    'in_use',
    'Synthetic SaaS',
    '',
    '',
    'Synthetic',
    'requester@beta.example.test',
  ],
];
const body = { sourceKey, mapping, reason: '合成CSVの取込確認', csv: csv(records) };
assert.equal((await api('/assets/imports/inspect', null, { csv: body.csv })).status, 401);
assert.equal((await api('/assets/imports/preview', owner, body)).status, 403);
assert.equal((await api('/assets/imports/preview', auditor, body)).status, 403);
const inspection = await api('/assets/imports/inspect', staff, { csv: body.csv });
assert.equal(inspection.status, 200);
assert.deepEqual(inspection.data.headers, headers);
for (const raw of [
  'a,a\n1,2',
  'a,b\n"open,2',
  'a\n' + 'x\n'.repeat(101),
  'a\n' + 'x'.repeat(24576),
])
  assert.equal((await api('/assets/imports/inspect', staff, { csv: raw })).status, 400);
assert.equal(
  (
    await api('/assets/imports/preview', staff, {
      ...body,
      mapping: { ...mapping, externalId: '' },
    })
  ).status,
  400,
);
const p = await api('/assets/imports/preview', staff, body);
assert.equal(p.status, 200, JSON.stringify(p.data));
assert.deepEqual(p.data.counts, { add: 1, update: 1, unchanged: 0, error: 6 });
const path = '/assets/imports/' + p.data.id,
  confirmation = { confirmed: true, planHash: p.data.planHash };
assert.equal((await api(path, owner)).status, 403);
assert.equal((await api(path, betaStaff)).status, 404);
assert.equal((await api(path, auditor)).status, 200);
assert.equal((await api(path + '/apply', auditor, confirmation)).status, 403);
assert.equal(
  (await api(path + '/apply', staff, { ...confirmation, confirmed: false })).status,
  400,
);
assert.equal(
  (await api(path + '/apply', staff, { ...confirmation, planHash: '0'.repeat(64) })).status,
  409,
);
let d = (await api(path, staff)).data;
assert.equal(d.receipt, null);
assert.equal(d.plan.rows[0].match, 'asset_tag');
assert.equal((await api('/assets/' + manual.data.id, staff)).data.asset.version, 1);
const applies = await Promise.all([
  api(path + '/apply', staff, confirmation),
  api(path + '/apply', staff, confirmation),
]);
assert.deepEqual(
  applies.map((a) => a.status),
  [200, 200],
);
assert.deepEqual(applies.map((a) => a.data.replayed).sort(), [false, true]);
assert.deepEqual(applies[0].data.assets, applies[1].data.assets);
const createdId = applies[0].data.assets.find((a) => a.row === 3).id;
let changed = (await api('/assets/' + manual.data.id, staff)).data;
assert.equal(changed.asset.version, 2);
assert.equal(changed.asset.location, base.location);
assert.equal(changed.asset.internalNotes, base.internalNotes);
assert.equal(changed.asset.sourceKind, 'manual');
assert.equal((await api('/assets/' + createdId, staff)).data.asset.sourceKind, 'csv');
assert.equal((await api('/assets/' + createdId, owner)).data.asset.internalNotes, undefined);
assert.equal((await api('/assets/' + omitted.data.id, staff)).data.asset.version, 1);
const rerun = await api('/assets/imports/preview', staff, body);
assert.equal(rerun.status, 200);
assert.deepEqual(rerun.data.counts, { add: 0, update: 0, unchanged: 2, error: 6 });
assert.equal(
  (
    await api('/assets/imports/' + rerun.data.id + '/apply', staff, {
      confirmed: true,
      planHash: rerun.data.planHash,
    })
  ).status,
  200,
);
assert.equal((await api('/assets/' + createdId, staff)).data.asset.version, 1);
assert.equal((await api('/assets/' + manual.data.id, staff)).data.asset.version, 2);
// External ID survives a tag rename; explicit blank clears mapped attributes, others retain.
const renamed = structuredClone(records[1]);
renamed[1] = marker + '-RENAMED';
const rename = await api('/assets/imports/preview', staff, { ...body, csv: csv([renamed]) });
assert.equal(rename.status, 200);
assert.equal(rename.data.counts.update, 1);
assert.equal(
  (
    await api('/assets/imports/' + rename.data.id + '/apply', staff, {
      confirmed: true,
      planHash: rename.data.planHash,
    })
  ).status,
  200,
);
assert.equal((await api('/assets/' + createdId, staff)).data.asset.assetTag, renamed[1]);
const createdDetail = (await api('/assets/' + createdId, staff)).data.asset;
const createdInput = Object.fromEntries(
  Object.keys(base)
    .filter((k) => k !== 'reason')
    .map((k) => [k, createdDetail[k]]),
);
assert.equal(
  (
    await api('/assets/' + createdId + '/edit', staff, {
      ...createdInput,
      internalNotes: '合成: 明示空欄で消すメモ',
      expectedVersion: createdDetail.version,
      reason: '合成空欄確認',
    })
  ).status,
  200,
);
const clearCsv =
  'id,tag,name,type,note\n' + ['pc1', renamed[1], renamed[2], 'pc', ''].map(enc).join(',');
const clear = await api('/assets/imports/preview', staff, {
  sourceKey,
  reason: '合成の明示空欄',
  csv: clearCsv,
  mapping: { externalId: 'id', assetTag: 'tag', name: 'name', kind: 'type', internalNotes: 'note' },
});
assert.equal(clear.status, 200);
assert.equal(clear.data.counts.update, 1);
assert.equal(
  (
    await api('/assets/imports/' + clear.data.id + '/apply', staff, {
      confirmed: true,
      planHash: clear.data.planHash,
    })
  ).status,
  200,
);
const cleared = (await api('/assets/' + createdId, staff)).data.asset;
assert.equal(cleared.internalNotes, '');
assert.equal(cleared.hostname, records[1][7]);
assert.equal(cleared.state, 'in_use');
const conflictRow = [...records[0]];
conflictRow[0] = 'different-identity';
const identityConflict = await api('/assets/imports/preview', staff, {
  ...body,
  csv: csv([conflictRow]),
});
assert.equal(identityConflict.status, 200);
assert.equal(identityConflict.data.counts.error, 1);
const report = await fetch('http://127.0.0.1:3000/assets/imports/' + p.data.id + '/errors', {
  headers: { cookie: staff.cookie },
});
assert.equal(report.status, 200);
assert.match(report.headers.get('content-disposition'), /attachment/);
assert.equal((await report.json()).rows.length, 6);
// A stale preview rolls back an earlier insertion in the same batch.
const newRow = [
  'rollback',
  marker + '-ROLLBACK',
  '合成rollback',
  'saas',
  'stocked',
  'Synthetic SaaS',
  '',
  '',
  'Synthetic',
  '',
];
const stale = await api('/assets/imports/preview', staff, {
  ...body,
  csv: csv([newRow, records[0]]),
});
assert.equal(stale.status, 200);
const manualInput = Object.fromEntries(
  Object.keys(base)
    .filter((k) => k !== 'reason')
    .map((k) => [k, changed.asset[k]]),
);
assert.equal(
  (
    await api('/assets/' + manual.data.id + '/edit', staff, {
      ...manualInput,
      name: '合成: プレビュー後の編集',
      expectedVersion: 2,
      reason: '合成競合確認',
    })
  ).status,
  200,
);
assert.equal(
  (
    await api('/assets/imports/' + stale.data.id + '/apply', staff, {
      confirmed: true,
      planHash: stale.data.planHash,
    })
  ).status,
  409,
);
assert.equal((await api('/assets?q=' + marker + '-ROLLBACK', staff)).data.total, 0);
assert.equal((await api('/assets/imports/' + stale.data.id, staff)).data.receipt, null);
// Same external ID and tag are independently scoped in another organization.
const betaRow = [...records[1]];
betaRow[9] = 'requester@beta.example.test';
const beta = await api('/assets/imports/preview', betaStaff, { ...body, csv: csv([betaRow]) });
assert.equal(beta.status, 200);
assert.equal(beta.data.counts.add, 1);
assert.equal(
  (
    await api('/assets/imports/' + beta.data.id + '/apply', betaStaff, {
      confirmed: true,
      planHash: beta.data.planHash,
    })
  ).status,
  200,
);
assert.equal((await api('/assets/imports/' + beta.data.id, staff)).status, 404);
assert.equal(
  (await api('/assets/imports', betaStaff)).data.items.some((i) => i.id === p.data.id),
  false,
);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE solvi_app');
  await client.query("SELECT set_config('app.current_org',$1,true)", [
    betaStaff.data.organizationId,
  ]);
  for (const table of ['asset_import_plan', 'asset_import_receipt', 'asset_source_identity']) {
    assert.equal(
      Number(
        (
          await client.query(`SELECT count(*) FROM ${table} WHERE organization_id=$1`, [
            staff.data.organizationId,
          ])
        ).rows[0].count,
      ),
      0,
    );
  }
  await client.query('ROLLBACK');
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE solvi_app');
  await client.query("SELECT set_config('app.current_org',$1,true)", [staff.data.organizationId]);
  await assert.rejects(
    client.query('UPDATE asset_import_plan SET plan=plan WHERE id=$1', [p.data.id]),
    (e) => e.code === '42501',
  );
  await client.query('ROLLBACK');
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org',$1,true)", [staff.data.organizationId]);
  const audit = (
    await client.query(
      'SELECT event_type,count(*)::int AS count FROM audit_event WHERE target_id=$1 GROUP BY event_type',
      [p.data.id],
    )
  ).rows;
  assert.equal(audit.find((a) => a.event_type === 'asset.import.applied').count, 1);
  const counts = (
    await client.query(
      'SELECT count(*)::int AS count FROM asset_source_identity WHERE organization_id=$1 AND source_key=$2',
      [staff.data.organizationId, sourceKey],
    )
  ).rows[0].count;
  assert.equal(counts, 2);
  await client.query('ROLLBACK');
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        timestamp: new Date().toISOString(),
        previewId: p.data.id,
        createdAssetId: createdId,
        sourceKey,
        counts: p.data.counts,
        rerun: rerun.data.counts,
        checks: [
          'BOM/CRLF/quoted newline/custom mapping',
          'required columns/limits/syntax',
          'bad rows/all duplicate rows isolated',
          'explicit confirm/hash',
          'parallel apply single receipt',
          'same CSV unchanged versions/count',
          'external ID survives tag rename',
          'unmapped and omitted assets retained',
          'mapped blank clears attribute; conflicting source binding isolated; JSON error report',
          'stale whole batch rollback',
          'staff write/auditor read/requester denial',
          'API/RLS organization boundary',
          'immutable plan and single apply audit',
        ],
        audit,
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
