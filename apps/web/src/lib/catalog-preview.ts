import {
  catalogDefinitionSchema,
  validateCatalogFieldValues,
  type CatalogField,
  type CatalogSection,
  type CatalogValues,
} from '@solvi/shared/catalog';
import { catalogInputValues, visibleCatalogValues } from './catalog-form';

/** Local authoring feedback only. Saving and real requests still use server validation. */
export type CatalogPreviewConfig = {
  title: string;
  description: string;
  target: string;
  days: string;
  maxReason: number;
  approver: string;
  fields: CatalogField[];
  category?: string;
  sections?: CatalogSection[];
  approvers: Array<{ id: string; name: string }>;
};

export type CatalogPreviewIssue = { field: string; message: string };
export type CatalogPreviewInput = {
  reason: string;
  durationDays: number;
  values: CatalogValues;
};

/** Keep sample controls and validation aligned after editing the question definition. */
export function normalizeCatalogPreviewValues(
  previousFields: ReadonlyArray<Pick<CatalogField, 'key' | 'type'>>,
  fields: CatalogField[],
  values: CatalogValues,
): CatalogValues {
  const previousTypes = new Map(previousFields.map((field) => [field.key, field.type]));
  const normalized: CatalogValues = Object.fromEntries(
    fields.map((field) => {
      const value = values[field.key];
      const empty = field.type === 'checkbox' ? false : field.type === 'multiselect' ? [] : '';
      if (previousTypes.get(field.key) !== field.type) return [field.key, empty];
      if (field.type === 'checkbox') return [field.key, typeof value === 'boolean' ? value : false];
      if (field.type === 'multiselect')
        return [
          field.key,
          Array.isArray(value)
            ? field.options
                .map((option) => option.trim())
                .filter((option) => value.includes(option))
            : [],
        ];
      if (field.type === 'number')
        return [field.key, typeof value === 'string' || typeof value === 'number' ? value : ''];
      if (typeof value !== 'string') return [field.key, ''];
      if (field.type === 'select')
        return [
          field.key,
          field.options.some((option) => option.trim() === value.trim()) ? value.trim() : '',
        ];
      return [field.key, value];
    }),
  );
  return visibleCatalogValues(fields, normalized);
}

function draftDefinition(config: CatalogPreviewConfig) {
  return catalogDefinitionSchema.safeParse({
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: config.target,
    allowedDurations: config.days
      .split(',')
      .map((value) => (value.trim() ? Number(value.trim()) : Number.NaN)),
    maxReasonLength: config.maxReason,
    approval: { mode: 'fixed', approverId: config.approver },
    fields: config.fields,
    ...(config.category?.trim() ? { category: config.category } : {}),
    ...(config.sections !== undefined ? { sections: config.sections } : {}),
  });
}

export function validateCatalogPreviewConfig(config: CatalogPreviewConfig): {
  durations: number[];
  errors: CatalogPreviewIssue[];
} {
  const errors: CatalogPreviewIssue[] = [];
  if (!config.title.trim() || config.title.trim().length > 200)
    errors.push({ field: 'title', message: 'サービス名を1〜200文字で入力してください。' });
  if (!config.description.trim() || config.description.trim().length > 2000)
    errors.push({
      field: 'description',
      message: '利用者への説明を1〜2000文字で入力してください。',
    });
  const definition = draftDefinition(config);
  if (!definition.success)
    for (const issue of definition.error.issues) {
      const path = issue.path.join('.').replace(/(\.options)\.\d+$/, '$1');
      const field = path.startsWith('allowedDurations')
        ? 'days'
        : path === 'targetLabel'
          ? 'target'
          : path === 'maxReasonLength'
            ? 'maxReason'
            : path.startsWith('approval.')
              ? 'approver'
              : path || 'fields';
      if (!errors.some((error) => error.field === field))
        errors.push({ field, message: issue.message });
    }
  if (
    !config.approvers.some((person) => person.id === config.approver) &&
    !errors.some((error) => error.field === 'approver')
  )
    errors.push({ field: 'approver', message: '現在の候補から固定の承認者を選んでください。' });
  return {
    durations: errors.some((issue) => issue.field === 'days')
      ? []
      : config.days.split(',').map(Number),
    errors,
  };
}

export function validateCatalogPreviewInput(
  config: CatalogPreviewConfig,
  input: CatalogPreviewInput,
): CatalogPreviewIssue[] {
  const definition = validateCatalogPreviewConfig(config);
  if (definition.errors.length) return definition.errors;
  const errors: CatalogPreviewIssue[] = [];
  const reason = input.reason.trim();
  if (!reason) errors.push({ field: 'reason', message: '利用する理由を入力してください。' });
  else if (reason.length > config.maxReason)
    errors.push({
      field: 'reason',
      message: `利用する理由は${config.maxReason}文字以内にしてください。`,
    });
  if (!definition.durations.includes(input.durationDays))
    errors.push({ field: 'durationDays', message: '設定された利用日数から選んでください。' });
  const parsed = draftDefinition(config);
  if (parsed.success)
    errors.push(
      ...validateCatalogFieldValues(parsed.data, catalogInputValues(config.fields, input.values))
        .errors,
    );
  return errors.filter(
    (issue, index) => errors.findIndex((other) => other.field === issue.field) === index,
  );
}
