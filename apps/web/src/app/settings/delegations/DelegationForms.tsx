'use client';

import { useActionState, useId } from 'react';
import { FeedbackForm, FormField } from '../../../components/FeedbackForm';
import type { ApprovalDelegationCandidate } from '../../../lib/api';
import type { FormFeedback } from '../../../lib/form-state';

type DelegationCreateAction = (previous: FormFeedback, form: FormData) => Promise<FormFeedback>;
type DelegationRevokeAction = (previous: FormFeedback, form: FormData) => Promise<FormFeedback>;

/**
 * 承認の委任の作成フォーム (WP-P4-APR-020 §6.7)。
 *
 * 代理者は候補の一覧から選ぶ。IDの自由入力を作らない。期間は日本時間で入力し、
 * 認可・期間・重なりの検証はAPIが行う。画面はAPIの拒否を項目に結び付けて表示するだけである。
 */
export function DelegationCreateForm({
  action,
  candidates,
  defaultStart,
}: {
  action: DelegationCreateAction;
  candidates: ApprovalDelegationCandidate[];
  defaultStart: string;
}) {
  const [feedback, dispatch, pending] = useActionState(action, {
    message: '',
  } as FormFeedback);
  const id = useId();
  const delegateId = `${id}-delegate`;
  const delegateHintId = `${id}-delegate-hint`;
  const startsId = `${id}-starts`;
  const startsHintId = `${id}-starts-hint`;
  const endsId = `${id}-ends`;
  const endsHintId = `${id}-ends-hint`;
  const confirmId = `${id}-confirm`;
  return (
    <FeedbackForm
      feedback={feedback}
      pending={pending}
      action={dispatch}
      className="directory-form"
    >
      <fieldset className="directory-form-grid">
        <legend className="visually-hidden">承認の委任を作成</legend>
        <FormField name="delegateId">
          <label htmlFor={delegateId}>代理者</label>
          <p className="hint" id={delegateHintId}>
            現在有効な所属で、承認者の役割を持つ人だけを候補にしています。
          </p>
          <select
            id={delegateId}
            name="delegateId"
            required
            defaultValue=""
            aria-describedby={delegateHintId}
            style={{ maxWidth: '100%' }}
          >
            <option value="">選択してください</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </option>
            ))}
          </select>
        </FormField>
        <FormField name="startsAt">
          <label htmlFor={startsId}>開始（日本時間・JST）</label>
          <p className="hint" id={startsHintId}>
            いまから開始できます。開始前の委任として先の日時も指定できます。
          </p>
          <input
            type="datetime-local"
            id={startsId}
            name="startsAt"
            defaultValue={defaultStart}
            required
            aria-describedby={startsHintId}
          />
        </FormField>
        <FormField name="endsAt">
          <label htmlFor={endsId}>終了（日本時間・JST）</label>
          <p className="hint" id={endsHintId}>
            終了は開始より後にしてください。期間は最長30日です。延長するときは新しい委任を作成します。
          </p>
          <input
            type="datetime-local"
            id={endsId}
            name="endsAt"
            required
            aria-describedby={endsHintId}
          />
        </FormField>
      </fieldset>
      <div
        className="field"
        data-error-field="confirm"
        // チェック欄とラベルを同じ行に並べる(チェック欄が左、ラベルが右)。
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}
      >
        <input
          type="checkbox"
          id={confirmId}
          name="confirm"
          value="1"
          required
          // WCAG 2.2 AA の target-size (24x24px)。グローバルの 16px を上書きする。
          style={{ width: '24px', height: '24px', marginTop: '0.1rem' }}
        />
        <label htmlFor={confirmId} style={{ minWidth: 0 }}>
          委任の期間中、この人が自分宛ての承認を判断できることを確認しました
        </label>
      </div>
      <div className="directory-form-actions">
        <button type="submit" disabled={pending}>
          {pending ? '委任を作成しています…' : '委任を作成する'}
        </button>
      </div>
    </FeedbackForm>
  );
}

/**
 * 委任の取消(代理者から見れば辞退)のフォーム。
 * 理由が必須で、実行前の確認はチェック欄で求める。成功の文は一覧を読み直して出す。
 */
export function DelegationRevokeForm({
  action,
  kind,
  summary,
  who,
}: {
  action: DelegationRevokeAction;
  kind: 'revoked' | 'declined';
  summary: string;
  who: string;
}) {
  const [feedback, dispatch, pending] = useActionState(action, {
    message: '',
  } as FormFeedback);
  const id = useId();
  const reasonId = `${id}-reason`;
  const reasonHintId = `${id}-reason-hint`;
  const confirmId = `${id}-confirm`;
  const declining = kind === 'declined';
  return (
    <details aria-label={summary} style={{ gridColumn: '1 / -1' }}>
      <summary>{summary}</summary>
      <FeedbackForm
        feedback={feedback}
        pending={pending}
        action={dispatch}
        className="directory-form"
      >
        <FormField name="reason">
          <label htmlFor={reasonId}>{declining ? '辞退の理由' : '取消の理由'}</label>
          <p className="hint" id={reasonHintId}>
            {declining
              ? `「${who}」さんからの委任を辞退する理由を書いてください。2000文字以内です。`
              : `「${who}」さんへの委任を取り消す理由を書いてください。2000文字以内です。`}
          </p>
          <textarea
            id={reasonId}
            name="reason"
            required
            maxLength={2000}
            rows={3}
            aria-describedby={reasonHintId}
          />
        </FormField>
        <div
          className="field"
          data-error-field="confirm"
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: '0.5rem' }}
        >
          <input
            type="checkbox"
            id={confirmId}
            name="confirm"
            value="1"
            required
            style={{ width: '24px', height: '24px', marginTop: '0.1rem' }}
          />
          <label htmlFor={confirmId} style={{ minWidth: 0 }}>
            {declining
              ? 'この委任を辞退し、以後は代理で承認しないことを確認しました'
              : 'この委任を取り消し、以後は代理で承認できないことを確認しました'}
          </label>
        </div>
        <div className="directory-form-actions">
          <button type="submit" className={declining ? undefined : 'danger'} disabled={pending}>
            {pending
              ? declining
                ? '辞退しています…'
                : '取り消しています…'
              : declining
                ? '辞退する'
                : '取り消す'}
          </button>
        </div>
      </FeedbackForm>
    </details>
  );
}
