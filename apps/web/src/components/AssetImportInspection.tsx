'use client';
import { useState } from 'react';
import type { AssetImportDetail } from '../lib/api';
import { ContextLink } from './ContextLink';
import { TableRegion } from './TableRegion';
import styles from './AssetImportInspection.module.css';

export type AssetImportInspectionRow = Pick<
  AssetImportDetail['plan']['rows'][number],
  | 'row'
  | 'externalId'
  | 'assetTag'
  | 'operation'
  | 'assetId'
  | 'expectedVersion'
  | 'match'
  | 'issues'
  | 'changes'
>;
export type ImportOperationFilter = 'all' | AssetImportInspectionRow['operation'];
const operationLabel = { add: '追加', update: '更新', unchanged: '変更なし', error: '不正・隔離' };
const filters: Array<{ value: ImportOperationFilter; label: string }> = [
  { value: 'all', label: '全件' },
  { value: 'add', label: '追加' },
  { value: 'update', label: '更新' },
  { value: 'unchanged', label: '変更なし' },
  { value: 'error', label: '不正' },
];

export function visibleImportRows(
  rows: readonly AssetImportInspectionRow[],
  operation: ImportOperationFilter,
  search: string,
) {
  const query = search.toLowerCase();
  return rows.filter(
    (row) =>
      (operation === 'all' || row.operation === operation) &&
      (row.externalId.toLowerCase().includes(query) || row.assetTag.toLowerCase().includes(query)),
  );
}
function valueLabel(value: string | null) {
  return value === null ? '（なし）' : value === '' ? '（空欄）' : value;
}

export function AssetImportInspection({
  rows,
  normalCount,
}: {
  rows: readonly AssetImportInspectionRow[];
  normalCount: number;
}) {
  const [operation, setOperation] = useState<ImportOperationFilter>('all');
  const [search, setSearch] = useState('');
  const displayed = visibleImportRows(rows, operation, search);
  const clear = () => {
    setOperation('all');
    setSearch('');
  };
  return (
    <section className={styles.inspection} aria-labelledby="import-inspection-title">
      <h2 id="import-inspection-title">行ごとの確認</h2>
      <p className="hint">
        表示の絞り込みは行の確認用です。確定時の対象は正常{normalCount}行すべてです。
      </p>
      <div role="group" aria-label="判定で表示を絞り込む" className={styles.filters}>
        {filters.map((filter) => (
          <button
            type="button"
            key={filter.value}
            aria-pressed={operation === filter.value}
            className={operation === filter.value ? '' : 'secondary'}
            onClick={() => setOperation(filter.value)}
          >
            {filter.label}（
            {filter.value === 'all'
              ? rows.length
              : rows.filter((row) => row.operation === filter.value).length}
            ）
          </button>
        ))}
      </div>
      <div className={styles.search}>
        <div className={styles.searchField}>
          <label htmlFor="import-row-search">外部ID・資産タグで探す</label>
          <input
            id="import-row-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
            aria-describedby="import-search-hint"
          />
          <p id="import-search-hint" className="hint">
            入力した文字を含む外部ID・資産タグを表示します。
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={clear}
          disabled={operation === 'all' && search === ''}
        >
          表示条件を解除する
        </button>
      </div>
      <p role="status" aria-live="polite">
        表示{displayed.length}行 / 全{rows.length}行
      </p>
      <p className="hint">表が画面に収まらない場合は、表の中を左右にスクロールできます。</p>
      <TableRegion label="CSVの行ごとの変更と隔離理由">
        <table className={`tickets ${styles.table}`}>
          <caption>行ごとの変更・隔離理由</caption>
          <colgroup>
            <col className={styles.rowColumn} />
            <col className={styles.identityColumn} />
            <col className={styles.operationColumn} />
            <col className={styles.changeColumn} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">行</th>
              <th scope="col">外部ID / 資産タグ</th>
              <th scope="col">判定</th>
              <th scope="col">差分・確認事項</th>
            </tr>
          </thead>
          <tbody>
            {!displayed.length && (
              <tr>
                <td colSpan={4}>
                  {rows.length
                    ? '条件に一致する行がありません。判定や識別情報を変更するか、表示条件を解除してください。'
                    : '表示する行がありません。取込履歴から確認するプレビューを選んでください。'}
                </td>
              </tr>
            )}
            {displayed.map((row) => (
              <tr key={row.row}>
                <td>{row.row}</td>
                <td>
                  {row.externalId}
                  <br />
                  {row.assetId ? (
                    <ContextLink href={`/assets/${row.assetId}`}>{row.assetTag}</ContextLink>
                  ) : (
                    row.assetTag
                  )}
                </td>
                <td>{operationLabel[row.operation]}</td>
                <td>
                  {row.issues.map((issue, i) => (
                    <p key={i}>{issue}</p>
                  ))}
                  {row.operation !== 'error' && (
                    <>
                      <p>
                        {row.match === 'asset_tag'
                          ? '初回の資産タグ一致: この資産へ外部IDを対応付けます。'
                          : row.match === 'external_id'
                            ? '登録済みの外部IDで一致'
                            : '新しい資産を登録'}
                        {row.expectedVersion ? `（確認時の版${row.expectedVersion}）` : ''}
                      </p>
                      {row.changes.length ? (
                        <details open={row.operation === 'update'}>
                          <summary>{row.changes.length}項目の内容を確認する</summary>
                          {row.changes.map((change) => (
                            <div className={styles.change} key={change.field}>
                              <p className={styles.changeLabel}>{change.label}</p>
                              <dl className={styles.values}>
                                <div>
                                  <dt>変更前</dt>
                                  <dd>{valueLabel(change.before)}</dd>
                                </div>
                                <div>
                                  <dt>変更後</dt>
                                  <dd>{valueLabel(change.after)}</dd>
                                </div>
                              </dl>
                            </div>
                          ))}
                        </details>
                      ) : (
                        <p>資産の内容・版を変更しません。</p>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </section>
  );
}
