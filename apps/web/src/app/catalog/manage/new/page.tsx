import { ContextLink } from '../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { CatalogAdminForm } from '../../../../components/CatalogAdminForm';
import { safeReturnTo, withReturnTo } from '../../../../lib/navigation';
export default async function CatalogNewPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[]; copyFrom?: string | string[] }>;
}) {
  await requireSession();
  const query = await searchParams;
  const copyFrom = query.copyFrom;
  if (
    copyFrom !== undefined &&
    (typeof copyFrom !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copyFrom))
  )
    notFound();
  const r = await api.catalogManagementRead();
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const returnTo = safeReturnTo(query.returnTo);
    const retry = new URLSearchParams();
    if (copyFrom) retry.set('copyFrom', copyFrom);
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
  if (r.data.canCreate !== true) notFound();
  let initialContent;
  if (copyFrom !== undefined) {
    if (
      typeof copyFrom !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copyFrom)
    )
      notFound();
    const source = await api.catalogManagementDetail(copyFrom);
    if (!source.ok) {
      if ([403, 404].includes(source.problem.status)) notFound();
      const retry = withReturnTo(
        `/catalog/manage/new?copyFrom=${encodeURIComponent(copyFrom)}`,
        query.returnTo,
      );
      return (
        <main id="main" className="shell">
          <h1>複製元を読み込めませんでした</h1>
          <p role="alert">元のサービスと接続を確認して、再度お試しください。</p>
          <a href={retry}>複製元を再取得する</a>
          <p>
            <ContextLink back href="/catalog/manage">
              カタログ管理へ戻る
            </ContextLink>
          </p>
        </main>
      );
    }
    initialContent = {
      title: source.data.draft.title,
      description: source.data.draft.description,
      definition: source.data.draft.definition,
    };
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href="/catalog/manage">
        カタログ管理へ戻る
      </ContextLink>
      <h1>{initialContent ? 'サービスを複製する' : 'サービスを作成する'}</h1>
      {initialContent && (
        <p>「{initialContent.title}」の下書き内容から、新しいサービスを作成します。</p>
      )}
      <p>ローカルの模擬申請専用です。下書きは利用者のカタログに表示しません。</p>
      <CatalogAdminForm
        approvers={r.data.approvers}
        options={r.data}
        initialContent={initialContent}
      />
    </main>
  );
}
