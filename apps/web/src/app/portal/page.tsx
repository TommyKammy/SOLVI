import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { stateLabel, kindLabel, formatDate, formatDateTime } from '../../lib/labels';
import { TicketPagination } from '../../components/TicketPagination';
import { FreshserviceIcon } from '../../components/FreshserviceIcon';
import { navigationRoles, withReturnTo } from '../../lib/navigation';
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
  const hasWork = navigationRoles(session).inbox;
  const raw = await searchParams;
  const query = parsePortalQuery(raw);
  const tab: SupportTab =
    raw.tab === 'requests' ? 'requests' : raw.tab === 'services' ? 'services' : 'tickets';
  const ticketList =
    tab === 'tickets' && (raw.tab === 'tickets' || query.view === 'all' || query.cursor !== null);
  const home = tab === 'tickets' && !ticketList;
  const listHref = (href: string) => href + (href.includes('?') ? '&' : '?') + 'tab=tickets';
  const baseHref = portalHref(query);
  const currentHref = home
    ? '/portal'
    : tab === 'tickets'
      ? listHref(baseHref)
      : `/portal?tab=${tab}`;
  const firstHref = listHref(portalHref({ ...query, page: 1, cursor: null }));
  const reportHref = withReturnTo('/tickets/new?kind=incident', currentHref);
  const listQuery = portalNavigationQuery(query);
  listQuery.set('tab', 'tickets');

  // API認可を維持し、URLから来た他人のIDを本人条件に使わない。
  const [tickets, requests, catalog] = await Promise.all([
    api.listTickets(
      home ? 3 : 10,
      portalTicketFilter(session.userId, home ? { ...query, view: 'all' } : query),
    ),
    api.serviceRequests('view=mine&page=1'),
    api.catalog(),
  ]);
  const recentRequests = requests.ok
    ? requests.data.items.filter((request) => request.own).slice(0, 3)
    : [];

  return (
    <main id="main" className="support-main">
      {home ? (
        <section className="support-hero" aria-labelledby="support-hero-title">
          <div className="support-hero-inner">
            <h1 id="support-hero-title">どういったことでお困りですか？</h1>
            <div className="support-primary-actions">
              <Link className="support-action support-action--primary" href={reportHref}>
                <FreshserviceIcon name="ticket" size={18} /> 障害を報告する
              </Link>
              <Link className="support-action" href="/portal?tab=tickets">
                <FreshserviceIcon name="portal" size={18} /> 自分の問い合わせを見る
              </Link>
              <Link className="support-action" href="/catalog">
                <FreshserviceIcon name="grid" size={18} /> サービスを探す
              </Link>
            </div>
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
              <button type="submit">検索</button>
            </form>
          </div>
        </section>
      ) : (
        <header className="support-page-heading">
          <div>
            <Link className="support-back" href="/portal">
              ポータルに戻る
            </Link>
            <h1>
              {tab === 'tickets'
                ? '自分の問い合わせ'
                : tab === 'requests'
                  ? '申請の状況'
                  : 'サービスを探す'}
            </h1>
          </div>
          {ticketList && (
            <Link className="support-action support-action--primary" href={reportHref}>
              <FreshserviceIcon name="ticket" size={18} /> 障害を報告する
            </Link>
          )}
        </header>
      )}

      <section className="support-lists" aria-label="自分の状況">
        <div className="support-tab-panel">
          {tab === 'tickets' ? (
            <section className="support-panel" aria-labelledby="support-tickets-title">
              <div className="support-panel-heading">
                <h2
                  id="support-tickets-title"
                  className={ticketList ? 'visually-hidden' : undefined}
                >
                  {home ? '最近の問い合わせ' : '問い合わせ一覧'}
                </h2>
                {home ? (
                  <Link href="/portal?tab=tickets&view=all">すべての問い合わせを見る</Link>
                ) : (
                  <nav className="portal-ticket-views" aria-label="問い合わせの表示">
                    <Link
                      href="/portal?tab=tickets"
                      aria-current={query.view === 'open' ? 'page' : undefined}
                    >
                      未解決
                    </Link>
                    <Link
                      href="/portal?tab=tickets&view=all"
                      aria-current={query.view === 'all' ? 'page' : undefined}
                    >
                      すべて
                    </Link>
                  </nav>
                )}
              </div>
              {!tickets.ok ? (
                <PortalLoadError
                  status={tickets.problem.status}
                  retryHref={currentHref}
                  firstHref={ticketList ? firstHref : undefined}
                />
              ) : (
                <>
                  {ticketList && (
                    <p className="portal-result" role="status">
                      {query.view === 'open' ? '未解決' : '自分の問い合わせ'} {tickets.data.total}件
                      {' · '}このページ {tickets.data.items.length}件 · {query.page}ページ目
                    </p>
                  )}
                  {tickets.data.items.length === 0 ? (
                    <div className="portal-message">
                      <h3>
                        {tickets.data.total > 0
                          ? 'このページに問い合わせはありません'
                          : ticketList && query.view === 'open'
                            ? '未解決の問い合わせはありません'
                            : '問い合わせはまだありません'}
                      </h3>
                      <p>
                        {tickets.data.total > 0
                          ? '一覧が更新された可能性があります。最初のページから確認してください。'
                          : ticketList && query.view === 'open'
                            ? '過去の問い合わせや解決内容は「すべて」から確認できます。'
                            : '障害を報告すると、ここから受付番号や担当者の返信を確認できます。'}
                      </p>
                      {tickets.data.total > 0 && (
                        <Link href={firstHref}>最初のページから確認する</Link>
                      )}
                    </div>
                  ) : (
                    <ul className="portal-ticket-list">
                      {tickets.data.items.map((ticket) => (
                        <li key={ticket.id}>
                          <Link
                            className="support-ticket-row"
                            href={{
                              pathname: `/tickets/${encodeURIComponent(ticket.id)}`,
                              query: { returnTo: currentHref },
                            }}
                          >
                            <FreshserviceIcon name="ticket" size={18} />
                            <span className="support-ticket-row-copy">
                              <span className="record-title">{ticket.subject}</span>
                              <span className="record-number">
                                {ticket.number} · {kindLabel(ticket.kind)}
                              </span>
                              <span
                                className={
                                  ticket.state === 'pending' &&
                                  ticket.pendingReason === 'wait_requester'
                                    ? 'portal-your-turn'
                                    : 'hint'
                                }
                              >
                                {portalTicketNextAction(ticket)}
                              </span>
                            </span>
                            <span className="support-ticket-row-status">
                              <span className="state" data-state={ticket.state}>
                                {stateLabel(ticket.state)}
                              </span>
                              <time dateTime={ticket.createdAt}>
                                受付 {formatDate(ticket.createdAt)}
                              </time>
                            </span>
                            <FreshserviceIcon name="chevron" size={14} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  {ticketList && tickets.data.total > 0 && (
                    <TicketPagination
                      basePath="/portal"
                      query={listQuery}
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

      {home && (
        <nav className="support-secondary-actions" aria-label="その他のサポート">
          <Link href="/knowledge">ヘルプ記事を閲覧する</Link>
          <Link href="/portal?tab=services">サービスを検索する</Link>
          <Link href={hasWork ? '/inbox' : '/requests?view=mine'}>
            {hasWork ? '担当業務を確認する' : '申請状況を確認する'}
          </Link>
          <Link href="/portal?tab=requests">最近の申請を見る</Link>
        </nav>
      )}
    </main>
  );
}
