import type pg from 'pg';
import { Problems } from '@solvi/shared';
import type { DenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  NotificationListService,
  parseNotificationListQuery,
  requireNotificationListAccess,
} from './notification-list.service.js';
export type { NotificationListResponse } from './notification-list.service.js';

export interface NotificationRouteDeps {
  pool: pg.Pool;
  denialRecorder?: DenialRecorder;
}

export class NotificationListController {
  constructor(private readonly deps: NotificationRouteDeps) {}

  async list(auth: AuthenticatedRequest, query: URLSearchParams) {
    try {
      requireNotificationListAccess(auth.authz);
      if (auth.userId !== auth.authz.principal.userId)
        throw Problems.forbidden('必要な権限がありません');
    } catch (error) {
      if (auth.authz.organizationId) {
        await this.deps.denialRecorder
          ?.record(auth.authz.organizationId, {
            eventType: 'authz.access.denied',
            organizationId: auth.authz.organizationId,
            actorType: 'user',
            actorId: auth.authz.principal.userId,
            targetType: 'notification',
            action: 'list',
            outcome: 'denied',
            policyDecision: { rule: 'notification_selected_org_admin' },
          })
          .catch(() => undefined);
      }
      throw error;
    }
    const options = parseNotificationListQuery(query, auth.authz);
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.current_actor',$2,true)",
        [auth.authz.organizationId, auth.userId],
      );
      const body = await new NotificationListService(client).list(auth.authz, options);
      await client.query('COMMIT');
      return { status: 200 as const, body };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
