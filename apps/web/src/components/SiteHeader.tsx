import { api } from '../lib/api';
import { Suspense } from 'react';
import { AppNavigation, RouteContext } from './AppNavigation';
import { DraftSessionBoundary, LogoutForm } from './DraftSessionBoundary';
import { formScope } from '../lib/form-scope';
import { navigationRoles } from '../lib/navigation';

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
  // The isolated GLPI trial does not require the legacy SOLVI API/PostgreSQL stack.
  if (process.env.GLPI_UI_ENABLED === 'true' && process.env.NODE_ENV !== 'production') {
    return (
      <header className="site">
        <div className="inner">
          <a className="site-brand" href="/glpi">
            SOLVI
          </a>
        </div>
      </header>
    );
  }
  // `me()` は組織が未選択だと 403 になる。ここは組織の選択画面でも
  // 表示されるため、未選択でも引ける経路を使う。
  const result = await api.myOrganizations();
  const signedIn = result.ok;
  const organizations = result.ok ? result.data.organizations : [];
  const selectedId = result.ok ? result.data.selected : null;
  const current = organizations.find((o) => o.id === selectedId);
  const canSwitch = organizations.length > 1;
  const me = selectedId ? await api.me() : null;
  const roles = me?.ok ? navigationRoles(me.data) : null;
  if (roles?.notifications) {
    // auth/me omits binding validity dates. The protected reader confirms current permission.
    const notifications = await api.notifications({
      status: 'all',
      direction: 'next',
      invalid: false,
    });
    roles.notifications = notifications.ok;
  }
  return (
    <>
      <header className={roles ? 'site workspace-nav' : 'site'}>
        <DraftSessionBoundary scope={me?.ok ? formScope(me.data) : null} />
        <div className="inner">
          <div className="identity-row">
            <a className="site-brand" href="/">
              SOLVI
            </a>
            {current && (
              <span className="current-org">
                <span className="visually-hidden">操作中の組織: </span>
                {current.name}
              </span>
            )}
            {signedIn && (
              <div className="session-actions">
                {canSwitch && <a href="/select-organization">組織を切り替える</a>}
                {me?.ok && <a href="/settings/notifications">自分の通知設定</a>}
                <LogoutForm />
              </div>
            )}
          </div>
          {roles && (
            <Suspense fallback={null}>
              <AppNavigation roles={roles} />
            </Suspense>
          )}
        </div>
      </header>
      {roles && (
        <Suspense fallback={null}>
          <RouteContext />
        </Suspense>
      )}
    </>
  );
}
