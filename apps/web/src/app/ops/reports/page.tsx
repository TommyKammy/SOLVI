import React from 'react';
import Link from 'next/link';
import { AdminDenied } from '../../../components/AdminWorkspace';
import { TicketReturnFocus } from '../../../components/TicketReturnFocus';
import { api, requireSession } from '../../../lib/api';
import { formatDateTime, stateLabel } from '../../../lib/labels';
import {
  navigationRoles,
  ticketEntryId,
  ticketListHeadingId,
  ticketReturnTo,
  withReturnTo,
} from '../../../lib/navigation';
import {
  parseReportQuery,
  reportHref,
  reportMetrics,
  reportTicketsQuery,
  type ReportMetric,
} from '../../../lib/ops-insights';

export const dynamic = 'force-dynamic';

const metrics = Object.keys(reportMetrics) as ReportMetric[];

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (!navigationRoles(session).staff) return <AdminDenied title="レポート" canOpenHome={false} />;

  const scope = parseReportQuery(await searchParams);
  const groupsResult = await api.listGroups(true);
  const groups = groupsResult.ok ? groupsResult.data.items : [];
  const groupName = groups.find((item) => item.id === scope.group)?.name;
  const groupValid = !scope.group || ['mine', 'ungrouped'].includes(scope.group) || !!groupName;
  const ready = !scope.invalid && groupValid;
  const entries = ready
    ? await Promise.all(
        metrics.map(async (metric) => {
          const selected = metric === scope.metric;
          const result = await api.listTickets(
            selected ? 25 : 1,
            reportTicketsQuery(scope, metric, selected),
          );
          return [
            metric,
            result.ok &&
            result.data.scope === 'organization' &&
            Number.isSafeInteger(result.data.total) &&
            result.data.total >= 0 &&
            Array.isArray(result.data.items)
              ? result.data
              : null,
          ] as const;
        }),
      )
    : [];
  const totals = new Map(entries);
  const selected = totals.get(scope.metric);
  const from = reportHref(scope, scope.metric, scope.cursor);

  return (
    <main id="main" className="shell insights-workspace">
      <header className="support-page-heading">
        <div>
          <h1>レポート</h1>
          <p className="lead">受付日と担当グループで対応状況を確認します。</p>
        </div>
        <Link href="/ops/overview" className="support-action">
          運営状況を開く
        </Link>
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
            <option value="">すべてのグループ</option>
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
        <input type="hidden" name="metric" value={scope.metric} />
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
          <p className="hint">
            解決期限超過は、SLAが稼働中の未完了チケットを対象にします。チケットの時刻はJSTで表示します。
          </p>
          <nav className="report-metrics" aria-label="対象チケットを表示する集計">
            {metrics.map((metric) => {
              const metricData = totals.get(metric);
              return metricData ? (
                <Link
                  className="report-metric"
                  data-metric={metric}
                  key={metric}
                  href={reportHref(scope, metric) + '#report-results'}
                  aria-current={scope.metric === metric ? 'page' : undefined}
                  prefetch={false}
                >
                  <span>{reportMetrics[metric]}</span>
                  <strong>{metricData.total.toLocaleString('ja-JP')}件</strong>
                </Link>
              ) : (
                <div className="report-metric" key={metric}>
                  <span>{reportMetrics[metric]}</span>
                  <span>取得できませんでした</span>
                </div>
              );
            })}
          </nav>
          <section
            className="insights-panel"
            id="report-results"
            aria-labelledby={ticketListHeadingId}
          >
            <h2 id={ticketListHeadingId} tabIndex={-1}>
              {reportMetrics[scope.metric]}の対象チケット
            </h2>
            {!selected ? (
              <p role="alert">
                対象チケットを取得できませんでした。<a href={from}>再読み込みする</a>
              </p>
            ) : (
              <>
                <TicketReturnFocus />
                <p role="status">
                  全{selected.total.toLocaleString('ja-JP')}件 · このページに{selected.items.length}
                  件を表示
                </p>
                {selected.items.length === 0 ? (
                  <p>
                    {scope.cursor
                      ? 'この位置にチケットはありません。先頭から確認できます。'
                      : 'この条件に該当するチケットはありません。'}
                  </p>
                ) : (
                  <ul className="insights-list" role="list">
                    {selected.items.map((ticket) => (
                      <li key={ticket.id}>
                        <div>
                          <Link
                            id={ticketEntryId(ticket.id)}
                            prefetch={false}
                            href={withReturnTo(
                              '/ops/' + encodeURIComponent(ticket.id),
                              ticketReturnTo(from, ticket.id),
                            )}
                          >
                            {ticket.number} · {ticket.subject}
                          </Link>
                          <p className="hint">
                            {ticket.assigneeGroupName ?? 'グループ未設定'} · 受付{' '}
                            {formatDateTime(ticket.createdAt)}
                          </p>
                        </div>
                        <span className="state" data-state={ticket.state}>
                          {stateLabel(ticket.state)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {(scope.cursor || selected.nextCursor) && (
                  <nav className="form-actions" aria-label="対象チケットのページ">
                    {scope.cursor && (
                      <Link href={reportHref(scope) + '#report-results'} prefetch={false}>
                        先頭へ
                      </Link>
                    )}
                    {selected.nextCursor && (
                      <Link
                        href={
                          reportHref(scope, scope.metric, selected.nextCursor) + '#report-results'
                        }
                        prefetch={false}
                      >
                        次のページ
                      </Link>
                    )}
                  </nav>
                )}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
