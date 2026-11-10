import { ContextLink } from '../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/labels';
import { safeReturnTo } from '../../../../lib/navigation';
import { CatalogManagement } from '../../../../components/CatalogAdminForm';
export const dynamic = 'force-dynamic';
export default async function CatalogEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; returnTo?: string | string[] }>;
}) {
  await requireSession();
  const { id } = await params,
    query = await searchParams,
    { saved } = query,
    r = await api.catalogManagementDetail(id);
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const returnTo = safeReturnTo(query.returnTo);
    const validId =
      typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retry = new URLSearchParams();
    if (returnTo) retry.set('returnTo', returnTo);
    const retryUrl = validId
      ? '/catalog/manage/' + encodeURIComponent(id) + (retry.size ? '?' + retry.toString() : '')
      : undefined;
    const message =
      r.problem.status === 400
        ? 'カタログ項目を取得できませんでした。カタログ管理から項目を選び直してください。'
        : r.problem.status === 401
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : 'カタログ項目を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>カタログ項目を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <div className="form-actions">
          {retryUrl && <a href={retryUrl}>再取得する</a>}
          {returnTo && <a href={returnTo}>元の画面へ戻る</a>}
          <a href="/catalog/manage">カタログ管理へ戻る</a>
          <a href="/portal">ポータルへ戻る</a>
        </div>
      </main>
    );
  }
  const i = r.data;
  return (
    <main id="main" className="shell">
      <ContextLink back href="/catalog/manage">
        カタログ管理へ戻る
      </ContextLink>
      <h1>{i.draft.title}</h1>
      {saved === '1' && (
        <p role="status" className="success">
          カタログ設定を保存しました。
        </p>
      )}
      <p className="notice">
        {i.active
          ? '公開中: ' + i.published?.title + '（版' + i.publishedRevision + '）'
          : '非公開: 新規申請を受け付けていません'}{' '}
        · 下書き版{i.draft.revision}
      </p>
      {i.active && (
        <p>
          <ContextLink href={'/catalog/' + i.id}>現在の公開フォームを見る</ContextLink>
        </p>
      )}
      <CatalogManagement key={i.id + '-' + i.editVersion} item={i} />
      <h2>保存した定義の版</h2>
      <ul>
        {i.history.map((h) => (
          <li key={h.revision}>
            版{h.revision} · {h.title} · {formatDateTime(h.createdAt)}
            {h.revision === i.publishedRevision ? ' · 最後に公開した版' : ''}
          </li>
        ))}
      </ul>
      <p className="hint">
        公開・非公開は新規申請だけに適用されます。既存申請は申請時の定義を保持します。
      </p>
    </main>
  );
}
