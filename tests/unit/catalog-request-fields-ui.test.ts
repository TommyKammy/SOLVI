import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogField, CatalogSection, CatalogValues } from '@solvi/shared/catalog';
import { CatalogFieldInputs } from '../../apps/web/src/components/CatalogFieldInputs';
import { CatalogValueSummary } from '../../apps/web/src/components/CatalogValueSummary';
import {
  catalogDraftValues,
  catalogInputValues,
  readCatalogFormValues,
  restoreCatalogDraftValues,
  visibleCatalogValues,
} from '../../apps/web/src/lib/catalog-form';
import { saveServiceRequest } from '../../apps/web/src/app/requests/actions';

const api = vi.hoisted(() => ({ submitRequest: vi.fn(), editRequest: vi.fn() }));
vi.mock('../../apps/web/src/lib/api', () => ({ api }));
vi.mock('../../apps/web/src/lib/form-scope', () => ({ formScopeError: async () => undefined }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

const sections: CatalogSection[] = [
  { key: 'equipment', title: '必要な機器', description: '数量と周辺機器を確認してください。' },
];
const fields: CatalogField[] = [
  {
    key: 'loan',
    type: 'select',
    label: '貸与区分',
    required: true,
    options: ['標準貸与', '一時貸出'],
  },
  {
    key: 'return_date',
    type: 'date',
    label: '返却予定日',
    required: true,
    minDate: '2026-01-01',
    maxDate: '2030-12-31',
    visibleWhen: { field: 'loan', equals: '一時貸出' },
    section: 'equipment',
    helpText: '一時貸出の場合に入力します。',
  },
  {
    key: 'quantity',
    type: 'number',
    label: '希望台数',
    required: true,
    min: 1,
    max: 5,
    section: 'equipment',
  },
  {
    key: 'extras',
    type: 'multiselect',
    label: '必要な周辺機器',
    required: true,
    options: ['マウス', 'アダプター'],
    section: 'equipment',
    helpText: '必要なものを複数選べます。',
  },
  { key: 'consent', type: 'checkbox', label: '内容を確認した', required: false },
];
type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const control = (tree: unknown, name: string) =>
  nodes(tree).find(
    (node) =>
      ['input', 'select', 'textarea'].includes(String(node.type)) &&
      node.props.name === name &&
      node.props.type !== 'hidden',
  )!;
function html(
  values: CatalogValues,
  overrides: Partial<Parameters<typeof CatalogFieldInputs>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(CatalogFieldInputs, { fields, sections, values, ...overrides }),
  );
}

describe('FR-CAT-002 typed catalog request controls', () => {
  it('renders date and number constraints, help associations, and a labelled multiple-choice group', () => {
    const output = html({ loan: '一時貸出', quantity: 2, extras: ['アダプター'] });
    expect(output).toContain('type="date"');
    expect(output).toContain('min="2026-01-01"');
    expect(output).toContain('max="2030-12-31"');
    expect(output).toContain('type="number"');
    expect(output).toContain('step="any"');
    expect(output).toContain('min="1"');
    expect(output).toContain('max="5"');
    expect(output).toContain('<legend>必要な周辺機器（必須）</legend>');
    expect(output).toContain('name="multiselect:extras"');
    expect(output.match(/name="value:extras"/g)).toHaveLength(2);
    expect(output).toContain('aria-describedby="catalog-field-extras-help"');
    expect(output).toContain('必要なものを複数選べます。');
    const inputs = nodes(
      CatalogFieldInputs({ fields, sections, values: { loan: '一時貸出' } }),
    ).filter((node) => node.props.name === 'value:extras');
    expect(inputs.every((node) => node.props.required !== true)).toBe(true);
  });

  it('keeps native form names out of previews and generates distinct prefixes with valid help/error references', () => {
    const first = html(
      { loan: '一時貸出' },
      {
        idPrefix: 'first',
        namedControls: false,
        errors: [{ field: 'values.extras', message: '1つ以上選んでください。' }],
      },
    );
    const second = html({ loan: '一時貸出' }, { idPrefix: 'second', namedControls: false });
    expect(first).not.toMatch(/\bname="(?:value:|number:|checkbox:|multiselect:)/);
    expect(first).toContain('aria-describedby="first-extras-help first-extras-error"');
    const ids = [...(first + second).matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of first.matchAll(/aria-describedby="([^"]+)"/g))
      for (const id of match[1].split(' ')) expect(first).toContain(`id="${id}"`);
  });

  it('does not render hidden required questions or their form markers', () => {
    const output = html({ loan: '標準貸与', return_date: '2027-01-01' });
    expect(output).not.toContain('name="value:return_date"');
    expect(output).not.toContain('一時貸出の場合に入力します。');
    expect(output).toContain('希望台数');
  });

  it('clears a hidden answer on controller change so that showing it again cannot resurrect it', () => {
    const onChange = vi.fn();
    const initial = { loan: '一時貸出', return_date: '2027-01-01', quantity: '2' };
    const tree = CatalogFieldInputs({ fields, sections, values: initial, onChange });
    (control(tree, 'value:loan').props.onChange as (event: unknown) => void)({
      target: { value: '標準貸与' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ loan: '標準貸与', quantity: '2' });
    const next = onChange.mock.calls[0][0] as CatalogValues;
    const changed = CatalogFieldInputs({ fields, sections, values: next, onChange });
    (control(changed, 'value:loan').props.onChange as (event: unknown) => void)({
      target: { value: '一時貸出' },
    });
    expect(onChange.mock.calls[1][0]).not.toHaveProperty('return_date');
    expect(initial.return_date).toBe('2027-01-01');
  });

  it('updates multiple selections without replacing or duplicating an existing answer', () => {
    const onChange = vi.fn();
    const tree = CatalogFieldInputs({
      fields,
      values: { loan: '標準貸与', extras: ['マウス'] },
      onChange,
    });
    const adapter = nodes(tree).find(
      (node) => node.props.name === 'value:extras' && node.props.value === 'アダプター',
    )!;
    (adapter.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({
      loan: '標準貸与',
      extras: ['マウス', 'アダプター'],
    });
    const mouse = nodes(tree).find(
      (node) => node.props.name === 'value:extras' && node.props.value === 'マウス',
    )!;
    (mouse.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    expect(onChange).toHaveBeenLastCalledWith({ loan: '標準貸与', extras: ['マウス'] });
  });

  it('places unassigned fields first and renders each populated section in definition order', () => {
    const output = html({ loan: '一時貸出' });
    expect(output.indexOf('貸与区分')).toBeLessThan(output.indexOf('<h3'));
    expect(output.indexOf('内容を確認した')).toBeLessThan(output.indexOf('<h3'));
    expect(output).toContain('<h3 id="catalog-field-section-equipment">必要な機器</h3>');
    expect(output).toContain('数量と周辺機器を確認してください。');
    expect(output.indexOf('返却予定日')).toBeLessThan(output.indexOf('希望台数'));
  });
});

describe('catalog form data and local draft recovery', () => {
  it('reads repeated choices, finite numbers, and old checkbox markers together', () => {
    const form = new FormData();
    form.append('value:loan', '一時貸出');
    form.append('number:quantity', '1');
    form.append('value:quantity', '2.5');
    form.append('multiselect:extras', '1');
    form.append('value:extras', 'マウス');
    form.append('value:extras', 'アダプター');
    form.append('checkbox:consent', '1');
    expect(readCatalogFormValues(form)).toEqual({
      loan: '一時貸出',
      quantity: 2.5,
      extras: ['マウス', 'アダプター'],
      consent: false,
    });
    form.append('value:consent', 'true');
    expect(readCatalogFormValues(form).consent).toBe(true);
  });

  it('represents an empty choice group as an empty array and omits an empty numeric answer', () => {
    const form = new FormData();
    form.append('number:quantity', '1');
    form.append('value:quantity', '  ');
    form.append('multiselect:extras', '1');
    expect(readCatalogFormValues(form)).toEqual({ extras: [] });
    expect(catalogInputValues(fields, { quantity: '', extras: [] })).toEqual({ extras: [] });
    expect(catalogInputValues(fields, { quantity: '0' })).toEqual({ quantity: 0 });
  });

  it.each(['NaN', 'Infinity', '1e999', 'invalid', '0x10'])(
    'keeps invalid number input %s for server rejection instead of silently coercing it',
    (raw) => {
      const form = new FormData();
      form.append('number:quantity', '1');
      form.append('value:quantity', raw);
      expect(readCatalogFormValues(form).quantity).toBe(raw);
      expect(catalogInputValues(fields, { quantity: raw }).quantity).toBe(raw);
    },
  );

  it('keeps unsafe marker keys as own data properties for shared validation to reject', () => {
    const form = new FormData();
    form.append('multiselect:__proto__', '1');
    const value = readCatalogFormValues(form);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.__proto__).toEqual([]);
  });

  it('round-trips array and numeric draft values without restoring checkbox consent', () => {
    const values = {
      loan: '一時貸出',
      return_date: '2028-02-29',
      quantity: '2.5',
      extras: ['マウス', 'アダプター'],
      consent: true,
    };
    const draft = catalogDraftValues(fields, values);
    expect(draft).not.toHaveProperty('value:consent');
    expect(restoreCatalogDraftValues(fields, draft)).toEqual({ ...values, consent: false });
  });

  it('filters removed choices and malformed saved dates, numbers and arrays during restoration', () => {
    expect(
      restoreCatalogDraftValues(fields, {
        'value:loan': '一時貸出',
        'value:return_date': '2027-02-29',
        'value:quantity': 'Infinity',
        'value:extras': '["マウス","古い候補","マウス"]',
        'value:consent': 'true',
      }),
    ).toEqual({
      loan: '一時貸出',
      return_date: '',
      quantity: '',
      extras: ['マウス'],
      consent: false,
    });
    expect(restoreCatalogDraftValues(fields, { 'value:extras': 'not JSON' }).extras).toEqual([]);
  });

  it('prunes a chain of conditional answers independently of field order', () => {
    const nested: CatalogField[] = [
      {
        key: 'notes',
        label: '説明',
        type: 'text',
        required: true,
        maxLength: 20,
        visibleWhen: { field: 'consent', equals: true },
      },
      {
        key: 'consent',
        label: '確認',
        type: 'checkbox',
        required: false,
        visibleWhen: { field: 'loan', equals: '一時貸出' },
      },
      fields[0],
    ];
    expect(
      visibleCatalogValues(nested, { loan: '標準貸与', consent: true, notes: 'old', unknown: 'x' }),
    ).toEqual({ loan: '標準貸与' });
  });
});

describe('FR-CAT-003 frozen request display', () => {
  it('shows date, numeric and multiple answers under their frozen section and omits hidden values', () => {
    const original = {
      loan: '一時貸出',
      return_date: '2028-02-29',
      quantity: 2.5,
      extras: ['マウス', 'アダプター'],
      consent: true,
    };
    const before = JSON.stringify({ fields, original });
    const output = renderToStaticMarkup(
      createElement(CatalogValueSummary, { fields, sections, values: original }),
    );
    expect(output).toContain('必要な機器');
    expect(output).toContain('2028-02-29');
    expect(output).toContain('2.5');
    expect(output).toContain('<li>マウス</li><li>アダプター</li>');
    expect(output).toContain('一時貸出の場合に入力します。');
    const hidden = renderToStaticMarkup(
      createElement(CatalogValueSummary, {
        fields,
        sections,
        values: { ...original, loan: '標準貸与' },
      }),
    );
    expect(hidden).not.toContain('2028-02-29');
    expect(JSON.stringify({ fields, original })).toBe(before);
  });
});

describe('typed request action payload', () => {
  it('sends typed answers through both new submission and edit paths', async () => {
    api.submitRequest.mockResolvedValue({ ok: true, data: { id: 'synthetic-request' } });
    api.editRequest.mockResolvedValue({ ok: true, data: { id: 'synthetic-request' } });
    const form = new FormData();
    for (const [key, value] of Object.entries({
      reason: '合成の検証',
      durationDays: '30',
      approverId: 'synthetic-approver',
      itemId: 'synthetic-item',
      itemVersion: '2',
      idempotencyKey: 'synthetic-intent',
      expectedVersion: '3',
    }))
      form.append(key, value);
    form.append('number:quantity', '1');
    form.append('value:quantity', '2.5');
    form.append('multiselect:extras', '1');
    form.append('value:extras', 'マウス');
    form.append('value:extras', 'アダプター');
    form.append('value:return_date', '2028-02-29');
    await saveServiceRequest(null, { message: '' }, form);
    expect(api.submitRequest.mock.calls[0][0]).toMatchObject({
      itemVersion: 2,
      values: { quantity: 2.5, extras: ['マウス', 'アダプター'], return_date: '2028-02-29' },
    });
    await saveServiceRequest('synthetic-request', { message: '' }, form);
    expect(api.editRequest.mock.calls[0][1]).toMatchObject({
      expectedVersion: 3,
      values: { quantity: 2.5, extras: ['マウス', 'アダプター'], return_date: '2028-02-29' },
    });
  });
});
