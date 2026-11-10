import { ContextLink } from '../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { AssetForm } from '../../../../components/AssetForm';
import { safeReturnTo } from '../../../../lib/navigation';
export default async function EditAssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const { id } = await params;
  const [r, o] = await Promise.all([api.asset(id), api.assetFormOptions()]);
  if ((!r.ok && (r.problem.status < 500 || r.problem.status > 599)) || (r.ok && !r.data.canManage))
    notFound();
  if (!o.ok && o.problem.status === 403) notFound();
  if (!r.ok) {
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const assetPath = `/assets/${encodeURIComponent(id)}`;
    const retryHref = `${assetPath}/edit${retryQuery.size ? '?' + retryQuery.toString() : ''}`;
    return (
      <main id="main" className="shell">
        <h1>編集画面を表示できません</h1>
        <p role="alert">
          一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。
        </p>
        <p>
          <a href={retryHref}>再取得する</a>
        </p>
        <p>
          <a href={returnTo ?? assetPath}>{returnTo ? '元の画面へ戻る' : '資産の詳細へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  if (!o.ok) {
    if (o.problem.status === 403) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const assetPath = `/assets/${encodeURIComponent(id)}`;
    const retryHref = `${assetPath}/edit${retryQuery.size ? '?' + retryQuery.toString() : ''}`;
    const message =
      o.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : o.problem.status === 400
          ? '画面を開くための情報が正しくありません。元の画面から開き直してください。'
          : o.problem.status === 404
            ? '登録・編集に必要な候補を取得できませんでした。元の画面から開き直してください。'
            : '一時的に入力候補を取得できませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>編集画面を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <p>
          <a href={retryHref}>再取得する</a>
        </p>
        <p>
          <a href={returnTo ?? assetPath}>{returnTo ? '元の画面へ戻る' : '資産の詳細へ戻る'}</a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href={`/assets/${id}`}>
        資産の詳細へ戻る
      </ContextLink>
      <h1>資産を編集する</h1>
      <p>保存時に版が競合したら最新の内容を確認してください。入力は保持されます。</p>
      <AssetForm asset={r.data.asset} options={o.data} />
    </main>
  );
}
