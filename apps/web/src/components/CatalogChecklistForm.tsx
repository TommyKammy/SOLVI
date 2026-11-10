'use client';

import { useActionState } from 'react';
import type { CatalogFulfillment } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { updateCatalogChecklist } from '../app/requests/actions';
import { FeedbackForm } from './FeedbackForm';

export function CatalogChecklistForm({
  requestId,
  requestRevision,
  fulfillment,
}: {
  requestId: string;
  requestRevision: number;
  fulfillment?: CatalogFulfillment;
}) {
  const [feedback, action, pending] = useActionState(
    updateCatalogChecklist.bind(null, requestId, requestRevision),
    { message: '' } as FormFeedback,
  );
  if (
    !fulfillment ||
    (!fulfillment.ownerName && !fulfillment.groupName && !fulfillment.checks.length)
  )
    return null;
  const required = fulfillment.checks.filter((check) => check.required);
  const completed = required.filter((check) => check.completed).length;
  const list = (
    <ul className="attachments">
      {fulfillment.checks.map((check) => (
        <li className="attachment" key={check.key}>
          <p>
            <strong>{check.label}</strong>
            {check.required ? '（完了必須）' : '（任意）'}
          </p>
          <p>{check.completed ? '完了' : '未完了'}</p>
          {fulfillment.canUpdate === true && (
            <>
              <input
                type="hidden"
                name={'completed:' + check.key}
                value={String(!check.completed)}
              />
              <button
                type="submit"
                name="key"
                value={check.key}
                className="secondary"
                aria-label={`「${check.label}」を${check.completed ? '未完了に戻す' : '完了にする'}`}
                disabled={pending}
              >
                {check.completed ? '未完了に戻す' : '完了にする'}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="受付後の担当と作業" className="form-panel">
      <h2>受付後の担当と作業</h2>
      <dl>
        <dt>サービスの責任者</dt>
        <dd>{fulfillment.ownerName ?? '未設定'}</dd>
        <dt>担当グループ</dt>
        <dd>{fulfillment.groupName ?? '未設定'}</dd>
      </dl>
      {!!fulfillment.checks.length && (
        <>
          <p>
            必須作業の完了 {completed} / {required.length}件
          </p>
          {fulfillment.canUpdate === true ? (
            <FeedbackForm action={action} feedback={feedback} pending={pending} className="stack">
              <input type="hidden" name="expectedVersion" value={fulfillment.checklistVersion} />
              {list}
              {pending && <p role="status">作業チェックを保存しています…</p>}
              {!pending && feedback.success && (
                <p role="status" className="success">
                  {feedback.success}
                </p>
              )}
            </FeedbackForm>
          ) : (
            <>
              {list}
              <p className="hint">現在の作業状況を表示しています。</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
