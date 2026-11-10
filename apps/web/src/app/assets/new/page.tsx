import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { AssetForm } from '../../../components/AssetForm';
import { safeReturnTo } from '../../../lib/navigation';
export default async function NewAssetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const r = await api.assetFormOptions();
  if (!r.ok) {
    if (r.problem.status === 403) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const retryHref = `/assets/new${retryQuery.size ? '?' + retryQuery.toString() : ''}`;
    const message =
      r.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : r.problem.status === 400
          ? '画面を開くための情報が正しくありません。元の画面から開き直してください。'
          : r.problem.status === 404
            ? '登録・編集に必要な候補を取得できませんでした。元の画面から開き直してください。'
            : '一時的に入力候補を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>登録画面を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <p>
          <a href={retryHref}>再取得する</a>
        </p>
        <p>
          <a href={returnTo ?? '/assets'}>{returnTo ? '元の画面へ戻る' : '資産台帳へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href="/assets">
        資産台帳へ戻る
      </ContextLink>
      <h1>新しい資産を登録する</h1>
      <AssetForm options={r.data} />
    </main>
  );
}
