import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/labels';

/**
 * グループのメンバー管理 (FR-TKT-003 / WP-P2-GRP-015)。
 *
 * メンバーが要るのは「自分のグループのキュー」を引くためである。
 * これが無いと担当者は全グループのキューを目で選り分けることになり、
 * **キューの意味が無くなる。**
 *
 * 追加は利用者IDで行う。**利用者の一覧を出さない** —
 * 組織の在籍者一覧は、それ自体が名簿である。既にIDを知っている
 * 管理者が入れる形にとどめ、選択式にするのは利用者管理の画面ができてから。
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
          <Link href="/ops">対応待ちの一覧へ戻る</Link>
        </p>
      </main>
    );
  }

  const groupList = await api.listGroups(true);
  if (!groupList.ok) notFound();
  const group = groupList.data.items.find((g) => g.id === id);
  // 他組織のグループはAPIが返さないため、ここで見つからない = 存在しないか権限外。
  if (!group) notFound();

  const memberResult = await api.listGroupMembers(id);
  const members = memberResult.ok ? memberResult.data.items : [];

  async function addMember(formData: FormData): Promise<void> {
    'use server';
    const done = await api.addGroupMember(id, String(formData.get('userId') ?? ''));
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/groups/${id}?error=${encodeURIComponent(detail)}`);
    }
    revalidatePath(`/ops/groups/${id}`);
    redirect(`/ops/groups/${id}`);
  }

  async function removeMember(formData: FormData): Promise<void> {
    'use server';
    const done = await api.removeGroupMember(id, String(formData.get('userId') ?? ''));
    if (!done.ok) redirect(`/ops/groups/${id}?error=1`);
    revalidatePath(`/ops/groups/${id}`);
    redirect(`/ops/groups/${id}`);
  }

  return (
    <main id="main" className="shell">
      <p>
        <Link href="/ops/groups">グループの一覧へ戻る</Link>
      </p>

      <h1>{group.name} のメンバー</h1>
      <p className="lead">
        ここに入っている人が、このグループのキューを「自分のグループ」として絞り込めます。
      </p>

      {typeof query.error === 'string' && (
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>操作できませんでした</h2>
          <p style={{ margin: 0 }}>{query.error}</p>
        </div>
      )}

      {members.length === 0 ? (
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
              <div className="meta">
                <time dateTime={member.addedAt}>{formatDateTime(member.addedAt)} に追加</time>
              </div>
              <form action={removeMember} style={{ marginTop: '0.5rem' }}>
                <input type="hidden" name="userId" value={member.userId} />
                <button type="submit" className="secondary">
                  このグループから外す
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2>メンバーを追加する</h2>
      <form action={addMember} className="stack" style={{ maxWidth: '32rem' }}>
        <div className="field">
          <label htmlFor="member-id">利用者ID</label>
          {/* **在籍者の一覧を出さない。** 組織の名簿そのものになる。
              選択式にするのは利用者管理の画面ができてから。 */}
          <span className="hint" id="member-id-hint">
            追加する方の利用者IDを入力してください。同じ組織に在籍している方のみ追加できます。
          </span>
          <input
            id="member-id"
            name="userId"
            type="text"
            required
            maxLength={64}
            aria-describedby="member-id-hint"
            autoComplete="off"
          />
        </div>
        <button type="submit">追加する</button>
      </form>
    </main>
  );
}
