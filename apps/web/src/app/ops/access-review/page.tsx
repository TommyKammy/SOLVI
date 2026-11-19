import Link from 'next/link';
import { AdminBackLink, AdminDenied } from '../../../components/AdminWorkspace';
import { adminViewPath, withAdminReturnTo } from '../../../lib/admin-recovery';
import { navigationRoles } from '../../../lib/navigation';
import { DIRECTORY_ROLE_LABELS } from '../../../lib/user-directory';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../lib/api';
import { TableRegion } from '../../../components/TableRegion';
import { formatDate, formatDateTime } from '../../../lib/labels';

/**
 * アクセスレビュー (NFR-SEC-002 / WP-P1-SEC-024)。
 *
 * 誰が何を持つかは `/ops/users` で見えていた。**見直す機会が無かった。**
 * 一覧が在っても、見る日が決まっていなければ誰も見ない。
 *
 * この画面は「期を開き、1件ずつ判断し、閉じる」ためだけに在る。
 * 閉じた記録が、四半期レビューを実施したという Evidence になる。
 */

export const dynamic = 'force-dynamic';

export default async function AccessReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const returnTo = adminViewPath('/ops/access-review', query);
  const session = await requireSession(returnTo);
  const roles = navigationRoles(session);
  const canManage = roles.admin;
  if (!canManage && !roles.auditor) {
    return <AdminDenied title="アクセスレビュー" canOpenHome={false} />;
  }

  const error = typeof query.error === 'string' ? query.error : null;
  const list = await api.listAccessReviews();
  const reviews = list.ok ? list.data.items : [];
  const open = reviews.find((r) => r.completedAt === null);
  const selected =
    typeof query.review === 'string' ? reviews.find((review) => review.id === query.review) : open;
  const detail = selected ? await api.accessReview(selected.id) : null;
  const completed = reviews.filter((review) => review.completedAt !== null);
  const isOpen = Boolean(selected && selected.id === open?.id);
  const failure = !list.ok ? list.problem : detail && !detail.ok ? detail.problem : null;

  async function openReview(formData: FormData): Promise<void> {
    'use server';
    const done = await api.openAccessReview(String(formData.get('periodLabel') ?? ''));
    if (!done.ok) {
      const detailText =
        done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/access-review?error=${encodeURIComponent(detailText)}`);
    }
    revalidatePath('/ops/access-review');
    redirect('/ops/access-review');
  }

  async function decide(formData: FormData): Promise<void> {
    'use server';
    const reviewId = String(formData.get('reviewId') ?? '');
    const itemId = String(formData.get('itemId') ?? '');
    const decision = String(formData.get('decision') ?? '') === 'revoke' ? 'revoke' : 'keep';
    const done = await api.decideAccessReviewItem(reviewId, itemId, {
      decision,
      reason: String(formData.get('reason') ?? ''),
    });
    if (!done.ok) {
      const detailText =
        done.problem.errors?.[0]?.message ?? done.problem.detail ?? done.problem.title;
      redirect(`/ops/access-review?error=${encodeURIComponent(detailText)}`);
    }
    revalidatePath('/ops/access-review');
    redirect('/ops/access-review');
  }

  async function complete(formData: FormData): Promise<void> {
    'use server';
    const done = await api.completeAccessReview(String(formData.get('reviewId') ?? ''));
    if (!done.ok) {
      const detailText = done.problem.detail ?? done.problem.title;
      redirect(`/ops/access-review?error=${encodeURIComponent(detailText)}`);
    }
    revalidatePath('/ops/access-review');
    redirect('/ops/access-review');
  }

  return (
    <main id="main" className="shell admin-workspace">
      <header className="support-page-heading">
        <div>
          <AdminBackLink />
          <h1>アクセスレビュー</h1>
          <p className="lead">
            {canManage
              ? '付与されている役割を確認し、判断と理由を記録します。'
              : '監査担当者 · 閲覧のみ'}
          </p>
        </div>
        <Link className="support-action" href="/ops/approvals/changes">
          上長・部署長の変更履歴
        </Link>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {failure && (
        <section role="alert" className="admin-permission">
          <h2>レビューを読み込めませんでした</h2>
          {failure.status === 401 ? (
            <Link href={withAdminReturnTo('/login?expired=1', returnTo)}>ログインし直す</Link>
          ) : (
            <a href={returnTo ?? '/ops/access-review'}>レビューを再読み込みする</a>
          )}
        </section>
      )}

      {list.ok && canManage && !open && (
        <section className="admin-panel" aria-labelledby="review-start-title">
          <h2 id="review-start-title">レビューを開始する</h2>
          <p>開始時点で有効な役割を、確認対象として固定します。</p>
          <form className="stack" action={openReview}>
            <div className="field">
              <label htmlFor="periodLabel">期の名前（必須）</label>
              <input
                id="periodLabel"
                name="periodLabel"
                required
                maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]{1,31}"
                placeholder="2026-Q3"
                aria-describedby="review-period-hint"
              />
              <p id="review-period-hint" className="hint">
                半角英数字で始め、2〜32文字で入力してください。
              </p>
            </div>
            <div className="form-actions">
              <button type="submit">レビューを開始</button>
            </div>
          </form>
        </section>
      )}

      {list.ok && typeof query.review === 'string' && !selected && (
        <p role="status">選択したレビューを表示できません。実施記録から選び直してください。</p>
      )}
      {open && selected?.id !== open.id && (
        <p>
          <Link href="/ops/access-review">進行中のレビューを開く</Link>
        </p>
      )}

      {selected && detail?.ok && (
        <section className="admin-panel" aria-labelledby="review-detail-title">
          <h2 id="review-detail-title">{selected.periodLabel}</h2>
          <p role="status">
            {isOpen ? '進行中' : '完了'} · 対象 {selected.totalItems} 件 · 未判断{' '}
            {selected.pendingItems} 件
          </p>
          <p className="hint">
            開始 {formatDateTime(selected.openedAt)}
            {selected.completedAt && <> · 完了 {formatDateTime(selected.completedAt)}</>}
          </p>
          <p className="hint">
            この組織の役割が対象です。プラットフォーム全体の役割は別の手続きで確認します。
          </p>
          <ul className="admin-review-items" role="list" aria-label="レビュー対象">
            {detail.data.items.map((item) => (
              <li key={item.id}>
                <div>
                  <h3>{item.displayName}</h3>
                  {canManage && (
                    <p className="admin-review-identity">
                      {item.email}
                      {item.userId === session.userId ? ' · 自分' : ''}
                    </p>
                  )}
                  <p>
                    {DIRECTORY_ROLE_LABELS[item.roleCode] ?? item.roleCode} ·{' '}
                    {item.validUntilAtOpen ? formatDate(item.validUntilAtOpen) : '期限なし'}
                  </p>
                </div>
                {item.decision !== 'pending' ? (
                  <div>
                    <strong>{item.decision === 'keep' ? '維持' : '失効済み'}</strong>
                    {item.selfReviewed && '（自分で判断）'}
                    <p>{item.reason}</p>
                  </div>
                ) : item.alreadyInactive ? (
                  <p>既に失効済み</p>
                ) : isOpen && canManage ? (
                  <form className="stack" action={decide}>
                    <input type="hidden" name="reviewId" value={selected.id} />
                    <input type="hidden" name="itemId" value={item.id} />
                    <div className="field">
                      <label htmlFor={'reason-' + item.id}>判断の理由（必須）</label>
                      <input id={'reason-' + item.id} name="reason" required maxLength={500} />
                    </div>
                    <div className="form-actions">
                      <button type="submit" name="decision" value="keep">
                        維持する
                      </button>
                      <button className="secondary" type="submit" name="decision" value="revoke">
                        失効させる
                      </button>
                    </div>
                  </form>
                ) : (
                  <p>判断待ち</p>
                )}
              </li>
            ))}
          </ul>
          {isOpen && canManage && (
            <form action={complete} className="stack admin-review-complete">
              <input type="hidden" name="reviewId" value={selected.id} />
              <div className="form-actions">
                <button type="submit" disabled={selected.pendingItems > 0}>
                  レビューを完了する
                </button>
                {selected.pendingItems > 0 && (
                  <span className="hint">すべて判断すると完了できます。</span>
                )}
              </div>
            </form>
          )}
        </section>
      )}

      {list.ok && (
        <section className="admin-panel">
          <h2>これまでの実施記録</h2>
          {completed.length === 0 ? (
            <p>完了したレビューはまだありません。</p>
          ) : (
            <TableRegion label="完了したアクセスレビュー">
              <table className="tickets admin-history-table">
                <caption className="visually-hidden">完了したアクセスレビュー</caption>
                <thead>
                  <tr>
                    <th scope="col">期</th>
                    <th scope="col">開始</th>
                    <th scope="col">完了</th>
                    <th scope="col">対象</th>
                  </tr>
                </thead>
                <tbody>
                  {completed.map((review) => (
                    <tr key={review.id}>
                      <th scope="row">
                        <Link
                          href={'/ops/access-review?' + new URLSearchParams({ review: review.id })}
                        >
                          {review.periodLabel}
                        </Link>
                      </th>
                      <td>{formatDate(review.openedAt)}</td>
                      <td>{formatDate(review.completedAt!)}</td>
                      <td>{review.totalItems} 件</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          )}
        </section>
      )}
    </main>
  );
}
