'use server';

import { revalidatePath } from 'next/cache';
import { formScopeError } from '../../../lib/form-scope';
import { api } from '../../../lib/api';
import type { FormFeedback } from '../../../lib/form-state';

export async function sendReply(
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
  const scope = String(form.get('formScope'));
  const replyContext = {
    ticketVersion: String(form.get('expectedVersion') ?? ''),
    latestCommentId: String(form.get('latestCommentId') ?? '') || null,
  };
  const body = String(form.get('body') ?? '');
  const visibility = String(form.get('visibility') ?? 'public');
  const selected = String(form.get('citation') ?? '');
  const [articleId, articleVersion] = selected.split(':');
  const citation = selected
    ? { articleId: articleId ?? '', version: Number(articleVersion) }
    : undefined;
  const result =
    form.get('outcome') === 'resolve'
      ? await api.resolveWithReply(
          id,
          {
            body,
            visibility,
            replyContext,
            ...(citation ? { citation } : {}),
            expectedVersion: String(form.get('expectedVersion') ?? ''),
          },
          scope,
        )
      : await api.addComment(
          id,
          { body, visibility, replyContext, ...(citation ? { citation } : {}) },
          scope,
        );
  if (!result.ok) {
    return {
      scopeChanged: (result.problem.detail ?? '').includes('利用者または組織'),
      errors: result.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
      message: result.problem.type?.endsWith('/stale')
        ? '状態またはやり取りが変わりました。返信は保存していません。「入力を保持して最新の内容を読み込む」でやり取りを確認し、入力を引き継いでから送信してください。'
        : result.problem.status === 401
          ? 'ログインの期限が切れました。別のタブでログインしてから再度送信してください。'
          : result.problem.status >= 500
            ? '送信結果を確認できませんでした。別のタブで最新のやり取りを確認してから再度操作してください。'
            : (result.problem.errors?.[0]?.message ??
              result.problem.detail ??
              result.problem.title),
    };
  }
  revalidatePath(`/ops/${id}`);
  revalidatePath(`/tickets/${id}`);
  const comment = 'comment' in result.data ? result.data.comment : result.data;
  return {
    message: '',
    success: visibility === 'internal' ? '内部メモを保存しました。' : '返信を保存しました。',
    postedCommentId: comment.id,
    postedVisibility: visibility === 'internal' ? 'internal' : 'public',
    attempt: (previous.attempt ?? 0) + 1,
  };
}
