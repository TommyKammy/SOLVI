'use client';
import { useActionState, useEffect, useId, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import { saveQuestionSet } from '../app/catalog/manage/question-sets/actions';
import type { CatalogAdminSummary, CatalogQuestionSet } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';

export function CatalogQuestionSetForm({
  item,
  sources,
}: {
  item?: CatalogQuestionSet;
  sources: CatalogAdminSummary[];
}) {
  const [feedback, action, pending] = useActionState(saveQuestionSet.bind(null, item?.id ?? null), {
    message: '',
  } as FormFeedback);
  const [creationKey, setCreationKey] = useState('');
  useEffect(() => setCreationKey(crypto.randomUUID()), []);
  const id = 'question-set-' + useId().replaceAll(':', '');
  return (
    <FeedbackForm
      feedback={feedback}
      action={action}
      pending={pending}
      className="stack form-panel"
      aria-label={item ? `共有項目セット「${item.title}」を更新する` : '共有項目セットを作成する'}
    >
      <input type="hidden" name="creationKey" value={creationKey} />
      <input type="hidden" name="expectedVersion" value={item?.revision ?? 0} />
      <fieldset disabled={pending} className="stack">
        <legend>{item ? 'セットの更新' : '新しいセット'}</legend>
        <FormField className="field">
          <label htmlFor={`${id}-title`}>セット名</label>
          <input
            id={`${id}-title`}
            name="title"
            defaultValue={item?.title ?? ''}
            maxLength={200}
            required
          />
        </FormField>
        <FormField className="field">
          <label htmlFor={`${id}-description`}>セットの説明</label>
          <textarea
            id={`${id}-description`}
            name="description"
            defaultValue={item?.description ?? ''}
            maxLength={2000}
          />
        </FormField>
        <FormField className="field">
          <label htmlFor={`${id}-source`}>
            {item ? '質問を置き換える元サービス' : '質問の元サービス'}
          </label>
          <select id={`${id}-source`} name="source" defaultValue="" required={!item}>
            <option value="">{item ? '質問は変更しない' : '保存済みの下書きを選ぶ'}</option>
            {sources.map((source) => (
              <option key={source.id} value={`${source.id}|${source.draftRevision}`}>
                {source.title}（下書き版{source.draftRevision}）
              </option>
            ))}
          </select>
          <p className="hint">
            保存した質問とセクションをコピーします。承認者・責任者・担当グループは共有しません。
          </p>
        </FormField>
        <button disabled={pending || (!item && (!creationKey || !sources.length))}>
          {pending
            ? '保存しています…'
            : item
              ? '新しい版として保存する'
              : '共有項目セットを作成する'}
        </button>
      </fieldset>
    </FeedbackForm>
  );
}
