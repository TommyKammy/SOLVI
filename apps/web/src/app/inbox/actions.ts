'use server';
import { redirect } from 'next/navigation';
import { ticketReturnTo, withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import type { FormFeedback } from '../../lib/form-state';
export async function openInboxItem(previous: FormFeedback, form: FormData): Promise<FormFeedback> {
  const kind = String(form.get('kind') ?? '');
  const id = String(form.get('id') ?? '');
  const r = await api.readInbox({
    kind,
    id,
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
  const from = form.get('returnTo');
  redirect(withReturnTo(r.data.href, kind === 'ticket' ? ticketReturnTo(from, id) : from));
}
