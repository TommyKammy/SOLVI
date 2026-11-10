'use client';
import { useActionState, useState } from 'react';
import { FeedbackForm, FormField } from './FeedbackForm';
import type { FormFeedback } from '../lib/form-state';
/**
 * 関連付けの追加 (WP-P2-RELUI-012)。
 *
 * **受付番号で指定する。** 担当者が画面で見ているのは番号であり、
 * UUID ではない。UUID を写させると写し間違いが起きるうえ、
 * 間違えたことにも気付けない(どちらも意味を読めない文字列だから)。
 */
export function RelationForm({
  action,
  errorMessage,
}: {
  action: (previous: FormFeedback, formData: FormData) => Promise<FormFeedback>;
  errorMessage?: string;
}) {
  const [feedback, dispatch, pending] = useActionState(action, { message: '' } as FormFeedback);
  const [number, setNumber] = useState('');
  const [relation, setRelation] = useState('related');
  return (
    <FeedbackForm action={dispatch} feedback={feedback} pending={pending} className="stack">
      {errorMessage && (
        <div className="error-summary" role="alert" tabIndex={-1}>
          <h3 style={{ margin: '0 0 0.5rem' }}>関連付けできませんでした</h3>
          <p style={{ margin: 0 }}>{errorMessage}</p>
        </div>
      )}

      <FormField>
        <label htmlFor="relation-number">相手の受付番号</label>
        <span className="hint" id="relation-number-hint">
          例: INC-2026-000012
        </span>
        <input
          id="relation-number"
          name="targetTicketNumber"
          type="text"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          required
          maxLength={64}
          aria-describedby="relation-number-hint"
          autoComplete="off"
        />
      </FormField>

      <FormField>
        <label htmlFor="relation-type">関係</label>
        {/*
          既定は「関連」。親子は「まとめる」という判断を含み、
          誤って作ると子の一覧に別件が並ぶ。危険でないほうを既定にする。
        */}
        <select
          id="relation-type"
          name="relationType"
          value={relation}
          onChange={(e) => setRelation(e.target.value)}
        >
          <option value="related">関連する問い合わせとして並べる</option>
          <option value="parent_of">この問い合わせの子にする(まとめる)</option>
        </select>
        <span className="hint">
          子にできるのは1段までです。子をさらに別の親にまとめることはできません。
        </span>
      </FormField>

      <button disabled={pending} type="submit">
        関連付ける
      </button>
    </FeedbackForm>
  );
}
