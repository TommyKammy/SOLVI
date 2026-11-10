'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Refresh only while quarantine is pending; preserve the page's form inputs. */
export function AttachmentScanRefresh() {
  const router = useRouter();
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 5000);
    const stop = setTimeout(() => {
      clearInterval(timer);
      setWaiting(true);
    }, 180000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [router]);
  return (
    <p className="hint" role="status">
      {waiting
        ? '検査に時間がかかっています。担当者にご確認ください。'
        : '添付の検査結果を自動で確認しています。'}{' '}
      <button type="button" className="secondary" onClick={() => router.refresh()}>
        結果を更新する
      </button>
    </p>
  );
}
