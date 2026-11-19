import React, { Suspense } from 'react';
import Link from 'next/link';
import { AdminDenied } from '../../../components/AdminWorkspace';
import { TableRegion } from '../../../components/TableRegion';
import { TicketReturnFocus } from '../../../components/TicketReturnFocus';
import { api, requireSession, type TicketView } from '../../../lib/api';
import { formatDateTime, stateLabel } from '../../../lib/labels';
import {
  navigationRoles,
  ticketEntryId,
  ticketReturnTo,
  withReturnTo,
} from '../../../lib/navigation';
import { operationsSlaText } from '../../../lib/operations-overview';
import {
  parseReportQuery,
  reportHref,
  reportMetrics,
  reportTicketsQuery,
  type ReportMetric,
} from '../../../lib/ops-insights';

export const dynamic = 'force-dynamic';

const metrics = Object.keys(reportMetrics) as ReportMetric[];
const groupMetrics = ['received', 'resolved', 'breached'] as const;
const resultsId = 'report-results';
const number = new Intl.NumberFormat('ja-JP');
type ReportScope = ReturnType<typeof parseReportQuery>;
type ReportGroup = { id: string; name: string };
type TicketPage = NonNullable<Awaited<ReturnType<typeof loadTickets>>>;

async function loadTickets(scope: ReportScope, metric: ReportMetric, page = false) {
  try {
    const result = await api.listTickets(page ? 25 : 1, reportTicketsQuery(scope, metric, page));
    if (
      result.ok &&
      result.data.scope === 'organization' &&
      Number.isSafeInteger(result.data.total) &&
      result.data.total >= 0 &&
      Array.isArray(result.data.items)
    ) {
      return result.data;
    }
  } catch {
    // A failed response stream is handled like an unavailable count.
  }
  return null;
}

function resultsHref(
  scope: ReportScope,
  metric = scope.metric,
  cursor: ReportScope['cursor'] = null,
) {
  return reportHref(scope, metric, cursor) + '#' + resultsId;
}

function formatPeriod({ from, to }: ReportScope) {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const display = (day: string) => (sameYear ? day.slice(5) : day).replaceAll('-', '/');
  return (
    <>
      <time dateTime={from}>{display(from)}</time>
      {from !== to && (
        <>
          〜<time dateTime={to}>{display(to)}</time>
        </>
      )}
    </>
  );
}

function ReportCards({
  scope,
  totals,
}: {
  scope: ReportScope;
  totals: ReadonlyMap<ReportMetric, TicketPage | null>;
}) {
  return (
    <nav className="report-metrics" aria-label="対象チケットを表示する集計">
      {metrics.map((metric) => {
        const data = totals.get(metric);
        return data ? (
          <Link
            className="report-metric"
            data-metric={metric}
            key={metric}
            href={resultsHref(scope, metric)}
            aria-current={scope.metric === metric ? 'true' : undefined}
            prefetch={false}
          >
            <span className="report-metric-name">{reportMetrics[metric]}</span>
            <strong className="report-metric-value">
              {number.format(data.total)}
              <small>件</small>
            </strong>
            <span className="report-metric-open">
              対象チケット
              <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24">
                <path
                  d="M4 12h15m-6-6 6 6-6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.65"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </Link>
        ) : (
          <div className="report-metric" key={metric}>
            <span className="report-metric-name">{reportMetrics[metric]}</span>
            <span className="hint">取得できませんでした</span>
          </div>
        );
      })}
    </nav>
  );
}

async function GroupBreakdown({
  scope,
  groups,
  totals,
}: {
  scope: ReportScope;
  groups: ReportGroup[];
  totals: ReadonlyMap<ReportMetric, TicketPage | null>;
}) {
  async function loadRow(group: ReportGroup) {
    const groupScope = { ...scope, group: group.id };
    const counts = await Promise.all(
      groupMetrics.map(async (metric) => {
        const data = scope.group ? totals.get(metric) : await loadTickets(groupScope, metric);
        return [metric, data?.total ?? null] as const;
      }),
    );
    return { group, counts: new Map(counts) };
  }

  const rows: Awaited<ReturnType<typeof loadRow>>[] = [];
  const groupsPerBatch = 3;
  for (let index = 0; index < groups.length; index += groupsPerBatch) {
    rows.push(...(await Promise.all(groups.slice(index, index + groupsPerBatch).map(loadRow))));
  }
  const maximum = rows.reduce((value, row) => Math.max(value, row.counts.get('received') ?? 0), 1);

  return (
    <>
      <div className="report-breakdown-head" aria-hidden="true">
        <span>担当グループ</span>
        {groupMetrics.map((metric) => (
          <span key={metric}>{reportMetrics[metric]}</span>
        ))}
      </div>
      <ul className="report-breakdown" role="list">
        {rows.map(({ group, counts }) => (
          <li className="report-breakdown-row" key={group.id}>
            <h3>{group.name}</h3>
            {groupMetrics.map((metric) => {
              const count = counts.get(metric) ?? null;
              return (
                <div className={metric === 'received' ? 'report-bar-cell' : undefined} key={metric}>
                  <span className="report-mobile-label" aria-hidden="true">
                    {metric === 'received' ? '受付' : reportMetrics[metric]}
                  </span>
                  {metric === 'received' && count !== null && (
                    <span className="report-bar" aria-hidden="true">
                      <span style={{ inlineSize: (count / maximum) * 100 + '%' }} />
                    </span>
                  )}
                  {count === null ? (
                    <span className="hint report-count-unavailable">
                      <span className="visually-hidden">{reportMetrics[metric]}を</span>
                      取得できません
                    </span>
                  ) : (
                    <Link
                      className="report-count"
                      data-tone={metric === 'breached' && count > 0 ? 'danger' : undefined}
                      href={resultsHref({ ...scope, group: group.id }, metric)}
                      aria-label={
                        group.name +
                        'の' +
                        reportMetrics[metric] +
                        ' ' +
                        number.format(count) +
                        '件'
                      }
                      prefetch={false}
                    >
                      {number.format(count)}件
                    </Link>
                  )}
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </>
  );
}

function ReportSla({ ticket }: { ticket: TicketView }) {
  if (ticket.state === 'pending') return <span className="hint">SLA停止中</span>;
  if (!['new', 'assigned', 'in_progress'].includes(ticket.state))
    return <span className="hint">—</span>;
  return (
    <span className={ticket.sla?.breached ? 'report-overdue' : undefined}>
      {operationsSlaText(ticket.sla)}
    </span>
  );
}

function ReportTickets({
  scope,
  page,
  title,
}: {
  scope: ReportScope;
  page: TicketPage;
  title: string;
}) {
  const from = reportHref(scope, scope.metric, scope.cursor);
  return (
    <>
      {page.items.length === 0 ? (
        <div className="report-empty">
          <p>
            {scope.cursor
              ? 'この位置にチケットはありません。先頭から確認できます。'
              : 'この条件に該当するチケットはありません。'}
          </p>
          {!scope.cursor && <p className="hint">集計期間または担当グループを変更できます。</p>}
        </div>
      ) : (
        <TableRegion label={title} className="table-scroll report-table-scroll">
          <table className="work-table report-ticket-table">
            <caption className="visually-hidden">
              全 {number.format(page.total)} 件中 {number.format(page.items.length)} 件を表示
            </caption>
            <thead>
              <tr>
                <th scope="col">チケット</th>
                <th scope="col">担当グループ</th>
                <th scope="col">状態</th>
                <th scope="col">受付日</th>
                <th scope="col">解決期限（SLA）</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((ticket) => (
                <tr key={ticket.id}>
                  <th scope="row">
                    <Link
                      id={ticketEntryId(ticket.id)}
                      prefetch={false}
                      href={withReturnTo(
                        '/ops/' + encodeURIComponent(ticket.id),
                        ticketReturnTo(from, ticket.id),
                      )}
                    >
                      {ticket.subject} <span className="report-ticket-number">{ticket.number}</span>
                    </Link>
                  </th>
                  <td>{ticket.assigneeGroupName ?? 'グループ未設定'}</td>
                  <td>
                    <span className="state" data-state={ticket.state}>
                      {stateLabel(ticket.state)}
                    </span>
                  </td>
                  <td>
                    <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
                  </td>
                  <td>
                    <ReportSla ticket={ticket} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
      {(scope.cursor || page.nextCursor) && (
        <nav className="form-actions" aria-label="対象チケットのページ">
          {scope.cursor && (
            <Link href={resultsHref(scope)} prefetch={false}>
              先頭へ
            </Link>
          )}
          {page.nextCursor && (
            <Link href={resultsHref(scope, scope.metric, page.nextCursor)} prefetch={false}>
              次のページ
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (!navigationRoles(session).staff) return <AdminDenied title="レポート" canOpenHome={false} />;

  const scope = parseReportQuery(await searchParams);
  const [groupsResult, organizations] = await Promise.all([
    api.listGroups(true),
    api.myOrganizations(),
  ]);
  const groups = groupsResult.ok ? groupsResult.data.items : [];
  const organization = organizations.ok
    ? organizations.data.organizations.find((item) => item.id === session.organizationId)?.name
    : undefined;
  const groupName = groups.find((item) => item.id === scope.group)?.name;
  const groupValid = !scope.group || ['mine', 'ungrouped'].includes(scope.group) || !!groupName;
  const scopeLabel = !scope.group
    ? '組織全体'
    : scope.group === 'mine'
      ? '所属グループ'
      : scope.group === 'ungrouped'
        ? 'グループ未設定'
        : groupName;
  const ready = !scope.invalid && groupValid;
  const entries = ready
    ? await Promise.all(
        metrics.map(
          async (metric) =>
            [metric, await loadTickets(scope, metric, metric === scope.metric)] as const,
        ),
      )
    : [];
  const totals = new Map(entries);
  const selected = scope.metric ? totals.get(scope.metric) : null;
  const from = reportHref(scope, scope.metric, scope.cursor);
  const breakdownGroups =
    scope.group && scopeLabel
      ? [{ id: scope.group, name: scopeLabel }]
      : [...groups, { id: 'ungrouped', name: 'グループ未設定' }];
  const title = scope.metric
    ? reportMetrics[scope.metric] + 'の対象チケット'
    : 'グループ別の対応状況';

  return (
    <main id="main" className="shell insights-workspace report-workspace">
      <header className="report-heading">
        {organization && <p>{organization}</p>}
        <h1>レポート</h1>
      </header>

      <form key={from} method="get" className="insights-filters" aria-label="レポートの集計条件">
        <div className="field">
          <label htmlFor="report-from">受付開始日（UTC）</label>
          <input type="date" id="report-from" name="from" defaultValue={scope.from} required />
        </div>
        <div className="field">
          <label htmlFor="report-to">受付終了日（UTC）</label>
          <input type="date" id="report-to" name="to" defaultValue={scope.to} required />
        </div>
        <div className="field">
          <label htmlFor="report-group">担当グループ</label>
          <select id="report-group" name="group" defaultValue={scope.group}>
            <option value="">組織全体</option>
            <option value="mine">所属グループ</option>
            <option value="ungrouped">グループ未設定</option>
            {scope.group && !groupValid && (
              <option value={scope.group}>選択したグループを確認できません</option>
            )}
            {groups.map((group) => (
              <option value={group.id} key={group.id}>
                {group.name}
                {group.active ? '' : '（無効）'}
              </option>
            ))}
          </select>
        </div>
        {scope.metric && <input type="hidden" name="metric" value={scope.metric} />}
        <div className="form-actions">
          <button type="submit">絞り込む</button>
          <Link href="/ops/reports">条件を解除する</Link>
        </div>
      </form>

      {!ready ? (
        <section className="insights-panel" role="alert">
          <h2>集計条件を確認してください</h2>
          <p>
            {scope.invalid
              ? '有効な受付日から366日以内で指定してください。'
              : '担当グループを選び直すか、条件を解除してください。'}
          </p>
        </section>
      ) : (
        <>
          <p className="report-scope">
            受付日 {formatPeriod(scope)}（UTC） · {scopeLabel}
            <br />
            SLA停止中のチケットは期限超過に含めません。チケットの時刻はJSTで表示します。
          </p>
          <ReportCards scope={scope} totals={totals} />
          <section
            className={scope.metric ? 'report-results' : 'report-results report-group-panel'}
            aria-labelledby={resultsId}
          >
            <TicketReturnFocus key={from} headingId={resultsId} />
            <div className="report-results-heading">
              <h2 id={resultsId} tabIndex={-1}>
                {title}
                {selected && `（${number.format(selected.total)}件）`}
              </h2>
              {scope.metric && (
                <Link href={resultsHref(scope, null)} prefetch={false}>
                  グループ別の集計に戻る
                </Link>
              )}
            </div>
            {scope.metric ? (
              selected ? (
                <ReportTickets scope={scope} page={selected} title={title} />
              ) : (
                <p role="alert">
                  対象チケットを取得できませんでした。<a href={from}>再読み込みする</a>
                </p>
              )
            ) : !groupsResult.ok && !scope.group ? (
              <p role="alert">
                担当グループを取得できませんでした。<a href={from}>再読み込みする</a>
              </p>
            ) : (
              <Suspense
                key={'breakdown:' + from}
                fallback={<p role="status">グループ別の対応状況を読み込んでいます。</p>}
              >
                <GroupBreakdown scope={scope} groups={breakdownGroups} totals={totals} />
              </Suspense>
            )}
          </section>
        </>
      )}
    </main>
  );
}
