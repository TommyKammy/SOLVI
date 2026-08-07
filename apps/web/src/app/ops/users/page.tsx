import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';

/**
 * 在籍者の管理 (FR-IDM-007 / WP-P1-IDM-011)。
 *
 * **退職者のアクセスを止める手段が無かった。** サービス層には
 * `deactivateUser` があったが、呼ぶ経路が画面にもAPIにも存在せず、
 * アカウントは有効なまま残り続けていた。
 *
 * ここは**名簿を出してよい場所**である。担当グループの画面では
 * 在籍者の一覧を出さないと決めた(業務の画面に名簿を置かない)が、
 * 在籍者の管理そのものを行う画面では、一覧が無いと仕事にならない。
 */

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  requester: '依頼者',
  agent: '担当者',
  approver: '承認者',
  auditor: '監査',
  org_admin: '組織管理者',
  platform_admin: 'プラットフォーム管理者',
};

export default async function ManageUsers({
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
        <h1>在籍者の管理</h1>
        <p className="empty">この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
        <p>
          <Link href="/ops">対応待ちの一覧へ戻る</Link>
        </p>
      </main>
    );
  }

  const result = await api.listMembers();
  const members = result.ok ? result.data.items : [];

  async function deactivate(formData: FormData): Promise<void> {
    'use server';
    const userId = String(formData.get('userId') ?? '');
    const done = await api.deactivateUser(userId, String(formData.get('reason') ?? ''));
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/users?error=${encodeURIComponent(detail)}`);
    }
    revalidatePath('/ops/users');
    // **止めたあとに担当が残っていることを伝える。** 黙って止めると、
    // その人が持っていたチケットが誰にも見られないまま滞留する。
    redirect(
      done.data.openTicketCount > 0
        ? `/ops/users?stopped=${done.data.openTicketCount}`
        : '/ops/users?stopped=0',
    );
  }

  async function reactivate(formData: FormData): Promise<void> {
    'use server';
    const userId = String(formData.get('userId') ?? '');
    const done = await api.reactivateUser(userId, String(formData.get('reason') ?? ''));
    if (!done.ok) {
      const detail = done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/users?error=${encodeURIComponent(detail)}`);
    }
    revalidatePath('/ops/users');
    redirect('/ops/users');
  }

  return (
    <main id="main" className="shell">
      <p>
        <Link href="/ops">対応待ちの一覧へ戻る</Link>
      </p>

      <h1>在籍者の管理</h1>
      <p className="lead">
        退職・休職・事故対応でアクセスを止めます。 止めても問い合わせの履歴と担当の記録は残ります。
      </p>

      {typeof query.error === 'string' && (
        <div className="error-summary" role="alert" tabIndex={-1} autoFocus>
          <h2>操作できませんでした</h2>
          <p style={{ margin: 0 }}>{query.error}</p>
        </div>
      )}

      {typeof query.stopped === 'string' && (
        <div className="notice" role="status">
          <h2 style={{ marginTop: 0 }}>アクセスを止めました</h2>
          <p style={{ margin: 0 }}>
            {Number(query.stopped) > 0
              ? `対応中の問い合わせが ${query.stopped} 件残っています。別の担当者へ振り直してください。`
              : 'その場でログイン中のセッションも切れています。'}
          </p>
        </div>
      )}

      {members.length === 0 ? (
        <p className="empty">在籍者を取得できませんでした。</p>
      ) : (
        <ul className="groups">
          {members.map((member) => {
            const stopped = member.status === 'deactivated';
            const isSelf = member.userId === session.userId;
            return (
              <li key={member.userId} className={stopped ? 'group inactive' : 'group'}>
                <div className="meta">
                  {/* **止まっていることを文言で書く。** 色や薄さだけに頼らない。 */}
                  {stopped && <span className="state">アクセス停止中</span>}
                  <span>{member.roleCodes.map((c) => ROLE_LABELS[c] ?? c).join(' / ')}</span>
                  {member.openTicketCount > 0 && <span>対応中 {member.openTicketCount} 件</span>}
                </div>
                <strong>{member.displayName}</strong>
                <p style={{ margin: '0.25rem 0 0' }}>{member.email}</p>

                {member.temporaryRoles.length > 0 && (
                  // **期限は静かに来る** (FR-IDM-006)。
                  // 出しておかないと、切れた日に本人も管理者も理由が分からない。
                  <ul className="temporary-roles">
                    {member.temporaryRoles.map((t) => {
                      const days = Math.ceil(
                        (new Date(t.validUntil).getTime() - Date.now()) / 86_400_000,
                      );
                      return (
                        <li
                          key={`${t.roleCode}:${t.validUntil}`}
                          className={days <= 30 ? 'soon' : ''}
                        >
                          {ROLE_LABELS[t.roleCode] ?? t.roleCode} は {formatDateTime(t.validUntil)}{' '}
                          まで
                          {/* 色だけに頼らない。**残り日数を文言で言う。** */}
                          {days <= 30 && <strong>(あと {Math.max(days, 0)} 日)</strong>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {stopped && member.deactivatedAt && (
                  <p className="hint" style={{ margin: '0.25rem 0 0' }}>
                    {formatDateTime(member.deactivatedAt)} に停止
                  </p>
                )}

                {isSelf ? (
                  // 自分を止めると、その場でセッションが切れて元に戻せなくなる。
                  <p className="hint" style={{ marginTop: '0.5rem' }}>
                    自分自身のアクセスは止められません。
                  </p>
                ) : (
                  <details className="user-action">
                    <summary>{stopped ? 'アクセスを戻す' : 'アクセスを止める'}</summary>

                    {!stopped && member.openTicketCount > 0 && (
                      // **止める前に見せる。** 止めたあとで気付くと、
                      // その人が持っていたチケットが滞留する。
                      <div className="notice" role="note">
                        <p style={{ margin: 0 }}>
                          対応中の問い合わせを {member.openTicketCount} 件持っています。
                          先に振り直すことをお勧めします(止めること自体は妨げません)。
                        </p>
                      </div>
                    )}

                    <form action={stopped ? reactivate : deactivate} className="stack">
                      <input type="hidden" name="userId" value={member.userId} />
                      <div className="field">
                        <label htmlFor={`reason-${member.userId}`}>
                          {stopped ? '戻す理由' : '止める理由'}
                        </label>
                        {/* 理由は監査に残る。**退職と事故対応を後から区別できないと、
                            記録として意味を持たない。** */}
                        <span className="hint" id={`reason-hint-${member.userId}`}>
                          {stopped
                            ? '例: 休職から復帰 / 誤って停止した'
                            : '例: 2026-08-31 付で退職 / 端末の紛失により一時停止'}
                        </span>
                        <input
                          id={`reason-${member.userId}`}
                          name="reason"
                          type="text"
                          required
                          maxLength={500}
                          aria-describedby={`reason-hint-${member.userId}`}
                        />
                      </div>
                      {!stopped && (
                        <p className="field-error" style={{ margin: 0 }}>
                          止めると、その場でログイン中のセッションも切れます。
                        </p>
                      )}
                      <button type="submit" className={stopped ? 'secondary' : 'danger'}>
                        {stopped ? 'アクセスを戻す' : 'アクセスを止める'}
                      </button>
                    </form>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
