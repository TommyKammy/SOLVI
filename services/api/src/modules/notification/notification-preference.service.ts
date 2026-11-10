import type pg from 'pg';
import { z } from 'zod';
import { Problems } from '@solvi/shared';
import type { AuthzContext } from '../../common/authz/authz.js';
import { recordAuditEvent } from '../../common/audit/audit.js';

export interface NotificationPreference {
  ticketEmailEnabled: boolean;
}
export const OPTIONAL_TICKET_EMAIL_EVENTS: ReadonlySet<string> = new Set([
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.reassessed',
]);
type Client = pg.PoolClient | pg.Client;
const uuid = z.string().uuid();

/** A platform binding does not constitute membership of the selected organization. */
export function requireNotificationPreferenceAccess(ctx: AuthzContext): void {
  const now = ctx.now ?? new Date();
  if (
    !uuid.safeParse(ctx.organizationId).success ||
    !uuid.safeParse(ctx.principal.userId).success ||
    ctx.principal.status !== 'active' ||
    !ctx.principal.bindings.some(
      (binding) =>
        binding.organizationId === ctx.organizationId &&
        !binding.roleCode.startsWith('platform_') &&
        binding.validFrom <= now &&
        (binding.validUntil === null || binding.validUntil > now),
    )
  )
    throw Problems.forbidden('選択中の組織の有効な所属が必要です');
}

function invalidResult(): never {
  throw new Error('NOTIFICATION_PREFERENCE_RESULT_INVALID');
}

/**
 * ADR-0039: existing delivery rows retain their retry contract. Only a new row
 * consults the preference. This is a statement snapshot, not cancellation of
 * in-flight work or a preference snapshot at event creation time.
 * Organization-only SELECT lets the existing app-role dispatcher read it without
 * impersonating the recipient through app.current_actor.
 */
export async function allowTicketEmailPreparation(
  client: Client,
  organizationId: string,
  userId: string,
  outboxEventId: string,
  address: string,
): Promise<boolean> {
  const { rows } = await client.query<{ enabled: boolean }>(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM notification
       WHERE organization_id=$1::uuid AND outbox_event_id=$3::uuid AND recipient_address=$4
     ) THEN true ELSE COALESCE((
       SELECT ticket_email_enabled FROM notification_preference
       WHERE organization_id=$1::uuid AND user_id=$2::uuid
     ), true) END AS enabled`,
    [organizationId, userId, outboxEventId, address],
  );
  if (rows.length !== 1 || typeof rows[0]?.enabled !== 'boolean') invalidResult();
  return rows[0]!.enabled;
}

export class NotificationPreferenceService {
  constructor(private readonly client: Client) {}

  private async currentMembership(ctx: AuthzContext): Promise<void> {
    const { rows } = await this.client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM app_user u JOIN role_binding rb ON rb.user_id=u.id
         JOIN role r ON r.id=rb.role_id
         WHERE u.id=$2::uuid AND u.status='active' AND rb.organization_id=$1::uuid
           AND r.scope='org' AND rb.valid_from <= statement_timestamp()
           AND (rb.valid_until IS NULL OR rb.valid_until > statement_timestamp())
       ) AS allowed`,
      [ctx.organizationId, ctx.principal.userId],
    );
    if (rows.length !== 1 || typeof rows[0]?.allowed !== 'boolean') invalidResult();
    if (!rows[0]!.allowed) throw Problems.forbidden('選択中の組織の有効な所属が必要です');
  }

  private async read(ctx: AuthzContext): Promise<NotificationPreference> {
    const { rows } = await this.client.query<{ ticket_email_enabled: boolean }>(
      `SELECT ticket_email_enabled FROM notification_preference
       WHERE organization_id=$1::uuid AND user_id=$2::uuid`,
      [ctx.organizationId, ctx.principal.userId],
    );
    if (
      rows.length > 1 ||
      (rows.length === 1 && typeof rows[0]?.ticket_email_enabled !== 'boolean')
    )
      invalidResult();
    return { ticketEmailEnabled: rows[0]?.ticket_email_enabled ?? true };
  }

  async get(ctx: AuthzContext): Promise<NotificationPreference> {
    requireNotificationPreferenceAccess(ctx);
    await this.currentMembership(ctx);
    return this.read(ctx);
  }

  /** The caller owns the transaction: row change and audit must commit together. */
  async update(ctx: AuthzContext, ticketEmailEnabled: boolean): Promise<NotificationPreference> {
    requireNotificationPreferenceAccess(ctx);
    if (typeof ticketEmailEnabled !== 'boolean')
      throw Problems.validation([
        { field: 'ticketEmailEnabled', message: '通知設定を確認してください' },
      ]);
    // Serializes both missing-row and existing-row saves. Hash collisions only wait.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `notification-preference:${ctx.organizationId}:${ctx.principal.userId}`,
    ]);
    // A binding can expire or be removed while waiting for the lock. Do not use
    // transaction-start now(), or just the principal obtained before that wait.
    await this.currentMembership(ctx);
    const before = await this.read(ctx);
    if (before.ticketEmailEnabled === ticketEmailEnabled) return before;
    const written = await this.client.query(
      `INSERT INTO notification_preference (organization_id,user_id,ticket_email_enabled,updated_at)
       VALUES ($1::uuid,$2::uuid,$3,statement_timestamp())
       ON CONFLICT (organization_id,user_id) DO UPDATE
       SET ticket_email_enabled=EXCLUDED.ticket_email_enabled,updated_at=EXCLUDED.updated_at
       RETURNING ticket_email_enabled`,
      [ctx.organizationId, ctx.principal.userId, ticketEmailEnabled],
    );
    if (written.rows.length !== 1 || written.rows[0]?.ticket_email_enabled !== ticketEmailEnabled)
      invalidResult();
    const after = { ticketEmailEnabled };
    await recordAuditEvent(this.client, {
      eventType: 'config.changed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: ctx.principal.userId,
      targetType: 'notification_preference',
      targetId: ctx.principal.userId,
      action: 'notification.preference.update',
      outcome: 'success',
      beforeState: { ...before },
      afterState: after,
    });
    return after;
  }
}
