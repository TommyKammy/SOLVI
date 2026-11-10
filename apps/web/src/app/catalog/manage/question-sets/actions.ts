'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, type CatalogQuestionSet } from '../../../../lib/api';
import type { FormFeedback } from '../../../../lib/form-state';
import { withReturnTo } from '../../../../lib/navigation';

export async function saveQuestionSet(
  id: string | null,
  previous: FormFeedback,
  form: FormData,
): Promise<FormFeedback> {
  const fail = (message: string, field?: string): FormFeedback => ({
    message,
    attempt: (previous.attempt ?? 0) + 1,
    ...(field ? { errors: [{ field, message }] } : {}),
  });
  const source = String(form.get('source') ?? '');
  let fields: CatalogQuestionSet['fields'], sections: CatalogQuestionSet['sections'];
  if (source) {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|([1-9]\d*)$/i.exec(source);
    if (!match) return fail('質問の元サービスを選び直してください。', 'source');
    const read = await api.catalogManagementDetail(match[1]!);
    if (!read.ok)
      return fail('元サービスを取得できませんでした。権限と接続を確認してください。', 'source');
    if (read.data.draft.revision !== Number(match[2]))
      return fail(
        '元サービスが更新されました。画面を再読込して最新の下書きを選んでください。',
        'source',
      );
    fields = read.data.draft.definition.fields ?? [];
    sections = read.data.draft.definition.sections ?? [];
  } else if (id) {
    const read = await api.catalogQuestionSets();
    if (!read.ok) return fail('共有項目セットを取得できませんでした。再度お試しください。');
    const current = read.data.items.find((item) => item.id === id);
    if (!current || current.revision !== Number(form.get('expectedVersion')))
      return fail('共有項目セットが更新されています。最新の版を確認してください。');
    fields = current.fields;
    sections = current.sections;
  } else return fail('保存済みの元サービスを選んでください。', 'source');
  const result = await api.saveCatalogQuestionSet(id, {
    title: String(form.get('title') ?? ''),
    description: String(form.get('description') ?? ''),
    fields,
    ...(sections ? { sections } : {}),
    ...(id
      ? { expectedVersion: Number(form.get('expectedVersion')) }
      : { creationKey: String(form.get('creationKey') ?? '') }),
  });
  if (!result.ok)
    return {
      ...fail(
        result.problem.status >= 500
          ? '保存結果を確認できませんでした。共有項目セットの一覧で保存済みか確認してください。'
          : (result.problem.detail ?? result.problem.errors?.[0]?.message ?? result.problem.title),
      ),
      errors: result.problem.errors,
    };
  revalidatePath('/catalog/manage/question-sets');
  revalidatePath('/catalog/manage');
  redirect(
    withReturnTo(
      `/catalog/manage/question-sets?saved=1#set-${encodeURIComponent(result.data.id)}`,
      form.get('returnTo'),
    ),
  );
}
