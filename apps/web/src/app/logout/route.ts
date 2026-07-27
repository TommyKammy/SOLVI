import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { api } from '../../lib/api';

/**
 * ログアウト (WP-P2-PORTAL-002)。
 *
 * POST でのみ受ける。GET にすると、`<img src="/logout">` を含むページを
 * 踏ませるだけで他人をログアウトさせられる(CSRF)。
 * 実害は小さいが、状態を変える操作を GET に置かないという原則を崩さない。
 */
export async function POST(): Promise<NextResponse> {
  // API 側でセッションを失効させる。Cookie を消すだけだと、
  // トークンは有効なまま残り、控えを持っていれば使い続けられる。
  await api.logout();

  const jar = await cookies();
  jar.delete('solvi_session');

  return NextResponse.redirect(
    new URL('/login', process.env.WEB_BASE_URL ?? 'http://localhost:3000'),
    {
      status: 303,
    },
  );
}
