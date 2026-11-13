import Link from 'next/link';
import { api, requireSession } from '../../../../lib/api';
import { isOrgAdmin, navigationRoles } from '../../../../lib/navigation';
import { formatDateTime } from '../../../../lib/labels';
import {
  formatRelationshipChangeSide,
  parseRelationshipHistoryQuery,
  relationshipChangeLabel,
  relationshipHistoryHref,
} from '../../../../lib/approval-route';

export const dynamic = 'force-dynamic';

/**
 * 上長・主部署・部署長の変更履歴 (WP-P4-APR-016 段階A / ADR-0023 §3)。
 *
 * 上長・部署長の設定は承認権限の付与と同格の特権操作である。アクセスレビューで
 * 人が見直せるように、監査イベントから期間指定で表示する。
 * 閲覧できるのは `org_admin` と `auditor` だけ。APIが毎回認可する。
 * 社員番号・役職・勤務地はAPIが返さないため、この画面にも出さない。
 */
export default async function RelationshipChangesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const session = await requireSession();
  const roles = navigationRoles(session);
  if (!isOrgAdmin(session) && !roles.auditor) {
    return (
      <main id="main" className="shell">
        <h1>上長・部署長の変更履歴</h1>
        <p className="empty">
          この画面を表示する権限がありません。組織の管理者または監査担当へご連絡ください。
        </p>
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </main>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const query = parseRelationshipHistoryQuery(raw, today);
  const result = await api.relationshipChanges(query);
  const problem = result.ok ? null : result.problem;
  const error =
    problem && problem.status !== 400
      ? (problem.errors?.[0]?.message ??
        problem.detail ??
        problem.title ??
        '変更履歴を読み込めませんでした。')
      : null;
  const validationError =
    problem?.status === 400
      ? (problem.errors?.[0]?.message ??
        problem.detail ??
        problem.title ??
        '期間の指定を確認してください。')
      : null;

  return (
    <main id="main" className="shell directory-shell">
      <div className="directory-heading">
        <div>
          <h1>上長・部署長の変更履歴</h1>
          <p>
            上長・主部署・部署長の設定と変更を、期間を指定して新しい順に表示します。アクセスレビューで確認するための画面です。
          </p>
        </div>
        <div className="directory-heading-actions">
          <Link className="directory-cta secondary" href="/ops/access-review">
            アクセスレビュー
          </Link>
          {isOrgAdmin(session) && (
            <Link className="directory-cta secondary" href="/ops/approvals">
              承認ルール
            </Link>
          )}
        </div>
      </div>

      <form method="get" action="/ops/approvals/changes" className="directory-filters">
        <div className="field">
          <label htmlFor="relationship-from">開始日</label>
          <input id="relationship-from" name="from" type="date" defaultValue={query.from} />
        </div>
        <div className="field">
          <label htmlFor="relationship-to">終了日</label>
          <input id="relationship-to" name="to" type="date" defaultValue={query.to} />
        </div>
        <div className="directory-filter-actions">
          <button type="submit" className="secondary">
            期間を指定する
          </button>
        </div>
        <p className="hint" style={{ gridColumn: '1 / -1' }}>
          期間は日付（UTC）で指定します。1回に366日まで、50件ずつ表示します。
        </p>
      </form>

      {validationError && (
        <div className="error-summary" role="alert">
          <h2>期間を確認してください</h2>
          <p>{validationError}</p>
        </div>
      )}
      {error && (
        <div className="error-summary" role="alert">
          <h2>
            {problem?.status === 403
              ? '変更履歴を表示する権限がありません'
              : '変更履歴を読み込めませんでした'}
          </h2>
          <p>{error}</p>
          <Link href={relationshipHistoryHref(query)}>同じ条件で再読み込み</Link>
        </div>
      )}

      {result.ok && (
        <>
          <p className="hint" role="status">
            {result.data.from} から {result.data.to} まで · このページ {result.data.items.length} 件
            {result.data.hasMore ? '（次のページがあります）' : ''}
          </p>
          {result.data.items.length === 0 ? (
            <p className="empty">指定した期間に、上長・主部署・部署長の変更はありません。</p>
          ) : (
            <div className="directory-table-wrap">
              <table className="directory-table">
                <caption>上長・部署長の変更履歴</caption>
                <thead>
                  <tr>
                    <th scope="col">日時</th>
                    <th scope="col">種類</th>
                    <th scope="col">操作者</th>
                    <th scope="col">対象者</th>
                    <th scope="col">変更前</th>
                    <th scope="col">変更後</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((item) => (
                    <tr key={item.eventId}>
                      <td data-label="日時">{formatDateTime(item.occurredAt)}</td>
                      <td data-label="種類">{relationshipChangeLabel(item.changeType)}</td>
                      <td data-label="操作者">{item.actor.displayName ?? '確認できません'}</td>
                      <td data-label="対象者">{item.subject.displayName ?? '確認できません'}</td>
                      <td data-label="変更前">
                        {formatRelationshipChangeSide(item.changeType, item.before).map(
                          (line, index) => (
                            <span key={index} style={{ display: 'block' }}>
                              {line}
                            </span>
                          ),
                        )}
                      </td>
                      <td data-label="変更後">
                        {formatRelationshipChangeSide(item.changeType, item.after).map(
                          (line, index) => (
                            <span key={index} style={{ display: 'block' }}>
                              {line}
                            </span>
                          ),
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav className="actions-row directory-pagination" aria-label="変更履歴のページ">
            {query.page > 1 ? (
              <Link href={relationshipHistoryHref(query, { page: query.page - 1 })}>
                前のページ
              </Link>
            ) : (
              <span aria-disabled="true">前のページ</span>
            )}
            <span>{query.page} ページ</span>
            {result.data.hasMore ? (
              <Link href={relationshipHistoryHref(query, { page: query.page + 1 })}>
                次のページ
              </Link>
            ) : (
              <span aria-disabled="true">次のページ</span>
            )}
          </nav>
        </>
      )}

      <p className="hint">
        <Link href="/ops/access-review">アクセスレビューへ戻る</Link>
      </p>
    </main>
  );
}
