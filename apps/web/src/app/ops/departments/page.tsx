import Link from 'next/link';
import { api, requireSession, type DepartmentNode } from '../../../lib/api';
import { isOrgAdmin } from '../../../lib/navigation';
import { formatDateTime } from '../../../lib/labels';
import {
  assignHeadAction,
  createDepartmentAction,
  deactivateDepartmentAction,
  editDepartmentAction,
  endHeadAction,
} from './actions';
import {
  departmentHref,
  departmentNoticeText,
  findDepartmentNode,
  flattenDepartmentTree,
  parentOptions,
  parseDepartmentQuery,
} from './department-ui';

export const dynamic = 'force-dynamic';

/**
 * 部署管理 (WP-P4-IDM-013 段階B / FR-IDM-010・FR-IDM-012)。
 *
 * 部署のツリー・追加・編集・無効化・メンバー・部署長を1画面にまとめる。
 * 変更できるのは選択中の組織の `org_admin` だけ。表示しないことを認可にせず、
 * すべての変更はサーバー側のAPIが再検証する。
 *
 * 無効化は取り消せないため、リンクを押しただけでは実行せず、確認画面を挟む。
 */
export default async function ManageDepartments({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const session = await requireSession();
  if (!isOrgAdmin(session)) {
    return (
      <main id="main" className="shell">
        <h1>部署管理</h1>
        <p className="empty">この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </main>
    );
  }

  const query = parseDepartmentQuery(raw);
  const scope = { userId: session.userId, organizationId: session.organizationId };
  const result = await api.listDepartments();
  const error = typeof raw.error === 'string' ? raw.error.trim().slice(0, 500) : '';
  const notice = departmentNoticeText(raw.notice);

  if (!result.ok) {
    return (
      <main id="main" className="shell">
        <h1>部署管理</h1>
        <section className="error-summary" role="alert">
          <h2>
            {result.problem.status === 403
              ? '部署を表示する権限がありません'
              : '部署の一覧を読み込めませんでした'}
          </h2>
          <p>情報を取得できていないため、部署の操作は表示していません。</p>
          <Link href="/ops/departments">一覧を再読み込み</Link>
        </section>
      </main>
    );
  }

  const nodes = result.data.items;
  const selected = query.department ? findDepartmentNode(nodes, query.department) : null;
  const membersResult = selected ? await api.departmentMembers(selected.id) : null;
  const headResult = selected ? await api.departmentHead(selected.id) : null;
  const allMembersResult = selected ? await api.listMembers() : null;
  const members = membersResult?.ok ? membersResult.data.items : [];
  const head = headResult?.ok ? headResult.data.head : null;
  const activeMembers = (allMembersResult?.ok ? allMembersResult.data.items : [])
    .filter((member) => member.status === 'active')
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName, 'ja') || a.userId.localeCompare(b.userId),
    );
  const options = flattenDepartmentTree(nodes);
  const parent = selected?.parentId
    ? options.find((option) => option.id === selected.parentId)
    : undefined;
  const editParents = selected ? parentOptions(nodes, selected.id) : [];
  const addParents = parentOptions(nodes);
  const detailError = error ? 'department-error' : undefined;
  const actionLinkStyle = {
    display: 'inline-block',
    minHeight: '24px',
    padding: '2px 0',
  } as const;

  const tree = (items: DepartmentNode[], label: string) => (
    <ul className="groups" aria-label={label}>
      {items.map((node) => (
        <li key={node.id} className={node.active ? 'group' : 'group inactive'}>
          <div className="meta">
            <span className="group-code">{node.code}</span>
            <span>{node.active ? '有効' : '無効'}</span>
            {node.children.length > 0 && <span>子部署 {node.children.length} 件</span>}
          </div>
          <strong>{node.name}</strong>
          <div className="actions-row" style={{ marginTop: '0.5rem' }}>
            <Link
              href={
                departmentHref(query, { department: node.id, confirm: null }) +
                '#department-details'
              }
              aria-current={query.department === node.id ? 'true' : undefined}
              aria-label={`${node.name} の詳細とメンバー`}
              style={actionLinkStyle}
            >
              詳細・メンバー
            </Link>
          </div>
          {node.children.length > 0 && (
            <div style={{ paddingLeft: '1rem', marginTop: '0.5rem' }}>
              {tree(node.children, `${node.name}の子部署`)}
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <main id="main" className="shell">
      <div className="directory-heading">
        <div>
          <h1>部署管理</h1>
          <p>部署の階層、メンバー、部署長を管理します。</p>
        </div>
        <div className="directory-heading-actions">
          <Link className="directory-cta secondary" href="/ops/users">
            利用者管理
          </Link>
        </div>
      </div>

      {notice && (
        <div className="notice directory-notice" id="department-notice" role="status" tabIndex={-1}>
          <p>{notice}</p>
        </div>
      )}
      {error && (
        <div className="error-summary" id="department-error" role="alert" tabIndex={-1} autoFocus>
          <h2>操作できませんでした</h2>
          <p>{error}</p>
        </div>
      )}

      <section aria-labelledby="department-tree-title">
        <h2 id="department-tree-title">部署のツリー</h2>
        {nodes.length === 0 ? (
          <p className="empty">
            まだ部署がありません。下の「部署を追加」から最初の部署を作成してください。
          </p>
        ) : (
          tree(nodes, '部署のツリー')
        )}
      </section>

      <section
        className="directory-panel"
        aria-labelledby="department-create-title"
        id="department-create"
      >
        <h2 id="department-create-title">部署を追加</h2>
        <form
          action={createDepartmentAction.bind(null, scope, query)}
          aria-describedby={error ? 'department-create-error' : undefined}
        >
          {error && (
            <p className="hint" id="department-create-error">
              {error}
            </p>
          )}
          <fieldset className="directory-form-grid">
            <legend className="visually-hidden">部署を追加</legend>
            <div className="field">
              <label htmlFor="department-code">部署コード</label>
              <p className="hint" id="department-code-hint">
                会話やAPIで部署を指す記号です。例: UI013-SYN-ROOT
              </p>
              <input
                id="department-code"
                name="code"
                type="text"
                required
                maxLength={64}
                aria-describedby="department-code-hint"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="department-name">部署名</label>
              <input
                id="department-name"
                name="name"
                type="text"
                required
                maxLength={200}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="department-parent">親部署</label>
              <p className="hint" id="department-parent-hint">
                未指定なら最上位の部署になります。階層は10階層までです。
              </p>
              <select
                id="department-parent"
                name="parentId"
                defaultValue=""
                aria-describedby="department-parent-hint"
              >
                <option value="">親部署なし（最上位）</option>
                {addParents
                  .filter((option) => option.active)
                  .map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </div>
          </fieldset>
          <div className="directory-form-actions">
            <button type="submit" id="department-create-submit">
              部署を追加する
            </button>
          </div>
        </form>
      </section>

      {query.department && !selected && (
        <p role="status">選択した部署は表示できませんでした。ツリーから選び直してください。</p>
      )}

      {selected && (
        <section
          className="directory-panel"
          id="department-details"
          aria-labelledby="department-details-title"
          tabIndex={-1}
        >
          <div className="directory-detail-heading">
            <h2 id="department-details-title">{selected.name}</h2>
            <Link
              href={departmentHref(query, { department: null, confirm: null })}
              style={actionLinkStyle}
            >
              詳細を閉じる
            </Link>
          </div>
          <p>
            <span className="group-code">{selected.code}</span> ·{' '}
            {selected.active ? '有効' : '無効'} · 親部署: {parent?.name ?? 'なし'}
          </p>

          {selected.active ? (
            <section aria-labelledby="department-edit-title">
              <h3 id="department-edit-title">部署を編集</h3>
              <form
                action={editDepartmentAction.bind(null, scope, query, selected.id)}
                aria-describedby={detailError}
              >
                <fieldset className="directory-form-grid">
                  <legend className="visually-hidden">部署を編集</legend>
                  <div className="field">
                    <label htmlFor="department-edit-code">部署コード</label>
                    <input
                      id="department-edit-code"
                      name="code"
                      type="text"
                      required
                      maxLength={64}
                      defaultValue={selected.code}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="department-edit-name">部署名</label>
                    <input
                      id="department-edit-name"
                      name="name"
                      type="text"
                      required
                      maxLength={200}
                      defaultValue={selected.name}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="department-edit-parent">親部署</label>
                    <select
                      id="department-edit-parent"
                      name="parentId"
                      defaultValue={selected.parentId ?? ''}
                    >
                      <option value="">親部署なし（最上位）</option>
                      {editParents.map((option) => (
                        <option
                          key={option.id}
                          value={option.id}
                          disabled={option.disabledReason !== null}
                        >
                          {option.label}
                          {option.disabledReason ? `（${option.disabledReason}）` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </fieldset>
                <div className="directory-form-actions">
                  <button type="submit" className="secondary">
                    変更を保存する
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <p className="empty">
              この部署は無効化されています。編集やメンバーの変更はできません。
            </p>
          )}

          <section aria-labelledby="department-members-title">
            <h3 id="department-members-title">メンバー</h3>
            {membersResult && !membersResult.ok ? (
              <p className="hint" role="alert">
                メンバーを読み込めませんでした。時間をおいて再度お試しください。
              </p>
            ) : members.length === 0 ? (
              <p className="empty">この部署を主部署にしている利用者はいません。</p>
            ) : (
              <ul className="groups" aria-label="この部署のメンバー">
                {members.map((member) => (
                  <li key={member.userId} className="group">
                    <div className="meta">
                      <span>{member.status === 'active' ? '有効' : '停止中'}</span>
                      {!member.activeMembership && <span>所属が失効しています</span>}
                    </div>
                    <strong>{member.displayName}</strong>
                    <p className="hint" style={{ margin: '0.25rem 0 0' }}>
                      役職: {member.jobTitle ?? '未設定'} / 上長:{' '}
                      {member.managerDisplayName ?? '未設定'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="department-head-title" id="department-head">
            <h3 id="department-head-title">部署長</h3>
            {headResult && !headResult.ok ? (
              <p className="hint" role="alert">
                部署長を読み込めませんでした。時間をおいて再度お試しください。
              </p>
            ) : head ? (
              <>
                <p>
                  現在の部署長: <strong>{head.displayName}</strong>（
                  {formatDateTime(head.validFrom)} から
                  {head.validUntil ? ` ${formatDateTime(head.validUntil)} まで` : '、終了日未設定'}
                  ）
                </p>
                <form
                  action={endHeadAction.bind(null, scope, query, selected.id)}
                  aria-describedby={detailError}
                >
                  <div className="field">
                    <label htmlFor="department-head-end">終了日（任意）</label>
                    <p className="hint" id="department-head-end-hint">
                      空欄なら今日で終了します。任期の延長はできません。延長する場合は新しい任期として設定してください。
                    </p>
                    <input
                      id="department-head-end"
                      name="validUntil"
                      type="date"
                      aria-describedby="department-head-end-hint"
                    />
                  </div>
                  <div className="directory-form-actions">
                    <button type="submit" className="secondary">
                      部署長を終了する
                    </button>
                  </div>
                </form>
                <p className="hint">現在の部署長を終了すると、新しい部署長を設定できます。</p>
              </>
            ) : selected.active ? (
              <>
                <p className="empty">現在の部署長はいません。</p>
                <form
                  action={assignHeadAction.bind(null, scope, query, selected.id)}
                  aria-describedby={detailError}
                >
                  <div className="field">
                    <label htmlFor="department-head-user">部署長にする利用者</label>
                    <p className="hint" id="department-head-user-hint">
                      選択中の組織で有効な所属を持つ利用者だけを候補にしています。
                    </p>
                    <select
                      id="department-head-user"
                      name="userId"
                      required
                      defaultValue=""
                      aria-describedby="department-head-user-hint"
                    >
                      <option value="">選択してください</option>
                      {activeMembers.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="directory-form-actions">
                    <button type="submit">部署長に設定する</button>
                  </div>
                </form>
              </>
            ) : (
              <p className="empty">無効化された部署には部署長を設定できません。</p>
            )}
          </section>

          <section aria-labelledby="department-deactivate-title" id="deactivate-department">
            <h3 id="department-deactivate-title">部署の無効化</h3>
            {selected.active ? (
              <>
                <p>
                  無効化すると元に戻せません。子部署・メンバー・部署長が残っている場合は無効化できません。
                </p>
                {query.confirm === 'deactivate' ? (
                  <div className="notice" aria-labelledby="department-confirm-title">
                    <h4 id="department-confirm-title">部署を無効化しますか</h4>
                    <p>
                      {selected.name}（{selected.code}）を無効化します。この操作は取り消せません。
                    </p>
                    <form
                      action={deactivateDepartmentAction.bind(null, scope, query, selected.id)}
                      className="actions-row"
                    >
                      <button type="submit" className="danger">
                        無効化する
                      </button>
                      <Link
                        href={departmentHref(query, { confirm: null }) + '#department-details'}
                        style={actionLinkStyle}
                      >
                        やめる
                      </Link>
                    </form>
                  </div>
                ) : (
                  <p>
                    <Link
                      href={
                        departmentHref(query, { confirm: 'deactivate' }) + '#deactivate-department'
                      }
                      style={actionLinkStyle}
                    >
                      この部署を無効化する
                    </Link>
                  </p>
                )}
              </>
            ) : (
              <p className="empty">この部署は既に無効化されています。</p>
            )}
          </section>
        </section>
      )}
    </main>
  );
}
