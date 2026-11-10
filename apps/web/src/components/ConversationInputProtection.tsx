'use client';
import { FormDraftRecovery } from './FormDraftRecovery';
import type { DraftValues } from '../lib/form-draft';
import type { ReplyContext } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { conversationVersion } from '../lib/use-conversation-input';

export function ConversationInputProtection({
  scope,
  formKey,
  visibility,
  current,
  draft,
  changed,
  pending,
  feedback,
  restore,
  reload,
  acknowledge,
}: {
  scope: string;
  formKey: string;
  visibility: 'public' | 'internal';
  current: ReplyContext;
  draft: { body: string; citation: string; context: ReplyContext };
  changed: boolean;
  pending: boolean;
  feedback: FormFeedback;
  restore: (values: DraftValues) => void;
  reload: () => void;
  acknowledge: () => void;
}) {
  const internal = visibility === 'internal';
  return (
    <>
      <input type="hidden" name="expectedVersion" value={draft.context.ticketVersion} />
      <input type="hidden" name="latestCommentId" value={draft.context.latestCommentId ?? ''} />
      {feedback.success && <p role="status">{feedback.success}</p>}
      <fieldset disabled={pending}>
        <FormDraftRecovery
          key={`${visibility}:${feedback.postedVisibility === visibility ? (feedback.postedCommentId ?? '') : ''}`}
          scope={scope}
          formKey={`${formKey}:${visibility}`}
          version={conversationVersion(current)}
          baseline={{ body: '', citation: '' }}
          values={{ body: draft.body, citation: draft.citation }}
          labels={{ body: internal ? '内部メモ本文' : '公開返信本文', citation: '引用記事の選択' }}
          onRestore={restore}
          conservativeRestore
          copy={{
            title: internal ? 'このタブの内部メモ下書き' : 'このタブの公開返信下書き',
            notice:
              '保存した本文と現在の入力を比較して、復元する項目を選んでください。古い版や入力済みの項目は初期選択しません。復元しても送信しません。',
            restored:
              '選んだ入力を復元しました。最新のやり取りと公開範囲を確認してから送信してください。',
          }}
        />
        <p className="hint">
          再読込前に必要なモードの入力を一時保存してください。公開と内部は別保存です。送信成功で、送ったモードの下書きだけを消去します。
        </p>
        <button type="button" className="secondary" onClick={reload}>
          入力を保持して最新の内容を読み込む
        </button>
        {changed && (
          <div className="notice">
            <p role="alert">
              入力中に状態またはやり取りが変わりました。本文は保持しています。上の最新のやり取りを確認し、入力を引き継いでから送信してください。
            </p>
            <button type="button" onClick={acknowledge}>
              最新のやり取りを確認して入力を引き継ぐ
            </button>
          </div>
        )}
      </fieldset>
    </>
  );
}
