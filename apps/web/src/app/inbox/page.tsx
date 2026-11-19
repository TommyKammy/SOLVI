import { TableRegion } from '../../components/TableRegion';
import Link from 'next/link';
import { api, requireSession, type InboxItem } from '../../lib/api';
import { formatDateTime, formatRemaining } from '../../lib/labels';
import { InboxOpenForm } from '../../components/InboxOpenForm';
import { TicketReturnFocus } from '../../components/TicketReturnFocus';
import { ticketListHeadingId } from '../../lib/navigation';
export const dynamic = 'force-dynamic';

/** UI v2 の共通表で使う種類の表示。APIの識別子は画面へ出さない。 */
const INBOX_KIND_LABELS: Record<InboxItem['kind'], string> = {
  ticket: 'チケット',
  request_approval: '申請承認',
  change: '変更',
};

function inboxKindLabel(kind: InboxItem['kind']): string {
  return INBOX_KIND_LABELS[kind];
}

function deadlineText(item: InboxItem) {
  const d = item.deadline;
  return d.status === 'none'
    ? `${d.label}：未設定`
    : d.status === 'paused'
      ? `${d.label}：計測停止（${d.remainingSeconds === null ? '未設定' : formatRemaining(d.remainingSeconds)}）`
      : `${d.label}：${d.at ? formatDateTime(d.at) : '未設定'}（${d.remainingSeconds === null ? '' : formatRemaining(d.remainingSeconds)}${d.status === 'within' ? '・予定期間内' : ''}）`;
}
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const p = await searchParams,
    q = new URLSearchParams();
  for (const key of ['kind', 'q', 'unread', 'unassigned', 'page'])
    if (typeof p[key] === 'string' && p[key]) q.set(key, p[key]);
  const refresh = '/inbox' + (q.size ? '?' + q.toString() : '');
  const r = await api.inbox(q.toString());
  if (!r.ok) {
    const message =
      r.problem.status === 401
        ? 'ログインの有効期限が切れた可能性があります。再取得しても表示できない場合は、ポータルからログインし直してください。'
        : r.problem.status === 403
          ? 'この組織の受信箱を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
          : r.problem.status === 404
            ? '受信箱を表示できません。対象や機能が現在利用できない可能性があります。ポータルへ戻ってご確認ください。'
            : r.problem.status === 400
              ? '受信箱の検索条件を確認できませんでした。条件を解除して開き直してください。'
              : '受信箱を取得できませんでした。時間をおいて、同じ条件で再取得してください。';
    return (
      <main id="main" className="shell">
        <TicketReturnFocus />
        <h1 id={ticketListHeadingId} tabIndex={-1}>
          業務受信箱
        </h1>
        <p role="alert">{message}</p>
        <p>
          <a href={refresh}>同じ条件で再取得する</a>
          {r.problem.status === 400 && (
            <>
              {' · '}
              <a href="/inbox">条件を解除する</a>
            </>
          )}
          {' · '}
          <Link href="/portal">ポータルへ戻る</Link>
        </p>
      </main>
    );
  }
  const d = r.data,
    f = d.appliedFilter,
    filtering = f.kind !== 'all' || Boolean(f.q) || f.unread === '1' || f.unassigned === '1';
  const pageLink = (page: number) => {
    const next = new URLSearchParams(q);
    next.set('page', String(page));
    return '/inbox?' + next.toString();
  };
  return (
    <main id="main" className="shell ops-shell inbox-page">
      <TicketReturnFocus />
      <header className="page-heading">
        <div>
          <h1 id={ticketListHeadingId} tabIndex={-1}>
            業務受信箱
          </h1>
          <p className="lead">担当チケット、承認依頼、担当する変更を確認します。</p>
        </div>
        <p className="hint inbox-as-of">
          <time dateTime={d.asOf}>{formatDateTime(d.asOf)}</time>
          <span>（JST）</span>
        </p>
      </header>
      <dl className="inbox-summary" aria-label="現在の業務件数">
        <div>
          <dt>{f.unassigned === '1' ? '担当・未割当チケット' : '担当チケット'}</dt>
          <dd>
            <strong>{d.counts.ticket}</strong>件
          </dd>
        </div>
        <div>
          <dt>承認依頼</dt>
          <dd>
            <strong>{d.counts.approval}</strong>件
          </dd>
        </div>
        <div>
          <dt>変更・PIR</dt>
          <dd>
            <strong>{d.counts.change}</strong>件
          </dd>
        </div>
      </dl>
      <form method="get" className="filters" aria-label="受信箱の絞り込み">
        <div className="field">
          <label htmlFor="inbox-q">番号・件名で検索</label>
          <input
            type="text"
            id="inbox-q"
            name="q"
            defaultValue={f.q}
            maxLength={160}
            placeholder="VPN、INC-1048など"
          />
        </div>
        <div className="field">
          <label htmlFor="inbox-kind">業務の種類</label>
          <select id="inbox-kind" name="kind" defaultValue={f.kind}>
            <option value="all">すべて</option>
            <option value="ticket">担当チケット</option>
            <option value="approval">承認依頼</option>
            <option value="change">変更・PIR</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="inbox-unread">更新の確認</label>
          <select id="inbox-unread" name="unread" defaultValue={f.unread}>
            <option value="0">すべての更新</option>
            <option value="1">新しい更新</option>
          </select>
        </div>
        <div className="form-actions inbox-filter-actions">
          <button type="submit">絞り込む</button>
          <Link className="support-action" href="/inbox">
            条件を解除する
          </Link>
        </div>
        {d.canIncludeUnassigned && (
          <label className="inbox-unassigned">
            <input
              type="checkbox"
              name="unassigned"
              value="1"
              defaultChecked={f.unassigned === '1'}
            />{' '}
            担当未定のチケットも表示する
          </label>
        )}
      </form>
      <p className="hint">
        業務を開くと更新が既読になります。返答・外部対応待ちのSLAは計測を停止します。
      </p>
      <div className="inbox-results">
        <p role="status">
          {filtering ? '絞り込み中 · ' : ''}表示対象 {d.total}件 · 新しい更新 {d.unread}件 ·{' '}
          {d.page}
          ページ目
        </p>
        <a className="support-back" href={refresh}>
          受信箱を更新する
        </a>
      </div>
      {!d.items.length ? (
        <section className="inbox-empty">
          <h2>
            {d.total > 0
              ? 'このページに業務はありません'
              : filtering
                ? '条件に合う業務はありません'
                : 'いま対応・確認する業務はありません'}
          </h2>
          <p>
            {d.total > 0
              ? '前のページに戻ると、表示対象の業務を確認できます。'
              : filtering
                ? '検索条件や業務の種類、更新の確認、未割当の条件を見直してください。'
                : d.canIncludeUnassigned
                  ? '新しい担当や承認依頼が届くと、ここに表示します。未割当のチケットは上の条件で確認できます。'
                  : '指名された承認依頼が届くと、ここに表示します。今のところ確認する依頼はありません。'}
          </p>
          {d.canIncludeUnassigned && (
            <p>
              <Link href="/ops?state=new&assignment=unassigned">担当未定のチケットを確認する</Link>{' '}
              · <Link href="/changes">変更の予定を確認する</Link>
            </p>
          )}
        </section>
      ) : (
        <TableRegion label="業務一覧" className="table-scroll">
          <table className="work-table inbox-table inbox-table--v2">
            <caption>
              表示対象 {d.total} 件中 {d.items.length} 件を表示
            </caption>
            <colgroup>
              <col className="inbox-col-number" />
              <col />
              <col className="inbox-col-kind" />
              <col className="inbox-col-state" />
              <col className="inbox-col-deadline" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">番号</th>
                <th scope="col">件名</th>
                <th scope="col">種類</th>
                <th scope="col">状態</th>
                <th scope="col">期限</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((item) => (
                <tr key={item.kind + ':' + item.id}>
                  <th scope="row" className="inbox-number">
                    <span className="cell-clip">{item.number}</span>
                  </th>
                  <td className="ticket-subject">
                    <strong className="record-title">{item.title}</strong>
                    <span className={`update-label${item.unread ? ' unread' : ''}`}>
                      {item.unread ? '新しい更新' : '既読の更新'}
                    </span>
                    <span className="hint">
                      {' '}
                      · {item.scopeLabel} · 更新 {formatDateTime(item.updatedAt)}
                    </span>
                    <div className="inbox-action">
                      <InboxOpenForm key={item.eventKey} item={item} restoreFocus />
                    </div>
                  </td>
                  <td>
                    <span className="kind-label" data-kind={item.kind}>
                      {inboxKindLabel(item.kind)}
                    </span>
                  </td>
                  <td>
                    <span className="state" data-state={item.state}>
                      {item.stateLabel}
                    </span>
                    {item.waiting && <p className="hint">相手の返答・判断待ち</p>}
                    {item.state === 'failed' && (
                      <p className="hint">保存済み結果を保持してPIRを追加</p>
                    )}
                  </td>
                  <td className="inbox-deadline">
                    <span className={`deadline-label deadline-${item.deadline.status}`}>
                      {deadlineText(item)}
                    </span>
                    {item.kind === 'change' && (item.plannedStart || item.plannedEnd) && (
                      <p className="hint">
                        予定: {item.plannedStart ? formatDateTime(item.plannedStart) : '開始未設定'}{' '}
                        〜 {item.plannedEnd ? formatDateTime(item.plannedEnd) : '終了未設定'}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
      <nav className="pagination inbox-pagination" aria-label="受信箱のページ">
        {d.page > 1 && <Link href={pageLink(d.page - 1)}>前のページ</Link>}
        {d.page * d.pageSize < d.total && <Link href={pageLink(d.page + 1)}>次のページ</Link>}
      </nav>
    </main>
  );
}
