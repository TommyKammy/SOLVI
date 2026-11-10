import { describe, expect, it } from 'vitest';
import {
  catalogDefinitionSchema,
  catalogFieldSchema,
  getVisibleCatalogFields,
  groupCatalogFields,
  isCatalogDate,
  validateCatalogFieldValues,
  type CatalogDefinition,
  type CatalogField,
} from '../../packages/shared/src/catalog';
import { validateValues } from '../../services/api/src/modules/catalog/catalog-definition';

const text: CatalogField = {
  key: 'team',
  label: '部署',
  type: 'text',
  required: true,
  maxLength: 100,
};
const choice: CatalogField = {
  key: 'loan',
  label: '貸与区分',
  type: 'select',
  required: true,
  options: ['標準貸与', '一時貸出'],
};
const confirm: CatalogField = { key: 'confirm', label: '確認', type: 'checkbox', required: false };
const number: CatalogField = {
  key: 'quantity',
  label: '台数',
  type: 'number',
  required: true,
  min: 0,
  max: 10,
};
const date: CatalogField = {
  key: 'start_date',
  label: '開始希望日',
  type: 'date',
  required: true,
  minDate: '2026-01-01',
  maxDate: '2026-12-31',
};
const multi: CatalogField = {
  key: 'devices',
  label: '周辺機器',
  type: 'multiselect',
  required: true,
  options: ['マウス', 'ディスプレイ', 'キーボード'],
};
const definition = (changes: Partial<CatalogDefinition> = {}): CatalogDefinition => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7, 30],
  maxReasonLength: 2000,
  ...changes,
});
const validate = (fields: CatalogField[], values: Record<string, unknown>) =>
  validateCatalogFieldValues({ fields }, values);
const paths = (value: unknown) => {
  const result = catalogDefinitionSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('FR-CAT-002/003 backward compatible catalog definitions', () => {
  it('keeps a legacy JSON definition and normalized answers without new attributes', () => {
    const legacy = definition({
      fields: [
        text,
        choice,
        { key: 'notes', label: '補足', type: 'textarea', required: false, maxLength: 2000 },
        confirm,
      ],
    });
    const parsed = catalogDefinitionSchema.parse(legacy);
    expect(parsed).toStrictEqual(legacy);
    expect(parsed).not.toHaveProperty('category');
    expect(parsed).not.toHaveProperty('sections');
    expect(parsed.fields?.[0]).not.toHaveProperty('helpText');
    expect(parsed.fields?.[0]).not.toHaveProperty('visibleWhen');
    const oldValues = { team: '合成IT部', loan: '標準貸与', confirm: false };
    expect(validateValues(parsed, oldValues)).toStrictEqual(oldValues);
    expect(validateValues(definition(), {})).toStrictEqual({});
  });

  it('accepts all seven types and versioned optional metadata', () => {
    const value = definition({
      category: ' 端末・機器 ',
      sections: [
        { key: 'loan_info', title: ' 貸与情報 ', description: '必要な内容を入力してください' },
      ],
      fields: [
        { ...text, helpText: '申請する部署を入力', section: 'loan_info' },
        choice,
        confirm,
        { ...date, visibleWhen: { field: 'loan', equals: '一時貸出' } },
        number,
        multi,
        { key: 'notes', label: '補足', type: 'textarea', required: false, maxLength: 500 },
      ],
    });
    const parsed = catalogDefinitionSchema.parse(value);
    expect(parsed.category).toBe('端末・機器');
    expect(parsed.sections?.[0]?.title).toBe('貸与情報');
    expect(parsed.fields).toHaveLength(7);
  });

  it.each(['', 'a'.repeat(81)])('rejects invalid category %s', (category) => {
    expect(paths(definition({ category }))).toContain('category');
  });
  it('keeps definition, field, and section objects strict and bounded', () => {
    expect(
      catalogDefinitionSchema.safeParse({ ...definition(), resourceId: 'untrusted' }).success,
    ).toBe(false);
    expect(catalogFieldSchema.safeParse({ ...text, arbitrary: true }).success).toBe(false);
    expect(
      catalogDefinitionSchema.safeParse(
        definition({
          fields: Array.from({ length: 11 }, (_, i) => ({ ...text, key: `team_${i}` })),
        }),
      ).success,
    ).toBe(false);
    expect(
      catalogDefinitionSchema.safeParse(
        definition({
          sections: Array.from({ length: 11 }, (_, i) => ({ key: `section_${i}`, title: '部門' })),
        }),
      ).success,
    ).toBe(false);
    expect(catalogFieldSchema.safeParse({ ...text, helpText: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(catalogFieldSchema.safeParse({ ...multi, options: ['同じ', ' 同じ '] }).success).toBe(
      false,
    );
    expect(catalogFieldSchema.safeParse({ ...multi, options: ['1件だけ'] }).success).toBe(false);
    expect(
      catalogFieldSchema.safeParse({
        ...multi,
        options: Array.from({ length: 11 }, (_, i) => String(i)),
      }).success,
    ).toBe(false);
    for (const key of ['constructor', 'prototype', '__proto__', '1team'])
      expect(catalogFieldSchema.safeParse({ ...text, key }).success).toBe(false);
  });
});

describe('catalog calendar and number boundaries', () => {
  it.each(['0001-01-01', '2000-02-29', '2024-02-29', '2026-12-31', '9999-12-31'])(
    'accepts real date %s',
    (value) => {
      expect(isCatalogDate(value)).toBe(true);
    },
  );
  it.each([
    '0000-01-01',
    '1900-02-29',
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-1-1',
    '2026-01-01T00:00:00Z',
    '',
  ])('rejects invalid date %s', (value) => {
    expect(isCatalogDate(value)).toBe(false);
  });
  it('validates date bounds as real dates and ordered endpoints', () => {
    expect(catalogFieldSchema.safeParse({ ...date, minDate: '2026-02-30' }).success).toBe(false);
    expect(catalogFieldSchema.safeParse({ ...date, minDate: '2027-01-01' }).success).toBe(false);
    for (const value of ['2026-01-01', '2026-12-31'])
      expect(validate([date], { start_date: value }).errors).toEqual([]);
    for (const value of ['2025-12-31', '2027-01-01', '2026-02-29', true])
      expect(validate([date], { start_date: value }).errors.length).toBeGreaterThan(0);
  });
  it('preserves zero and decimals with inclusive min/max', () => {
    for (const value of [0, 0.25, 10])
      expect(validate([number], { quantity: value })).toEqual({
        values: { quantity: value },
        errors: [],
      });
    expect(catalogFieldSchema.safeParse({ ...number, min: 10, max: 0 }).success).toBe(false);
    expect(catalogFieldSchema.safeParse({ ...number, max: Infinity }).success).toBe(false);
  });
  it.each(
    [-0.001, 10.001, Infinity, -Infinity, NaN, '2', true, [], null].map((value) => ({ value })),
  )('rejects invalid numeric answer $value', ({ value }) => {
    expect(validate([number], { quantity: value }).errors.map((issue) => issue.field)).toContain(
      'values.quantity',
    );
  });
  it.each([undefined, '', '   '])('treats blank numbers as missing, never zero: %j', (value) => {
    expect(validate([{ ...number, required: false }], { quantity: value })).toEqual({
      values: {},
      errors: [],
    });
    expect(validate([number], { quantity: value }).errors).toHaveLength(1);
  });
});

describe('catalog multiselect values', () => {
  it('normalizes candidate order without mutating the submitted answers', () => {
    const selected = Object.freeze([' キーボード ', 'マウス']);
    expect(validate([multi], { devices: selected })).toEqual({
      values: { devices: ['マウス', 'キーボード'] },
      errors: [],
    });
    expect(selected).toEqual([' キーボード ', 'マウス']);
  });
  it.each(
    [
      ['未定義'],
      ['マウス', 'マウス'],
      ['マウス', ' マウス '],
      [true],
      Array.from({ length: 11 }, () => 'マウス'),
      'マウス',
      false,
      1,
    ].map((value) => ({ value })),
  )('rejects invalid multiple selection $value', ({ value }) => {
    expect(validate([multi], { devices: value }).errors.map((issue) => issue.field)).toContain(
      'values.devices',
    );
  });
  it('requires one selection only when required and omits optional empty selections', () => {
    expect(validate([multi], { devices: [] }).errors).toHaveLength(1);
    expect(validate([multi], {}).errors).toHaveLength(1);
    expect(validate([{ ...multi, required: false }], { devices: [] })).toEqual({
      values: {},
      errors: [],
    });
  });
});

describe('catalog conditions and section references', () => {
  it('accepts a forward reference and preserves visibility when questions are reordered', () => {
    const child: CatalogField = { ...date, visibleWhen: { field: 'loan', equals: '一時貸出' } };
    expect(catalogDefinitionSchema.safeParse(definition({ fields: [child, choice] })).success).toBe(
      true,
    );
    expect(
      getVisibleCatalogFields([child, choice], { loan: '一時貸出' }).map((field) => field.key),
    ).toEqual(['start_date', 'loan']);
    expect(
      getVisibleCatalogFields([choice, child], { loan: '標準貸与' }).map((field) => field.key),
    ).toEqual(['loan']);
  });
  it('does not require, validate, or save answers to a hidden required field', () => {
    const child: CatalogField = { ...date, visibleWhen: { field: 'loan', equals: '一時貸出' } };
    expect(
      validate([choice, child], { loan: '標準貸与', start_date: 'invalid stale date' }),
    ).toEqual({ values: { loan: '標準貸与' }, errors: [] });
    expect(
      validate([choice, child], { loan: '一時貸出' }).errors.map((issue) => issue.field),
    ).toContain('values.start_date');
    expect(
      validate([choice, child], { loan: '標準貸与', undeclared: true }).errors.map(
        (issue) => issue.field,
      ),
    ).toContain('values.undeclared');
  });
  it('hides descendants of a hidden parent despite stale matching parent values', () => {
    const nestedChoice: CatalogField = {
      ...choice,
      visibleWhen: { field: 'confirm', equals: true },
    };
    const child: CatalogField = { ...date, visibleWhen: { field: 'loan', equals: '一時貸出' } };
    const fields = [child, nestedChoice, confirm];
    expect(
      validate(fields, { loan: '一時貸出', start_date: '2026-02-01', confirm: false }),
    ).toEqual({ values: { confirm: false }, errors: [] });
  });
  it('treats an omitted unchecked checkbox as false without inserting a new answer', () => {
    const child: CatalogField = {
      ...text,
      required: false,
      visibleWhen: { field: 'confirm', equals: false },
    };
    expect(validate([confirm, child], { team: '合成部署' })).toEqual({
      values: { team: '合成部署' },
      errors: [],
    });
    expect(
      getVisibleCatalogFields([confirm, child], { confirm: 'false' }).map((field) => field.key),
    ).toEqual(['confirm']);
  });
  it.each([
    { field: 'missing', equals: true },
    { field: 'team', equals: true },
    { field: 'quantity', equals: true },
    { field: 'loan', equals: true },
    { field: 'loan', equals: '候補外' },
    { field: 'confirm', equals: 'true' },
  ])('rejects invalid visibility reference %j', (visibleWhen) => {
    expect(
      paths(definition({ fields: [choice, confirm, number, { ...text, visibleWhen }] })),
    ).toContain('fields.3.visibleWhen');
  });
  it('rejects cycles and fails closed when an invalid draft reaches rendering', () => {
    const cycle: CatalogField[] = [
      { ...choice, visibleWhen: { field: 'confirm', equals: true } },
      { ...confirm, visibleWhen: { field: 'loan', equals: '一時貸出' } },
    ];
    expect(paths(definition({ fields: cycle })).some((path) => path.endsWith('visibleWhen'))).toBe(
      true,
    );
    expect(getVisibleCatalogFields(cycle, { loan: '一時貸出', confirm: true })).toEqual([]);
  });
  it('rejects duplicate keys, duplicate sections, and unknown sections', () => {
    expect(paths(definition({ fields: [text, text] }))).toContain('fields.1.key');
    expect(paths(definition({ fields: [{ ...text, section: 'missing' }] }))).toContain(
      'fields.0.section',
    );
    expect(
      paths(
        definition({
          sections: [
            { key: 'same', title: '先頭' },
            { key: 'same', title: '後続' },
          ],
        }),
      ),
    ).toContain('sections.1.key');
  });
  it('groups unassigned fields first, then section order while retaining field order', () => {
    const fields: CatalogField[] = [
      { ...date, section: 'second' },
      text,
      { ...number, section: 'first' },
      { ...multi, section: 'first' },
    ];
    const groups = groupCatalogFields(fields, [
      { key: 'first', title: '申請内容' },
      { key: 'second', title: '日程' },
      { key: 'empty', title: '空' },
    ]);
    expect(
      groups.map((group) => [group.section?.key, group.fields.map((field) => field.key)]),
    ).toEqual([
      [undefined, ['team']],
      ['first', ['quantity', 'devices']],
      ['second', ['start_date']],
    ]);
  });
  it('rejects malformed visible values through the server wrapper', () => {
    expect(() =>
      validateValues(definition({ fields: [date] }), { start_date: '2026-02-30' }),
    ).toThrow();
  });
});
