import { Suspense } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { navigationRoles } from '../../../lib/navigation';
import { TableRegion } from '../../../components/TableRegion';
import { NotificationRetryForm } from '../../../components/NotificationRetryForm';
import { formScope } from '../../../lib/form-scope';
import { notificationRetryAction } from './actions';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_STATUS_LABELS,
  OUTBOX_STATUS_LABELS,
  notificationDate,
  notificationHref,
  parseNotificationQuery,
  type NotificationQuery,
} from '../../../lib/notification-list';

export const dynamic = 'force-dynamic';

function Failure({ status, first }: { status: number; first: string }) {
  return (
    <section className="notification-message" role="alert">
      <h2>
        {status === 401
          ? 'ログイン状態を確認してください'
          : status === 403
            ? '通知状況を表示する権限がありません'
            : status === 400
              ? '表示条件を確認してください'
              : '通知状況を取得できませんでした'}
      </h2>
      <p>
        {status === 401
          ? 'ログインし直してから、通知状況を再読み込みしてください。'
          : status === 403
            ? '選択中の組織で有効な組織管理者の権限が必要です。'
            : status === 400
              ? '結果の取得位置が変わった可能性があります。同じ状態の先頭から確認できます。'
              : '接続を確認し、時間をおいて再度お試しください。状態の指定は保持しています。'}
      </p>
      <div className="notification-actions">
        {status === 401 && (
          <a href="/login" target="_blank" rel="noopener">
            別のタブでログインする
          </a>
        )}
        {status !== 403 && <a href={first}>通知状況を再読み込み</a>}
        <Link href="/portal">利用者ポータルへ</Link>
      </div>
    </section>
  );
}

async function Results({ query, scope }: { query: NotificationQuery; scope: string }) {
  const result = await api.notifications(query);
  const first = notificationHref({ status: query.status, direction: 'next' });
  if (!result.ok) return <Failure status={result.problem.status} first={first} />;
  const data = result.data;
  return (
    <section aria-label="通知の一覧">
      <dl className="notification-counts" aria-label="選択中の組織の通知件数">
        {NOTIFICATION_STATUSES.map((status) => (
          <div key={status}>
            <dt>{NOTIFICATION_STATUS_LABELS[status]}</dt>
            <dd>{data.counts[status]}件</dd>
          </div>
        ))}
      </dl>
      <p className="notification-result" role="status">
        対象 <strong>{data.total}件</strong> · この画面に
        {data.items.length}件を表示
      </p>
      {data.items.length === 0 ? (
        <div className="notification-message">
          <h2>
            {data.total > 0
              ? 'この取得位置に通知はありません'
              : query.status === 'all'
                ? '通知はまだ記録されていません'
                : 'この状態の通知はありません'}
          </h2>
          <p>
            {data.total > 0
              ? '通知の状態が更新された可能性があります。先頭から確認してください。'
              : '状態が変わると、この一覧に反映されます。'}
          </p>
          <a href={first}>同じ状態の先頭へ</a>
          {query.status !== 'all' && (
            <Link href={notificationHref({ status: 'all', direction: 'next' })}>
              すべての通知を見る
            </Link>
          )}
        </div>
      ) : (
        <TableRegion label="通知状況の表">
          <table className="work-table notification-table">
            <caption className="visually-hidden">
              通知の記録状態と処理状況。時刻は日本標準時です。
            </caption>
            <thead>
              <tr>
                <th scope="col">作成日時・種別</th>
                <th scope="col">通知の状態</th>
                <th scope="col">処理状況</th>
                <th scope="col">試行数</th>
                <th scope="col">手動再試行</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <NotificationRetryForm
                  key={item.id}
                  summary={item.manualRetry}
                  action={notificationRetryAction.bind(null, item.id, scope)}
                  firstHref={first}
                  description={`${notificationDate(item.createdAt)} · ${NOTIFICATION_EVENTS[item.eventType]} · 試行数 ${item.attempts}`}
                >
                  <td>
                    <time dateTime={item.createdAt}>{notificationDate(item.createdAt)}</time>
                    <span className="notification-event">
                      {NOTIFICATION_EVENTS[item.eventType]}
                    </span>
                    <span className="hint">
                      {item.channel === 'email'
                        ? 'メール'
                        : item.channel === 'webhook'
                          ? 'Webhook'
                          : 'その他'}
                    </span>
                  </td>
                  <td>
                    <strong className="notification-status" data-status={item.status}>
                      {NOTIFICATION_STATUS_LABELS[item.status]}
                    </strong>
                    {item.sentAt && (
                      <span className="notification-time">
                        記録日時 <time dateTime={item.sentAt}>{notificationDate(item.sentAt)}</time>
                      </span>
                    )}
                    {item.failedAt && (
                      <span className="notification-time">
                        失敗日時{' '}
                        <time dateTime={item.failedAt}>{notificationDate(item.failedAt)}</time>
                      </span>
                    )}
                  </td>
                  <td>
                    <span>{OUTBOX_STATUS_LABELS[item.outboxStatus]}</span>
                    {item.nextAttemptAt && (
                      <span className="notification-time">
                        次回処理予定{' '}
                        <time dateTime={item.nextAttemptAt}>
                          {notificationDate(item.nextAttemptAt)}
                        </time>
                      </span>
                    )}
                  </td>
                  <td>{item.attempts}</td>
                </NotificationRetryForm>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
      {(query.cursor || data.previousCursor || data.nextCursor) && (
        <nav className="notification-pagination" aria-label="通知一覧のページ">
          {query.cursor && (
            <Link href={first} prefetch={false}>
              同じ状態の先頭へ
            </Link>
          )}
          {data.previousCursor && (
            <Link
              href={notificationHref({
                ...query,
                direction: 'previous',
                cursor: data.previousCursor,
              })}
              prefetch={false}
            >
              前の20件
            </Link>
          )}
          {data.nextCursor && (
            <Link
              href={notificationHref({ ...query, direction: 'next', cursor: data.nextCursor })}
              prefetch={false}
            >
              次の20件
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await api.me();
  const query = parseNotificationQuery(await searchParams);
  const first = notificationHref({ status: query.status, direction: 'next' });
  if (!session.ok || !navigationRoles(session.data).notifications)
    return (
      <main id="main" className="shell notification-list">
        <h1>通知状況</h1>
        <Failure status={session.ok ? 403 : session.problem.status} first={first} />
      </main>
    );
  return (
    <main id="main" className="shell notification-list">
      <header className="notification-heading">
        <h1>通知状況</h1>
        <a href={first}>通知状況を再読み込み</a>
      </header>
      <p className="notification-recording">
        開発環境では送信処理の記録のみ。実際のメール配達は確認できません。
      </p>
      <nav className="notification-filters" aria-label="通知の状態で絞り込み">
        {NOTIFICATION_STATUSES.map((status) => (
          <Link
            key={status}
            href={notificationHref({ status, direction: 'next' })}
            prefetch={false}
            aria-current={query.status === status ? 'page' : undefined}
          >
            {NOTIFICATION_STATUS_LABELS[status]}
          </Link>
        ))}
      </nav>
      {query.invalid ? (
        <Failure status={400} first={first} />
      ) : (
        <Suspense
          key={notificationHref(query)}
          fallback={
            <section className="notification-loading" aria-busy="true">
              <p role="status">通知状況を読み込んでいます</p>
              <div className="notification-skeleton" aria-hidden="true" />
              <div className="notification-skeleton" aria-hidden="true" />
              <div className="notification-skeleton" aria-hidden="true" />
            </section>
          }
        >
          <Results query={query} scope={formScope(session.data)} />
        </Suspense>
      )}
      <details className="notification-definitions">
        <summary>状態と試行数の見方</summary>
        <p>
          通知の「失敗」と処理状況は別の記録です。「処理終了」でも通知の失敗が解消したとは限りません。「再試行なし」の理由はこの画面では判断できません。
        </p>
        <p>
          試行数は通知行に記録された値です。処理全体の再試行回数や総送信回数とは異なります。次回処理予定は開始時刻を保証しません。再読み込みすると同じ状態の先頭から最新の記録を取得します。表示時刻は日本標準時です。
        </p>
      </details>
    </main>
  );
}
