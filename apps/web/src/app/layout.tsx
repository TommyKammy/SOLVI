import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import './freshservice.css';
import { AppShell } from '../components/AppShell';
import { CSP_MODE, cspHeaderName } from '../lib/security-headers';

export const metadata: Metadata = {
  title: 'SOLVI',
  description: '社内サポートポータル',
  // OSの文字拡大設定をブラウザの基準文字サイズへ反映する。
  other: { 'text-scale': 'scale' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * 保存されたテーマを最初の描画前に反映する。外部スクリプトは使わない。
 * 値は固定文字列だけで、利用者由来のデータを含めない。
 * CSPを緩めないよう、ミドルウェアが作ったnonceを付けて出す。
 */
const THEME_INIT = `(function(){try{var t=localStorage.getItem('solvi-theme');var d=t==='dark'||t==='light'?t:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',d);}catch(e){try{document.documentElement.setAttribute('data-theme',window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}catch(_){}}})();`;

function cspNonce(policy: string | null): string | undefined {
  const match = policy?.match(/'nonce-([^']+)'/);
  return match?.[1];
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const nonce = cspNonce(requestHeaders.get(cspHeaderName(CSP_MODE)));

  return (
    <html lang="ja" suppressHydrationWarning>
      <body className="fs-ui">
        {nonce && <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />}
        {/* 本文へ飛ぶリンク。キーボード利用者に毎回ヘッダを読み上げさせない。 */}
        <a className="skip-link" href="#main">
          本文へ移動
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
