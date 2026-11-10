'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, type ProblemDetails } from '../../../lib/api';
import type { FormFeedback } from '../../../lib/form-state';
import { withReturnTo } from '../../../lib/navigation';

function failure(previous: FormFeedback, problem: ProblemDetails): FormFeedback {
  return {
    attempt: (previous.attempt ?? 0) + 1,
    errors: problem.errors?.map((e) => ({
      ...e,
      field: e.field === 'targetTicketId' ? 'targetTicketNumber' : e.field,
    })),
    message: problem.type?.endsWith('/stale')
      ? '他の人が問い合わせを変更しました。保存していません。入力を控え、最新の状態を確認してから開き直してください。'
      : problem.status === 401
        ? 'ログインの期限が切れました。別のタブでログインしてから再度送信してください。'
        : problem.status >= 500
          ? '送信結果を確認できませんでした。最新の状態で保存済みか確認してください。'
          : (problem.detail ?? problem.title),
  };
}
function saved(id: string, form: FormData): never {
  revalidatePath(`/ops/${id}`);
  revalidatePath(`/tickets/${id}`);
  redirect(withReturnTo(`/ops/${id}?updated=1`, form.get('returnTo')));
}
export async function routeToGroup(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const result = await api.assignGroup(
    id,
    String(form.get('groupId') ?? '') || null,
    String(form.get('expectedVersion') ?? ''),
  );
  if (!result.ok) return failure(previous, result.problem);
  saved(id, form);
}
export async function reassess(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const result = await api.reassess(id, {
    impact: String(form.get('impact') ?? ''),
    urgency: String(form.get('urgency') ?? ''),
    reason: String(form.get('reason') ?? ''),
    expectedVersion: String(form.get('expectedVersion') ?? ''),
  });
  if (!result.ok) return failure(previous, result.problem);
  saved(id, form);
}
export async function addRelation(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const result = await api.linkTicket(id, {
    relationType: String(form.get('relationType') ?? 'related'),
    targetTicketNumber: String(form.get('targetTicketNumber') ?? ''),
  });
  if (!result.ok) return failure(previous, result.problem);
  saved(id, form);
}
