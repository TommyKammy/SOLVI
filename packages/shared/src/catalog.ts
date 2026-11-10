import { z } from 'zod';

const keySchema = z
  .string({
    required_error: '保存キーを確認してください',
    invalid_type_error: '保存キーを確認してください',
  })
  .regex(
    /^[a-z][a-z0-9_]{0,31}$/,
    '保存キーは英小文字から始まる32文字以内の英小文字・数字・アンダースコアにしてください',
  )
  .refine(
    (key) => !['constructor', 'prototype', '__proto__'].includes(key),
    'この保存キーは使用できません',
  );

/** Calendar dates have no time zone; Date.parse must not normalize invalid days. */
export function isCatalogDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
const dateSchema = z
  .string({ invalid_type_error: '日付はYYYY-MM-DDで入力してください' })
  .refine(isCatalogDate, '実在する日付をYYYY-MM-DDで入力してください');
const numberBoundSchema = z
  .number({ invalid_type_error: '数値の上下限は有限の数値で入力してください' })
  .finite('数値の上下限は有限の数値で入力してください');
const textLimitSchema = (max: number) =>
  z
    .number({
      required_error: '文字数上限を入力してください',
      invalid_type_error: '文字数上限は整数で入力してください',
    })
    .int('文字数上限は整数で入力してください')
    .min(1, '文字数上限は1文字以上にしてください')
    .max(max, `文字数上限は${max}文字以内にしてください`);
const optionsSchema = z
  .array(
    z
      .string({ invalid_type_error: '選択肢は文字列で入力してください' })
      .trim()
      .min(1, '空の選択肢は使用できません')
      .max(100, '各選択肢は100文字以内で入力してください'),
    { invalid_type_error: '選択肢を2〜10候補で設定してください' },
  )
  .min(2, '選択肢は2候補以上にしてください')
  .max(10, '選択肢は10候補以内にしてください')
  .refine((options) => new Set(options).size === options.length, '選択肢は重複できません');
const common = {
  key: keySchema,
  label: z
    .string({
      required_error: '表示名を入力してください',
      invalid_type_error: '表示名は文字列で入力してください',
    })
    .trim()
    .min(1, '表示名を入力してください')
    .max(100, '表示名は100文字以内で入力してください'),
  required: z.boolean({ invalid_type_error: '必須設定を確認してください' }),
  helpText: z
    .string({ invalid_type_error: '補足説明は文字列で入力してください' })
    .trim()
    .max(500, '補足説明は500文字以内で入力してください')
    .optional(),
  section: keySchema.optional(),
  visibleWhen: z
    .union([
      z
        .object({
          field: keySchema,
          equals: z.union(
            [
              z
                .string()
                .trim()
                .min(1, '表示条件の回答を選んでください')
                .max(100, '表示条件の回答は100文字以内で選んでください'),
              z.boolean(),
            ],
            {
              errorMap: () => ({
                message: '表示条件の回答は選択肢またはチェック状態から選んでください',
              }),
            },
          ),
        })
        .strict(),
      z
        .object({
          field: keySchema,
          contains: z
            .string()
            .trim()
            .min(1, '表示条件の回答を選んでください')
            .max(100, '表示条件の回答は100文字以内で選んでください'),
        })
        .strict(),
    ])
    .optional(),
};
export const catalogFieldSchema = z
  .discriminatedUnion('type', [
    z.object({ ...common, type: z.literal('text'), maxLength: textLimitSchema(1000) }).strict(),
    z
      .object({
        ...common,
        type: z.literal('textarea'),
        maxLength: textLimitSchema(2000),
      })
      .strict(),
    z.object({ ...common, type: z.literal('select'), options: optionsSchema }).strict(),
    z.object({ ...common, type: z.literal('checkbox') }).strict(),
    z
      .object({
        ...common,
        type: z.literal('date'),
        minDate: dateSchema.optional(),
        maxDate: dateSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal('number'),
        min: numberBoundSchema.optional(),
        max: numberBoundSchema.optional(),
      })
      .strict(),
    z.object({ ...common, type: z.literal('multiselect'), options: optionsSchema }).strict(),
  ])
  .superRefine((field, context) => {
    if (field.type === 'date' && field.minDate && field.maxDate && field.minDate > field.maxDate)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDate'],
        message: '日付の上限は下限以降にしてください',
      });
    if (
      field.type === 'number' &&
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max'],
        message: '数値の上限は下限以上にしてください',
      });
  });
export const catalogSectionSchema = z
  .object({
    key: keySchema,
    title: z
      .string({
        required_error: 'セクション名を入力してください',
        invalid_type_error: 'セクション名は文字列で入力してください',
      })
      .trim()
      .min(1, 'セクション名を入力してください')
      .max(100, 'セクション名は100文字以内で入力してください'),
    description: z
      .string({ invalid_type_error: 'セクションの説明は文字列で入力してください' })
      .trim()
      .max(500, 'セクションの説明は500文字以内で入力してください')
      .optional(),
  })
  .strict();
export const catalogDefinitionSchema = z
  .object({
    mode: z.literal('local_simulation'),
    action: z.literal('simulate.access_grant'),
    targetLabel: z
      .string({ invalid_type_error: '模擬対象の表示名は文字列で入力してください' })
      .trim()
      .min(1, '模擬対象の表示名を入力してください')
      .max(100, '模擬対象の表示名は100文字以内で入力してください'),
    allowedDurations: z
      .array(
        z
          .number({ invalid_type_error: '利用日数は1〜365の整数で入力してください' })
          .int('利用日数は整数で入力してください')
          .min(1, '利用日数は1日以上にしてください')
          .max(365, '利用日数は365日以内にしてください'),
      )
      .min(1, '利用日数を1候補以上設定してください')
      .max(10, '利用日数は10候補以内にしてください')
      .refine((values) => new Set(values).size === values.length, '利用日数の候補は重複できません'),
    maxReasonLength: z
      .number({ invalid_type_error: '理由の文字数上限は整数で入力してください' })
      .int('理由の文字数上限は整数で入力してください')
      .min(1, '理由の文字数上限は1文字以上にしてください')
      .max(2000, '理由の文字数上限は2000文字以内にしてください'),
    requestFields: z
      .object({
        reason: z.boolean({ invalid_type_error: '理由の表示設定を確認してください' }).optional(),
        duration: z
          .boolean({ invalid_type_error: '利用日数の表示設定を確認してください' })
          .optional(),
      })
      .strict()
      .optional(),
    fields: z
      .array(catalogFieldSchema)
      .max(10, '追加の申請項目は10件以内にしてください')
      .optional(),
    approval: z
      .object({
        mode: z.literal('fixed'),
        approverId: z
          .string({ invalid_type_error: '固定の承認者を選んでください' })
          .uuid('固定の承認者を選んでください'),
      })
      .strict()
      .optional(),
    category: z
      .string({ invalid_type_error: '業務カテゴリは文字列で入力してください' })
      .trim()
      .min(1, '業務カテゴリを入力してください')
      .max(80, '業務カテゴリは80文字以内で入力してください')
      .optional(),
    sections: z
      .array(catalogSectionSchema)
      .max(10, 'セクションは10件以内にしてください')
      .optional(),
    ownerId: z.string().uuid('現在有効な同じ組織の責任者を選んでください').optional(),
    fulfillmentGroupId: z
      .string()
      .uuid('現在有効な同じ組織の処理グループを選んでください')
      .optional(),
    checklist: z
      .array(
        z
          .object({
            key: keySchema,
            label: z
              .string()
              .trim()
              .min(1, '作業名を入力してください')
              .max(200, '作業名は200文字以内にしてください'),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(20, '作業チェックリストは20件以内にしてください')
      .refine(
        (items) => new Set(items.map((item) => item.key)).size === items.length,
        '作業の保存キーは重複できません',
      )
      .optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const fields = definition.fields ?? [],
      sections = definition.sections ?? [],
      sectionKeys = new Set<string>();
    sections.forEach((section, index) => {
      if (sectionKeys.has(section.key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sections', index, 'key'],
          message: 'セクションのキーは重複できません',
        });
      sectionKeys.add(section.key);
    });
    const byKey = new Map(fields.map((field) => [field.key, field])),
      keys = new Set<string>();
    fields.forEach((field, index) => {
      const issue = (path: string, message: string) =>
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, path], message });
      if (keys.has(field.key)) issue('key', '質問の保存キーは重複できません');
      keys.add(field.key);
      if (field.section && !sectionKeys.has(field.section))
        issue('section', '定義にあるセクションを選んでください');
      if (!field.visibleWhen) return;
      const source = byKey.get(field.visibleWhen.field);
      if (!source || source === field)
        issue('visibleWhen', '別の質問を表示条件として選んでください');
      else {
        const condition = field.visibleWhen;
        const valid =
          'contains' in condition
            ? source.type === 'multiselect' && source.options.includes(condition.contains)
            : source.type === 'select'
              ? typeof condition.equals === 'string' && source.options.includes(condition.equals)
              : source.type === 'checkbox' && typeof condition.equals === 'boolean';
        if (!valid)
          issue('visibleWhen', '表示条件には選択項目の候補または確認チェックを指定してください');
      }
    });
    const visited = new Set<string>(),
      visiting = new Set<string>(),
      cycles = new Set<string>();
    const visit = (key: string): void => {
      if (visiting.has(key)) {
        cycles.add(key);
        return;
      }
      if (visited.has(key)) return;
      visiting.add(key);
      const source = byKey.get(key)?.visibleWhen?.field;
      if (source && byKey.has(source)) visit(source);
      visiting.delete(key);
      visited.add(key);
    };
    fields.forEach((field) => visit(field.key));
    fields.forEach((field, index) => {
      if (cycles.has(field.key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'visibleWhen'],
          message: '表示条件を循環させることはできません',
        });
    });
  });
export type CatalogField = z.infer<typeof catalogFieldSchema>;
export type CatalogSection = z.infer<typeof catalogSectionSchema>;
export type CatalogDefinition = z.infer<typeof catalogDefinitionSchema>;
export type CatalogValue = string | boolean | number | string[];
export type CatalogValues = Record<string, CatalogValue>;
export type CatalogValidationIssue = { field: string; message: string };

/** Missing flags preserve the legacy required fields without modifying stored definitions. */
export function catalogRequestFieldVisibility(
  definition: Pick<CatalogDefinition, 'requestFields'>,
): { reason: boolean; duration: boolean } {
  return {
    reason: definition.requestFields?.reason !== false,
    duration: definition.requestFields?.duration !== false,
  };
}
export type CatalogRequestInputs = { reason?: string; durationDays?: number };
export function validateCatalogRequestInputs(
  definition: Pick<CatalogDefinition, 'requestFields' | 'allowedDurations' | 'maxReasonLength'>,
  input: Readonly<Record<string, unknown>>,
): { inputs: CatalogRequestInputs; errors: CatalogValidationIssue[] } {
  const visibility = catalogRequestFieldVisibility(definition);
  const inputs: CatalogRequestInputs = {},
    errors: CatalogValidationIssue[] = [];
  if (visibility.reason) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) errors.push({ field: 'reason', message: '利用する理由を入力してください。' });
    else if (reason.length > definition.maxReasonLength)
      errors.push({
        field: 'reason',
        message: `利用する理由は${definition.maxReasonLength}文字以内で入力してください。`,
      });
    else inputs.reason = reason;
  }
  if (visibility.duration) {
    const duration = input.durationDays;
    if (
      typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      duration <= 0 ||
      !definition.allowedDurations.includes(duration)
    )
      errors.push({ field: 'durationDays', message: '設定された利用日数から選んでください。' });
    else inputs.durationDays = duration;
  }
  return { inputs, errors };
}

/** Evaluate a DAG independently of question order; malformed references fail closed. */
export function getVisibleCatalogFields(
  fields: readonly CatalogField[],
  values: Readonly<Record<string, unknown>> = {},
): CatalogField[] {
  const byKey = new Map(fields.map((field) => [field.key, field])),
    results = new Map<string, boolean>(),
    visiting = new Set<string>();
  const visible = (field: CatalogField): boolean => {
    const prior = results.get(field.key);
    if (prior !== undefined) return prior;
    if (visiting.has(field.key)) return false;
    visiting.add(field.key);
    let result = true;
    const condition = field.visibleWhen;
    if (condition) {
      const source = byKey.get(condition.field),
        value = source ? values[source.key] : undefined;
      result = Boolean(
        source &&
        source.key !== field.key &&
        visible(source) &&
        ('contains' in condition
          ? source.type === 'multiselect' &&
            typeof condition.contains === 'string' &&
            source.options.some((option) => option.trim() === condition.contains.trim()) &&
            Array.isArray(value) &&
            value.every(
              (entry) =>
                typeof entry === 'string' &&
                source.options.some((option) => option.trim() === entry.trim()),
            ) &&
            value.some(
              (entry) => typeof entry === 'string' && entry.trim() === condition.contains.trim(),
            )
          : source.type === 'select'
            ? typeof condition.equals === 'string' &&
              source.options.some(
                (option) => option.trim() === condition.equals.toString().trim(),
              ) &&
              typeof value === 'string' &&
              value.trim() === condition.equals.trim()
            : source.type === 'checkbox' &&
              typeof condition.equals === 'boolean' &&
              (value === undefined || typeof value === 'boolean') &&
              (value ?? false) === condition.equals),
      );
    }
    visiting.delete(field.key);
    results.set(field.key, result);
    return result;
  };
  return fields.filter(visible);
}

export function groupCatalogFields(
  fields: readonly CatalogField[],
  sections: readonly CatalogSection[] = [],
): Array<{ section?: CatalogSection; fields: CatalogField[] }> {
  const keys = new Set(sections.map((section) => section.key)),
    groups: Array<{ section?: CatalogSection; fields: CatalogField[] }> = [];
  const unassigned = fields.filter((field) => !field.section || !keys.has(field.section));
  if (unassigned.length) groups.push({ fields: unassigned });
  for (const section of sections) {
    const selected = fields.filter((field) => field.section === section.key);
    if (selected.length) groups.push({ section, fields: selected });
  }
  return groups;
}

/** Normalize only visible answers. Hidden stale values never enter a request snapshot. */
export function validateCatalogFieldValues(
  definition: { fields?: readonly CatalogField[]; sections?: readonly CatalogSection[] },
  submitted: Readonly<Record<string, unknown>> = {},
): { values: CatalogValues; errors: CatalogValidationIssue[] } {
  const fields = definition.fields ?? [],
    errors: CatalogValidationIssue[] = [],
    values: CatalogValues = {};
  for (const key of Object.keys(submitted))
    if (!fields.some((field) => field.key === key))
      errors.push({ field: `values.${key}`, message: '定義にない申請項目は送信できません' });
  for (const field of getVisibleCatalogFields(fields, submitted)) {
    const value = submitted[field.key],
      error = (message: string) => errors.push({ field: `values.${field.key}`, message });
    if (typeof value === 'string' && value.length > 2000) {
      error(`${field.label}は2000文字以内で入力してください`);
      continue;
    }
    if (field.type === 'checkbox') {
      if (value !== undefined && typeof value !== 'boolean')
        error(`${field.label}は確認チェックで入力してください`);
      if (field.required && value !== true) error(`${field.label}を確認してください`);
      if (typeof value === 'boolean') values[field.key] = value;
    } else if (field.type === 'number') {
      if (value === undefined || (typeof value === 'string' && !value.trim())) {
        if (field.required) error(`${field.label}を入力してください`);
      } else if (typeof value !== 'number' || !Number.isFinite(value))
        error(`${field.label}は有限の数値で入力してください`);
      else if (
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max)
      )
        error(`${field.label}が数値の範囲に合いません`);
      else values[field.key] = value;
    } else if (field.type === 'multiselect') {
      if (value === undefined) {
        if (field.required) error(`${field.label}を1つ以上選んでください`);
      } else if (
        !Array.isArray(value) ||
        value.length > 10 ||
        value.some((entry) => typeof entry !== 'string' || entry.length > 100)
      )
        error(`${field.label}は候補から複数選択してください`);
      else {
        const selected = value.map((entry: string) => entry.trim());
        if (
          new Set(selected).size !== selected.length ||
          selected.some((entry) => !field.options.includes(entry))
        )
          error(`${field.label}は重複なく候補から選んでください`);
        else if (!selected.length) {
          if (field.required) error(`${field.label}を1つ以上選んでください`);
        } else values[field.key] = field.options.filter((option) => selected.includes(option));
      }
    } else {
      if (value !== undefined && typeof value !== 'string')
        error(`${field.label}は文字で入力してください`);
      const text = typeof value === 'string' ? value.trim() : '';
      if (field.required && !text) error(`${field.label}を入力してください`);
      if (text) {
        if (field.type === 'date') {
          if (
            !isCatalogDate(text) ||
            (field.minDate && text < field.minDate) ||
            (field.maxDate && text > field.maxDate)
          ) {
            error(`${field.label}は設定された範囲の実在する日付で入力してください`);
            continue;
          }
        } else if (
          field.type === 'select' ? !field.options.includes(text) : text.length > field.maxLength
        ) {
          error(`${field.label}が候補または文字数の条件に合いません`);
          continue;
        }
        values[field.key] = text;
      }
    }
  }
  return { values, errors };
}
