import { ContextLink } from '../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { AssetCsvForm } from '../../../../components/AssetCsvForms';
import { safeReturnTo } from '../../../../lib/navigation';
export default async function NewAssetImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const access = await api.assetFormOptions();
  if (!access.ok) {
    if (access.problem.status === 403) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const retryHref = `/assets/imports/new${retryQuery.size ? '?' + retryQuery.toString() : ''}`;
    const message =
      access.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : access.problem.status === 400
          ? '画面を開くための情報が正しくありません。元の画面から開き直してください。'
          : access.problem.status === 404
            ? '取込に必要な情報を取得できませんでした。元の画面から開き直してください。'
            : '一時的に取込画面を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>CSV取込画面を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        <p>
          <a href={retryHref}>再取得する</a>
        </p>
        <p>
          <a href={returnTo ?? '/assets/imports'}>
            {returnTo ? '元の画面へ戻る' : '取込履歴へ戻る'}
          </a>
        </p>
        <p>
          <a href="/portal">ポータルへ戻る</a>
        </p>
      </main>
    );
  }
  return (
    <main id="main" className="shell">
      <ContextLink back href="/assets/imports">
        取込履歴へ戻る
      </ContextLink>
      <h1>資産CSVを取り込む</h1>
      <p>
        合成データで試すローカル取込です。列を選び、差分を確認してから確定します。CSVにない資産の削除・廃止は行いません。
      </p>
      <AssetCsvForm />
    </main>
  );
}
