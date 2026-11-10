import {
  getVisibleCatalogFields,
  groupCatalogFields,
  type CatalogField,
  type CatalogSection,
  type CatalogValues,
} from '@solvi/shared/catalog';
import { visibleCatalogValues } from '../lib/catalog-form';
import { FormField } from './FeedbackForm';
import styles from './CatalogFieldInputs.module.css';

export function CatalogFieldInputs({
  fields,
  values,
  sections,
  onChange,
  disabled = false,
  idPrefix = 'catalog-field',
  fieldId,
  namedControls = true,
  errors = [],
}: {
  fields: CatalogField[];
  values: CatalogValues;
  sections?: CatalogSection[];
  onChange?: (values: CatalogValues) => void;
  disabled?: boolean;
  idPrefix?: string;
  fieldId?: (field: CatalogField, index: number) => string;
  namedControls?: boolean;
  errors?: Array<{ field: string; message: string }>;
}) {
  const groups = groupCatalogFields(getVisibleCatalogFields(fields, values), sections);
  const renderField = (field: CatalogField) => {
    const index = fields.indexOf(field);
    const id = fieldId?.(field, index) ?? `${idPrefix}-${field.key}`;
    const name = namedControls ? 'value:' + field.key : undefined;
    const error = errors.find((issue) => issue.field === 'values.' + field.key)?.message;
    const describedBy =
      [field.helpText && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') ||
      undefined;
    const label = `${field.label.trim() || `項目${index + 1}`}（${field.required ? '必須' : '任意'}）`;
    const set = (value: CatalogValues[string]) =>
      onChange?.(visibleCatalogValues(fields, { ...values, [field.key]: value }));
    const common = {
      id,
      name,
      disabled,
      'aria-invalid': Boolean(error) || undefined,
      'aria-describedby': describedBy,
    };
    const selected = values[field.key];
    return (
      <FormField className={styles.field} name={name} key={field.key}>
        {field.type === 'checkbox' ? (
          <>
            {namedControls && <input type="hidden" name={'checkbox:' + field.key} value="1" />}
            <label className={styles.choice} htmlFor={id}>
              <input
                {...common}
                type="checkbox"
                value="true"
                checked={selected === true}
                required={field.required}
                onChange={(event) => set(event.target.checked)}
              />
              {label}
            </label>
          </>
        ) : field.type === 'multiselect' ? (
          <fieldset className={styles.choiceGroup} aria-describedby={describedBy}>
            <legend>{label}</legend>
            {namedControls && <input type="hidden" name={'multiselect:' + field.key} value="1" />}
            {field.options.map((rawOption, optionIndex) => {
              const option = rawOption.trim();
              return (
                <label className={styles.choice} htmlFor={`${id}-${optionIndex}`} key={optionIndex}>
                  <input
                    {...common}
                    id={`${id}-${optionIndex}`}
                    type="checkbox"
                    value={option}
                    checked={Array.isArray(selected) && selected.includes(option)}
                    onChange={(event) => {
                      const previous = Array.isArray(selected) ? selected : [];
                      set(
                        event.target.checked
                          ? [...new Set([...previous, option])]
                          : previous.filter((value) => value !== option),
                      );
                    }}
                  />
                  {option}
                </label>
              );
            })}
          </fieldset>
        ) : (
          <>
            <label htmlFor={id}>{label}</label>
            {field.type === 'select' ? (
              <select
                {...common}
                required={field.required}
                value={String(selected ?? '')}
                onChange={(event) => set(event.target.value)}
              >
                <option value="">選んでください</option>
                {field.options.map((option, optionIndex) => (
                  <option key={optionIndex} value={option.trim()}>
                    {option.trim() || '（空の候補）'}
                  </option>
                ))}
              </select>
            ) : field.type === 'textarea' ? (
              <textarea
                {...common}
                value={String(selected ?? '')}
                maxLength={field.maxLength > 0 ? field.maxLength : undefined}
                required={field.required}
                onChange={(event) => set(event.target.value)}
              />
            ) : field.type === 'number' ? (
              <>
                {namedControls && <input type="hidden" name={'number:' + field.key} value="1" />}
                <input
                  {...common}
                  type="number"
                  step="any"
                  min={field.min}
                  max={field.max}
                  value={String(selected ?? '')}
                  required={field.required}
                  onChange={(event) => set(event.target.value)}
                />
              </>
            ) : field.type === 'date' ? (
              <input
                {...common}
                type="date"
                min={field.minDate}
                max={field.maxDate}
                value={String(selected ?? '')}
                required={field.required}
                onChange={(event) => set(event.target.value)}
              />
            ) : (
              <input
                {...common}
                type="text"
                value={String(selected ?? '')}
                maxLength={field.maxLength > 0 ? field.maxLength : undefined}
                required={field.required}
                onChange={(event) => set(event.target.value)}
              />
            )}
          </>
        )}
        {field.helpText && (
          <p className={styles.description} id={`${id}-help`}>
            {field.helpText}
          </p>
        )}
        {error && (
          <p className={styles.error} id={`${id}-error`}>
            {error}
          </p>
        )}
      </FormField>
    );
  };
  return (
    <>
      {groups.map((group) =>
        group.section ? (
          <section
            className={styles.section}
            key={group.section.key}
            aria-labelledby={`${idPrefix}-section-${group.section.key}`}
          >
            <h3 id={`${idPrefix}-section-${group.section.key}`}>{group.section.title}</h3>
            {group.section.description && (
              <p className={styles.description}>{group.section.description}</p>
            )}
            {group.fields.map(renderField)}
          </section>
        ) : (
          group.fields.map(renderField)
        ),
      )}
    </>
  );
}
