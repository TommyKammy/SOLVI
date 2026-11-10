import type pg from 'pg';
import { z } from 'zod';
import { Problems, ProblemError } from '@solvi/shared';
import type { DenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import { OperationSessionService } from '../auth/operation-session.service.js';
import { requireNotificationListAccess } from './notification-list.service.js';
import {
  NotificationRetryService,
  NOTIFICATION_RETRY_VERSION_PATTERN,
} from './notification-retry.service.js';
import type { OperationSessionValidator } from './types.js';
export type { NotificationRetryStatus } from './types.js';

type Headers = Record<string, string | string[] | undefined>;
const bodySchema = z
  .object({ version: z.string().regex(NOTIFICATION_RETRY_VERSION_PATTERN) })
  .strict();
const invalid = () =>
  Problems.validation([{ field: 'retry', message: '通知の再試行条件を確認してください' }]);
function values(headers: Headers, name: string): (string | string[])[] {
  return Object.entries(headers)
    .filter(([key, value]) => key.toLowerCase() === name && value !== undefined)
    .map(([, value]) => value!);
}
export function validateNotificationRetryRequest(
  auth: AuthenticatedRequest,
  headers: Headers,
  body: unknown,
): string {
  if (values(headers, 'origin').length) throw Problems.forbidden('この送信方法では予約できません');
  const content = values(headers, 'content-type');
  if (
    content.length !== 1 ||
    typeof content[0] !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(content[0])
  )
    throw invalid();
  const scope = values(headers, 'x-solvi-form-scope');
  if (scope.length !== 1 || scope[0] !== `${auth.authz.organizationId}:${auth.userId}`)
    throw Problems.conflict('利用者または組織が変更されています。画面を開き直してください');
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw invalid();
  return parsed.data.version;
}

export class NotificationRetryController {
  constructor(
    private readonly deps: {
      pool: pg.Pool;
      denialRecorder?: DenialRecorder;
      operationSessions?: (client: pg.PoolClient) => OperationSessionValidator;
    },
  ) {}

  private async run(
    auth: AuthenticatedRequest,
    notificationId: string,
    query: URLSearchParams,
    write?: { headers: Headers; body: unknown },
  ) {
    let client: pg.PoolClient | undefined;
    try {
      requireNotificationListAccess(auth.authz);
      if (auth.userId !== auth.authz.principal.userId)
        throw Problems.forbidden('必要な権限がありません');
      if (query.size) throw invalid();
      const version = write
        ? validateNotificationRetryRequest(auth, write.headers, write.body)
        : undefined;
      client = await this.deps.pool.connect();
      await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY');
      await client.query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.current_actor',$2,true)",
        [auth.authz.organizationId, auth.userId],
      );
      const operationSessions =
        this.deps.operationSessions?.(client) ?? new OperationSessionService(client);
      if (
        !(
          await operationSessions.validate({
            sessionId: auth.sessionId,
            userId: auth.userId,
            organizationId: auth.authz.organizationId,
          })
        ).valid
      )
        throw Problems.forbidden('必要な権限がありません');
      const service = new NotificationRetryService(client, { operationSessions });
      const body =
        version === undefined
          ? await service.get(auth.authz, notificationId)
          : await service.request(auth.authz, {
              notificationId,
              sessionId: auth.sessionId,
              version,
            });
      await client.query('COMMIT');
      return { status: 200 as const, body };
    } catch (error) {
      if (client) {
        const failed = client;
        client = undefined;
        let broken = false;
        await failed.query('ROLLBACK').catch(() => {
          broken = true;
        });
        failed.release(broken);
      }
      if (error instanceof ProblemError && error.status === 403 && auth.authz.organizationId) {
        await this.deps.denialRecorder
          ?.record(auth.authz.organizationId, {
            eventType: 'authz.access.denied',
            organizationId: auth.authz.organizationId,
            actorType: 'user',
            actorId: auth.authz.principal.userId,
            targetType: 'notification',
            action: write ? 'notification.retry.request' : 'notification.retry.read',
            outcome: 'denied',
            policyDecision: { rule: 'notification_retry_current_org_admin' },
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      client?.release();
    }
  }
  get(auth: AuthenticatedRequest, id: string, query: URLSearchParams) {
    return this.run(auth, id, query);
  }
  request(
    auth: AuthenticatedRequest,
    id: string,
    headers: Headers,
    body: unknown,
    query: URLSearchParams,
  ) {
    return this.run(auth, id, query, { headers, body });
  }
}
