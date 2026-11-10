'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import type { FormFeedback } from '../../lib/form-state';
export async function openInboxItem(previous: FormFeedback, form: FormData): Promise<FormFeedback> {
  const r = await api.readInbox({
    kind: String(form.get('kind') ?? ''),
    id: String(form.get('id') ?? ''),
    eventKey: String(form.get('eventKey') ?? ''),
  });
  if (!r.ok)
    return {
      message:
        r.problem.status === 404
          ? 'この業務は処理済み、または担当・承認者が変わりました。受信箱を更新してください。'
          : (r.problem.detail ?? r.problem.title),
      errors: r.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/inbox');
  redirect(withReturnTo(r.data.href, form.get('returnTo')));
}
