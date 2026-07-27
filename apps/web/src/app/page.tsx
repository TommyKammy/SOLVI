/**
 * Phase 1 の時点では基盤確認用の最小ページのみ。
 * Portal の画面(リクエスト送信 / インシデント報告)は WP-P2-PORTAL-002 で実装する。
 * 画面仕様は docs/planning/11_UI_UX/11.2_Information_Architecture.md。
 */
export default function Page() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.7 }}>
      <h1>SOLVI</h1>
      <p>社内サポートポータル(基盤構築中)</p>
      <p>
        Phase 1 ではプラットフォーム基盤を構築しています。利用者向けの画面は Phase 2
        で追加されます。
      </p>
    </main>
  );
}
