import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SOLVI',
  description: '社内サポートポータル',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/* 本文へ飛ぶリンク。キーボード利用者に毎回ヘッダを読み上げさせない。 */}
        <a className="skip-link" href="#main">
          本文へ移動
        </a>
        <header className="site">
          <div className="inner">
            <a href="/">SOLVI サポート</a>
            <nav aria-label="利用者メニュー">
              <form action="/logout" method="post">
                <button className="secondary" type="submit">
                  ログアウト
                </button>
              </form>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
