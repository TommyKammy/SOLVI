'use server';
import { redirect } from 'next/navigation';
import { withReturnTo } from '../../../lib/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../../lib/api';
import type { FormFeedback } from '../../../lib/form-state';
export async function saveCatalog(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  let fields: unknown;
  try {
    fields = JSON.parse(String(form.get('fields') ?? '[]'));
  } catch {
    return { message: '項目の形式を確認してください' };
  }
  const content = {
    title: String(form.get('title') ?? ''),
    description: String(form.get('description') ?? ''),
    definition: {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: String(form.get('targetLabel') ?? ''),
      allowedDurations: String(form.get('allowedDurations') ?? '')
        .split(',')
        .map((s) => Number(s.trim())),
      maxReasonLength: Number(form.get('maxReasonLength')),
      approval: { mode: 'fixed', approverId: String(form.get('approverId') ?? '') },
      fields,
    },
  };
  const r = await api.saveCatalogItem(id, {
    ...content,
    ...(id
      ? { expectedVersion: Number(form.get('expectedVersion')) }
      : {
          code: String(form.get('code') ?? ''),
          creationKey: String(form.get('creationKey') ?? ''),
        }),
  });
  if (!r.ok)
    return {
      message: r.problem.errors?.[0]?.message ?? r.problem.detail ?? r.problem.title,
      errors:
        r.problem.errors?.map((e) => ({
          ...e,
          message:
            e.message === 'Invalid input' && e.field === 'definition.allowedDurations'
              ? '日数の候補を重複しない値で入力してください。'
              : e.message === 'Invalid input' && e.field === 'definition.fields'
                ? '追加項目の保存キーは重複しない値に変更してください。'
                : e.message,
        })) ??
        (r.problem.detail?.includes('コードは既に')
          ? [
              {
                field: 'code',
                message: 'この管理コードは使われています。別のコードに変更してください。',
              },
            ]
          : undefined),
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/catalog/manage');
  redirect(withReturnTo(`/catalog/manage/${r.data.id}?saved=1#preview`, form.get('returnTo')));
}
export async function publishCatalog(
  id: string,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const r = await api.publishCatalogItem(id, {
    expectedVersion: Number(form.get('expectedVersion')),
    state: String(form.get('state')),
  });
  if (!r.ok)
    return {
      message: r.problem.errors?.[0]?.message ?? r.problem.detail ?? r.problem.title,
      errors: r.problem.errors,
      attempt: (previous.attempt ?? 0) + 1,
    };
  revalidatePath('/catalog');
  revalidatePath('/catalog/manage');
  redirect(withReturnTo(`/catalog/manage/${id}?saved=1`, form.get('returnTo')));
}
