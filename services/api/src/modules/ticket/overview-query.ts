import { Problems } from '@solvi/shared';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';
import { SLA_BREACHED_SQL, SLA_JOIN_SQL } from './ticket-query.js';

export const TICKET_OVERVIEW_METRICS = [
  'open',
  'unassigned',
  'mine',
  'pending',
  'breached',
  'critical',
] as const;
export type TicketOverviewCounts = Record<(typeof TICKET_OVERVIEW_METRICS)[number], number>;
export interface OverviewOptions {
  group?: string;
}
export interface TicketOverviewQuery {
  sql: string;
  params: unknown[];
}

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The existing staff policy, including active binding, expiry, and organization checks. */
export function requireOverviewAccess(ctx: AuthzContext): void {
  requireRole(ctx, 'agent', 'org_admin', 'platform_admin');
}

export function validateOverviewGroup(group: string | undefined): string {
  if (group === undefined) return '';
  if (
    typeof group !== 'string' ||
    (group !== '' && group !== 'mine' && group !== 'ungrouped' && !GROUP_ID.test(group))
  ) {
    throw Problems.validation([{ field: 'group', message: '指定できない担当グループです' }]);
  }
  return group;
}

/** One exact aggregate, no user-name joins, list retrieval, cache, or estimated totals. */
export function buildTicketOverviewQuery(
  ctx: AuthzContext,
  options: OverviewOptions = {},
): TicketOverviewQuery {
  requireOverviewAccess(ctx);
  const group = validateOverviewGroup(options.group);
  const params: unknown[] = [
    ctx.organizationId,
    ctx.principal.userId,
    ['new', 'assigned', 'in_progress', 'pending'],
  ];
  const clauses = ['t.organization_id = $1', 't.state = ANY($3::text[])'];
  if (group === 'mine') {
    // Same active membership as GroupService.myGroups. An empty set remains an empty set.
    clauses.push(`t.assignee_group_id IN (
      SELECT g.id FROM assignment_group g
      JOIN assignment_group_member m ON m.group_id=g.id AND m.organization_id=g.organization_id
      WHERE g.organization_id=$1 AND m.organization_id=$1 AND m.user_id=$2 AND g.active
    )`);
  } else if (group === 'ungrouped') {
    clauses.push('t.assignee_group_id IS NULL');
  } else if (group) {
    params.push(group);
    clauses.push(`t.assignee_group_id = $${params.length}::uuid`);
  }
  return {
    sql: `SELECT count(*)::int AS open,
      (count(*) FILTER (WHERE t.assignee_id IS NULL))::int AS unassigned,
      (count(*) FILTER (WHERE t.assignee_id=$2))::int AS mine,
      (count(*) FILTER (WHERE t.state='pending'))::int AS pending,
      (count(*) FILTER (WHERE ${SLA_BREACHED_SQL}))::int AS breached,
      (count(*) FILTER (WHERE t.priority='critical'))::int AS critical
      FROM ticket t ${SLA_JOIN_SQL}
      WHERE ${clauses.join(' AND ')}`,
    params,
  };
}
