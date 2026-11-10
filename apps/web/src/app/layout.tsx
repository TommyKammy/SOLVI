import type { Metadata, Viewport } from 'next';
import './globals.css';
import './freshservice.css';
import { AppShell } from '../components/AppShell';

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
      <body className="fs-ui">
        {/* 本文へ飛ぶリンク。キーボード利用者に毎回ヘッダを読み上げさせない。 */}
        <a className="skip-link" href="#main">
          本文へ移動
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
