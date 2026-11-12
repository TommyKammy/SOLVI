import Link from 'next/link';
import { api, requireSession } from '../../../lib/api';
import { isOrgAdmin, navigationRoles } from '../../../lib/navigation';
import {
  DIRECTORY_ROLE_LABELS,
  directoryHref,
  managerFieldReasons,
  managerOptions,
  parseDirectoryQuery,
  selectDirectoryMembers,
} from '../../../lib/user-directory';
import { flattenDepartmentTree } from '../departments/department-ui';
import { UserCreateForm, UserMemberActions } from '../../../components/UserDirectoryForms';
import { updateDirectoryUser, updateMemberProfile } from './actions';

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
  const completeness = result.ok ? result.data.profileCompleteness : null;
  const orgAdmin = isOrgAdmin(session);
  const departments = orgAdmin ? await api.listDepartments() : null;
  const departmentOptions = departments?.ok ? flattenDepartmentTree(departments.data.items) : [];
  const activeDepartments = departmentOptions.filter((option) => option.active);
  const view = selectDirectoryMembers(members, query);
  const current = { ...query, page: view.page };
  const baseHref = directoryHref(current);
  const create = raw.create === 'agent' || raw.create === 'requester' ? raw.create : null;
  const selected =
    typeof raw.selected === 'string' ? members.find((m) => m.userId === raw.selected) : undefined;
  const selectedMatches = selected ? selectDirectoryMembers([selected], query).filtered > 0 : false;
  const selectedProfile = selected && orgAdmin ? await api.getProfile(selected.userId) : null;
  const profile = selectedProfile?.ok ? selectedProfile.data.profile : null;
  const profileError =
    typeof raw.profileError === 'string' ? raw.profileError.trim().slice(0, 500) : '';
  const isSelf = selected?.userId === session.userId;
  const managerReasons = selected ? managerFieldReasons(selected, isSelf) : [];
  const managerChoices = selected ? managerOptions(members, selected) : [];
  const managerBlocked = managerChoices.filter((option) => option.disabledReason);
  const currentDepartmentOption = profile?.primaryDepartmentId
    ? departmentOptions.find((option) => option.id === profile.primaryDepartmentId)
    : undefined;
  const departmentChoices =
    currentDepartmentOption && !currentDepartmentOption.active
      ? [...activeDepartments, currentDepartmentOption]
      : activeDepartments;
  const scope = { userId: session.userId, organizationId: session.organizationId };
  const notices: Record<string, string> = {
    created:
      '利用者を追加しました。ログインを有効にするには、別途管理者による資格情報の設定が必要です。',
    granted: '役割を付与しました。本人がログインし直さなくても反映されます。',
    revoked: '役割を取り消しました。付与と取消の記録は保持されます。',
    stopped: 'アクセスを停止し、ログイン中のセッションを失効させました。',
    reactivated: 'アクセスを再開しました。',
    profile: '組織プロフィールを保存しました。変更は監査に記録されます。',
    'profile-unchanged': '組織プロフィールに変更はありません。',
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
            {orgAdmin && (
              <Link className="directory-cta secondary" href="/ops/departments">
                部署管理
              </Link>
            )}
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

      {result.ok && completeness && (
        <section className="notice" aria-labelledby="directory-completeness-title">
          <h2 id="directory-completeness-title">プロフィールの充足状況</h2>
          <p className="hint">
            上長・主部署・部署長が未設定だと、関係ベースの承認経路を解決できません。
          </p>
          <ul>
            <li>
              <Link
                href={directoryHref(current, { manager: 'unset' })}
                style={{ display: 'inline-block', minHeight: '24px', padding: '2px 0' }}
              >
                上長未設定: {completeness.missingManager} 人
              </Link>
            </li>
            <li>
              <Link
                href={directoryHref(current, { department: 'unset' })}
                style={{ display: 'inline-block', minHeight: '24px', padding: '2px 0' }}
              >
                主部署未設定: {completeness.missingDepartment} 人
              </Link>
            </li>
            <li>
              {orgAdmin ? (
                <Link
                  href="/ops/departments"
                  style={{ display: 'inline-block', minHeight: '24px', padding: '2px 0' }}
                >
                  部署長不在: {completeness.missingDepartmentHead} 部署（有効な部署{' '}
                  {completeness.totalDepartments} 件中）
                </Link>
              ) : (
                <span>
                  部署長不在: {completeness.missingDepartmentHead} 部署（有効な部署{' '}
                  {completeness.totalDepartments} 件中）
                </span>
              )}
            </li>
          </ul>
          {orgAdmin && !departments?.ok && (
            <p className="hint">
              部署の一覧を取得できませんでした。部署の絞り込みとプロフィールの主部署は選べません。
            </p>
          )}
        </section>
      )}

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
            <div className="field">
              <label htmlFor="directory-department">部署</label>
              <select
                key={query.department}
                id="directory-department"
                name="department"
                defaultValue={query.department}
              >
                <option value="all">すべての部署</option>
                <option value="unset">部署未設定</option>
                {departmentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                    {option.active ? '' : '（無効）'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="directory-manager">上長</label>
              <select
                key={query.manager}
                id="directory-manager"
                name="manager"
                defaultValue={query.manager}
              >
                <option value="all">すべての上長</option>
                <option value="unset">上長未設定</option>
                {[...members]
                  .sort(
                    (a, b) =>
                      a.displayName.localeCompare(b.displayName, 'ja') ||
                      a.userId.localeCompare(b.userId),
                  )
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="directory-job-title">役職</label>
              <input
                key={query.jobTitle}
                id="directory-job-title"
                name="jobTitle"
                type="search"
                defaultValue={query.jobTitle}
                maxLength={200}
                placeholder="役職の一部"
              />
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
              {query.q ||
              query.role !== 'all' ||
              query.status !== 'all' ||
              query.department !== 'all' ||
              query.manager !== 'all' ||
              query.jobTitle
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
                  : '名前・メールの検索語や、役割・状態・部署・上長・役職の条件を変更してください。'}
              </p>
              {members.length > 0 && <Link href="/ops/users">条件を解除して全員を表示</Link>}
            </section>
          ) : (
            <div className="directory-table-wrap">
              <table className="directory-table">
                <caption className="sr-only">
                  利用者一覧。名前、メール、部署、上長、役職、役割、状態、対応中の問い合わせ件数を表示します。
                </caption>
                <thead>
                  <tr>
                    <th scope="col">氏名</th>
                    <th scope="col">メールアドレス</th>
                    <th scope="col">部署</th>
                    <th scope="col">上長</th>
                    <th scope="col">役職</th>
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
                      <td data-label="部署">{member.primaryDepartmentName ?? '未設定'}</td>
                      <td data-label="上長">{member.managerDisplayName ?? '未設定'}</td>
                      <td data-label="役職">{member.jobTitle ?? '未設定'}</td>
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
              {orgAdmin && (
                <div className="directory-profile" aria-labelledby="directory-profile-title">
                  <h3 id="directory-profile-title">組織プロフィール</h3>
                  {profileError && (
                    <div
                      className="error-summary"
                      id="profile-error"
                      role="alert"
                      tabIndex={-1}
                      autoFocus
                    >
                      <h4>プロフィールを保存できませんでした</h4>
                      <p>{profileError}</p>
                    </div>
                  )}
                  {!selectedProfile?.ok || !profile ? (
                    <p className="hint">
                      組織プロフィールを読み込めませんでした。一覧を開き直してから再度お試しください。
                    </p>
                  ) : (
                    <form
                      action={updateMemberProfile.bind(null, scope, current, selected.userId)}
                      aria-describedby={profileError ? 'profile-error' : undefined}
                    >
                      <input
                        type="hidden"
                        name="origin_primaryDepartmentId"
                        value={profile.primaryDepartmentId ?? ''}
                      />
                      <input
                        type="hidden"
                        name="origin_managerUserId"
                        value={profile.managerUserId ?? ''}
                      />
                      <input type="hidden" name="origin_jobTitle" value={profile.jobTitle ?? ''} />
                      <input type="hidden" name="origin_location" value={profile.location ?? ''} />
                      <input
                        type="hidden"
                        name="origin_employeeId"
                        value={profile.employeeId ?? ''}
                      />
                      <fieldset className="directory-form-grid">
                        <legend className="sr-only">組織プロフィールの編集</legend>
                        <div className="field">
                          <label htmlFor="profile-primary-department">主部署</label>
                          <select
                            id="profile-primary-department"
                            name={isSelf ? undefined : 'primaryDepartmentId'}
                            disabled={isSelf}
                            defaultValue={profile.primaryDepartmentId ?? ''}
                            aria-describedby={
                              isSelf ? 'profile-primary-department-reason' : undefined
                            }
                          >
                            <option value="">未設定</option>
                            {departmentChoices.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                                {option.active ? '' : '（無効）'}
                              </option>
                            ))}
                            {profile.primaryDepartmentId &&
                              !departmentChoices.some(
                                (option) => option.id === profile.primaryDepartmentId,
                              ) && (
                                <option value={profile.primaryDepartmentId}>
                                  {profile.primaryDepartmentName ?? '現在の主部署'}
                                </option>
                              )}
                          </select>
                          {isSelf && (
                            <p className="hint" id="profile-primary-department-reason">
                              自分自身の主部署は自分では変更できません。別の組織管理者に設定を依頼してください。
                            </p>
                          )}
                        </div>
                        <div className="field">
                          <label htmlFor="profile-manager">上長</label>
                          <select
                            id="profile-manager"
                            name={managerReasons.length > 0 ? undefined : 'managerUserId'}
                            disabled={managerReasons.length > 0}
                            defaultValue={profile.managerUserId ?? ''}
                            aria-describedby={
                              managerReasons.length > 0 ? 'profile-manager-reason' : undefined
                            }
                          >
                            <option value="">未設定</option>
                            {managerChoices.map((option) => (
                              <option
                                key={option.userId}
                                value={option.userId}
                                disabled={
                                  option.disabledReason !== null &&
                                  option.userId !== profile.managerUserId
                                }
                              >
                                {option.displayName}
                                {option.disabledReason ? `（${option.disabledReason}）` : ''}
                              </option>
                            ))}
                            {profile.managerUserId &&
                              !managerChoices.some(
                                (option) => option.userId === profile.managerUserId,
                              ) && (
                                <option value={profile.managerUserId}>
                                  {profile.managerDisplayName ?? '現在の上長'}
                                </option>
                              )}
                          </select>
                          {managerReasons.length > 0 && (
                            <p className="hint" id="profile-manager-reason">
                              {managerReasons.join(' ')}
                            </p>
                          )}
                          {managerBlocked.length > 0 && (
                            <p className="hint">
                              選べない候補:{' '}
                              {managerBlocked
                                .map(
                                  (option) => `${option.displayName}（${option.disabledReason}）`,
                                )
                                .join('、')}
                            </p>
                          )}
                        </div>
                        <div className="field">
                          <label htmlFor="profile-job-title">役職</label>
                          <input
                            id="profile-job-title"
                            name="jobTitle"
                            type="text"
                            maxLength={200}
                            defaultValue={profile.jobTitle ?? ''}
                            autoComplete="off"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="profile-location">勤務地</label>
                          <input
                            id="profile-location"
                            name="location"
                            type="text"
                            maxLength={200}
                            defaultValue={profile.location ?? ''}
                            autoComplete="off"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="profile-employee-id">社員番号</label>
                          <p className="hint" id="profile-employee-id-hint">
                            一覧には表示しません。監査には変更した事実だけを記録します。
                          </p>
                          <input
                            id="profile-employee-id"
                            name="employeeId"
                            type="text"
                            maxLength={64}
                            defaultValue={profile.employeeId ?? ''}
                            aria-describedby="profile-employee-id-hint"
                            autoComplete="off"
                          />
                        </div>
                      </fieldset>
                      <div className="directory-form-actions">
                        <button type="submit">プロフィールを保存する</button>
                        <span className="hint">変更した項目だけを保存します。</span>
                      </div>
                    </form>
                  )}
                </div>
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
