'use server';

import { withReturnTo } from '../../../lib/navigation';
import { api } from '../../../lib/api';
import { formScopeError } from '../../../lib/form-scope';
import type { FormFeedback } from '../../../lib/form-state';

export async function createTicket(previous: FormFeedback, form: FormData): Promise<FormFeedback> {
  const scopeError = await formScopeError(form);
  if (scopeError) return { message: scopeError, attempt: (previous.attempt ?? 0) + 1 };
  const result = await api.createTicket(
    {
      kind: String(form.get('kind') ?? 'request'),
      subject: String(form.get('subject') ?? ''),
      body: String(form.get('body') ?? ''),
      impact: String(form.get('impact') ?? 'medium'),
      urgency: String(form.get('urgency') ?? 'medium'),
    },
    String(form.get('formScope')),
  );
  if (!result.ok) {
    return {
      attempt: (previous.attempt ?? 0) + 1,
      values: {
        impact: String(form.get('impact') ?? 'low'),
        urgency: String(form.get('urgency') ?? 'medium'),
      },
      message:
        result.problem.status === 401
          ? 'ログインの期限が切れました。別のタブでログインしてから再度送信してください。'
          : result.problem.status >= 500
            ? '送信結果を確認できませんでした。ポータルの一覧を確認してから、必要なら再度送信してください。'
            : (result.problem.detail ?? '入力内容を確認してください。'),
      errors: result.problem.errors ?? [],
    };
  }
  return {
    message: '',
    redirectTo: withReturnTo(`/tickets/${result.data.id}?created=1`, form.get('returnTo')),
  };
}
