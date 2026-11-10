import { ContextLink } from '../../../components/ContextLink';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { ChangePlanForm } from '../../../components/ChangeForms';
import { safeReturnTo } from '../../../lib/navigation';
export default async function NewChangePage({
  searchParams,
}: {
  searchParams: Promise<{ ticketId?: string; assetId?: string; returnTo?: string | string[] }>;
}) {
  const user = await requireSession(),
    p = await searchParams,
    r = await api.changeFormOptions(
      new URLSearchParams({
        ...(p.ticketId ? { ticketId: p.ticketId } : {}),
        ...(p.assetId ? { assetIds: p.assetId } : {}),
      }).toString(),
    );
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const returnTo = safeReturnTo(p.returnTo);
    const retry = new URLSearchParams();
    for (const key of ['ticketId', 'assetId'] as const) {
      const value = p[key];
      if (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      )
        retry.set(key, value);
    }
    if (returnTo) retry.set('returnTo', returnTo);
    const retryUrl = '/changes/new' + (retry.size > 0 ? '?' + retry.toString() : '');
    const message =
      r.problem.status === 400
        ? '入力候補を取得できませんでした。元の画面や変更一覧から開き直してください。'
        : r.problem.status === 401
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : '入力候補を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>入力候補を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <div className="form-actions">
          <a href={retryUrl}>再取得する</a>
          {returnTo && <a href={returnTo}>元の画面へ戻る</a>}
          <a href="/changes">変更一覧へ戻る</a>
          <a href="/portal">ポータルへ戻る</a>
        </div>
      </main>
    );
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href="/changes">
        変更一覧へ戻る
      </ContextLink>
      <h1>通常変更の計画を作成する</h1>
      <p>元のチケットと対象資産を選び、まず下書きとして保存します。</p>
      <ChangePlanForm
        options={r.data}
        userId={user.userId}
        creationKey={randomUUID()}
        commandKey={randomUUID()}
        ticketId={p.ticketId}
        assetId={p.assetId}
      />
    </main>
  );
}
