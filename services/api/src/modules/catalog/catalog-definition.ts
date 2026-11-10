import { z } from 'zod';
import { Problems } from '@solvi/shared';
const fieldBase = {
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .refine((k) => !['constructor', 'prototype', '__proto__'].includes(k)),
  label: z.string().trim().min(1).max(100),
  required: z.boolean(),
};
export const fieldSchema = z.discriminatedUnion('type', [
  z
    .object({ ...fieldBase, type: z.literal('text'), maxLength: z.number().int().min(1).max(1000) })
    .strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('textarea'),
      maxLength: z.number().int().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal('select'),
      options: z
        .array(z.string().trim().min(1).max(100))
        .min(2)
        .max(10)
        .refine((v) => new Set(v).size === v.length),
    })
    .strict(),
  z.object({ ...fieldBase, type: z.literal('checkbox') }).strict(),
]);
export const definitionSchema = z
  .object({
    mode: z.literal('local_simulation'),
    action: z.literal('simulate.access_grant'),
    targetLabel: z.string().trim().min(1).max(100),
    allowedDurations: z
      .array(z.number().int().min(1).max(365))
      .min(1)
      .max(10)
      .refine((v) => new Set(v).size === v.length),
    maxReasonLength: z.number().int().min(1).max(2000),
    fields: z
      .array(fieldSchema)
      .max(10)
      .refine((v) => new Set(v.map((f) => f.key)).size === v.length)
      .optional(),
    approval: z
      .object({ mode: z.literal('fixed'), approverId: z.string().uuid() })
      .strict()
      .optional(),
  })
  .strict();
export type Definition = z.infer<typeof definitionSchema>;
export function validateValues(
  definition: Definition,
  values: Record<string, string | boolean> = {},
) {
  const fields = definition.fields ?? [],
    errors: Array<{ field: string; message: string }> = [];
  for (const key of Object.keys(values))
    if (!fields.some((f) => f.key === key))
      errors.push({ field: 'values.' + key, message: '定義にない申請項目は送信できません' });
  const normalized: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'checkbox') {
      if (v !== undefined && typeof v !== 'boolean')
        errors.push({
          field: 'values.' + f.key,
          message: f.label + 'は確認チェックで入力してください',
        });
      if (f.required && v !== true)
        errors.push({ field: 'values.' + f.key, message: f.label + 'を確認してください' });
      if (typeof v === 'boolean') normalized[f.key] = v;
    } else {
      if (v !== undefined && typeof v !== 'string')
        errors.push({ field: 'values.' + f.key, message: f.label + 'は文字で入力してください' });
      const text = typeof v === 'string' ? v.trim() : '';
      if (f.required && !text)
        errors.push({ field: 'values.' + f.key, message: f.label + 'を入力してください' });
      if (text && (f.type === 'select' ? !f.options.includes(text) : text.length > f.maxLength))
        errors.push({
          field: 'values.' + f.key,
          message: f.label + 'が候補または文字数の条件に合いません',
        });
      if (text) normalized[f.key] = text;
    }
  }
  if (errors.length) throw Problems.validation(errors);
  return normalized;
}
