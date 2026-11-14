'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import { formScopeError } from '../../lib/form-scope';
import type { FormFeedback } from '../../lib/form-state';
import { readCatalogFormValues } from '../../lib/catalog-form';
export async function saveServiceRequest(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const scopeError = await formScopeError(form);
  if (scopeError) return { message: scopeError, attempt: (previous.attempt ?? 0) + 1 };
  const approverId = form.get('approverId');
  const values = {
    ...(form.has('reason') ? { reason: String(form.get('reason') ?? '') } : {}),
    ...(form.has('durationDays') ? { durationDays: String(form.get('durationDays') ?? '') } : {}),
    // ルールで経路が決まる項目では承認者を送らない(WP-P4-APR-016 §6.1)。
    ...(typeof approverId === 'string' && approverId.length > 0 ? { approverId } : {}),
  };
  const customValues = readCatalogFormValues(form);
  const input = {
    ...values,
    ...(values.durationDays !== undefined ? { durationDays: Number(values.durationDays) } : {}),
    values: customValues,
  };
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

/** Progress has its own version; revalidation preserves the revision-keyed request editor. */
export async function updateCatalogChecklist(
  id: string,
  requestRevision: number,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const key = String(form.get('key') ?? '');
  const completed = String(form.get('completed:' + key) ?? form.get('completed') ?? '');
  if (!key || !['true', 'false'].includes(completed))
    return { message: '更新する作業を選び直してください。', attempt: (previous.attempt ?? 0) + 1 };
  const result = await api.updateRequestChecklist(id, {
    requestRevision,
    expectedVersion: Number(form.get('expectedVersion')),
    key,
    completed: completed === 'true',
  });
  if (!result.ok)
    return {
      message: result.problem.errors?.[0]?.message ?? result.problem.detail ?? result.problem.title,
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath(`/requests/${id}`);
  return {
    message: '',
    success: '作業チェックを更新しました。',
    attempt: (previous.attempt ?? 0) + 1,
  };
}
