import {
  getVisibleCatalogFields,
  isCatalogDate,
  type CatalogField,
  type CatalogValues,
} from '@solvi/shared/catalog';
import type { DraftValues } from './form-draft';

function numberInput(value: string): number | string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) && Number.isFinite(Number(raw))
    ? Number(raw)
    : value;
}

/** Browser number controls keep strings while typing; an empty value is never zero. */
export function catalogInputValues(fields: CatalogField[], values: CatalogValues): CatalogValues {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const field = fields.find((candidate) => candidate.key === key);
      if (field?.type !== 'number' || typeof value !== 'string') return [[key, value]];
      const number = numberInput(value);
      return number === undefined ? [] : [[key, number]];
    }),
  );
}

/** Clear hidden answers as soon as their controller changes, including descendant conditions. */
export function visibleCatalogValues(fields: CatalogField[], values: CatalogValues): CatalogValues {
  const keys = new Set(getVisibleCatalogFields(fields, values).map((field) => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)));
}

/** Read repeated choice values and explicit empty groups without trusting HTML coercion. */
export function readCatalogFormValues(form: FormData): CatalogValues {
  const entries = [...form.entries()];
  const values = new Map<string, CatalogValues[string]>(
    entries
      .filter(([name]) => name.startsWith('value:'))
      .map(([name, value]) => [name.slice(6), String(value)]),
  );
  for (const [name] of entries) {
    if (name.startsWith('checkbox:'))
      values.set(name.slice(9), form.get('value:' + name.slice(9)) === 'true');
    else if (name.startsWith('multiselect:'))
      values.set(name.slice(12), form.getAll('value:' + name.slice(12)).map(String));
    else if (name.startsWith('number:')) {
      const key = name.slice(7);
      const number = numberInput(String(form.get('value:' + key) ?? ''));
      if (number === undefined) values.delete(key);
      else values.set(key, number);
    }
  }
  return Object.fromEntries(values);
}

/** Draft storage is string-only; checkbox consent is deliberately never persisted. */
export function catalogDraftValues(fields: CatalogField[], values: CatalogValues): DraftValues {
  return Object.fromEntries(
    fields
      .filter((field) => field.type !== 'checkbox')
      .map((field) => {
        const value = values[field.key];
        return [
          'value:' + field.key,
          field.type === 'multiselect'
            ? JSON.stringify(Array.isArray(value) ? value : [])
            : String(value ?? ''),
        ];
      }),
  );
}

export function restoreCatalogDraftValues(
  fields: CatalogField[],
  draft: DraftValues,
): CatalogValues {
  const values: CatalogValues = Object.fromEntries(
    fields.map((field) => {
      const raw = draft['value:' + field.key] ?? '';
      if (field.type === 'checkbox') return [field.key, false];
      if (field.type === 'multiselect') {
        let selected: unknown;
        try {
          selected = JSON.parse(raw);
        } catch {
          selected = [];
        }
        return [
          field.key,
          Array.isArray(selected)
            ? field.options.filter((option) => selected.includes(option))
            : [],
        ];
      }
      if (field.type === 'select') return [field.key, field.options.includes(raw) ? raw : ''];
      if (field.type === 'number')
        return [field.key, typeof numberInput(raw) === 'number' ? raw : ''];
      if (field.type === 'date') return [field.key, isCatalogDate(raw) ? raw : ''];
      return [field.key, raw.slice(0, field.maxLength)];
    }),
  );
  return visibleCatalogValues(fields, values);
}
