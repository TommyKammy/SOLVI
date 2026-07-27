import type { Metadata, Viewport } from 'next';

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
      <body>{children}</body>
    </html>
  );
}
