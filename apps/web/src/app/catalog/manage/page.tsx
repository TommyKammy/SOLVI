import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { withReturnTo } from '../../../lib/navigation';
import { formatDateTime } from '../../../lib/labels';
import {
  catalogListContext,
  catalogListQuery,
  catalogListUrl,
  catalogListView,
} from '../../../lib/catalog-management-list';
export const dynamic = 'force-dynamic';
export default async function CatalogManagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const r = await api.catalogManagementRead();
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const query = catalogListQuery(await searchParams);
    const returnTo = query.returnTo;
    const retryUrl = catalogListUrl(query);
    const message =
      r.problem.status === 400
        ? 'カタログ管理を取得できませんでした。元の画面やカタログから開き直してください。'
        : r.problem.status === 401
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : 'カタログ管理を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>カタログ管理を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <div className="form-actions">
          <a href={retryUrl}>再取得する</a>
          {returnTo && <a href={returnTo}>元の画面へ戻る</a>}
          <a href="/catalog">利用者のカタログへ戻る</a>
          <a href="/portal">ポータルへ戻る</a>
        </div>
      </main>
    );
  }
  const query = catalogListQuery(await searchParams);
  const view = catalogListView(r.data.items, query);
  const context = catalogListContext(query);
  const clearUrl = catalogListUrl({ ...query, q: '', state: 'all', page: 1 });
  return (
    <main id="main" className="shell">
      <ContextLink back href="/catalog">
        利用者のカタログへ戻る
      </ContextLink>
      <h1>カタログ管理</h1>
      <p className="lead">項目と承認者を下書きで整え、プレビューして新規受付へ公開します。</p>
      {r.data.canCreate && (
        <p>
          <a className="button-link" href={withReturnTo('/catalog/manage/new', context)}>
            サービスを作成する
          </a>
        </p>
      )}
      <nav className="form-actions" aria-label="カタログ管理の設定">
        <a href={withReturnTo('/catalog/manage/question-sets', context)}>共有項目セット</a>
        {r.data.canPublish && <a href="/ops/users">編集権限を委任する</a>}
      </nav>
      <form
        action="/catalog/manage"
        method="get"
        className="filters"
        aria-label="カタログの表示条件"
      >
        <div className="field search-field">
          <label htmlFor="catalog-query">サービスを検索</label>
          <input id="catalog-query" name="q" type="search" maxLength={100} defaultValue={query.q} />
          <p className="hint">名前・説明・責任者・管理コードから検索します。</p>
        </div>
        <div className="field">
          <label htmlFor="catalog-state">公開状態</label>
          <select id="catalog-state" name="state" defaultValue={query.state}>
            <option value="all">すべて</option>
            <option value="published">公開中</option>
            <option value="unpublished">非公開</option>
            <option value="changed">未公開の変更あり</option>
          </select>
        </div>
        {query.returnTo && <input type="hidden" name="returnTo" value={query.returnTo} />}
        <button type="submit">条件を適用する</button>
        <a href={clearUrl}>条件をクリアする</a>
      </form>
      <p role="status">
        全{view.total}件 · 条件に一致するサービス{view.matched}件 · {view.start}〜{view.end}件を表示
      </p>
      <ul className="attachments">
        {view.items.map((i) => (
          <li className="attachment" key={i.id}>
            <h2>
              <a href={withReturnTo('/catalog/manage/' + i.id, context)}>{i.title}</a>
            </h2>
            <p>
              {i.active ? '公開中（版' + i.publishedRevision + '）' : '非公開'} · 下書き版
              {i.draftRevision}
              {i.active && i.draftRevision !== i.publishedRevision ? ' · 未公開の変更あり' : ''}
            </p>
            <p>{i.description}</p>
            <p>
              担当責任者: {i.ownerName || '未設定'} · 最終更新:{' '}
              {i.updatedAt ? formatDateTime(i.updatedAt) : '記録なし'}
            </p>
            <p>
              公開前の確認:{' '}
              {i.readiness
                ? i.readiness.ready
                  ? i.readiness.warnings?.length
                    ? '公開条件を満たしています（確認事項あり）'
                    : '公開条件を満たしています'
                  : '設定の見直しが必要'
                : '未確認'}
            </p>
            {i.readiness && (i.readiness.issues.length > 0 || !!i.readiness.warnings?.length) && (
              <ul>
                {[...i.readiness.issues, ...(i.readiness.warnings ?? [])].map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {r.data.canCreate && (
              <a
                href={withReturnTo(
                  `/catalog/manage/new?copyFrom=${encodeURIComponent(i.id)}`,
                  context,
                )}
              >
                このサービスを複製する
              </a>
            )}
            <p className="hint">管理コード: {i.code}</p>
          </li>
        ))}
      </ul>
      {!view.total ? (
        <p>まだサービスがありません。最初の下書きを作成してください。</p>
      ) : !view.matched ? (
        <p>条件に一致するサービスがありません。検索語や公開状態を変更してください。</p>
      ) : !view.items.length ? (
        <p>
          このページにサービスがありません。{' '}
          <a href={catalogListUrl({ ...query, page: 1 })}>先頭ページへ戻る</a>
        </p>
      ) : null}
      <nav className="pagination" aria-label="カタログ一覧のページ">
        <span>
          ページ{query.page} / {view.pages}
        </span>
        {view.previous && (
          <a href={catalogListUrl({ ...query, page: query.page - 1 })}>前のページ</a>
        )}
        {view.next && <a href={catalogListUrl({ ...query, page: query.page + 1 })}>次のページ</a>}
      </nav>
    </main>
  );
}
