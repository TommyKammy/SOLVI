/**
 * 基盤へ接続できないときの画面 (NFR-UX-004 / 11.11 / WP-P2-UISTATE-018)。
 *
 * **以前はここへ来る経路が無く、利用者はログイン画面へ送られていた。**
 * ログアウトされたと思い、そのログイン画面でも同じ理由で失敗する。
 * 画面上は「パスワードが違う」ようにしか見えない。
 *
 * ## なぜ `error.tsx` ではなくページなのか
 *
 * サーバ側の描画中に投げた例外は `error.tsx` へ届かない。
 * 全ページ読み込みでは Next.js の既定の500画面が出るだけで、
 * **日本語ですらない。** `error.tsx` が効くのは画面遷移中と
 * ハイドレーション後であり、最初の1枚には効かない。
 *
 * 投げるのをやめ、**普通のページとして描く**。
 * 経路を1か所(`requireSession()`)に閉じているので、
 * 各画面が個別に判定する必要は無い。
 */
export const dynamic = 'force-dynamic';

export default function Unavailable() {
  return (
    <main id="main" className="shell">
      <div className="error-summary" role="alert" tabIndex={-1}>
        <h1 style={{ marginTop: 0 }}>ただいま接続できません</h1>
        <p style={{ margin: 0 }}>
          {/* **ログアウトされたのではない**と明示する。これを言わないと、
              利用者は自分の資格情報を疑って何度もログインを試みる。 */}
          サービスに接続できていません。ログアウトされたわけではありません。
          しばらく待ってからもう一度お試しください。
        </p>
      </div>

      <div className="stack" style={{ marginTop: '1.5rem', maxWidth: '30rem' }}>
        {/* **必ず出口を用意する。** 再試行しか無い画面は、
            直らないときに行き止まりになる。 */}
        <p style={{ margin: 0 }}>
          <a href="/">もう一度読み込む</a>
        </p>
        <p className="hint" style={{ margin: 0 }}>
          しばらく経っても直らない場合は、情報システム部門へご連絡ください。
          復旧後は、ログインし直さずにそのまま作業を続けられます。
        </p>
      </div>
    </main>
  );
}
