import type pg from 'pg';
import { z } from 'zod';
import { Problems, ProblemError } from '@solvi/shared';
import type { DenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  NotificationPreferenceService,
  requireNotificationPreferenceAccess,
} from './notification-preference.service.js';
export type { NotificationPreference } from './notification-preference.service.js';

type Headers = Record<string, string | string[] | undefined>;
const bodySchema = z.object({ ticketEmailEnabled: z.boolean() }).strict();
const invalid = () =>
  Problems.validation([{ field: 'ticketEmailEnabled', message: '通知設定を確認してください' }]);

function headerValues(headers: Headers, name: string): (string | string[])[] {
  return Object.entries(headers)
    .filter(([key, value]) => key.toLowerCase() === name && value !== undefined)
    .map(([, value]) => value!);
}
export function validateNotificationPreferenceWrite(
  auth: AuthenticatedRequest,
  headers: Headers,
  body: unknown,
): boolean {
  if (headerValues(headers, 'origin').length)
    throw Problems.forbidden('この送信方法では保存できません');
  const contentType = headerValues(headers, 'content-type');
  if (
    contentType.length !== 1 ||
    typeof contentType[0] !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0])
  )
    throw invalid();
  const scope = headerValues(headers, 'x-solvi-form-scope');
  if (scope.length !== 1 || scope[0] !== `${auth.authz.organizationId}:${auth.userId}`)
    throw Problems.conflict('利用者または組織が変更されています。設定画面を開き直してください。');
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw invalid();
  return parsed.data.ticketEmailEnabled;
}

export class NotificationPreferenceController {
  constructor(private readonly deps: { pool: pg.Pool; denialRecorder?: DenialRecorder }) {}

  private async run(auth: AuthenticatedRequest, query: URLSearchParams, enabled?: boolean) {
    let client: pg.PoolClient | undefined;
    try {
      requireNotificationPreferenceAccess(auth.authz);
      if (auth.userId !== auth.authz.principal.userId)
        throw Problems.forbidden('必要な権限がありません');
      if (query.size !== 0) throw invalid();
      client = await this.deps.pool.connect();
      await client.query(enabled === undefined ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query(
        "SELECT set_config('app.current_org',$1,true),set_config('app.current_actor',$2,true)",
        [auth.authz.organizationId, auth.userId],
      );
      const service = new NotificationPreferenceService(client);
      const body =
        enabled === undefined
          ? await service.get(auth.authz)
          : await service.update(auth.authz, enabled);
      await client.query('COMMIT');
      return { status: 200 as const, body };
    } catch (error) {
      if (client) {
        const failedClient = client;
        client = undefined;
        let broken = false;
        await failedClient.query('ROLLBACK').catch(() => {
          broken = true;
        });
        // Denial recording opens its own connection, including when pool.max=1.
        failedClient.release(broken);
      }
      if (error instanceof ProblemError && error.status === 403 && auth.authz.organizationId) {
        await this.deps.denialRecorder
          ?.record(auth.authz.organizationId, {
            eventType: 'authz.access.denied',
            organizationId: auth.authz.organizationId,
            actorType: 'user',
            actorId: auth.authz.principal.userId,
            targetType: 'notification_preference',
            action: enabled === undefined ? 'read' : 'update',
            outcome: 'denied',
            policyDecision: { rule: 'notification_preference_current_membership' },
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      client?.release();
    }
  }

  get(auth: AuthenticatedRequest, query: URLSearchParams) {
    return this.run(auth, query);
  }

  async update(
    auth: AuthenticatedRequest,
    headers: Headers,
    body: unknown,
    query: URLSearchParams,
  ) {
    return this.run(auth, query, validateNotificationPreferenceWrite(auth, headers, body));
  }
}
