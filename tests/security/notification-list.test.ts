/** WP-P2-NTFUI-056 / ADR-0038: actual PostgreSQL, auth sessions and application RLS. */
// FR-TKT-007, NFR-SEC-001, NFR-SEC-006: real auth, org isolation and safe state visibility.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { newContext, runWithContext, SESSION_COOKIE_NAME } from '@solvi/shared';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { AuthController } from '../../services/api/src/modules/auth/auth.routes.js';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import {
  NotificationListController,
  type NotificationListResponse,
} from '../../services/api/src/modules/notification/notification.routes.js';
import { createKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/isolated-knowledge-db.mjs';
import { createCiKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs';
import {
  readKnowledgeFixture,
  type KnowledgeFixture,
} from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';

// This suite owns a new disposable database. Development DB URLs are never accepted.
// The immutable WP054 helper's physical label and source proof remain WP054-specific.
let runtime:
  | Awaited<ReturnType<typeof createKnowledgeDatabase>>
  | Awaited<ReturnType<typeof createCiKnowledgeDatabase>>
  | undefined;
let admin: pg.Client;
let pool: pg.Pool;
let fixture: KnowledgeFixture;
let authController: AuthController;
let controller: NotificationListController;
let verifiedRlsTables = 0;
type Status = 'pending' | 'sent' | 'failed';
type Filter = 'all' | Status;
type OutboxState = 'waiting' | 'processing' | 'finished' | 'stopped';
type TestSession = { userId: string; sessionId: string; headers: { cookie: string } };
const sessions: Record<string, TestSession> = {};
const stateRows: Array<{
  id: string;
  status: Status;
  outboxStatus: NotificationListResponse['items'][number]['outboxStatus'];
  nextAttempt: boolean;
}> = [];
const canary = 'NTF056_PRIVATE_SYNTHETIC';
const eventTypes = [
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.reassessed',
  'role.binding.expiring',
] as const;
const evidencePath = new URL(
  '../../evidence/WP-P2-NTFUI-056/20261008/database-lifecycle.json',
  import.meta.url,
);

async function issue(userId: string, organizationId: string | null): Promise<TestSession> {
  const issued = await new SessionService(admin).issue({
    userId,
    organizationId,
    authMethod: 'local',
  });
  // Plain tokens exist only in memory and are never asserted, reported, or logged.
  return {
    userId,
    sessionId: issued.session.id,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${issued.token}` },
  };
}

async function actor(
  name: string,
  role: string,
  roleOrganization: string | null = fixture.organizationId,
  selectedOrganization: string | null = fixture.organizationId,
): Promise<TestSession> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO app_user(id,primary_email,display_name,status,created_via)
     VALUES($1,$2,$3,'active','seed')`,
    [id, `${name}-${id}@ntf056.test`, `Synthetic ${name}`],
  );
  const bound = await admin.query(
    `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source,valid_from)
     SELECT $1,$2,id,scope,$3,'manual',now()-interval '2 days' FROM role WHERE code=$4`,
    [uuidv7(), id, roleOrganization, role],
  );
  expect(bound.rowCount).toBe(1);
  return issue(id, selectedOrganization);
}

async function outbox(
  organizationId: string,
  state: OutboxState = 'waiting',
  eventType: string = 'ticket.created',
): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO outbox_event(id,organization_id,event_type,payload,available_at,
       locked_until,processed_at,failed_at,last_error)
     VALUES($1,$2,$3,$4::jsonb,now()+interval '10 minutes',
       CASE WHEN $5='processing' THEN now()+interval '1 hour'
            WHEN $5 IN ('finished','stopped') THEN now()+interval '1 hour' ELSE NULL END,
       CASE WHEN $5='finished' THEN now() ELSE NULL END,
       CASE WHEN $5='stopped' THEN now() ELSE NULL END,
       CASE WHEN $5='stopped' THEN $6 ELSE NULL END)`,
    [id, organizationId, eventType, JSON.stringify({ private: canary }), state, canary],
  );
  return id;
}

async function notification(
  organizationId: string,
  status: Status,
  outboxId: string | null,
  createdAt = '2030-01-01T00:00:00.000001Z',
  channel: 'email' | 'webhook' = 'email',
): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO notification(id,organization_id,outbox_event_id,channel,recipient_user_id,
       recipient_address,subject,link_path,status,sent_at,failed_at,last_error,attempts,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
       CASE WHEN $9='sent' THEN now() ELSE NULL END,
       CASE WHEN $9='failed' THEN now() ELSE NULL END,
       CASE WHEN $9='failed' THEN $7 ELSE NULL END,2,$10::timestamptz)`,
    [
      id,
      organizationId,
      outboxId,
      channel,
      fixture.actors.requester.userId,
      `${canary}-${id}@example.test`,
      canary,
      `/${canary}`,
      status,
      createdAt,
    ],
  );
  return id;
}

beforeAll(async () => {
  runtime =
    process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
      ? await createCiKnowledgeDatabase()
      : await createKnowledgeDatabase();
  admin = new pg.Client({ connectionString: runtime.adminUrl, statement_timeout: 10000 });
  await admin.connect();
  pool = new pg.Pool({ connectionString: runtime.appUrl, max: 5, statement_timeout: 10000 });
  const proof = (
    await pool.query(
      `SELECT current_user AS role,r.rolsuper,r.rolbypassrls,c.relname,
       c.relowner=r.oid AS owns_table,c.relrowsecurity,c.relforcerowsecurity,
       current_setting('row_security') AS row_security
     FROM pg_roles r CROSS JOIN pg_class c
     WHERE r.rolname=current_user AND c.oid IN ('notification'::regclass,'outbox_event'::regclass)`,
    )
  ).rows;
  expect(proof).toHaveLength(2);
  for (const row of proof)
    expect(row).toMatchObject({
      role: 'solvi_app',
      rolsuper: false,
      rolbypassrls: false,
      owns_table: false,
      relrowsecurity: true,
      relforcerowsecurity: true,
      row_security: 'on',
    });
  verifiedRlsTables = proof.length;
  fixture = await readKnowledgeFixture(admin);
  authController = new AuthController(pool, {
    localAuthEnabled: true,
    cookieSecure: false,
    localAuth: { maxFailedAttempts: 5, lockoutSeconds: 60 },
  });
  controller = new NotificationListController({
    pool,
    denialRecorder: new PoolDenialRecorder(pool),
  });
  for (const name of ['admin', 'agent', 'requester'] as const)
    sessions[name] = await issue(fixture.actors[name].userId, fixture.organizationId);
  for (const role of ['approver', 'auditor']) sessions[role] = await actor(role, role);
  sessions.platform = await actor('platform', 'platform_admin', null);
  sessions.secondAdmin = await actor('second-admin', 'org_admin');
  sessions.foreignAdmin = await actor(
    'foreign-admin',
    'org_admin',
    fixture.controlOrganizationId,
    fixture.controlOrganizationId,
  );
  await admin.query(
    `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source,valid_from)
     SELECT $1,$2,id,scope,$3,'manual',now()-interval '2 days' FROM role WHERE code='org_admin'`,
    [uuidv7(), fixture.actors.admin.userId, fixture.controlOrganizationId],
  );
  sessions.sameActorOtherOrg = await issue(
    fixture.actors.admin.userId,
    fixture.controlOrganizationId,
  );
  sessions.wrongOrg = await actor(
    'wrong-org',
    'org_admin',
    fixture.controlOrganizationId,
    fixture.organizationId,
  );
  sessions.expiredRole = await actor('expired-role', 'org_admin');
  await admin.query(
    `UPDATE role_binding SET valid_until=now()-interval '1 minute' WHERE user_id=$1`,
    [sessions.expiredRole.userId],
  );
  sessions.noOrg = await issue(fixture.actors.admin.userId, null);
  for (const name of ['inactive', 'revoked', 'expiredSession', 'roleChanged'])
    sessions[name] = await actor(name, 'org_admin');
  await admin.query(`UPDATE app_user SET status='deactivated',deactivated_at=now() WHERE id=$1`, [
    sessions.inactive.userId,
  ]);
  await admin.query(
    `UPDATE session SET revoked_at=now(),revoked_reason='admin_revoked' WHERE id=$1`,
    [sessions.revoked.sessionId],
  );
  await admin.query(
    `UPDATE session SET issued_at=now()-interval '2 days',
    absolute_expires_at=now()-interval '1 day',idle_expires_at=now()-interval '1 day',
    last_seen_at=now()-interval '2 days' WHERE id=$1`,
    [sessions.expiredSession.sessionId],
  );

  // More than two pages; exact timestamp ties plus distinct PostgreSQL microseconds.
  for (let i = 0; i < 45; i++) {
    const event = await outbox(
      fixture.organizationId,
      'waiting',
      eventTypes[i % eventTypes.length],
    );
    await notification(
      fixture.organizationId,
      ['pending', 'sent', 'failed'][i % 3] as Status,
      event,
      i < 23 ? '2030-01-01T00:00:00.000002Z' : '2030-01-01T00:00:00.000001Z',
      i % 2 ? 'email' : 'webhook',
    );
  }
  for (const status of ['pending', 'sent', 'failed'] as const) {
    for (const state of ['waiting', 'processing', 'finished', 'stopped'] as const) {
      const id = await notification(
        fixture.organizationId,
        status,
        await outbox(fixture.organizationId, state),
        '2029-01-01T00:00:00.000001Z',
      );
      stateRows.push({
        id,
        status,
        outboxStatus: state === 'waiting' && status === 'failed' ? 'retry_waiting' : state,
        nextAttempt: state === 'waiting' && status !== 'sent',
      });
    }
  }
  for (const event of [null, await outbox(fixture.controlOrganizationId)]) {
    const id = await notification(
      fixture.organizationId,
      'failed',
      event,
      '2029-01-01T00:00:00.000001Z',
    );
    stateRows.push({ id, status: 'failed', outboxStatus: 'unknown', nextAttempt: false });
  }
  await notification(
    fixture.organizationId,
    'pending',
    await outbox(fixture.organizationId, 'waiting', `${canary}_event`),
    '2029-01-01T00:00:00.000001Z',
  );
  const sharedEvent = await outbox(fixture.organizationId);
  await notification(fixture.organizationId, 'pending', sharedEvent, '2029-01-01T00:00:00.000001Z');
  await notification(fixture.organizationId, 'pending', sharedEvent, '2029-01-01T00:00:00.000001Z');
  await notification(
    fixture.controlOrganizationId,
    'sent',
    await outbox(fixture.controlOrganizationId),
    '2031-01-01T00:00:00.000001Z',
  );
}, 240000);

afterAll(async () => {
  const closed = await Promise.allSettled([pool?.end(), admin?.end()]);
  const cleanup = await runtime?.cleanup();
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        workPackage: 'WP-P2-NTFUI-056',
        lifecycleHelper: 'WP-P3-KNWUI-054 (read-only reuse; physical label unchanged)',
        syntheticOnly: true,
        verificationTransport:
          'public controller with actual SessionService/AuthController; HTTP separately required',
        nonOwnerForcedRlsTables: verifiedRlsTables,
        connectionsClosed: closed.every((result) => result.status === 'fulfilled'),
        cleanup,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
  if (cleanup) expect(cleanup.success).toBe(true);
}, 60000);

async function request(
  session = sessions.admin,
  query = new URLSearchParams(),
  target = controller,
): Promise<NotificationListResponse> {
  return runWithContext(newContext(), async () => {
    const auth = await authController.authenticate(session.headers);
    const response = await target.list(auth, query);
    expect(response.status).toBe(200);
    return response.body;
  });
}

async function oracle(organizationId: string, status: Filter = 'all'): Promise<string[]> {
  const result = await admin.query<{ id: string }>(
    `SELECT id FROM notification WHERE organization_id=$1
     AND ($2='all' OR status=$2) ORDER BY created_at DESC,id DESC`,
    [organizationId, status],
  );
  return result.rows.map((row) => row.id);
}

async function counts(organizationId: string): Promise<NotificationListResponse['counts']> {
  const result = await admin.query<{ status: Status; count: number }>(
    `SELECT status,count(*)::integer AS count FROM notification WHERE organization_id=$1 GROUP BY status`,
    [organizationId],
  );
  const value = { all: 0, pending: 0, sent: 0, failed: 0 };
  for (const row of result.rows) {
    value[row.status] = row.count;
    value.all += row.count;
  }
  return value;
}

async function pages(session = sessions.admin, status: Filter = 'all') {
  const result: NotificationListResponse[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const query = new URLSearchParams({ status, direction: 'next' });
    if (cursor) query.set('cursor', cursor);
    const page = await request(session, query);
    result.push(page);
    expect(page.items.length).toBeLessThanOrEqual(20);
    cursor = page.nextCursor;
    if (!cursor) return result;
  }
  throw new Error('NTF056_PAGINATION_DID_NOT_TERMINATE');
}

async function digest() {
  const result = await admin.query<{ notifications: string; outbox: string }>(
    `SELECT (SELECT md5(coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id)::text,'[]'))
      FROM notification n) AS notifications,
      (SELECT md5(coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id)::text,'[]'))
      FROM outbox_event o) AS outbox`,
  );
  return result.rows[0];
}

describe('WP056 notification visibility: actual application role and sessions', () => {
  it('returns only the fixed safe DTO and recording delivery semantics', async () => {
    const all = await pages();
    const expectedKeys = [
      'id',
      'eventType',
      'channel',
      'status',
      'createdAt',
      'sentAt',
      'failedAt',
      'attempts',
      'outboxStatus',
      'nextAttemptAt',
      'manualRetry',
    ].sort();
    for (const page of all) {
      expect(Object.keys(page).sort()).toEqual(
        ['items', 'counts', 'total', 'previousCursor', 'nextCursor', 'deliveryMode'].sort(),
      );
      expect(Object.keys(page.counts).sort()).toEqual(['all', 'pending', 'sent', 'failed'].sort());
      expect(page.deliveryMode).toBe('recording');
      expect(JSON.stringify(page)).not.toContain(canary);
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(expectedKeys);
        expect([...eventTypes, 'other']).toContain(item.eventType);
        expect(['email', 'webhook', 'other']).toContain(item.channel);
        expect(['check_required', 'reserved', 'unavailable']).toContain(item.manualRetry);
        expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        expect(Number.isInteger(item.attempts)).toBe(true);
      }
    }
  });

  it.each(['requester', 'agent', 'approver', 'auditor', 'platform', 'wrongOrg', 'expiredRole'])(
    'rejects %s without a currently valid selected-org admin binding',
    async (name) => {
      await expect(request(sessions[name])).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(['inactive', 'revoked', 'expiredSession'])(
    'rejects %s through actual session validation',
    async (name) => {
      await expect(request(sessions[name])).rejects.toMatchObject({ status: 401 });
    },
  );

  it('requires an active organization selection', async () => {
    await expect(request(sessions.noOrg)).rejects.toMatchObject({ status: 403 });
  });

  it('reloads role validity on a later request with the same session', async () => {
    expect((await request(sessions.roleChanged)).counts.all).toBeGreaterThan(0);
    await admin.query(
      `UPDATE role_binding SET valid_until=now()-interval '1 minute' WHERE user_id=$1`,
      [sessions.roleChanged.userId],
    );
    await expect(request(sessions.roleChanged)).rejects.toMatchObject({ status: 403 });
  });

  it('scopes a valid foreign-org admin to its own rows and counts', async () => {
    const result = await pages(sessions.foreignAdmin);
    expect(result.flatMap((page) => page.items.map((item) => item.id))).toEqual(
      await oracle(fixture.controlOrganizationId),
    );
    expect(result[0].counts).toEqual(await counts(fixture.controlOrganizationId));
  });

  it('enforces direct SELECT RLS for both tables using a non-owner, non-bypass role', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [fixture.organizationId]);
      for (const table of ['notification', 'outbox_event']) {
        const visible = await client.query(`SELECT DISTINCT organization_id FROM ${table}`);
        expect(visible.rows.length).toBeGreaterThan(0);
        expect(visible.rows.every((row) => row.organization_id === fixture.organizationId)).toBe(
          true,
        );
        const foreign = await client.query(`SELECT id FROM ${table} WHERE organization_id=$1`, [
          fixture.controlOrganizationId,
        ]);
        expect(foreign.rows).toEqual([]);
      }
      await client.query("SELECT set_config('app.current_org','',true)");
      for (const table of ['notification', 'outbox_event'])
        expect((await client.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('distinguishes notification and Outbox states with terminal precedence and safe unknown joins', async () => {
    const items = (await pages()).flatMap((page) => page.items);
    for (const expected of stateRows) {
      const item = items.find((entry) => entry.id === expected.id);
      expect(item).toMatchObject({ status: expected.status, outboxStatus: expected.outboxStatus });
      expect(item?.nextAttemptAt !== null).toBe(expected.nextAttempt);
      expect(item?.sentAt !== null).toBe(expected.status === 'sent');
      expect(item?.failedAt !== null).toBe(expected.status === 'failed');
      if (expected.outboxStatus === 'unknown') expect(item?.eventType).toBe('other');
    }
    expect(items.map((item) => item.eventType)).toContain('other');
    for (const type of eventTypes) expect(items.map((item) => item.eventType)).toContain(type);
  });

  it.each(['all', 'pending', 'sent', 'failed'] as const)(
    'counts notification rows and filters %s independently of total counts',
    async (status) => {
      const result = await pages(sessions.admin, status);
      const expected = await counts(fixture.organizationId);
      const ids = result.flatMap((page) => page.items.map((item) => item.id));
      expect(ids).toEqual(await oracle(fixture.organizationId, status));
      expect(new Set(ids).size).toBe(ids.length);
      for (const page of result) {
        expect(page.counts).toEqual(expected);
        expect(page.total).toBe(expected[status]);
        if (status !== 'all') expect(page.items.every((item) => item.status === status)).toBe(true);
      }
      const events = await admin.query<{ count: number }>(
        'SELECT count(DISTINCT outbox_event_id)::integer AS count FROM notification WHERE organization_id=$1',
        [fixture.organizationId],
      );
      expect(expected.all).toBeGreaterThan(events.rows[0].count);
    },
  );

  it('traverses microsecond boundaries and exact timestamp ties without gaps or duplicates', async () => {
    const result = await pages();
    const ids = result.flatMap((page) => page.items.map((item) => item.id));
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].items).toHaveLength(20);
    expect(result[1].items).toHaveLength(20);
    expect(result[0].previousCursor).toBeNull();
    expect(result.at(-1)?.nextCursor).toBeNull();
    expect(ids).toEqual(await oracle(fixture.organizationId));
    expect(new Set(ids).size).toBe(ids.length);
    const timestamps = result.flatMap((page) => page.items.map((item) => item.createdAt));
    for (const timestamp of [
      '2030-01-01T00:00:00.000002Z',
      '2030-01-01T00:00:00.000001Z',
      '2029-01-01T00:00:00.000001Z',
    ])
      expect(timestamps).toContain(timestamp);
    for (const page of result)
      for (const cursor of [page.previousCursor, page.nextCursor])
        if (cursor) expect(cursor.length).toBeLessThanOrEqual(168);
  });

  it('returns the preceding page in descending order and supports a forward round trip', async () => {
    const first = await request();
    const second = await request(
      sessions.admin,
      new URLSearchParams({ direction: 'next', cursor: first.nextCursor! }),
    );
    const previous = await request(
      sessions.admin,
      new URLSearchParams({ direction: 'previous', cursor: second.previousCursor! }),
    );
    expect(previous.items).toEqual(first.items);
    expect(previous.previousCursor).toBeNull();
    const forward = await request(
      sessions.admin,
      new URLSearchParams({ direction: 'next', cursor: previous.nextCursor! }),
    );
    expect(forward.items).toEqual(second.items);
  });

  it('rejects cursor reuse by another actor, organization, filter or direction', async () => {
    const first = await request();
    const cursor = first.nextCursor!;
    for (const session of [sessions.secondAdmin, sessions.sameActorOtherOrg])
      await expect(request(session, new URLSearchParams({ cursor }))).rejects.toMatchObject({
        status: 400,
      });
    for (const query of [
      new URLSearchParams({ cursor, status: 'failed' }),
      new URLSearchParams({ cursor, direction: 'previous' }),
    ])
      await expect(request(sessions.admin, query)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    'status=',
    'status=bogus',
    'status=sent&status=failed',
    'direction=',
    'direction=previous',
    'direction=sideways',
    'cursor=',
    'cursor=invalid!',
    'cursor=abc&cursor=def',
    'limit=100',
    'q=private',
    'direction=next&direction=next',
  ])('rejects malformed or unsupported query %s', async (query) => {
    await expect(request(sessions.admin, new URLSearchParams(query))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('keeps counts, rows and cursors in one read-only repeatable-read snapshot during a concurrent insert', async () => {
    const before = await counts(fixture.organizationId);
    const beforeIds = await oracle(fixture.organizationId);
    let inserted: string | undefined;
    const sql: string[] = [];
    const observedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(text: string, params?: unknown[]) {
            sql.push(text);
            const result = await client.query(text, params);
            if (!inserted && /count\(\*\)::text AS all/.test(text)) {
              // A second real owner connection commits after the reader's count snapshot.
              inserted = await notification(
                fixture.organizationId,
                'pending',
                null,
                '2032-01-01T00:00:00.000001Z',
              );
            }
            return result;
          },
          release() {
            client.release();
          },
        };
      },
    } as unknown as pg.Pool;
    const result = await request(
      sessions.admin,
      new URLSearchParams(),
      new NotificationListController({ pool: observedPool }),
    );
    expect(inserted).toBeDefined();
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(result.counts).toEqual(before);
    expect(result.total).toBe(before.all);
    expect(result.items.map((item) => item.id)).toEqual(beforeIds.slice(0, 20));
    expect(result.previousCursor).toBeNull();
    expect(result.nextCursor).not.toBeNull();
    const current = await request();
    expect(current.counts.all).toBe(before.all + 1);
    expect(current.items[0].id).toBe(inserted);
  });

  it('does not mutate any notification or Outbox business row while reading filters and pages', async () => {
    const before = await digest();
    for (const status of ['all', 'pending', 'sent', 'failed'] as const)
      await pages(sessions.admin, status);
    await pages(sessions.foreignAdmin);
    await expect(request(sessions.requester)).rejects.toMatchObject({ status: 403 });
    expect(await digest()).toEqual(before);
    // Session idle touches and access-denied audit records are separate accepted auth behavior.
  });
});
