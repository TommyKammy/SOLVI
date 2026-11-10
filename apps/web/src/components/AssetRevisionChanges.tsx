import type { AssetDetail } from '../lib/api';
import { assetFieldChanges } from '../lib/asset-history';

type Revision = AssetDetail['revisions'][number];

export function AssetRevisionChanges({
  revision,
  previous,
}: {
  revision: Revision;
  previous?: Revision;
}) {
  if (revision.version === 1)
    return (
      <p className="hint">初回登録です。登録時の全項目は「この版の内容を見る」で確認できます。</p>
    );
  if (!previous || previous.version !== revision.version - 1)
    return <p className="hint">直前の版を取得できないため、変更前後を比較できません。</p>;
  const changes = assetFieldChanges(previous.snapshot, revision.snapshot);
  if (!changes.length)
    return (
      <p className="hint">項目の変更はありません。記録理由とこの版の内容を確認してください。</p>
    );
  return (
    <div className="table-scroll">
      <table className="tickets">
        <caption>
          版{previous.version} → 版{revision.version}：変更した{changes.length}項目
        </caption>
        <thead>
          <tr>
            <th scope="col">項目</th>
            <th scope="col">変更前</th>
            <th scope="col">変更後</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.label}>
              <th scope="row">{change.label}</th>
              <td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{change.before}</td>
              <td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{change.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
