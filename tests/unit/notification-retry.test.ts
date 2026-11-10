import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { AuditWriteError } from '../../services/api/src/common/audit/audit.js';
import {
  NotificationService,
  type NotificationSender,
} from '../../services/api/src/modules/notification/notification.service.js';
import type { OutboxRecordLike } from '../../services/api/src/modules/notification/types.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const EVENT = '00000000-0000-4000-8000-000000000003';
const TICKET = '00000000-0000-4000-8000-000000000004';
const REQUESTER = '00000000-0000-4000-8000-000000000005';
const ASSIGNEE = '00000000-0000-4000-8000-000000000006';
const NOTICE = '00000000-0000-4000-8000-000000000007';
const STAMP = '2026-10-07T00:00:00.000Z';

interface RecipientRow {
  user_id: string;
  email: string | null;
  organization_id: string;
  active: boolean;
  currentRole: boolean;
  administrator?: boolean;
}

interface NotificationRow {
  id: string;
  organization_id: string;
  outbox_event_id: string;
  channel: string;
  recipient_user_id: string;
  recipient_address: string;
  subject: string;
  link_path: string;
  status: string;
  attempts: number;
  sent_at: string | null;
  failed_at: string | null;
  last_error: string | null;
}

interface QueryCall {
  sql: string;
  values: unknown[];
}

interface AuditRow {
  eventType: string;
  organizationId: unknown;
  targetId: unknown;
  subjectUserId: unknown;
  afterState: unknown;
}

function recipient(userId = REQUESTER): RecipientRow {
  return {
    user_id: userId,
    email: userId === REQUESTER ? 'requester@example.invalid' : 'operator@example.invalid',
    organization_id: ORG,
    active: true,
    currentRole: true,
  };
}

function existing(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTICE,
    organization_id: ORG,
    outbox_event_id: EVENT,
    channel: 'email',
    recipient_user_id: REQUESTER,
    recipient_address: 'requester@example.invalid',
    subject: '[TKT-TEST] 受け付けました',
    link_path: `/tickets/${TICKET}`,
    status: 'failed',
    attempts: 1,
    sent_at: null,
    failed_at: STAMP,
    last_error: 'temporary sender failure',
    ...overrides,
  };
}

function event(overrides: Partial<OutboxRecordLike> = {}): OutboxRecordLike {
  return {
    id: EVENT,
    organizationId: ORG,
    eventType: 'ticket.created',
    payload: {
      ticketId: TICKET,
      ticketNumber: 'TKT-TEST',
      body: 'SYNTHETIC-BODY-MUST-NOT-BE-SENT',
      commentBody: 'SYNTHETIC-COMMENT-MUST-NOT-BE-SENT',
    },
    ...overrides,
  };
}

/**
 * A small SQL boundary fixture, not a PostgreSQL simulator. It retains rows between
 * public service calls and observes the actual SQL and audit writer. Transaction
 * rollback, real constraints, RLS and concurrent lock behavior require the separate
 * WP055 isolated database gate; a unit success does not claim any of those gates.
 */
class MemoryClient {
  recipients = [recipient()];
  notices: NotificationRow[] = [];
  calls: QueryCall[] = [];
  audits: AuditRow[] = [];
  auditAttempts: string[] = [];
  failAudit = new Set<string>();
  failSentUpdate = false;

  query = vi.fn(async (rawSql: string, values: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql, values });
    if (sql.startsWith('SELECT CASE WHEN EXISTS') && sql.includes('notification_preference')) {
      // WP057: this legacy retry fixture has no saved preference (default ON).
      return { rows: [{ enabled: true }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT DISTINCT u.id AS user_id')) {
      const ticketQuery = sql.includes('FROM ticket t');
      const organizationId = values[ticketQuery ? 1 : 0];
      const subjectUserId = ticketQuery ? undefined : values[1];
      const rows = this.recipients.filter(
        (r) =>
          r.organization_id === organizationId &&
          r.active &&
          r.currentRole &&
          (ticketQuery || r.user_id === subjectUserId || r.administrator),
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO notification')) {
      const [id, organizationId, eventId, channel, userId, address, subject, linkPath] =
        values as string[];
      if (
        this.notices.some((r) => r.outbox_event_id === eventId && r.recipient_address === address)
      ) {
        return { rows: [], rowCount: 0 };
      }
      const row = existing({
        id,
        organization_id: organizationId,
        outbox_event_id: eventId,
        channel,
        recipient_user_id: userId,
        recipient_address: address,
        subject,
        link_path: linkPath,
        status: 'pending',
        attempts: 0,
        failed_at: null,
        last_error: null,
      });
      this.notices.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/\bFROM notification\b/.test(sql)) {
      const rows = this.notices.filter((row) => {
        for (const field of [
          'organization_id',
          'outbox_event_id',
          'recipient_address',
          'recipient_user_id',
          'channel',
        ] as const) {
          const match = sql.match(new RegExp(`\\b${field}\\s*=\\s*\\$(\\d+)`));
          if (match && row[field] !== values[Number(match[1]) - 1]) return false;
        }
        return true;
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE notification')) {
      const row = this.notices.find((r) => r.id === values[0]);
      if (!row) throw new Error('fixture notification missing');
      if (sql.includes("status = 'sent'")) {
        if (this.failSentUpdate) throw new Error('synthetic database update failure');
        row.status = 'sent';
        row.sent_at = STAMP;
        if (/failed_at\s*=\s*NULL/i.test(sql)) row.failed_at = null;
        if (/last_error\s*=\s*NULL/i.test(sql)) row.last_error = null;
      } else if (sql.includes("status = 'failed'")) {
        row.status = 'failed';
        row.failed_at = STAMP;
        row.last_error = String(values[1]);
      } else {
        throw new Error('unexpected notification update in fixture');
      }
      row.attempts += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO audit_event')) {
      const eventType = String(values[1]);
      this.auditAttempts.push(eventType);
      if (this.failAudit.has(eventType)) throw new Error('synthetic audit unavailable');
      this.audits.push({
        eventType,
        organizationId: values[2],
        subjectUserId: values[6],
        targetId: values[8],
        afterState: values[12],
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query in notification unit fixture: ${sql}`);
  });

  asPgClient(): pg.PoolClient {
    return this as unknown as pg.PoolClient;
  }
}

function service(
  client: MemoryClient,
  send = vi.fn<NotificationSender['send']>().mockResolvedValue(undefined),
) {
  const sender: NotificationSender = { channel: 'email', send };
  return {
    service: new NotificationService(client.asPgClient(), new Map([['email', sender]])),
    send,
  };
}

function assertBoundPredicate(call: QueryCall, field: string, value: unknown) {
  const match = call.sql.match(new RegExp(`\\b${field}\\s*=\\s*\\$(\\d+)`));
  expect(match, `bound predicate for ${field}`).not.toBeNull();
  expect(call.values[Number(match![1]) - 1]).toBe(value);
}

describe('notification retry through the public service (WP055)', () => {
  it('reuses the failed notification ID, increments attempts and clears failure state', async () => {
    const client = new MemoryClient();
    const send = vi
      .fn<NotificationSender['send']>()
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('temporary sender failure'));
    const { service: subject } = service(client, send);

    await expect(subject.deliverForEvent(event())).rejects.toThrow('temporary sender failure');
    const failed = { ...client.notices[0]! };
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, failed_at: STAMP });
    expect(failed.last_error).toBe('temporary sender failure');

    await expect(subject.deliverForEvent(event())).resolves.toEqual({ sent: 1, skipped: 0 });
    expect(client.notices).toHaveLength(1);
    expect(client.notices[0]).toMatchObject({
      id: failed.id,
      status: 'sent',
      attempts: 2,
      sent_at: STAMP,
      failed_at: null,
      last_error: null,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(client.audits.map((a) => [a.eventType, a.targetId])).toEqual([
      ['notification.failed', failed.id],
      ['notification.sent', failed.id],
    ]);
  });

  it('skips an already sent notification without increasing attempts or adding audit', async () => {
    const client = new MemoryClient();
    client.notices = [
      existing({ status: 'sent', sent_at: STAMP, failed_at: null, last_error: null }),
    ];
    const { service: subject, send } = service(client);
    await expect(subject.deliverForEvent(event())).resolves.toEqual({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(client.notices[0]!.attempts).toBe(1);
    expect(client.audits).toHaveLength(0);
  });

  it('recovers an existing pending notification without allocating a second row', async () => {
    const client = new MemoryClient();
    client.notices = [
      existing({ status: 'pending', attempts: 0, failed_at: null, last_error: null }),
    ];
    const { service: subject, send } = service(client);
    await expect(subject.deliverForEvent(event())).resolves.toEqual({ sent: 1, skipped: 0 });
    expect(client.notices).toHaveLength(1);
    expect(client.notices[0]).toMatchObject({ id: NOTICE, status: 'sent', attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries only the failed recipient after a partially successful attempt', async () => {
    const client = new MemoryClient();
    client.recipients.push(recipient(ASSIGNEE));
    const send = vi
      .fn<NotificationSender['send']>()
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('temporary sender failure'));
    const { service: subject } = service(client, send);
    await expect(subject.deliverForEvent(event())).rejects.toThrow('temporary sender failure');
    const firstId = client.notices[0]!.id;
    const failedId = client.notices[1]!.id;
    await expect(subject.deliverForEvent(event())).resolves.toEqual({ sent: 1, skipped: 1 });
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      {
        to: 'requester@example.invalid',
        subject: '[TKT-TEST] 受け付けました',
        linkPath: `/tickets/${TICKET}`,
      },
      {
        to: 'operator@example.invalid',
        subject: '[TKT-TEST] 受け付けました',
        linkPath: `/tickets/${TICKET}`,
      },
      {
        to: 'operator@example.invalid',
        subject: '[TKT-TEST] 受け付けました',
        linkPath: `/tickets/${TICKET}`,
      },
    ]);
    expect(client.notices).toHaveLength(2);
    expect(client.notices[0]).toMatchObject({ id: firstId, status: 'sent', attempts: 1 });
    expect(client.notices[1]).toMatchObject({ id: failedId, status: 'sent', attempts: 2 });
  });

  it('preserves repeated failure attempts and one failure audit per sender attempt', async () => {
    const client = new MemoryClient();
    const error = new Error('temporary sender failure');
    const send = vi.fn<NotificationSender['send']>().mockRejectedValue(error);
    const { service: subject } = service(client, send);
    await expect(subject.deliverForEvent(event())).rejects.toBe(error);
    const id = client.notices[0]!.id;
    await expect(subject.deliverForEvent(event())).rejects.toBe(error);
    expect(client.notices[0]).toMatchObject({ id, status: 'failed', attempts: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(client.audits.map((a) => [a.eventType, a.targetId])).toEqual([
      ['notification.failed', id],
      ['notification.failed', id],
    ]);
  });

  it('locks and scopes the conflict lookup to the same organization, event and address', async () => {
    const client = new MemoryClient();
    client.notices = [existing()];
    const { service: subject } = service(client);
    await subject.deliverForEvent(event());
    const lookup = client.calls.find((call) =>
      call.sql.startsWith('SELECT id, organization_id, outbox_event_id, recipient_address'),
    );
    expect(lookup).toBeDefined();
    expect(lookup!.sql).toMatch(/\bFOR UPDATE\b/i);
    assertBoundPredicate(lookup!, 'organization_id', ORG);
    assertBoundPredicate(lookup!, 'outbox_event_id', EVENT);
    assertBoundPredicate(lookup!, 'recipient_address', 'requester@example.invalid');
    const insert = client.calls.find((call) => call.sql.startsWith('INSERT INTO notification'))!;
    expect(insert.sql).toMatch(
      /ON CONFLICT \(outbox_event_id, recipient_address\) WHERE outbox_event_id IS NOT NULL DO NOTHING/i,
    );
  });

  it.each([
    ['another organization', { organization_id: OTHER_ORG }],
    ['another recipient user', { recipient_user_id: ASSIGNEE }],
    ['another channel', { channel: 'webhook' }],
    ['an unknown delivery state', { status: 'unknown' }],
  ] as const)('fails closed for a conflicting row with %s', async (_label, overrides) => {
    const client = new MemoryClient();
    client.notices = [existing(overrides)];
    const original = { ...client.notices[0]! };
    const { service: subject, send } = service(client);
    await expect(subject.deliverForEvent(event())).rejects.toBeInstanceOf(Error);
    expect(send).not.toHaveBeenCalled();
    expect(client.notices[0]).toEqual(original);
    expect(client.audits).toHaveLength(0);
  });

  it.each([
    ['inactive', { active: false }],
    ['no longer holding a current organization role', { currentRole: false }],
    ['without an email', { email: null }],
    ['another organization', { organization_id: OTHER_ORG }],
  ] as const)('does not retry when the current recipient is %s', async (_label, overrides) => {
    const client = new MemoryClient();
    client.notices = [existing()];
    client.recipients = [{ ...recipient(), ...overrides }];
    const { service: subject, send } = service(client);
    await expect(subject.deliverForEvent(event())).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(client.notices[0]!.attempts).toBe(1);
    const lookup = client.calls[0]!;
    expect(lookup.sql).toContain("u.status = 'active'");
    expect(lookup.sql).toContain('rb.valid_from <= now()');
    expect(lookup.sql).toContain('rb.valid_until > now()');
    assertBoundPredicate(lookup, 't.organization_id', ORG);
    assertBoundPredicate(lookup, 'rb.organization_id', ORG);
  });

  it('never delivers an internal note, including a matching failed notification', async () => {
    const client = new MemoryClient();
    client.notices = [existing()];
    const { service: subject, send } = service(client);
    await expect(
      subject.deliverForEvent(
        event({
          eventType: 'ticket.comment.added',
          payload: { ...event().payload, visibility: 'internal' },
        }),
      ),
    ).resolves.toEqual({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(0);
  });

  it('excludes the event actor and sends only the subject and authenticated link', async () => {
    const client = new MemoryClient();
    client.recipients.push(recipient(ASSIGNEE));
    const { service: subject, send } = service(client);
    await expect(
      subject.deliverForEvent(event({ payload: { ...event().payload, actorId: ASSIGNEE } })),
    ).resolves.toEqual({ sent: 1, skipped: 1 });
    expect(send).toHaveBeenCalledWith({
      to: 'requester@example.invalid',
      subject: '[TKT-TEST] 受け付けました',
      linkPath: `/tickets/${TICKET}`,
    });
    expect(JSON.stringify(client.audits)).not.toContain('example.invalid');
    expect(JSON.stringify(client.audits)).not.toContain('TKT-TEST');
    expect(JSON.stringify(send.mock.calls)).not.toContain('SYNTHETIC-BODY');
    expect(JSON.stringify(send.mock.calls)).not.toContain('SYNTHETIC-COMMENT');
    expect(client.audits[0]!.afterState).toEqual({ channel: 'email' });
  });

  it('retries role expiry notifications through the same state-aware path', async () => {
    const client = new MemoryClient();
    client.recipients.push({ ...recipient(ASSIGNEE), administrator: true });
    client.recipients.push({
      ...recipient(ASSIGNEE),
      user_id: NOTICE,
      organization_id: OTHER_ORG,
      administrator: true,
    });
    const send = vi
      .fn<NotificationSender['send']>()
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('temporary sender failure'));
    const { service: subject } = service(client, send);
    const notice = event({
      eventType: 'role.binding.expiring',
      payload: {
        userId: REQUESTER,
        validUntil: '2030-01-01T00:00:00Z',
        roleName: 'MUST-NOT-BE-SENT',
      },
    });
    await expect(subject.deliverForEvent(notice)).rejects.toThrow('temporary sender failure');
    const id = client.notices[0]!.id;
    await expect(subject.deliverForEvent(notice)).resolves.toEqual({ sent: 2, skipped: 0 });
    await expect(subject.deliverForEvent(notice)).resolves.toEqual({ sent: 0, skipped: 2 });
    expect(client.notices).toHaveLength(2);
    expect(client.notices[0]).toMatchObject({
      id,
      status: 'sent',
      attempts: 2,
      failed_at: null,
      last_error: null,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(send.mock.calls)).not.toContain('MUST-NOT-BE-SENT');
    for (const [params] of send.mock.calls)
      expect(params).toMatchObject({ linkPath: '/ops/users' });
  });

  it('propagates success audit failure without recording a sender failure or another attempt', async () => {
    const client = new MemoryClient();
    client.failAudit.add('notification.sent');
    const { service: subject, send } = service(client);
    await expect(subject.deliverForEvent(event())).rejects.toBeInstanceOf(AuditWriteError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.auditAttempts).toEqual(['notification.sent']);
    expect(client.calls.filter((call) => call.sql.startsWith('UPDATE notification'))).toHaveLength(
      1,
    );
    expect(client.notices[0]!.attempts).toBe(1);
  });

  it('propagates failure audit errors to the transaction caller', async () => {
    const client = new MemoryClient();
    client.failAudit.add('notification.failed');
    const send = vi
      .fn<NotificationSender['send']>()
      .mockRejectedValue(new Error('temporary sender failure'));
    const { service: subject } = service(client, send);
    await expect(subject.deliverForEvent(event())).rejects.toBeInstanceOf(AuditWriteError);
    expect(client.auditAttempts).toEqual(['notification.failed']);
    expect(client.audits).toHaveLength(0);
    expect(client.notices[0]!.attempts).toBe(1);
  });

  it('does not recast a post-send database error as a failed sender attempt', async () => {
    const client = new MemoryClient();
    client.failSentUpdate = true;
    const { service: subject, send } = service(client);
    await expect(subject.deliverForEvent(event())).rejects.toThrow(
      'synthetic database update failure',
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(client.auditAttempts).toHaveLength(0);
    expect(client.calls.filter((call) => call.sql.startsWith('UPDATE notification'))).toHaveLength(
      1,
    );
    expect(client.notices[0]!.attempts).toBe(0);
  });
});
