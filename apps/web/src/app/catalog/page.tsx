import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { withReturnTo } from '../../lib/navigation';
import { FreshserviceIcon } from '../../components/FreshserviceIcon';
import {
  CATALOG_SEARCH_MAX_LENGTH,
  catalogHref,
  catalogQueryError,
  parseCatalogQuery,
  selectCatalogItems,
} from '../../lib/portal-overview';

export const dynamic = 'force-dynamic';

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const query = parseCatalogQuery(await searchParams);
  const queryError = catalogQueryError(query);
  const result = await api.catalog();
  const selection = selectCatalogItems(result.ok ? result.data.items : [], query);
  const currentHref = catalogHref(query);
  const missingTarget = query.target !== '' && !selection.targets.includes(query.target);
  const targets = result.ok
    ? [
        ...new Set(result.data.items.map((item) => item.definition.targetLabel).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b, 'ja'))
    : [];

  return (
    <main id="main" className="shell service-catalog fs-catalog">
      <div className="fs-page-with-sidebar">
        <aside className="fs-side-nav" aria-label="サービスカタログのカテゴリ">
          <p className="fs-side-nav-heading">サービスカタログ</p>
          <nav className="fs-side-nav-links">
            <Link
              href={catalogHref(query, { target: '', page: 1 })}
              aria-current={!query.target ? 'page' : undefined}
            >
              すべてのアイテム
            </Link>
            {targets.map((target) => (
              <Link
                key={target}
                href={catalogHref(query, { target, page: 1 })}
                aria-current={query.target === target ? 'page' : undefined}
              >
                <span>{target}</span>
              </Link>
            ))}
            {missingTarget && (
              <span className="fs-side-nav-note">指定中の対象を保持しています</span>
            )}
          </nav>
          {result.ok && result.data.canManage && (
            <>
              <p className="fs-side-nav-heading">管理</p>
              <nav className="fs-side-nav-links">
                <Link href={withReturnTo('/catalog/manage', currentHref)}>カタログを管理する</Link>
              </nav>
            </>
          )}
        </aside>

        <section className="fs-page-main" aria-label="サービスカタログ">
          <div className="page-heading catalog-heading">
            <div>
              <h1>サービスカタログ</h1>
              <p className="hint">必要なサービスを探し、申請内容の入力へ進めます。</p>
            </div>
            <nav className="catalog-utilities" aria-label="カタログの関連画面">
              <Link href="/portal">利用者ポータル</Link>
              <Link href="/requests?view=mine">自分の申請状況</Link>
            </nav>
          </div>
          <p className="notice">
            ローカル模擬申請です。承認後も実アカウント作成・権限付与・機器の貸出は行いません。
          </p>
          <form
            key={currentHref}
            action="/catalog"
            method="get"
            className="catalog-filters"
            aria-label="サービスの絞り込み"
          >
            <div className="field catalog-search">
              <label htmlFor="catalog-q">サービスを検索</label>
              <input
                id="catalog-q"
                type="search"
                name="q"
                defaultValue={query.q}
                maxLength={CATALOG_SEARCH_MAX_LENGTH}
                aria-invalid={query.q.length > CATALOG_SEARCH_MAX_LENGTH || undefined}
                aria-describedby={
                  query.q.length > CATALOG_SEARCH_MAX_LENGTH
                    ? 'catalog-search-hint catalog-query-error'
                    : 'catalog-search-hint'
                }
              />
              <span id="catalog-search-hint" className="visually-hidden">
                サービス名・説明・対象から探せます。
              </span>
            </div>
            {query.target && <input type="hidden" name="target" value={query.target} />}
            <div className="catalog-filter-actions">
              <button type="submit">絞り込む</button>
              <Link href={catalogHref(query, { q: '', target: '', page: 1 })}>条件を解除</Link>
            </div>
          </form>

          {queryError ? (
            <section className="catalog-message" role="alert">
              <h2>検索条件を確認してください</h2>
              <p id="catalog-query-error">{queryError}</p>
              <a href="#catalog-q">条件を修正する</a>
            </section>
          ) : !result.ok ? (
            <section className="catalog-message" role="alert">
              <h2>
                {result.problem.status === 403
                  ? 'サービスを表示する権限がありません'
                  : result.problem.status === 400
                    ? 'カタログの取得条件を確認してください'
                    : 'カタログを読み込めませんでした'}
              </h2>
              <p>
                {result.problem.status === 403
                  ? '選択中の組織と利用権限を管理者に確認してください。'
                  : result.problem.status === 400
                    ? '条件を解除して再度お試しください。'
                    : '時間をおいて再度お試しください。検索条件は保持しています。'}
              </p>
              <a href={currentHref}>再読み込み</a>
            </section>
          ) : (
            <>
              <div className="catalog-result" role="status">
                <span>
                  <strong>{selection.filtered}件</strong> / 公開サービス {selection.total}件
                </span>
                <span>
                  {selection.items.length > 0
                    ? `${selection.from}〜${selection.to}件を表示 · `
                    : ''}
                  {selection.page}ページ目
                </span>
              </div>
              {selection.items.length === 0 ? (
                <section className="catalog-message">
                  <h2>
                    {selection.total === 0
                      ? '公開中のサービスはありません'
                      : selection.filtered === 0
                        ? '条件に合うサービスはありません'
                        : 'このページにサービスはありません'}
                  </h2>
                  <p>
                    {selection.total === 0
                      ? 'サービスの受付が始まるとここに表示されます。メニューにない依頼は一般相談から送れます。'
                      : selection.filtered === 0
                        ? '検索語や対象を変えるか、条件を解除してお試しください。'
                        : '公開サービスが変わった可能性があります。同じ条件の最初のページから確認してください。'}
                  </p>
                  {selection.filtered > 0 ? (
                    <Link href={catalogHref(query, { page: 1 })}>最初のページへ</Link>
                  ) : selection.total > 0 ? (
                    <Link href="/catalog">条件を解除してすべて表示</Link>
                  ) : (
                    <Link href={withReturnTo('/tickets/new?kind=request', currentHref)}>
                      メニューにない依頼・一般相談を送る
                    </Link>
                  )}
                </section>
              ) : (
                <ul className="fs-catalog-grid">
                  {selection.items.map((item) => (
                    <li key={item.id}>
                      <Link
                        className="fs-catalog-card"
                        href={withReturnTo(`/catalog/${encodeURIComponent(item.id)}`, currentHref)}
                      >
                        <span className="fs-catalog-icon" aria-hidden="true">
                          <FreshserviceIcon name="grid" size={22} />
                        </span>
                        <span className="fs-catalog-card-body">
                          <strong>{item.title}</strong>
                          <span className="fs-catalog-description">{item.description}</span>
                          <span className="fs-catalog-target">
                            {item.definition.targetLabel || '対象未設定'}
                          </span>
                        </span>
                        <FreshserviceIcon name="chevron" size={16} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {selection.items.length > 0 && selection.pageCount > 1 && (
                <nav className="catalog-pagination" aria-label="サービスカタログのページ">
                  {selection.page > 1 && (
                    <Link href={catalogHref(query, { page: selection.page - 1 })}>前のページ</Link>
                  )}
                  <span>
                    {selection.page} / {selection.pageCount} ページ
                  </span>
                  {selection.page < selection.pageCount && (
                    <Link href={catalogHref(query, { page: selection.page + 1 })}>次のページ</Link>
                  )}
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
