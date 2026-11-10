import { ContextLink } from '../../../../components/ContextLink';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { ChangePlanForm } from '../../../../components/ChangeForms';
import { safeReturnTo } from '../../../../lib/navigation';

function readFailure(
  id: string,
  returnToValue: string | string[] | undefined,
  status: number,
  kind: 'plan' | 'options',
) {
  const returnTo = safeReturnTo(returnToValue);
  const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const detailUrl = validId ? `/changes/${encodeURIComponent(id)}` : null;
  const retry = new URLSearchParams();
  if (returnTo) retry.set('returnTo', returnTo);
  const retryUrl = detailUrl
    ? `${detailUrl}/edit${retry.size > 0 ? '?' + retry.toString() : ''}`
    : null;
  const message =
    kind === 'plan'
      ? '変更計画を取得できませんでした。時間をおいて、もう一度お試しください。'
      : status === 400
        ? '入力候補を取得できませんでした。変更計画や変更一覧から開き直してください。'
        : status === 401
          ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
          : status === 403
            ? '入力候補を取得できませんでした。操作中の組織と編集権限を確認してください。'
            : status === 404
              ? '入力候補を取得できませんでした。対象の現在の内容を変更計画で確認してください。'
              : '入力候補を取得できませんでした。時間をおいて、もう一度お試しください。';
  return (
    <main id="main" className="shell">
      <h1>
        {kind === 'plan' ? '変更計画を読み込めませんでした' : '入力候補を読み込めませんでした'}
      </h1>
      <p role="alert">{message}</p>
      <div className="form-actions">
        {retryUrl && <a href={retryUrl}>再取得する</a>}
        {returnTo ? (
          <a href={returnTo}>元の画面へ戻る</a>
        ) : (
          detailUrl && <a href={detailUrl}>変更計画へ戻る</a>
        )}
        <a href="/changes">変更一覧へ戻る</a>
        <a href="/portal">ポータルへ戻る</a>
      </div>
    </main>
  );
}

export default async function EditChangePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const user = await requireSession(),
    { id } = await params,
    p = await searchParams,
    d = await api.changeDetail(id);
  if (!d.ok) {
    if (d.problem.status < 500 || d.problem.status >= 600) notFound();
    return readFailure(id, p.returnTo, d.problem.status, 'plan');
  }
  if (!d.data.availableActions.includes('edit')) notFound();
  const options = await api.changeFormOptions(
    new URLSearchParams({
      ticketId: d.data.change.ticket.id,
      assetIds: d.data.change.assets.map((a) => a.id).join(','),
    }).toString(),
  );
  if (!options.ok) return readFailure(id, p.returnTo, options.problem.status, 'options');
  return (
    <main id="main" className="shell">
      <ContextLink back href={`/changes/${id}`}>
        変更計画へ戻る
      </ContextLink>
      <h1>{d.data.change.number} · 計画を見直す</h1>
      <p>保存後は下書きに戻ります。対象の現在の版を確認し、別担当者へ再申請してください。</p>
      <ChangePlanForm
        current={d.data.change}
        options={options.data}
        userId={user.userId}
        creationKey={randomUUID()}
        commandKey={randomUUID()}
      />
    </main>
  );
}
