import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { api } from '../../lib/api';

/**
 * ログイン画面 (WP-P2-PORTAL-002 / WP-P1-IDM-009)。
 *
 * **失敗の理由を出し分けない。** メールアドレスが違うのかパスワードが違うのかを
 * 画面に出すと、有効なアドレスの判別材料になる。APIも同じ理由で一律の401を返す。
 *
 * 検証段階のローカル認証を使う(ADR-0019)。外部IdP接続後は
 * この画面がIdPへのリダイレクトに置き換わる。
 */

export const dynamic = 'force-dynamic';

async function login(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  // **組織は入力させない。** 利用者が知っているのは「自分がどの会社の人間か」
  // だけで、その組織IDではない。所属はシステムが役割束縛として持っている。
  const result = await api.login({ email, password });

  if (!result.ok) {
    // クエリに理由を載せない。載せるとブラウザ履歴と参照元ヘッダに残る。
    redirect('/login?error=1');
  }

  // API が発行した Set-Cookie を、そのままブラウザへ渡す。
  // ここで値を作り直すと、HttpOnly や期限の設定を二重管理することになる。
  if (result.setCookie) {
    const jar = await cookies();
    const [pair] = result.setCookie.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) {
      jar.set({
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.SESSION_COOKIE_SECURE !== 'false',
      });
    }
  }

  // 兼務者は組織が決まらない。**勝手に片方を選ばない** —
  // 別組織のつもりで書き込む事故を、最初の一歩で防ぐ。
  redirect(result.data.organizationId ? '/' : '/select-organization');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const failed = params.error !== undefined;
  // **なぜ戻されたのかを言う。** セッションを持っていたのに 401 だった場合は
  // 期限切れか失効である。何も言わずにログイン画面へ戻すと、
  // 利用者は自分の操作を疑う(NFR-UX-004)。
  const expired = params.expired !== undefined;

  return (
    <main id="main" className="shell">
      <h1>ログイン</h1>
      <p className="lead">社内サポートポータルを利用するにはログインしてください。</p>

      {expired && !failed && (
        <div className="notice" role="status">
          <h2 style={{ marginTop: 0 }}>ログインの有効期限が切れました</h2>
          <p style={{ margin: 0 }}>
            お手数ですが、もう一度ログインしてください。作業中だった内容は保存されています。
          </p>
        </div>
      )}

      {failed && (
        // 送信直後にここへフォーカスを移し、何が起きたかを最初に読み上げさせる。
        // role="alert" だけだと、画面を目で追っていない利用者には届きにくい。
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>ログインできませんでした</h2>
          <p style={{ margin: 0 }}>
            メールアドレスまたはパスワードが正しくありません。入力内容をご確認ください。
          </p>
        </div>
      )}

      <form className="stack" action={login} style={{ marginTop: '1.5rem' }}>
        <div className="field">
          <label htmlFor="email">メールアドレス</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            aria-invalid={failed || undefined}
          />
        </div>

        <div className="field">
          <label htmlFor="password">パスワード</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={failed || undefined}
          />
        </div>

        <button type="submit">ログイン</button>
      </form>
    </main>
  );
}
