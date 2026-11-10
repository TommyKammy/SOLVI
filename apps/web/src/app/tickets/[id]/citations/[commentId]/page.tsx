import { ContextLink } from '../../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../../lib/api';
import { safeReturnTo } from '../../../../../lib/navigation';
export default async function CitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; commentId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const { id, commentId } = await params;
  const query = (await searchParams) ?? {};
  const result = await api.citationContent(id, commentId);
  if (!result.ok) {
    if (result.problem.status === 404) notFound();
    const encodeSegment = (value: string): string | null => {
      if (value === '' || value === '.' || value === '..') return null;
      try {
        return encodeURIComponent(value);
      } catch {
        return null;
      }
    };
    const ticket = encodeSegment(id);
    const comment = encodeSegment(commentId);
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const retryHref =
      ticket !== null && comment !== null
        ? `/tickets/${ticket}/citations/${comment}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
        : null;
    const staff = session.roles.some((r) =>
      ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode),
    );
    const fallback = `/${staff ? 'ops' : 'tickets'}${ticket !== null ? '/' + ticket : ''}`;
    const message =
      result.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : result.problem.status === 403
          ? '引用記事を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : result.problem.status === 400
            ? '引用記事の指定が正しくありません。問い合わせから開き直してください。'
            : '一時的に引用記事を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>引用記事を表示できません</h1>
        <p role="alert">{message}</p>
        {retryHref && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
        <p>
          <a href={returnTo ?? fallback}>
            {returnTo ? '元の画面へ戻る' : ticket !== null ? '問い合わせへ戻る' : '一覧へ戻る'}
          </a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  const article = result.data;
  const staff = session.roles.some((r) =>
    ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode),
  );
  return (
    <main id="main" className="shell">
      <ContextLink back href={`/${staff ? 'ops' : 'tickets'}/${id}`}>
        問い合わせへ戻る
      </ContextLink>
      <h1>{article.title}</h1>
      <p className="hint">
        返信で引用した版 {article.version}{' '}
        を表示しています。記事の最新の版とは異なる場合があります。
      </p>
      <article className="form-panel" style={{ whiteSpace: 'pre-wrap' }}>
        {article.body}
      </article>
      <p>
        <ContextLink href={`/knowledge/${article.articleId}`}>
          現在公開されている記事を確認する
        </ContextLink>
      </p>
    </main>
  );
}
