import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';

/**
 * 操作する組織を選ぶ画面 (WP-P1-IDM-010)。
 *
 * **複数の組織に所属する人にしか現れない。** 所属が1つなら
 * ログインの時点で決まっており、この画面は挟まらない。
 * 全員に一律で選ばせると、大多数にとっては意味の無い一手間になる。
 *
 * 以前のログイン画面は**組織IDのUUIDを手入力させていた。**
 * 利用者が知っているのは「自分がどの会社の人間か」だけで、
 * その組織IDではない。所属はシステムが役割束縛として既に持っている。
 * 打ち間違えても意味を読めない文字列なので、間違いに気付く手段も無かった。
 */

export const dynamic = 'force-dynamic';

export default async function SelectOrganization({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  // `me` は組織が未選択だと 403 を返す。ここでは専用の経路を使う。
  const result = await api.myOrganizations();
  if (!result.ok) redirect('/login');

  const { selected, organizations } = result.data;

  if (organizations.length === 0) {
    // 所属が無い。ログインはできたが操作できる組織が無い状態である。
    // **黙って行き止まりにしない。** 誰に連絡すればよいかを書く。
    return (
      <main id="main" className="shell">
        <h1>操作できる組織がありません</h1>
        <p className="lead">
          お客様のアカウントには、現在有効な所属が登録されていません。
          管理者へお問い合わせください。
        </p>
      </main>
    );
  }

  async function choose(formData: FormData): Promise<void> {
    'use server';
    const organizationId = String(formData.get('organizationId') ?? '');
    const done = await api.selectOrganization(organizationId);
    if (!done.ok) {
      redirect('/select-organization?error=1');
    }
    revalidatePath('/', 'layout');
    redirect('/');
  }

  return (
    <main id="main" className="shell">
      <h1>どの組織として操作しますか</h1>
      <p className="lead">
        複数の組織に所属しています。選んだ組織の問い合わせだけが表示され、
        書き込みもその組織のものになります。
      </p>

      {query.error !== undefined && (
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>組織を切り替えられませんでした</h2>
          <p style={{ margin: 0 }}>もう一度お試しください。</p>
        </div>
      )}

      <form action={choose} className="stack" style={{ marginTop: '1.5rem' }}>
        {/*
          ラジオボタンにする。選択肢が2〜3件のとき、プルダウンは
          「開く」という一手間を挟むわりに一覧性が上がらない。
          どの組織があるのかを一目で見せたい場面である。
        */}
        <fieldset className="org-choice">
          <legend>組織</legend>
          {organizations.map((org, index) => (
            <div key={org.id} className="org-option">
              <input
                type="radio"
                id={`org-${org.id}`}
                name="organizationId"
                value={org.id}
                defaultChecked={selected ? org.id === selected : index === 0}
                required
              />
              {/* **名前で選ばせる。** IDは画面に出さない —
                  利用者が読めない値を見せても、選択の助けにならない。 */}
              <label htmlFor={`org-${org.id}`}>{org.name}</label>
            </div>
          ))}
        </fieldset>

        <button type="submit">この組織で続ける</button>
      </form>
    </main>
  );
}
