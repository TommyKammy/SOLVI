import Link from 'next/link';

/**
 * 見つからないときの表示 (NFR-UX-004 / 11.11 / WP-P2-UISTATE-018)。
 *
 * **これが無かった。** 存在しないチケットを開くと、
 * ヘッダだけが出て**本文が空の画面**になっていた。
 * 何も書かれていないので、利用者には読み込み中との区別もつかない。
 *
 * 「無い」と「見せない」を区別しない文面にする。
 * 他組織のチケットも 404 で返す設計(存在の秘匿)であり、
 * ここで「存在しません」と断言すると、その設計を裏切る。
 */
export default function NotFound() {
  return (
    <main id="main" className="shell">
      <h1>お探しの画面は見つかりませんでした</h1>
      <p className="lead">URLが変わったか、閲覧できる範囲の外にある可能性があります。</p>

      <ul className="stack" style={{ listStyle: 'none', padding: 0, maxWidth: '30rem' }}>
        <li>
          <Link href="/">問い合わせの一覧(依頼者)へ</Link>
        </li>
        <li>
          <Link href="/ops">対応待ちの一覧(担当者)へ</Link>
        </li>
      </ul>

      <p className="hint">
        リンクをたどってこの画面に来た場合は、情報システム部門へご連絡ください。
      </p>
    </main>
  );
}
