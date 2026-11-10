import React from 'react';
import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { navigationRoles, withReturnTo } from '../../lib/navigation';
import { formatDateTime } from '../../lib/labels';
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

function parseTags(tags: string): string[] {
  return tags
    .split(/[,、\s]+/u)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date);
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
  const tagCounts = new Map<string, number>();
  if (result?.ok) {
    for (const article of result.data.items) {
      for (const tag of parseTags(article.tags)) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .slice(0, 12);
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
    <main id="main" className="shell knowledge-search fs-knowledge">
      <div className="fs-page-with-sidebar">
        <aside className="fs-side-nav" aria-label="ナレッジのカテゴリ">
          <p className="fs-side-nav-heading">ナレッジ</p>
          <nav className="fs-side-nav-links">
            <Link
              href={knowledgeHref({ q: '', manage: false })}
              aria-current={!query.manage && !query.q ? 'page' : undefined}
            >
              すべての記事
            </Link>
            {staff && (
              <Link
                href={knowledgeHref({ q: '', manage: true })}
                aria-current={query.manage ? 'page' : undefined}
              >
                ナレッジ管理
              </Link>
            )}
            {staff && <Link href={withReturnTo('/knowledge/new', currentHref)}>記事を作成</Link>}
          </nav>
          {topTags.length > 0 && (
            <>
              <p className="fs-side-nav-heading fs-side-nav-heading--tags">
                タグ <span className="hint">表示中の記事</span>
              </p>
              <nav className="fs-side-nav-links fs-side-nav-tags" aria-label="タグ">
                {topTags.map(([tag, count]) => (
                  <Link
                    key={tag}
                    href={knowledgeHref({ q: tag, manage: query.manage })}
                    aria-current={query.q === tag ? 'page' : undefined}
                  >
                    <span>{tag}</span>
                    <span className="fs-side-nav-count">{count}</span>
                  </Link>
                ))}
              </nav>
            </>
          )}
        </aside>

        <section className="fs-page-main" aria-label="ナレッジ検索結果">
          <div className="page-heading knowledge-heading">
            <div>
              <h1>{query.manage ? 'ナレッジの管理' : 'ナレッジを探す'}</h1>
              <p className="hint">
                {query.manage
                  ? '記事の内容と公開状況を確認できます。'
                  : 'よくある質問や対応手順を、タイトル・本文・タグから探せます。'}
              </p>
            </div>
            {staff && query.manage && (
              <nav className="knowledge-utilities" aria-label="ナレッジの表示と管理">
                <Link className="text-action" href={withReturnTo('/knowledge/new', currentHref)}>
                  新しい記事を書く
                </Link>
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
              <p>
                結果の取得位置が正しくありません。同じ検索条件の最初の結果から確認してください。
              </p>
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
                      <Link href={withReturnTo('/knowledge/new', currentHref)}>
                        新しい記事を書く
                      </Link>
                    ) : (
                      <Link href={withReturnTo('/tickets/new?kind=incident', currentHref)}>
                        問い合わせる
                      </Link>
                    )}
                  </div>
                </section>
              ) : (
                <div className="table-scroll">
                  <table className="fs-knowledge-table">
                    <caption className="visually-hidden">
                      ナレッジ記事 {result.data.total}件中 {result.data.items.length}件を表示
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">タイトル</th>
                        <th scope="col">状態</th>
                        <th scope="col">公開範囲</th>
                        <th scope="col">版</th>
                        <th scope="col">更新日</th>
                        <th scope="col">タグ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.data.items.map((article) => {
                        const excerpt = knowledgeExcerpt(article.body, query.q);
                        return (
                          <tr key={article.id}>
                            <td className="fs-knowledge-title">
                              <Link
                                href={withReturnTo(
                                  `/knowledge/${encodeURIComponent(article.id)}${query.manage ? '?manage=1' : ''}`,
                                  currentHref,
                                )}
                              >
                                <Highlight parts={knowledgeHighlights(article.title, query.q)} />
                              </Link>
                              <p className="hint">
                                {excerpt.leading && '…'}
                                <Highlight parts={excerpt.parts} />
                                {excerpt.trailing && '…'}
                              </p>
                            </td>
                            <td>
                              <span className="knowledge-state">{labels[article.state]}</span>
                            </td>
                            <td>{article.audience === 'staff' ? '担当者限定' : '組織内'}</td>
                            <td>v{article.contentVersion}</td>
                            <td
                              title={formatDateTime(article.versionCreatedAt)}
                              className="fs-knowledge-date"
                            >
                              {formatDate(article.versionCreatedAt)}
                            </td>
                            <td className="fs-knowledge-tags">
                              {article.tags ? (
                                <Highlight parts={knowledgeHighlights(article.tags, query.q)} />
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {result.data.items.length > 0 && pagination('下')}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
