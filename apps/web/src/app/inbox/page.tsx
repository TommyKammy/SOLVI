import { TableRegion } from '../../components/TableRegion';
import Link from 'next/link';
import { api, requireSession, type InboxItem } from '../../lib/api';
import { formatDateTime, formatRemaining } from '../../lib/labels';
import { InboxOpenForm } from '../../components/InboxOpenForm';
export const dynamic = 'force-dynamic';
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
        <h1>業務受信箱</h1>
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
    <main id="main" className="shell ops-shell">
      <p className="eyebrow">担当ワークスペース</p>
      <h1>業務受信箱</h1>
      <p className="lead">自分の担当、指名された承認、変更の予定を確認して、次の作業へ進みます。</p>
      <p className="hint">
        業務を開くと今回の更新を既読として記録します。既読でも、未完了の業務はここに残ります。外部への通知送信は行いません。
      </p>
      <div className="inbox-summary" role="group" aria-label="現在の業務件数">
        <p>
          {f.unassigned === '1' ? '担当・未割当チケット' : '担当チケット'}{' '}
          <strong>{d.counts.ticket}件</strong>
        </p>
        <p>
          自分への承認 <strong>{d.counts.approval}件</strong>
        </p>
        <p>
          担当する変更・PIR <strong>{d.counts.change}件</strong>
        </p>
      </div>
      <form method="get" className="filters" aria-label="受信箱の絞り込み">
        <div className="field">
          <label htmlFor="inbox-q">番号・タイトルで検索</label>
          <input type="text" id="inbox-q" name="q" defaultValue={f.q} maxLength={160} />
        </div>
        <div className="field">
          <label htmlFor="inbox-kind">業務の種類</label>
          <select id="inbox-kind" name="kind" defaultValue={f.kind}>
            <option value="all">すべて</option>
            <option value="ticket">担当チケット</option>
            <option value="approval">自分への承認依頼</option>
            <option value="change">担当する変更・PIR</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="inbox-unread">更新の確認</label>
          <select id="inbox-unread" name="unread" defaultValue={f.unread}>
            <option value="0">未読・既読を表示</option>
            <option value="1">新しい更新だけ</option>
          </select>
        </div>
        {d.canIncludeUnassigned && (
          <label>
            <input
              type="checkbox"
              name="unassigned"
              value="1"
              defaultChecked={f.unassigned === '1'}
            />{' '}
            担当未定のチケットも表示する
          </label>
        )}
        <button>絞り込む</button>
        <Link href="/inbox">条件を解除する</Link>
      </form>
      <p className="hint">
        期限超過、対応が必要な項目、近い期限の順で表示します。返答・外部対応待ちのSLAは計測停止。日時は日本時間（JST）です。
      </p>
      <p role="status">
        {filtering ? '絞り込み中 · ' : ''}表示対象 {d.total}件 · 新しい更新 {d.unread}件 · {d.page}
        ページ目
      </p>
      <p>
        確認時点: {formatDateTime(d.asOf)} · <a href={refresh}>受信箱を更新する</a>
      </p>
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
        <TableRegion label="業務一覧">
          <table className="work-table inbox-table">
            <caption>
              表示対象 {d.total} 件中 {d.items.length} 件を表示
            </caption>
            <thead>
              <tr>
                <th scope="col">業務</th>
                <th scope="col">状況・待ち先</th>
                <th scope="col">期限</th>
                <th scope="col">次の対応</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((item) => (
                <tr key={item.kind + ':' + item.id}>
                  <td className="ticket-subject">
                    <span className="record-number">
                      {item.number} · {item.scopeLabel}
                    </span>
                    <strong className="record-title">{item.title}</strong>
                    <span className={`update-label${item.unread ? ' unread' : ''}`}>
                      {item.unread ? '新しい更新' : '既読の更新'}
                    </span>
                    <span className="hint"> · 更新 {formatDateTime(item.updatedAt)}</span>
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
                  <td>
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
                  <td>
                    <InboxOpenForm key={item.eventKey} item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
      <nav className="queue-shortcuts" aria-label="受信箱のページ">
        {d.page > 1 && <Link href={pageLink(d.page - 1)}>前のページ</Link>}
        {d.page * d.pageSize < d.total && <Link href={pageLink(d.page + 1)}>次のページ</Link>}
      </nav>
    </main>
  );
}
