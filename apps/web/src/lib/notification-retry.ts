export const RETRY_REASONS = {
  unsupported: 'この種類・方法の通知は手動再試行の対象外です。',
  not_failed: '失敗状態ではないため、再試行を予約できません。',
  outbox_unavailable: '元の処理を確認できないため、再試行を予約できません。',
  outbox_not_stopped: '元の処理が終了していないため、再試行を予約できません。',
  recipient_ineligible: '現在の受信条件を満たさないため、再試行を予約できません。',
  event_invalid: '元の通知の整合性を確認できないため、再試行を予約できません。',
  target_changed: '通知または関連する情報が変更されています。最新の状態を確認してください。',
  approval_expired: '予約から15分を経過し、実行できませんでした。',
  session_invalid: '予約時のログイン状態または権限を確認できず、実行できませんでした。',
  sender_failed: '追加の記録処理が失敗しました。再予約はできません。',
  result_unknown: '処理結果を確認できません。再予約せず、管理者による確認が必要です。',
} as const;
export const RETRY_STATES = {
  not_requested: '未予約',
  queued: '再試行を予約済み',
  processing: '再試行を処理中',
  succeeded: '再試行の記録が完了',
  failed: '再試行が失敗',
  rejected: '再試行を実行できませんでした',
  expired: '予約の有効期限切れ',
  unknown: '再試行の結果不明',
} as const;
export interface NotificationRetryStatus {
  eligible: boolean;
  reason: keyof typeof RETRY_REASONS | null;
  version: string | null;
  state: keyof typeof RETRY_STATES;
  requestedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  deliveryMode: 'recording';
}
export const retryVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const retryTarget = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const date = (value: unknown) =>
  value === null ||
  (typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
/** Accept only fixed public metadata, never server error text or delivery contents. */
export function parseNotificationRetry(value: unknown): NotificationRetryStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    'eligible',
    'reason',
    'version',
    'state',
    'requestedAt',
    'expiresAt',
    'completedAt',
    'deliveryMode',
  ];
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    typeof row.eligible !== 'boolean' ||
    row.deliveryMode !== 'recording' ||
    typeof row.state !== 'string' ||
    !Object.hasOwn(RETRY_STATES, row.state) ||
    !(
      row.reason === null ||
      (typeof row.reason === 'string' && Object.hasOwn(RETRY_REASONS, row.reason))
    ) ||
    !(row.version === null || retryVersion(row.version)) ||
    ![row.requestedAt, row.expiresAt, row.completedAt].every(date) ||
    (row.eligible &&
      (row.state !== 'not_requested' || row.reason !== null || !retryVersion(row.version))) ||
    (!row.eligible && row.version !== null)
  )
    return null;
  if (row.state === 'not_requested') {
    if (
      row.requestedAt !== null ||
      row.expiresAt !== null ||
      row.completedAt !== null ||
      (!row.eligible && row.reason === null)
    )
      return null;
  } else {
    if (
      row.eligible ||
      row.requestedAt === null ||
      row.expiresAt === null ||
      Date.parse(String(row.expiresAt)) <= Date.parse(String(row.requestedAt))
    )
      return null;
    if (['queued', 'processing', 'succeeded'].includes(row.state) && row.reason !== null)
      return null;
    if (['queued', 'processing'].includes(row.state) && row.completedAt !== null) return null;
    if (['succeeded', 'failed', 'rejected'].includes(row.state) && row.completedAt === null)
      return null;
    if (row.state === 'failed' && row.reason !== 'sender_failed') return null;
    if (row.state === 'rejected' && row.reason === null) return null;
    if (row.state === 'expired' && row.reason !== 'approval_expired') return null;
    if (row.state === 'unknown' && row.reason !== 'result_unknown') return null;
  }
  return row as unknown as NotificationRetryStatus;
}
export interface NotificationRetryState {
  message: string;
  attempt: number;
  data?: NotificationRetryStatus;
  mustCheck?: boolean;
  scopeChanged?: boolean;
}
export function retryFailure(status: number): string {
  if (status === 401)
    return 'ログインの有効期限が切れました。ログインし直してから、予約状態を確認してください。';
  if (status === 403) return '選択中の組織で有効な組織管理者の権限を確認できませんでした。';
  if (status === 404) return '対象の通知を確認できませんでした。一覧を開き直してください。';
  if (status === 409) return '通知の状態が変更されています。内容を再確認してから操作してください。';
  if (status === 400) return '確認内容を読み取れませんでした。一覧から確認し直してください。';
  return '予約状態を確認できませんでした。結果を推測して再予約せず、状態を再確認してください。';
}
