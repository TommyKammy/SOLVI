'use server';

import { api } from '../../../lib/api';
import { formScope } from '../../../lib/form-scope';
import {
  preferenceFailure,
  type NotificationPreferenceState,
} from '../../../lib/notification-preference';

/** The rendered scope is an expectation, never authorization or a writable target. */
export async function saveNotificationPreference(
  scope: string,
  previous: NotificationPreferenceState,
  form: FormData,
): Promise<NotificationPreferenceState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const values = form.getAll('ticketEmailEnabled');
  if (values.length !== 1 || !['true', 'false'].includes(String(values[0])))
    return { message: preferenceFailure(400), attempt };
  try {
    const session = await api.me();
    if (!session.ok) return { message: preferenceFailure(session.problem.status), attempt };
    if (!session.data.organizationId || formScope(session.data) !== scope)
      return { message: preferenceFailure(409), scopeChanged: true, attempt };
    const result = await api.saveNotificationPreference(values[0] === 'true', scope);
    if (!result.ok)
      return {
        message: preferenceFailure(result.problem.status),
        scopeChanged: result.problem.status === 409,
        attempt,
      };
    if (result.data.ticketEmailEnabled !== (values[0] === 'true'))
      return { message: preferenceFailure(503), attempt };
    return { message: '', saved: result.data.ticketEmailEnabled, attempt };
  } catch {
    return { message: preferenceFailure(503), attempt };
  }
}
