'use client';

import { useEffect, useState } from 'react';

/**
 * 接続が切れていることの表示 (NFR-UX-004 / 11.11 / WP-P2-UISTATE-020)。
 *
 * **サーバ側では分からない状態である。** ブラウザが回線を失うと、
 * 画面はそのまま表示され続け、押しても何も起きない。
 * 利用者には「固まった」ようにしか見えない。
 *
 * `/unavailable`(基盤が落ちている)とは別の状態である。
 *
 * | | 誰が落ちているか | 利用者にできること |
 * |---|---|---|
 * | `/unavailable` | サービス側 | 待つ |
 * | この表示 | 手元の回線 | **自分で直せる** |
 *
 * 区別しないと、自分のWi-Fiが切れているときに
 * 「サービスに接続できていません」と読み、情報システム部門へ連絡が来る。
 *
 * `navigator.onLine` は完璧ではない(繋がっているが到達できない場合を
 * 検出できない)。それでも**回線が切れた瞬間は確実に分かる**ので、
 * 分かる範囲だけを言う。分からないときは何も言わない。
 */
export function OfflineNotice() {
  // 最初は「オンライン」から始める。サーバ側の描画には
  // `navigator` が無く、初期値をずらすとハイドレーションで表示が跳ねる。
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = (): void => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  if (!offline) return null;

  return (
    // `role="status"` にする。**操作を遮らない。**
    // 回線が切れていても、書きかけの文章を読むことはできる。
    <div className="offline-notice" role="status" aria-live="polite">
      <strong>ネットワークに接続していません</strong>
      <span>書きかけの内容は画面に残っています。接続が戻ってから送信してください。</span>
    </div>
  );
}
