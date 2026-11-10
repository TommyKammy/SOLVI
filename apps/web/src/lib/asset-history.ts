import type { AssetView } from './api';
import { assetKindLabel, assetStateLabel } from './asset-labels';

export interface AssetFieldChange {
  label: string;
  before: string;
  after: string;
}

const fields: Array<{ key: keyof AssetView; label: string }> = [
  { key: 'assetTag', label: '資産タグ' },
  { key: 'name', label: '資産名' },
  { key: 'kind', label: '種別' },
  { key: 'state', label: '状態' },
  { key: 'assignedUserId', label: '利用者' },
  { key: 'model', label: 'モデル・サービス名' },
  { key: 'serialNumber', label: 'シリアル番号' },
  { key: 'hostname', label: 'ホスト名' },
  { key: 'vendor', label: 'メーカー・提供元' },
  { key: 'location', label: '保管場所' },
  { key: 'internalNotes', label: '内部メモ' },
];

function display(snapshot: AssetView, key: keyof AssetView): string {
  const value = snapshot[key];
  if (value === undefined) return '未記録';
  if (key === 'assignedUserId')
    return value === null ? '割当なし' : (snapshot.assignedUserName ?? '氏名未記録');
  if (key === 'state') return assetStateLabel(String(value));
  if (key === 'kind') return assetKindLabel(String(value));
  return value === null || value === '' ? '未入力' : String(value);
}

/** Compare only the authorized snapshots supplied by the detail API. */
export function assetFieldChanges(before: AssetView, after: AssetView): AssetFieldChange[] {
  return fields
    .filter(({ key }) => before[key] !== after[key])
    .map(({ key, label }) => ({
      label,
      before: display(before, key),
      after: display(after, key),
    }));
}
