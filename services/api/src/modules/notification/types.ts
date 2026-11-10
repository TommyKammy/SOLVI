/**
 * ディスパッチャとの契約。
 * 通知サービスが Worker のクラスへ直接依存すると、
 * API → Worker の依存が生まれて禁止依存検査に引っかかる。
 * 必要な形だけをここで定義する。
 */
export interface OutboxRecordLike {
  id: string;
  organizationId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

export const NOTIFICATION_RETRY_REASONS = [
  'unsupported',
  'not_failed',
  'outbox_unavailable',
  'outbox_not_stopped',
  'recipient_ineligible',
  'event_invalid',
  'target_changed',
  'approval_expired',
  'session_invalid',
  'sender_failed',
  'result_unknown',
] as const;
export type NotificationRetryReason = (typeof NOTIFICATION_RETRY_REASONS)[number];
export interface NotificationRetryStatus {
  eligible: boolean;
  reason: NotificationRetryReason | null;
  version: string | null;
  state:
    | 'not_requested'
    | 'queued'
    | 'processing'
    | 'succeeded'
    | 'failed'
    | 'rejected'
    | 'expired'
    | 'unknown';
  requestedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  deliveryMode: 'recording';
}

/** Auth's read-only validation on the SAME transaction client; no idle extension. */
export interface OperationSessionValidator {
  validate(
    input: { sessionId: string; userId: string; organizationId: string },
    options?: { lock?: boolean },
  ): Promise<
    | { valid: true }
    | {
        valid: false;
        reason: 'session_invalid' | 'organization_changed' | 'user_inactive' | 'role_invalid';
      }
  >;
}
