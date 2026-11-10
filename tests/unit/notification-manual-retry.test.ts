import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import { NotificationRetryService } from '../../services/api/src/modules/notification/notification-retry.service.js';
import {
  NotificationRetryController,
  validateNotificationRetryRequest,
} from '../../services/api/src/modules/notification/notification-retry.routes.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import { buildSubject } from '../../services/api/src/modules/notification/notification.service.js';
import type { OperationSessionValidator } from '../../services/api/src/modules/notification/types.js';

const org = '10000000-0000-4000-8000-000000000001';
const admin = '20000000-0000-4000-8000-000000000001';
const recipient = '20000000-0000-4000-8000-000000000002';
const actor = '20000000-0000-4000-8000-000000000003';
const notificationId = '30000000-0000-4000-8000-000000000001';
const originalId = '40000000-0000-4000-8000-000000000001';
const ticketId = '50000000-0000-4000-8000-000000000001';
const sessionId = '60000000-0000-4000-8000-000000000001';
const ctx: AuthzContext = {
  organizationId: org,
  principal: {
    userId: admin,
    status: 'active',
    bindings: [
      { roleCode: 'org_admin', organizationId: org, validFrom: new Date(0), validUntil: null },
    ],
  },
};
const auth = { authz: ctx, userId: admin, sessionId };
const headers = { 'content-type': 'application/json', 'x-solvi-form-scope': `${org}:${admin}` };
const fixedVersion = 'a'.repeat(43);

/** A SQL-boundary stub, not RLS/transaction proof (the isolated security suite
 * supplies those). It captures the complete mutation set and phases. */
function fixture() {
  const payload: Record<string, unknown> = { ticketId, ticketNumber: 'TKT-0058', actorId: actor };
  const target = {
    id: notificationId,
    organization_id: org,
    outbox_event_id: originalId,
    channel: 'email',
    recipient_user_id: recipient,
    recipient_address: 'synthetic-recipient@example.test',
    subject: buildSubject('ticket.created', 'TKT-0058'),
    link_path: `/tickets/${ticketId}`,
    status: 'failed',
    attempts: 2,
    failure_time: '2026-10-01T00:00:00.123456Z',
    last_error: 'previous-failure',
    original_id: originalId,
    event_type: 'ticket.created',
    payload,
    payload_text: JSON.stringify(payload),
    original_failure_time: '2026-10-01T00:01:00.123456Z',
    original_processed: false,
    original_leased: false,
  };
  const ticket = {
    number: 'TKT-0058',
    requester_id: recipient,
    assignee_id: admin,
    recipient_valid: true,
    actor_exists: true,
    public_comment: true,
    recipient_valid_until: null as Date | null,
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  const audits: unknown[][] = [];
  let request: Record<string, unknown> | null = null;
  let retryId = '';
  let receiptCount = 0;
  let targetExists = true;
  let auditFailure = '';
  let updateFailure = false;
  let onLock: (() => void) | undefined;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT n.id'))
      return { rows: targetExists ? [target] : [], rowCount: targetExists ? 1 : 0 };
    if (sql.startsWith('SELECT r.*'))
      return { rows: request ? [{ ...request }] : [], rowCount: request ? 1 : 0 };
    if (sql.startsWith('SELECT t.number')) return { rows: [ticket], rowCount: 1 };
    if (sql.startsWith('SELECT notification_id'))
      return {
        rows:
          request && params[1] === request.id && params[2] === retryId
            ? [{ notification_id: notificationId }]
            : [],
        rowCount: 1,
      };
    if (sql.includes('FROM notification WHERE') && sql.includes('FOR UPDATE')) {
      onLock?.();
      return { rows: [{ id: notificationId }], rowCount: 1 };
    }
    if (sql.includes('FOR SHARE')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO outbox_event')) {
      retryId = String(params[0]);
      expect(params[2]).toBe('notification.manual_retry.requested');
      expect(params[7]).toBe(1);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO notification_retry_request')) {
      request = {
        id: params[0],
        organization_id: params[1],
        notification_id: params[2],
        original_outbox_id: params[3],
        retry_outbox_id: params[4],
        requested_by: params[5],
        session_id: params[6],
        approved_at: params[7],
        expires_at: params[8],
        failure_attempts: params[9],
        failure_time: params[10],
        snapshot_hash: params[11],
        retry_event_type: 'notification.manual_retry.requested',
        retry_payload: { retryRequestId: params[0] },
        retry_max_attempts: 1,
        retry_processed: false,
        retry_failed: false,
        retry_leased: false,
        receipt_id: null,
        outcome: null,
        reason: null,
        completed_at: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO notification_retry_receipt')) {
      receiptCount++;
      Object.assign(request!, {
        receipt_id: params[0],
        outcome: params[3],
        reason: params[4],
        completed_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE notification SET')) {
      if (updateFailure) throw new Error('synthetic database failure');
      target.status = String(params[2]);
      target.attempts++;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_event')) {
      if (params[1] === auditFailure) throw new Error('synthetic audit failure');
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (
      sql.includes('pg_advisory_xact_lock') ||
      /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql)
    )
      return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL in bounded unit stub');
  });
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient;
  const operationSessions = {
    validate: vi.fn<OperationSessionValidator['validate']>().mockResolvedValue({ valid: true }),
  };
  const sender = new RecordingEmailSender();
  const service = new NotificationRetryService(client, { operationSessions, sender });
  async function reserve() {
    const before = await service.get(ctx, notificationId);
    expect(before.eligible).toBe(true);
    const result = await service.request(ctx, {
      notificationId,
      sessionId,
      version: before.version!,
    });
    expect(result.state).toBe('queued');
    return {
      id: retryId,
      organizationId: org,
      eventType: 'notification.manual_retry.requested',
      payload: { retryRequestId: String(request!.id) },
    };
  }
  return {
    client,
    query,
    target,
    ticket,
    calls,
    audits,
    operationSessions,
    sender,
    service,
    reserve,
    get request() {
      return request!;
    },
    get receiptCount() {
      return receiptCount;
    },
    failAudit(event: string) {
      auditFailure = event;
    },
    failUpdate() {
      updateFailure = true;
    },
    hideTarget() {
      targetExists = false;
    },
    onLock(fn: () => void) {
      onLock = fn;
    },
    deferReservationUntilLock() {
      const committed = request;
      request = null;
      onLock = () => {
        request = committed;
      };
    },
  };
}

describe('notification manual retry contract (FR-TKT-007, NFR-SEC-001, NFR-SEC-006)', () => {
  it('returns bounded safe confirmation, preserving microsecond failure generation privately', async () => {
    const f = fixture(),
      result = await f.service.get(ctx, notificationId);
    expect(result).toMatchObject({
      eligible: true,
      reason: null,
      state: 'not_requested',
      deliveryMode: 'recording',
    });
    expect(result.version).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result)).not.toContain(f.target.recipient_address);
    f.target.failure_time = '2026-10-01T00:00:00.123457Z';
    expect((await f.service.get(ctx, notificationId)).version).not.toBe(result.version);
  });
  it('binds confirmation to the actor and refuses a stale version without writes', async () => {
    const f = fixture();
    const result = await f.service.get(ctx, notificationId);
    const other = { ...ctx, principal: { ...ctx.principal, userId: actor } };
    expect((await f.service.get(other, notificationId)).version).not.toBe(result.version);
    f.target.attempts++;
    await expect(
      f.service.request(ctx, { notificationId, sessionId, version: result.version! }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });
  it.each(['agent', 'requester', 'platform_admin'] as const)(
    'denies %s and global org_admin',
    async (roleCode) => {
      const f = fixture();
      const principal = {
        ...ctx.principal,
        bindings: [{ ...ctx.principal.bindings[0]!, roleCode }],
      };
      await expect(f.service.get({ ...ctx, principal }, notificationId)).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        f.service.get(
          {
            ...ctx,
            principal: {
              ...ctx.principal,
              bindings: [{ ...ctx.principal.bindings[0]!, organizationId: null }],
            },
          },
          notificationId,
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.calls).toHaveLength(0);
    },
  );
  it('hides a missing or foreign target', async () => {
    const f = fixture();
    f.hideTarget();
    await expect(f.service.get(ctx, notificationId)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.get(ctx, 'not-uuid')).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    ['channel', 'webhook', 'unsupported'],
    ['status', 'sent', 'not_failed'],
    ['status', 'pending', 'not_failed'],
    ['original_id', null, 'outbox_unavailable'],
    ['original_processed', true, 'outbox_not_stopped'],
    ['original_leased', true, 'outbox_not_stopped'],
    ['original_failure_time', null, 'outbox_not_stopped'],
    ['event_type', 'role.binding.expiring', 'unsupported'],
    ['event_type', 'unknown', 'unsupported'],
    ['recipient_user_id', actor, 'recipient_ineligible'],
    ['attempts', 32767, 'not_failed'],
    ['subject', 'changed', 'target_changed'],
    ['link_path', '/changed', 'target_changed'],
  ])('rejects changed %s (%s)', async (key, value, reason) => {
    const f = fixture();
    Object.assign(f.target, { [String(key)]: value });
    expect(await f.service.get(ctx, notificationId)).toMatchObject({
      eligible: false,
      version: null,
      reason,
    });
  });
  it.each(['recipient_valid', 'actor_exists', 'public_comment'] as const)(
    'validates current %s',
    async (key) => {
      const f = fixture();
      f.target.event_type = 'ticket.comment.added';
      f.target.subject = buildSubject('ticket.comment.added', 'TKT-0058');
      f.target.payload.visibility = 'public';
      f.ticket[key] = false;
      expect((await f.service.get(ctx, notificationId)).eligible).toBe(false);
    },
  );
  it('rejects internal and malformed original payloads; permits actorless automatic transition only', async () => {
    const f = fixture();
    f.target.event_type = 'ticket.comment.added';
    f.target.payload.visibility = 'internal';
    expect((await f.service.get(ctx, notificationId)).reason).toBe('event_invalid');
    delete f.target.payload.visibility;
    delete f.target.payload.actorId;
    f.target.event_type = 'ticket.created';
    expect((await f.service.get(ctx, notificationId)).reason).toBe('event_invalid');
    f.target.event_type = 'ticket.transitioned';
    f.target.subject = buildSubject(f.target.event_type, 'TKT-0058');
    expect((await f.service.get(ctx, notificationId)).eligible).toBe(true);
  });
  it('reserves one fixed Outbox without sending or changing business history/preferences', async () => {
    const f = fixture();
    await f.reserve();
    expect(f.sender.sent).toHaveLength(0);
    expect(
      f.calls
        .filter((c) => /^(INSERT|UPDATE|DELETE)/.test(c.sql.trim()))
        .map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(' ')),
    ).toEqual([
      'INSERT INTO outbox_event',
      'INSERT INTO notification_retry_request',
      'INSERT INTO audit_event',
    ]);
    expect(
      (f.request.expires_at as Date).getTime() - (f.request.approved_at as Date).getTime(),
    ).toBe(15 * 60_000);
    expect(f.audits[0]![1]).toBe('notification.retry.requested');
    expect(f.audits[0]![20]).toBeNull();
    expect(f.audits[0]![12]).toMatchObject({
      retryRequestId: f.request.id,
      deliveryMode: 'recording',
    });
  });
  it('returns the existing reservation before stale-version/new eligibility after expiry or completion', async () => {
    const f = fixture();
    await f.reserve();
    const before = f.calls.length;
    f.request.expires_at = new Date(0);
    f.target.status = 'sent';
    const replay = await f.service.request(ctx, {
      notificationId,
      sessionId,
      version: fixedVersion,
    });
    expect(replay.state).toBe('expired');
    expect(f.calls.slice(before).some((c) => /INSERT|UPDATE|FOR UPDATE/.test(c.sql))).toBe(false);
  });
  it('rechecks the request after the notification lock (a concurrent reservation wins)', async () => {
    const f = fixture();
    await f.reserve();
    f.deferReservationUntilLock();
    const before = f.calls.length;
    const result = await f.service.request(ctx, {
      notificationId,
      sessionId,
      version: fixedVersion,
    });
    expect(result.state).toBe('queued');
    expect(f.calls.slice(before).some((c) => c.sql.includes('FOR UPDATE'))).toBe(true);
    expect(f.calls.slice(before).some((c) => c.sql.includes('INSERT'))).toBe(false);
    expect(f.audits).toHaveLength(1);
  });
  it('rejects loss of session while waiting for the intake row lock', async () => {
    const f = fixture(),
      before = await f.service.get(ctx, notificationId);
    f.onLock(() =>
      f.operationSessions.validate.mockResolvedValue({ valid: false, reason: 'session_invalid' }),
    );
    await expect(
      f.service.request(ctx, { notificationId, sessionId, version: before.version! }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });
  it('records one targeted success, real terminal reference, then suppresses duplicate execution', async () => {
    const f = fixture(),
      record = await f.reserve();
    expect(await f.service.execute(record)).toEqual({ outcome: 'processed' });
    expect(f.target).toMatchObject({ status: 'sent', attempts: 3 });
    expect(f.sender.sent).toHaveLength(1);
    expect(f.receiptCount).toBe(1);
    const terminal = f.audits.find((a) => a[1] === 'notification.retry.completed')!;
    expect(terminal[20]).toBe(f.request.receipt_id);
    expect((await f.service.get(ctx, notificationId)).state).toBe('succeeded');
    await f.service.execute(record);
    expect(f.sender.sent).toHaveLength(1);
    expect(f.receiptCount).toBe(1);
    expect(f.calls.some((c) => /UPDATE outbox_event|INSERT INTO notification\s/.test(c.sql))).toBe(
      false,
    );
  });
  it.each(['expiry', 'session', 'address', 'payload', 'generation', 'sent'] as const)(
    'rechecks %s AFTER the worker row lock',
    async (change) => {
      const f = fixture(),
        record = await f.reserve();
      f.onLock(() => {
        if (change === 'expiry') f.request.expires_at = new Date(0);
        if (change === 'session')
          f.operationSessions.validate.mockResolvedValue({ valid: false, reason: 'role_invalid' });
        if (change === 'address') f.ticket.recipient_valid = false;
        if (change === 'payload') f.target.payload_text = '{"changed":true}';
        if (change === 'generation') f.target.failure_time = '2026-10-01T00:00:00.123457Z';
        if (change === 'sent') f.target.status = 'sent';
      });
      await f.service.execute(record);
      expect(f.sender.sent).toHaveLength(0);
      expect(f.request.outcome).toBe('rejected');
      expect(f.audits.at(-1)?.[1]).toBe('notification.retry.rejected');
    },
  );
  it('rejects a session that expires during eligibility reads before sender', async () => {
    const f = fixture(),
      record = await f.reserve();
    f.operationSessions.validate
      .mockResolvedValueOnce({ valid: true })
      .mockResolvedValue({ valid: false, reason: 'session_invalid' });
    await f.service.execute(record);
    expect(f.sender.sent).toHaveLength(0);
    expect(f.request.reason).toBe('session_invalid');
  });
  it('rejects recipient membership expiry while final authorization awaits, despite row locks', async () => {
    const f = fixture(),
      record = await f.reserve();
    const before = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(before);
      f.ticket.recipient_valid_until = new Date(before + 60_000);
      f.operationSessions.validate
        .mockResolvedValueOnce({ valid: true })
        .mockImplementation(async () => {
          vi.setSystemTime(before + 60_001);
          return { valid: true };
        });
      await f.service.execute(record);
      expect(f.sender.sent).toHaveLength(0);
      expect(f.request.reason).toBe('recipient_ineligible');
    } finally {
      vi.useRealTimers();
    }
  });
  it('commits a known recording-sender failure as a safe terminal result (not automatic retry)', async () => {
    class FailingRecordingSender extends RecordingEmailSender {
      override async send(): Promise<void> {
        throw new Error('PRIVATE_SENDER_ERROR');
      }
    }
    const f = fixture(),
      record = await f.reserve();
    const service = new NotificationRetryService(f.client, {
      operationSessions: f.operationSessions,
      sender: new FailingRecordingSender(),
    });
    await expect(service.execute(record)).resolves.toEqual({ outcome: 'processed' });
    expect(f.request).toMatchObject({ outcome: 'failed', reason: 'sender_failed' });
    expect(f.target.attempts).toBe(3);
    expect(JSON.stringify(f.audits)).not.toContain('PRIVATE_SENDER_ERROR');
  });
  it.each(['notification.sent', 'notification.retry.completed'])(
    'propagates %s audit failures instead of treating them as sender failures',
    async (event) => {
      const f = fixture(),
        record = await f.reserve();
      f.failAudit(event);
      await expect(f.service.execute(record)).rejects.toThrow('監査イベント');
      expect(f.audits.some((a) => a[1] === 'notification.failed')).toBe(false);
      expect(f.sender.sent).toHaveLength(1);
    },
  );
  it('propagates database failure after sender (caller rollback; external effect is not claimed atomic)', async () => {
    const f = fixture(),
      record = await f.reserve();
    f.failUpdate();
    await expect(f.service.execute(record)).rejects.toThrow('synthetic database failure');
    expect(f.receiptCount).toBe(0);
  });
  it('does not swallow failure-audit errors after a known sender failure', async () => {
    class FailingRecordingSender extends RecordingEmailSender {
      override async send(): Promise<void> {
        throw new Error('private sender detail');
      }
    }
    const f = fixture(),
      record = await f.reserve();
    f.failAudit('notification.failed');
    const service = new NotificationRetryService(f.client, {
      operationSessions: f.operationSessions,
      sender: new FailingRecordingSender(),
    });
    await expect(service.execute(record)).rejects.toThrow('監査イベント');
    expect(f.receiptCount).toBe(0);
  });
  it('reports terminal Outbox without receipt as unknown, even after approval expiry', async () => {
    const f = fixture();
    await f.reserve();
    f.request.retry_failed = true;
    f.request.expires_at = new Date(0);
    expect(await f.service.get(ctx, notificationId)).toMatchObject({
      state: 'unknown',
      eligible: false,
      reason: 'result_unknown',
    });
  });
  it.each([
    ['retry_event_type', 'ticket.created'],
    ['retry_max_attempts', 5],
    ['retry_payload', { retryRequestId: originalId }],
    ['retry_payload', { retryRequestId: originalId, extra: true }],
  ])(
    'reports invalid new Outbox %s as unknown without masking a committed receipt',
    async (key, value) => {
      const f = fixture(),
        record = await f.reserve();
      const original = f.request[String(key)];
      f.request[String(key)] = value;
      expect((await f.service.get(ctx, notificationId)).state).toBe('unknown');
      f.request[String(key)] = original;
      await f.service.execute(record);
      f.request[String(key)] = value;
      expect((await f.service.get(ctx, notificationId)).state).toBe('succeeded');
    },
  );
  it('rejects arbitrary sender and malformed/wrong Outbox without delivery', async () => {
    const f = fixture(),
      record = await f.reserve();
    const wrong = new NotificationRetryService(f.client, {
      operationSessions: f.operationSessions,
      sender: { send: vi.fn() } as unknown as RecordingEmailSender,
    });
    await expect(wrong.execute(record)).rejects.toThrow('RECORDING_ONLY');
    await expect(
      f.service.execute({ ...record, payload: { ...record.payload, address: 'private' } }),
    ).rejects.toThrow('RESULT_INVALID');
    await expect(f.service.execute({ ...record, id: originalId })).rejects.toThrow(
      'RESULT_INVALID',
    );
    expect(f.sender.sent).toHaveLength(0);
  });
});

describe('manual retry public route guards and rollback (NFR-SEC-004)', () => {
  it('accepts only version, JSON, matching current form scope, and no Origin', () => {
    expect(validateNotificationRetryRequest(auth, headers, { version: fixedVersion })).toBe(
      fixedVersion,
    );
    for (const body of [
      null,
      {},
      { version: fixedVersion, userId: admin },
      { version: 'x'.repeat(44) },
      { version: 1 },
    ])
      expect(() => validateNotificationRetryRequest(auth, headers, body)).toThrow();
    for (const bad of [
      { ...headers, origin: 'https://example.test' },
      { ...headers, 'content-type': 'text/plain' },
      { ...headers, 'Content-Type': 'application/json' },
      { ...headers, 'x-solvi-form-scope': `${org}:${actor}` },
    ])
      expect(() =>
        validateNotificationRetryRequest(auth, bad, { version: fixedVersion }),
      ).toThrow();
  });
  it('uses a read-only transaction for GET and never exposes private fields', async () => {
    const f = fixture();
    const pool = { connect: vi.fn().mockResolvedValue(f.client) } as unknown as pg.Pool;
    const controller = new NotificationRetryController({
      pool,
      operationSessions: () => f.operationSessions,
    });
    const response = await controller.get(auth, notificationId, new URLSearchParams());
    expect(response.status).toBe(200);
    expect(f.calls[0]?.sql).toBe('BEGIN READ ONLY');
    expect(f.calls.at(-1)?.sql).toBe('COMMIT');
    expect(Object.keys(response.body).sort()).toEqual(
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
  });
  it('rejects query/body identity injection before opening a DB connection', async () => {
    const connect = vi.fn();
    const controller = new NotificationRetryController({ pool: { connect } as unknown as pg.Pool });
    await expect(
      controller.get(auth, notificationId, new URLSearchParams('actor=x&actor=y')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.request(
        auth,
        notificationId,
        headers,
        { version: fixedVersion, sessionId },
        new URLSearchParams(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(connect).not.toHaveBeenCalled();
  });
  it('rolls back request/audit failures and releases the client; no commit', async () => {
    const f = fixture(),
      confirmation = await f.service.get(ctx, notificationId);
    f.failAudit('notification.retry.requested');
    const controller = new NotificationRetryController({
      pool: { connect: vi.fn().mockResolvedValue(f.client) } as unknown as pg.Pool,
      operationSessions: () => f.operationSessions,
    });
    await expect(
      controller.request(
        auth,
        notificationId,
        headers,
        { version: confirmation.version },
        new URLSearchParams(),
      ),
    ).rejects.toThrow('監査イベント');
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.some((c) => c.sql === 'COMMIT')).toBe(false);
    expect(f.client.release).toHaveBeenCalledWith(false);
    expect(f.sender.sent).toHaveLength(0);
  });
});
