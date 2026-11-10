import { TableRegion } from '../../components/TableRegion';
import { ContextLink } from '../../components/ContextLink';
import Link from 'next/link';
import { api, requireSession } from '../../lib/api';
import { stateLabel, kindLabel, priorityLabel, formatDateTime, slaUrgency } from '../../lib/labels';
import { operationsSlaText } from '../../lib/operations-overview';
import { TicketFilters } from '../../components/TicketFilters';
import { TicketPagination, pageNumber } from '../../components/TicketPagination';
import {
  parseTicketQueueQuery,
  ticketQueueConditions,
  ticketQueueHref,
  ticketQueuePreset,
  TICKET_QUEUE_PRESETS,
} from '../../lib/ticket-queue';

/**
 * 担当者向けチケット一覧 (WP-P2-OPSUI-010)。
 *
 * 依頼者のトップとは**情報の密度を変える**(11.1)。
 * 依頼者は「自分の件がどうなったか」だけを知りたいが、
 * 担当者は「いま何から手を付けるか」を決める必要がある。
 * 優先度と受付日時を出し、未割当が分かるようにする。
 */

export const dynamic = 'force-dynamic';

/** 一覧の列幅を保つための短い日付。完全な日時は title で補う。 */
function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date);
}

export default async function OpsQueue({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // APIの許可キーだけを転送する。複数条件とカーソルの精度は保つ。
  const filter = parseTicketQueueQuery(params);
  // ページ番号だけではAPIの取得位置は変わらない。カーソルなしは必ず先頭。
  const page =
    filter.get('cursorCreatedAt') &&
    filter.get('cursorId') &&
    typeof params.page === 'string' &&
    /^[1-9]\d*$/.test(params.page)
      ? pageNumber(params.page)
      : 1;

  // 未ログインはログイン画面へ、組織が未選択なら選択画面へ。
  // 判定は requireSession に閉じる(画面ごとに書くと必ず書き漏れる)。
  const session = await requireSession();

  const isAgent = session.roles.some((r) =>
    ['agent', 'org_admin', 'platform_admin'].includes(r.roleCode),
  );
  if (!isAgent) {
    // 権限が無い利用者にはこの画面を見せない。
    // ただし**表示しないことを防御にしない** — APIは自分の分しか返さない。
    return (
      <main id="main" className="shell">
        <h1>担当者向けの画面</h1>
        <p className="empty">この画面を表示する権限がありません。</p>
        <p>
          <ContextLink back href="/portal">
            ポータルへ戻る
          </ContextLink>
        </p>
      </main>
    );
  }

  const tickets = await api.listTickets(50, filter);
  // 絞り込みの選択肢に名前を出すために引く。失敗しても一覧は出す —
  // グループが見えないことは、対応そのものを止める理由にはならない。
  const groupList = await api.listGroups();
  const groups = groupList.ok ? groupList.data.items.map((g) => ({ id: g.id, name: g.name })) : [];
  const conditions = ticketQueueConditions(filter, groups);
  const filtering = conditions.some(({ key }) => key !== 'sort');
  const preset = ticketQueuePreset(filter);
  const currentQuery = new URLSearchParams(filter);
  if (page > 1) currentQuery.set('page', String(page));
  const firstQuery = new URLSearchParams(filter);
  firstQuery.delete('cursorCreatedAt');
  firstQuery.delete('cursorId');
  const firstHref = ticketQueueHref(firstQuery);

  return (
    <main id="main" className="shell ops-shell ops-queue">
      <div className="page-heading queue-heading">
        <div>
          <h1>問い合わせの一覧</h1>
          <p className="hint">担当・状況・期限から、次に対応する問い合わせを確認します。</p>
        </div>
        <div className="queue-utilities">
          <Link href="/ops/overview">運営状況</Link>
          <Link href="/inbox">業務受信箱</Link>
          {session.roles.some((r) => ['org_admin', 'platform_admin'].includes(r.roleCode)) && (
            <>
              <ContextLink href="/ops/groups">担当グループ管理</ContextLink>
              <ContextLink href="/ops/users">利用者管理</ContextLink>
            </>
          )}
        </div>
      </div>

      <nav className="queue-shortcuts" aria-label="担当者の絞り込み">
        {TICKET_QUEUE_PRESETS.map((view) => (
          <Link
            key={view.id}
            href={view.href}
            aria-current={preset === view.id ? 'page' : undefined}
          >
            {view.label}
          </Link>
        ))}
        {preset === 'custom' && <span className="queue-custom-view">カスタム条件</span>}
      </nav>

      <div className="fs-ticket-layout">
        <section className="fs-ticket-main" aria-label="問い合わせ一覧">
          <div className="fs-ticket-toolbar">
            <span className="hint">一覧と絞り込みはURLの条件を共有します。</span>
            <a className="fs-filter-link" href="#ticket-filters">
              フィルタ
            </a>
          </div>

          {conditions.length > 0 && (
            <nav className="queue-conditions" aria-label="適用中の条件">
              <span className="hint">適用中</span>
              {conditions.map((condition) => (
                <Link
                  key={`${condition.key}:${condition.value}`}
                  href={condition.removeHref}
                  aria-label={`${condition.label} を解除`}
                >
                  {condition.label}
                  <span aria-hidden="true"> ×</span>
                </Link>
              ))}
            </nav>
          )}

          {!tickets.ok ? (
            <section className="queue-message" role="alert">
              <h2>
                {tickets.problem.status === 400
                  ? '検索条件を確認してください'
                  : tickets.problem.status === 403
                    ? '問い合わせを表示する権限がありません'
                    : '一覧を取得できませんでした'}
              </h2>
              <p>
                {tickets.problem.status === 400
                  ? '条件の値や受付日の範囲を見直して、もう一度絞り込んでください。'
                  : tickets.problem.status === 403
                    ? '選択中の組織と利用権限を管理者に確認してください。'
                    : '時間をおいて再度お試しください。検索条件は保持しています。'}
              </p>
              <div className="queue-utilities">
                <a href={ticketQueueHref(currentQuery)}>再読み込み</a>
                <Link href="/ops">条件を解除</Link>
              </div>
            </section>
          ) : (
            <>
              <div className="queue-results" role="status">
                <span>
                  <strong>全 {tickets.data.total} 件</strong> · このページ{' '}
                  {tickets.data.items.length} 件
                  {filter.get('sort') !== 'deadline' && ` · ${page}ページ目`}
                </span>
                <span>{filter.get('sort') === 'deadline' ? '期限が近い順' : '新しい順'}</span>
              </div>
              {tickets.data.items.length === 0 ? (
                <section className="queue-message">
                  <h2>
                    {tickets.data.total > 0
                      ? 'このページに問い合わせはありません'
                      : filtering
                        ? '条件に合う問い合わせはありません'
                        : '問い合わせはまだありません'}
                  </h2>
                  <p>
                    {tickets.data.total > 0
                      ? '一覧が更新された可能性があります。最初のページから確認してください。'
                      : filtering
                        ? 'キーワードを変えるか、適用中の条件を外してお試しください。'
                        : '問い合わせが届くと、この一覧で担当や対応状況を確認できます。'}
                  </p>
                  {tickets.data.total > 0 ? (
                    <Link href={firstHref}>最初のページから確認する</Link>
                  ) : filtering ? (
                    <Link href="/ops">条件を解除</Link>
                  ) : null}
                </section>
              ) : (
                <TableRegion label="問い合わせ一覧">
                  <table className="tickets fs-queue-table">
                    <caption className="visually-hidden">
                      全 {tickets.data.total} 件中 {tickets.data.items.length} 件を表示
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">問い合わせ</th>
                        <th scope="col">依頼者</th>
                        <th scope="col">状況</th>
                        <th scope="col">優先度</th>
                        <th scope="col">担当</th>
                        <th scope="col">グループ</th>
                        <th scope="col">SLAの目安</th>
                        <th scope="col">受付日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.data.items.map((ticket) => (
                        <tr key={ticket.id}>
                          <td className="ticket-subject">
                            <Link
                              href={{
                                pathname: `/ops/${ticket.id}`,
                                query: { returnTo: ticketQueueHref(currentQuery) },
                              }}
                            >
                              <span className="record-number">
                                {ticket.number} · {kindLabel(ticket.kind)}
                              </span>
                              <span className="record-title">{ticket.subject}</span>
                            </Link>
                          </td>
                          <td className="requester-cell">
                            {ticket.requesterName ?? '依頼者名未取得'}
                          </td>
                          <td className="state-cell">
                            <span className="state" data-state={ticket.state}>
                              {stateLabel(ticket.state)}
                            </span>
                            <p className="hint">
                              {ticket.state === 'pending'
                                ? ticket.pendingReason === 'wait_requester'
                                  ? `${ticket.requesterName ?? '依頼者'}の返答待ち`
                                  : ticket.pendingReason === 'wait_external'
                                    ? '外部の対応待ち'
                                    : '待ち先未記録・担当者が確認'
                                : ['new', 'assigned', 'in_progress'].includes(ticket.state)
                                  ? ticket.assigned
                                    ? '担当者の対応'
                                    : '担当者の割当待ち'
                                  : ticket.state === 'resolved'
                                    ? '依頼者の解決確認'
                                    : '対応終了'}
                            </p>
                          </td>
                          <td>
                            <span className="priority-label">{priorityLabel(ticket.priority)}</span>
                          </td>
                          <td>
                            {/* 未割当を色ではなく文言で示す。
                      「空欄」だと、担当がいないのか表示漏れなのか分からない。 */}
                            {ticket.assigned
                              ? (ticket.assigneeName ?? '担当者名未取得')
                              : '担当者未割当'}
                          </td>
                          <td className="group-cell">
                            {ticket.assigneeGroupName ?? 'グループ未割当'}
                          </td>
                          <td>
                            {ticket.state === 'pending' ? (
                              <span className="hint">SLA停止</span>
                            ) : ticket.sla ? (
                              <span
                                className={`sla sla-${slaUrgency(ticket.sla.remainingSeconds)}`}
                                title={operationsSlaText(ticket.sla)}
                              >
                                {operationsSlaText(ticket.sla).replace(/^あと/, '')}
                              </span>
                            ) : (
                              // **「不明」を空欄にしない。** 目標が設定されていない組織では
                              // 判定できない。空欄だと「期限が無い」と読まれる。
                              <span className="hint">目標未設定</span>
                            )}
                          </td>
                          <td title={formatDateTime(ticket.createdAt)}>
                            {shortDate(ticket.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableRegion>
              )}
              {filter.get('sort') !== 'deadline' && tickets.data.total > 0 ? (
                <TicketPagination
                  basePath="/ops"
                  query={filter}
                  cursor={tickets.data.nextCursor}
                  total={tickets.data.total}
                  pageSize={50}
                  page={page}
                />
              ) : filter.get('sort') === 'deadline' ? (
                <p className="hint">
                  期限順は先頭 50 件を表示します。続きは受付順に切り替えて確認してください。
                </p>
              ) : null}
            </>
          )}
        </section>
        <aside className="fs-ticket-filters" aria-label="絞り込み">
          <div className="fs-filter-panel-heading">
            <h2>フィルタ</h2>
            <Link href="/ops">クリア</Link>
          </div>
          <TicketFilters
            key={filter.toString()}
            applied={filter}
            groups={groups}
            groupsUnavailable={!groupList.ok}
            variant="panel"
          />
        </aside>
      </div>
    </main>
  );
}
