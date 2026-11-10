import type { CatalogField } from '../lib/api';
export function CatalogValueSummary({
  fields,
  values,
}: {
  fields: CatalogField[];
  values: Record<string, string | boolean>;
}) {
  if (!fields.length) return null;
  return (
    <dl>
      {fields.map((f) => (
        <div key={f.key}>
          <dt>{f.label}</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>
            {f.type === 'checkbox'
              ? values[f.key] === true
                ? '確認済み'
                : '未確認'
              : String(values[f.key] ?? '未入力')}
          </dd>
        </div>
      ))}
    </dl>
  );
}
