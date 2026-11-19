import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { recordAuditEvent } from '../../common/audit/audit.js';
import { requireRole } from '../../common/authz/authz.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

const eventTypes = {
  approval: [
    'approval.requested',
    'approval.approved',
    'approval.rejected',
    'approval.invalidated',
    'approval.cancelled',
    'approval.expired',
    'approval.reassigned',
    'approval.delegated',
    'approval.delegation_revoked',
    'request.approved',
    'request.rejected',
    'request.revoked',
    'change.approved',
    'change.rejected',
  ],
  role: ['role.binding.created', 'role.binding.deleted'],
  review: ['access.review.opened', 'access.review.item.decided', 'access.review.completed'],
  assistance: ['ai.suggestion.accepted', 'ai.suggestion.rejected'],
  automation: ['request.simulated'],
} as const;

const roles = new Set([
  'agent',
  'requester',
  'approver',
  'auditor',
  'org_admin',
  'platform_admin',
  'platform_auditor',
  'catalog_editor',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = /^\d{4}-\d{2}-\d{2}$/;
const filters = new Set(['from', 'to', 'category', 'page', 'target', 'event']);
const pageSize = 25;

function invalid(field: string, message: string): never {
  throw Problems.validation([{ field, message }]);
}

function utcDate(value: string | null, field: string) {
  if (!value || !day.test(value) || value.startsWith('0000-')) {
    invalid(field, '日付を指定してください');
  }
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    invalid(field, '有効な日付を指定してください');
  }
  return date;
}

export function parseAuditEventsQuery(query: URLSearchParams) {
  for (const key of query.keys()) {
    if (!filters.has(key) || query.getAll(key).length !== 1) {
      invalid('query', '絞り込み条件を確認してください');
    }
  }
  const from = utcDate(query.get('from'), 'from');
  const to = utcDate(query.get('to'), 'to');
  const span = (to.getTime() - from.getTime()) / 86_400_000;
  if (span < 0 || span >= 31) invalid('to', '開始日から31日以内で指定してください');
  const category = query.get('category') ?? 'all';
  if (category !== 'all' && !Object.hasOwn(eventTypes, category)) {
    invalid('category', '種別を確認してください');
  }
  const page = query.get('page') ?? '1';
  if (!/^[1-9]\d{0,2}$/.test(page) || Number(page) > 200) {
    invalid('page', 'ページを確認してください');
  }
  const target = query.get('target');
  if (target !== null && !uuid.test(target)) invalid('target', '対象を確認してください');
  const event = query.get('event');
  if (event !== null && !uuid.test(event)) invalid('event', '記録を確認してください');
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    category,
    types:
      category === 'all'
        ? Object.values(eventTypes).flat()
        : eventTypes[category as keyof typeof eventTypes],
    page: Number(page),
    target: target?.toLowerCase() ?? null,
    event: event?.toLowerCase() ?? null,
  };
}

interface EventRow {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  subject_user_id: string | null;
  target_id: string | null;
  before_role: string | null;
  after_role: string | null;
  step_no: string | null;
  ticket_id: string | null;
  receipt_ref: string | null;
}

export class AuditEventsController {
  constructor(private readonly deps: { pool: pg.Pool }) {}

  async read(
    auth: AuthenticatedRequest,
    query: URLSearchParams,
    request: { sourceIp?: string; userAgent?: string } = {},
  ) {
    const { authz } = auth;
    requireRole(authz, 'auditor', 'platform_auditor');
    const filter = parseAuditEventsQuery(query);
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org', $1, true)", [authz.organizationId]);
      const { rows } = await client.query<EventRow>(
        'SELECT event_id, event_type, occurred_at, actor_type, actor_id, subject_user_id, target_id,\n' +
          "       before_state->>'roleCode' AS before_role, after_state->>'roleCode' AS after_role,\n" +
          "       after_state->>'stepNo' AS step_no, after_state->>'ticketId' AS ticket_id, receipt_ref\n" +
          '  FROM audit_event\n' +
          ' WHERE organization_id = $1::uuid AND event_type = ANY($2::text[])\n' +
          "   AND occurred_at >= ($3::date::timestamp AT TIME ZONE 'UTC')\n" +
          "   AND occurred_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')\n" +
          '   AND ($5::text IS NULL OR target_id = $5)\n' +
          '   AND ($6::uuid IS NULL OR event_id = $6)\n' +
          ' ORDER BY occurred_at DESC, event_id DESC LIMIT $7 OFFSET $8',
        [
          authz.organizationId,
          filter.types,
          filter.from,
          filter.to,
          filter.target,
          filter.event,
          pageSize + 1,
          filter.event ? 0 : (filter.page - 1) * pageSize,
        ],
      );
      const items = rows.slice(0, pageSize).map((row) => ({
        id: row.event_id,
        type: row.event_type,
        occurredAt: row.occurred_at.toISOString(),
        actorType: row.actor_type,
        actorId: row.actor_id,
        subjectId: row.subject_user_id,
        targetId: row.target_id && uuid.test(row.target_id) ? row.target_id : null,
        roleBefore:
          row.event_type === 'role.binding.deleted' && row.before_role && roles.has(row.before_role)
            ? row.before_role
            : null,
        roleAfter:
          row.event_type === 'role.binding.created' && row.after_role && roles.has(row.after_role)
            ? row.after_role
            : null,
        step: row.step_no && /^[1-9]\d?$/.test(row.step_no) ? Number(row.step_no) : null,
        ...((row.event_type === 'request.simulated' ||
          eventTypes.assistance.some((type) => type === row.event_type)) &&
        row.ticket_id &&
        uuid.test(row.ticket_id)
          ? { ticketId: row.ticket_id }
          : {}),
        ...(row.event_type === 'request.simulated' && row.receipt_ref
          ? { receiptId: row.receipt_ref }
          : {}),
      }));
      await recordAuditEvent(client, {
        eventType: 'audit.viewed',
        organizationId: authz.organizationId,
        actorType: 'user',
        actorId: authz.principal.userId,
        targetType: 'audit_event',
        action: 'view',
        outcome: 'success',
        sourceIp: request.sourceIp,
        userAgent: request.userAgent,
        afterState: {
          from: filter.from,
          to: filter.to,
          category: filter.category,
          page: filter.page,
          eventCount: items.length,
          detail: filter.event !== null,
          targetFiltered: filter.target !== null,
        },
      });
      await client.query('COMMIT');
      return { items, hasMore: rows.length > pageSize && filter.page < 200 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
