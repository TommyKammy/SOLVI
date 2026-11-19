'use client';

import { useEffect, useRef } from 'react';
import { FreshserviceIcon } from './FreshserviceIcon';

export function TicketReceipt({ number, incident }: { number: string; incident: boolean }) {
  const receipt = useRef<HTMLDivElement>(null);

  useEffect(() => {
    receipt.current?.focus();
  }, []);

  return (
    <div className="support-ticket-receipt" role="status" tabIndex={-1} ref={receipt}>
      <h2>
        <FreshserviceIcon name="check" size={18} />
        {incident ? '障害報告を受け付けました' : '依頼を受け付けました'}
      </h2>
      <p>
        受付番号は <strong>{number}</strong> です。対応状況と返信をこの画面で確認できます。
      </p>
    </div>
  );
}
