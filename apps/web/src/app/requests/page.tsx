import Link from 'next/link';
import { FreshserviceIcon } from '../../components/FreshserviceIcon';
import { ContextLink } from '../../components/ContextLink';
import { api, requireSession } from '../../lib/api';
import { formatDateTime } from '../../lib/labels';
const labels: Record<string, string> = {
  pending: '承認待ち',
  approved: '承認済み・模擬実行待ち',
  rejected: '却下',
  invalidated: '承認取消・再申請待ち',
  completed: '模擬実行完了',
  cancelled: '取消',
};
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const p = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['q', 'state', 'view', 'page'])
    if (typeof p[key] === 'string' && p[key]) query.set(key, p[key]);
  const refresh = '/requests' + (query.size ? '?' + query.toString() : '');
  const r = await api.serviceRequests(query.toString());
  if (!r.ok) {
    const message =
      r.problem.status === 401
        ? 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。'
        : r.problem.status === 403
          ? 'この組織の申請一覧を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : r.problem.status === 404
            ? '申請一覧を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。'
            : r.problem.status === 400
              ? '申請一覧の検索条件を確認できませんでした。条件を解除して開き直してください。'
              : '申請一覧を取得できませんでした。時間をおいて、同じ条件で再取得してください。';
    return (
      <main id="main" className="shell">
        <h1>申請の状況</h1>
        <p role="alert">{message}</p>
        <p>
          <a href={refresh}>同じ条件で再取得する</a>
          {r.problem.status === 400 && (
            <>
              {' · '}
              <a href="/requests">条件を解除する</a>
            </>
          )}
          {' · '}
          <Link href="/portal">ポータルへ戻る</Link>
        </p>
      </main>
    );
  }
  const f = r.data.appliedFilter;
  const filtering = Boolean(f.q) || f.state !== 'all' || f.view !== 'all';
  const pageLink = (page: number) => {
    const next = new URLSearchParams(query);
    next.set('page', String(page));
    return '/requests?' + next.toString();
  };
  return (
    <main id="main" className="shell service-workspace">
      <header className="support-page-heading">
        <div>
          <h1>申請の状況</h1>
          <p className="lead">
            申請の進捗と、いま誰が対応するかを確認します。実際の権限・外部サービスは変更しません。
          </p>
        </div>
        <div className="form-actions">
          {f.view === 'approvals' && (
            <Link className="support-action" href="/settings/delegations">
              代理承認の委任を管理する
            </Link>
          )}
          <Link className="support-action support-action--primary" href="/catalog">
            カタログから申請する
          </Link>
        </div>
      </header>
      <form method="get" className="filters service-filter" aria-label="申請の絞り込み">
        <div className="field service-search-field">
          <label htmlFor="request-q">受付番号・サービス名・申請者で検索</label>
          <input id="request-q" name="q" defaultValue={f.q} maxLength={160} />
        </div>
        <div className="field">
          <label htmlFor="request-view">処理対象</label>
          <select id="request-view" name="view" defaultValue={f.view}>
            <option value="all">閲覧できるすべて</option>
            <option value="mine">自分の申請</option>
            <option value="approvals">自分が判断する承認待ち</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="request-state">進捗</label>
          <select id="request-state" name="state" defaultValue={f.state}>
            <option value="all">すべて</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="expired">承認期限切れ</option>
          </select>
        </div>
        <button>絞り込む</button>
        <Link href="/requests">条件を解除する</Link>
      </form>
      <div className="service-list-toolbar">
        <h2 role="status">
          {filtering ? '絞り込み中 · ' : ''}表示対象 {r.data.total}件 · {r.data.page}ページ目
        </h2>
        <div className="service-heading-actions">
          <a href={refresh}>申請の状況を更新する</a>
        </div>
      </div>
      {r.data.items.length > 0 && (
        <ul className="service-result-list" role="list" aria-label="申請一覧">
          {r.data.items.map((q) => (
            <li key={q.id} className="service-list-row service-request-row">
              <span className="service-row-icon">
                <FreshserviceIcon name="ticket" size={18} />
              </span>
              <div className="service-row-copy">
                <ContextLink className="service-row-title" href={`/requests/${q.id}`}>
                  {q.number} · {q.title}
                </ContextLink>
                <span className="hint">
                  申請者: {q.requesterName}
                  {q.own && '（自分）'} · 承認者: {q.approverName}
                </span>
                {q.delegated && (
                  <span className="hint" data-delegated="true">
                    {q.approverName}さんの代理で判断できます（委任された承認です）。
                  </span>
                )}
                <span className="hint">{q.nextAction}</span>
                {q.decisionReason && ['rejected', 'invalidated'].includes(q.state) && (
                  <span className="service-decision-note">判断理由: {q.decisionReason}</span>
                )}
              </div>
              <div className="service-row-aside">
                <span className="state" data-state={q.expired ? 'expired' : q.state}>
                  <strong>
                    {q.expired ? '承認期限切れ・再承認が必要' : (labels[q.state] ?? q.state)}
                  </strong>
                </span>
                <time className="hint" dateTime={q.updatedAt}>
                  {formatDateTime(q.updatedAt)}
                </time>
                {['pending', 'approved'].includes(q.state) && (
                  <span className="hint">承認期限: {formatDateTime(q.expiresAt)}</span>
                )}
              </div>
              <FreshserviceIcon name="chevron" size={16} />
            </li>
          ))}
        </ul>
      )}
      {!r.data.items.length && (
        <p className="service-empty">
          {r.data.total > 0
            ? 'このページに申請はありません。最初のページへ戻ってください。'
            : filtering
              ? '条件に合う申請はありません。条件を解除するか、カタログから申請できます。'
              : '表示できる申請はまだありません。カタログから申請できます。'}
        </p>
      )}
      <nav className="pagination" aria-label="申請のページ">
        {(r.data.page > 1 || (r.data.total > 0 && !r.data.items.length)) && (
          <Link href={pageLink(1)}>最初のページへ</Link>
        )}
        {r.data.page > 1 && <Link href={pageLink(r.data.page - 1)}>前のページ</Link>}
        {r.data.page * r.data.pageSize < r.data.total && (
          <Link href={pageLink(r.data.page + 1)}>次のページ</Link>
        )}
      </nav>
    </main>
  );
}
