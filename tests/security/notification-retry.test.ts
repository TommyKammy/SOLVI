/** WP-P2-NTF-055 / FR-TKT-007 / FR-TKT-004 / NFR-SEC-001 / NFR-SEC-006. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { createLogger, newContext, runWithContext } from '@solvi/shared';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import {
  OutboxDispatcher,
  backoffSeconds,
  type OutboxHandler,
} from '../../services/api/src/common/outbox/dispatcher.js';
import {
  NotificationService,
  buildSubject,
  type NotificationSender,
} from '../../services/api/src/modules/notification/notification.service.js';
import type { OutboxRecordLike } from '../../services/api/src/modules/notification/types.js';
import { createKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/isolated-knowledge-db.mjs';
import { createCiKnowledgeDatabase } from '../../evidence/WP-P3-KNWUI-054/20261007/ci-knowledge-db.mjs';
import type { KnowledgeFixture } from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';
import { readKnowledgeFixture } from '../../evidence/WP-P3-KNWUI-054/20261007/knowledge-fixture.mjs';

// Own a new disposable database. Never accept an ordinary development DB URL.
let runtime:
  | Awaited<ReturnType<typeof createKnowledgeDatabase>>
  | Awaited<ReturnType<typeof createCiKnowledgeDatabase>>
  | undefined;
let admin: pg.Client;
let pool: pg.Pool;
let fixture: KnowledgeFixture;
let denials: PoolDenialRecorder;
let verifiedRlsTables = 0;
const logger = createLogger({
  service: 'ntf055-test',
  level: 'error',
  env: 'test',
  sink: () => {},
});
const evidencePath = new URL(
  '../../evidence/WP-P2-NTF-055/20261007/database-lifecycle.json',
  import.meta.url,
);

beforeAll(async () => {
  runtime =
    process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
      ? await createCiKnowledgeDatabase()
      : await createKnowledgeDatabase();
  admin = new pg.Client({ connectionString: runtime.adminUrl, statement_timeout: 10000 });
  await admin.connect();
  pool = new pg.Pool({ connectionString: runtime.appUrl, max: 5, statement_timeout: 10000 });
  denials = new PoolDenialRecorder(pool);
  const proof = (
    await pool.query(
      `SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
              c.relname, c.relowner = r.oid AS owns_table,
              c.relrowsecurity, c.relforcerowsecurity
         FROM pg_roles r CROSS JOIN pg_class c
        WHERE r.rolname = current_user
          AND c.oid IN ('notification'::regclass, 'outbox_event'::regclass)`,
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
    });
  verifiedRlsTables = proof.length;
  fixture = await readKnowledgeFixture(admin);
}, 240000);

afterAll(async () => {
  const closed = await Promise.allSettled([pool?.end(), admin?.end()]);
  const cleanup = await runtime?.cleanup();
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        workPackage: 'WP-P2-NTF-055',
        lifecycleHelper: 'WP-P3-KNWUI-054 (read-only reuse)',
        syntheticOnly: true,
        sender: 'recording-only',
        nonOwnerForcedRlsTables: verifiedRlsTables,
        connectionsClosed: closed.every((r) => r.status === 'fulfilled'),
        cleanup,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  expect(closed.every((r) => r.status === 'fulfilled')).toBe(true);
  if (cleanup) expect(cleanup.success).toBe(true);
}, 60000);

async function inOrg<T>(org: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return runWithContext(newContext(), async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', org]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

class ScriptedSender implements NotificationSender {
  readonly channel = 'email' as const;
  readonly calls: Array<{ to: string; subject: string; linkPath: string }> = [];
  constructor(
    private readonly behavior: (
      call: number,
      params: { to: string; subject: string; linkPath: string },
    ) => Promise<void> = async () => {},
  ) {}
  async send(params: { to: string; subject: string; linkPath: string }) {
    this.calls.push(params);
    await this.behavior(this.calls.length, params);
  }
}

async function event() {
  const actor = fixture.actors.agent.auth;
  const ticket = await inOrg(fixture.organizationId, (client) =>
    new TicketService(client, denials).create(actor.authz, {
      kind: 'incident',
      subject: 'WP055 synthetic request',
      body: 'NTF055_PRIVATE_BODY',
      impact: 'medium',
      urgency: 'medium',
      requesterId: fixture.actors.requester.userId,
    }),
  );
  const row = (
    await admin.query(
      "SELECT id, payload FROM outbox_event WHERE event_type = 'ticket.created' AND payload->>'ticketId' = $1",
      [ticket.id],
    )
  ).rows[0];
  return {
    ticket,
    record: {
      id: row.id as string,
      organizationId: fixture.organizationId,
      eventType: 'ticket.created',
      payload: row.payload,
    } satisfies OutboxRecordLike,
  };
}

function deliver(
  record: OutboxRecordLike,
  sender: NotificationSender,
  org = fixture.organizationId,
) {
  return inOrg(org, (client) =>
    new NotificationService(client, new Map([['email', sender]])).deliverForEvent(record),
  );
}

function dispatcher(sender: NotificationSender) {
  // Same catch-and-return contract as the production API main handler.
  const handler: OutboxHandler = async (record, client) => {
    try {
      await new NotificationService(client, new Map([['email', sender]])).deliverForEvent(record);
      return { status: 'ok' };
    } catch {
      return { status: 'retry', reason: 'NTF055_TRANSIENT' };
    }
  };
  return new OutboxDispatcher(pool, new Map([['ticket.created', handler]]), logger);
}

async function notifications(id: string) {
  return (await admin.query('SELECT * FROM notification WHERE outbox_event_id = $1', [id])).rows;
}
async function retryDue(id: string) {
  await admin.query(
    "UPDATE outbox_event SET available_at = now() - interval '1 second', locked_until = NULL WHERE id = $1",
    [id],
  );
}
async function failFirst(record: OutboxRecordLike) {
  // Capture sender errors as production does; commit the failed row for retry.
  return inOrg(fixture.organizationId, async (client) => {
    try {
      await new NotificationService(
        client,
        new Map([
          [
            'email',
            new ScriptedSender(async () => {
              throw new Error('NTF055_TRANSIENT');
            }),
          ],
        ]),
      ).deliverForEvent(record);
    } catch (error) {
      expect((error as Error).message).toBe('NTF055_TRANSIENT');
    }
  });
}

describe('WP055 notification recovery with actual PostgreSQL / Outbox / FORCE RLS', () => {
  it('committed failure is retried with the same ID and real Outbox completion', async () => {
    const { record } = await event();
    const sender = new ScriptedSender(async (call) => {
      if (call === 1) throw new Error('NTF055_TRANSIENT');
    });
    const dispatch = dispatcher(sender);
    expect((await dispatch.dispatchOnce()).retried).toBe(1);
    const failed = (await notifications(record.id))[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    const queued = (await admin.query('SELECT * FROM outbox_event WHERE id = $1', [record.id]))
      .rows[0];
    expect(queued.available_at.getTime() - queued.created_at.getTime()).toBeGreaterThanOrEqual(
      backoffSeconds(1) * 1000,
    );
    await retryDue(record.id);
    expect((await dispatch.dispatchOnce()).succeeded).toBe(1);
    expect(sender.calls).toHaveLength(2);
    expect(await notifications(record.id)).toMatchObject([
      { id: failed.id, status: 'sent', attempts: 2, failed_at: null, last_error: null },
    ]);
    const final = (
      await admin.query('SELECT processed_at, failed_at FROM outbox_event WHERE id = $1', [
        record.id,
      ])
    ).rows[0];
    expect(final.processed_at).toBeInstanceOf(Date);
    expect(final.failed_at).toBeNull();
  });

  it('a sent recipient is skipped on repeated event delivery', async () => {
    const { record } = await event();
    const sender = new ScriptedSender();
    expect(await deliver(record, sender)).toEqual({ sent: 1, skipped: 0 });
    expect(await deliver(record, sender)).toEqual({ sent: 0, skipped: 1 });
    expect(sender.calls).toHaveLength(1);
    expect(await notifications(record.id)).toMatchObject([{ status: 'sent', attempts: 1 }]);
  });

  it('recovers an existing pending row without creating a second ID', async () => {
    const { record, ticket } = await event();
    const id = uuidv7();
    await admin.query(
      `INSERT INTO notification (id, organization_id, outbox_event_id, channel,
        recipient_user_id, recipient_address, subject, link_path, status)
       VALUES ($1, $2, $3, 'email', $4, $5, $6, $7, 'pending')`,
      [
        id,
        fixture.organizationId,
        record.id,
        fixture.actors.requester.userId,
        fixture.actors.requester.email,
        buildSubject('ticket.created', ticket.number),
        `/tickets/${ticket.id}`,
      ],
    );
    expect(await deliver(record, new ScriptedSender())).toEqual({ sent: 1, skipped: 0 });
    expect(await notifications(record.id)).toMatchObject([{ id, status: 'sent', attempts: 1 }]);
  });

  it('partial success retries only the failed recipient', async () => {
    const { record, ticket } = await event();
    await admin.query('UPDATE ticket SET assignee_id = $2 WHERE id = $1', [
      ticket.id,
      fixture.actors.admin.userId,
    ]);
    const sender = new ScriptedSender(async (call) => {
      if (call === 2) throw new Error('NTF055_TRANSIENT');
    });
    const dispatch = dispatcher(sender);
    expect((await dispatch.dispatchOnce()).retried).toBe(1);
    const first = await notifications(record.id);
    expect(first.map((r) => r.status).sort()).toEqual(['failed', 'sent']);
    await retryDue(record.id);
    expect((await dispatch.dispatchOnce()).succeeded).toBe(1);
    expect(sender.calls).toHaveLength(3);
    expect(sender.calls[2].to).toBe(sender.calls[1].to);
    expect(sender.calls.filter((r) => r.to === sender.calls[0].to)).toHaveLength(1);
    expect((await notifications(record.id)).map((r) => r.attempts).sort()).toEqual([1, 2]);
  });

  it('persistent failure reaches the unchanged retry cap without false completion', async () => {
    const { record } = await event();
    await admin.query('UPDATE outbox_event SET max_attempts = 3 WHERE id = $1', [record.id]);
    const sender = new ScriptedSender(async () => {
      throw new Error('NTF055_TRANSIENT');
    });
    const dispatch = dispatcher(sender);
    for (let n = 0; n < 3; n++) {
      await retryDue(record.id);
      const result = await dispatch.dispatchOnce();
      expect(n < 2 ? result.retried : result.failed).toBe(1);
    }
    const row = (await admin.query('SELECT * FROM outbox_event WHERE id = $1', [record.id]))
      .rows[0];
    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.processed_at).toBeNull();
    expect(await notifications(record.id)).toMatchObject([{ status: 'failed', attempts: 3 }]);
    expect(sender.calls).toHaveLength(3);
    expect((await dispatch.dispatchOnce()).fetched).toBe(0);
  });

  it('rechecks current recipients and preserves a failure after deactivation', async () => {
    const { record } = await event();
    await failFirst(record);
    await admin.query(
      "UPDATE app_user SET status = 'deactivated', deactivated_at = now() WHERE id = $1",
      [fixture.actors.requester.userId],
    );
    try {
      const sender = new ScriptedSender();
      expect(await deliver(record, sender)).toEqual({ sent: 0, skipped: 0 });
      expect(sender.calls).toHaveLength(0);
      expect(await notifications(record.id)).toMatchObject([{ status: 'failed', attempts: 1 }]);
    } finally {
      await admin.query(
        "UPDATE app_user SET status = 'active', deactivated_at = NULL WHERE id = $1",
        [fixture.actors.requester.userId],
      );
    }
  });

  it('FORCE RLS prevents another organization from reading or retrying the row', async () => {
    const { record } = await event();
    await failFirst(record);
    const sender = new ScriptedSender();
    expect(await deliver(record, sender, fixture.controlOrganizationId)).toEqual({
      sent: 0,
      skipped: 0,
    });
    expect(
      await inOrg(
        fixture.controlOrganizationId,
        async (client) =>
          (
            await client.query('SELECT id FROM notification WHERE outbox_event_id = $1', [
              record.id,
            ])
          ).rows,
      ),
    ).toEqual([]);
    expect(sender.calls).toHaveLength(0);
  });

  it('internal notes produce no notification even with retryable records', async () => {
    const { record } = await event();
    const sender = new ScriptedSender();
    expect(
      await deliver(
        {
          ...record,
          eventType: 'ticket.comment.added',
          payload: { ...record.payload, visibility: 'internal' },
        },
        sender,
      ),
    ).toEqual({ sent: 0, skipped: 1 });
    expect(await notifications(record.id)).toEqual([]);
    expect(sender.calls).toEqual([]);
  });

  it('same recipient retry is serialized and the waiter observes committed success', async () => {
    const { record } = await event();
    await failFirst(record);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sender = new ScriptedSender(async () => {
      entered();
      await gate;
    });
    const first = deliver(record, sender);
    let second: ReturnType<typeof deliver> | undefined;
    try {
      await reached;
      second = deliver(record, sender);
      let locked = false;
      for (let n = 0; n < 20; n++) {
        locked =
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND usename = 'solvi_app' AND wait_event_type = 'Lock' AND query ILIKE '%notification%'",
            )
          ).rowCount !== 0;
        if (locked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(locked).toBe(true);
    } finally {
      release();
      const results = await Promise.all([first, second]);
      expect(results).toEqual([
        { sent: 1, skipped: 0 },
        { sent: 0, skipped: 1 },
      ]);
    }
    expect(sender.calls).toHaveLength(1);
    expect(await notifications(record.id)).toMatchObject([{ status: 'sent', attempts: 2 }]);
  });

  it.each(['notification.sent', 'notification.failed'])(
    'audit rejection rolls back notification state: %s',
    async (eventType) => {
      const { record } = await event();
      await admin.query(
        `CREATE FUNCTION wp055_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = '${eventType}' THEN RAISE EXCEPTION 'NTF055_AUDIT_REJECTED'; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        'CREATE TRIGGER wp055_reject_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION wp055_reject_audit()',
      );
      const sender = new ScriptedSender(async () => {
        if (eventType.endsWith('failed')) throw new Error('NTF055_TRANSIENT');
      });
      try {
        await expect(deliver(record, sender)).rejects.toThrow('NTF055_AUDIT_REJECTED');
        expect(await notifications(record.id)).toEqual([]);
      } finally {
        await admin.query('DROP TRIGGER wp055_reject_audit ON audit_event');
        await admin.query('DROP FUNCTION wp055_reject_audit()');
      }
    },
  );

  it('role-expiry notifications recover through the same ID and recipient boundary', async () => {
    const { record } = await event();
    const roleRecord = {
      ...record,
      eventType: 'role.binding.expiring',
      payload: { userId: fixture.actors.requester.userId, validUntil: '2027-01-01T00:00:00Z' },
    };
    await failFirst(roleRecord);
    const first = await notifications(record.id);
    const sender = new ScriptedSender();
    await deliver(roleRecord, sender);
    const recovered = await notifications(record.id);
    expect(recovered.find((r) => r.id === first[0].id)).toMatchObject({
      status: 'sent',
      attempts: 2,
      failed_at: null,
    });
    expect(recovered.every((r) => r.organization_id === fixture.organizationId)).toBe(true);
    expect(sender.calls.every((r) => r.linkPath === '/ops/users')).toBe(true);
  });

  it('audit records match actual attempts and contain no recipient, subject, or body', async () => {
    const { record } = await event();
    await failFirst(record);
    const sender = new ScriptedSender();
    await deliver(record, sender);
    const row = (await notifications(record.id))[0];
    const audits = (
      await admin.query(
        'SELECT event_type, after_state FROM audit_event WHERE target_id = $1 ORDER BY occurred_at, event_type',
        [row.id],
      )
    ).rows;
    expect(audits.map((r) => r.event_type)).toEqual(['notification.failed', 'notification.sent']);
    const text = JSON.stringify(audits);
    expect(text).not.toContain(fixture.actors.requester.email);
    expect(text).not.toContain(sender.calls[0].subject);
    expect(text).not.toContain('NTF055_PRIVATE_BODY');
    expect(Object.keys(sender.calls[0]).sort()).toEqual(['linkPath', 'subject', 'to']);
  });
});
