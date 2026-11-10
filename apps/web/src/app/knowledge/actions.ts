'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import type { FormFeedback } from '../../lib/form-state';

export async function saveArticle(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const content = {
    title: String(form.get('title') ?? ''),
    body: String(form.get('body') ?? ''),
    tags: String(form.get('tags') ?? ''),
    audience: String(form.get('audience') ?? 'organization'),
  };
  const result = id
    ? await api.knowledgeSave(id, {
        ...content,
        expectedVersion: Number(form.get('expectedVersion')),
      })
    : await api.knowledgeCreate(content);
  if (!result.ok)
    return {
      message:
        result.problem.status === 409
          ? 'ほかの操作で記事が更新されました。入力をコピーして最新の内容を確認してください。'
          : (result.problem.detail ?? result.problem.title),
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
      values: content,
    };
  revalidatePath('/knowledge');
  redirect(withReturnTo(`/knowledge/${result.data.id}?manage=1&saved=1`, form.get('returnTo')));
}
export async function changeArticle(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const result = await api.knowledgeAction(id, {
    action: String(form.get('action')),
    expectedVersion: Number(form.get('expectedVersion')),
    ...(form.get('restoreVersion') ? { restoreVersion: Number(form.get('restoreVersion')) } : {}),
  });
  if (!result.ok)
    return {
      message: result.problem.detail ?? result.problem.title,
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/knowledge');
  revalidatePath(`/knowledge/${id}`);
  redirect(withReturnTo(`/knowledge/${id}?manage=1&saved=1`, form.get('returnTo')));
}
