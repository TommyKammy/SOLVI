import { ContextLink } from '../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { CatalogAdminForm } from '../../../../components/CatalogAdminForm';
import { safeReturnTo } from '../../../../lib/navigation';
export default async function CatalogNewPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  await requireSession();
  const r = await api.catalogManagementRead();
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const returnTo = safeReturnTo((await searchParams).returnTo);
    const retry = new URLSearchParams();
    if (returnTo) retry.set('returnTo', returnTo);
    const retryUrl = '/catalog/manage/new' + (retry.size ? '?' + retry.toString() : '');
    const message =
      r.problem.status === 400
        ? '承認者の候補を取得できませんでした。元の画面やカタログ管理から開き直してください。'
        : r.problem.status === 401
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : '承認者の候補を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>承認者の候補を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <div className="form-actions">
          <a href={retryUrl}>再取得する</a>
          {returnTo && <a href={returnTo}>元の画面へ戻る</a>}
          <a href="/catalog/manage">カタログ管理へ戻る</a>
          <a href="/portal">ポータルへ戻る</a>
        </div>
      </main>
    );
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href="/catalog/manage">
        カタログ管理へ戻る
      </ContextLink>
      <h1>サービスを作成する</h1>
      <p>ローカルの模擬申請専用です。下書きは利用者のカタログに表示しません。</p>
      <CatalogAdminForm approvers={r.data.approvers} />
    </main>
  );
}
