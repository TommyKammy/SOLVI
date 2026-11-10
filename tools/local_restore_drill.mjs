/**
 * Local, synthetic-only restore drill. No current data/credentials are exported.
 * Default: existing pinned image, no network/ports/host volumes. --runtime adds
 * explicitly isolated localhost ports to verify synthetic restored API/Web. Stops only
 * the new uniquely named container. Never accepts a restore target override.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

if (process.env.NODE_ENV === 'production') throw new Error('Local development only');
const runtimeMode = process.argv.includes('--runtime');
const runtime = runtimeMode ? await import('./local_restore_runtime.mjs') : null;
if (runtime) await runtime.checkPorts();
const image = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8').match(
  /image: (postgres:[^\s]+@sha256:[a-f0-9]{64})/,
)?.[1];
if (!image) throw new Error('Pinned PostgreSQL image missing');
const current = 'solvi-postgres-1';
const isolated = `solvi-restore-drill-${Date.now()}`;
const tables = [
  'organization',
  'app_user',
  'ticket',
  'ticket_comment',
  'local_catalog_item',
  'local_catalog_revision',
  'local_service_request',
  'local_request_revision',
  'local_request_approval',
  'local_simulation_receipt',
  'asset',
  'asset_revision',
  'asset_ticket_link',
  'asset_ticket_event',
  'audit_event',
];
if (runtimeMode) tables.push('ticket_attachment', 'role', 'role_binding');
const started = Date.now();
function docker(args, input) {
  const result = spawnSync('docker', args, {
    input,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(runtime ? { POSTGRES_PASSWORD: runtime.postgresPassword } : {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString().trim() || 'Docker failed');
  return result.stdout;
}
function sql(database, statement) {
  return docker(
    [
      'exec',
      '-i',
      isolated,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      database,
    ],
    statement,
  )
    .toString()
    .trim();
}
function sourceSql(statement) {
  return docker(
    [
      'exec',
      '-i',
      current,
      'sh',
      '-c',
      'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ],
    statement,
  )
    .toString()
    .trim();
}
// Hash all columns, deterministically sorted, without returning any row content.
const digestQuery = `SELECT jsonb_agg(to_jsonb(d) ORDER BY name) FROM (${tables
  .map(
    (t) =>
      `SELECT '${t}' AS name, count(*) AS count, md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${t} t`,
  )
  .join(' UNION ALL ')}) d;`;
const id = (n) => `10000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const quoted = (v) => `'${String(v).replaceAll("'", "''")}'`;
const insert = (table, row) =>
  `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row)
    .map((v) => (v === null ? 'NULL' : quoted(typeof v === 'object' ? JSON.stringify(v) : v)))
    .join(',')});`;
const org = id(1),
  other = id(2),
  requester = id(3),
  approver = id(4);
const incident = id(5),
  requestTicket = id(6),
  otherTicket = id(7),
  itemId = id(8);
const requestId = id(9),
  approvalId = id(10),
  assetId = id(11);
const definition = {
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成Restore対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  fields: [],
  approval: { approverId: approver },
};
const snapshot = {
  item: { id: itemId, code: 'restore-demo', version: 1, title: '合成Restore申請', definition },
  inputs: { reason: '合成Restore理由', durationDays: 7, values: {} },
};
const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const rows = [
  ['organization', { id: org, code: 'restore-one', name: '合成Restore組織1' }],
  ['organization', { id: other, code: 'restore-two', name: '合成Restore組織2' }],
  ['app_user', { id: requester, display_name: '合成Restore利用者', created_via: 'seed' }],
  ['app_user', { id: approver, display_name: '合成Restore承認者', created_via: 'seed' }],
  ...[
    [incident, org, 'INC-2026-000001', 'incident', 'new'],
    [requestTicket, org, 'REQ-2026-000001', 'request', 'resolved'],
    [otherTicket, other, 'INC-2026-000001', 'incident', 'new'],
  ].map(([ticketId, organization, number, kind, state]) => [
    'ticket',
    {
      id: ticketId,
      organization_id: organization,
      number,
      kind,
      state,
      subject: '合成Restoreチケット',
      body: '架空の本文。実データ・PIIなし。',
      requester_id: requester,
      impact: 'low',
      urgency: 'low',
      priority: 'low',
      resolved_at: state === 'resolved' ? '2026-10-03T00:00:00Z' : null,
    },
  ]),
  [
    'ticket_comment',
    {
      id: id(12),
      organization_id: org,
      ticket_id: incident,
      author_id: approver,
      visibility: 'public',
      body: '合成Restore返信',
    },
  ],
  [
    'local_catalog_item',
    {
      id: itemId,
      organization_id: org,
      code: 'restore-demo',
      version: 1,
      title: '合成Restore申請',
      description: '合成データだけの演習',
      definition,
      active: true,
      published_revision: 1,
    },
  ],
  [
    'local_catalog_revision',
    {
      item_id: itemId,
      organization_id: org,
      revision: 1,
      title: '合成Restore申請',
      description: '合成データだけの演習',
      definition,
    },
  ],
  [
    'local_service_request',
    {
      id: requestId,
      organization_id: org,
      item_id: itemId,
      requester_id: requester,
      ticket_id: requestTicket,
      idempotency_key: id(13),
      version: 1,
      revision: 1,
      state: 'completed',
      snapshot,
      snapshot_hash: snapshotHash,
      current_approval_id: approvalId,
    },
  ],
  [
    'local_request_revision',
    {
      request_id: requestId,
      organization_id: org,
      revision: 1,
      snapshot,
      snapshot_hash: snapshotHash,
      changed_by: requester,
    },
  ],
  [
    'local_request_approval',
    {
      id: approvalId,
      organization_id: org,
      request_id: requestId,
      revision: 1,
      snapshot_hash: snapshotHash,
      approver_id: approver,
      state: 'approved',
      reason: '合成承認',
      decided_at: '2026-10-03T00:00:00Z',
      expires_at: '2026-10-06T00:00:00Z',
    },
  ],
  [
    'local_simulation_receipt',
    {
      id: id(14),
      organization_id: org,
      request_id: requestId,
      approval_id: approvalId,
      snapshot_hash: snapshotHash,
      idempotency_key: 'restore-drill:synthetic',
      simulation: true,
      result: {
        status: 'succeeded',
        targetLabel: '合成Restore対象',
        durationDays: 7,
        externalChanges: 0,
        summary: '隔離演習のみ。外部変更0件。',
      },
    },
  ],
  [
    'asset',
    {
      id: assetId,
      organization_id: org,
      asset_tag: 'RESTORE-SYN-SAAS',
      name: '合成Restore資産',
      kind: 'saas',
      state: 'stocked',
      version: 1,
      created_by: requester,
    },
  ],
  [
    'asset_revision',
    {
      asset_id: assetId,
      organization_id: org,
      version: 1,
      snapshot: { assetTag: 'RESTORE-SYN-SAAS', kind: 'saas', state: 'stocked' },
      reason: '合成作成',
      changed_by: requester,
    },
  ],
  [
    'asset_ticket_link',
    { asset_id: assetId, ticket_id: incident, organization_id: org, active: true, version: 1 },
  ],
  [
    'asset_ticket_event',
    {
      id: id(16),
      asset_id: assetId,
      ticket_id: incident,
      organization_id: org,
      version: 1,
      operation: 'linked',
      reason: '合成関連付け',
      actor_id: requester,
    },
  ],
  [
    'audit_event',
    {
      event_id: id(15),
      event_type: 'ticket.created',
      organization_id: org,
      actor_type: 'system',
      action: 'create',
      outcome: 'success',
      target_type: 'ticket',
      target_id: incident,
    },
  ],
];

let created = false;
try {
  const actualImage = docker(['inspect', current, '--format', '{{.Config.Image}}'])
    .toString()
    .trim();
  if (actualImage !== image) throw new Error('Current SOLVI container does not match pinned image');
  const before = sourceSql(digestQuery);
  // Schema only. Do not use pg_dumpall or dump current data, credentials or sessions.
  const schema = docker([
    'exec',
    current,
    'sh',
    '-c',
    runtimeMode
      ? 'exec pg_dump --schema-only --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
      : 'exec pg_dump --schema-only --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  ]);
  const roles = JSON.parse(
    sourceSql(
      "SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'solvi_%';",
    ),
  );
  docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    isolated,
    ...(runtimeMode ? ['-p', '127.0.0.1:55433:5432'] : ['--network', 'none']),
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=134217728',
    '-e',
    runtimeMode ? 'POSTGRES_PASSWORD' : 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=synthetic_source',
    image,
  ]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = spawnSync('docker', [
      'exec',
      isolated,
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'synthetic_source',
    ]);
    if (r.error) throw r.error;
    if (r.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Isolated PostgreSQL not ready');
  sql(
    'postgres',
    roles
      .map((role) => {
        if (!/^solvi_[a-z_]+$/.test(role)) throw new Error('Unexpected role name');
        return `CREATE ROLE "${role}" NOLOGIN NOBYPASSRLS;`;
      })
      .join('\n') + '\nCREATE DATABASE synthetic_restore;',
  );
  docker(
    [
      'exec',
      '-i',
      isolated,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'synthetic_source',
    ],
    schema,
  );
  sql(
    'synthetic_source',
    'BEGIN;\n' +
      rows.map(([t, r]) => insert(t, r)).join('\n') +
      (runtimeMode
        ? '\nCOMMIT;'
        : '\nGRANT USAGE ON SCHEMA public TO solvi_app; GRANT SELECT ON ticket TO solvi_app;\nCOMMIT;'),
  );
  const fixtureContext = { sql, isolated, org, requester, incident, requestId, id, insert, quoted };
  if (runtime) await runtime.prepare(fixtureContext);
  const backup = docker([
    'exec',
    isolated,
    'pg_dump',
    '-Fc',
    '--no-owner',
    ...(runtimeMode
      ? ['--exclude-table-data=local_credential', '--exclude-table-data=session']
      : []),
    '-U',
    'postgres',
    '-d',
    'synthetic_source',
  ]);
  docker(
    [
      'exec',
      '-i',
      isolated,
      'pg_restore',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '-U',
      'postgres',
      '-d',
      'synthetic_restore',
    ],
    backup,
  );
  const source = sql('synthetic_source', digestQuery),
    restored = sql('synthetic_restore', digestQuery);
  if (source !== restored) throw new Error('Synthetic record mismatch');
  const sensitive = sql(
    'synthetic_restore',
    'SELECT (SELECT count(*) FROM local_credential) + (SELECT count(*) FROM session);',
  );
  if (sensitive !== '0') throw new Error('Credential/session data must remain empty');
  const rls = sql(
    'synthetic_restore',
    "SELECT jsonb_build_object('enabled',bool_and(relrowsecurity),'forced',bool_and(relforcerowsecurity)) FROM pg_class WHERE relname IN ('ticket','asset','local_service_request');",
  );
  if (rls !== '{"forced": true, "enabled": true}') throw new Error('RLS not preserved');
  const visible = (organization) =>
    sql(
      'synthetic_restore',
      `BEGIN; SET LOCAL ROLE solvi_app; SET LOCAL app.current_org='${organization}'; SELECT count(*) FROM ticket; ROLLBACK;`,
    );
  if (visible(org) !== '2' || visible(other) !== '1') throw new Error('Organization RLS failed');
  const unscoped = sql(
    'synthetic_restore',
    'BEGIN; SET LOCAL ROLE solvi_app; SELECT count(*) FROM ticket; ROLLBACK;',
  );
  if (unscoped !== '0') throw new Error('Unscoped RLS failed');
  const roleSafety = sql(
    'synthetic_restore',
    "SELECT NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname='solvi_app';",
  );
  if (roleSafety !== 't') throw new Error('Unsafe app role');
  const runtimeResults = runtime ? await runtime.verify(fixtureContext) : null;
  const after = sourceSql(digestQuery);
  if (before !== after)
    throw new Error('Current business data changed during drill; investigate concurrent writes');
  console.log(
    JSON.stringify(
      {
        isolatedContainer: isolated,
        image,
        seconds: (Date.now() - started) / 1000,
        backupBytes: backup.length,
        tables: JSON.parse(restored),
        rls: JSON.parse(rls),
        visibleByOrganization: [2, 1],
        unscopedVisible: 0,
        appRoleNonSuperuserNoBypass: true,
        credentialsAndSessions: 0,
        currentBusinessDataUnchanged: true,
        ...(runtimeResults ? { runtime: runtimeResults } : {}),
        limitations: [
          'Schema and selected synthetic records only',
          ...(runtimeMode ? [] : ['No API/Web restart against restored DB']),
          runtimeMode
            ? 'No other-PC/PITR/KMS/production RPO or RTO validation'
            : 'No object bytes/PITR/KMS/production RPO or RTO validation',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (runtime) await runtime.cleanup();
  if (created) docker(['stop', isolated]);
}
