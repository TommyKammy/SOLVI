import { ContextLink } from '../../../components/ContextLink';
import { TableRegion } from '../../../components/TableRegion';
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
    <main id="main" className="shell service-workspace asset-change-workflow">
      <h1 className="work-page-title">CSV取込と履歴</h1>
      <div className="work-page-tools">
        <ContextLink back href="/assets" className="support-back">
          資産台帳へ戻る
        </ContextLink>
        {r.data.canManage && (
          <ContextLink
            href="/assets/imports/new"
            className="support-action support-action--primary"
          >
            資産CSVを取り込む
          </ContextLink>
        )}
      </div>
      {r.data.items.length ? (
        <TableRegion label="資産CSV取込履歴" className="table-scroll service-table-scroll">
          <table className="work-table service-data-table">
            <caption className="visually-hidden">資産CSV取込履歴（最新50件）</caption>
            <thead>
              <tr>
                <th scope="col">取込元・プレビュー日時（JST）</th>
                <th scope="col">状態と取込件数</th>
                <th scope="col">確定日時（JST）</th>
              </tr>
            </thead>
            <tbody>
              {r.data.items.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    <ContextLink href={`/assets/imports/${p.id}`}>
                      {p.sourceKey} · {formatDateTime(p.createdAt)}
                    </ContextLink>
                  </th>
                  <td>
                    {p.appliedAt ? '確定済み' : '未確定'} · 追加{p.counts.add} / 更新
                    {p.counts.update} / 変更なし{p.counts.unchanged} / 不正{p.counts.error}
                  </td>
                  <td>{p.appliedAt ? formatDateTime(p.appliedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      ) : (
        <p className="service-empty">取込プレビューはまだありません。</p>
      )}
    </main>
  );
}
