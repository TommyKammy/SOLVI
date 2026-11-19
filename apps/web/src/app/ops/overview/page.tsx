import React from 'react';
import Link from 'next/link';
import { InboxOpenForm } from '../../../components/InboxOpenForm';
import { FreshserviceIcon } from '../../../components/FreshserviceIcon';
import { OperationsGroupSelect } from '../../../components/OperationsGroupSelect';
import { TicketReturnFocus } from '../../../components/TicketReturnFocus';
import { api, requireSession } from '../../../lib/api';
import type { InboxItem, InboxView, TicketView } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';
import {
  navigationRoles,
  ticketEntryId,
  ticketListHeadingId,
  ticketReturnTo,
  withReturnTo,
} from '../../../lib/navigation';
import {
  HOME_WORK_LIMIT,
  approvalQueueHref,
  groupHomeWork,
  homeWorkQuery,
  homeWorkQueueHref,
  inboxDeadlineText,
  inboxItemHref,
  isApprovalInboxItem,
  operationsDeadlineQuery,
  operationsHref,
  operationsMetricQuery,
  operationsQueueHref,
  operationsScopeLabel,
  parseOperationsGroup,
  type HomeDueBucket,
  type HomeWorkGroups,
  type HomeWorkTicket,
} from '../../../lib/operations-overview';

export const dynamic = 'force-dynamic';

type WorkResult = Awaited<ReturnType<typeof api.listTickets>>;
type OverviewResult = Awaited<ReturnType<typeof api.ticketOverview>>;
type InboxResult = Awaited<ReturnType<typeof api.inbox>>;

function unavailableText(result: WorkResult | OverviewResult): string | null {
  if (result.ok)
    return result.data.scope === 'organization'
      ? null
      : '組織の表示範囲を確認できません。画面を開き直してください。';
  if (result.problem.status === 403)
    return '表示する権限がありません。利用権限を確認してください。';
  if (result.problem.status === 400)
    return '表示範囲を確認してください。担当グループを選び直せます。';
  return '取得できませんでした。再読み込みをお試しください。';
}

function inboxUnavailableText(result: InboxResult): string | null {
  if (result.ok) return null;
  if (result.problem.status === 403)
    return '表示する権限がありません。利用権限を確認してください。';
  return '取得できませんでした。再読み込みをお試しください。';
}

const BUCKETS: ReadonlyArray<{ id: HomeDueBucket; label: string }> = [
  { id: 'overdue', label: '解決期限超過' },
  { id: 'today', label: '今日' },
  { id: 'week', label: '今週' },
];

const EMPTY_GROUPS: HomeWorkGroups = {
  overdue: [],
  today: [],
  week: [],
  paused: [],
  later: [],
  unplanned: [],
};

function WorkList({
  id,
  label,
  tone,
  items,
  returnTo,
}: {
  id: string;
  label: string;
  tone: HomeDueBucket | 'paused';
  items: HomeWorkTicket[];
  returnTo: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="home-work-group" aria-labelledby={`home-work-${id}`}>
      <h3 id={`home-work-${id}`} data-tone={tone}>
        {label}
        <span className="home-work-group-count">{items.length}件</span>
      </h3>
      <ul className="home-work-list">
        {items.map(({ ticket, dueLabel }) => (
          <li key={ticket.id}>
            <Link
              className="home-work-row"
              data-due={tone}
              id={ticketEntryId(ticket.id)}
              href={withReturnTo(
                `/ops/${encodeURIComponent(ticket.id)}`,
                ticketReturnTo(returnTo, ticket.id),
              )}
              prefetch={false}
            >
              <span className="home-work-marker">
                <FreshserviceIcon name="ticket" size={16} />
              </span>
              <span className="home-work-subject">
                <span className="home-work-title">{ticket.subject}</span>
                <span className="home-work-reference">
                  <span className="home-work-number">{ticket.number}</span>
                  <span aria-hidden="true"> · </span>
                  {ticket.assigneeGroupName ?? 'グループ未設定'}
                </span>
              </span>
              <span className="home-work-due">{dueLabel}</span>
              <FreshserviceIcon name="chevron" size={14} className="home-work-arrow" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GroupBars({
  counts,
  group,
}: {
  counts: { open: number; breached: number };
  group: string;
}) {
  const share =
    counts.open > 0 ? Math.min(100, Math.round((counts.breached / counts.open) * 100)) : 0;
  return (
    <ul className="home-bars" aria-label="選択中の担当グループの件数">
      <li className="home-bar">
        <span className="home-bar-label">
          <Link href={operationsQueueHref(operationsMetricQuery('open', group))} prefetch={false}>
            未完了
          </Link>
        </span>
        <span className="home-bar-track" aria-hidden="true">
          <span className="home-bar-fill" style={{ width: counts.open > 0 ? '100%' : '0%' }} />
        </span>
        <span className="home-bar-value">
          <strong>{counts.open}</strong>件
        </span>
      </li>
      <li className="home-bar" data-tone="danger">
        <span className="home-bar-label">
          <Link
            href={operationsQueueHref(operationsMetricQuery('breached', group))}
            prefetch={false}
          >
            解決期限超過
          </Link>
        </span>
        <span className="home-bar-track" aria-hidden="true">
          <span className="home-bar-fill" style={{ width: `${share}%` }} />
        </span>
        <span className="home-bar-value">
          <strong>{counts.breached}</strong>件
          {counts.open > 0 ? <span className="hint">（未完了の{share}%）</span> : null}
        </span>
      </li>
    </ul>
  );
}

function NotificationList({ items }: { items: InboxItem[] }) {
  if (items.length === 0)
    return <p className="home-empty">新しい通知はありません。業務受信箱で更新を確認できます。</p>;
  return (
    <ul className="home-notifications-list">
      {items.map((item) => (
        <li key={`${item.kind}:${item.id}`}>
          {/* 直接遷移すると既読にならない。業務受信箱と同じ action で既読を記録してから移る。 */}
          <div className="home-notification" data-unread={item.unread || undefined}>
            <span className="home-notification-title">
              {item.unread ? <span className="home-unread-label">未読</span> : null}
              {item.title}
            </span>
            <span className="home-notification-meta">
              {item.number}・{item.stateLabel}・
              <time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time>
            </span>
            <InboxOpenForm item={item} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function OperationsOverview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const session = await requireSession();
  if (!navigationRoles(session).staff)
    return (
      <main id="main" className="shell operations-overview fs-home">
        <h1>ホーム</h1>
        <p className="overview-message" role="alert">
          この画面を表示する権限がありません。
        </p>
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </main>
    );

  const raw = await searchParams;
  const { group, error } = parseOperationsGroup(raw);
  const rawGroups = typeof raw.group === 'string' ? [raw.group] : (raw.group ?? []);
  const invalidQuery = new URLSearchParams();
  for (const value of rawGroups) invalidQuery.append('group', value);
  const currentHref = error
    ? `/ops/overview${invalidQuery.size ? `?${invalidQuery}` : ''}`
    : operationsHref(group);
  const deadlineQuery = homeWorkQuery();
  const assessedAt = new Date();
  const [groupList, overview, work, inbox] = await Promise.all([
    api.listGroups(),
    error ? Promise.resolve(null) : api.ticketOverview(group),
    api.listTickets(HOME_WORK_LIMIT, deadlineQuery),
    api.inbox(),
  ]);

  const groups = groupList.ok ? groupList.data.items.map(({ id, name }) => ({ id, name })) : [];
  const scope = operationsScopeLabel(group, groups);
  const selectedGroup = error ? (rawGroups[0] ?? '') : group;
  const missingGroup =
    selectedGroup !== '' &&
    !['mine', 'ungrouped'].includes(selectedGroup) &&
    !groups.some((item) => item.id === selectedGroup);

  const overviewError = overview ? unavailableText(overview) : '取得できませんでした。';
  const workError = unavailableText(work);
  const inboxError = inboxUnavailableText(inbox);

  const counts = overview?.ok ? overview.data.counts : null;
  const workOk = work.ok && work.data.scope === 'organization';
  const workItems: TicketView[] = workOk ? work.data.items : [];
  const workTotal = workOk ? work.data.total : null;
  const grouped = workOk ? groupHomeWork(workItems, assessedAt) : EMPTY_GROUPS;
  const truncated = workTotal !== null && workTotal > workItems.length;
  const bucketTotal = grouped.overdue.length + grouped.today.length + grouped.week.length;
  // 見出しの件数は、読み込んだ項目だけから数える。全件数(workTotal)と
  // 先頭ページの部分集合を混ぜると、未読込の停止中が件数に残る。
  // 停止中は期限を作らないため、この件数からも除く。
  const workActiveTotal = workOk ? workItems.length - grouped.paused.length : null;

  const inboxView: InboxView | null = inbox.ok ? inbox.data : null;
  const approvalItems = (inboxView?.items ?? []).filter(isApprovalInboxItem);
  const approval = approvalItems[0] ?? null;
  // counts は全件、items は先頭ページだけ。両者を混同しない。
  const approvalTotal = inboxView?.counts.approval ?? 0;
  const approvalPageSize = inboxView?.pageSize ?? 25;
  const notifications = (inboxView?.items ?? [])
    .filter((item) => !isApprovalInboxItem(item))
    .slice(0, 3);
  const approvalDeadline = approval ? inboxDeadlineText(approval.deadline) : null;

  return (
    <main id="main" className="shell operations-overview fs-home">
      <TicketReturnFocus />
      <header className="home-heading">
        <h1 id={ticketListHeadingId} tabIndex={-1}>
          運営状況
        </h1>
        <p className="home-date">
          <time dateTime={assessedAt.toISOString()}>
            {new Intl.DateTimeFormat('ja-JP', {
              timeZone: 'Asia/Tokyo',
              month: 'short',
              day: 'numeric',
              weekday: 'short',
            }).format(assessedAt)}
          </time>
          <span aria-hidden="true">·</span>
          <span>日本時間（JST）</span>
        </p>
      </header>

      <div className="home-layout">
        <div className="home-main">
          <section className="home-today" aria-labelledby="home-today-title">
            <h2 id="home-today-title">
              {workActiveTotal === null ? (
                '今日の対応'
              ) : truncated ? (
                <>
                  期限の近い{workItems.length}件のうち、対応中は{' '}
                  <strong className="home-count">{workActiveTotal}</strong>件です
                </>
              ) : (
                <>
                  今日の対応は <strong className="home-count">{workActiveTotal}</strong>件です
                </>
              )}
            </h2>
            {workOk && truncated ? (
              <p className="hint">
                全{workTotal}件のうち、期限の近い{workItems.length}
                件だけを読み込み、その中の対応中を数えています。
                <Link href={homeWorkQueueHref()} prefetch={false}>
                  全件を期限順の一覧で確認する
                </Link>
              </p>
            ) : null}
            <p className="home-lede">
              自分に割り当てられた未完了のチケットを、解決期限の近い順に表示します。
            </p>
            {workOk ? (
              <dl className="home-summary" aria-label="解決期限ごとの件数">
                {BUCKETS.map((bucket) => (
                  <div key={bucket.id} data-tone={bucket.id}>
                    <dt>{bucket.label}</dt>
                    <dd>
                      <strong>{grouped[bucket.id].length}</strong>件
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
          <section className="home-panel home-panel--work" aria-labelledby="home-work-title">
            <div className="home-section-head">
              <h2 id="home-work-title">自分の担当（未完了）</h2>
              <Link href={homeWorkQueueHref()} prefetch={false}>
                期限順の一覧を見る
              </Link>
            </div>
            {workError ? (
              <div className="home-error" role="alert">
                <p>自分に割り当てられたチケットを表示できません。{workError}</p>
                <a href={currentHref}>同じ範囲で再読み込みする</a>
              </div>
            ) : workTotal === 0 ? (
              <p className="home-empty">
                自分に割り当てられた未完了のチケットはありません。
                <Link href="/ops">チケットの一覧を見る</Link>
              </p>
            ) : workItems.length === 0 ? (
              <div className="home-error" role="alert">
                <p>表示するチケットを確認できませんでした。一覧が更新された可能性があります。</p>
                <a href={currentHref}>再読み込みする</a>
              </div>
            ) : (
              <>
                {BUCKETS.map((bucket) => (
                  <WorkList
                    key={bucket.id}
                    id={bucket.id}
                    label={bucket.label}
                    tone={bucket.id}
                    items={grouped[bucket.id]}
                    returnTo={currentHref}
                  />
                ))}
                {grouped.paused.length > 0 ? (
                  <>
                    <WorkList
                      id="paused"
                      label="計測停止中（SLA停止）"
                      tone="paused"
                      items={grouped.paused}
                      returnTo={currentHref}
                    />
                    <p className="hint">
                      返答待ちなどでSLAの計測が止まっているチケットです。期限は表示せず、期限ごとの件数にも含めていません。
                    </p>
                  </>
                ) : null}
                {bucketTotal === 0 ? (
                  <p className="home-empty">
                    今日・今週が期限のチケットはありません。
                    <Link href={homeWorkQueueHref()}>期限順の一覧を見る</Link>
                  </p>
                ) : null}
                {truncated ? (
                  <p className="hint">
                    期限の早い順に最大{HOME_WORK_LIMIT}
                    件を表示しています。件数は表示中のものを数えています。
                  </p>
                ) : null}
                {grouped.later.length > 0 || grouped.unplanned.length > 0 ? (
                  <p className="hint">
                    {grouped.later.length > 0
                      ? `今週より後の期限が${grouped.later.length}件`
                      : null}
                    {grouped.later.length > 0 && grouped.unplanned.length > 0 ? '、' : null}
                    {grouped.unplanned.length > 0
                      ? `解決期限が未設定のものが${grouped.unplanned.length}件`
                      : null}
                    あります。期限順の一覧で確認できます。
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>

        <aside className="home-aside" aria-label="担当グループ、承認待ちと通知">
          <section className="home-panel home-panel--group" aria-labelledby="home-group-title">
            <div className="home-section-head">
              <div>
                <h2 id="home-group-title">
                  <FreshserviceIcon name="admin" size={18} />
                  担当グループの状況
                </h2>
                <p className="hint">
                  表示範囲: <strong>{scope}</strong>
                </p>
              </div>
            </div>
            <form
              key={currentHref}
              action="/ops/overview"
              method="get"
              className="home-group-filter"
              aria-label="担当グループの状況の表示範囲"
            >
              <div className="field">
                <label htmlFor="overview-group">担当グループ</label>
                <OperationsGroupSelect
                  selectedGroup={selectedGroup}
                  groups={groups}
                  missingGroup={missingGroup}
                  invalid={Boolean(error)}
                  describedBy={
                    error
                      ? 'overview-group-error'
                      : missingGroup
                        ? 'overview-group-hint'
                        : undefined
                  }
                />
              </div>
              <button type="submit">範囲を適用</button>
              <Link className="home-clear-range" href="/ops/overview">
                範囲を解除
              </Link>
            </form>
            {!groupList.ok && (
              <p className="overview-notice" role="alert">
                {groupList.problem.status === 403
                  ? 'グループ名を表示する権限がありません。'
                  : 'グループ名を取得できませんでした。'}
                指定した範囲は保持しています。<a href={currentHref}>グループ名を再読み込み</a>
              </p>
            )}
            {missingGroup && !error && (
              <p className="overview-notice" id="overview-group-hint">
                指定したグループの名称を確認できません。範囲はそのまま保持しています。
              </p>
            )}
            {error ? (
              <div className="home-error" role="alert">
                <p id="overview-group-error">{error}</p>
                <p>指定された値: {rawGroups.map((value) => value || '（空欄）').join(' / ')}</p>
                <a href="#overview-group">担当グループを選び直す</a>
              </div>
            ) : overviewError ? (
              <div className="home-error" role="alert">
                <p>担当グループの件数を表示できません。{overviewError}</p>
                <a href={currentHref}>同じ範囲で再読み込みする</a>
              </div>
            ) : counts && counts.open === 0 ? (
              <p className="home-empty">この範囲に未完了のチケットはありません。</p>
            ) : counts ? (
              <GroupBars counts={counts} group={group} />
            ) : null}
            <div className="home-group-footer">
              <p className="hint">解決期限超過は未完了の内数です。</p>
              {!error && (
                <Link href={operationsQueueHref(operationsDeadlineQuery(group))} prefetch={false}>
                  期限順の一覧を見る
                </Link>
              )}
            </div>
          </section>
          {inboxError ? (
            <section className="home-card home-error" role="alert">
              <h2>承認待ちと通知</h2>
              <p>{inboxError}</p>
              <a href={currentHref}>再読み込みする</a>
            </section>
          ) : (
            <>
              <section className="home-card" aria-labelledby="home-approval-title">
                <div className="home-section-head">
                  <h2 id="home-approval-title">
                    <FreshserviceIcon name="change" size={18} />
                    あなたの承認待ち
                  </h2>
                  <span className="hint">{approvalTotal}件</span>
                </div>
                {approval ? (
                  <>
                    <h3>{approval.title}</h3>
                    <dl className="home-card-meta">
                      <div>
                        <dt>番号</dt>
                        <dd>{approval.number}</dd>
                      </div>
                      <div>
                        <dt>状態</dt>
                        <dd>{approval.stateLabel}</dd>
                      </div>
                      <div>
                        <dt>対象</dt>
                        <dd>{approval.scopeLabel}</dd>
                      </div>
                      <div>
                        <dt>更新</dt>
                        <dd>
                          <time dateTime={approval.updatedAt}>
                            {formatDateTime(approval.updatedAt)}
                          </time>
                        </dd>
                      </div>
                      {approvalDeadline ? (
                        <div>
                          <dt>{approval.deadline.label}</dt>
                          <dd>{approvalDeadline}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <Link
                      className="home-action"
                      href={inboxItemHref(approval.href)}
                      prefetch={false}
                    >
                      内容を確認して承認判断する
                    </Link>
                    <p className="home-note">
                      承認の確定は承認者が行います。実行直前に承認状態を再確認します。
                    </p>
                    {approvalTotal > 1 ? (
                      <p className="hint">
                        ほか{approvalTotal - 1}件の承認待ちがあります。
                        <Link href={approvalQueueHref()}>業務受信箱で確認する</Link>
                      </p>
                    ) : null}
                  </>
                ) : approvalTotal > 0 ? (
                  <div className="home-empty">
                    <p>
                      承認待ちが <strong>{approvalTotal}</strong>
                      件あります。この画面で読み込んだ先頭{approvalPageSize}
                      件には承認依頼が含まれていません。
                    </p>
                    <Link href={approvalQueueHref()}>承認待ちを業務受信箱で確認する</Link>
                  </div>
                ) : (
                  <p className="home-empty">あなたの承認待ちはありません。</p>
                )}
              </section>

              <section className="home-notifications" aria-labelledby="home-notifications-title">
                <div className="home-section-head">
                  <h2 id="home-notifications-title">
                    <FreshserviceIcon name="bell" size={18} />
                    通知
                  </h2>
                  <Link href="/inbox">業務受信箱を見る</Link>
                </div>
                <NotificationList items={notifications} />
              </section>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
