import { ContextLink } from '../../../../components/ContextLink';
import { GroupMembershipControls } from '../../../../components/GroupMembershipControls';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/labels';
import {
  groupMemberQuery,
  groupMemberUrl,
  groupMemberOperationUrl,
  groupMemberView,
} from '../../../../lib/group-member-selection';

/**
 * グループのメンバー管理 (FR-TKT-003 / WP-P2-GRP-015)。
 *
 * メンバーが要るのは「自分のグループのキュー」を引くためである。
 * これが無いと担当者は全グループのキューを目で選り分けることになり、
 * **キューの意味が無くなる。**
 *
 * 管理者限定の在籍者APIから検索・選択する (WP-P2-UX-036)。
 * 一般担当者へ名簿を公開せず、停止/期限切れ/所属済みを追加候補から除く。
 */

export const dynamic = 'force-dynamic';

export default async function GroupMembers({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requireSession();

  const canManage = session.roles.some((r) => ['org_admin', 'platform_admin'].includes(r.roleCode));
  if (!canManage) {
    return (
      <main id="main" className="shell">
        <h1>グループのメンバー</h1>
        <p className="empty">この画面を表示する権限がありません。</p>
        <p>
          <ContextLink back href="/ops">
            対応待ちの一覧へ戻る
          </ContextLink>
        </p>
      </main>
    );
  }

  const groupList = await api.listGroups(true);
  if (!groupList.ok) notFound();
  const group = groupList.data.items.find((g) => g.id === id);
  // 他組織のグループはAPIが返さないため、ここで見つからない = 存在しないか権限外。
  if (!group) notFound();

  const [memberResult, peopleResult] = await Promise.all([
    api.listGroupMembers(id),
    api.listMembers(),
  ]);
  const members = memberResult.ok ? memberResult.data.items : [];
  const people = peopleResult.ok ? peopleResult.data.items : [];
  const personById = new Map(people.map((person) => [person.userId, person]));
  const memberIds = new Set(members.map((member) => member.userId));
  const selection = groupMemberQuery(query);
  const view = groupMemberView(people, memberIds, selection);
  const readReady = memberResult.ok && peopleResult.ok;
  const ready = memberResult.ok && peopleResult.ok && group.active;

  async function addMember(formData: FormData): Promise<void> {
    // 最終認可・現在の所属と停止状態の再検証は既存APIが行う。
    'use server';
    const done = await api.addGroupMember(id, String(formData.get('userId') ?? ''));
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(groupMemberOperationUrl(id, selection, 'error', detail));
    }
    revalidatePath(`/ops/groups/${id}`);
    redirect(groupMemberOperationUrl(id, selection, 'notice', 'added'));
  }

  async function removeMember(formData: FormData): Promise<void> {
    'use server';
    const done = await api.removeGroupMember(id, String(formData.get('userId') ?? ''));
    if (!done.ok)
      redirect(
        groupMemberOperationUrl(id, selection, 'error', done.problem.detail ?? done.problem.title),
      );
    revalidatePath(`/ops/groups/${id}`);
    redirect(groupMemberOperationUrl(id, selection, 'notice', 'removed'));
  }

  return (
    <main id="main" className="shell">
      <p>
        <ContextLink back href="/ops/groups">
          グループの一覧へ戻る
        </ContextLink>
      </p>

      <h1>{group.name} のメンバー</h1>
      <p className="lead">
        ここに入っている人が、このグループのキューを「自分のグループ」として絞り込めます。
      </p>
      <p className="hint">
        選択中の組織の在籍者だけを表示します。追加しても担当者などの役割は付与されません。
      </p>
      {!group.active && (
        <p className="notice">
          このグループは無効です。新しいメンバーは追加できません。既存メンバーの確認・解除はできます。
        </p>
      )}
      {query.notice === 'added' && (
        <p role="status">メンバーの追加を受け付けました。所属済みの人は重複して追加されません。</p>
      )}
      {query.notice === 'removed' && <p role="status">このグループからメンバーを外しました。</p>}

      {typeof query.error === 'string' && (
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>操作できませんでした</h2>
          <p style={{ margin: 0 }}>{query.error}</p>
        </div>
      )}

      <h2>{memberResult.ok ? `現在のメンバー · ${members.length}人` : '現在のメンバー'}</h2>
      {!memberResult.ok ? (
        <>
          <p role="alert">メンバーを取得できませんでした。再読み込みしてください。</p>
          <p className="hint">
            検索条件を保ったまま、もう一度読み込めます。{' '}
            <a href={groupMemberUrl(id, selection)}>メンバーを再取得する</a>
          </p>
        </>
      ) : members.length === 0 ? (
        // **黙って空にしない。** メンバーが居ないグループはキューとして
        // 機能しない(誰も自分のキューとして見られない)。
        <div className="notice" role="note">
          <h2 style={{ marginTop: 0 }}>メンバーが居ません</h2>
          <p style={{ margin: 0 }}>
            このグループへ振っても、誰も「自分のグループ」として見つけられません。
            担当する方を追加してください。
          </p>
        </div>
      ) : (
        <ul className="groups">
          {members.map((member) => (
            <li key={member.userId} className="group">
              <strong>{member.displayName}</strong>
              <p className="hint">{personById.get(member.userId)?.email}</p>
              <p className="hint">
                {personById.get(member.userId)?.status === 'deactivated'
                  ? '利用停止中 · 追加候補には表示しません'
                  : personById.has(member.userId)
                    ? '現在この組織に在籍'
                    : peopleResult.ok
                      ? '現在有効な組織所属がありません'
                      : '在籍状態を取得できません'}
              </p>
              <div className="meta">
                <time dateTime={member.addedAt}>{formatDateTime(member.addedAt)} に追加</time>
              </div>
              <form action={removeMember} style={{ marginTop: '0.5rem' }}>
                <input type="hidden" name="userId" value={member.userId} />
                <GroupMembershipControls operation="remove">
                  <button type="submit" className="secondary">
                    このグループから外す
                  </button>
                </GroupMembershipControls>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2>メンバーを追加する</h2>
      <form action={`/ops/groups/${id}`} method="get" className="stack form-panel">
        {selection.returnTo && <input type="hidden" name="returnTo" value={selection.returnTo} />}
        <div className="field">
          <label htmlFor="member-search">名前・メールで在籍者を検索</label>
          <input
            id="member-search"
            name="q"
            type="search"
            maxLength={200}
            defaultValue={selection.q}
            placeholder="名前またはメールの一部"
          />
        </div>
        <div className="field">
          <label htmlFor="member-filter">表示する在籍者</label>
          <select id="member-filter" name="filter" defaultValue={selection.filter}>
            <option value="all">すべての検索結果</option>
            <option value="available">追加可能のみ</option>
          </select>
        </div>
        <div className="form-actions">
          <button type="submit" className="secondary">
            検索する
          </button>
          {(selection.q || selection.filter !== 'all' || selection.page !== 1) && (
            <a href={groupMemberUrl(id, { ...selection, q: '', filter: 'all', page: 1 })}>
              検索を解除する
            </a>
          )}
        </div>
      </form>
      {!peopleResult.ok && (
        <>
          <p role="alert">在籍者候補を取得できないため追加できません。再読み込みしてください。</p>
          <p className="hint">
            検索条件を保ったまま、もう一度読み込めます。{' '}
            <a href={groupMemberUrl(id, selection)}>在籍者候補を再取得する</a>
          </p>
        </>
      )}
      {readReady && (
        <p className="hint" role="status">
          追加可能 {view.available}人 · 所属済み {view.member}人 · 停止中 {view.stopped}
          人（検索結果内）。所属期限が切れた人や他組織の人は候補に含みません。
        </p>
      )}
      {readReady && (
        <>
          <p className="hint" role="status">
            在籍者 {view.total}人 · 検索結果 {view.matched}人 · 表示条件に一致 {view.filtered}人 ·{' '}
            {view.start}〜{view.end}人を表示 · {selection.page}ページ（全{view.pages}ページ）
          </p>
          {view.empty === 'users' && <p className="empty">この組織の在籍者が居ません。</p>}
          {view.empty === 'search' && (
            <p className="empty">
              検索条件に一致する在籍者が居ません。検索を解除して確認してください。
            </p>
          )}
          {view.empty === 'available' && (
            <p className="empty">
              検索結果に追加可能な在籍者が居ません。すべての検索結果で在籍状態を確認してください。
            </p>
          )}
          {view.empty === 'page' && (
            <p className="empty">このページに在籍者が居ません。先頭ページから確認してください。</p>
          )}
          {selection.filter === 'all' && view.pageEligible === 0 && view.available > 0 && (
            <p className="hint">
              このページの在籍者は追加できません。{' '}
              <a href={groupMemberUrl(id, { ...selection, filter: 'available', page: 1 })}>
                追加可能のみを表示する
              </a>
            </p>
          )}
          <nav className="form-actions" aria-label="在籍者候補のページ">
            {view.previous && (
              <a href={groupMemberUrl(id, { ...selection, page: selection.page - 1 })}>
                前のページ
              </a>
            )}
            {view.next && (
              <a href={groupMemberUrl(id, { ...selection, page: selection.page + 1 })}>
                次のページ
              </a>
            )}
            {selection.page !== 1 && (
              <a href={groupMemberUrl(id, { ...selection, page: 1 })}>先頭ページへ戻る</a>
            )}
          </nav>
        </>
      )}
      <form action={addMember} className="stack" style={{ maxWidth: '32rem' }}>
        <GroupMembershipControls operation="add">
          <div className="field">
            <label htmlFor="member-id">追加する在籍者</label>
            <span className="hint" id="member-id-hint">
              同じ組織の有効な在籍者から選びます。所属済み・停止中の人は選べません。
            </span>
            <select
              id="member-id"
              name="userId"
              required
              defaultValue=""
              disabled={!ready || view.pageEligible === 0}
              aria-describedby="member-id-hint"
            >
              <option value="">名前とメールを確認して選ぶ</option>
              {view.items.map((person) => (
                <option
                  key={person.userId}
                  value={person.userId}
                  disabled={person.status !== 'active' || memberIds.has(person.userId)}
                >
                  {person.displayName} · {person.email}
                  {memberIds.has(person.userId)
                    ? '（所属済み）'
                    : person.status === 'deactivated'
                      ? '（停止中）'
                      : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={!ready || view.pageEligible === 0}>
              選んだ在籍者を追加する
            </button>
          </div>
        </GroupMembershipControls>
      </form>
      {ready && view.pageEligible === 0 && !view.empty && view.available === 0 && (
        <p className="empty">
          追加できる在籍者が見つかりません。検索条件または在籍者の状態を確認してください。
        </p>
      )}
    </main>
  );
}
