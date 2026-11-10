import type pg from 'pg';
import { Problems } from '@solvi/shared';
import type { AuthzContext } from '../../common/authz/authz.js';
import {
  buildTicketOverviewQuery,
  TICKET_OVERVIEW_METRICS,
  type OverviewOptions,
  type TicketOverviewCounts,
} from './overview-query.js';

export interface TicketOverview {
  scope: 'organization';
  counts: TicketOverviewCounts;
}

export class TicketOverviewService {
  constructor(private readonly client: pg.PoolClient | pg.Client) {}

  async read(ctx: AuthzContext, options: OverviewOptions = {}): Promise<TicketOverview> {
    const query = buildTicketOverviewQuery(ctx, options);
    const { rows } = await this.client.query<TicketOverviewCounts>(query.sql, query.params);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !TICKET_OVERVIEW_METRICS.every((key) => Number.isSafeInteger(row[key]) && row[key] >= 0)
    ) {
      // A missing or malformed result is a failed read, never six fabricated zeroes.
      throw Problems.internal();
    }
    const counts = Object.fromEntries(
      TICKET_OVERVIEW_METRICS.map((key) => [key, row[key]]),
    ) as TicketOverviewCounts;
    return { scope: 'organization', counts };
  }
}
