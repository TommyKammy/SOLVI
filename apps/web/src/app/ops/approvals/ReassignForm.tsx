'use client';

import { useActionState, useId } from 'react';
import { FeedbackForm } from '../../../components/FeedbackForm';
import type { FormFeedback } from '../../../lib/form-state';

type ReassignAction = (previous: FormFeedback, form: FormData) => Promise<FormFeedback>;

/**
 * 承認者不在の申請の再割当フォーム (WP-P4-APR-018 §6-6)。
 *
 * 理由だけを送る。承認者・段・経路は利用者に選ばせない(APIも受け取らない)。
 * 実行前の確認はチェック欄で求め、失敗はその場に表示する。成功は一覧が
 * 最新になって行が消えるため、申請IDをURLに残して画面全体で表示する。
 * 権限・条件の判定はAPIが行い、この画面は表示を制御するだけである。
 */
export function ReassignForm({
  action,
  requestNumber,
}: {
  action: ReassignAction;
  requestNumber: string;
}) {
  const [feedback, dispatch, pending] = useActionState(action, {
    message: '',
  } as FormFeedback);
  const id = useId();
  const reasonId = `${id}-reason`;
  const reasonHintId = `${id}-reason-hint`;
  const confirmId = `${id}-confirm`;
  return (
    // モバイルでは td が2列グリッドになる。欄をセル幅いっぱいに広げる
    // (そのままだと1列目の90pxに押し込まれ、1文字ずつ折り返す)。
    <details aria-label={`申請番号 ${requestNumber} の再割当`} style={{ gridColumn: '1 / -1' }}>
      <summary>再割当（申請番号 {requestNumber}）</summary>
      <FeedbackForm
        feedback={feedback}
        pending={pending}
        action={dispatch}
        className="directory-form"
      >
        <div className="field">
          <label htmlFor={reasonId}>再割当の理由</label>
          <p className="hint" id={reasonHintId}>
            なぜ承認者を決め直す必要があるかを書いてください。2000文字以内です。申請者にも表示されます。
          </p>
          <textarea
            id={reasonId}
            name="reason"
            required
            maxLength={2000}
            rows={3}
            aria-describedby={reasonHintId}
          />
        </div>
        <div
          className="field"
          // チェック欄とラベルを同じ行に並べる(チェック欄が左、ラベルが右)。
          // ラベルが折り返しても、チェック欄は1行目に揃える。
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
            今の組織の設定（上長・部署長）から承認者を決め直すことを確認しました
          </label>
        </div>
        <div className="directory-form-actions">
          <button type="submit" disabled={pending}>
            {pending ? '再割当しています…' : '再割当を実行する'}
          </button>
        </div>
      </FeedbackForm>
    </details>
  );
}
