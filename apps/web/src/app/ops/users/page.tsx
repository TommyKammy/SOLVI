import Link from 'next/link';
import { api, requireSession } from '../../../lib/api';
import { navigationRoles } from '../../../lib/navigation';
import {
  DIRECTORY_ROLE_LABELS,
  directoryHref,
  parseDirectoryQuery,
  selectDirectoryMembers,
} from '../../../lib/user-directory';
import { UserCreateForm, UserMemberActions } from '../../../components/UserDirectoryForms';
import { updateDirectoryUser } from './actions';

export const dynamic = 'force-dynamic';

export default async function ManageUsers({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const session = await requireSession();
  if (!navigationRoles(session).admin) {
    return (
      <main id="main" className="shell directory-shell">
        <h1>利用者管理</h1>
        <p className="empty">この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </main>
    );
  }

  const query = parseDirectoryQuery(raw);
  const result = await api.listMembers();
  const members = result.ok ? result.data.items : [];
  const view = selectDirectoryMembers(members, query);
  const current = { ...query, page: view.page };
  const baseHref = directoryHref(current);
  const create = raw.create === 'agent' || raw.create === 'requester' ? raw.create : null;
  const selected =
    typeof raw.selected === 'string' ? members.find((m) => m.userId === raw.selected) : undefined;
  const selectedMatches = selected ? selectDirectoryMembers([selected], query).filtered > 0 : false;
  const scope = { userId: session.userId, organizationId: session.organizationId };
  const notices: Record<string, string> = {
    created:
      '利用者を追加しました。ログインを有効にするには、別途管理者による資格情報の設定が必要です。',
    granted: '役割を付与しました。本人がログインし直さなくても反映されます。',
    revoked: '役割を取り消しました。付与と取消の記録は保持されます。',
    stopped: 'アクセスを停止し、ログイン中のセッションを失効させました。',
    reactivated: 'アクセスを再開しました。',
  };
  const notice =
    typeof raw.notice === 'string' && Object.hasOwn(notices, raw.notice)
      ? notices[raw.notice]
      : undefined;
  const count =
    typeof raw.count === 'string' && /^\d{1,7}$/.test(raw.count) ? Number(raw.count) : 0;

  return (
    <main id="main" className="shell directory-shell">
      <div className="directory-heading">
        <div>
          <h1>利用者管理</h1>
          <p>登録・役割・アクセス状況を、選択中の組織で管理します。</p>
        </div>
        {result.ok && (
          <div className="directory-heading-actions">
            <Link
              className="directory-cta secondary"
              href={directoryHref(current, { create: 'requester' }) + '#directory-create'}
            >
              リクエスターを追加
            </Link>
            <Link
              className="directory-cta"
              href={directoryHref(current, { create: 'agent' }) + '#directory-create'}
            >
              オペレーターを追加
            </Link>
          </div>
        )}
      </div>

      {result.ok && notice && (
        <div className="notice directory-notice" role="status" id="directory-notice" tabIndex={-1}>
          <p>{notice}</p>
          {raw.notice === 'stopped' && count > 0 && (
            <p>対応中の問い合わせが {count} 件残っています。別の担当者へ振り直してください。</p>
          )}
          {selected && !selectedMatches && (
            <p>
              操作した利用者は現在の検索条件に含まれません。必要に応じて条件を解除してください。
            </p>
          )}
        </div>
      )}

      {!result.ok ? (
        <section className="error-summary" role="alert">
          <h2>
            {result.problem.status === 403
              ? '利用者を表示する権限がありません'
              : '利用者一覧を読み込めませんでした'}
          </h2>
          <p>情報を取得できていないため、件数や管理操作は表示していません。</p>
          <Link href={baseHref}>一覧を再読み込み</Link>
        </section>
      ) : (
        <>
          {create && (
            <section
              className="directory-panel"
              id="directory-create"
              aria-labelledby="directory-create-title"
            >
              <h2 id="directory-create-title">
                {create === 'agent' ? 'オペレーターを追加' : 'リクエスターを追加'}
              </h2>
              <UserCreateForm
                key={create}
                initialRole={create}
                cancelHref={baseHref}
                action={updateDirectoryUser.bind(null, scope, current, null, 'create')}
              />
            </section>
          )}

          <nav className="directory-tabs" aria-label="利用者の種類">
            {(
              [
                ['all', '全員'],
                ['requester', 'リクエスター'],
                ['agent', 'オペレーター'],
              ] as const
            ).map(([role, label]) => (
              <Link
                key={role}
                href={directoryHref(current, { role, page: 1 })}
                aria-current={query.role === role ? 'page' : undefined}
              >
                {label}
                <span>
                  {role === 'all'
                    ? members.length
                    : members.filter((m) => m.roleCodes.includes(role)).length}
                </span>
              </Link>
            ))}
          </nav>

          <form
            method="get"
            action="/ops/users"
            className="directory-filters"
            aria-label="利用者の絞り込み"
          >
            <div className="field directory-search">
              <label htmlFor="directory-q">名前・メール</label>
              <input
                key={query.q}
                id="directory-q"
                name="q"
                type="search"
                defaultValue={query.q}
                placeholder="名前またはメールアドレス"
                maxLength={200}
              />
            </div>
            <div className="field">
              <label htmlFor="directory-role">役割</label>
              <select key={query.role} id="directory-role" name="role" defaultValue={query.role}>
                <option value="all">すべての役割</option>
                {Object.entries(DIRECTORY_ROLE_LABELS).map(([role, label]) => (
                  <option key={role} value={role}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="directory-status">状態</label>
              <select
                key={query.status}
                id="directory-status"
                name="status"
                defaultValue={query.status}
              >
                <option value="all">すべての状態</option>
                <option value="active">有効</option>
                <option value="deactivated">停止中</option>
              </select>
            </div>
            <div className="directory-filter-actions">
              <button type="submit" className="secondary">
                絞り込む
              </button>
              <Link href="/ops/users">条件を解除</Link>
            </div>
          </form>

          <div className="directory-result-info">
            <p role="status">
              {view.filtered} 人
              {query.q || query.role !== 'all' || query.status !== 'all'
                ? ` / 表示可能な在籍者 ${view.total} 人`
                : 'の表示可能な在籍者'}
              {view.filtered > 0 && (
                <span>
                  {' '}
                  · {view.from}–{view.to} 人目を表示
                </span>
              )}
            </p>
            <span>名前順 · 25人ずつ</span>
          </div>

          {view.filtered === 0 ? (
            <section className="directory-empty" aria-labelledby="directory-empty-title">
              <h2 id="directory-empty-title">
                {members.length === 0
                  ? '表示できる在籍者がいません'
                  : '条件に一致する利用者がいません'}
              </h2>
              <p>
                {members.length === 0
                  ? '新しい利用者を追加するか、組織と在籍状況を確認してください。'
                  : '名前・メールの検索語や、役割・状態の条件を変更してください。'}
              </p>
              {members.length > 0 && <Link href="/ops/users">条件を解除して全員を表示</Link>}
            </section>
          ) : (
            <div className="directory-table-wrap">
              <table className="directory-table">
                <caption className="sr-only">
                  利用者一覧。名前、メール、役割、状態、対応中の問い合わせ件数を表示します。
                </caption>
                <thead>
                  <tr>
                    <th scope="col">氏名</th>
                    <th scope="col">メールアドレス</th>
                    <th scope="col">役割</th>
                    <th scope="col">状態</th>
                    <th scope="col">対応中</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((member) => (
                    <tr
                      key={member.userId}
                      data-selected={selected?.userId === member.userId ? 'true' : undefined}
                    >
                      <th scope="row" data-label="氏名">
                        <span>{member.displayName}</span>
                        {member.userId === session.userId && <small>自分</small>}
                      </th>
                      <td data-label="メールアドレス" className="directory-email">
                        {member.email}
                      </td>
                      <td data-label="役割">
                        {member.roleCodes
                          .map((role) => DIRECTORY_ROLE_LABELS[role] ?? role)
                          .join(' / ')}
                        {member.temporaryRoles.length > 0 && (
                          <small className="directory-expiry">
                            {member.temporaryRoles.some((role) => role.expiringSoon)
                              ? 'まもなく期限切れの役割あり'
                              : '期限付きの役割あり'}
                          </small>
                        )}
                      </td>
                      <td data-label="状態">
                        <span className="directory-state" data-state={member.status}>
                          {member.status === 'deactivated' ? '停止中' : '有効'}
                        </span>
                      </td>
                      <td data-label="対応中">{member.openTicketCount} 件</td>
                      <td data-label="操作">
                        <Link
                          aria-label={`${member.displayName} の詳細`}
                          href={
                            directoryHref(current, { selected: member.userId }) + '#member-details'
                          }
                        >
                          詳細
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {view.pageCount > 1 && (
            <nav className="directory-pagination" aria-label="利用者一覧のページ">
              {view.page > 1 ? (
                <Link href={directoryHref(current, { page: view.page - 1 })}>前へ</Link>
              ) : (
                <span aria-disabled="true">前へ</span>
              )}
              <span>
                {view.page} / {view.pageCount} ページ
              </span>
              {view.page < view.pageCount ? (
                <Link href={directoryHref(current, { page: view.page + 1 })}>次へ</Link>
              ) : (
                <span aria-disabled="true">次へ</span>
              )}
            </nav>
          )}

          {selected && (
            <section
              id="member-details"
              className="directory-panel"
              aria-labelledby="directory-member-title"
              tabIndex={-1}
            >
              <div className="directory-detail-heading">
                <h2 id="directory-member-title">{selected.displayName}</h2>
                <Link href={baseHref}>詳細を閉じる</Link>
              </div>
              <p className="directory-detail-email">{selected.email}</p>
              <p>
                {selected.status === 'deactivated' ? 'アクセス停止中' : '有効'} · 対応中{' '}
                {selected.openTicketCount} 件
              </p>
              {!selectedMatches && (
                <p className="hint">この利用者は現在の検索条件に含まれていません。</p>
              )}
              <UserMemberActions
                key={`${selected.userId}:${selected.status}:${selected.roleCodes.join(',')}`}
                member={selected}
                isSelf={selected.userId === session.userId}
                actions={{
                  grant: updateDirectoryUser.bind(null, scope, current, selected.userId, 'grant'),
                  revoke: updateDirectoryUser.bind(null, scope, current, selected.userId, 'revoke'),
                  deactivate: updateDirectoryUser.bind(
                    null,
                    scope,
                    current,
                    selected.userId,
                    'deactivate',
                  ),
                  reactivate: updateDirectoryUser.bind(
                    null,
                    scope,
                    current,
                    selected.userId,
                    'reactivate',
                  ),
                }}
              />
            </section>
          )}
          {raw.selected && !selected && (
            <p role="status">
              選択した利用者は表示可能な在籍者に含まれていません。すべての役割が取り消されたか、失効した可能性があります。一覧から選び直してください。
            </p>
          )}
          <p className="directory-footnote">
            複数の役割を持つ人は、各役割の一覧に表示されます。すべての役割が失効した人は、この一覧に含まれません。
          </p>
        </>
      )}
    </main>
  );
}
