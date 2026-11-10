import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { KnowledgeManagement } from '../../../components/KnowledgeEditor';
import { safeReturnTo } from '../../../lib/navigation';
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
  const manage =
    query.manage === '1' &&
    session.roles.some((r) => ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode));
  const result = await api.knowledgeDetail(id, manage);
  if (!result.ok) {
    if (result.problem.status === 404) notFound();
    const returnTo = safeReturnTo(query.returnTo);
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retryQuery = new URLSearchParams();
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
          <a href={returnTo ?? (manage ? '/knowledge?manage=1' : '/knowledge')}>
            {returnTo ? '元の画面へ戻る' : '記事一覧へ戻る'}
          </a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const { article, versions } = result.data;
  const labels = {
    draft: '下書き',
    review: 'レビュー待ち',
    published: '公開済み',
    retired: '取り下げ済み',
  };
  return (
    <main id="main" className="shell">
      <ContextLink back href={manage ? '/knowledge?manage=1' : '/knowledge'}>
        記事一覧へ戻る
      </ContextLink>
      <h1>{article.title}</h1>
      {query.saved === '1' && (
        <p role="status" className="success">
          記事を保存しました。
        </p>
      )}
      <p className="hint">
        版 {article.contentVersion} · {article.audience === 'staff' ? '担当者限定' : '組織内'}
        {manage && ` · ${labels[article.state]}`}
      </p>
      {manage ? (
        <>
          {article.publishedVersion && article.state !== 'retired' && (
            <p>
              <ContextLink href={`/knowledge/${id}`}>利用者に公開している版を見る</ContextLink>（版{' '}
              {article.publishedVersion}）
            </p>
          )}
          {(article.state === 'review' || article.state === 'retired') && (
            <article className="form-panel" style={{ whiteSpace: 'pre-wrap' }}>
              {article.body}
            </article>
          )}
          <KnowledgeManagement
            key={`${article.id}-${article.version}`}
            article={article}
            canPublish={session.roles.some((r) =>
              ['org_admin', 'platform_admin'].includes(r.roleCode),
            )}
            versions={versions}
          />
        </>
      ) : (
        <>
          <article className="form-panel" style={{ whiteSpace: 'pre-wrap' }}>
            {article.body}
          </article>
          <p className="hint">{article.tags}</p>
          <p>
            解決しない場合は
            <ContextLink href="/tickets/new?kind=incident">問い合わせてください</ContextLink>。
          </p>
        </>
      )}
    </main>
  );
}
