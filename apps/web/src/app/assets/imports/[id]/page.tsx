import { ContextLink } from '../../../../components/ContextLink';
import { notFound } from 'next/navigation';
import { api, requireSession } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/labels';
import { ApplyAssetCsvForm } from '../../../../components/AssetCsvForms';
import {
  AssetImportInspection,
  type AssetImportInspectionRow,
} from '../../../../components/AssetImportInspection';
import { safeReturnTo } from '../../../../lib/navigation';
export default async function AssetImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const { id } = await params,
    r = await api.assetImportDetail(id);
  if (!r.ok) {
    if ([403, 404].includes(r.problem.status)) notFound();
    const query = await searchParams;
    const returnTo = safeReturnTo(query.returnTo);
    const retryQuery = new URLSearchParams();
    if (returnTo) retryQuery.set('returnTo', returnTo);
    const validId =
      typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const retryHref = validId
      ? `/assets/imports/${encodeURIComponent(id)}${retryQuery.size ? '?' + retryQuery.toString() : ''}`
      : '';
    const message =
      r.problem.status === 401
        ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
        : r.problem.status === 400
          ? '取込内容を指定する情報が正しくありません。取込履歴から選び直してください。'
          : '一時的に取込内容を読み込めませんでした。時間をおいて、もう一度お試しください。';
    return (
      <main id="main" className="shell">
        <h1>取込内容を読み込めませんでした</h1>
        <p role="alert">{message}</p>
        {validId && (
          <p>
            <a href={retryHref}>再取得する</a>
          </p>
        )}
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
  const d = r.data,
    counts = d.plan.counts,
    valid = counts.add + counts.update + counts.unchanged;
  const savedAssets = new Map(d.receipt?.result.assets.map((asset) => [asset.row, asset]));
  const firstSavedRow = d.plan.rows.find((row) => savedAssets.has(row.row));
  const firstSavedAsset = firstSavedRow && savedAssets.get(firstSavedRow.row);
  return (
    <main id="main" className="shell asset-change-workflow">
      <header className="support-page-heading">
        <div>
          <ContextLink back href="/assets/imports" className="support-back">
            取込履歴へ戻る
          </ContextLink>
          <h1>{d.receipt ? 'CSV取込の確定結果' : 'CSV取込プレビュー'}</h1>
          <p className="lead">
            {d.sourceKey} · {formatDateTime(d.createdAt)} · {d.creatorName}
          </p>
        </div>
        {!!counts.error && (
          <ContextLink href={`/assets/imports/${id}/errors`} className="support-action">
            不正行のレポートを保存する（JSON）
          </ContextLink>
        )}
      </header>
      <p>
        <strong>取込理由</strong> {d.plan.reason}
      </p>
      <dl className="asset-import-counts" aria-label="取込行の内訳">
        {(
          [
            ['追加', counts.add],
            ['更新', counts.update],
            ['変更なし', counts.unchanged],
            ['不正（取込対象外）', counts.error],
          ] as const
        ).map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count}件</dd>
          </div>
        ))}
      </dl>
      {d.receipt ? (
        <section
          className="asset-change-panel asset-change-receipt"
          aria-labelledby="import-receipt-heading"
        >
          <h2 id="import-receipt-heading">正常行の取込を確定しました</h2>
          <p>
            確定済み · {formatDateTime(d.receipt.appliedAt)} · {d.receipt.actorName}
          </p>
          <p>
            保存: 追加{d.receipt.result.added} / 更新{d.receipt.result.updated} / 変更なし
            {d.receipt.result.unchanged} / 隔離{d.receipt.result.skipped}
          </p>
          <div className="form-actions">
            {savedAssets.size === 1 && firstSavedRow && firstSavedAsset && (
              <ContextLink
                href={`/assets/${firstSavedAsset.id}`}
                className="support-action support-action--primary"
              >
                {firstSavedRow.assetTag}を開く
              </ContextLink>
            )}
            <a href="/assets">保存した資産を見る</a>
          </div>
        </section>
      ) : (
        <p className="hint">
          まだ資産を変更していません。不正行は確定対象から除外します。プレビュー後に対象が変わった場合は全正常行の保存を取り消し、再確認を求めます。
        </p>
      )}
      <details className="asset-change-disclosure">
        <summary>確認した列の対応付けと識別情報</summary>
        <dl className="detail">
          {Object.entries(d.plan.mapping).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v || '対応なし'}</dd>
            </div>
          ))}
        </dl>
        <p className="hint">CSV SHA-256: {d.contentHash}</p>
        <p className="hint">プレビューID: {d.id}</p>
      </details>
      <AssetImportInspection
        key={d.receipt ? 'applied' : 'preview'}
        normalCount={valid}
        rows={d.plan.rows.map((row) => {
          const saved = savedAssets.get(row.row);
          const view: AssetImportInspectionRow = {
            row: row.row,
            externalId: row.externalId,
            assetTag: row.assetTag,
            operation: row.operation,
            assetId: saved?.id ?? row.assetId,
            expectedVersion: row.expectedVersion,
            match: row.match,
            issues: row.issues,
            changes: row.changes.map((change) => ({
              field: change.field,
              label: change.label,
              before: change.before,
              after: change.after,
            })),
          };
          return view;
        })}
      />
      {!d.receipt && d.canManage && valid > 0 && (
        <section className="asset-change-panel" aria-labelledby="import-confirm-heading">
          <h2 id="import-confirm-heading">取込の確定</h2>
          <ApplyAssetCsvForm id={id} planHash={d.planHash} count={valid} />
        </section>
      )}
      {!d.receipt && !valid && (
        <p role="alert">正常行がありません。CSVを修正し再プレビューしてください。</p>
      )}
      <p>
        <ContextLink href="/assets/imports/new">別のCSVをプレビューする</ContextLink>
      </p>
    </main>
  );
}
