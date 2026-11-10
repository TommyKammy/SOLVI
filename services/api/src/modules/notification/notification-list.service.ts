import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { Problems } from '@solvi/shared';
import { hasRole, type AuthzContext } from '../../common/authz/authz.js';

export const NOTIFICATION_PAGE_SIZE = 20;
export const NOTIFICATION_CURSOR_MAX_LENGTH = 168;
export const NOTIFICATION_EVENT_TYPES = [
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.reassessed',
  'role.binding.expiring',
] as const;
const statuses = ['all', 'pending', 'sent', 'failed'] as const;
type StatusFilter = (typeof statuses)[number];
type Direction = 'next' | 'previous';
interface Anchor {
  createdAt: string;
  id: string;
}
export interface NotificationListOptions {
  status: StatusFilter;
  direction: Direction;
  cursor: Anchor | null;
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}
const timestamp = z.string().refine(validTimestamp);
const uuid = z.string().uuid();
const cursorSchema = z.tuple([
  z.literal(1),
  z.union([z.literal(0), z.literal(1)]),
  timestamp,
  uuid,
  z.string().regex(/^[A-Za-z0-9_-]{43}$/),
]);
const itemSchema = z.object({
  id: uuid,
  eventType: z.enum([...NOTIFICATION_EVENT_TYPES, 'other']),
  channel: z.enum(['email', 'webhook', 'other']),
  status: z.enum(['pending', 'sent', 'failed']),
  createdAt: timestamp,
  sentAt: timestamp.nullable(),
  failedAt: timestamp.nullable(),
  attempts: z.number().int().min(0).max(32767),
  outboxStatus: z.enum([
    'waiting',
    'retry_waiting',
    'processing',
    'finished',
    'stopped',
    'unknown',
  ]),
  nextAttemptAt: timestamp.nullable(),
  // A confirmation entry point, never a promise that the latest target is eligible.
  manualRetry: z.enum(['check_required', 'reserved', 'unavailable']),
});
export type NotificationListItem = z.infer<typeof itemSchema>;
export interface NotificationListResponse {
  items: NotificationListItem[];
  counts: { all: number; pending: number; sent: number; failed: number };
  total: number;
  previousCursor: string | null;
  nextCursor: string | null;
  deliveryMode: 'recording';
}

/** ADR-0038: platform privilege alone does not authorize this organization's records. */
export function requireNotificationListAccess(ctx: AuthzContext): void {
  const scoped = {
    ...ctx,
    principal: {
      ...ctx.principal,
      bindings: ctx.principal.bindings.filter(
        (binding) => binding.organizationId === ctx.organizationId,
      ),
    },
  };
  if (
    !uuid.safeParse(ctx.organizationId).success ||
    !uuid.safeParse(ctx.principal.userId).success ||
    !hasRole(scoped, 'org_admin')
  ) {
    throw Problems.forbidden('必要な権限がありません');
  }
}

function invalidQuery(): never {
  // Do not reflect arbitrary parameters, cursor content or identifiers into errors.
  throw Problems.validation([
    { field: 'query', message: '表示条件が不正です。先頭から開き直してください' },
  ]);
}
function cursorDigest(ctx: AuthzContext, status: StatusFilter, direction: Direction): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        ctx.principal.userId,
        ctx.organizationId,
        status,
        NOTIFICATION_PAGE_SIZE,
        direction,
      ]),
    )
    .digest('base64url');
}
export function parseNotificationListQuery(
  query: URLSearchParams,
  ctx: AuthzContext,
): NotificationListOptions {
  for (const key of query.keys()) {
    if (!['status', 'direction', 'cursor'].includes(key) || query.getAll(key).length !== 1)
      invalidQuery();
  }
  const status = query.get('status') ?? 'all';
  const direction = query.get('direction') ?? 'next';
  if (!statuses.includes(status as StatusFilter) || !['next', 'previous'].includes(direction))
    invalidQuery();
  const options: NotificationListOptions = {
    status: status as StatusFilter,
    direction: direction as Direction,
    cursor: null,
  };
  const raw = query.get('cursor');
  if (raw === null) {
    if (direction !== 'next') invalidQuery();
    return options;
  }
  if (!raw || raw.length > NOTIFICATION_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw))
    invalidQuery();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    invalidQuery();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) invalidQuery();
  const tuple = parsed.data;
  if (
    Buffer.from(JSON.stringify(tuple)).toString('base64url') !== raw ||
    tuple[1] !== (direction === 'next' ? 0 : 1) ||
    tuple[4] !== cursorDigest(ctx, options.status, options.direction)
  )
    invalidQuery();
  options.cursor = { createdAt: tuple[2], id: tuple[3] };
  return options;
}
export function encodeNotificationCursor(
  ctx: AuthzContext,
  status: StatusFilter,
  anchor: Anchor,
  direction: Direction,
): string {
  const tuple = cursorSchema.parse([
    1,
    direction === 'next' ? 0 : 1,
    anchor.createdAt,
    anchor.id,
    cursorDigest(ctx, status, direction),
  ]);
  return Buffer.from(JSON.stringify(tuple)).toString('base64url');
}

const filtered = "n.organization_id=$1::uuid AND ($2::text='all' OR n.status=$2::text)";
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
interface SqlQuery {
  sql: string;
  params: unknown[];
}
export function buildNotificationPageQuery(
  ctx: AuthzContext,
  options: NotificationListOptions,
): SqlQuery {
  const params: unknown[] = [ctx.organizationId, options.status];
  const previous = options.direction === 'previous';
  let boundary = '';
  if (options.cursor) {
    params.push(options.cursor.createdAt, options.cursor.id);
    boundary = ` AND (n.created_at,n.id) ${previous ? '>' : '<'} ($3::timestamptz,$4::uuid)`;
  }
  params.push([...NOTIFICATION_EVENT_TYPES]);
  const eventsParam = params.length;
  params.push(NOTIFICATION_PAGE_SIZE);
  // Explicit projection: no payload, recipients, links, outbox IDs, or raw errors are read.
  return {
    sql: `SELECT n.id,
      CASE WHEN o.event_type=ANY($${eventsParam}::text[]) THEN o.event_type ELSE 'other' END AS "eventType",
      CASE WHEN n.channel IN ('email','webhook') THEN n.channel ELSE 'other' END AS channel,
      n.status, ${iso('n.created_at')} AS "createdAt", ${iso('n.sent_at')} AS "sentAt",
      ${iso('n.failed_at')} AS "failedAt", n.attempts,
      CASE WHEN o.id IS NULL THEN 'unknown'
        WHEN o.failed_at IS NOT NULL THEN 'stopped'
        WHEN o.processed_at IS NOT NULL THEN 'finished'
        WHEN o.locked_until > CURRENT_TIMESTAMP THEN 'processing'
        WHEN n.status='failed' THEN 'retry_waiting' ELSE 'waiting' END AS "outboxStatus",
      CASE WHEN o.failed_at IS NULL AND o.processed_at IS NULL
        AND (o.locked_until IS NULL OR o.locked_until <= CURRENT_TIMESTAMP)
        AND n.status IN ('pending','failed') THEN ${iso('o.available_at')} ELSE NULL END AS "nextAttemptAt",
      CASE WHEN EXISTS (
        SELECT 1 FROM notification_retry_request rr
         WHERE rr.organization_id=n.organization_id AND rr.notification_id=n.id
      ) THEN 'reserved'
        WHEN n.status='failed' AND n.channel='email'
          AND o.event_type IN ('ticket.created','ticket.transitioned','ticket.assigned',
                               'ticket.comment.added','ticket.reassessed')
          AND o.failed_at IS NOT NULL AND o.processed_at IS NULL
          AND (o.locked_until IS NULL OR o.locked_until <= CURRENT_TIMESTAMP)
        THEN 'check_required' ELSE 'unavailable' END AS "manualRetry"
      FROM notification n LEFT JOIN outbox_event o ON o.id=n.outbox_event_id
        AND o.organization_id=n.organization_id AND o.organization_id=$1::uuid
      WHERE ${filtered}${boundary}
      ORDER BY n.created_at ${previous ? 'ASC' : 'DESC'},n.id ${previous ? 'ASC' : 'DESC'} LIMIT $${params.length}`,
    params,
  };
}

function resultInvalid(): never {
  throw new Error('NOTIFICATION_LIST_RESULT_INVALID');
}
function count(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) resultInvalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) resultInvalid();
  return parsed;
}
/** Called only inside the controller's single READ ONLY REPEATABLE READ transaction. */
export class NotificationListService {
  constructor(private readonly client: pg.PoolClient) {}

  async list(
    ctx: AuthzContext,
    options: NotificationListOptions,
  ): Promise<NotificationListResponse> {
    requireNotificationListAccess(ctx);
    const counted = await this.client.query(
      `SELECT count(*)::text AS all,
      count(*) FILTER (WHERE n.status='pending')::text AS pending,
      count(*) FILTER (WHERE n.status='sent')::text AS sent,
      count(*) FILTER (WHERE n.status='failed')::text AS failed
      FROM notification n WHERE n.organization_id=$1::uuid`,
      [ctx.organizationId],
    );
    const rawCounts = counted.rows[0];
    if (counted.rows.length !== 1 || !rawCounts) resultInvalid();
    const counts = {
      all: count(rawCounts.all),
      pending: count(rawCounts.pending),
      sent: count(rawCounts.sent),
      failed: count(rawCounts.failed),
    };
    if (counts.pending + counts.sent + counts.failed !== counts.all) resultInvalid();
    const query = buildNotificationPageQuery(ctx, options);
    const page = await this.client.query(query.sql, query.params);
    const parsed = z.array(itemSchema).max(NOTIFICATION_PAGE_SIZE).safeParse(page.rows);
    if (!parsed.success) resultInvalid();
    const items = options.direction === 'previous' ? parsed.data.reverse() : parsed.data;
    const total = counts[options.status];
    if (items.length > total) resultInvalid();
    const response: NotificationListResponse = {
      items,
      counts,
      total,
      previousCursor: null,
      nextCursor: null,
      deliveryMode: 'recording',
    };
    const first = items[0],
      last = items.at(-1);
    if (first && last) {
      const neighbors = await this.client.query(
        `SELECT
        EXISTS(SELECT 1 FROM notification n WHERE ${filtered} AND (n.created_at,n.id) > ($3::timestamptz,$4::uuid)) AS previous,
        EXISTS(SELECT 1 FROM notification n WHERE ${filtered} AND (n.created_at,n.id) < ($5::timestamptz,$6::uuid)) AS next`,
        [ctx.organizationId, options.status, first.createdAt, first.id, last.createdAt, last.id],
      );
      const row = neighbors.rows[0];
      if (
        neighbors.rows.length !== 1 ||
        typeof row?.previous !== 'boolean' ||
        typeof row?.next !== 'boolean'
      )
        resultInvalid();
      if (row.previous)
        response.previousCursor = encodeNotificationCursor(ctx, options.status, first, 'previous');
      if (row.next)
        response.nextCursor = encodeNotificationCursor(ctx, options.status, last, 'next');
    }
    return response;
  }
}
