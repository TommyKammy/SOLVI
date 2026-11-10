import type pg from 'pg';
import { Problems } from '@solvi/shared';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  requireOverviewAccess,
  validateOverviewGroup,
  type OverviewOptions,
} from './overview-query.js';
import { TicketOverviewService } from './overview.service.js';

/** No arbitrary ticket/user/organization filters may alter the six metric definitions. */
export function parseOverviewQuery(query: URLSearchParams): OverviewOptions {
  if ([...query.keys()].some((key) => key !== 'group')) {
    throw Problems.validation([
      { field: 'query', message: '担当グループ以外の条件は指定できません' },
    ]);
  }
  const groups = query.getAll('group');
  if (groups.length > 1) {
    throw Problems.validation([{ field: 'group', message: '担当グループは1つ指定してください' }]);
  }
  const group = validateOverviewGroup(groups[0]);
  return group ? { group } : {};
}

export class TicketOverviewController {
  constructor(private readonly deps: { pool: pg.Pool }) {}

  async read(auth: AuthenticatedRequest, query: URLSearchParams) {
    requireOverviewAccess(auth.authz);
    const options = parseOverviewQuery(query);
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        "SELECT set_config('app.current_org',$1,true), set_config('app.current_actor',$2,true)",
        [auth.authz.organizationId, auth.authz.principal.userId],
      );
      const result = await new TicketOverviewService(client).read(auth.authz, options);
      await client.query('COMMIT');
      return { status: 200, body: result };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
