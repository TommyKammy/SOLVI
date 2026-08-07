import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SiteHeader } from '../components/SiteHeader';
import { OfflineNotice } from '../components/OfflineNotice';

export const metadata: Metadata = {
  title: 'SOLVI',
  description: '社内サポートポータル',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/* 本文へ飛ぶリンク。キーボード利用者に毎回ヘッダを読み上げさせない。 */}
        <a className="skip-link" href="#main">
          本文へ移動
        </a>
        <SiteHeader />
        {/* 回線が切れていることは全画面で伝える。**画面ごとに書くと書き忘れる。** */}
        <OfflineNotice />
        {children}
      </body>
    </html>
  );
}
