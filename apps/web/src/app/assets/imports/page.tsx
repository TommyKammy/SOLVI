import { ContextLink } from '../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../lib/api';
import { formatDateTime } from '../../../lib/labels';
import { safeReturnTo } from '../../../lib/navigation';
export default async function AssetImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const r = await api.assetImports();
  if (!r.ok) {
    if (r.problem.status === 403) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const retryHref = `/assets/imports${retryQuery.size ? '?' + retryQuery.toString() : ''}`;
    const message =
      r.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : r.problem.status === 400
          ? '画面を開くための情報が正しくありません。元の画面から開き直してください。'
          : r.problem.status === 404
            ? '取込履歴を取得できませんでした。元の画面から開き直してください。'
            : '一時的に取込履歴を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>取込履歴を読み込めませんでした</h1>
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
      <h1>CSV取込と履歴</h1>
      <p>最新50件のプレビューと確定結果です。CSVにない資産を変更しません。</p>
      {r.data.canManage && (
        <p>
          <ContextLink href="/assets/imports/new">資産CSVを取り込む</ContextLink>
        </p>
      )}
      {r.data.items.length ? (
        <ul className="attachments">
          {r.data.items.map((p) => (
            <li key={p.id} className="attachment">
              <ContextLink href={`/assets/imports/${p.id}`}>
                {p.sourceKey} · {formatDateTime(p.createdAt)}
              </ContextLink>
              <p>
                {p.appliedAt ? '確定済み' : '未確定'} · 追加{p.counts.add} / 更新{p.counts.update} /
                変更なし{p.counts.unchanged} / 不正{p.counts.error}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>取込プレビューはまだありません。</p>
      )}
    </main>
  );
}
