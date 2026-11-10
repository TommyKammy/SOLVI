import React from 'react';
import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { navigationRoles, withReturnTo } from '../../lib/navigation';
import {
  KNOWLEDGE_PAGE_SIZE,
  KNOWLEDGE_SEARCH_MAX_LENGTH,
  knowledgeExcerpt,
  knowledgeHighlights,
  knowledgeHref,
  parseKnowledgeQuery,
  type HighlightPart,
} from '../../lib/knowledge-search';

export const dynamic = 'force-dynamic';

function Highlight({ parts }: { parts: HighlightPart[] }) {
  return parts.map((part, index) =>
    part.match ? <mark key={index}>{part.text}</mark> : part.text,
  );
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const staff = navigationRoles(session).staff;
  const query = parseKnowledgeQuery(await searchParams, staff);
  const currentHref = knowledgeHref(query);
  const firstHref = knowledgeHref({ q: query.q, manage: query.manage });
  const clearHref = knowledgeHref({ q: '', manage: query.manage });
  const result = query.error
    ? null
    : await api.knowledgeList(query.q, query.manage, {
        limit: KNOWLEDGE_PAGE_SIZE,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
  const searching = query.q.length > 0;
  const labels = {
    draft: '下書き',
    review: 'レビュー待ち',
    published: '公開済み',
    retired: '取り下げ済み',
  };
  const pagination = (position: '上' | '下') =>
    result?.ok &&
    result.data.total > 0 &&
    (query.cursor || result.data.previousCursor || result.data.nextCursor) && (
      <nav className="knowledge-pagination" aria-label={`ナレッジ検索結果のページ（${position}）`}>
        {query.cursor && <Link href={firstHref}>最初の結果へ</Link>}
        {result.data.previousCursor && (
          <Link href={knowledgeHref({ ...query, cursor: result.data.previousCursor })}>
            前の結果
          </Link>
        )}
        {result.data.nextCursor && (
          <Link href={knowledgeHref({ ...query, cursor: result.data.nextCursor })}>次の結果</Link>
        )}
      </nav>
    );

  return (
    <main id="main" className="shell knowledge-search">
      <div className="page-heading knowledge-heading">
        <div>
          <h1>{query.manage ? 'ナレッジの管理' : 'ナレッジを探す'}</h1>
          <p className="hint">
            {query.manage
              ? '記事の内容と公開状況を確認できます。'
              : 'よくある質問や対応手順を、タイトル・本文・タグから探せます。'}
          </p>
        </div>
        {staff && (
          <nav className="knowledge-utilities" aria-label="ナレッジの表示と管理">
            <Link href={knowledgeHref({ q: query.q, manage: !query.manage })}>
              {query.manage ? '公開された記事を見る' : '記事を作成・管理する'}
            </Link>
            {query.manage && (
              <Link className="text-action" href={withReturnTo('/knowledge/new', currentHref)}>
                新しい記事を書く
              </Link>
            )}
          </nav>
        )}
      </div>

      <form
        key={currentHref}
        action="/knowledge"
        method="get"
        className="knowledge-filters"
        aria-label="ナレッジを検索"
      >
        <div className="field">
          <label htmlFor="knowledge-q">検索する言葉</label>
          <input
            id="knowledge-q"
            type="search"
            name="q"
            defaultValue={query.q}
            maxLength={KNOWLEDGE_SEARCH_MAX_LENGTH}
            placeholder="例: VPN、パスワード"
            aria-describedby="knowledge-search-hint"
          />
          <span id="knowledge-search-hint" className="visually-hidden">
            タイトル・本文・タグを部分一致で検索します。
          </span>
        </div>
        {query.manage && <input type="hidden" name="manage" value="1" />}
        <div className="knowledge-filter-actions">
          <button type="submit">検索する</button>
          {(query.q || query.cursor) && <Link href={clearHref}>検索条件を解除</Link>}
        </div>
      </form>

      {query.error ? (
        <section className="knowledge-message" role="alert">
          <h2>検索条件を確認してください</h2>
          <p>結果の取得位置が正しくありません。同じ検索条件の最初の結果から確認してください。</p>
          <Link href={firstHref}>最初の結果へ</Link>
        </section>
      ) : result && !result.ok ? (
        <section className="knowledge-message" role="alert">
          <h2>
            {result.problem.status === 403
              ? '記事を表示する権限がありません'
              : result.problem.status === 400
                ? '検索条件を確認してください'
                : result.problem.status === 401
                  ? 'ログイン状態を確認してください'
                  : '記事を読み込めませんでした'}
          </h2>
          <p>
            {result.problem.status === 403
              ? '選択中の組織と利用権限を管理者に確認してください。'
              : result.problem.status === 400
                ? '検索条件や取得位置が変わった可能性があります。同じ条件の最初の結果から確認してください。'
                : result.problem.status === 401
                  ? 'ログイン状態が変わった可能性があります。再読み込みして現在の状態を確認してください。'
                  : '時間をおいて再度お試しください。検索条件は保持しています。'}
          </p>
          <div className="knowledge-recovery">
            <a href={currentHref}>再読み込み</a>
            {result.problem.status === 400 ? (
              <Link href={firstHref}>最初の結果へ</Link>
            ) : (
              <Link href="/portal">利用者ポータルへ</Link>
            )}
          </div>
        </section>
      ) : result?.ok ? (
        <>
          <div className="knowledge-result" role="status">
            <p>
              <strong>{result.data.total}件</strong>
              {searching ? 'の検索結果' : query.manage ? 'の記事' : 'の公開記事'}
            </p>
            <p>この画面に{result.data.items.length}件を表示</p>
          </div>
          {result.data.items.length > 0 && pagination('上')}
          {result.data.items.length === 0 ? (
            <section className="knowledge-message">
              <h2>
                {query.cursor && result.data.total > 0
                  ? 'この取得位置に記事はありません'
                  : searching
                    ? '条件に合う記事はありません'
                    : query.manage
                      ? '記事はまだ登録されていません'
                      : '公開中の記事はありません'}
              </h2>
              <p>
                {query.cursor && result.data.total > 0
                  ? '記事の公開状況や検索結果が変わった可能性があります。同じ条件の最初の結果から確認してください。'
                  : searching
                    ? '別の言葉で検索するか、条件を解除して記事を確認してください。'
                    : query.manage
                      ? '新しい記事を作成すると、ここで内容や公開状況を確認できます。'
                      : '公開された記事がここに表示されます。解決したいことは問い合わせから相談できます。'}
              </p>
              <div className="knowledge-recovery">
                {query.cursor ? (
                  <Link href={firstHref}>最初の結果へ</Link>
                ) : searching ? (
                  <>
                    <a href="#knowledge-q">検索語を修正する</a>
                    <Link href={clearHref}>条件を解除してすべて表示</Link>
                  </>
                ) : query.manage ? (
                  <Link href={withReturnTo('/knowledge/new', currentHref)}>新しい記事を書く</Link>
                ) : (
                  <Link href={withReturnTo('/tickets/new?kind=incident', currentHref)}>
                    問い合わせる
                  </Link>
                )}
              </div>
            </section>
          ) : (
            <ul className="knowledge-results">
              {result.data.items.map((article) => {
                const excerpt = knowledgeExcerpt(article.body, query.q);
                return (
                  <li key={article.id}>
                    <h2>
                      <Link
                        href={withReturnTo(
                          `/knowledge/${encodeURIComponent(article.id)}${query.manage ? '?manage=1' : ''}`,
                          currentHref,
                        )}
                      >
                        <Highlight parts={knowledgeHighlights(article.title, query.q)} />
                      </Link>
                    </h2>
                    <p className="knowledge-excerpt">
                      {excerpt.leading && '…'}
                      <Highlight parts={excerpt.parts} />
                      {excerpt.trailing && '…'}
                    </p>
                    <div className="knowledge-meta">
                      <span>{article.audience === 'staff' ? '担当者限定' : '組織内'}</span>
                      <span>版 {article.contentVersion}</span>
                      {query.manage && (
                        <span className="knowledge-state">{labels[article.state]}</span>
                      )}
                    </div>
                    {article.tags && (
                      <p className="knowledge-tags">
                        タグ: <Highlight parts={knowledgeHighlights(article.tags, query.q)} />
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {result.data.items.length > 0 && pagination('下')}
        </>
      ) : null}
    </main>
  );
}
