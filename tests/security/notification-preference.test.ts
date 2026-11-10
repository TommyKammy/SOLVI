/** WP-P2-NTFPREF-057 / ADR-0039: PostgreSQL preferences, real sessions and delivery. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { createLogger, newContext, runWithContext, SESSION_COOKIE_NAME } from '@solvi/shared';
import { AuditWriteError, uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { AuthController } from '../../services/api/src/modules/auth/auth.routes.js';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import { NotificationPreferenceController } from '../../services/api/src/modules/notification/notification-preference.routes.js';
import {
  NotificationService,
  type NotificationSender,
} from '../../services/api/src/modules/notification/notification.service.js';
import type { OutboxRecordLike } from '../../services/api/src/modules/notification/types.js';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import {
  OutboxDispatcher,
  type OutboxHandler,
} from '../../services/api/src/common/outbox/dispatcher.js';
import { createKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/isolated-knowledge-db.mjs';
import { createCiKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs';
import {
  readKnowledgeFixture,
  type KnowledgeFixture,
} from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';

// Always own a new database; ordinary development URLs are deliberately not accepted.
let runtime:
  | Awaited<ReturnType<typeof createKnowledgeDatabase>>
  | Awaited<ReturnType<typeof createCiKnowledgeDatabase>>
  | undefined;
let admin: pg.Client;
let pool: pg.Pool;
let fixture: KnowledgeFixture;
let authentication: AuthController;
let preferences: NotificationPreferenceController;
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
const ticketEvents = [
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.reassessed',
] as const;
const evidencePath = new URL(
  '../../evidence/WP-P2-NTFPREF-057/20261008/database-lifecycle.json',
  import.meta.url,
);
const migration = readFileSync(
  new URL('../../db/migrations/0034_notification_preference.sql', import.meta.url),
  'utf8',
);
const up = migration.split('-- +migrate up')[1]!.split('-- +migrate down')[0]!;
const down = migration.split('-- +migrate down')[1]!;
const logger = createLogger({
  service: 'ntfpref057-test',
  level: 'error',
  env: 'test',
  sink: () => {},
});

function writeLifecycleEvidence(content: string) {
  // Every run keeps its own report, including failed runs. Exclusive creation
  // prevents an existence-check race from replacing an earlier Evidence file.
  for (let run = 1; run <= 1000; run++) {
    const target =
      run === 1
        ? evidencePath
        : new URL(`database-lifecycle-${String(run).padStart(2, '0')}.json`, evidencePath);
    try {
      writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('NTF057_LIFECYCLE_EVIDENCE_SLOTS_EXHAUSTED');
}

async function issue(userId: string, organizationId: string | null): Promise<TestSession> {
  const result = await new SessionService(admin).issue({
    userId,
    organizationId,
    authMethod: 'local',
  });
  // Token and cookie values stay in memory; never assert or report them.
  return {
    userId,
    organizationId,
    sessionId: result.session.id,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${result.token}` },
  };
}

async function actor(
  name: string,
  role = 'requester',
  org: string | null = fixture.organizationId,
  selected: string | null = fixture.organizationId,
): Promise<TestSession> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO app_user(id,primary_email,display_name,status,created_via)
    VALUES($1,$2,$3,'active','seed')`,
    [id, `${name}-${id}@ntfpref057.test`, `Synthetic ${name}`],
  );
  const binding = await admin.query(
    `INSERT INTO role_binding
    (id,user_id,role_id,role_scope,organization_id,source,valid_from)
    SELECT $1,$2,id,scope,$3,'manual',now()-interval '2 days' FROM role WHERE code=$4`,
    [uuidv7(), id, org, role],
  );
  expect(binding.rowCount).toBe(1);
  return issue(id, selected);
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
    await pool.query(`SELECT current_user AS role,r.rolsuper,r.rolbypassrls,
    c.relname,c.relowner=r.oid AS owns_table,c.relrowsecurity,c.relforcerowsecurity,
    current_setting('row_security') AS row_security
    FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND
    c.oid IN ('notification_preference'::regclass,'notification'::regclass,'outbox_event'::regclass)`)
  ).rows;
  expect(proof).toHaveLength(3);
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
  preferences = new NotificationPreferenceController({ pool, denialRecorder: denials });
  for (const name of ['requester', 'agent', 'admin'] as const)
    sessions[name] = await issue(fixture.actors[name].userId, fixture.organizationId);
  for (const role of ['approver', 'auditor']) sessions[role] = await actor(role, role);
  sessions.foreign = await actor(
    'foreign',
    'requester',
    fixture.controlOrganizationId,
    fixture.controlOrganizationId,
  );
  sessions.platform = await actor('platform', 'platform_admin', null);
  sessions.wrongOrg = await actor('wrong-org', 'requester', fixture.controlOrganizationId);
  sessions.noOrg = await issue(fixture.actors.requester.userId, null);
  for (const name of [
    'expiredRole',
    'futureRole',
    'revoked',
    'expiredSession',
    'inactive',
    'noOp',
    'concurrent',
    'rollback',
    'blockedInactive',
    'blockedRole',
    'rlsOther',
  ])
    sessions[name] = await actor(name);
  await admin.query(
    `UPDATE role_binding SET valid_until=now()-interval '1 minute' WHERE user_id=$1`,
    [sessions.expiredRole.userId],
  );
  await admin.query(`UPDATE role_binding SET valid_from=now()+interval '1 day' WHERE user_id=$1`, [
    sessions.futureRole.userId,
  ]);
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
}, 240000);

afterAll(async () => {
  const closed = await Promise.allSettled([pool?.end(), admin?.end()]);
  const cleanup = await runtime?.cleanup();
  writeLifecycleEvidence(
    JSON.stringify(
      {
        workPackage: 'WP-P2-NTFPREF-057',
        lifecycleHelper: 'WP-P3-KNWUI-054 (read-only reuse; physical label unchanged)',
        syntheticOnly: true,
        verificationTransport:
          'public controller with real auth/session and delivery service; HTTP separately required',
        nonOwnerForcedRlsTables: verifiedRlsTables,
        migrationUpDownUpVerified: migrationCycleVerified,
        rlsReadBoundary: 'organization; same-org other-user boolean is directly readable',
        rlsWriteBoundary: 'organization and current actor; no DELETE grant',
        connectionsClosed: closed.every((result) => result.status === 'fulfilled'),
        cleanup,
      },
      null,
      2,
    ) + '\n',
  );
  expect(closed.every((result) => result.status === 'fulfilled')).toBe(true);
  if (cleanup) expect(cleanup.success).toBe(true);
}, 60000);

async function get(session = sessions.requester, query = new URLSearchParams()) {
  return runWithContext(newContext(), async () => {
    const auth = await authentication.authenticate(session.headers);
    const response = await preferences.get(auth, query);
    expect(response.status).toBe(200);
    return response.body;
  });
}

function headers(session: TestSession) {
  return {
    ...session.headers,
    'content-type': 'application/json',
    'x-solvi-form-scope': `${session.organizationId}:${session.userId}`,
  };
}

async function update(
  session: TestSession,
  enabled: boolean,
  overrides: Record<string, string | string[] | undefined> = {},
  body: unknown = { ticketEmailEnabled: enabled },
  query = new URLSearchParams(),
) {
  return runWithContext(newContext(), async () => {
    const requestHeaders = { ...headers(session), ...overrides };
    const auth = await authentication.authenticate(requestHeaders);
    const response = await preferences.update(auth, requestHeaders, body, query);
    expect(response.status).toBe(200);
    return response.body;
  });
}

async function inOrg<T>(org: string, fn: (client: pg.PoolClient) => Promise<T>, actorId?: string) {
  return runWithContext(newContext(), async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.current_actor',$2,true)",
        [org, actorId ?? ''],
      );
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

async function setting(session: TestSession) {
  return (
    await admin.query(
      `SELECT organization_id,user_id,ticket_email_enabled,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM notification_preference WHERE organization_id=$1 AND user_id=$2`,
      [session.organizationId, session.userId],
    )
  ).rows;
}

async function configAudits(session: TestSession) {
  return (
    await admin.query(
      `SELECT event_type,organization_id,actor_type,actor_id,
    subject_user_id,before_state,after_state,outcome FROM audit_event
    WHERE event_type='config.changed' AND organization_id=$1 AND subject_user_id=$2
    ORDER BY occurred_at,event_id`,
      [session.organizationId, session.userId],
    )
  ).rows;
}

async function businessDigest() {
  const tables = (
    await admin.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables
    WHERE schemaname='public' AND tablename<>'notification_preference' ORDER BY tablename`)
  ).rows;
  const result: Record<string, string> = {};
  for (const table of tables)
    result[table.name] = (
      await admin.query<{ hash: string }>(
        `SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) AS hash
     FROM ${pg.escapeIdentifier(table.name)} t`,
      )
    ).rows[0]!.hash;
  return result;
}

async function notificationDigest() {
  return (
    await admin.query(`SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id)::text,'[]')) FROM notification n) AS notification,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id)::text,'[]')) FROM outbox_event o) AS outbox`)
  ).rows[0];
}

async function waitForBlockedSaver() {
  for (let i = 0; i < 100; i++) {
    const result = await admin.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND usename='solvi_app'
      AND wait_event_type='Lock' AND wait_event='advisory'`);
    if (result.rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('NTF057_SAVER_DID_NOT_WAIT_FOR_LOCK');
}

async function waitForRoleExpiry(userId: string) {
  for (let i = 0; i < 200; i++) {
    const result = await admin.query<{ expired: boolean }>(
      `SELECT bool_and(
      valid_until IS NOT NULL AND valid_until <= clock_timestamp()) AS expired
      FROM role_binding WHERE user_id=$1`,
      [userId],
    );
    if (result.rows[0]?.expired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('NTF057_ROLE_DID_NOT_EXPIRE_WHILE_WAITING');
}

class RecordingSender implements NotificationSender {
  readonly channel = 'email' as const;
  readonly calls: Array<{ to: string; subject: string; linkPath: string }> = [];
  constructor(private readonly behavior: (call: number) => Promise<void> = async () => {}) {}
  async send(value: { to: string; subject: string; linkPath: string }) {
    this.calls.push(value);
    await this.behavior(this.calls.length);
  }
}

async function event(eventType = 'ticket.created', visibility?: string) {
  const actorAuth = fixture.actors.admin.auth;
  const ticket = await inOrg(fixture.organizationId, (client) =>
    new TicketService(client, denials).create(actorAuth.authz, {
      kind: 'incident',
      subject: 'WP057 synthetic ticket',
      body: 'NTF057_PRIVATE_BODY',
      impact: 'medium',
      urgency: 'medium',
      requesterId: fixture.actors.requester.userId,
    }),
  );
  const original = (
    await admin.query(
      `SELECT id,payload FROM outbox_event
    WHERE event_type='ticket.created' AND payload->>'ticketId'=$1`,
      [ticket.id],
    )
  ).rows[0];
  if (eventType === 'ticket.created' && visibility === undefined)
    return {
      ticket,
      record: {
        id: original.id as string,
        organizationId: fixture.organizationId,
        eventType,
        payload: original.payload,
      } satisfies OutboxRecordLike,
    };
  const record: OutboxRecordLike = {
    id: uuidv7(),
    organizationId: fixture.organizationId,
    eventType,
    payload: { ...original.payload, ...(visibility ? { visibility } : {}) },
  };
  await admin.query(
    `INSERT INTO outbox_event(id,organization_id,event_type,payload)
    VALUES($1,$2,$3,$4::jsonb)`,
    [record.id, record.organizationId, record.eventType, JSON.stringify(record.payload)],
  );
  return { ticket, record };
}

function deliver(
  record: OutboxRecordLike,
  sender: NotificationSender,
  org = fixture.organizationId,
) {
  // Production delivery has an organization and deliberately has no current_actor.
  return inOrg(org, (client) =>
    new NotificationService(client, new Map([['email', sender]])).deliverForEvent(record),
  );
}

async function notices(record: OutboxRecordLike) {
  return (await admin.query('SELECT * FROM notification WHERE outbox_event_id=$1', [record.id]))
    .rows;
}

describe('WP057 persistence and public API with actual PostgreSQL sessions', () => {
  it('supports additive up/down/up without changing any pre-existing row', async () => {
    await admin.query(
      `INSERT INTO notification_preference(organization_id,user_id,ticket_email_enabled)
      VALUES($1,$2,false)`,
      [fixture.organizationId, fixture.actors.requester.userId],
    );
    const before = await businessDigest();
    await admin.query(down);
    expect(
      (await admin.query("SELECT to_regclass('public.notification_preference') AS name")).rows[0]
        .name,
    ).toBeNull();
    await admin.query(up);
    expect(await businessDigest()).toEqual(before);
    expect((await admin.query('SELECT * FROM notification_preference')).rows).toEqual([]);
    migrationCycleVerified = true;
  });

  it.each(['requester', 'agent', 'admin', 'approver', 'auditor'])(
    'returns the default ON boolean for an unconfigured valid %s member',
    async (name) => {
      expect(await get(sessions[name])).toEqual({ ticketEmailEnabled: true });
      expect(await setting(sessions[name])).toEqual([]);
    },
  );

  it.each(['platform', 'wrongOrg', 'expiredRole', 'futureRole', 'noOrg'])(
    'rejects %s without a current selected-org membership',
    async (name) => {
      await expect(get(sessions[name])).rejects.toMatchObject({ status: 403 });
      await expect(update(sessions[name], false)).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(['inactive', 'revoked', 'expiredSession'])(
    'rejects %s through real authentication',
    async (name) => {
      await expect(get(sessions[name])).rejects.toMatchObject({ status: 401 });
      await expect(update(sessions[name], false)).rejects.toMatchObject({ status: 401 });
    },
  );

  it('persists only the authenticated member setting, without changing notification or Outbox rows', async () => {
    const before = await notificationDigest();
    const foreignBefore = await setting(sessions.foreign);
    expect(await update(sessions.auditor, false)).toEqual({ ticketEmailEnabled: false });
    expect(await get(sessions.auditor)).toEqual({ ticketEmailEnabled: false });
    expect(await get(sessions.requester)).toEqual({ ticketEmailEnabled: true });
    expect(await setting(sessions.foreign)).toEqual(foreignBefore);
    expect(await notificationDigest()).toEqual(before);
    expect(await update(sessions.auditor, true)).toEqual({ ticketEmailEnabled: true });
    const audits = await configAudits(sessions.auditor);
    expect(audits).toHaveLength(2);
    for (const row of audits)
      expect(row).toMatchObject({
        event_type: 'config.changed',
        organization_id: fixture.organizationId,
        actor_type: 'user',
        actor_id: sessions.auditor.userId,
        subject_user_id: sessions.auditor.userId,
        outcome: 'success',
      });
    expect(audits.map((row) => row.before_state)).toEqual([
      { ticketEmailEnabled: true },
      { ticketEmailEnabled: false },
    ]);
    expect(audits.map((row) => row.after_state)).toEqual([
      { ticketEmailEnabled: false },
      { ticketEmailEnabled: true },
    ]);
  });

  it('treats default ON and repeated saves as a no-op without timestamps or extra audits', async () => {
    expect(await update(sessions.noOp, true)).toEqual({ ticketEmailEnabled: true });
    expect(await setting(sessions.noOp)).toEqual([]);
    expect(await configAudits(sessions.noOp)).toEqual([]);
    await update(sessions.noOp, false);
    const before = await setting(sessions.noOp);
    await update(sessions.noOp, false);
    expect(await setting(sessions.noOp)).toEqual(before);
    expect(await configAudits(sessions.noOp)).toHaveLength(1);
  });

  it('serializes concurrent same-value saves into one row and one audit', async () => {
    const result = await Promise.all(
      Array.from({ length: 6 }, () => update(sessions.concurrent, false)),
    );
    expect(result.every((value) => value.ticketEmailEnabled === false)).toBe(true);
    expect(await setting(sessions.concurrent)).toHaveLength(1);
    expect(await configAudits(sessions.concurrent)).toHaveLength(1);
    const before = await setting(sessions.concurrent);
    await Promise.all(Array.from({ length: 4 }, () => update(sessions.concurrent, false)));
    expect(await setting(sessions.concurrent)).toEqual(before);
    expect(await configAudits(sessions.concurrent)).toHaveLength(1);
  });

  it.each(['userId=x', 'organizationId=x', 'ticketEmailEnabled=false', 'q=x'])(
    'rejects unsupported GET and PATCH query %s',
    async (query) => {
      await expect(get(sessions.requester, new URLSearchParams(query))).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        update(sessions.requester, false, {}, undefined, new URLSearchParams(query)),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  it.each([
    null,
    [],
    {},
    true,
    { ticketEmailEnabled: 'false' },
    { ticketEmailEnabled: 0 },
    { ticketEmailEnabled: false, userId: 'forged' },
    { ticketEmailEnabled: false, organizationId: 'forged' },
    { ticketEmailEnabled: false, recipient: 'forged@example.test' },
  ])('rejects a non-boolean or mass-assigned payload %#', async (body) => {
    await expect(update(sessions.requester, false, {}, body)).rejects.toMatchObject({
      status: 400,
    });
  });

  it.each([
    undefined,
    '',
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ])('requires JSON content type %#', async (contentType) => {
    await expect(
      update(sessions.requester, false, { 'content-type': contentType }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts JSON with UTF-8 charset through the server-fetch contract', async () => {
    expect(
      await update(sessions.noOp, false, { 'content-type': 'application/json; charset=utf-8' }),
    ).toEqual({ ticketEmailEnabled: false });
  });

  it.each([undefined, '', 'wrong', ['duplicate', 'duplicate']])(
    'requires one matching actor/org scope header %#',
    async (scope) => {
      await expect(
        update(sessions.requester, false, { 'x-solvi-form-scope': scope }),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it.each([
    undefined,
    '',
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ])('requires JSON content type %#', async (contentType) => {
    await expect(
      update(sessions.requester, false, { 'content-type': contentType }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts JSON with UTF-8 charset through the server-fetch contract', async () => {
    expect(
      await update(sessions.noOp, false, { 'content-type': 'application/json; charset=utf-8' }),
    ).toEqual({ ticketEmailEnabled: false });
  });

  it.each([undefined, '', 'wrong', ['duplicate', 'duplicate']])(
    'requires one matching actor/org scope header %#',
    async (scope) => {
      await expect(
        update(sessions.requester, false, { 'x-solvi-form-scope': scope }),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it('accepts JSON with UTF-8 charset through the server-fetch contract', async () => {
    expect(
      await update(sessions.noOp, false, { 'content-type': 'application/json; charset=utf-8' }),
    ).toEqual({ ticketEmailEnabled: false });
  });

  it.each([undefined, '', 'wrong', ['duplicate', 'duplicate']])(
    'requires one matching actor/org scope header %#',
    async (scope) => {
      await expect(
        update(sessions.requester, false, { 'x-solvi-form-scope': scope }),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it.each(['https://untrusted.example', 'null', 'http://localhost:3000', ''])(
    'rejects any Origin-bearing direct API write %#',
    async (origin) => {
      await expect(update(sessions.requester, false, { origin })).rejects.toMatchObject({
        status: 403,
      });
    },
  );

  it('applies org-read/self-write RLS and denies DELETE using the real non-owner app role', async () => {
    await update(sessions.rlsOther, false);
    await update(sessions.foreign, false);
    await inOrg(
      fixture.organizationId,
      async (client) => {
        expect(
          (
            await client.query(
              `SELECT user_id,ticket_email_enabled FROM notification_preference
        WHERE user_id=$1`,
              [sessions.rlsOther.userId],
            )
          ).rows,
        ).toEqual([{ user_id: sessions.rlsOther.userId, ticket_email_enabled: false }]);
        expect(
          (
            await client.query(
              'SELECT user_id FROM notification_preference WHERE organization_id=$1',
              [fixture.controlOrganizationId],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await client.query(
              'UPDATE notification_preference SET ticket_email_enabled=true WHERE user_id=$1',
              [sessions.rlsOther.userId],
            )
          ).rowCount,
        ).toBe(0);
      },
      sessions.requester.userId,
    );
    for (const [org, user] of [
      [fixture.organizationId, sessions.agent.userId],
      [fixture.controlOrganizationId, sessions.foreign.userId],
    ])
      await expect(
        inOrg(
          fixture.organizationId,
          (client) =>
            client.query(
              `INSERT INTO
        notification_preference(organization_id,user_id,ticket_email_enabled) VALUES($1,$2,false)`,
              [org, user],
            ),
          sessions.requester.userId,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inOrg(
        fixture.organizationId,
        (client) => client.query('DELETE FROM notification_preference'),
        sessions.requester.userId,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inOrg(fixture.organizationId, (client) =>
        client.query(
          `INSERT INTO
      notification_preference(organization_id,user_id) VALUES($1,$2)`,
          [fixture.organizationId, sessions.requester.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await inOrg(
      '',
      async (client) => {
        expect((await client.query('SELECT * FROM notification_preference')).rows).toEqual([]);
      },
      sessions.requester.userId,
    );
    await inOrg(
      fixture.controlOrganizationId,
      async (client) => {
        expect((await client.query('SELECT user_id FROM notification_preference')).rows).toEqual([
          { user_id: sessions.foreign.userId },
        ]);
      },
      sessions.foreign.userId,
    );
  });

  it('enforces preference primary key, both foreign keys and non-null values in PostgreSQL', async () => {
    await expect(
      admin.query(
        `INSERT INTO notification_preference(organization_id,user_id)
      VALUES($1,$2)`,
        [fixture.organizationId, sessions.rlsOther.userId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    for (const [org, user] of [
      [uuidv7(), sessions.requester.userId],
      [fixture.organizationId, uuidv7()],
    ])
      await expect(
        admin.query(
          `INSERT INTO notification_preference(organization_id,user_id)
        VALUES($1,$2)`,
          [org, user],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin.query(
        `INSERT INTO notification_preference
      (organization_id,user_id,ticket_email_enabled) VALUES($1,$2,NULL)`,
        [fixture.organizationId, sessions.requester.userId],
      ),
    ).rejects.toMatchObject({ code: '23502' });
    await expect(
      admin.query(
        `INSERT INTO notification_preference
      (organization_id,user_id,updated_at) VALUES($1,$2,NULL)`,
        [fixture.organizationId, sessions.requester.userId],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('rolls back a changed preference when the real config audit INSERT fails', async () => {
    const trigger = 'ntf057_config_audit_failure';
    await admin.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='config.changed' AND NEW.subject_user_id::text=TG_ARGV[0]
        THEN RAISE EXCEPTION 'NTF057_TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$`);
    await admin.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_event FOR EACH ROW
      EXECUTE FUNCTION ${trigger}(${pg.escapeLiteral(sessions.rollback.userId)})`);
    try {
      const failedSave = update(sessions.rollback, false);
      await expect(failedSave).rejects.toBeInstanceOf(AuditWriteError);
      await expect(failedSave).rejects.toThrow('NTF057_TEST_AUDIT_FAILURE');
      expect(await setting(sessions.rollback)).toEqual([]);
      expect(await configAudits(sessions.rollback)).toEqual([]);
    } finally {
      await admin.query(`DROP TRIGGER ${trigger} ON audit_event`);
      await admin.query(`DROP FUNCTION ${trigger}()`);
    }
    // A later request proves the failed transaction/connection was released and usable.
    expect(await update(sessions.rollback, false)).toEqual({ ticketEmailEnabled: false });
  });

  it.each(['blockedInactive', 'blockedRole'])(
    'revalidates %s immediately before saving after waiting for the transaction lock',
    async (name) => {
      const session = sessions[name];
      if (name === 'blockedRole')
        await admin.query(
          `UPDATE role_binding SET valid_until=clock_timestamp()+interval '2 seconds'
         WHERE user_id=$1`,
          [session.userId],
        );
      await admin.query('BEGIN');
      await admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `notification-preference:${session.organizationId}:${session.userId}`,
      ]);
      const pending = update(session, false).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let committed = false;
      try {
        await waitForBlockedSaver();
        if (name === 'blockedInactive')
          await admin.query(
            `UPDATE app_user SET status='deactivated',deactivated_at=now() WHERE id=$1`,
            [session.userId],
          );
        else await waitForRoleExpiry(session.userId);
        await admin.query('COMMIT');
        committed = true;
        expect((await pending).error).toMatchObject({ status: 403 });
        expect(await setting(session)).toEqual([]);
        expect(await configAudits(session)).toEqual([]);
      } finally {
        if (!committed) await admin.query('ROLLBACK');
        await pending;
      }
    },
  );
});

describe('WP057 optional Email delivery with actual PostgreSQL and existing retry', () => {
  it('processes an all-suppressed Outbox event without a notification and never replays it after ON', async () => {
    await update(sessions.requester, false);
    const { record } = await event();
    const sender = new RecordingSender();
    const handler: OutboxHandler = async (value, client) => {
      await new NotificationService(client, new Map([['email', sender]])).deliverForEvent(value);
      return { status: 'ok' };
    };
    const dispatcher = new OutboxDispatcher(pool, new Map([['ticket.created', handler]]), logger);
    expect((await dispatcher.dispatchOnce()).succeeded).toBe(1);
    expect(sender.calls).toEqual([]);
    expect(await notices(record)).toEqual([]);
    const processed = (
      await admin.query('SELECT processed_at,failed_at FROM outbox_event WHERE id=$1', [record.id])
    ).rows[0];
    expect(processed.processed_at).toBeInstanceOf(Date);
    expect(processed.failed_at).toBeNull();
    await update(sessions.requester, true);
    expect((await dispatcher.dispatchOnce()).succeeded).toBe(0);
    expect(sender.calls).toEqual([]);
    expect(await notices(record)).toEqual([]);
  });

  it.each(ticketEvents)(
    'suppresses only new %s Email rows while OFF, then sends a later event while ON',
    async (type) => {
      await update(sessions.requester, false);
      const first = await event(type);
      const sender = new RecordingSender();
      expect(await deliver(first.record, sender)).toMatchObject({ sent: 0 });
      expect(await notices(first.record)).toEqual([]);
      expect(sender.calls).toEqual([]);
      await update(sessions.requester, true);
      const second = await event(type);
      expect(await deliver(second.record, sender)).toMatchObject({ sent: 1 });
      expect(await notices(second.record)).toMatchObject([{ status: 'sent', attempts: 1 }]);
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].subject).not.toContain('NTF057_PRIVATE_BODY');
    },
  );

  it('keeps committed failed rows retrying under the same ID after OFF, then skips sent rows', async () => {
    await update(sessions.requester, true);
    const { record } = await event();
    await inOrg(fixture.organizationId, async (client) => {
      try {
        await new NotificationService(
          client,
          new Map([
            [
              'email',
              new RecordingSender(async () => {
                throw new Error('NTF057_TRANSIENT');
              }),
            ],
          ]),
        ).deliverForEvent(record);
        throw new Error('NTF057_EXPECTED_SENDER_FAILURE');
      } catch (error) {
        expect((error as Error).message).toBe('NTF057_TRANSIENT');
      }
    });
    const failed = (await notices(record))[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    await update(sessions.requester, false);
    const sender = new RecordingSender();
    expect(await deliver(record, sender)).toMatchObject({ sent: 1 });
    expect(await notices(record)).toMatchObject([
      { id: failed.id, status: 'sent', attempts: 2, failed_at: null, last_error: null },
    ]);
    const before = await notices(record);
    expect(await deliver(record, sender)).toMatchObject({ sent: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(await notices(record)).toEqual(before);
  });

  it('recovers an existing pending row after OFF rather than treating it as a new notification', async () => {
    await update(sessions.requester, false);
    const { record } = await event();
    const id = uuidv7();
    await admin.query(
      `INSERT INTO notification(id,organization_id,outbox_event_id,channel,
      recipient_user_id,recipient_address,subject,link_path,status)
      VALUES($1,$2,$3,'email',$4,$5,'Synthetic pending','/tickets','pending')`,
      [
        id,
        fixture.organizationId,
        record.id,
        fixture.actors.requester.userId,
        fixture.actors.requester.email,
      ],
    );
    const sender = new RecordingSender();
    expect(await deliver(record, sender)).toMatchObject({ sent: 1 });
    expect(await notices(record)).toMatchObject([{ id, status: 'sent', attempts: 1 }]);
    expect(sender.calls).toHaveLength(1);
  });

  it.each(['user', 'channel'] as const)(
    'fails closed on an existing %s identity mismatch even after OFF',
    async (mismatch) => {
      await update(sessions.requester, false);
      const { record } = await event();
      await admin.query(
        `INSERT INTO notification(id,organization_id,outbox_event_id,channel,
        recipient_user_id,recipient_address,subject,link_path,status)
        VALUES($1,$2,$3,$4,$5,$6,'Synthetic mismatch','/tickets','pending')`,
        [
          uuidv7(),
          fixture.organizationId,
          record.id,
          mismatch === 'channel' ? 'webhook' : 'email',
          mismatch === 'user' ? fixture.actors.agent.userId : fixture.actors.requester.userId,
          fixture.actors.requester.email,
        ],
      );
      const before = await notices(record);
      const sender = new RecordingSender();
      await expect(deliver(record, sender)).rejects.toThrow('通知の再試行対象が一致しません');
      expect(sender.calls).toEqual([]);
      expect(await notices(record)).toEqual(before);
    },
  );

  it('can create a previously suppressed recipient after ON while another failed recipient keeps the event retryable', async () => {
    await update(sessions.requester, false);
    await update(sessions.agent, true);
    const { record, ticket } = await event();
    await admin.query('UPDATE ticket SET assignee_id=$1 WHERE id=$2', [
      fixture.actors.agent.userId,
      ticket.id,
    ]);
    await inOrg(fixture.organizationId, async (client) => {
      try {
        await new NotificationService(
          client,
          new Map([
            [
              'email',
              new RecordingSender(async () => {
                throw new Error('NTF057_TRANSIENT');
              }),
            ],
          ]),
        ).deliverForEvent(record);
        throw new Error('NTF057_EXPECTED_SENDER_FAILURE');
      } catch (error) {
        expect((error as Error).message).toBe('NTF057_TRANSIENT');
      }
    });
    const failed = (await notices(record))[0];
    expect(failed).toMatchObject({
      recipient_user_id: fixture.actors.agent.userId,
      status: 'failed',
    });
    await update(sessions.requester, true);
    const sender = new RecordingSender();
    expect(await deliver(record, sender)).toMatchObject({ sent: 2 });
    const final = await notices(record);
    expect(final).toHaveLength(2);
    expect(final.find((row) => row.id === failed.id)).toMatchObject({
      attempts: 2,
      status: 'sent',
    });
    expect(new Set(sender.calls.map((call) => call.to)).size).toBe(2);
  });

  it('retries only the failed recipient of a partial success after both recipients turn OFF', async () => {
    await update(sessions.requester, true);
    await update(sessions.agent, true);
    const { record, ticket } = await event();
    await admin.query('UPDATE ticket SET assignee_id=$1 WHERE id=$2', [
      fixture.actors.agent.userId,
      ticket.id,
    ]);
    await inOrg(fixture.organizationId, async (client) => {
      try {
        await new NotificationService(
          client,
          new Map([
            [
              'email',
              new RecordingSender(async (call) => {
                if (call === 2) throw new Error('NTF057_TRANSIENT');
              }),
            ],
          ]),
        ).deliverForEvent(record);
        throw new Error('NTF057_EXPECTED_SENDER_FAILURE');
      } catch (error) {
        expect((error as Error).message).toBe('NTF057_TRANSIENT');
      }
    });
    const initial = await notices(record);
    expect(initial).toHaveLength(2);
    const successful = initial.find((row) => row.status === 'sent');
    const failed = initial.find((row) => row.status === 'failed');
    expect(successful).toBeDefined();
    expect(failed).toBeDefined();
    await update(sessions.requester, false);
    await update(sessions.agent, false);
    const sender = new RecordingSender();
    expect(await deliver(record, sender)).toMatchObject({ sent: 1 });
    expect(sender.calls).toHaveLength(1);
    const final = await notices(record);
    expect(final.find((row) => row.id === successful!.id)).toEqual(successful);
    expect(final.find((row) => row.id === failed!.id)).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
  });

  it('does not apply optional settings to role-binding expiry notices', async () => {
    await update(sessions.requester, false);
    await update(sessions.admin, false);
    const record: OutboxRecordLike = {
      id: uuidv7(),
      organizationId: fixture.organizationId,
      eventType: 'role.binding.expiring',
      payload: {
        userId: fixture.actors.requester.userId,
        validUntil: new Date(Date.now() + 3 * 86400000).toISOString(),
      },
    };
    await admin.query(
      `INSERT INTO outbox_event(id,organization_id,event_type,payload)
      VALUES($1,$2,$3,$4::jsonb)`,
      [record.id, record.organizationId, record.eventType, JSON.stringify(record.payload)],
    );
    const sender = new RecordingSender();
    await deliver(record, sender);
    const recipients = (await notices(record)).map((row) => row.recipient_user_id);
    expect(recipients).toContain(fixture.actors.requester.userId);
    expect(recipients).toContain(fixture.actors.admin.userId);
    expect(sender.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves internal-note non-notification and foreign-org recipient isolation', async () => {
    await update(sessions.requester, true);
    const internal = await event('ticket.comment.added', 'internal');
    const sender = new RecordingSender();
    expect(await deliver(internal.record, sender)).toMatchObject({ sent: 0 });
    expect(await notices(internal.record)).toEqual([]);
    const foreign = await event();
    await admin.query('UPDATE ticket SET assignee_id=$1 WHERE id=$2', [
      sessions.foreign.userId,
      foreign.ticket.id,
    ]);
    await deliver(foreign.record, sender);
    expect((await notices(foreign.record)).map((row) => row.recipient_user_id)).toEqual([
      fixture.actors.requester.userId,
    ]);
    expect(
      await deliver(foreign.record, new RecordingSender(), fixture.controlOrganizationId),
    ).toMatchObject({ sent: 0 });
  });

  it('keeps populated notification and Outbox history unchanged when saving a new preference', async () => {
    expect(
      (await admin.query('SELECT count(*)::integer AS count FROM notification')).rows[0].count,
    ).toBeGreaterThan(0);
    const before = await notificationDigest();
    await update(sessions.requester, false);
    await update(sessions.requester, true);
    expect(await notificationDigest()).toEqual(before);
  });
});
