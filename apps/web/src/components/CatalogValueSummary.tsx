import {
  getVisibleCatalogFields,
  groupCatalogFields,
  type CatalogField,
  type CatalogSection,
  type CatalogValues,
} from '@solvi/shared/catalog';

export function CatalogValueSummary({
  fields,
  values,
  sections,
}: {
  fields: CatalogField[];
  values: CatalogValues;
  sections?: CatalogSection[];
}) {
  const groups = groupCatalogFields(getVisibleCatalogFields(fields, values), sections);
  if (!groups.some((group) => group.fields.length)) return null;
  return (
    <>
      {groups.map((group, index) => (
        <section key={group.section?.key ?? `unassigned-${index}`}>
          {group.section && (
            <>
              <h3>{group.section.title}</h3>
              {group.section.description && <p>{group.section.description}</p>}
            </>
          )}
          <dl>
            {group.fields.map((field) => {
              const value = values[field.key];
              return (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>
                    {field.type === 'checkbox' ? (
                      value === true ? (
                        '確認済み'
                      ) : (
                        '未確認'
                      )
                    ) : Array.isArray(value) ? (
                      value.length ? (
                        <ul>
                          {value.map((option) => (
                            <li key={option}>{option}</li>
                          ))}
                        </ul>
                      ) : (
                        '未入力'
                      )
                    ) : value === undefined || value === '' ? (
                      '未入力'
                    ) : (
                      String(value)
                    )}
                  </dd>
                  {field.helpText && <dd className="hint">{field.helpText}</dd>}
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </>
  );
}
