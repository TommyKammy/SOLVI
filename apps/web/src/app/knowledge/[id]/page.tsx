import { KnowledgeBody } from '../../../components/KnowledgeBody';
import { ContextLink } from '../../../components/ContextLink';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { KnowledgeManagement } from '../../../components/KnowledgeEditor';
import {
  isPortalView,
  navigationRoles,
  portalViewHref,
  safeReturnTo,
  withReturnTo,
} from '../../../lib/navigation';
import { formatDateTime } from '../../../lib/labels';
import { knowledgeHref } from '../../../lib/knowledge-search';
export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;
  const roles = navigationRoles(session);
  const portalView = isPortalView(query.portal);
  const staff = !portalView && roles.staff;
  const manage = query.manage === '1' && staff;
  const listHref = portalViewHref(manage ? '/knowledge?manage=1' : '/knowledge', portalView);
  const result = portalView
    ? await api.knowledgeDetail(id, false, 'organization')
    : await api.knowledgeDetail(id, manage);
  if (!result.ok) {
    if (result.problem.status === 404) notFound();
    const returnTo = safeReturnTo(query.returnTo);
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retryQuery = new URLSearchParams();
    if (portalView) retryQuery.set('portal', '1');
    if (manage) retryQuery.set('manage', '1');
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const retryHref = validId
      ? `/knowledge/${encodeURIComponent(id)}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
      : '';
    const message =
      result.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : result.problem.status === 403
          ? 'この記事を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : result.problem.status === 400
            ? '記事の指定が正しくありません。記事一覧から開き直してください。'
            : '一時的に記事を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>記事を表示できません</h1>
        <p role="alert">{message}</p>
        {validId && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? listHref}>{returnTo ? '元の画面へ戻る' : '記事一覧へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const { article, versions } = result.data;
  const audience = article.audience === 'staff' ? '担当者限定' : '組織内';
  const backHref = safeReturnTo(query.returnTo) ?? listHref;
  const backLocation = new URL(backHref, 'https://solvi.local');
  const review = article.state === 'review' || article.state === 'retired';
  const tags = [...new Set(article.tags.split(/[,、\s]+/u).filter(Boolean))];
  const labels = {
    draft: '下書き',
    review: 'レビュー待ち',
    published: '公開済み',
    retired: '取り下げ済み',
  };
  return (
    <main id="main" className="shell service-workspace knowledge-article">
      <header className="support-page-heading">
        <div>
          <Link className="support-back" href={backHref}>
            {backLocation.pathname === '/knowledge'
              ? '記事一覧へ戻る'
              : backLocation.pathname === `/knowledge/${id}` &&
                  backLocation.searchParams.get('manage') === '1'
                ? '記事の管理に戻る'
                : '元の画面へ戻る'}
          </Link>
          <h1>{article.title}</h1>
          {manage && (
            <p className="knowledge-article-states">
              <span className="knowledge-state" data-knowledge-state={article.state}>
                {labels[article.state]}
              </span>
              <span>作業版 {article.contentVersion}</span>
              <span>{audience}</span>
            </p>
          )}
        </div>
        {manage && article.publishedVersion !== null && article.state !== 'retired' && (
          <Link
            className="support-action"
            href={{
              pathname: `/knowledge/${id}`,
              query: { returnTo: withReturnTo(`/knowledge/${id}?manage=1`, backHref) },
            }}
          >
            公開中の版を見る（版 {article.publishedVersion}）
          </Link>
        )}
        {!manage && staff && (
          <Link
            className="support-action"
            href={withReturnTo(`/knowledge/${encodeURIComponent(id)}?manage=1`, backHref)}
          >
            記事を管理する
          </Link>
        )}
      </header>
      {query.saved === '1' && (
        <p role="status" className="success">
          記事を保存しました。
        </p>
      )}
      {manage ? (
        <div className={review ? 'knowledge-reader-layout' : undefined}>
          {review && (
            <article className="knowledge-reader-panel" aria-labelledby="knowledge-review-title">
              <h2 id="knowledge-review-title">
                {article.state === 'review' ? 'レビュー対象の内容' : '取り下げた版の内容'}
              </h2>
              <KnowledgeBody article={article} />
              {article.tags && <p className="hint">タグ {article.tags}</p>}
            </article>
          )}
          <KnowledgeManagement
            key={`${article.id}-${article.version}`}
            article={article}
            canPublish={roles.admin}
            versions={versions}
          />
        </div>
      ) : (
        <div className="knowledge-reader-layout">
          <article className="knowledge-reader-panel" aria-labelledby="knowledge-body-title">
            <h2 id="knowledge-body-title">記事の内容</h2>
            <KnowledgeBody article={article} />
            {!staff && (
              <div className="knowledge-reader-help">
                <ContextLink href="/tickets/new?kind=incident">
                  この記事で解決しない場合は障害を報告する
                </ContextLink>
              </div>
            )}
          </article>
          <aside className="knowledge-reader-panel" aria-labelledby="knowledge-info-title">
            <h2 id="knowledge-info-title">この記事の情報</h2>
            <dl>
              <dt>公開範囲</dt>
              <dd>{audience}</dd>
              <dt>公開版</dt>
              <dd>版 {article.contentVersion}</dd>
              <dt>公開版の更新</dt>
              <dd>
                <time dateTime={article.versionCreatedAt}>
                  {formatDateTime(article.versionCreatedAt)}
                </time>
              </dd>
            </dl>
            {tags.length > 0 && (
              <nav className="knowledge-tag-links" aria-label="記事のタグ">
                {tags.map((tag) => (
                  <Link
                    key={tag}
                    href={portalViewHref(knowledgeHref({ q: tag, manage: false }), portalView)}
                  >
                    {tag}
                  </Link>
                ))}
              </nav>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
