import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';

/** Ticket-owned read interface for the existing administrator directory and stop warning. */
export class TicketAssignmentReadService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  async countOpenByAssignees(
    ctx: AuthzContext,
    userIds: readonly string[],
  ): Promise<Map<string, number>> {
    requireRole(ctx, 'org_admin', 'platform_admin');
    const ids = [...new Set(userIds.map((id) => id.toLowerCase()))];
    if (ids.length === 0) return new Map();

    // The caller owns the transaction. Do not reconnect or narrow target membership/status:
    // stopped users and users with an expired membership can still have assigned work.
    const { rows } = await this.client.query<{ assignee_id: string; open_tickets: number }>(
      `SELECT assignee_id, count(*)::int AS open_tickets
         FROM ticket
        WHERE organization_id = $1 AND assignee_id = ANY($2::uuid[])
          AND state NOT IN ('resolved', 'closed', 'cancelled', 'merged')
        GROUP BY assignee_id`,
      [ctx.organizationId, ids],
    );
    const requested = new Set(ids);
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (
        !row ||
        typeof row.assignee_id !== 'string' ||
        !requested.has(row.assignee_id) ||
        counts.has(row.assignee_id) ||
        !Number.isSafeInteger(row.open_tickets) ||
        row.open_tickets < 0
      ) {
        throw Problems.internal();
      }
      counts.set(row.assignee_id, row.open_tickets);
    }
    // Preserve each caller's UUID spelling; PostgreSQL returns canonical lowercase UUIDs.
    return new Map(userIds.map((id) => [id, counts.get(id.toLowerCase()) ?? 0]));
  }
}
