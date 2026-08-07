'use client';

import { useEffect } from 'react';

/**
 * 画面が例外で止まったときの表示 (NFR-UX-004 / 11.11 / WP-P2-UISTATE-018)。
 *
 * **これが無かった。** Next.js の既定の画面が出るだけで、
 * 本番構成では「Application error: a client-side exception has occurred」
 * としか書かれない。**日本語ですらない。**
 *
 * **これが受け持つのは画面遷移中とハイドレーション後だけである。**
 * サーバ側の描画中に投げた例外はここへ届かない。
 * 基盤へ接続できない場合は `requireSession()` が `/unavailable` へ送る。
 *
 * 起きたことを日本語で言い、次の行動を1つ以上示す。
 * 「エラーが発生しました」で終わる画面は、利用者を止めるだけである。
 *
 * **原因の詳細は出さない。** スタックトレースや内部のホスト名は
 * 偵察の材料になる。出すのは「何ができるか」であって「何が壊れたか」ではない。
 */
export default function ErrorScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // ブラウザのコンソールには残す。利用者には見せないが、
    // 手元で再現している開発者からは見えるようにする。
    console.error('screen error', error);
  }, [error]);

  return (
    <main id="main" className="shell">
      <div className="error-summary" role="alert" tabIndex={-1}>
        <h1 style={{ marginTop: 0 }}>画面を表示できませんでした</h1>
        <p style={{ margin: 0 }}>一時的な問題が起きた可能性があります。もう一度お試しください。</p>
      </div>

      <div className="stack" style={{ marginTop: '1.5rem', maxWidth: '30rem' }}>
        <button type="button" onClick={() => reset()}>
          もう一度読み込む
        </button>
        {/* **必ず出口を用意する。** 再試行しか無い画面は、
            直らないときに行き止まりになる。 */}
        <p style={{ margin: 0 }}>
          <a href="/">最初の画面へ戻る</a>
        </p>
        <p className="hint" style={{ margin: 0 }}>
          何度も繰り返す場合は、情報システム部門へご連絡ください。
          {/* digest は Next が採番する識別子。**内容ではなく番号だけ**なので
              利用者へ見せてよく、問い合わせのときに突き合わせられる。 */}
          {error.digest && <> 問い合わせ番号: {error.digest}</>}
        </p>
      </div>
    </main>
  );
}
