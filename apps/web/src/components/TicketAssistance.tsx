'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { TicketAssistanceView } from '../lib/api';
import type { FormFeedback } from '../lib/form-state';
import { formatDateTime } from '../lib/labels';
import { withReturnTo } from '../lib/navigation';
import { FeedbackForm } from './FeedbackForm';

const checklist = [
  '申請の対象と利用条件を照合する。',
  '承認者と有効期限を確認する。',
  '承認後に模擬実行し、保存された証跡と外部変更件数を確認する。',
];

export function TicketAssistance({
  assistance,
  action,
  scope,
  ticketHref,
  canReadAudit,
  saved,
}: {
  assistance: TicketAssistanceView;
  action: (previous: FormFeedback, form: FormData) => Promise<FormFeedback>;
  scope: string;
  ticketHref: string;
  canReadAudit: boolean;
  saved: boolean;
}) {
  const [feedback, submit, pending] = useActionState(action, { message: '' } as FormFeedback);
  const { decision } = assistance;
  const accepted = decision?.kind === 'accepted';
  const status = accepted ? '採用済み' : decision ? '見送り' : '未判断';
  const requestHref = withReturnTo(
    '/requests/' +
      encodeURIComponent(assistance.requestId) +
      (assistance.receiptId ? '#simulation-receipt' : ''),
    ticketHref,
  );

  return (
    <details id="ticket-assistance" className="ticket-assistance" open={saved || undefined}>
      <summary>
        <span>AI支援プレビュー</span>
        <span className="ticket-assistance-status">{status}</span>
      </summary>
      <div className="ticket-assistance-content">
        <h3>承認と模擬実行の確認手順</h3>
        <p>模擬申請用の定型提案です。判断は担当者が記録します。</p>
        <ol>
          {checklist.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
        <p className="hint">
          参照元 {assistance.source.title}（公開版 {assistance.source.version}、申請内容版{' '}
          {assistance.requestRevision}）
        </p>
        {assistance.canDecide && (
          <FeedbackForm
            aria-label="提案の判断"
            action={submit}
            feedback={feedback}
            pending={pending}
          >
            <input type="hidden" name="formScope" value={scope} />
            <div className="form-actions ticket-assistance-actions">
              <button type="submit" name="decision" value="accepted" disabled={pending}>
                提案を採用する
              </button>
              <button
                type="submit"
                name="decision"
                value="rejected"
                className="secondary"
                disabled={pending}
              >
                提案を見送る
              </button>
            </div>
            {pending && <p role="status">判断を保存しています…</p>}
          </FeedbackForm>
        )}
        {!decision && !assistance.canDecide && (
          <p className="hint">承認待ちの申請で判断を記録できます。</p>
        )}
        {decision && (
          <p className="hint" role={saved ? 'status' : undefined}>
            {accepted ? '提案を採用しました。' : '提案を見送りました。'}{' '}
            {formatDateTime(decision.decidedAt)}
          </p>
        )}
        {(accepted || (decision && canReadAudit)) && (
          <div className="form-actions ticket-assistance-actions">
            {accepted && (
              <Link className="support-action" href={requestHref}>
                {assistance.receiptId ? '模擬実行の結果を開く' : '承認・模擬実行を開く'}
              </Link>
            )}
            {canReadAudit && (
              <Link
                className="support-action"
                prefetch={false}
                href={'/ops/audit?' + new URLSearchParams({ target: assistance.requestId })}
              >
                この申請の監査ログを開く
              </Link>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
