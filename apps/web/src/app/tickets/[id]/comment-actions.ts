'use server';
import { revalidatePath } from 'next/cache';
import { formScopeError } from '../../../lib/form-scope';
import { api } from '../../../lib/api';
import type { FormFeedback } from '../../../lib/form-state';

export async function postPublicComment(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const scopeError = await formScopeError(form);
  if (scopeError)
    return {
      message: scopeError,
      scopeChanged: scopeError.includes('利用者または組織'),
      attempt: (previous.attempt ?? 0) + 1,
    };
  const result = await api.addComment(
    id,
    {
      body: String(form.get('body') ?? ''),
      visibility: 'public',
      replyContext: {
        ticketVersion: String(form.get('expectedVersion') ?? ''),
        latestCommentId: String(form.get('latestCommentId') ?? '') || null,
      },
    },
    String(form.get('formScope')),
  );
  if (!result.ok)
    return {
      message: result.problem.type?.endsWith('/stale')
        ? '状態またはやり取りが変わりました。入力は送信していません。「入力を保持して最新の内容を読み込む」で確認し、引き継いでから送信してください。'
        : result.problem.status === 401
          ? 'ログインの期限が切れました。別のタブでログインしてから再送してください。'
          : result.problem.status >= 500
            ? '送信結果を確認できませんでした。最新のやり取りを確認してから再送してください。'
            : (result.problem.detail ?? result.problem.title),
      scopeChanged: (result.problem.detail ?? '').includes('利用者または組織'),
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath(`/tickets/${id}`);
  revalidatePath(`/ops/${id}`);
  return {
    message: '',
    success: '追加内容を送信しました。',
    postedCommentId: result.data.id,
    postedVisibility: 'public',
    attempt: (previous.attempt ?? 0) + 1,
  };
}
