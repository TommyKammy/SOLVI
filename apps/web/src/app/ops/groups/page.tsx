import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../lib/api';

/**
 * 担当グループの管理 (FR-TKT-003 / WP-P2-GRP-015)。
 *
 * **管理する手段を同時に作る。** グループへ振る機能だけを作って
 * 作る手段を用意しないと、新しく構築した環境では誰もグループを作れず、
 * 機能が使えない。シードのデータでしか動かないものは
 * 「作ったが使えない」状態である。
 *
 * 触れるのは組織の管理者だけ。担当者は振るだけで、体制を変えられない。
 */

export const dynamic = 'force-dynamic';

export default async function ManageGroups({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const session = await requireSession();

  const canManage = session.roles.some((r) => ['org_admin', 'platform_admin'].includes(r.roleCode));
  if (!canManage) {
    // **表示しないことを防御にしない。** APIは権限が無ければ 403 を返す。
    return (
      <main id="main" className="shell">
        <h1>担当グループの管理</h1>
        <p className="empty">この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
        <p>
          <Link href="/ops">対応待ちの一覧へ戻る</Link>
        </p>
      </main>
    );
  }

  // 無効化したものも出す。管理画面では「運用から外したもの」も見えないと、
  // 同じ記号で作り直そうとして重複エラーになる。
  const result = await api.listGroups(true);
  const groups = result.ok ? result.data.items : [];

  async function createGroup(formData: FormData): Promise<void> {
    'use server';
    const done = await api.createGroup({
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? ''),
    });
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/groups?error=${encodeURIComponent(detail)}`);
    }
    revalidatePath('/ops/groups');
    redirect('/ops/groups');
  }

  async function toggleActive(formData: FormData): Promise<void> {
    'use server';
    const groupId = String(formData.get('groupId') ?? '');
    const active = String(formData.get('active') ?? '') === 'true';
    const done = await api.setGroupActive(groupId, active);
    if (!done.ok) redirect('/ops/groups?error=1');
    revalidatePath('/ops/groups');
    redirect('/ops/groups');
  }

  return (
    <main id="main" className="shell">
      <p>
        <Link href="/ops">対応待ちの一覧へ戻る</Link>
      </p>

      <h1>担当グループの管理</h1>
      <p className="lead">
        問い合わせをまず受けるキューです。担当者はグループのキューから引き受けます。
      </p>

      {typeof query.error === 'string' && (
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>操作できませんでした</h2>
          <p style={{ margin: 0 }}>{query.error}</p>
        </div>
      )}

      <h2>いまあるグループ</h2>
      {groups.length === 0 ? (
        <p className="empty">まだグループがありません。下のフォームから作成してください。</p>
      ) : (
        <ul className="groups">
          {groups.map((group) => (
            <li key={group.id} className={group.active ? 'group' : 'group inactive'}>
              <div className="meta">
                <span className="group-code">{group.code}</span>
                {!group.active && <span className="state">運用から外れています</span>}
                <span>{group.memberCount}人</span>
              </div>
              <strong>{group.name}</strong>
              {group.description && <p style={{ margin: '0.25rem 0 0' }}>{group.description}</p>}

              <div className="actions-row" style={{ marginTop: '0.5rem' }}>
                <Link href={`/ops/groups/${group.id}`}>メンバーを見る</Link>
                <form action={toggleActive}>
                  <input type="hidden" name="groupId" value={group.id} />
                  <input type="hidden" name="active" value={group.active ? 'false' : 'true'} />
                  {/* **削除は無い。** 消すと過去のチケットが振り先を失う。
                      運用から外すのは無効化で行う。 */}
                  <button type="submit" className="secondary">
                    {group.active ? '運用から外す' : '運用に戻す'}
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>グループを作る</h2>
      <form action={createGroup} className="stack" style={{ maxWidth: '32rem' }}>
        <div className="field">
          <label htmlFor="group-name">名前</label>
          <span className="hint" id="group-name-hint">
            画面と一覧に出ます。例: ヘルプデスク / インフラ担当
          </span>
          <input
            id="group-name"
            name="name"
            type="text"
            required
            maxLength={120}
            aria-describedby="group-name-hint"
          />
        </div>

        <div className="field">
          <label htmlFor="group-code">記号</label>
          {/* 記号を持たせるのは、会話やAPIで指し示すためである。
              UUIDを人に読ませない(WP-P1-IDM-010 と同じ理由)。 */}
          <span className="hint" id="group-code-hint">
            英小文字・数字・ハイフン・下線で2〜32文字。例: helpdesk
          </span>
          <input
            id="group-code"
            name="code"
            type="text"
            required
            maxLength={32}
            pattern="[a-z0-9][a-z0-9_\-]{1,31}"
            aria-describedby="group-code-hint"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="group-description">説明(任意)</label>
          <span className="hint" id="group-desc-hint">
            どんな問い合わせを受けるかを書くと、振り間違いが減ります
          </span>
          <input
            id="group-description"
            name="description"
            type="text"
            maxLength={500}
            aria-describedby="group-desc-hint"
          />
        </div>

        <button type="submit">作成する</button>
      </form>
    </main>
  );
}
