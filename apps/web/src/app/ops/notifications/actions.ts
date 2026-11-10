'use server';

import { api } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import { navigationRoles } from '../../../lib/navigation';
import {
  retryFailure,
  retryTarget,
  retryVersion,
  type NotificationRetryState,
} from '../../../lib/notification-retry';

/** Target and scope are bound by the rendered row; neither is a client form input. */
export async function notificationRetryAction(
  notificationId: string,
  scope: string,
  previous: NotificationRetryState,
  form: FormData,
): Promise<NotificationRetryState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const fail = (status: number): NotificationRetryState => ({
    message: retryFailure(status),
    attempt,
    mustCheck: true,
  });
  const intent = form.getAll('intent');
  if (
    !retryTarget(notificationId) ||
    intent.length !== 1 ||
    !['check', 'reserve'].includes(String(intent[0]))
  )
    return fail(400);
  const reserve = intent[0] === 'reserve';
  const versions = form.getAll('version');
  if (reserve && (versions.length !== 1 || !retryVersion(versions[0]))) return fail(400);
  try {
    const session = await api.me();
    if (!session.ok) return fail(session.problem.status);
    if (!session.data.organizationId || formScope(session.data) !== scope)
      return {
        ...fail(409),
        message: '利用者または組織が変更されています。一覧を開き直してください。',
        scopeChanged: true,
      };
    if (!navigationRoles(session.data).notifications) return fail(403);
    if (!reserve) {
      const result = await api.notificationRetry(notificationId);
      return result.ok ? { message: '', data: result.data, attempt } : fail(result.problem.status);
    }
    const result = await api.reserveNotificationRetry(notificationId, String(versions[0]), scope);
    if (result.ok) return { message: '', data: result.data, attempt };
    if (result.problem.status === 409 || result.problem.status >= 500) {
      // A lost response can follow a committed reservation. Re-read; never repeat POST.
      const current = await api.me();
      if (!current.ok) return fail(current.problem.status);
      if (formScope(current.data) !== scope) return { ...fail(409), scopeChanged: true };
      const refreshed = await api.notificationRetry(notificationId);
      if (refreshed.ok)
        return {
          message:
            refreshed.data.state === 'not_requested' ? retryFailure(result.problem.status) : '',
          data: refreshed.data,
          mustCheck: refreshed.data.state === 'not_requested',
          attempt,
        };
      return fail(refreshed.problem.status);
    }
    return fail(result.problem.status);
  } catch {
    return fail(503);
  }
}
