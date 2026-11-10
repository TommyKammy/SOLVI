import Link from 'next/link';
import { OperationsGroupSelect } from '../../../components/OperationsGroupSelect';
import { TableRegion } from '../../../components/TableRegion';
import { DonutChart } from '../../../components/DonutChart';
import { api, requireSession } from '../../../lib/api';
import { formatDateTime, priorityLabel, slaUrgency, stateLabel } from '../../../lib/labels';
import { navigationRoles, withReturnTo } from '../../../lib/navigation';
import {
  OPERATIONS_METRICS,
  operationsDeadlineQuery,
  operationsHref,
  operationsMetricQuery,
  operationsQueueHref,
  operationsScopeLabel,
  operationsSlaText,
  parseOperationsGroup,
} from '../../../lib/operations-overview';

export const dynamic = 'force-dynamic';

type TicketResult = Awaited<ReturnType<typeof api.listTickets>>;
type OverviewResult = Awaited<ReturnType<typeof api.ticketOverview>>;

function unavailableText(result: TicketResult | OverviewResult): string | null {
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

export default async function OperationsOverview({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (!navigationRoles(session).staff)
    return (
      <main id="main" className="shell operations-overview">
        <h1>運営状況</h1>
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
  const metricQueries = OPERATIONS_METRICS.map((metric) => operationsMetricQuery(metric.id, group));
  const deadlineQuery = operationsDeadlineQuery(group);
  const chartQuery = operationsMetricQuery('open', group);
  const chartHref = operationsQueueHref(chartQuery);
  const [groupList, overview, deadlines, chartTickets] = await Promise.all([
    api.listGroups(),
    error ? Promise.resolve(null) : api.ticketOverview(group),
    error ? Promise.resolve(null) : api.listTickets(5, deadlineQuery),
    error ? Promise.resolve(null) : api.listTickets(50, chartQuery),
  ]);
  const groups = groupList.ok ? groupList.data.items.map(({ id, name }) => ({ id, name })) : [];
  const scope = operationsScopeLabel(group, groups);
  const selectedGroup = error ? (rawGroups[0] ?? '') : group;
  const missingGroup =
    selectedGroup !== '' &&
    !['mine', 'ungrouped'].includes(selectedGroup) &&
    !groups.some((item) => item.id === selectedGroup);
  const retrievedAt = new Date().toISOString();
  const deadlineError = deadlines ? unavailableText(deadlines) : null;
  const overviewError = overview ? unavailableText(overview) : '取得できませんでした。';
  const chartError = chartTickets ? unavailableText(chartTickets) : '取得できませんでした。';
  const counts = overview?.ok ? overview.data.counts : null;
  const chartItems = chartTickets?.ok ? chartTickets.data.items : [];
  const prioritySegments = [
    {
      label: '最優先',
      value: chartItems.filter((t) => t.priority === 'critical').length,
      color: '#cd2629',
    },
    {
      label: '高',
      value: chartItems.filter((t) => t.priority === 'high').length,
      color: '#cf6121',
    },
    {
      label: '中',
      value: chartItems.filter((t) => t.priority === 'medium').length,
      color: '#276cf0',
    },
    { label: '低', value: chartItems.filter((t) => t.priority === 'low').length, color: '#8e9dac' },
  ];
  const stateSegments = [
    {
      label: stateLabel('new'),
      value: chartItems.filter((t) => t.state === 'new').length,
      color: '#276cf0',
    },
    {
      label: stateLabel('assigned'),
      value: chartItems.filter((t) => t.state === 'assigned').length,
      color: '#6aa8ff',
    },
    {
      label: stateLabel('in_progress'),
      value: chartItems.filter((t) => t.state === 'in_progress').length,
      color: '#00513f',
    },
    {
      label: stateLabel('pending'),
      value: chartItems.filter((t) => t.state === 'pending').length,
      color: '#cf6121',
    },
  ];

  return (
    <main id="main" className="shell operations-overview fs-dashboard">
      <header className="overview-heading">
        <div>
          <h1>運営状況</h1>
          <p>現在の問い合わせを把握し、対応する一覧へ進みます。</p>
        </div>
        <nav className="overview-utilities" aria-label="運営状況の関連画面">
          <Link href="/ops">問い合わせの一覧</Link>
          <Link href="/inbox">業務受信箱</Link>
        </nav>
      </header>

      <form
        key={currentHref}
        action="/ops/overview"
        method="get"
        className="overview-filter"
        aria-label="運営状況の表示範囲"
      >
        <div className="field">
          <label htmlFor="overview-group">担当グループ</label>
          <OperationsGroupSelect
            selectedGroup={selectedGroup}
            groups={groups}
            missingGroup={missingGroup}
            invalid={Boolean(error)}
            describedBy={
              error ? 'overview-group-error' : missingGroup ? 'overview-group-hint' : undefined
            }
          />
        </div>
        <button type="submit">範囲を適用</button>
        <Link href="/ops/overview">範囲を解除</Link>
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
        <section className="overview-message" role="alert">
          <h2>表示範囲を確認してください</h2>
          <p id="overview-group-error">{error}</p>
          <p>指定された値: {rawGroups.map((value) => value || '（空欄）').join(' / ')}</p>
          <a href="#overview-group">担当グループを選び直す</a>
        </section>
      ) : (
        <>
          <section className="overview-metrics" aria-labelledby="overview-metrics-title">
            <div className="overview-section-heading">
              <h2 id="overview-metrics-title">現在の件数</h2>
              <p className="hint">
                表示範囲: <strong>{scope}</strong>
              </p>
            </div>
            {overviewError ? (
              <p role="alert" className="overview-message overview-metric-error">
                6項目の件数を表示できません。{overviewError}
              </p>
            ) : null}
            <dl className="overview-counts">
              {OPERATIONS_METRICS.map((metric, index) => {
                return (
                  <div
                    key={metric.id}
                    className="overview-metric"
                    data-metric={metric.id}
                    data-overdue={
                      (metric.id === 'breached' && counts !== null && counts.breached > 0) ||
                      undefined
                    }
                  >
                    <dt>
                      <Link href={operationsQueueHref(metricQueries[index])} prefetch={false}>
                        {metric.label}
                        <span className="visually-hidden">の問い合わせを見る</span>
                        <span aria-hidden="true"> →</span>
                      </Link>
                    </dt>
                    <dd>
                      {counts ? (
                        <>
                          <strong className="overview-count">{counts[metric.id]}</strong>
                          <span> 件</span>
                        </>
                      ) : (
                        <span className="hint">未取得</span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <div className="overview-meta">
              <p className="hint">
                取得処理完了: <time dateTime={retrievedAt}>{formatDateTime(retrievedAt)}</time>
                （JST）
              </p>
              <a href={currentHref}>運営状況を再読み込み</a>
            </div>
            <details className="overview-definitions">
              <summary>件数とSLAの見方</summary>
              <p>
                6項目は同じ時点の問い合わせをまとめて集計した現在件数です。期間実績ではありません。項目間に重複があるため、合計しません。
              </p>
              <dl>
                {OPERATIONS_METRICS.map((metric) => (
                  <div key={metric.id}>
                    <dt>{metric.label}</dt>
                    <dd>{metric.description}</dd>
                  </div>
                ))}
              </dl>
              <p>
                SLAは暦時間で計測します。確認・対応待ちは計測を停止し、営業時間・休日は考慮しません。初回応答期限はこの画面の集計に含みません。
              </p>
              <p>
                解決期限超過には、停止前に目標を超過した確認・対応待ちも含みます。目標未設定の問い合わせは超過件数に含みません。
              </p>
            </details>
          </section>

          <section className="fs-dashboard-charts" aria-label="未完了チケットの内訳">
            {chartError ? (
              <div className="overview-message" role="alert">
                <p>内訳を取得できませんでした。{chartError}</p>
                <a href={currentHref}>内訳を再読み込み</a>
              </div>
            ) : (
              <>
                <DonutChart
                  title="優先度の内訳"
                  caption={`${scope}・未完了の先頭${chartItems.length}件`}
                  segments={prioritySegments}
                  emptyLabel="対象のチケットはありません"
                  href={chartHref}
                  hrefLabel={`${scope}の未完了の問い合わせ一覧を見る`}
                />
                <DonutChart
                  title="状況の内訳"
                  caption={`${scope}・未完了の先頭${chartItems.length}件`}
                  segments={stateSegments}
                  emptyLabel="対象のチケットはありません"
                  href={chartHref}
                  hrefLabel={`${scope}の未完了の問い合わせ一覧を見る`}
                />
              </>
            )}
          </section>

          <section className="overview-deadlines" aria-labelledby="overview-deadlines-title">
            <div className="overview-section-heading">
              <h2 id="overview-deadlines-title">解決期限の確認</h2>
              <Link href={operationsQueueHref(deadlineQuery)} prefetch={false}>
                期限順の一覧を見る
              </Link>
            </div>
            <p className="overview-deadline-scope hint">
              受付済み・担当決定・対応中を、最も超過した順から表示。停止中の「確認・対応待ち」は含みません。
            </p>
            {deadlineError ? (
              <div className="overview-message" role="alert">
                <p>{deadlineError}</p>
                <a href={currentHref}>期限一覧を再読み込み</a>
              </div>
            ) : deadlines?.ok && deadlines.data.scope === 'organization' ? (
              <>
                <p className="overview-deadline-result" role="status">
                  対象 {deadlines.data.total}件 · 先頭{deadlines.data.items.length}
                  件を表示（最大5件）
                </p>
                {deadlines.data.items.length === 0 ? (
                  <div className="overview-message">
                    <h3>
                      {deadlines.data.total > 0
                        ? '表示する問い合わせを確認できません'
                        : 'この範囲に対応中の問い合わせはありません'}
                    </h3>
                    <p>
                      {deadlines.data.total > 0
                        ? '一覧が更新された可能性があります。再読み込みして確認してください。'
                        : '確認・対応待ちの問い合わせは、上の件数から確認できます。'}
                    </p>
                    <Link href={operationsQueueHref(deadlineQuery)}>
                      問い合わせの一覧を確認する
                    </Link>
                  </div>
                ) : (
                  <TableRegion label="解決期限の問い合わせ一覧">
                    <table className="work-table overview-deadline-table">
                      <caption className="visually-hidden">
                        {scope}の解決期限確認、対象{deadlines.data.total}件中
                        {deadlines.data.items.length}件
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">問い合わせ</th>
                          <th scope="col">解決SLA</th>
                          <th scope="col">状況</th>
                          <th scope="col">担当</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deadlines.data.items.map((ticket) => (
                          <tr key={ticket.id}>
                            <td className="overview-ticket">
                              <Link
                                href={withReturnTo(
                                  `/ops/${encodeURIComponent(ticket.id)}`,
                                  currentHref,
                                )}
                                prefetch={false}
                              >
                                <span className="record-number">
                                  {ticket.number} · {priorityLabel(ticket.priority)}
                                </span>
                                <span className="record-title">{ticket.subject}</span>
                              </Link>
                            </td>
                            <td>
                              <span
                                className={`sla sla-${slaUrgency(ticket.sla?.remainingSeconds ?? null)}`}
                              >
                                {operationsSlaText(ticket.sla)}
                              </span>
                            </td>
                            <td>
                              <span className="state" data-state={ticket.state}>
                                {stateLabel(ticket.state)}
                              </span>
                            </td>
                            <td>
                              {ticket.assigned
                                ? (ticket.assigneeName ?? '担当者名未取得')
                                : '担当者未割当'}
                              {ticket.assigneeGroupName && (
                                <span className="overview-group-name hint">
                                  {ticket.assigneeGroupName}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableRegion>
                )}
                <p className="hint overview-limit">
                  期限順の一覧では最大50件を確認できます。すべての対象は受付順に切り替えて確認してください。
                </p>
              </>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}
