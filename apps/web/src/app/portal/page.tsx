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
  const query = parsePortalQuery(await searchParams);
  const currentHref = portalHref(query);
  const firstHref = portalHref({ ...query, page: 1, cursor: null });
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
    <main id="main" className="shell portal-shell requester-home">
      <section className="fs-portal-hero" aria-labelledby="portal-hero-title">
        <div className="fs-portal-hero-inner">
          <p className="fs-portal-kicker">SOLVI ヘルプセンター</p>
          <h1 id="portal-hero-title">どういった事でお困りですか？</h1>
          <p className="fs-portal-hero-lead">よくある質問を探すか、サービスを申請してください。</p>
          <form className="fs-portal-search" action="/knowledge" method="get">
            <FreshserviceIcon name="search" size={20} />
            <label className="visually-hidden" htmlFor="portal-search">
              ヘルプ記事を検索
            </label>
            <input
              id="portal-search"
              type="search"
              name="q"
              maxLength={CATALOG_SEARCH_MAX_LENGTH}
              placeholder="ヘルプ記事を検索"
            />
            <button type="submit">検索</button>
          </form>
        </div>
      </section>

      <section className="fs-portal-action-grid" aria-label="よく使う操作">
        <Link
          className="fs-portal-action-card"
          href={{ pathname: '/catalog', query: { returnTo: currentHref } }}
        >
          <span className="fs-portal-action-icon" aria-hidden="true">
            <FreshserviceIcon name="grid" size={22} />
          </span>
          <strong>サービスを申請する</strong>
          <span>提供中のサービスから必要なものを選びます。</span>
        </Link>
        <Link
          className="fs-portal-action-card"
          href={{ pathname: '/tickets/new', query: { kind: 'incident', returnTo: currentHref } }}
        >
          <span className="fs-portal-action-icon" aria-hidden="true">
            <FreshserviceIcon name="ticket" size={22} />
          </span>
          <strong>障害を報告する</strong>
          <span>困っていることをサポートチームへ連絡します。</span>
        </Link>
        <Link className="fs-portal-action-card" href="/knowledge">
          <span className="fs-portal-action-icon" aria-hidden="true">
            <FreshserviceIcon name="book" size={22} />
          </span>
          <strong>ヘルプ記事を閲覧する</strong>
          <span>よくある質問や手順を調べて解決します。</span>
        </Link>
        <Link className="fs-portal-action-card" href="/requests?view=mine">
          <span className="fs-portal-action-icon" aria-hidden="true">
            <FreshserviceIcon name="change" size={22} />
          </span>
          <strong>承認を確認する</strong>
          <span>自分の申請と承認待ちの状況を確認します。</span>
        </Link>
      </section>

      <header className="portal-heading">
        <div>
          <h2 className="portal-section-title">あなたのITサポート</h2>
          <p>問い合わせの続きも、新しい申請もここから。</p>
        </div>
      </header>

      <div className="portal-work">
        <section className="portal-tickets" aria-labelledby="my-tickets-title">
          <div className="portal-section-heading">
            <h2 id="my-tickets-title">あなたの問い合わせ</h2>
          </div>
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
                        : 'お困りごとや依頼がある場合は、上のボタンから始められます。'}
                  </p>
                  {tickets.data.total > 0 && <Link href={firstHref}>最初のページから確認する</Link>}
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
                            ticket.state === 'pending' && ticket.pendingReason === 'wait_requester'
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

        <section className="portal-requests" aria-labelledby="my-requests-title">
          <div className="portal-section-heading">
            <h2 id="my-requests-title">最近の申請</h2>
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
      </div>

      <section className="portal-services" aria-labelledby="portal-services-title">
        <div className="portal-section-heading">
          <h2 id="portal-services-title">サービスを探す</h2>
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
          href={{ pathname: '/tickets/new', query: { kind: 'request', returnTo: currentHref } }}
        >
          メニューにない依頼・一般相談を送る
        </Link>
      </section>

      <section className="portal-knowledge" aria-labelledby="portal-knowledge-title">
        <h2 id="portal-knowledge-title">解決のヒントを探す</h2>
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
      </section>
    </main>
  );
}
