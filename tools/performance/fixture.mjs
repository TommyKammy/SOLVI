import { createHash, randomBytes } from 'node:crypto';
import { validateProfile } from './workload.mjs';

const id = (kind, n) => `04100000-0000-4000-${kind}-${String(n).padStart(12, '0')}`;
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
// Match the existing catalog contract's snapshot hash without importing runtime services.
const canonical = (value) => {
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
};

/** Only the supervisor may supply a client for its already verified, owned database. */
export async function seedFixture(admin, profile, { createCredential, databaseName } = {}) {
  validateProfile(profile);
  check(typeof createCredential === 'function', 'FIXTURE_CREDENTIAL_SERVICE_REQUIRED');
  check(/^solvi_perf041_[a-z0-9_]+$/.test(databaseName ?? ''), 'FIXTURE_DATABASE_NAME_REJECTED');
  const identity = await admin.query('SELECT current_database() AS database');
  check(identity.rows[0]?.database === databaseName, 'FIXTURE_DATABASE_MISMATCH');
  const organizations = await admin.query(
    "SELECT id,code FROM organization WHERE code IN ('acme','beta')",
  );
  const organizationId = organizations.rows.find((r) => r.code === 'acme')?.id;
  const controlOrganizationId = organizations.rows.find((r) => r.code === 'beta')?.id;
  check(organizationId && controlOrganizationId, 'FIXTURE_BASE_SEED_REQUIRED');
  const password = randomBytes(32).toString('base64url');
  const actors = [];
  const activeRoles = Object.entries(profile.roles).flatMap(([role, count]) =>
    Array(count).fill(role),
  );
  let counts;
  let catalogItemId;
  const serviceRequestId = id('8004', 1);
  const controlTicketId = id('8002', 999999);
  try {
    await admin.query('BEGIN');
    const before = await admin.query(
      'SELECT count(DISTINCT user_id)::int n FROM role_binding WHERE organization_id=$1',
      [organizationId],
    );
    const ticketCount = await admin.query(
      'SELECT count(*)::int n FROM ticket WHERE organization_id=$1',
      [organizationId],
    );
    const existingFixture = await admin.query(
      "SELECT count(*)::int n FROM app_user WHERE primary_email::text LIKE 'perf041-%@example.test'",
    );
    check(existingFixture.rows[0].n === 0, 'FIXTURE_ALREADY_SEEDED');
    const additional = profile.users - before.rows[0].n;
    const additionalTickets = profile.tickets - ticketCount.rows[0].n;
    check(
      additional >= profile.activeSessions && additionalTickets >= additional,
      'FIXTURE_EXISTING_COUNTS_INVALID',
    );
    const users = Array.from({ length: additional }, (_, index) => ({
      id: id('8001', index + 1),
      email: `perf041-${index + 1}@example.test`,
      role: activeRoles[index % activeRoles.length],
    }));
    await admin.query(
      `INSERT INTO app_user(id,primary_email,display_name,status,created_via)
       SELECT x.id::uuid,x.email,'合成利用者 '||x.ordinal,'active','seed'
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,email text,ordinal int)`,
      [JSON.stringify(users.map((u, index) => ({ ...u, ordinal: index + 1 })))],
    );
    // Reuse the application's only credential writer, including identity, validation,
    // session revocation and audit. Non-active directory fixture users need no login.
    for (const user of users.slice(0, profile.activeSessions)) {
      const credential = await createCredential({
        userId: user.id,
        subject: user.email,
        password,
      });
      check(credential?.ok === true, 'FIXTURE_CREDENTIAL_REJECTED');
    }
    await admin.query(
      `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source)
       SELECT gen_random_uuid(),x.id::uuid,r.id,r.scope,$2,'seed'
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,role text)
       JOIN role r ON r.code=CASE WHEN x.role='admin' THEN 'org_admin' ELSE x.role END`,
      [JSON.stringify(users), organizationId],
    );
    const administrator = users.find((u) => u.role === 'admin');
    // This actor reads an actual pending approval; no decisions or privileged operations run.
    await admin.query(
      `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source)
       SELECT gen_random_uuid(),$1,r.id,r.scope,$2,'seed' FROM role r WHERE r.code='approver'`,
      [administrator.id, organizationId],
    );
    const groupRows = await admin.query(
      'SELECT id FROM assignment_group WHERE organization_id=$1 ORDER BY code',
      [organizationId],
    );
    check(groupRows.rows.length >= 2, 'FIXTURE_GROUPS_REQUIRED');
    const groups = groupRows.rows.map((r) => r.id);
    const agents = users.filter((u) => u.role === 'agent');
    const requesters = users.filter((u) => u.role === 'requester');
    await admin.query(
      `INSERT INTO assignment_group_member(group_id,user_id,organization_id)
       SELECT g,u,$3 FROM unnest($1::uuid[]) g CROSS JOIN unnest($2::uuid[]) u`,
      [groups, agents.map((u) => u.id), organizationId],
    );
    await admin.query(
      `INSERT INTO ticket(id,organization_id,number,kind,state,subject,body,requester_id,
         assignee_id,assignee_group_id,impact,urgency,priority,created_at,resolved_at,closed_at,
         sla_clock_started_at,sla_elapsed_seconds,pending_reason)
       SELECT ('04100000-0000-4000-8002-'||lpad(g::text,12,'0'))::uuid,$1,
         'PERF041-'||lpad(g::text,7,'0'),CASE WHEN g=1 OR g%3=0 THEN 'request' ELSE 'incident' END,
         (ARRAY['new','assigned','in_progress','pending','resolved','closed','cancelled'])[1+g%7],
         '合成性能問い合わせ '||g,'隔離性能測定用の合成本文です。'||repeat('追加説明。',g%20),
         ($3::uuid[])[1+(g-1)%cardinality($3::uuid[])],
         CASE WHEN g%7=0 OR g%5=0 THEN NULL ELSE ($4::uuid[])[1+(g-1)%cardinality($4::uuid[])] END,
         CASE WHEN g%3=0 THEN NULL ELSE ($5::uuid[])[1+g%cardinality($5::uuid[])] END,
         (ARRAY['low','medium','high','high'])[1+g%4],
         (ARRAY['low','medium','medium','high'])[1+g%4],
         (ARRAY['low','medium','high','critical'])[1+g%4],
         now()-(2+g%720)*interval '1 hour',
         CASE WHEN g%7 IN (4,5) THEN now()-(1+g%720)*interval '1 hour' END,
         CASE WHEN g%7=5 THEN now()-(g%720)*interval '1 hour' END,
         CASE WHEN g%7 IN (0,1,2) THEN now()-(2+g%720)*interval '1 hour' END,
         g%18000,
         CASE WHEN g%7=3 THEN CASE WHEN g%2=0 THEN 'wait_requester' ELSE 'wait_external' END END
       FROM generate_series(1,$2::int) g`,
      [
        organizationId,
        additionalTickets,
        requesters.map((u) => u.id),
        agents.map((u) => u.id),
        groups,
      ],
    );
    for (const user of users.slice(0, profile.activeSessions)) {
      const ordinal =
        user.role === 'requester' ? requesters.findIndex((u) => u.id === user.id) + 1 : 1;
      const actor = {
        userId: user.id,
        email: user.email,
        role: user.role,
        ticketId: id('8002', ordinal),
        ticketSubject: `合成性能問い合わせ ${ordinal}`,
      };
      Object.defineProperty(actor, 'password', { value: password, enumerable: false });
      actors.push(actor);
    }
    await admin.query(
      `INSERT INTO ticket_comment(id,organization_id,ticket_id,author_id,visibility,body)
       SELECT gen_random_uuid(),t.organization_id,t.id,t.requester_id,'public','合成コメント'
       FROM ticket t WHERE organization_id=$1 AND number LIKE 'PERF041-%'
       ORDER BY number LIMIT $2`,
      [organizationId, Math.min(additionalTickets, 1000)],
    );
    const controlUser = await admin.query(
      `SELECT rb.user_id FROM role_binding rb JOIN role r ON r.id=rb.role_id
       WHERE rb.organization_id=$1 AND r.code='requester' ORDER BY rb.user_id LIMIT 1`,
      [controlOrganizationId],
    );
    check(controlUser.rows.length === 1, 'FIXTURE_CONTROL_USER_REQUIRED');
    await admin.query(
      `INSERT INTO ticket(id,organization_id,number,kind,state,subject,body,requester_id,impact,urgency,priority)
       VALUES($1,$2,'PERF041-CONTROL','incident','new','別組織の合成問い合わせ','越境拒否確認専用',$3,'low','low','low')`,
      [controlTicketId, controlOrganizationId, controlUser.rows[0].user_id],
    );
    catalogItemId = id('8003', 1);
    const definition = {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '合成検証サービス',
      allowedDurations: [1, 7, 30],
      maxReasonLength: 2000,
    };
    await admin.query(
      `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,published_revision)
       VALUES($1,$2,'perf041-service',1,'合成サービス申請','隔離試験のための模擬サービス',$3,1)`,
      [catalogItemId, organizationId, definition],
    );
    await admin.query(
      `INSERT INTO local_catalog_revision(item_id,organization_id,revision,title,description,definition)
       SELECT id,organization_id,1,title,description,definition FROM local_catalog_item WHERE id=$1`,
      [catalogItemId],
    );
    const snapshot = {
      item: { id: catalogItemId, version: 1, title: '合成サービス申請', definition },
      inputs: { reason: '合成性能測定用', durationDays: 7 },
      requesterId: requesters[0].id,
    };
    const snapshotHash = createHash('sha256').update(canonical(snapshot)).digest('hex');
    const approvalId = id('8005', 1);
    await admin.query(
      `INSERT INTO local_service_request(id,organization_id,item_id,requester_id,ticket_id,idempotency_key,version,revision,state,snapshot,snapshot_hash,current_approval_id)
       VALUES($1,$2,$3,$4,$5,$1,1,1,'pending',$6,$7,$8)`,
      [
        serviceRequestId,
        organizationId,
        catalogItemId,
        requesters[0].id,
        id('8002', 1),
        snapshot,
        snapshotHash,
        approvalId,
      ],
    );
    await admin.query(
      `INSERT INTO local_request_revision(request_id,organization_id,revision,snapshot,snapshot_hash,changed_by)
       VALUES($1,$2,1,$3,$4,$5)`,
      [serviceRequestId, organizationId, snapshot, snapshotHash, requesters[0].id],
    );
    await admin.query(
      `INSERT INTO local_request_approval(id,organization_id,request_id,revision,snapshot_hash,approver_id,state,expires_at)
       VALUES($1,$2,$3,1,$4,$5,'pending',now()+interval '72 hours')`,
      [approvalId, organizationId, serviceRequestId, snapshotHash, administrator.id],
    );
    const count = async (sql, values = [organizationId]) => (await admin.query(sql, values)).rows;
    counts = {
      users: (
        await count(
          'SELECT count(DISTINCT user_id)::int n FROM role_binding WHERE organization_id=$1',
        )
      )[0].n,
      tickets: (await count('SELECT count(*)::int n FROM ticket WHERE organization_id=$1'))[0].n,
      usersByStatus: await count(
        'SELECT u.status,count(DISTINCT u.id)::int n FROM app_user u JOIN role_binding r ON r.user_id=u.id WHERE r.organization_id=$1 GROUP BY u.status ORDER BY u.status',
      ),
      roles: await count(
        'SELECT r.code,count(DISTINCT rb.user_id)::int n FROM role_binding rb JOIN role r ON r.id=rb.role_id WHERE rb.organization_id=$1 GROUP BY r.code ORDER BY r.code',
      ),
      states: await count(
        'SELECT state,count(*)::int n FROM ticket WHERE organization_id=$1 GROUP BY state ORDER BY state',
      ),
      priorities: await count(
        'SELECT priority,count(*)::int n FROM ticket WHERE organization_id=$1 GROUP BY priority ORDER BY priority',
      ),
      assignment: await count(
        'SELECT (assignee_id IS NULL) AS unassigned,(assignee_group_id IS NULL) AS ungrouped,count(*)::int n FROM ticket WHERE organization_id=$1 GROUP BY 1,2 ORDER BY 1,2',
      ),
      groups: (
        await count('SELECT count(*)::int n FROM assignment_group WHERE organization_id=$1')
      )[0].n,
      memberships: (
        await count('SELECT count(*)::int n FROM assignment_group_member WHERE organization_id=$1')
      )[0].n,
      comments: (
        await count('SELECT count(*)::int n FROM ticket_comment WHERE organization_id=$1')
      )[0].n,
      catalog: (
        await count('SELECT count(*)::int n FROM local_catalog_item WHERE organization_id=$1')
      )[0].n,
      approvals: (
        await count('SELECT count(*)::int n FROM local_request_approval WHERE organization_id=$1')
      )[0].n,
      credentials: (
        await count(
          'SELECT count(DISTINCT c.id)::int n FROM local_credential c JOIN role_binding rb ON rb.user_id=c.user_id WHERE rb.organization_id=$1',
        )
      )[0].n,
      readReceipts: (
        await count('SELECT count(*)::int n FROM work_inbox_read_receipt WHERE organization_id=$1')
      )[0].n,
      attachments: (
        await count('SELECT count(*)::int n FROM ticket_attachment WHERE organization_id=$1')
      )[0].n,
      controlUsers: (
        await count(
          'SELECT count(DISTINCT user_id)::int n FROM role_binding WHERE organization_id=$1',
          [controlOrganizationId],
        )
      )[0].n,
      controlTickets: (
        await count('SELECT count(*)::int n FROM ticket WHERE organization_id=$1', [
          controlOrganizationId,
        ])
      )[0].n,
    };
    check(
      counts.users === profile.users && counts.tickets === profile.tickets,
      'FIXTURE_COUNTS_MISMATCH',
    );
    await admin.query('COMMIT');
    await admin.query('ANALYZE');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    // Driver details can contain bound credential values. Return only fixed diagnostic codes.
    throw new Error(
      /^FIXTURE_[A-Z_]+$/.test(error.message) ? error.message : 'FIXTURE_PREPARATION_FAILED',
    );
  }
  const fixture = {
    organizationId,
    controlOrganizationId,
    controlTicketId,
    catalogItemId,
    serviceRequestId,
    counts,
  };
  Object.defineProperty(fixture, 'actors', { value: actors, enumerable: false });
  return fixture;
}
