export const NOTIFICATION_STATUSES = ['all', 'pending', 'sent', 'failed'] as const;
export type NotificationStatusFilter = (typeof NOTIFICATION_STATUSES)[number];
export type NotificationQuery = {
  status: NotificationStatusFilter;
  direction: 'next' | 'previous';
  cursor?: string;
  invalid: boolean;
};
export const NOTIFICATION_EVENTS = {
  'ticket.created': '問い合わせの受付',
  'ticket.transitioned': '問い合わせの状態変更',
  'ticket.assigned': '担当者の割り当て',
  'ticket.comment.added': 'コメントの追加',
  'ticket.reassessed': '優先度の見直し',
  'role.binding.expiring': 'ロールの有効期限',
  other: 'その他',
} as const;
export const NOTIFICATION_STATUS_LABELS = {
  all: 'すべて',
  pending: '未処理',
  sent: '記録済み',
  failed: '失敗',
} as const;
export const OUTBOX_STATUS_LABELS = {
  waiting: '処理待ち',
  retry_waiting: '再試行待ち',
  processing: '処理中',
  finished: '処理終了',
  stopped: '再試行なし',
  unknown: '処理状況不明',
} as const;
export interface NotificationItem {
  id: string;
  eventType: keyof typeof NOTIFICATION_EVENTS;
  channel: 'email' | 'webhook' | 'other';
  status: 'pending' | 'sent' | 'failed';
  createdAt: string;
  sentAt: string | null;
  failedAt: string | null;
  attempts: number;
  outboxStatus: keyof typeof OUTBOX_STATUS_LABELS;
  nextAttemptAt: string | null;
  manualRetry: 'check_required' | 'reserved' | 'unavailable';
}
export interface NotificationList {
  items: NotificationItem[];
  counts: Record<NotificationStatusFilter, number>;
  total: number;
  previousCursor: string | null;
  nextCursor: string | null;
  deliveryMode: 'recording';
}
const opaque = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 168 &&
  /^[A-Za-z0-9_-]+$/.test(value);
export function parseNotificationQuery(
  raw: Record<string, string | string[] | undefined>,
): NotificationQuery {
  const status = raw.status ?? 'all';
  const direction = raw.direction ?? 'next';
  const validStatus =
    typeof status === 'string' &&
    NOTIFICATION_STATUSES.includes(status as NotificationStatusFilter);
  const validDirection = direction === 'next' || direction === 'previous';
  const cursorValid = raw.cursor === undefined || opaque(raw.cursor);
  return {
    status: validStatus ? (status as NotificationStatusFilter) : 'all',
    direction: direction === 'previous' ? 'previous' : 'next',
    ...(opaque(raw.cursor) ? { cursor: raw.cursor } : {}),
    invalid:
      !validStatus ||
      !validDirection ||
      !cursorValid ||
      (direction === 'previous' && raw.cursor === undefined),
  };
}
export function notificationQueryString(
  query: Pick<NotificationQuery, 'status' | 'direction' | 'cursor'>,
): string {
  const params = new URLSearchParams({ status: query.status });
  if (query.cursor) {
    params.set('direction', query.direction);
    params.set('cursor', query.cursor);
  }
  return params.toString();
}
export const notificationHref = (
  query: Pick<NotificationQuery, 'status' | 'direction' | 'cursor'>,
) => '/ops/notifications?' + notificationQueryString(query);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const nullableDate = (value: unknown) => value === null || date(value);
/** Fail closed before rendering any server-provided text or unexpected field. */
export function parseNotificationList(
  value: unknown,
  status: NotificationStatusFilter,
): NotificationList | null {
  if (
    !record(value) ||
    !keys(value, ['items', 'counts', 'total', 'previousCursor', 'nextCursor', 'deliveryMode']) ||
    value.deliveryMode !== 'recording' ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !integer(value.total) ||
    !record(value.counts) ||
    !keys(value.counts, [...NOTIFICATION_STATUSES]) ||
    !NOTIFICATION_STATUSES.every((key) =>
      integer((value.counts as Record<string, unknown>)[key]),
    ) ||
    value.total !== value.counts[status]
  )
    return null;
  const counts = value.counts as NotificationList['counts'];
  if (
    counts.all !== counts.pending + counts.sent + counts.failed ||
    value.items.length > value.total
  )
    return null;
  if (
    ![value.previousCursor, value.nextCursor].every((cursor) => cursor === null || opaque(cursor))
  )
    return null;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !record(item) ||
      !keys(item, [
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
      ]) ||
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(item.id) ||
      seen.has(item.id) ||
      typeof item.eventType !== 'string' ||
      !Object.hasOwn(NOTIFICATION_EVENTS, item.eventType) ||
      typeof item.channel !== 'string' ||
      !['email', 'webhook', 'other'].includes(item.channel) ||
      typeof item.status !== 'string' ||
      !['pending', 'sent', 'failed'].includes(item.status) ||
      (status !== 'all' && item.status !== status) ||
      !date(item.createdAt) ||
      !nullableDate(item.sentAt) ||
      !nullableDate(item.failedAt) ||
      !integer(item.attempts) ||
      typeof item.outboxStatus !== 'string' ||
      !Object.hasOwn(OUTBOX_STATUS_LABELS, item.outboxStatus) ||
      !nullableDate(item.nextAttemptAt) ||
      typeof item.manualRetry !== 'string' ||
      !['check_required', 'reserved', 'unavailable'].includes(item.manualRetry)
    )
      return null;
    if (
      item.nextAttemptAt !== null &&
      (item.status === 'sent' || !['waiting', 'retry_waiting'].includes(item.outboxStatus))
    )
      return null;
    seen.add(item.id);
  }
  return value as unknown as NotificationList;
}
export function notificationDate(value: string) {
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(value));
}
