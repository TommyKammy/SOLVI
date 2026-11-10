import type { CatalogField } from '../lib/api';
import { FormField } from './FeedbackForm';
export function CatalogFieldInputs({
  fields,
  values,
  onChange,
  disabled = false,
}: {
  fields: CatalogField[];
  values: Record<string, string | boolean>;
  onChange?: (v: Record<string, string | boolean>) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {fields.map((f) => {
        const id = 'catalog-field-' + f.key,
          set = (v: string | boolean) => onChange?.({ ...values, [f.key]: v });
        return (
          <FormField className="field" key={f.key}>
            {f.type === 'checkbox' ? (
              <>
                <input type="hidden" name={'checkbox:' + f.key} value="1" />
                <label htmlFor={id}>
                  <input
                    type="checkbox"
                    id={id}
                    name={'value:' + f.key}
                    value="true"
                    checked={values[f.key] === true}
                    required={f.required}
                    disabled={disabled}
                    onChange={(e) => set(e.target.checked)}
                  />{' '}
                  {f.label}
                  {f.required ? '（必須）' : '（任意）'}
                </label>
              </>
            ) : (
              <>
                <label htmlFor={id}>
                  {f.label}
                  {f.required ? '（必須）' : '（任意）'}
                </label>
                {f.type === 'select' ? (
                  <select
                    id={id}
                    name={'value:' + f.key}
                    required={f.required}
                    disabled={disabled}
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => set(e.target.value)}
                  >
                    <option value="">選んでください</option>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'textarea' ? (
                  <textarea
                    id={id}
                    name={'value:' + f.key}
                    value={String(values[f.key] ?? '')}
                    maxLength={f.maxLength}
                    required={f.required}
                    disabled={disabled}
                    onChange={(e) => set(e.target.value)}
                  />
                ) : (
                  <input
                    type="text"
                    id={id}
                    name={'value:' + f.key}
                    value={String(values[f.key] ?? '')}
                    maxLength={f.maxLength}
                    required={f.required}
                    disabled={disabled}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </>
            )}
          </FormField>
        );
      })}
    </>
  );
}
