import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { stateLabel, kindLabel, formatDateTime } from '../../lib/labels';
import { TicketPagination } from '../../components/TicketPagination';
import { FreshserviceIcon } from '../../components/FreshserviceIcon';
import {
  CATALOG_SEARCH_MAX_LENGTH,
  parsePortalQuery,
  portalHref,
  portalNavigationQuery,
  portalTicketFilter,
  portalTicketNextAction,
} from '../../lib/portal-overview';

export const dynamic = 'force-dynamic';

const requestStates: Record<string, string> = {
  pending: '承認待ち',
  approved: '承認済み・模擬実行待ち',
  rejected: '却下',
  invalidated: '承認取消・再申請待ち',
  completed: '模擬実行完了',
  cancelled: '取消',
};

type SupportTab = 'tickets' | 'requests' | 'services';

function PortalLoadError({
  status,
  retryHref,
  firstHref,
}: {
  status: number;
  retryHref: string;
  firstHref?: string;
}) {
  return (
    <div className="portal-message" role="alert">
      <p>
        {status === 403
          ? 'この情報を表示する権限がありません。選択中の組織と利用権限を確認してください。'
          : status === 400
            ? '一覧の条件を確認してください。最初のページから確認できます。'
            : '情報を取得できませんでした。時間をおいて再度お試しください。'}
      </p>
      <a href={retryHref}>再読み込み</a>
      {firstHref && <Link href={firstHref}>最初のページへ戻る</Link>}
    </div>
  );
}

export default async function PortalHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const raw = await searchParams;
  const query = parsePortalQuery(raw);
  const tab: SupportTab =
    raw.tab === 'requests' ? 'requests' : raw.tab === 'services' ? 'services' : 'tickets';
  const baseHref = portalHref(query);
  const currentHref =
    tab === 'tickets' ? baseHref : `${baseHref}${baseHref.includes('?') ? '&' : '?'}tab=${tab}`;
  const firstHref = portalHref({ ...query, page: 1, cursor: null });
  const tabHref = (next: SupportTab) => (next === 'tickets' ? '/portal' : `/portal?tab=${next}`);

  // API認可を維持し、URLから来た他人のIDを本人条件に使わない。
  const [tickets, requests, catalog] = await Promise.all([
    api.listTickets(10, portalTicketFilter(session.userId, query)),
    api.serviceRequests('view=mine&page=1'),
    api.catalog(),
  ]);
  const recentRequests = requests.ok
    ? requests.data.items.filter((request) => request.own).slice(0, 3)
    : [];

  return (
    <main id="main" className="support-main">
      <section className="support-hero" aria-labelledby="support-hero-title">
        <div className="support-hero-inner">
          <h1 id="support-hero-title">どういった事でお困りですか？</h1>
          <form className="support-search" action="/knowledge" method="get" role="search">
            <FreshserviceIcon name="search" size={22} />
            <label className="visually-hidden" htmlFor="support-search-input">
              ヘルプ記事を検索
            </label>
            <input
              id="support-search-input"
              type="search"
              name="q"
              maxLength={200}
              placeholder="ヘルプ記事を検索"
            />
            <button type="submit" className="visually-hidden">
              検索
            </button>
          </form>
        </div>
      </section>

      <section className="support-cards" aria-label="よく使う操作">
        <div className="support-cards-grid">
          <Link
            className="support-card support-card--service"
            href={{ pathname: '/catalog', query: { returnTo: currentHref } }}
          >
            <span className="support-card-icon" aria-hidden="true">
              <FreshserviceIcon name="grid" size={30} />
            </span>
            <span className="support-card-text">
              <strong>サービスをリクエストする</strong>
              <span>提供されているサービスから必要なものを選び、申請します。</span>
            </span>
          </Link>
          <Link
            className="support-card support-card--incident"
            href={{
              pathname: '/tickets/new',
              query: { kind: 'incident', returnTo: currentHref },
            }}
          >
            <span className="support-card-icon" aria-hidden="true">
              <FreshserviceIcon name="ticket" size={30} />
            </span>
            <span className="support-card-text">
              <strong>問題を報告する</strong>
              <span>困っていることをサポートチームへ連絡します。</span>
            </span>
          </Link>
          <Link className="support-card support-card--knowledge" href="/knowledge">
            <span className="support-card-icon" aria-hidden="true">
              <FreshserviceIcon name="book" size={30} />
            </span>
            <span className="support-card-text">
              <strong>ヘルプ記事を閲覧する</strong>
              <span>よくある質問や手順を調べて、自分で解決します。</span>
            </span>
          </Link>
          <Link className="support-card support-card--approval" href="/requests?view=mine">
            <span className="support-card-icon" aria-hidden="true">
              <FreshserviceIcon name="change" size={30} />
            </span>
            <span className="support-card-text">
              <strong>アクションアイテムを完了する</strong>
              <span>保留中の承認と自分の申請を確認します。</span>
            </span>
          </Link>
        </div>
      </section>

      <section className="support-lists" aria-label="自分の状況">
        <nav className="support-tabs" aria-label="表示する情報">
          <Link href={tabHref('tickets')} aria-current={tab === 'tickets' ? 'page' : undefined}>
            オープンなチケット
          </Link>
          <Link href={tabHref('requests')} aria-current={tab === 'requests' ? 'page' : undefined}>
            申請の状況
          </Link>
          <Link href={tabHref('services')} aria-current={tab === 'services' ? 'page' : undefined}>
            サービスを探す
          </Link>
        </nav>

        <div className="support-tab-panel">
          {tab === 'tickets' ? (
            <section className="support-panel" aria-labelledby="support-tickets-title">
              <div className="support-panel-heading">
                <h2 id="support-tickets-title">あなたの問い合わせ</h2>
                <nav className="portal-ticket-views" aria-label="問い合わせの表示">
                  <Link
                    href={portalHref({ view: 'open', page: 1, cursor: null })}
                    aria-current={query.view === 'open' ? 'page' : undefined}
                  >
                    未解決
                  </Link>
                  <Link
                    href={portalHref({ view: 'all', page: 1, cursor: null })}
                    aria-current={query.view === 'all' ? 'page' : undefined}
                  >
                    すべて
                  </Link>
                </nav>
              </div>
              {!tickets.ok ? (
                <PortalLoadError
                  status={tickets.problem.status}
                  retryHref={currentHref}
                  firstHref={firstHref}
                />
              ) : (
                <>
                  <p className="portal-result" role="status">
                    {query.view === 'open' ? '未解決' : '自分の問い合わせ'} {tickets.data.total}件
                    {' · '}このページ {tickets.data.items.length}件 · {query.page}ページ目
                  </p>
                  {tickets.data.items.length === 0 ? (
                    <div className="portal-message">
                      <h3>
                        {tickets.data.total > 0
                          ? 'このページに問い合わせはありません'
                          : query.view === 'open'
                            ? '未解決の問い合わせはありません'
                            : '問い合わせはまだありません'}
                      </h3>
                      <p>
                        {tickets.data.total > 0
                          ? '一覧が更新された可能性があります。最初のページから確認してください。'
                          : query.view === 'open'
                            ? '過去の問い合わせや解決内容は「すべて」から確認できます。'
                            : 'お困りごとや依頼がある場合は、上のカードから始められます。'}
                      </p>
                      {tickets.data.total > 0 && (
                        <Link href={firstHref}>最初のページから確認する</Link>
                      )}
                    </div>
                  ) : (
                    <ul className="portal-ticket-list">
                      {tickets.data.items.map((ticket) => (
                        <li key={ticket.id}>
                          <div className="portal-ticket-line">
                            <Link
                              href={{
                                pathname: `/tickets/${encodeURIComponent(ticket.id)}`,
                                query: { returnTo: currentHref },
                              }}
                            >
                              <span className="record-number">
                                {ticket.number} · {kindLabel(ticket.kind)}
                              </span>
                              <span className="record-title">{ticket.subject}</span>
                            </Link>
                            <span className="state" data-state={ticket.state}>
                              {stateLabel(ticket.state)}
                            </span>
                          </div>
                          <div className="portal-ticket-followup">
                            <span
                              className={
                                ticket.state === 'pending' &&
                                ticket.pendingReason === 'wait_requester'
                                  ? 'portal-your-turn'
                                  : ''
                              }
                            >
                              {portalTicketNextAction(ticket)}
                            </span>
                            <span className="hint">受付 {formatDateTime(ticket.createdAt)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {tickets.data.total > 0 && (
                    <TicketPagination
                      basePath="/portal"
                      query={portalNavigationQuery(query)}
                      cursor={tickets.data.nextCursor}
                      total={tickets.data.total}
                      pageSize={10}
                      page={query.page}
                    />
                  )}
                </>
              )}
            </section>
          ) : tab === 'requests' ? (
            <section className="support-panel" aria-labelledby="support-requests-title">
              <div className="support-panel-heading">
                <h2 id="support-requests-title">最近の申請</h2>
                <Link href="/requests?view=mine">自分の申請をすべて見る</Link>
              </div>
              {!requests.ok ? (
                <PortalLoadError status={requests.problem.status} retryHref={currentHref} />
              ) : (
                <>
                  <p className="portal-result" role="status">
                    自分の申請 全{requests.data.total}件 · 更新が新しい{recentRequests.length}件
                  </p>
                  {recentRequests.length === 0 ? (
                    <div className="portal-message">
                      <h3>
                        {requests.data.total === 0
                          ? '申請はまだありません'
                          : '最近の申請を表示できません'}
                      </h3>
                      <p>
                        {requests.data.total === 0
                          ? 'サービスを選ぶと、必要事項の入力へ進めます。'
                          : '自分の申請一覧から状況を確認してください。'}
                      </p>
                    </div>
                  ) : (
                    <ul className="portal-request-list">
                      {recentRequests.map((request) => (
                        <li key={request.id}>
                          <Link
                            href={{
                              pathname: `/requests/${encodeURIComponent(request.id)}`,
                              query: { returnTo: currentHref },
                            }}
                          >
                            <span className="record-number">{request.number}</span>
                            <span className="record-title">{request.title}</span>
                          </Link>
                          <p className="portal-request-state">
                            {request.expired
                              ? '承認期限切れ・再承認が必要'
                              : (requestStates[request.state] ?? '状況を確認してください')}
                          </p>
                          <p className="portal-request-next">{request.nextAction}</p>
                          <p className="hint">更新 {formatDateTime(request.updatedAt)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          ) : (
            <div className="support-services-grid">
              <section className="support-panel" aria-labelledby="support-services-title">
                <div className="support-panel-heading">
                  <h2 id="support-services-title">サービスを探す</h2>
                  <Link href="/catalog">カタログをすべて見る</Link>
                </div>
                <form
                  action="/catalog"
                  method="get"
                  className="portal-find-form"
                  aria-label="サービスの検索"
                >
                  <label htmlFor="portal-service-q">サービス名・用途・対象で検索</label>
                  <div>
                    <input
                      id="portal-service-q"
                      name="q"
                      type="search"
                      maxLength={CATALOG_SEARCH_MAX_LENGTH}
                      placeholder="アカウント、Box、PC…"
                    />
                    <button type="submit">サービスを検索</button>
                  </div>
                </form>
                <p className="hint">
                  ローカル模擬申請です。実際のアカウント作成・権限付与・貸出は行いません。
                </p>
                {!catalog.ok ? (
                  <PortalLoadError status={catalog.problem.status} retryHref={currentHref} />
                ) : catalog.data.items.length === 0 ? (
                  <p className="portal-message">
                    公開中のサービスはありません。メニューにない依頼は一般相談から送れます。
                  </p>
                ) : (
                  <ul className="portal-service-links">
                    {catalog.data.items.slice(0, 6).map((item) => (
                      <li key={item.id}>
                        <Link
                          href={{
                            pathname: `/catalog/${encodeURIComponent(item.id)}`,
                            query: { returnTo: currentHref },
                          }}
                        >
                          {item.title}
                          <span aria-hidden="true"> →</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <Link
                  href={{
                    pathname: '/tickets/new',
                    query: { kind: 'request', returnTo: currentHref },
                  }}
                >
                  メニューにない依頼・一般相談を送る
                </Link>
              </section>

              <section className="support-panel" aria-labelledby="support-knowledge-title">
                <div className="support-panel-heading">
                  <h2 id="support-knowledge-title">解決のヒントを探す</h2>
                  <Link href="/knowledge">ナレッジをすべて見る</Link>
                </div>
                <form action="/knowledge" method="get" className="portal-find-form">
                  <label htmlFor="portal-knowledge-q">ナレッジを検索</label>
                  <div>
                    <input
                      id="portal-knowledge-q"
                      name="q"
                      type="search"
                      placeholder="VPN、Wi-Fi、パスワード…"
                      maxLength={200}
                    />
                    <button type="submit">ナレッジを検索</button>
                  </div>
                </form>
                <p className="hint">ヒーローの検索欄からも、同じナレッジ検索を利用できます。</p>
              </section>
            </div>
          )}
        </div>
      </section>

      <footer className="support-footer">SOLVI — 社内ITサービス管理</footer>
    </main>
  );
}
