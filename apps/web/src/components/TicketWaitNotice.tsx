import type { TicketView } from '../lib/api';
export function TicketWaitNotice({
  ticket,
  requester = false,
}: {
  ticket: Pick<TicketView, 'state' | 'pendingReason'>;
  requester?: boolean;
}) {
  if (ticket.state !== 'pending') return null;
  const waiting =
    ticket.pendingReason === 'wait_requester'
      ? 'requester'
      : ticket.pendingReason === 'wait_external'
        ? 'external'
        : 'unknown';
  return (
    <section className="notice" aria-label="次の対応">
      <strong>
        {waiting === 'requester'
          ? requester
            ? 'あなたの返答を待っています'
            : '依頼者の返答を待っています'
          : waiting === 'external'
            ? '外部の対応を待っています'
            : '待ち先が記録されていません'}
      </strong>
      <p>
        {waiting === 'requester'
          ? requester
            ? '下の「追加でお知らせする」から返答すると、担当者の対応を再開します。'
            : '依頼者から公開コメントが届くと対応中へ戻り、SLAの計測も再開します。'
          : waiting === 'external'
            ? '追加連絡は保存されます。外部の対応が完了したら担当者が対応を再開します。'
            : '担当者がやり取りを確認して対応を再開してください。'}
      </p>
      <p className="hint">待機中はSLAの計測を停止しています。</p>
    </section>
  );
}
