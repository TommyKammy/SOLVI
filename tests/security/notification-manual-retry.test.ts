/** WP-P2-NTFRETRY-058 / ADR-0040: actual auth, PostgreSQL and recording worker.
 * Public controllers are exercised directly. Production HTTP/Server Action wiring
 * and response-loss injection are separate UI gates, not claimed by this suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createLogger, newContext, runWithContext, SESSION_COOKIE_NAME } from '@solvi/shared';
import { AuditWriteError, uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import {
  OutboxDispatcher,
  type OutboxHandler,
} from '../../services/api/src/common/outbox/dispatcher.js';
import { AuthController } from '../../services/api/src/modules/auth/auth.routes.js';
import { OperationSessionService } from '../../services/api/src/modules/auth/operation-session.service.js';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import { NotificationRetryController } from '../../services/api/src/modules/notification/notification-retry.routes.js';
import { NotificationRetryService } from '../../services/api/src/modules/notification/notification-retry.service.js';
import {
  buildSubject,
  NotificationService,
} from '../../services/api/src/modules/notification/notification.service.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import type { OutboxRecordLike } from '../../services/api/src/modules/notification/types.js';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { createKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/isolated-knowledge-db.mjs';
import { createCiKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs';
import {
  readKnowledgeFixture,
  type KnowledgeFixture,
} from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';

let runtime:
  | Awaited<ReturnType<typeof createKnowledgeDatabase>>
  | Awaited<ReturnType<typeof createCiKnowledgeDatabase>>
  | undefined;
let admin: pg.Client;
let pool: pg.Pool;
let fixture: KnowledgeFixture;
let authentication: AuthController;
let controller: NotificationRetryController;
let denials: PoolDenialRecorder;
let verifiedRlsTables = 0;
let migrationCycleVerified = false;
type TestSession = {
  userId: string;
  organizationId: string | null;
  sessionId: string;
  headers: { cookie: string };
};
const sessions: Record<string, TestSession> = {};
const evidenceDirectory = new URL('../../evidence/WP-P2-NTFRETRY-058/20261008/', import.meta.url);
const migration = readFileSync(
  new URL('../../db/migrations/0035_notification_retry_request.sql', import.meta.url),
  'utf8',
);
const up = migration.split('-- +migrate up')[1]!.split('-- +migrate down')[0]!;
const down = migration.split('-- +migrate down')[1]!;
const logger = createLogger({
  service: 'ntfretry058-test',
  level: 'error',
  env: 'test',
  sink: () => {},
});

function writeLifecycleEvidence(content: string) {
  mkdirSync(evidenceDirectory, { recursive: true });
  for (let run = 1; run <= 1000; run++) {
    const leaf =
      run === 1
        ? 'database-lifecycle.json'
        : `database-lifecycle-${String(run).padStart(2, '0')}.json`;
    try {
      writeFileSync(new URL(leaf, evidenceDirectory), content, { mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('NTF058_LIFECYCLE_EVIDENCE_SLOTS_EXHAUSTED');
}

async function issue(userId: string, organizationId: string | null): Promise<TestSession> {
  const result = await new SessionService(admin).issue({
    userId,
    organizationId,
    authMethod: 'local',
  });
  // Cookie/token only live in memory and are never included in Evidence.
  return {
    userId,
    organizationId,
    sessionId: result.session.id,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${result.token}` },
  };
}

async function actor(
  name: string,
  role = 'org_admin',
  org: string | null = fixture.organizationId,
  selected: string | null = org,
) {
  const userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user(id,primary_email,display_name,status,created_via)
    VALUES($1,$2,$3,'active','seed')`,
    [userId, `${name}-${userId}@ntfretry058.test`, `Synthetic ${name}`],
  );
  const binding = await admin.query(
    `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source,valid_from)
    SELECT $1,$2,id,scope,$3,'manual',now()-interval '2 days' FROM role WHERE code=$4`,
    [uuidv7(), userId, org, role],
  );
  expect(binding.rowCount).toBe(1);
  return issue(userId, selected);
}

beforeAll(async () => {
  runtime =
    process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
      ? await createCiKnowledgeDatabase()
      : await createKnowledgeDatabase();
  admin = new pg.Client({ connectionString: runtime.adminUrl, statement_timeout: 10000 });
  await admin.connect();
  pool = new pg.Pool({ connectionString: runtime.appUrl, max: 8, statement_timeout: 10000 });
  const proof = (
    await pool.query(`SELECT current_user AS role,r.rolsuper,r.rolbypassrls,c.relname,
    c.relowner=r.oid AS owns_table,c.relrowsecurity,c.relforcerowsecurity,current_setting('row_security') AS row_security
    FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid IN
    ('notification_retry_request'::regclass,'notification_retry_receipt'::regclass,'notification'::regclass,'outbox_event'::regclass)`)
  ).rows;
  expect(proof).toHaveLength(4);
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
  denials = new PoolDenialRecorder(pool);
  authentication = new AuthController(pool, {
    localAuthEnabled: true,
    cookieSecure: false,
    localAuth: { maxFailedAttempts: 5, lockoutSeconds: 60 },
  });
  controller = new NotificationRetryController({
    pool,
    denialRecorder: denials,
    operationSessions: (client) => new OperationSessionService(client),
  });
  sessions.admin = await issue(fixture.actors.admin.userId, fixture.organizationId);
  for (const role of ['requester', 'agent', 'approver', 'auditor'])
    sessions[role] = await actor(role, role);
  sessions.platform = await actor('platform', 'platform_admin', null, fixture.organizationId);
  sessions.foreign = await actor('foreign', 'org_admin', fixture.controlOrganizationId);
  sessions.noOrg = await issue(fixture.actors.admin.userId, null);
  for (const name of ['inactive', 'expiredRole', 'futureRole', 'revoked', 'expiredSession'])
    sessions[name] = await actor(name);
  await admin.query(`UPDATE app_user SET status='deactivated',deactivated_at=now() WHERE id=$1`, [
    sessions.inactive.userId,
  ]);
  await admin.query(
    `UPDATE role_binding SET valid_until=now()-interval '1 minute' WHERE user_id=$1`,
    [sessions.expiredRole.userId],
  );
  await admin.query(`UPDATE role_binding SET valid_from=now()+interval '1 day' WHERE user_id=$1`, [
    sessions.futureRole.userId,
  ]);
  await admin.query(
    `UPDATE session SET revoked_at=now(),revoked_reason='admin_revoked' WHERE id=$1`,
    [sessions.revoked.sessionId],
  );
  await admin.query(
    `UPDATE session SET issued_at=now()-interval '2 days',absolute_expires_at=now()-interval '1 day',
    idle_expires_at=now()-interval '1 day',last_seen_at=now()-interval '2 days' WHERE id=$1`,
    [sessions.expiredSession.sessionId],
  );
  // Isolate only our owned synthetic fixture's unrelated queued events from a
  // later real dispatchOnce. No ordinary development DB is accepted here.
  await admin.query(`UPDATE outbox_event SET available_at=now()+interval '30 days'
    WHERE processed_at IS NULL AND failed_at IS NULL`);
}, 240000);

afterAll(async () => {
  const closed = await Promise.allSettled([pool?.end(), admin?.end()]);
  const cleanup = await runtime?.cleanup();
  writeLifecycleEvidence(
    JSON.stringify(
      {
        workPackage: 'WP-P2-NTFRETRY-058',
        lifecycleHelper: 'WP-P3-KNWUI-054 (read-only reuse; physical labels unchanged)',
        syntheticOnly: true,
        verificationTransport:
          'public controller with actual auth/session, PostgreSQL and recording worker; production HTTP separately required',
        sender: 'recording-only / synthetic known failures',
        nonOwnerForcedRlsTables: verifiedRlsTables,
        migrationUpDownUpVerified: migrationCycleVerified,
        connectionsClosed: closed.every((r) => r.status === 'fulfilled'),
        cleanup,
      },
      null,
      2,
    ) + '\n',
  );
  expect(closed.every((r) => r.status === 'fulfilled')).toBe(true);
  if (cleanup) expect(cleanup.success).toBe(true);
}, 60000);

async function inOrg<T>(org: string, fn: (client: pg.PoolClient) => Promise<T>, actorId = '') {
  return runWithContext(newContext(), async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_org',$1,true),set_config('app.current_actor',$2,true)`,
        [org, actorId],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

function headers(session: TestSession) {
  return {
    ...session.headers,
    'content-type': 'application/json',
    'x-solvi-form-scope': `${session.organizationId}:${session.userId}`,
  };
}
async function get(id: string, session = sessions.admin, query = new URLSearchParams()) {
  return runWithContext(newContext(), async () => {
    const auth = await authentication.authenticate(session.headers);
    const response = await controller.get(auth, id, query);
    expect(response.status).toBe(200);
    return response.body;
  });
}
async function request(
  id: string,
  version: string,
  session = sessions.admin,
  overrides: Record<string, string | string[] | undefined> = {},
  body: unknown = { version },
  query = new URLSearchParams(),
) {
  return runWithContext(newContext(), async () => {
    const requestHeaders = { ...headers(session), ...overrides };
    const auth = await authentication.authenticate(requestHeaders);
    const response = await controller.request(auth, id, requestHeaders, body, query);
    expect(response.status).toBe(200);
    return response.body;
  });
}
async function reserve(id: string, session = sessions.admin) {
  const status = await get(id, session);
  expect(status).toMatchObject({ eligible: true });
  expect(status.version).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return request(id, status.version!, session);
}
class ControlledRecordingSender extends RecordingEmailSender {
  calls = 0;
  constructor(
    private readonly behavior: (params: {
      to: string;
      subject: string;
      linkPath: string;
    }) => Promise<void> = async () => {},
  ) {
    super();
  }
  override async send(params: { to: string; subject: string; linkPath: string }) {
    this.calls++;
    await this.behavior(params);
    await super.send(params);
  }
}

async function source(options: { assignee?: boolean; org?: string } = {}) {
  const org = options.org ?? fixture.organizationId;
  const requesterId =
    org === fixture.organizationId
      ? fixture.actors.requester.userId
      : (await actor('foreign-recipient', 'requester', org)).userId;
  const creator =
    org === fixture.organizationId
      ? fixture.actors.admin.auth.authz
      : (await authentication.authenticate(sessions.foreign.headers)).authz;
  const ticket = await inOrg(org, (client) =>
    new TicketService(client, denials).create(creator, {
      kind: 'incident',
      subject: 'WP058 synthetic request',
      body: 'NTF058_PRIVATE_BODY',
      impact: 'medium',
      urgency: 'medium',
      requesterId,
    }),
  );
  const row = (
    await admin.query(
      `SELECT * FROM outbox_event WHERE event_type='ticket.created' AND payload->>'ticketId'=$1`,
      [ticket.id],
    )
  ).rows[0];
  if (options.assignee)
    await admin.query(`UPDATE ticket SET assignee_id=$2 WHERE id=$1`, [
      ticket.id,
      fixture.actors.agent.userId,
    ]);
  const record: OutboxRecordLike = {
    id: row.id,
    organizationId: org,
    eventType: 'ticket.created',
    payload: row.payload,
  };
  const recipientEmail = (
    await admin.query('SELECT primary_email::text AS email FROM app_user WHERE id=$1', [
      requesterId,
    ])
  ).rows[0].email;
  const initial = new ControlledRecordingSender(async (params) => {
    if (params.to === recipientEmail) throw new Error('NTF058_INITIAL_FAILURE');
  });
  await inOrg(org, async (client) => {
    try {
      await new NotificationService(client, new Map([['email', initial]])).deliverForEvent(record);
    } catch (error) {
      expect((error as Error).message).toBe('NTF058_INITIAL_FAILURE');
    }
  });
  const notification = (
    await admin.query(
      `SELECT * FROM notification WHERE outbox_event_id=$1 AND recipient_user_id=$2`,
      [row.id, requesterId],
    )
  ).rows[0];
  expect(notification).toMatchObject({ status: 'failed', attempts: 1 });
  if (options.assignee) {
    // Ensure this fixture includes a different already-sent recipient regardless
    // of legacy delivery query order / early failure. No sender is used here.
    await admin.query(
      `INSERT INTO notification(id,organization_id,outbox_event_id,channel,recipient_user_id,recipient_address,subject,link_path,status,sent_at,attempts)
      SELECT $1,$2,$3,'email',id,primary_email,$4,$5,'sent',now(),1 FROM app_user WHERE id=$6
      ON CONFLICT(outbox_event_id,recipient_address) WHERE outbox_event_id IS NOT NULL
      DO UPDATE SET status='sent',sent_at=now(),failed_at=NULL,last_error=NULL`,
      [
        uuidv7(),
        org,
        row.id,
        notification.subject,
        notification.link_path,
        fixture.actors.agent.userId,
      ],
    );
  }
  await admin.query(
    `UPDATE outbox_event SET failed_at=now(),processed_at=NULL,locked_until=NULL,last_error='NTF058_SYNTHETIC_STOP' WHERE id=$1`,
    [row.id],
  );
  return {
    id: notification.id as string,
    notification,
    outboxId: row.id as string,
    ticketId: ticket.id,
    record,
    organizationId: org,
    requesterId,
  };
}
async function booking(id: string) {
  return (
    await admin.query(`SELECT * FROM notification_retry_request WHERE notification_id=$1`, [id])
  ).rows[0];
}
async function receipts(id: string) {
  return (await admin.query(`SELECT * FROM notification_retry_receipt WHERE request_id=$1`, [id]))
    .rows;
}
async function notification(id: string) {
  return (await admin.query(`SELECT * FROM notification WHERE id=$1`, [id])).rows[0];
}
async function original(id: string) {
  return (await admin.query(`SELECT * FROM outbox_event WHERE id=$1`, [id])).rows[0];
}
async function businessDigest() {
  return (
    await admin.query(`SELECT
    (SELECT md5(coalesce(string_agg(row_to_json(n)::text,'|' ORDER BY id),'')) FROM notification n) AS notifications,
    (SELECT md5(coalesce(string_agg(row_to_json(o)::text,'|' ORDER BY id),'')) FROM outbox_event o) AS outbox,
    (SELECT md5(coalesce(string_agg(row_to_json(p)::text,'|' ORDER BY organization_id,user_id),'')) FROM notification_preference p) AS preferences`)
  ).rows[0];
}
async function execute(id: string, sender = new ControlledRecordingSender()) {
  const saved = await booking(id);
  expect(saved).toBeDefined();
  const row = await original(saved.retry_outbox_id);
  await inOrg(row.organization_id, (client) =>
    new NotificationRetryService(client, {
      operationSessions: new OperationSessionService(client),
      sender,
    }).execute({
      id: row.id,
      organizationId: row.organization_id,
      eventType: row.event_type,
      payload: row.payload,
    }),
  );
  return sender;
}
async function waitForBlockedNotification(pattern = '%notification%') {
  for (let attempt = 0; attempt < 160; attempt++) {
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const result = await admin.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND usename='solvi_app' AND wait_event_type='Lock' AND query ILIKE $1`,
      [pattern],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('NTF058_EXPECTED_DATABASE_LOCK_NOT_OBSERVED');
}

async function withAuditFailure<T>(id: string, eventType: string, run: () => Promise<T>) {
  const name = 'ntf058_audit_failure';
  await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type=TG_ARGV[0] AND NEW.target_id::text=TG_ARGV[1]
      THEN RAISE EXCEPTION 'NTF058_TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$`);
  await admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_event FOR EACH ROW
    EXECUTE FUNCTION ${name}(${pg.escapeLiteral(eventType)},${pg.escapeLiteral(id)})`);
  try {
    return await run();
  } finally {
    await admin.query(`DROP TRIGGER ${name} ON audit_event`);
    await admin.query(`DROP FUNCTION ${name}()`);
  }
}

describe('WP058 actual PostgreSQL manual retry boundaries', () => {
  it('up/down/up preserves old business rows without backfill', async () => {
    const target = await source();
    const before = await businessDigest();
    await admin.query(down);
    expect(
      (await admin.query(`SELECT to_regclass('notification_retry_request') AS table`)).rows[0]
        .table,
    ).toBeNull();
    await admin.query(up);
    expect(await businessDigest()).toEqual(before);
    expect((await notification(target.id)).status).toBe('failed');
    const rows = await admin.query(
      `SELECT (SELECT count(*) FROM notification_retry_request)::int AS requests,(SELECT count(*) FROM notification_retry_receipt)::int AS receipts`,
    );
    expect(rows.rows[0]).toEqual({ requests: 0, receipts: 0 });
    migrationCycleVerified = true;
  });

  it.each([
    'requester',
    'agent',
    'approver',
    'auditor',
    'platform',
    'noOrg',
    'expiredRole',
    'futureRole',
  ])('rejects %s from org-admin operation reads and writes', async (name) => {
    const target = await source();
    const before = await businessDigest();
    await expect(get(target.id, sessions[name])).rejects.toMatchObject({ status: 403 });
    await expect(request(target.id, 'A'.repeat(43), sessions[name])).rejects.toMatchObject({
      status: 403,
    });
    expect(await booking(target.id)).toBeUndefined();
    expect(await businessDigest()).toEqual(before);
  });
  it.each(['inactive', 'revoked', 'expiredSession'])(
    'rejects invalid %s authentication before reservation',
    async (name) => {
      const target = await source();
      await expect(get(target.id, sessions[name])).rejects.toMatchObject({ status: 401 });
      expect(await booking(target.id)).toBeUndefined();
    },
  );
  it('database forbids a global/null-org binding for an organization administrator', async () => {
    await expect(
      admin.query(
        `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source,valid_from)
      SELECT $1,$2,id,scope,NULL,'manual',now() FROM role WHERE code='org_admin'`,
        [uuidv7(), sessions.admin.userId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('does not resolve another organization notification through an authorized foreign admin', async () => {
    const target = await source();
    await expect(get(target.id, sessions.foreign)).rejects.toMatchObject({ status: 404 });
    await expect(request(target.id, 'A'.repeat(43), sessions.foreign)).rejects.toMatchObject({
      status: 404,
    });
    expect(await booking(target.id)).toBeUndefined();
  });
  it('GET is safe, minimal and makes no business changes', async () => {
    const target = await source();
    const before = await businessDigest();
    const status = await get(target.id);
    expect(Object.keys(status).sort()).toEqual(
      [
        'eligible',
        'reason',
        'version',
        'state',
        'requestedAt',
        'expiresAt',
        'completedAt',
        'deliveryMode',
      ].sort(),
    );
    expect(status).toMatchObject({
      eligible: true,
      state: 'not_requested',
      requestedAt: null,
      expiresAt: null,
      completedAt: null,
      deliveryMode: 'recording',
    });
    expect(JSON.stringify(status)).not.toMatch(
      /NTF058_PRIVATE_BODY|ntfretry058\.test|recipient|last_error|outbox|session/i,
    );
    expect(await businessDigest()).toEqual(before);
    expect(await booking(target.id)).toBeUndefined();
  });

  it.each(['https://untrusted.example', 'null', ''])(
    'rejects Origin-bearing direct API requests (%s)',
    async (origin) => {
      const target = await source();
      const status = await get(target.id);
      await expect(
        request(target.id, status.version!, sessions.admin, { origin }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await booking(target.id)).toBeUndefined();
    },
  );
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
    'rejects non-JSON %s',
    async (contentType) => {
      const target = await source();
      const status = await get(target.id);
      await expect(
        request(target.id, status.version!, sessions.admin, { 'content-type': contentType }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await booking(target.id)).toBeUndefined();
    },
  );
  it.each([undefined, '', 'wrong', ['duplicate', 'duplicate']])(
    'requires one matching form scope (%j)',
    async (scope) => {
      const target = await source();
      const status = await get(target.id);
      await expect(
        request(target.id, status.version!, sessions.admin, { 'x-solvi-form-scope': scope }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await booking(target.id)).toBeUndefined();
    },
  );
  it.each([
    { address: 'synthetic@invalid.test' },
    { userId: 'arbitrary' },
    { organizationId: 'arbitrary' },
    { sessionId: 'arbitrary' },
    { payload: {} },
    null,
    [],
    { version: 1 },
  ])('rejects arbitrary or malformed request body %j', async (extra) => {
    const target = await source();
    const status = await get(target.id);
    const body =
      extra && typeof extra === 'object' && !Array.isArray(extra)
        ? { version: status.version, ...extra }
        : extra;
    await expect(
      request(target.id, status.version!, sessions.admin, {}, body),
    ).rejects.toMatchObject({ status: 400 });
    expect(await booking(target.id)).toBeUndefined();
  });
  it.each(['x=1', 'version=one&version=two', 'cursor=anything'])(
    'rejects unsupported query %s',
    async (query) => {
      const target = await source();
      await expect(
        get(target.id, sessions.admin, new URLSearchParams(query)),
      ).rejects.toMatchObject({ status: 400 });
      const status = await get(target.id);
      await expect(
        request(
          target.id,
          status.version!,
          sessions.admin,
          {},
          undefined,
          new URLSearchParams(query),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await booking(target.id)).toBeUndefined();
    },
  );

  it('rejects an empty body, invalid notification ID and cross-actor confirmation version', async () => {
    const target = await source();
    const status = await get(target.id);
    await expect(request(target.id, status.version!, sessions.admin, {}, {})).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(get('not-a-uuid')).rejects.toMatchObject({ status: 404 });
    const otherAdmin = await actor('other-admin');
    await expect(request(target.id, status.version!, otherAdmin)).rejects.toMatchObject({
      status: 409,
    });
    expect(await booking(target.id)).toBeUndefined();
  });

  it.each([
    'sent',
    'pending',
    'webhook',
    'nonStopped',
    'processed',
    'leased',
    'foreignOutbox',
    'missingOutbox',
    'unsupported',
    'badPayload',
    'internalMemo',
    'recipientChanged',
  ])('does not reserve the ineligible %s target', async (mode) => {
    const target = await source();
    const initial = await get(target.id);
    if (mode === 'sent' || mode === 'pending')
      await admin.query(
        `UPDATE notification SET status=$2,
        sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,failed_at=NULL,last_error=NULL WHERE id=$1`,
        [target.id, mode],
      );
    if (mode === 'webhook')
      await admin.query(`UPDATE notification SET channel='webhook' WHERE id=$1`, [target.id]);
    if (mode === 'nonStopped')
      await admin.query(`UPDATE outbox_event SET failed_at=NULL WHERE id=$1`, [target.outboxId]);
    if (mode === 'processed')
      await admin.query(`UPDATE outbox_event SET processed_at=now(),failed_at=NULL WHERE id=$1`, [
        target.outboxId,
      ]);
    if (mode === 'leased')
      await admin.query(
        `UPDATE outbox_event SET locked_until=now()+interval '1 hour' WHERE id=$1`,
        [target.outboxId],
      );
    if (mode === 'foreignOutbox')
      await admin.query(`UPDATE outbox_event SET organization_id=$2 WHERE id=$1`, [
        target.outboxId,
        fixture.controlOrganizationId,
      ]);
    if (mode === 'unsupported')
      await admin.query(`UPDATE outbox_event SET event_type='role.binding.expiring' WHERE id=$1`, [
        target.outboxId,
      ]);
    if (mode === 'missingOutbox')
      await admin.query('UPDATE notification SET outbox_event_id=NULL WHERE id=$1', [target.id]);
    if (mode === 'badPayload')
      await admin.query(
        `UPDATE outbox_event SET payload=jsonb_build_object('ticketId',$2::text) WHERE id=$1`,
        [target.outboxId, target.ticketId],
      );
    if (mode === 'recipientChanged')
      await admin.query(
        `UPDATE notification SET recipient_address='different@synthetic.invalid' WHERE id=$1`,
        [target.id],
      );
    if (mode === 'internalMemo')
      await admin.query(
        `UPDATE outbox_event SET event_type='ticket.comment.added',
          payload=payload||'{"visibility":"internal"}'::jsonb WHERE id=$1`,
        [target.outboxId],
      );
    const before = await businessDigest();
    const latest = await get(target.id);
    expect(latest.eligible).toBe(false);
    expect(latest.version).toBeNull();
    await expect(request(target.id, initial.version!)).rejects.toMatchObject({ status: 409 });
    expect(await booking(target.id)).toBeUndefined();
    expect(await businessDigest()).toEqual(before);
  });

  it.each([
    'ticket.created',
    'ticket.transitioned',
    'ticket.assigned',
    'ticket.comment.added',
    'ticket.reassessed',
  ])('accepts the consistent stored fixed event %s', async (eventType) => {
    const target = await source();
    const payload = { ...target.record.payload };
    if (eventType === 'ticket.comment.added') {
      payload.visibility = 'public';
      await admin.query(
        `INSERT INTO ticket_comment(id,organization_id,ticket_id,author_id,visibility,body)
         VALUES($1,$2,$3,$4,'public','NTF058_SYNTHETIC_PUBLIC_COMMENT')`,
        [uuidv7(), fixture.organizationId, target.ticketId, fixture.actors.admin.userId],
      );
    }
    await admin.query('UPDATE outbox_event SET event_type=$2,payload=$3 WHERE id=$1', [
      target.outboxId,
      eventType,
      payload,
    ]);
    await admin.query('UPDATE notification SET subject=$2 WHERE id=$1', [
      target.id,
      buildSubject(eventType, String(payload.ticketNumber)),
    ]);
    await reserve(target.id);
    const sender = await execute(target.id);
    expect(sender.calls).toBe(1);
    expect((await notification(target.id)).status).toBe('sent');
  });

  it('reserves once without changing existing notification/source/preferences and emits minimal atomic audit', async () => {
    const target = await source();
    const beforeNotification = await notification(target.id);
    const beforeSource = await original(target.outboxId);
    const beforePreferences = (
      await admin.query(`SELECT * FROM notification_preference ORDER BY organization_id,user_id`)
    ).rows;
    const queued = await reserve(target.id);
    expect(queued).toMatchObject({
      eligible: false,
      state: 'queued',
      version: null,
      deliveryMode: 'recording',
    });
    const saved = await booking(target.id);
    expect(saved.requested_by).toBe(sessions.admin.userId);
    expect(saved.session_id).toBe(sessions.admin.sessionId);
    expect(saved.expires_at.getTime() - saved.approved_at.getTime()).toBe(15 * 60 * 1000);
    expect(saved.failure_attempts).toBe(1);
    const retry = await original(saved.retry_outbox_id);
    expect(retry).toMatchObject({
      organization_id: fixture.organizationId,
      event_type: 'notification.manual_retry.requested',
      max_attempts: 1,
      payload: { retryRequestId: saved.id },
    });
    expect(Object.keys(saved)).not.toEqual(
      expect.arrayContaining(['token', 'cookie', 'token_hash']),
    );
    expect(await notification(target.id)).toEqual(beforeNotification);
    expect(await original(target.outboxId)).toEqual(beforeSource);
    expect(
      (await admin.query(`SELECT * FROM notification_preference ORDER BY organization_id,user_id`))
        .rows,
    ).toEqual(beforePreferences);
    const requested = (
      await admin.query(
        `SELECT * FROM audit_event WHERE event_type='notification.retry.requested' AND target_id=$1`,
        [target.id],
      )
    ).rows;
    expect(requested).toHaveLength(1);
    expect(requested[0].receipt_ref).toBeNull();
    expect(await receipts(saved.id)).toEqual([]);
    await execute(target.id);
  });

  it('concurrent double POST and a lost response converge on one booking/audit/Outbox; completion POST reuses it', async () => {
    const target = await source();
    const status = await get(target.id);
    const results = await Promise.all([
      request(target.id, status.version!),
      request(target.id, status.version!),
    ]);
    expect(results.every((r) => r.state === 'queued')).toBe(true);
    const saved = await booking(target.id);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM notification_retry_request WHERE notification_id=$1`,
          [target.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM outbox_event WHERE payload->>'retryRequestId'=$1`,
          [saved.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit_event WHERE event_type='notification.retry.requested' AND target_id=$1`,
          [target.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // Discarding a committed return value models only client uncertainty; real
    // HTTP response truncation is exercised by the independent UI runner.
    expect((await get(target.id)).state).toBe('queued');
    await execute(target.id);
    const before = await businessDigest();
    expect((await request(target.id, 'A'.repeat(43))).state).toBe('succeeded');
    expect(await businessDigest()).toEqual(before);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit_event WHERE event_type='notification.retry.requested' AND target_id=$1`,
          [target.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('success updates the same notification once and confirmed receipt replay sends nothing', async () => {
    const target = await source();
    await reserve(target.id);
    const saved = await booking(target.id);
    const beforeSource = await original(target.outboxId);
    const idleBefore = (
      await admin.query(`SELECT last_seen_at,idle_expires_at FROM session WHERE id=$1`, [
        sessions.admin.sessionId,
      ])
    ).rows[0];
    const sender = await execute(target.id);
    expect(sender.calls).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(await notification(target.id)).toMatchObject({
      id: target.id,
      status: 'sent',
      attempts: 2,
      failed_at: null,
      last_error: null,
    });
    expect((await notification(target.id)).sent_at).toBeInstanceOf(Date);
    expect(await receipts(saved.id)).toMatchObject([{ outcome: 'succeeded', reason: null }]);
    const terminal = (
      await admin.query(
        `SELECT * FROM audit_event WHERE event_type='notification.retry.completed' AND target_id=$1`,
        [target.id],
      )
    ).rows;
    expect(terminal).toHaveLength(1);
    expect(terminal[0].receipt_ref).toBe((await receipts(saved.id))[0].id);
    expect(
      (
        await admin.query(`SELECT last_seen_at,idle_expires_at FROM session WHERE id=$1`, [
          sessions.admin.sessionId,
        ])
      ).rows[0],
    ).toEqual(idleBefore);
    await execute(target.id, sender);
    expect(sender.calls).toBe(1);
    expect(await receipts(saved.id)).toHaveLength(1);
    expect(await original(target.outboxId)).toEqual(beforeSource);
  });

  it('known sender failure commits one failed terminal result and never creates another reservation', async () => {
    const target = await source();
    await reserve(target.id);
    const saved = await booking(target.id);
    const sender = new ControlledRecordingSender(async () => {
      throw new Error('NTF058_KNOWN_SENDER_FAILURE_PRIVATE');
    });
    await execute(target.id, sender);
    expect(sender.calls).toBe(1);
    expect(await notification(target.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await receipts(saved.id)).toMatchObject([
      { outcome: 'failed', reason: 'sender_failed' },
    ]);
    const status = await get(target.id);
    expect(status).toMatchObject({
      eligible: false,
      state: 'failed',
      reason: 'sender_failed',
      version: null,
    });
    expect(JSON.stringify(status)).not.toContain('NTF058_KNOWN_SENDER_FAILURE_PRIVATE');
    expect((await request(target.id, 'A'.repeat(43))).state).toBe('failed');
    await execute(target.id, sender);
    expect(sender.calls).toBe(1);
  });

  it('new current org-admin may read the existing org reservation without supplying the original actor version', async () => {
    const target = await source();
    await reserve(target.id);
    const otherAdmin = await actor('existing-request-reader');
    expect((await request(target.id, 'B'.repeat(43), otherAdmin)).state).toBe('queued');
    await execute(target.id);
  });

  it('OFF does not cancel this existing failed notification and leaves other recipient rows unchanged', async () => {
    const target = await source({ assignee: true });
    await admin.query(
      `INSERT INTO notification_preference(organization_id,user_id,ticket_email_enabled) VALUES($1,$2,false)
      ON CONFLICT(organization_id,user_id) DO UPDATE SET ticket_email_enabled=false`,
      [fixture.organizationId, target.requesterId],
    );
    const others = (
      await admin.query(
        `SELECT * FROM notification WHERE outbox_event_id=$1 AND id<>$2 ORDER BY id`,
        [target.outboxId, target.id],
      )
    ).rows;
    expect(others.length).toBeGreaterThan(0);
    const beforeSource = await original(target.outboxId);
    await reserve(target.id);
    await execute(target.id);
    expect((await notification(target.id)).status).toBe('sent');
    expect(
      (
        await admin.query(
          `SELECT * FROM notification WHERE outbox_event_id=$1 AND id<>$2 ORDER BY id`,
          [target.outboxId, target.id],
        )
      ).rows,
    ).toEqual(others);
    expect(await original(target.outboxId)).toEqual(beforeSource);
    await admin.query(
      `UPDATE notification_preference SET ticket_email_enabled=true WHERE organization_id=$1 AND user_id=$2`,
      [fixture.organizationId, target.requesterId],
    );
  });

  it('rejects a stale failure generation but permits a newly confirmed one', async () => {
    const target = await source();
    const status = await get(target.id);
    await admin.query(
      `UPDATE notification SET attempts=attempts+1,failed_at=clock_timestamp(),last_error='NTF058_CHANGED_FAILURE' WHERE id=$1`,
      [target.id],
    );
    await expect(request(target.id, status.version!)).rejects.toMatchObject({ status: 409 });
    expect(await booking(target.id)).toBeUndefined();
    await reserve(target.id);
    await execute(target.id);
    expect((await notification(target.id)).attempts).toBe(3);
  });

  it('enforces org-only reads and append-only grants for requests and receipts under nonowner RLS', async () => {
    const home = await source();
    await reserve(home.id);
    await execute(home.id);
    const foreign = await source({ org: fixture.controlOrganizationId });
    await reserve(foreign.id, sessions.foreign);
    await execute(foreign.id);
    const homeRequest = await booking(home.id);
    const foreignRequest = await booking(foreign.id);
    await inOrg(fixture.organizationId, async (client) => {
      expect(
        (
          await client.query(`SELECT id FROM notification_retry_request WHERE id=$1`, [
            homeRequest.id,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(`SELECT id FROM notification_retry_request WHERE id=$1`, [
            foreignRequest.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(`SELECT id FROM notification_retry_receipt WHERE request_id=$1`, [
            foreignRequest.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(`SELECT id FROM notification_retry_receipt WHERE request_id=$1`, [
            homeRequest.id,
          ])
        ).rowCount,
      ).toBe(1);
    });
    await inOrg('', async (client) => {
      expect((await client.query('SELECT id FROM notification_retry_request')).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM notification_retry_receipt')).rowCount).toBe(0);
    });
    for (const table of ['notification_retry_request', 'notification_retry_receipt']) {
      await expect(
        inOrg(fixture.organizationId, (client) => client.query(`UPDATE ${table} SET id=id`)),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inOrg(fixture.organizationId, (client) => client.query(`DELETE FROM ${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const duplicate = { ...homeRequest, id: uuidv7() };
    await expect(
      inOrg(
        fixture.organizationId,
        (client) =>
          client.query(
            `INSERT INTO notification_retry_request SELECT * FROM jsonb_populate_record(NULL::notification_retry_request,$1::jsonb)`,
            [JSON.stringify(duplicate)],
          ),
        sessions.requester.userId,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inOrg(
        fixture.controlOrganizationId,
        (client) =>
          client.query(
            `INSERT INTO notification_retry_request SELECT * FROM jsonb_populate_record(NULL::notification_retry_request,$1::jsonb)`,
            [JSON.stringify(duplicate)],
          ),
        homeRequest.requested_by,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const receipt = (await receipts(homeRequest.id))[0];
    await expect(
      inOrg(fixture.controlOrganizationId, (client) =>
        client.query(
          `INSERT INTO notification_retry_receipt SELECT * FROM jsonb_populate_record(NULL::notification_retry_receipt,$1::jsonb)`,
          [JSON.stringify({ ...receipt, id: uuidv7() })],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Constraints remain enforced for the owner used only to create fixtures.
    await expect(
      admin.query(
        `INSERT INTO notification_retry_request SELECT * FROM jsonb_populate_record(NULL::notification_retry_request,$1::jsonb)`,
        [JSON.stringify(duplicate)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      admin.query(
        `INSERT INTO notification_retry_receipt SELECT * FROM jsonb_populate_record(NULL::notification_retry_receipt,$1::jsonb)`,
        [JSON.stringify({ ...receipt, id: uuidv7() })],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const noReceipt = await source();
    await reserve(noReceipt.id);
    await expect(
      admin.query(
        `INSERT INTO notification_retry_receipt(id,organization_id,request_id,outcome,reason) VALUES($1,$2,$3,'rejected','target_changed')`,
        [uuidv7(), fixture.controlOrganizationId, (await booking(noReceipt.id)).id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await execute(noReceipt.id);
  });

  it.each([
    'revoked',
    'roleExpired',
    'userInactive',
    'orgChanged',
    'recipientInactive',
    'addressChanged',
    'membershipExpired',
    'relationshipChanged',
    'failureChanged',
    'approvalExpired',
  ])('revalidates %s before worker and creates only a rejection receipt', async (mode) => {
    const session = await actor(`worker-${mode}`);
    const target = await source();
    await reserve(target.id, session);
    const saved = await booking(target.id);
    const before = await notification(target.id);
    const beforeSource = await original(target.outboxId);
    const sender = new ControlledRecordingSender();
    let restore: (() => Promise<unknown>) | undefined;
    if (mode === 'revoked')
      await admin.query(
        `UPDATE session SET revoked_at=now(),revoked_reason='admin_revoked' WHERE id=$1`,
        [session.sessionId],
      );
    if (mode === 'roleExpired')
      await admin.query(
        `UPDATE role_binding SET valid_until=now()-interval '1 minute' WHERE user_id=$1`,
        [session.userId],
      );
    if (mode === 'userInactive')
      await admin.query(
        `UPDATE app_user SET status='deactivated',deactivated_at=now() WHERE id=$1`,
        [session.userId],
      );
    if (mode === 'orgChanged')
      await admin.query(`UPDATE session SET organization_id=$2 WHERE id=$1`, [
        session.sessionId,
        fixture.controlOrganizationId,
      ]);
    if (mode === 'recipientInactive') {
      await admin.query(
        `UPDATE app_user SET status='deactivated',deactivated_at=now() WHERE id=$1`,
        [target.requesterId],
      );
      restore = () =>
        admin.query(`UPDATE app_user SET status='active',deactivated_at=NULL WHERE id=$1`, [
          target.requesterId,
        ]);
    }
    if (mode === 'addressChanged') {
      const email = (
        await admin.query(`SELECT primary_email::text AS email FROM app_user WHERE id=$1`, [
          target.requesterId,
        ])
      ).rows[0].email;
      await admin.query(
        `UPDATE app_user SET primary_email='changed@synthetic.invalid' WHERE id=$1`,
        [target.requesterId],
      );
      restore = () =>
        admin.query(`UPDATE app_user SET primary_email=$2 WHERE id=$1`, [
          target.requesterId,
          email,
        ]);
    }
    if (mode === 'membershipExpired') {
      const bindings = (
        await admin.query(
          `SELECT id,valid_from,valid_until FROM role_binding WHERE user_id=$1 AND organization_id=$2`,
          [target.requesterId, fixture.organizationId],
        )
      ).rows;
      await admin.query(
        `UPDATE role_binding SET valid_from=LEAST(valid_from,now()-interval '2 days'),
          valid_until=now()-interval '1 minute' WHERE user_id=$1 AND organization_id=$2`,
        [target.requesterId, fixture.organizationId],
      );
      restore = async () => {
        for (const binding of bindings)
          await admin.query(`UPDATE role_binding SET valid_until=$2,valid_from=$3 WHERE id=$1`, [
            binding.id,
            binding.valid_until,
            binding.valid_from,
          ]);
      };
    }
    if (mode === 'relationshipChanged')
      await admin.query(`UPDATE ticket SET requester_id=$2 WHERE id=$1`, [
        target.ticketId,
        fixture.actors.agent.userId,
      ]);
    if (mode === 'failureChanged')
      await admin.query(
        `UPDATE notification SET attempts=attempts+1,failed_at=clock_timestamp() WHERE id=$1`,
        [target.id],
      );
    if (mode === 'approvalExpired')
      await admin.query(
        `UPDATE notification_retry_request SET approved_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE id=$1`,
        [saved.id],
      );
    const justBefore = await notification(target.id);
    try {
      await execute(target.id, sender);
      expect(sender.calls).toBe(0);
      expect(await notification(target.id)).toEqual(justBefore);
      expect(await original(target.outboxId)).toEqual(beforeSource);
      expect(await receipts(saved.id)).toMatchObject([{ outcome: 'rejected' }]);
      expect((await receipts(saved.id))[0].reason).not.toBeNull();
      const audit = (
        await admin.query(
          `SELECT receipt_ref FROM audit_event WHERE event_type='notification.retry.rejected' AND target_id=$1`,
          [target.id],
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].receipt_ref).toBe((await receipts(saved.id))[0].id);
      if (mode === 'approvalExpired') {
        expect((await get(target.id)).state).toBe('expired');
        expect((await request(target.id, 'A'.repeat(43))).state).toBe('expired');
      }
    } finally {
      await restore?.();
    }
    expect(before.id).toBe(target.id);
  });

  it.each(['sessionRevoked', 'roleExpired', 'recipientAddress', 'approvalExpired'])(
    'worker rechecks %s after it actually waits for a PostgreSQL row lock',
    async (mode) => {
      const session = await actor(`wait-worker-${mode}`);
      const target = await source();
      await reserve(target.id, session);
      const saved = await booking(target.id);
      const sender = new ControlledRecordingSender();
      await admin.query('BEGIN');
      await admin.query(`SELECT id FROM notification WHERE id=$1 FOR UPDATE`, [target.id]);
      const pending = execute(target.id, sender).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let committed = false;
      let previousEmail: string | undefined;
      try {
        await waitForBlockedNotification();
        if (mode === 'sessionRevoked')
          await admin.query(
            `UPDATE session SET revoked_at=now(),revoked_reason='admin_revoked' WHERE id=$1`,
            [session.sessionId],
          );
        if (mode === 'roleExpired')
          await admin.query(
            `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1`,
            [session.userId],
          );
        if (mode === 'recipientAddress') {
          previousEmail = (
            await admin.query(`SELECT primary_email::text AS email FROM app_user WHERE id=$1`, [
              target.requesterId,
            ])
          ).rows[0].email;
          await admin.query(
            `UPDATE app_user SET primary_email='lock-changed@synthetic.invalid' WHERE id=$1`,
            [target.requesterId],
          );
        }
        if (mode === 'approvalExpired')
          await admin.query(
            `UPDATE notification_retry_request SET approved_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE id=$1`,
            [saved.id],
          );
        await admin.query('COMMIT');
        committed = true;
        expect((await pending).error).toBeUndefined();
        expect(sender.calls).toBe(0);
        expect(await receipts(saved.id)).toMatchObject([{ outcome: 'rejected' }]);
        expect((await notification(target.id)).attempts).toBe(1);
      } finally {
        if (!committed) await admin.query('ROLLBACK');
        await pending;
        if (previousEmail)
          await admin.query(`UPDATE app_user SET primary_email=$2 WHERE id=$1`, [
            target.requesterId,
            previousEmail,
          ]);
      }
    },
  );

  it.each(['userInactive', 'sessionRevoked', 'roleExpired'])(
    'reservation rechecks %s after waiting for a PostgreSQL notification lock',
    async (mode) => {
      const session = await actor(`wait-request-${mode}`);
      const target = await source();
      const status = await get(target.id, session);
      await admin.query('BEGIN');
      await admin.query(`SELECT id FROM notification WHERE id=$1 FOR UPDATE`, [target.id]);
      const pending = request(target.id, status.version!, session).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let committed = false;
      try {
        await waitForBlockedNotification();
        if (mode === 'userInactive')
          await admin.query(
            `UPDATE app_user SET status='deactivated',deactivated_at=now() WHERE id=$1`,
            [session.userId],
          );
        if (mode === 'sessionRevoked')
          await admin.query(
            `UPDATE session SET revoked_at=now(),revoked_reason='admin_revoked' WHERE id=$1`,
            [session.sessionId],
          );
        if (mode === 'roleExpired')
          await admin.query(
            `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1`,
            [session.userId],
          );
        await admin.query('COMMIT');
        committed = true;
        expect((await pending).error).toMatchObject({ status: 403 });
        expect(await booking(target.id)).toBeUndefined();
      } finally {
        if (!committed) await admin.query('ROLLBACK');
        await pending;
      }
    },
  );

  it('permits A to B to A before execution as documented; does not invent a switch-history version', async () => {
    const session = await actor('round-trip-org');
    const target = await source();
    await reserve(target.id, session);
    await admin.query(`UPDATE session SET organization_id=$2 WHERE id=$1`, [
      session.sessionId,
      fixture.controlOrganizationId,
    ]);
    await admin.query(`UPDATE session SET organization_id=$2 WHERE id=$1`, [
      session.sessionId,
      fixture.organizationId,
    ]);
    const sender = await execute(target.id);
    expect(sender.calls).toBe(1);
    expect((await notification(target.id)).status).toBe('sent');
  });

  it('rechecks actual time when an org-admin grant expires during a session SHARE-lock wait', async () => {
    const session = await actor('auth-lock-expiry');
    const target = await source();
    await reserve(target.id, session);
    await admin.query(
      `UPDATE role_binding SET valid_until=clock_timestamp()+interval '2 seconds' WHERE user_id=$1`,
      [session.userId],
    );
    const sender = new ControlledRecordingSender();
    await admin.query('BEGIN');
    await admin.query('SELECT id FROM session WHERE id=$1 FOR UPDATE', [session.sessionId]);
    const pending = execute(target.id, sender).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    let committed = false;
    try {
      await waitForBlockedNotification('%session%');
      let expired = false;
      for (let attempt = 0; attempt < 160; attempt++) {
        expired = (
          await admin.query(
            'SELECT bool_and(valid_until<=clock_timestamp()) AS expired FROM role_binding WHERE user_id=$1',
            [session.userId],
          )
        ).rows[0].expired;
        if (expired) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(expired).toBe(true);
      await admin.query('COMMIT');
      committed = true;
      expect((await pending).error).toBeUndefined();
      expect(sender.calls).toBe(0);
      expect(await receipts((await booking(target.id)).id)).toMatchObject([
        { outcome: 'rejected', reason: 'session_invalid' },
      ]);
    } finally {
      if (!committed) await admin.query('ROLLBACK');
      await pending;
    }
  });

  it('session purge preserves immutable reservation history and makes execution reject', async () => {
    const session = await actor('purged-session');
    const target = await source();
    await reserve(target.id, session);
    const saved = await booking(target.id);
    expect(
      (await admin.query(`DELETE FROM session WHERE id=$1`, [session.sessionId])).rowCount,
    ).toBe(1);
    const sender = await execute(target.id);
    expect(sender.calls).toBe(0);
    expect(await booking(target.id)).toEqual(saved);
    expect(await receipts(saved.id)).toMatchObject([
      { outcome: 'rejected', reason: 'session_invalid' },
    ]);
    expect((await notification(target.id)).attempts).toBe(1);
  });

  it('down refuses a FORCE-RLS table owner that sees zero rows while another org history exists', async () => {
    const target = await source();
    await reserve(target.id);
    await execute(target.id);
    const saved = await booking(target.id);
    const role = `ntf058_rollback_owner_${uuidv7().replaceAll('-', '')}`;
    // PostgreSQL role/ownership DDL is transactional. The fixture's only role
    // and both ownership changes are unconditionally rolled back, including
    // on failed assertions, and never reach any ordinary development database.
    await admin.query('BEGIN');
    try {
      await admin.query(
        `CREATE ROLE ${pg.escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${pg.escapeIdentifier(role)}`);
      for (const table of ['notification_retry_request', 'notification_retry_receipt'])
        await admin.query(`ALTER TABLE ${table} OWNER TO ${pg.escapeIdentifier(role)}`);
      await admin.query(`SET LOCAL ROLE ${pg.escapeIdentifier(role)}`);
      await admin.query(`SELECT set_config('app.current_org','',true)`);
      expect(
        (
          await admin.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns_table
            FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user
            AND c.oid='notification_retry_request'::regclass`)
        ).rows[0],
      ).toEqual({ rolsuper: false, rolbypassrls: false, owns_table: true });
      expect(
        (await admin.query('SELECT count(*)::int AS n FROM notification_retry_request')).rows[0].n,
      ).toBe(0);
      await expect(admin.query(down)).rejects.toThrow(
        'NOTIFICATION_RETRY_ROLLBACK_VISIBILITY_REQUIRED',
      );
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(await booking(target.id)).toEqual(saved);
    expect(await receipts(saved.id)).toHaveLength(1);
    expect((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount).toBe(0);
    await expect(admin.query(down)).rejects.toThrow('NOTIFICATION_RETRY_HISTORY_PRESENT');
  });

  it('serializes concurrent workers and persists one delivery result', async () => {
    const target = await source();
    await reserve(target.id);
    const sender = new ControlledRecordingSender();
    await Promise.all([execute(target.id, sender), execute(target.id, sender)]);
    expect(sender.calls).toBe(1);
    expect(await receipts((await booking(target.id)).id)).toHaveLength(1);
    expect((await notification(target.id)).attempts).toBe(2);
  });

  it('rolls back request, new Outbox and audit together when requested audit fails', async () => {
    const target = await source();
    const status = await get(target.id);
    const before = await businessDigest();
    await withAuditFailure(target.id, 'notification.retry.requested', async () => {
      const failure = request(target.id, status.version!);
      await expect(failure).rejects.toBeInstanceOf(AuditWriteError);
      await expect(failure).rejects.toThrow('NTF058_TEST_AUDIT_FAILURE');
      expect(await booking(target.id)).toBeUndefined();
      expect(await businessDigest()).toEqual(before);
      expect(
        (
          await admin.query(
            `SELECT event_id FROM audit_event WHERE event_type='notification.retry.requested' AND target_id=$1`,
            [target.id],
          )
        ).rows,
      ).toEqual([]);
    });
    // The later real request demonstrates transaction rollback and connection reuse.
    await reserve(target.id);
    await execute(target.id);
  });

  it.each(['notification.sent', 'notification.retry.completed', 'notification.failed'])(
    'propagates %s audit failure and rolls notification/receipt back rather than recasting it as sender failure',
    async (eventType) => {
      const target = await source();
      await reserve(target.id);
      const saved = await booking(target.id);
      const before = await notification(target.id);
      const sender = new ControlledRecordingSender(
        eventType === 'notification.failed'
          ? async () => {
              throw new Error('NTF058_KNOWN_FAILURE');
            }
          : async () => {},
      );
      await withAuditFailure(target.id, eventType, async () => {
        const failure = execute(target.id, sender);
        await expect(failure).rejects.toBeInstanceOf(AuditWriteError);
        await expect(failure).rejects.toThrow('NTF058_TEST_AUDIT_FAILURE');
        expect(sender.calls).toBe(1);
        expect(await notification(target.id)).toEqual(before);
        expect(await receipts(saved.id)).toEqual([]);
        expect(
          (
            await admin.query(
              `SELECT event_id FROM audit_event WHERE event_type IN ('notification.retry.completed','notification.retry.rejected') AND target_id=$1`,
              [target.id],
            )
          ).rows,
        ).toEqual([]);
      });
      // A rollback after recording sender activity cannot prove no side effect.
      // Close this synthetic command as terminal/unknown; do not send again.
      await admin.query(
        `UPDATE outbox_event SET failed_at=now(),last_error='NTF058_SYNTHETIC_ROLLBACK_TERMINAL' WHERE id=$1`,
        [saved.retry_outbox_id],
      );
      expect(await get(target.id)).toMatchObject({
        eligible: false,
        state: 'unknown',
        reason: 'result_unknown',
        version: null,
      });
      expect((await request(target.id, 'A'.repeat(43))).state).toBe('unknown');
      expect(sender.calls).toBe(1);
    },
  );

  it('actual dispatcher gives an audit-rollback command one terminal attempt and exposes unknown without a fabricated receipt', async () => {
    const target = await source();
    await reserve(target.id);
    const saved = await booking(target.id);
    const before = await notification(target.id);
    const sender = new ControlledRecordingSender();
    const handler: OutboxHandler = async (record, client) => {
      await new NotificationRetryService(client, {
        operationSessions: new OperationSessionService(client),
        sender: record.id === saved.retry_outbox_id ? sender : new RecordingEmailSender(),
      }).execute(record);
      return { status: 'ok' };
    };
    const dispatcher = new OutboxDispatcher(
      pool,
      new Map([['notification.manual_retry.requested', handler]]),
      logger,
      { batchSize: 500 },
    );
    await withAuditFailure(target.id, 'notification.retry.completed', async () => {
      const result = await dispatcher.dispatchOnce();
      expect(result.failed).toBeGreaterThanOrEqual(1);
    });
    expect(sender.calls).toBe(1);
    expect(await notification(target.id)).toEqual(before);
    expect(await receipts(saved.id)).toEqual([]);
    const stopped = await original(saved.retry_outbox_id);
    expect(stopped.max_attempts).toBe(1);
    expect(stopped.failed_at).toBeInstanceOf(Date);
    expect(stopped.processed_at).toBeNull();
    expect(await get(target.id)).toMatchObject({
      state: 'unknown',
      reason: 'result_unknown',
      eligible: false,
      version: null,
    });
    await dispatcher.dispatchOnce();
    expect(sender.calls).toBe(1);
    expect((await request(target.id, 'A'.repeat(43))).state).toBe('unknown');
  });

  it.each(['eventType', 'extraPayload', 'outboxIdentity', 'organization', 'maxAttempts'])(
    'fails closed for mismatched worker %s identity without sender or receipt',
    async (mode) => {
      const target = await source();
      await reserve(target.id);
      const saved = await booking(target.id);
      const row = await original(saved.retry_outbox_id);
      const sender = new ControlledRecordingSender();
      const record: OutboxRecordLike = {
        id: row.id,
        organizationId: row.organization_id,
        eventType: row.event_type,
        payload: row.payload,
      };
      if (mode === 'eventType') record.eventType = 'ticket.created';
      if (mode === 'extraPayload')
        record.payload = { ...row.payload, address: 'arbitrary@synthetic.invalid' };
      if (mode === 'outboxIdentity') record.id = uuidv7();
      if (mode === 'organization') record.organizationId = fixture.controlOrganizationId;
      if (mode === 'maxAttempts')
        await admin.query(`UPDATE outbox_event SET max_attempts=2 WHERE id=$1`, [row.id]);
      await expect(
        inOrg(row.organization_id, (client) =>
          new NotificationRetryService(client, {
            operationSessions: new OperationSessionService(client),
            sender,
          }).execute(record),
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(sender.calls).toBe(0);
      expect(await receipts(saved.id)).toEqual([]);
      expect((await notification(target.id)).attempts).toBe(1);
      if (mode === 'maxAttempts')
        await admin.query(`UPDATE outbox_event SET max_attempts=1 WHERE id=$1`, [row.id]);
      await execute(target.id);
    },
  );
});
