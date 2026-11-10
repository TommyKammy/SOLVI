import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeCatalogPreviewValues,
  validateCatalogPreviewConfig,
  validateCatalogPreviewInput,
  type CatalogPreviewConfig,
  type CatalogPreviewInput,
} from '../../apps/web/src/lib/catalog-preview';
import type { CatalogField } from '../../apps/web/src/lib/api';
import { CatalogLivePreview } from '../../apps/web/src/components/CatalogLivePreview';
import { CatalogFieldInputs } from '../../apps/web/src/components/CatalogFieldInputs';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, changed: false }));
vi.mock('react', async (importActual) => {
  const actual = await importActual<typeof import('react')>();
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const index = hooks.cursor++;
      if (!(index in hooks.states))
        hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [
        hooks.states[index] as T,
        (next: T | ((previous: T) => T)) => {
          hooks.states[index] =
            typeof next === 'function'
              ? (next as (previous: T) => T)(hooks.states[index] as T)
              : next;
          hooks.changed = true;
        },
      ];
    },
    useId: () => 'preview-unit',
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
  };
});
beforeEach(() => {
  vi.stubGlobal('React', React);
  hooks.states = [];
  hooks.cursor = 0;
  hooks.changed = false;
});
afterEach(() => vi.unstubAllGlobals());

const approverId = '11111111-1111-4111-8111-111111111111';
const configuration = (changes: Partial<CatalogPreviewConfig> = {}): CatalogPreviewConfig => ({
  title: '業務システムの利用申請',
  description: '業務で利用する期間と目的を入力してください。',
  target: '業務システム',
  days: '1, 7, 365',
  maxReason: 2000,
  approver: approverId,
  approvers: [{ id: approverId, name: '承認担当者' }],
  fields: [],
  ...changes,
});
const input = (changes: Partial<CatalogPreviewInput> = {}): CatalogPreviewInput => ({
  reason: '月次集計のため',
  durationDays: 7,
  values: {},
  ...changes,
});
function field(changes: Partial<CatalogField> = {}): CatalogField {
  const base = {
    key: changes.key ?? 'project',
    label: changes.label ?? 'プロジェクト名',
    required: changes.required ?? true,
  };
  if (changes.type === 'multiselect')
    return { ...base, type: 'multiselect', options: changes.options ?? ['国内', '海外'] };
  if (changes.type === 'number')
    return {
      ...base,
      type: 'number',
      ...(changes.min !== undefined ? { min: changes.min } : {}),
      ...(changes.max !== undefined ? { max: changes.max } : {}),
    };
  if (changes.type === 'date')
    return {
      ...base,
      type: 'date',
      ...(changes.minDate ? { minDate: changes.minDate } : {}),
      ...(changes.maxDate ? { maxDate: changes.maxDate } : {}),
    };
  if (changes.type === 'select')
    return { ...base, type: 'select', options: changes.options ?? ['国内', '海外'] };
  if (changes.type === 'checkbox') return { ...base, type: 'checkbox' };
  return {
    ...base,
    type: changes.type ?? 'text',
    maxLength: 'maxLength' in changes ? (changes.maxLength ?? 100) : 100,
  };
}
const configErrors = (changes: Partial<CatalogPreviewConfig>) =>
  validateCatalogPreviewConfig(configuration(changes)).errors.map((issue) => issue.field);
const inputErrors = (config: CatalogPreviewConfig, changes: Partial<CatalogPreviewInput>) =>
  validateCatalogPreviewInput(config, input(changes)).map((issue) => issue.field);

describe('catalog preview configuration', () => {
  it('treats a blank optional category like the save action without adding a definition key', () => {
    expect(validateCatalogPreviewConfig(configuration({ category: '   ' })).errors).toEqual([]);
  });
  it('accepts the duration endpoints and exactly ten distinct candidates', () => {
    expect(validateCatalogPreviewConfig(configuration({ days: '1,2,3,4,5,6,7,8,9,365' }))).toEqual({
      durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 365],
      errors: [],
    });
  });

  it.each(['', '0', '366', '1.5', 'NaN', '1,,7', '1,', '1, 01', '1,2,3,4,5,6,7,8,9,10,11'])(
    'does not expose selectable durations for invalid draft %s',
    (days) => {
      const result = validateCatalogPreviewConfig(configuration({ days }));
      expect(result.errors.map((issue) => issue.field)).toContain('days');
      expect(result.durations).toEqual([]);
    },
  );

  it('trims service copy and allows each maximum length', () => {
    expect(
      configErrors({
        title: ` ${'a'.repeat(200)} `,
        description: ` ${'a'.repeat(2000)} `,
        target: ` ${'a'.repeat(100)} `,
      }),
    ).toEqual([]);
    expect(configErrors({ title: ' ', description: ' ', target: ' ' })).toEqual([
      'title',
      'description',
      'target',
    ]);
    expect(
      configErrors({
        title: 'a'.repeat(201),
        description: 'a'.repeat(2001),
        target: 'a'.repeat(101),
      }),
    ).toEqual(['title', 'description', 'target']);
  });

  it.each([0, 2001, 1.5, Number.NaN])('rejects an invalid reason limit %s', (maxReason) => {
    expect(configErrors({ maxReason })).toContain('maxReason');
  });

  it.each([1, 2000])('accepts the reason limit boundary %s', (maxReason) => {
    expect(configErrors({ maxReason })).toEqual([]);
  });

  it('requires an approver from the current candidates with a valid identifier', () => {
    expect(configErrors({ approver: '22222222-2222-4222-8222-222222222222' })).toContain(
      'approver',
    );
    expect(
      configErrors({ approver: 'invalid', approvers: [{ id: 'invalid', name: '候補' }] }),
    ).toContain('approver');
    expect(configErrors({ approvers: [] })).toContain('approver');
  });

  it('accepts exactly ten fields and rejects an eleventh', () => {
    const fields = Array.from({ length: 10 }, (_, index) => field({ key: `field_${index}` }));
    expect(configErrors({ fields })).toEqual([]);
    expect(configErrors({ fields: [...fields, field({ key: 'field_10' })] })).toContain('fields');
  });

  it.each([
    'constructor',
    'prototype',
    '__proto__',
    'Project',
    '1project',
    'has-dash',
    'a'.repeat(33),
  ])('rejects unsafe or malformed field key %s', (key) =>
    expect(configErrors({ fields: [field({ key })] })).toContain('fields.0.key'),
  );

  it('rejects duplicate keys even when their field types differ', () => {
    expect(configErrors({ fields: [field(), field({ type: 'checkbox' })] })).toContain(
      'fields.1.key',
    );
  });

  it('checks trimmed field labels and their length boundary', () => {
    expect(configErrors({ fields: [field({ label: ` ${'a'.repeat(100)} ` })] })).toEqual([]);
    expect(configErrors({ fields: [field({ label: '  ' })] })).toContain('fields.0.label');
    expect(configErrors({ fields: [field({ label: 'a'.repeat(101) })] })).toContain(
      'fields.0.label',
    );
  });

  it.each([
    ['text', 1, true],
    ['text', 1000, true],
    ['text', 0, false],
    ['text', 1001, false],
    ['textarea', 1, true],
    ['textarea', 2000, true],
    ['textarea', 0, false],
    ['textarea', 2001, false],
    ['text', 1.5, false],
    ['textarea', Number.NaN, false],
  ] as const)('checks %s length limit %s', (type, maxLength, valid) => {
    expect(configErrors({ fields: [field({ type, maxLength })] }).length === 0).toBe(valid);
  });

  it('accepts two through ten trimmed, unique select candidates up to 100 characters', () => {
    expect(
      configErrors({
        fields: [field({ type: 'select', options: [' 第一候補 ', 'a'.repeat(100)] })],
      }),
    ).toEqual([]);
    expect(
      configErrors({
        fields: [
          field({ type: 'select', options: Array.from({ length: 10 }, (_, i) => String(i)) }),
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    [],
    ['one'],
    ['one', ' '],
    ['one', ' one '],
    ['one', 'a'.repeat(101)],
    Array.from({ length: 11 }, (_, index) => String(index)),
  ])('rejects invalid select choices %j', (...options) => {
    expect(
      configErrors({ fields: [field({ type: 'select', options: options as string[] })] }),
    ).toContain('fields.0.options');
  });
});

describe('catalog preview sample input', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('validates only enabled common fields: reason=%s duration=%s', (reason, duration) => {
    const config = configuration({ requestFields: { reason, duration } });
    const errors = inputErrors(config, { reason: '', durationDays: 0 });
    expect(errors.includes('reason')).toBe(reason);
    expect(errors.includes('durationDays')).toBe(duration);
    expect(validateCatalogPreviewConfig(config).errors).toEqual([]);
  });
  it('cannot report success while the unsaved configuration is invalid', () => {
    expect(inputErrors(configuration({ fields: [field({ label: '' })] }), {})).toContain(
      'fields.0.label',
    );
    expect(inputErrors(configuration({ days: '' }), {})).toContain('days');
  });

  it('checks a trimmed nonempty reason against the configured maximum', () => {
    const config = configuration({ maxReason: 3 });
    expect(inputErrors(config, { reason: ' abc ' })).toEqual([]);
    expect(inputErrors(config, { reason: ' \n ' })).toContain('reason');
    expect(inputErrors(config, { reason: 'abcd' })).toContain('reason');
  });

  it.each([0, 2, 7.5, 366])(
    'rejects a duration outside the configured candidates: %s',
    (durationDays) => {
      expect(inputErrors(configuration(), { durationDays })).toContain('durationDays');
    },
  );

  it('accepts all four supported field types without changing the definition or sample', () => {
    const config = configuration({
      fields: [
        field({ key: 'project', maxLength: 4 }),
        field({ key: 'details', type: 'textarea', maxLength: 8 }),
        field({ key: 'region', type: 'select', options: [' 国内 ', '海外'] }),
        { key: 'confirmed', label: '確認事項', type: 'checkbox', required: true },
      ],
    });
    const sample = input({
      values: { project: ' ABCD ', details: 'abcdefgh', region: ' 国内 ', confirmed: true },
    });
    const before = JSON.stringify({ config, sample });
    expect(validateCatalogPreviewInput(config, sample)).toEqual([]);
    expect(JSON.stringify({ config, sample })).toBe(before);
  });

  it('reports each omitted required sample with its field path', () => {
    const config = configuration({
      fields: [
        field(),
        field({ key: 'details', type: 'textarea' }),
        field({ key: 'region', type: 'select', options: ['国内', '海外'] }),
        { key: 'confirmed', label: '確認事項', type: 'checkbox', required: true },
      ],
    });
    expect(inputErrors(config, {})).toEqual([
      'values.project',
      'values.details',
      'values.region',
      'values.confirmed',
    ]);
  });

  it('accepts omitted and whitespace-only optional text, select and checkbox samples', () => {
    const config = configuration({
      fields: [
        field({ required: false }),
        field({ key: 'region', type: 'select', required: false, options: ['国内', '海外'] }),
        { key: 'confirmed', label: '確認事項', type: 'checkbox', required: false },
      ],
    });
    expect(inputErrors(config, {})).toEqual([]);
    expect(
      inputErrors(config, { values: { project: '   ', region: ' ', confirmed: false } }),
    ).toEqual([]);
  });

  it('checks text length after trimming and rejects custom select values', () => {
    const config = configuration({
      fields: [
        field({ maxLength: 3 }),
        field({ key: 'details', type: 'textarea', maxLength: 3 }),
        field({ key: 'region', type: 'select', options: ['国内', '海外'] }),
      ],
    });
    expect(
      inputErrors(config, { values: { project: 'abcd', details: 'abcd', region: 'その他' } }),
    ).toEqual(['values.project', 'values.details', 'values.region']);
  });

  it('enforces the request route raw string cap before accepting whitespace-only optional values', () => {
    const config = configuration({ fields: [field({ required: false })] });
    expect(inputErrors(config, { values: { project: ' '.repeat(2000) } })).toEqual([]);
    expect(inputErrors(config, { values: { project: ' '.repeat(2001) } })).toContain(
      'values.project',
    );
  });

  it('rejects wrong sample types and requires true for a required checkbox', () => {
    const config = configuration({
      fields: [field(), { key: 'confirmed', label: '確認事項', type: 'checkbox', required: true }],
    });
    expect(inputErrors(config, { values: { project: true, confirmed: 'true' } })).toEqual([
      'values.project',
      'values.confirmed',
    ]);
    expect(inputErrors(config, { values: { project: '入力済', confirmed: false } })).toEqual([
      'values.confirmed',
    ]);
  });

  it('rejects sample keys absent from the current definition', () => {
    expect(inputErrors(configuration(), { values: { removed_question: '残った値' } })).toContain(
      'values.removed_question',
    );
  });
});

describe('catalog preview sample normalization', () => {
  it('resets a sample whenever its question type changes, including text to textarea', () => {
    const previous = [field(), field({ key: 'confirmed', type: 'checkbox' })];
    const fields = [field({ type: 'textarea' }), field({ key: 'confirmed', type: 'text' })];
    expect(
      normalizeCatalogPreviewValues(previous, fields, { project: 'old', confirmed: true }),
    ).toEqual({
      project: '',
      confirmed: '',
    });
    expect(
      normalizeCatalogPreviewValues([field()], [field({ type: 'checkbox' })], { project: 'old' }),
    ).toEqual({ project: false });
  });

  it('drops removed questions, defaults new ones, and preserves reordered samples by key', () => {
    const previous = [field(), field({ key: 'details' }), field({ key: 'removed' })];
    const fields = [field({ key: 'details' }), field(), field({ key: 'new_question' })];
    expect(
      normalizeCatalogPreviewValues(previous, fields, {
        project: 'project value',
        details: 'details value',
        removed: 'old value',
      }),
    ).toEqual({ details: 'details value', project: 'project value', new_question: '' });
  });

  it('clears removed select choices and normalizes valid choices like saved definitions', () => {
    const previous = [field({ type: 'select', options: ['国内', '海外'] })];
    const fields = [field({ type: 'select', options: [' 海外 ', 'その他'] })];
    expect(normalizeCatalogPreviewValues(previous, fields, { project: '国内' })).toEqual({
      project: '',
    });
    expect(normalizeCatalogPreviewValues(previous, fields, { project: ' 海外 ' })).toEqual({
      project: '海外',
    });
  });
});

type PreviewNode = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function nodes(value: unknown): PreviewNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as PreviewNode;
  if (element.type === CatalogFieldInputs)
    return [
      element,
      ...nodes(CatalogFieldInputs(element.props as Parameters<typeof CatalogFieldInputs>[0])),
    ];
  return [element, ...nodes(element.props.children)];
}
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) {
    const node = value as PreviewNode;
    if (node.type === CatalogFieldInputs)
      return text(CatalogFieldInputs(node.props as Parameters<typeof CatalogFieldInputs>[0]));
    return text(node.props.children);
  }
  return '';
}
function renderPreview(config: CatalogPreviewConfig) {
  for (let pass = 0; pass < 5; pass++) {
    hooks.cursor = 0;
    hooks.changed = false;
    const tree = CatalogLivePreview(config);
    if (!hooks.changed) return tree;
  }
  throw new Error('Preview state did not settle');
}
function control(tree: unknown, index: number) {
  const match = nodes(tree).find(
    (node) => node.props.id === `catalog-try-preview-unit-field-${index}`,
  );
  if (!match) throw new Error(`Missing preview control ${index}`);
  return match;
}
function changeSample(tree: unknown, index: number, value: string | boolean) {
  const handler = control(tree, index).props.onChange as (event: {
    target: { value: string; checked: boolean };
  }) => void;
  handler({ target: { value: typeof value === 'string' ? value : '', checked: value === true } });
}
function testSample(tree: unknown, config: CatalogPreviewConfig) {
  const reason = nodes(tree).find((node) => node.props.id === 'catalog-try-preview-unit-reason')!;
  (reason.props.onChange as (event: unknown) => void)({ target: { value: '月次集計のため' } });
  const form = nodes(renderPreview(config)).find((node) => node.type === 'form')!;
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault, stopPropagation });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(stopPropagation).toHaveBeenCalledOnce();
  const status = nodes(renderPreview(config)).find((node) => node.props.role === 'status');
  return text(status);
}

describe('catalog live preview definition changes', () => {
  it('removes disabled base samples and never resurrects a previous reason or duration selection', () => {
    let config = configuration();
    const common = (tree: unknown, suffix: string) =>
      nodes(tree).find((node) => node.props.id === `catalog-try-preview-unit-${suffix}`);
    let tree = renderPreview(config);
    (common(tree, 'reason')!.props.onChange as (event: unknown) => void)({
      target: { value: '以前の理由' },
    });
    tree = renderPreview(config);
    (common(tree, 'days')!.props.onChange as (event: unknown) => void)({
      target: { value: '365' },
    });
    config = configuration({ requestFields: { reason: false, duration: false } });
    tree = renderPreview(config);
    expect(common(tree, 'reason')).toBeUndefined();
    expect(common(tree, 'days')).toBeUndefined();
    const form = nodes(tree).find((node) => node.type === 'form')!;
    (form.props.onSubmit as (event: unknown) => void)({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(
      text(nodes(renderPreview(config)).find((node) => node.props.role === 'status')),
    ).toContain('入力を確認しました');
    config = configuration();
    tree = renderPreview(config);
    expect(common(tree, 'reason')!.props.value).toBe('');
    expect(common(tree, 'days')!.props.value).toBe('1');
  });
  it('validates the visible unchecked value after optional text becomes a checkbox', () => {
    let config = configuration({ fields: [field({ required: false })] });
    changeSample(renderPreview(config), 0, 'previous text');
    config = configuration({ fields: [field({ type: 'checkbox', required: false })] });
    const tree = renderPreview(config);
    expect(control(tree, 0).props.checked).toBe(false);
    expect(testSample(tree, config)).toBe('入力を確認しました。申請は送信されません。');
  });

  it('clears a checked checkbox when it becomes text without showing or validating a boolean', () => {
    let config = configuration({ fields: [field({ type: 'checkbox', required: false })] });
    changeSample(renderPreview(config), 0, true);
    config = configuration({ fields: [field({ required: false })] });
    const tree = renderPreview(config);
    expect(control(tree, 0).props.value).toBe('');
    expect(testSample(tree, config)).toBe('入力を確認しました。申請は送信されません。');
  });

  it('clears a removed select choice and does not restore it when the choice returns', () => {
    const original = field({ type: 'select', required: false, options: ['国内', '海外'] });
    let config = configuration({ fields: [original] });
    changeSample(renderPreview(config), 0, '国内');
    config = configuration({
      fields: [field({ type: 'select', required: false, options: ['海外', 'その他'] })],
    });
    const tree = renderPreview(config);
    expect(control(tree, 0).props.value).toBe('');
    expect(testSample(tree, config)).toBe('入力を確認しました。申請は送信されません。');
    config = configuration({ fields: [original] });
    expect(control(renderPreview(config), 0).props.value).toBe('');
  });

  it('keeps values with their questions while reordering and drops deleted samples permanently', () => {
    const first = field();
    const second = field({ key: 'details', type: 'textarea' });
    let config = configuration({ fields: [first, second] });
    changeSample(renderPreview(config), 0, 'project value');
    changeSample(renderPreview(config), 1, 'details value');
    config = configuration({ fields: [second, first] });
    const reordered = renderPreview(config);
    expect(control(reordered, 0).props.value).toBe('details value');
    expect(control(reordered, 1).props.value).toBe('project value');
    config = configuration({ fields: [second] });
    renderPreview(config);
    config = configuration({ fields: [second, first] });
    expect(control(renderPreview(config), 1).props.value).toBe('');
  });
});

describe('priority two shared preview contract', () => {
  const expandedFields: CatalogField[] = [
    {
      key: 'loan',
      label: '貸与区分',
      type: 'select',
      required: true,
      options: ['標準貸与', '一時貸出'],
    },
    {
      key: 'return_date',
      label: '返却予定日',
      type: 'date',
      required: true,
      minDate: '2026-01-01',
      maxDate: '2030-12-31',
      visibleWhen: { field: 'loan', equals: '一時貸出' },
      section: 'equipment',
      helpText: '返却可能な日を指定します。',
    },
    {
      key: 'quantity',
      label: '希望台数',
      type: 'number',
      required: true,
      min: 1,
      max: 5,
      section: 'equipment',
    },
    {
      key: 'extras',
      label: '周辺機器',
      type: 'multiselect',
      required: true,
      options: [' マウス ', 'アダプター'],
      section: 'equipment',
    },
  ];
  const expanded = () =>
    configuration({
      fields: expandedFields,
      category: '機器・備品',
      sections: [
        { key: 'equipment', title: '必要な機器', description: '業務で必要な機器を選びます。' },
      ],
    });

  it('accepts all new definition metadata and the three new typed sample values', () => {
    const config = expanded();
    expect(validateCatalogPreviewConfig(config).errors).toEqual([]);
    expect(
      inputErrors(config, {
        values: {
          loan: '一時貸出',
          return_date: '2028-02-29',
          quantity: '2.5',
          extras: ['マウス', 'アダプター'],
        },
      }),
    ).toEqual([]);
    expect(
      inputErrors(config, { values: { loan: '標準貸与', quantity: 2, extras: ['マウス'] } }),
    ).toEqual([]);
  });

  it.each(['2027-02-29', '2028-02-30', '2025-12-31', '2031-01-01'])(
    'rejects impossible or out-of-range date %s',
    (return_date) => {
      expect(
        inputErrors(expanded(), {
          values: { loan: '一時貸出', return_date, quantity: '2', extras: ['マウス'] },
        }),
      ).toEqual(['values.return_date']);
    },
  );

  it.each(['', 'NaN', 'Infinity', '0x10', '6', '0', true])(
    'does not accept empty, malformed, wrong-type or out-of-range numeric value %s',
    (quantity) => {
      expect(
        inputErrors(expanded(), { values: { loan: '標準貸与', quantity, extras: ['マウス'] } }),
      ).toEqual(['values.quantity']);
    },
  );

  it.each([[], ['未知の候補'], ['マウス', ' マウス ']])(
    'rejects empty, unknown or repeated multiple choices %j',
    (...choices) => {
      expect(
        inputErrors(expanded(), {
          values: { loan: '標準貸与', quantity: 2, extras: choices as string[] },
        }),
      ).toEqual(['values.extras']);
    },
  );

  it('reports category, section and condition configuration errors before a sample can succeed', () => {
    expect(configErrors({ category: 'x'.repeat(81) })).toContain('category');
    expect(
      configErrors({ fields: [{ ...expandedFields[1], section: 'missing' }], sections: [] }),
    ).toContain('fields.0.section');
    const cyclic: CatalogField[] = [
      {
        key: 'first',
        label: '最初',
        required: false,
        type: 'checkbox',
        visibleWhen: { field: 'second', equals: true },
      },
      {
        key: 'second',
        label: '次',
        required: false,
        type: 'checkbox',
        visibleWhen: { field: 'first', equals: true },
      },
    ];
    expect(configErrors({ fields: cyclic }).some((path) => path.endsWith('visibleWhen'))).toBe(
      true,
    );
  });

  it('normalizes multiple choices to trimmed current options and clears samples on type changes', () => {
    const old: CatalogField = {
      key: 'extras',
      label: '周辺機器',
      type: 'multiselect',
      required: false,
      options: ['マウス', '旧候補'],
    };
    const next: CatalogField = { ...old, options: [' マウス ', 'アダプター'] };
    expect(normalizeCatalogPreviewValues([old], [next], { extras: ['マウス', '旧候補'] })).toEqual({
      extras: ['マウス'],
    });
    expect(
      normalizeCatalogPreviewValues([field({ key: 'extras' })], [next], { extras: 'old' }),
    ).toEqual({ extras: [] });
    expect(
      normalizeCatalogPreviewValues([old], [field({ key: 'extras', type: 'number' })], {
        extras: ['マウス'],
      }),
    ).toEqual({ extras: '' });
  });

  it('shows sections and hints, keeps controls unnamed, and clears hidden required values without resurrection', () => {
    const config = expanded();
    let tree = renderPreview(config);
    expect(text(tree)).toContain('必要な機器');
    expect(text(tree)).toContain('業務で必要な機器を選びます。');
    expect(nodes(tree).some((node) => node.props.id === 'catalog-try-preview-unit-field-1')).toBe(
      false,
    );
    changeSample(tree, 0, '一時貸出');
    tree = renderPreview(config);
    expect(text(tree)).toContain('返却可能な日を指定します。');
    changeSample(tree, 1, '2028-02-29');
    changeSample(renderPreview(config), 0, '標準貸与');
    expect(
      nodes(renderPreview(config)).some(
        (node) => node.props.id === 'catalog-try-preview-unit-field-1',
      ),
    ).toBe(false);
    changeSample(renderPreview(config), 0, '一時貸出');
    tree = renderPreview(config);
    expect(control(tree, 1).props.value).toBe('');
    expect(
      nodes(tree)
        .filter((node) => ['input', 'select', 'textarea'].includes(String(node.type)))
        .every((node) => !node.props.name),
    ).toBe(true);
  });

  it('keeps a selected draft option with whitespace checked after another input changes', () => {
    const config = expanded();
    let tree = renderPreview(config);
    changeSample(tree, 0, '標準貸与');
    tree = renderPreview(config);
    const mouse = nodes(tree).find(
      (node) => node.props.id === 'catalog-try-preview-unit-field-3-0',
    )!;
    (mouse.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    changeSample(renderPreview(config), 2, '2.5');
    tree = renderPreview(config);
    expect(
      nodes(tree).find((node) => node.props.id === 'catalog-try-preview-unit-field-3-0')?.props
        .checked,
    ).toBe(true);
    expect(testSample(tree, config)).toBe('入力を確認しました。申請は送信されません。');
  });
});
