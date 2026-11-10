'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import { formScopeError } from '../../lib/form-scope';
import type { FormFeedback } from '../../lib/form-state';
export async function saveServiceRequest(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const scopeError = await formScopeError(form);
  if (scopeError) return { message: scopeError, attempt: (previous.attempt ?? 0) + 1 };
  const values = {
    reason: String(form.get('reason') ?? ''),
    durationDays: String(form.get('durationDays') ?? ''),
    approverId: String(form.get('approverId') ?? ''),
  };
  const customValues: Record<string, string | boolean> = {};
  for (const [name, value] of form.entries())
    if (name.startsWith('value:')) customValues[name.slice(6)] = String(value);
  for (const [name] of form.entries())
    if (name.startsWith('checkbox:'))
      customValues[name.slice(9)] = form.get('value:' + name.slice(9)) === 'true';
  const input = { ...values, durationDays: Number(values.durationDays), values: customValues };
  const result = id
    ? await api.editRequest(
        id,
        { ...input, expectedVersion: Number(form.get('expectedVersion')) },
        String(form.get('formScope')),
      )
    : await api.submitRequest(
        {
          ...input,
          itemId: String(form.get('itemId')),
          itemVersion: Number(form.get('itemVersion')),
          idempotencyKey: String(form.get('idempotencyKey')),
        },
        String(form.get('formScope')),
      );
  if (!result.ok)
    return {
      message:
        result.problem.status >= 500
          ? '送信結果を確認できませんでした。申請一覧で保存済みか確認してから、必要な場合だけ再送してください。'
          : (result.problem.errors?.[0]?.message ?? result.problem.detail ?? result.problem.title),
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
      values,
    };
  // Full navigation below fetches current no-store data. Revalidating here would
  // remount the revision-keyed form before its success cleanup can run.
  return {
    message: '',
    redirectTo: withReturnTo(`/requests/${result.data.id}?saved=1`, form.get('returnTo')),
  };
}
export async function processServiceRequest(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const expectedVersion = Number(form.get('expectedVersion'));
  const result =
    form.get('operation') === 'simulate'
      ? await api.simulateRequest(id, { expectedVersion })
      : await api.decideRequest(id, {
          expectedVersion,
          decision: String(form.get('decision')),
          reason: String(form.get('reason') ?? ''),
        });
  if (!result.ok)
    return {
      message: result.problem.errors?.[0]?.message ?? result.problem.detail ?? result.problem.title,
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
  revalidatePath('/ops');
  redirect(withReturnTo(`/requests/${id}?saved=1`, form.get('returnTo')));
}
