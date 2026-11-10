import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { getContext, Problems } from '@solvi/shared';
import type { AuthzContext } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { enqueueOutboxEvent } from '../../common/outbox/outbox.js';
import { requireNotificationListAccess } from './notification-list.service.js';
import { buildLinkPath, buildSubject } from './notification.service.js';
import { RecordingEmailSender } from './senders.js';
import {
  NOTIFICATION_RETRY_REASONS,
  type NotificationRetryReason,
  type NotificationRetryStatus,
  type OperationSessionValidator,
  type OutboxRecordLike,
} from './types.js';
export type { NotificationRetryStatus, OperationSessionValidator } from './types.js';

const uuid = z.string().uuid();
const events = new Set([
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.reassessed',
]);
export const NOTIFICATION_RETRY_VERSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Target {
  id: string;
  organization_id: string;
  outbox_event_id: string | null;
  channel: string;
  recipient_user_id: string | null;
  recipient_address: string;
  subject: string;
  link_path: string;
  status: string;
  attempts: number;
  failure_time: string | null;
  last_error: string | null;
  original_id: string | null;
  event_type: string | null;
  payload: unknown;
  payload_text: string | null;
  original_failure_time: string | null;
  original_processed: boolean;
  original_leased: boolean;
}
interface Eligible {
  reason: null;
  snapshot: string;
  target: Target;
  subject: string;
  linkPath: string;
  recipientValidUntil: Date | null;
}
type Eligibility = Eligible | { reason: NotificationRetryReason };
interface Reservation {
  id: string;
  organization_id: string;
  notification_id: string;
  original_outbox_id: string;
  retry_outbox_id: string;
  requested_by: string;
  session_id: string;
  approved_at: Date;
  expires_at: Date;
  failure_attempts: number;
  failure_time: string;
  snapshot_hash: string;
  retry_event_type: string | null;
  retry_payload: unknown;
  retry_max_attempts: number | null;
  retry_processed: boolean;
  retry_failed: boolean;
  retry_leased: boolean;
  receipt_id: string | null;
  outcome: 'succeeded' | 'failed' | 'rejected' | 'unknown' | null;
  reason: NotificationRetryReason | null;
  completed_at: Date | null;
}

function fixedFailure(): never {
  throw new Error('NOTIFICATION_RETRY_RESULT_INVALID');
}
function validId(id: string): void {
  if (!uuid.safeParse(id).success) throw Problems.notFound('通知');
}
function date(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fixedFailure();
  return value.toISOString();
}
function hash(values: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
function version(ctx: AuthzContext, target: Eligible): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        ctx.organizationId,
        ctx.principal.userId,
        target.target.id,
        target.snapshot,
      ]),
    )
    .digest('base64url');
}
function blank(): NotificationRetryStatus {
  return {
    eligible: false,
    reason: null,
    version: null,
    state: 'not_requested',
    requestedAt: null,
    expiresAt: null,
    completedAt: null,
    deliveryMode: 'recording',
  };
}
function payloadObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function validRetryEvent(request: Reservation): boolean {
  const payload = payloadObject(request.retry_payload);
  return (
    request.retry_event_type === 'notification.manual_retry.requested' &&
    request.retry_max_attempts === 1 &&
    payload !== null &&
    Object.keys(payload).length === 1 &&
    payload.retryRequestId === request.id
  );
}

/** All methods require the caller's organization transaction. This service never
 * starts/commits a transaction, sends during intake, or resets the original event.
 * SQL for notification delivery follows the existing notification read model.
 */
export class NotificationRetryService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly deps: {
      operationSessions: OperationSessionValidator;
      sender?: RecordingEmailSender;
    },
  ) {}

  private async target(
    organizationId: string,
    notificationId: string,
    lock = false,
  ): Promise<Target> {
    if (lock) {
      // The notification row is already locked by intake/worker. Keep the
      // original event stable too, without updating its state or lease.
      await this.client.query(
        `SELECT o.id FROM outbox_event o JOIN notification n
          ON n.outbox_event_id=o.id AND n.organization_id=o.organization_id
         WHERE n.organization_id=$1::uuid AND n.id=$2::uuid FOR SHARE OF o`,
        [organizationId, notificationId],
      );
    }
    const { rows } = await this.client.query<Target>(
      `SELECT n.id,n.organization_id,n.outbox_event_id,n.channel,n.recipient_user_id,
        n.recipient_address,n.subject,n.link_path,n.status,n.attempts,
        ${iso('n.failed_at')} AS failure_time,n.last_error,
        o.id AS original_id,o.event_type,o.payload,o.payload::text AS payload_text,
        ${iso('o.failed_at')} AS original_failure_time,
        (o.processed_at IS NOT NULL) AS original_processed,
        COALESCE(o.locked_until > clock_timestamp(),false) AS original_leased
       FROM notification n LEFT JOIN outbox_event o
         ON o.id=n.outbox_event_id AND o.organization_id=n.organization_id
         AND o.organization_id=$1::uuid
       WHERE n.organization_id=$1::uuid AND n.id=$2::uuid`,
      [organizationId, notificationId],
    );
    if (rows.length !== 1 || !rows[0]) throw Problems.notFound('通知');
    return rows[0];
  }

  private async reservation(
    organizationId: string,
    notificationId: string,
  ): Promise<Reservation | null> {
    const { rows } = await this.client.query<Reservation>(
      `SELECT r.*,${iso('r.failure_failed_at')} AS failure_time,
        o.event_type AS retry_event_type,o.payload AS retry_payload,o.max_attempts AS retry_max_attempts,
        (o.processed_at IS NOT NULL) AS retry_processed,(o.failed_at IS NOT NULL) AS retry_failed,
        COALESCE(o.locked_until > clock_timestamp(),false) AS retry_leased,
        p.id AS receipt_id,p.outcome,p.reason,p.completed_at
       FROM notification_retry_request r
       LEFT JOIN outbox_event o ON o.id=r.retry_outbox_id AND o.organization_id=r.organization_id
       LEFT JOIN notification_retry_receipt p ON p.request_id=r.id AND p.organization_id=r.organization_id
       WHERE r.organization_id=$1::uuid AND r.notification_id=$2::uuid`,
      [organizationId, notificationId],
    );
    if (rows.length > 1) fixedFailure();
    return rows[0] ?? null;
  }

  private result(request: Reservation): NotificationRetryStatus {
    const body = blank();
    body.requestedAt = date(request.approved_at);
    body.expiresAt = date(request.expires_at);
    if (request.receipt_id) {
      if (
        !request.outcome ||
        !request.completed_at ||
        (request.reason !== null && !NOTIFICATION_RETRY_REASONS.includes(request.reason))
      )
        fixedFailure();
      body.state =
        request.outcome === 'rejected' && request.reason === 'approval_expired'
          ? 'expired'
          : request.outcome;
      body.reason = request.reason;
      body.completedAt = date(request.completed_at);
    } else if (!validRetryEvent(request) || request.retry_processed || request.retry_failed) {
      body.state = 'unknown';
      body.reason = 'result_unknown';
    } else if (request.expires_at <= new Date()) {
      body.state = 'expired';
      body.reason = 'approval_expired';
    } else {
      body.state = request.retry_leased ? 'processing' : 'queued';
    }
    return body;
  }

  private async eligibility(target: Target, lock = false): Promise<Eligibility> {
    if (target.channel !== 'email') return { reason: 'unsupported' };
    if (
      target.status !== 'failed' ||
      !target.failure_time ||
      !Number.isInteger(target.attempts) ||
      target.attempts < 0 ||
      target.attempts >= 32767
    )
      return { reason: 'not_failed' };
    if (!target.original_id || target.original_id !== target.outbox_event_id)
      return { reason: 'outbox_unavailable' };
    if (!target.original_failure_time || target.original_processed || target.original_leased)
      return { reason: 'outbox_not_stopped' };
    if (!target.event_type || !events.has(target.event_type)) return { reason: 'unsupported' };
    const payload = payloadObject(target.payload);
    if (
      !payload ||
      !uuid.safeParse(payload.ticketId).success ||
      typeof payload.ticketNumber !== 'string' ||
      !payload.ticketNumber ||
      (payload.actorId !== undefined && !uuid.safeParse(payload.actorId).success) ||
      (target.event_type !== 'ticket.transitioned' && !uuid.safeParse(payload.actorId).success) ||
      (target.event_type === 'ticket.comment.added' && payload.visibility !== 'public') ||
      (payload.visibility !== undefined && payload.visibility !== 'public')
    )
      return { reason: 'event_invalid' };
    if (
      !uuid.safeParse(target.recipient_user_id).success ||
      payload.actorId === target.recipient_user_id
    )
      return { reason: 'recipient_ineligible' };

    if (lock) {
      // Hold current relation, address/status and existing membership through
      // the final authorization read and sender call. No new grant is needed.
      await this.client.query(
        'SELECT id FROM ticket WHERE organization_id=$1::uuid AND id=$2::uuid FOR SHARE',
        [target.organization_id, payload.ticketId],
      );
      await this.client.query('SELECT id FROM app_user WHERE id=$1::uuid FOR SHARE', [
        target.recipient_user_id,
      ]);
      await this.client.query(
        `SELECT id FROM role_binding WHERE organization_id=$1::uuid AND user_id=$2::uuid
         ORDER BY id FOR SHARE`,
        [target.organization_id, target.recipient_user_id],
      );
    }

    // No message/comment content is read. The legacy event has no comment ID:
    // existence of a current public comment by this actor is a necessary check,
    // not a claim of immutable or uniquely attributable original provenance.
    const { rows } = await this.client.query<{
      number: string;
      requester_id: string;
      assignee_id: string | null;
      recipient_valid: boolean;
      actor_exists: boolean;
      public_comment: boolean;
      recipient_valid_until: Date | null;
    }>(
      `SELECT t.number,t.requester_id,t.assignee_id,
        EXISTS(SELECT 1 FROM app_user u WHERE u.id=$3::uuid AND u.status='active'
          AND u.primary_email::text=$4 AND u.id IN (t.requester_id,t.assignee_id)
          AND EXISTS(SELECT 1 FROM role_binding rb WHERE rb.user_id=u.id
            AND rb.organization_id=$1::uuid AND rb.valid_from<=clock_timestamp()
            AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()))) AS recipient_valid,
        (SELECT CASE WHEN bool_or(rb.valid_until IS NULL) THEN NULL ELSE max(rb.valid_until) END
         FROM role_binding rb WHERE rb.organization_id=$1::uuid AND rb.user_id=$3::uuid
           AND rb.valid_from<=clock_timestamp()
           AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp())) AS recipient_valid_until,
        ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM app_user u WHERE u.id=$5::uuid)) AS actor_exists,
        EXISTS(SELECT 1 FROM ticket_comment c WHERE c.organization_id=$1::uuid
          AND c.ticket_id=t.id AND c.author_id=$5::uuid AND c.visibility='public') AS public_comment
       FROM ticket t WHERE t.organization_id=$1::uuid AND t.id=$2::uuid`,
      [
        target.organization_id,
        payload.ticketId,
        target.recipient_user_id,
        target.recipient_address,
        payload.actorId ?? null,
      ],
    );
    const ticket = rows[0];
    if (
      rows.length !== 1 ||
      !ticket ||
      ticket.number !== payload.ticketNumber ||
      !ticket.actor_exists ||
      (target.event_type === 'ticket.comment.added' && !ticket.public_comment)
    )
      return { reason: 'event_invalid' };
    if (!ticket.recipient_valid) return { reason: 'recipient_ineligible' };
    if (ticket.recipient_valid_until !== null) date(ticket.recipient_valid_until);
    const subject = buildSubject(target.event_type, ticket.number);
    const linkPath = buildLinkPath(payload.ticketId as string);
    if (subject !== target.subject || linkPath !== target.link_path)
      return { reason: 'target_changed' };
    return {
      reason: null,
      target,
      subject,
      linkPath,
      recipientValidUntil: ticket.recipient_valid_until,
      snapshot: hash([
        1,
        target.organization_id,
        target.id,
        target.outbox_event_id,
        target.channel,
        target.recipient_user_id,
        target.recipient_address,
        target.subject,
        target.link_path,
        target.status,
        target.attempts,
        target.failure_time,
        target.last_error,
        target.event_type,
        target.payload_text,
        target.original_failure_time,
        ticket.number,
        ticket.requester_id,
        ticket.assignee_id,
      ]),
    };
  }

  async get(ctx: AuthzContext, notificationId: string): Promise<NotificationRetryStatus> {
    requireNotificationListAccess(ctx);
    validId(notificationId);
    const target = await this.target(ctx.organizationId, notificationId);
    const existing = await this.reservation(ctx.organizationId, notificationId);
    if (existing) return this.result(existing);
    const eligible = await this.eligibility(target);
    return eligible.reason === null
      ? { ...blank(), eligible: true, version: version(ctx, eligible) }
      : { ...blank(), reason: eligible.reason };
  }

  async request(
    ctx: AuthzContext,
    input: {
      notificationId: string;
      sessionId: string;
      version: string;
    },
  ): Promise<NotificationRetryStatus> {
    requireNotificationListAccess(ctx);
    validId(input.notificationId);
    const sessionInput = {
      sessionId: input.sessionId,
      userId: ctx.principal.userId,
      organizationId: ctx.organizationId,
    };
    if (!(await this.deps.operationSessions.validate(sessionInput)).valid)
      throw Problems.forbidden('再試行を予約する権限がありません');
    // Scope/presence first. An existing approval converges even after completion,
    // expiry, or a stale confirmation version; syntax was checked by the route.
    await this.target(ctx.organizationId, input.notificationId);
    let existing = await this.reservation(ctx.organizationId, input.notificationId);
    if (existing) return this.result(existing);
    const locked = await this.client.query(
      'SELECT id FROM notification WHERE organization_id=$1::uuid AND id=$2::uuid FOR UPDATE',
      [ctx.organizationId, input.notificationId],
    );
    if (locked.rowCount !== 1) throw Problems.notFound('通知');
    // READ COMMITTED intentionally sees commits made while the row lock waited.
    if (!(await this.deps.operationSessions.validate(sessionInput, { lock: true })).valid)
      throw Problems.forbidden('再試行を予約する権限がありません');
    existing = await this.reservation(ctx.organizationId, input.notificationId);
    if (existing) return this.result(existing);
    const eligible = await this.eligibility(
      await this.target(ctx.organizationId, input.notificationId, true),
      true,
    );
    if (eligible.reason !== null || version(ctx, eligible) !== input.version)
      throw Problems.conflict('通知の状態が変更されています。再確認してください');
    if (!(await this.deps.operationSessions.validate(sessionInput, { lock: true })).valid)
      throw Problems.forbidden('再試行を予約する権限がありません');
    if (eligible.recipientValidUntil !== null && eligible.recipientValidUntil <= new Date())
      throw Problems.conflict('通知の状態が変更されています。再確認してください');
    const id = uuidv7();
    const retryOutboxId = await enqueueOutboxEvent(this.client, {
      eventType: 'notification.manual_retry.requested',
      organizationId: ctx.organizationId,
      payload: { retryRequestId: id },
      maxAttempts: 1,
    });
    const approvedAt = new Date(),
      expiresAt = new Date(approvedAt.getTime() + 15 * 60_000);
    await this.client.query(
      `INSERT INTO notification_retry_request
        (id,organization_id,notification_id,original_outbox_id,retry_outbox_id,requested_by,
         session_id,approved_at,expires_at,failure_attempts,failure_failed_at,snapshot_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12)`,
      [
        id,
        ctx.organizationId,
        input.notificationId,
        eligible.target.original_id,
        retryOutboxId,
        ctx.principal.userId,
        input.sessionId,
        approvedAt,
        expiresAt,
        eligible.target.attempts,
        eligible.target.failure_time,
        eligible.snapshot,
      ],
    );
    await recordAuditEvent(this.client, {
      eventType: 'notification.retry.requested',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'notification',
      targetId: input.notificationId,
      action: 'notification.retry.request',
      outcome: 'success',
      afterState: {
        retryRequestId: id,
        approvedAt: approvedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        deliveryMode: 'recording',
      },
    });
    return {
      ...blank(),
      state: 'queued',
      requestedAt: approvedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async terminal(
    request: Reservation,
    outcome: 'succeeded' | 'failed' | 'rejected',
    reason: NotificationRetryReason | null,
  ): Promise<void> {
    const receiptId = uuidv7();
    await this.client.query(
      `INSERT INTO notification_retry_receipt (id,organization_id,request_id,outcome,reason,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        receiptId,
        request.organization_id,
        request.id,
        outcome,
        reason,
        getContext()?.correlationId ?? null,
      ],
    );
    await recordAuditEvent(this.client, {
      eventType:
        outcome === 'rejected' ? 'notification.retry.rejected' : 'notification.retry.completed',
      organizationId: request.organization_id,
      actorType: 'system',
      subjectUserId: request.requested_by,
      targetType: 'notification',
      targetId: request.notification_id,
      action: 'notification.retry.execute',
      outcome: outcome === 'succeeded' ? 'success' : 'failure',
      receiptRef: receiptId,
      afterState: {
        retryRequestId: request.id,
        result: outcome,
        reason,
        deliveryMode: 'recording',
      },
    });
  }

  /** Fixed Outbox handler. Audit/SQL errors MUST reach dispatcher rollback. */
  async execute(record: OutboxRecordLike): Promise<{ outcome: 'processed' }> {
    const payload = payloadObject(record.payload);
    if (
      !uuid.safeParse(record.organizationId).success ||
      !uuid.safeParse(record.id).success ||
      record.eventType !== 'notification.manual_retry.requested' ||
      !payload ||
      Object.keys(payload).length !== 1 ||
      !uuid.safeParse(payload.retryRequestId).success
    )
      fixedFailure();
    const organizationId = record.organizationId!;
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `notification-retry:${organizationId}:${payload!.retryRequestId}`,
    ]);
    const found = await this.client.query<{ notification_id: string }>(
      `SELECT notification_id FROM notification_retry_request
       WHERE organization_id=$1::uuid AND id=$2::uuid AND retry_outbox_id=$3::uuid`,
      [organizationId, payload!.retryRequestId, record.id],
    );
    if (found.rows.length !== 1 || !found.rows[0]) fixedFailure();
    let request = await this.reservation(organizationId, found.rows[0].notification_id);
    if (
      !request ||
      request.id !== payload!.retryRequestId ||
      request.retry_outbox_id !== record.id ||
      !validRetryEvent(request)
    )
      fixedFailure();
    if (request.receipt_id) return { outcome: 'processed' };
    if (request.retry_processed || request.retry_failed) fixedFailure();
    await this.client.query(
      'SELECT id FROM notification WHERE organization_id=$1::uuid AND id=$2::uuid FOR UPDATE',
      [organizationId, request.notification_id],
    );
    // Fresh reads AFTER both locks; never use a transaction-start now() for expiry.
    request = await this.reservation(organizationId, request.notification_id);
    if (!request) fixedFailure();
    if (request.receipt_id) return { outcome: 'processed' };
    let rejection: NotificationRetryReason | null =
      request.expires_at <= new Date() ? 'approval_expired' : null;
    if (
      !rejection &&
      !(
        await this.deps.operationSessions.validate(
          {
            sessionId: request.session_id,
            userId: request.requested_by,
            organizationId,
          },
          { lock: true },
        )
      ).valid
    )
      rejection = 'session_invalid';
    let eligible: Eligibility | undefined;
    if (!rejection) {
      eligible = await this.eligibility(
        await this.target(organizationId, request.notification_id, true),
        true,
      );
      rejection = eligible.reason;
      if (
        eligible.reason === null &&
        (eligible.snapshot !== request.snapshot_hash ||
          eligible.target.attempts !== request.failure_attempts ||
          eligible.target.failure_time !== request.failure_time)
      )
        rejection = 'target_changed';
    }
    if (rejection) {
      await this.terminal(request, 'rejected', rejection);
      return { outcome: 'processed' };
    }
    if (!eligible || eligible.reason !== null) fixedFailure();
    const sender = this.deps.sender;
    if (!(sender instanceof RecordingEmailSender))
      throw new Error('NOTIFICATION_RETRY_RECORDING_ONLY');
    // Eligibility reads may take time as well. Check approval/session again at
    // the sender boundary, without extending idle time or changing actor GUC.
    const stillValid = await this.deps.operationSessions.validate(
      {
        sessionId: request.session_id,
        userId: request.requested_by,
        organizationId,
      },
      { lock: true },
    );
    if (request.expires_at <= new Date() || !stillValid.valid) {
      await this.terminal(
        request,
        'rejected',
        request.expires_at <= new Date() ? 'approval_expired' : 'session_invalid',
      );
      return { outcome: 'processed' };
    }
    if (eligible.recipientValidUntil !== null && eligible.recipientValidUntil <= new Date()) {
      await this.terminal(request, 'rejected', 'recipient_ineligible');
      return { outcome: 'processed' };
    }
    let failed = false;
    // Only the sender call is caught; SQL and audit failures below roll back.
    try {
      await sender.send({
        to: eligible.target.recipient_address,
        subject: eligible.subject,
        linkPath: eligible.linkPath,
      });
    } catch {
      failed = true;
    }
    const updated = await this.client.query(
      `UPDATE notification SET status=$3,
        sent_at=CASE WHEN $3='sent' THEN clock_timestamp() ELSE NULL END,
        failed_at=CASE WHEN $3='failed' THEN clock_timestamp() ELSE NULL END,
        last_error=CASE WHEN $3='failed' THEN 'manual_retry_sender_failed' ELSE NULL END,
        attempts=attempts+1 WHERE organization_id=$1::uuid AND id=$2::uuid AND status='failed'`,
      [organizationId, request.notification_id, failed ? 'failed' : 'sent'],
    );
    if (updated.rowCount !== 1) fixedFailure();
    await recordAuditEvent(this.client, {
      eventType: failed ? 'notification.failed' : 'notification.sent',
      organizationId,
      actorType: 'system',
      subjectUserId: eligible.target.recipient_user_id,
      targetType: 'notification',
      targetId: request.notification_id,
      action: 'send',
      outcome: failed ? 'failure' : 'success',
      afterState: failed
        ? { channel: 'email', errorSummary: 'manual_retry_sender_failed' }
        : { channel: 'email' },
    });
    await this.terminal(request, failed ? 'failed' : 'succeeded', failed ? 'sender_failed' : null);
    return { outcome: 'processed' };
  }
}
