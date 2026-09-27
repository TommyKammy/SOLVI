import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, requireSession } from '../../../lib/api';

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
  const session = await requireSession();
  const error = typeof query.error === 'string' ? query.error : null;

  const canManage = session.roles.some((r) => ['org_admin', 'platform_admin'].includes(r.roleCode));
  if (!canManage) {
    // **表示しないことを防御にしない。** APIは権限が無ければ 403 を返す。
    return (
      <main id="main" className="shell">
        <h1>アクセスレビュー</h1>
        <p className="empty">
          この画面を表示する権限がありません。組織の管理者へご連絡ください。
        </p>
        <p>
          <Link href="/ops">対応待ちの一覧へ戻る</Link>
        </p>
      </main>
    );
  }

  const list = await api.listAccessReviews();
  const reviews = list.ok ? list.data.items : [];
  const open = reviews.find((r) => r.completedAt === null);
  const detail = open ? await api.accessReview(open.id) : null;

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
    <main id="main" className="shell">
      <p>
        <Link href="/ops">対応待ちの一覧へ戻る</Link> ・{' '}
        <Link href="/ops/users">在籍者の管理へ</Link>
      </p>

      <h1>アクセスレビュー</h1>
      <p className="lead">
        いま誰がどの役割を持っているかを、1件ずつ見直します。
        <strong>取り消しの判断は、その場で実際に役割を失効させます。</strong>
      </p>

      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      {open === undefined ? (
        <section>
          <h2>レビューを開始する</h2>
          <p>
            開始すると、<strong>その時点で有効な役割</strong>が対象として固定されます。
            開始後に与えられた役割は、次の期で見直します。
          </p>
          <form action={openReview}>
            <label htmlFor="periodLabel">期の名前</label>
            <input
              id="periodLabel"
              name="periodLabel"
              required
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,31}"
              placeholder="2026-Q3"
            />
            <button type="submit">レビューを開始</button>
          </form>
        </section>
      ) : null}

      {open !== undefined && detail?.ok ? (
        <section>
          <h2>進行中: {open.periodLabel}</h2>
          <p>
            開始 {new Date(open.openedAt).toLocaleString('ja-JP')} ・ 対象 {open.totalItems} 件 ・{' '}
            <strong>未判断 {open.pendingItems} 件</strong>
          </p>
          <p className="note">
            プラットフォーム全体の役割(<code>platform_admin</code> ・ <code>platform_auditor</code>
            )は、この画面の対象外です。組織の文脈を持たないため、
            <strong>この組織からは件数も見えません</strong>
            。0件という意味ではありません。別の手続きで確認してください。
          </p>

          <table>
            <caption>レビュー対象</caption>
            <thead>
              <tr>
                <th scope="col">利用者</th>
                <th scope="col">役割</th>
                <th scope="col">期限</th>
                <th scope="col">判断</th>
              </tr>
            </thead>
            <tbody>
              {detail.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.displayName}
                    <br />
                    <small>{item.email}</small>
                    {item.userId === session.userId ? <small> ・自分</small> : null}
                  </td>
                  <td>{item.roleCode}</td>
                  <td>
                    {item.validUntilAtOpen
                      ? new Date(item.validUntilAtOpen).toLocaleDateString('ja-JP')
                      : '期限なし'}
                  </td>
                  <td>
                    {item.decision !== 'pending' ? (
                      <span>
                        {item.decision === 'keep' ? '残す' : '取り消した'}
                        {item.selfReviewed ? '(自分で判断)' : ''}
                        <br />
                        <small>{item.reason}</small>
                      </span>
                    ) : item.alreadyInactive ? (
                      // 開いた後に別経路で失効したもの。判断は要らない。
                      <span>既に無効(判断は不要)</span>
                    ) : (
                      <form action={decide}>
                        <input type="hidden" name="reviewId" value={open.id} />
                        <input type="hidden" name="itemId" value={item.id} />
                        <label htmlFor={`reason-${item.id}`}>理由</label>
                        <input id={`reason-${item.id}`} name="reason" required maxLength={500} />
                        <button type="submit" name="decision" value="keep">
                          残す
                        </button>
                        <button type="submit" name="decision" value="revoke">
                          取り消す
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form action={complete}>
            <input type="hidden" name="reviewId" value={open.id} />
            <button type="submit" disabled={open.pendingItems > 0}>
              レビューを完了する
            </button>
            {open.pendingItems > 0 ? (
              <p className="note">
                未判断が {open.pendingItems} 件あります。すべて判断すると完了できます。
              </p>
            ) : null}
          </form>
        </section>
      ) : null}

      <section>
        <h2>これまでの実施記録</h2>
        {reviews.filter((r) => r.completedAt !== null).length === 0 ? (
          <p className="empty">完了したレビューはまだありません。</p>
        ) : (
          <table>
            <caption>完了したアクセスレビュー</caption>
            <thead>
              <tr>
                <th scope="col">期</th>
                <th scope="col">開始</th>
                <th scope="col">完了</th>
                <th scope="col">対象</th>
              </tr>
            </thead>
            <tbody>
              {reviews
                .filter((r) => r.completedAt !== null)
                .map((r) => (
                  <tr key={r.id}>
                    <td>{r.periodLabel}</td>
                    <td>{new Date(r.openedAt).toLocaleDateString('ja-JP')}</td>
                    <td>{new Date(r.completedAt as string).toLocaleDateString('ja-JP')}</td>
                    <td>{r.totalItems} 件</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
