import type { CatalogField } from './api';

/** Local authoring feedback only. Saving and real requests still use server validation. */
export type CatalogPreviewConfig = {
  title: string;
  description: string;
  target: string;
  days: string;
  maxReason: number;
  approver: string;
  fields: CatalogField[];
  approvers: Array<{ id: string; name: string }>;
};

export type CatalogPreviewIssue = { field: string; message: string };
export type CatalogPreviewInput = {
  reason: string;
  durationDays: number;
  values: Record<string, string | boolean>;
};

/** Keep sample controls and validation aligned after editing the question definition. */
export function normalizeCatalogPreviewValues(
  previousFields: ReadonlyArray<Pick<CatalogField, 'key' | 'type'>>,
  fields: CatalogField[],
  values: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const previousTypes = new Map(previousFields.map((field) => [field.key, field.type]));
  return Object.fromEntries(
    fields.map((field) => {
      const value = values[field.key];
      if (previousTypes.get(field.key) !== field.type)
        return [field.key, field.type === 'checkbox' ? false : ''];
      if (field.type === 'checkbox') return [field.key, typeof value === 'boolean' ? value : false];
      if (typeof value !== 'string') return [field.key, ''];
      if (field.type === 'select')
        return [
          field.key,
          field.options.some((option) => option.trim() === value.trim()) ? value.trim() : '',
        ];
      return [field.key, value];
    }),
  );
}

export function validateCatalogPreviewConfig(config: CatalogPreviewConfig): {
  durations: number[];
  errors: CatalogPreviewIssue[];
} {
  const errors: CatalogPreviewIssue[] = [];
  const error = (field: string, message: string) => errors.push({ field, message });
  if (!config.title.trim() || config.title.trim().length > 200)
    error('title', 'サービス名を1〜200文字で入力してください。');
  if (!config.description.trim() || config.description.trim().length > 2000)
    error('description', '利用者への説明を1〜2000文字で入力してください。');
  if (!config.target.trim() || config.target.trim().length > 100)
    error('target', '模擬対象の表示名を1〜100文字で入力してください。');
  const rawDays = config.days.split(',').map((value) => value.trim());
  const durations = rawDays.map(Number);
  if (
    rawDays.some((value) => !value) ||
    durations.length > 10 ||
    durations.some((value) => !Number.isInteger(value) || value < 1 || value > 365) ||
    new Set(durations).size !== durations.length
  )
    error('days', '利用日数は1〜365日の整数を、重複なく最大10候補で設定してください。');
  if (!Number.isInteger(config.maxReason) || config.maxReason < 1 || config.maxReason > 2000)
    error('maxReason', '理由の文字数上限を1〜2000の整数で設定してください。');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.approver) ||
    !config.approvers.some((person) => person.id === config.approver)
  )
    error('approver', '現在の候補から固定の承認者を選んでください。');
  if (config.fields.length > 10) error('fields', '追加の申請項目は最大10件です。');
  const keys = new Set<string>();
  config.fields.forEach((field, index) => {
    const name = `項目${index + 1}`;
    const path = `fields.${index}`;
    if (
      !/^[a-z][a-z0-9_]{0,31}$/.test(field.key) ||
      ['constructor', 'prototype', '__proto__'].includes(field.key) ||
      keys.has(field.key)
    )
      error(`${path}.key`, `${name}の保存キーを確認してください。同じキーは使用できません。`);
    keys.add(field.key);
    if (!field.label.trim() || field.label.trim().length > 100)
      error(`${path}.label`, `${name}の表示名を1〜100文字で入力してください。`);
    if (typeof field.required !== 'boolean')
      error(`${path}.required`, `${name}の必須設定を確認してください。`);
    if (field.type === 'select') {
      const options = field.options.map((option) => option.trim());
      if (
        options.length < 2 ||
        options.length > 10 ||
        options.some((option) => !option || option.length > 100) ||
        new Set(options).size !== options.length
      )
        error(`${path}.options`, `${name}の選択肢を重複・空行なしの2〜10候補で設定してください。`);
    } else if (field.type === 'text' || field.type === 'textarea') {
      const max = field.type === 'text' ? 1000 : 2000;
      if (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > max)
        error(`${path}.maxLength`, `${name}の文字数上限を1〜${max}の整数で設定してください。`);
    } else if (field.type !== 'checkbox') {
      error(`${path}.type`, `${name}の種類を確認してください。`);
    }
  });
  return {
    durations: errors.some((issue) => issue.field === 'days') ? [] : durations,
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
  for (const key of Object.keys(input.values)) {
    if (!config.fields.some((field) => field.key === key))
      errors.push({ field: `values.${key}`, message: '定義にない申請項目は試験できません。' });
  }
  for (const field of config.fields) {
    const value = input.values[field.key];
    const path = `values.${field.key}`;
    if (field.type === 'checkbox') {
      if ((value !== undefined && typeof value !== 'boolean') || (field.required && value !== true))
        errors.push({ field: path, message: `${field.label}を確認してチェックしてください。` });
      continue;
    }
    if (value !== undefined && typeof value !== 'string') {
      errors.push({ field: path, message: `${field.label}は文字で入力してください。` });
      continue;
    }
    // The request route caps raw strings before field-specific normalization.
    if (typeof value === 'string' && value.length > 2000) {
      errors.push({ field: path, message: `${field.label}は2000文字以内で入力してください。` });
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (field.required && !text)
      errors.push({ field: path, message: `${field.label}を入力してください。` });
    if (
      text &&
      (field.type === 'select'
        ? !field.options.some((option) => option.trim() === text)
        : text.length > field.maxLength)
    )
      errors.push({ field: path, message: `${field.label}の候補または文字数を確認してください。` });
  }
  return errors;
}
