import { api } from '../lib/api';

/**
 * 全画面共通のヘッダ (WP-P1-IDM-010)。
 *
 * **いまどの組織として操作しているかを、常に見えるところへ置く。**
 *
 * 兼務者は組織を切り替えられる。切り替えたことを忘れたまま書き込むと、
 * 別の会社の問い合わせに社内の事情を書いてしまう。
 * 「どちらに居るか」は操作のたびに確認できなければならない。
 *
 * 所属が1つの利用者には切り替えリンクを出さない。
 * 押しても選択肢が1つしかない導線は、画面を読む手間を増やすだけである。
 *
 * ログイン前は題字だけを出す。ログイン画面に「ログアウト」が並んでいると、
 * 自分が今どちらの状態なのか分からなくなる。
 */
export async function SiteHeader() {
  // `me()` は組織が未選択だと 403 になる。ここは組織の選択画面でも
  // 表示されるため、未選択でも引ける経路を使う。
  const result = await api.myOrganizations();
  const signedIn = result.ok;
  const organizations = result.ok ? result.data.organizations : [];
  const selectedId = result.ok ? result.data.selected : null;
  const current = organizations.find((o) => o.id === selectedId);
  const canSwitch = organizations.length > 1;

  return (
    <header className="site">
      <div className="inner">
        <a href="/">SOLVI サポート</a>

        {signedIn && (
          <nav
            aria-label="利用者メニュー"
            style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}
          >
            {current && (
              <span className="current-org">
                {/* 支援技術には「何の名前か」を伝える。目で見る利用者には
                    位置と体裁で分かるが、読み上げでは文脈が要る。 */}
                <span className="visually-hidden">操作中の組織: </span>
                {current.name}
              </span>
            )}
            {canSwitch && <a href="/select-organization">組織を切り替える</a>}

            {/* 担当者向けの入口。権限が無い利用者が押しても、
                画面側で「権限がありません」と伝え、APIは自分の分しか返さない。 */}
            <a href="/ops">対応待ちの一覧</a>
            <form action="/logout" method="post">
              <button className="secondary" type="submit">
                ログアウト
              </button>
            </form>
          </nav>
        )}
      </div>
    </header>
  );
}
