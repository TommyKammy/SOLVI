import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogField, CatalogSection } from '@solvi/shared/catalog';
import {
  appendCatalogQuestionSet,
  cloneCatalogContent,
  type CatalogInitialContent,
} from '../../apps/web/src/lib/catalog-reuse';
import { CatalogChecklistForm } from '../../apps/web/src/components/CatalogChecklistForm';
import { updateCatalogChecklist } from '../../apps/web/src/app/requests/actions';
import type { CatalogFulfillment } from '../../apps/web/src/lib/api';

const state = vi.hoisted(() => ({
  update: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
  feedback: { message: '' } as { message: string; success?: string },
  pending: false,
}));
vi.mock('react', async (importActual) => ({
  ...(await importActual<typeof import('react')>()),
  useActionState: () => [state.feedback, vi.fn(), state.pending],
}));
vi.mock('../../apps/web/src/lib/api', () => ({ api: { updateRequestChecklist: state.update } }));
vi.mock('../../apps/web/src/lib/form-scope', () => ({ formScopeError: async () => undefined }));
vi.mock('next/navigation', () => ({ redirect: state.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: state.revalidate }));
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  state.feedback = { message: '' };
  state.pending = false;
});
afterEach(() => vi.unstubAllGlobals());

const owner = '11111111-1111-4111-8111-111111111111';
const viewer = '22222222-2222-4222-8222-222222222222';
const group = '33333333-3333-4333-8333-333333333333';
const sourceFields: CatalogField[] = [
  {
    key: 'loan',
    label: '貸与区分',
    type: 'select',
    required: true,
    options: ['標準貸与', '一時貸出'],
    section: 'equipment',
    helpText: '貸出方法を選びます。',
  },
  {
    key: 'return_date',
    label: '返却予定日',
    type: 'date',
    required: true,
    visibleWhen: { field: 'loan', equals: '一時貸出' },
    section: 'equipment',
  },
];
const sourceSections: CatalogSection[] = [
  { key: 'equipment', title: '機器の利用', description: '必要な情報を入力します。' },
];
const content = (): CatalogInitialContent => ({
  title: 'PC貸与',
  description: '合成情報で申請します。',
  definition: {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: 'PC貸与の検証',
    allowedDurations: [30],
    maxReasonLength: 100,
    fields: structuredClone(sourceFields),
    sections: structuredClone(sourceSections),
    category: '機器・備品',
    ownerId: owner,
    fulfillmentGroupId: group,
    checklist: [{ key: 'prepare', label: '機器を準備する', required: true }],
  },
});

describe('catalog clone and shared set copy', () => {
  it('deep copies all version content, assigns the new creator, and carries no publication identity', () => {
    const source = content();
    const original = JSON.stringify(source);
    const copied = cloneCatalogContent(
      { ...source, code: 'original-code', active: true } as CatalogInitialContent,
      viewer,
    );
    expect(copied.definition.ownerId).toBe(viewer);
    expect(copied.definition.fulfillmentGroupId).toBe(group);
    expect(copied.definition.checklist).toEqual(source.definition.checklist);
    expect(copied).not.toHaveProperty('code');
    expect(copied).not.toHaveProperty('active');
    const first = copied.definition.fields![0];
    if (first.type === 'select') first.options.push('copy only');
    copied.definition.sections![0].title = 'copy title';
    copied.definition.checklist![0].label = 'copy check';
    expect(JSON.stringify(source)).toBe(original);
  });

  it('does not keep the original owner when the creator is unavailable', () => {
    expect(cloneCatalogContent(content(), '').definition).not.toHaveProperty('ownerId');
  });

  it('remaps every question, section and condition reference while preserving current content', () => {
    let sequence = 0;
    const existing = {
      fields: [
        {
          key: 'field_1',
          label: '現在の質問',
          type: 'text',
          required: false,
          maxLength: 30,
        } as CatalogField,
      ],
      sections: [] as CatalogSection[],
    };
    const source = {
      fields: structuredClone(sourceFields),
      sections: structuredClone(sourceSections),
    };
    const original = JSON.stringify({ existing, source });
    const result = appendCatalogQuestionSet(existing, source, (kind) => `${kind}_${++sequence}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [current, first, dependent] = result.fields;
    expect(current).toEqual(existing.fields[0]);
    expect(first.key).not.toBe(source.fields[0].key);
    expect(first.key).not.toBe(current.key);
    expect(first.section).toBe(result.sections[0].key);
    expect(dependent.visibleWhen?.field).toBe(first.key);
    expect(dependent.visibleWhen?.equals).toBe('一時貸出');
    expect(dependent.section).toBe(first.section);
    expect(first.helpText).toBe('貸出方法を選びます。');
    result.sections[0].title = 'changed';
    if (first.type === 'select') first.options.push('copy only');
    expect(JSON.stringify({ existing, source })).toBe(original);
  });

  it('supports inserting the same set twice without cross-linking or sharing mutable definitions', () => {
    let sequence = 0;
    const makeKey = (kind: string) => `${kind}_${++sequence}`;
    const source = { fields: sourceFields, sections: sourceSections };
    const first = appendCatalogQuestionSet({ fields: [], sections: [] }, source, makeKey);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendCatalogQuestionSet(first, source, makeKey);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(new Set(second.fields.map((field) => field.key)).size).toBe(4);
    expect(second.fields[1].visibleWhen?.field).toBe(second.fields[0].key);
    expect(second.fields[3].visibleWhen?.field).toBe(second.fields[2].key);
    expect(second.fields[0].section).not.toBe(second.fields[2].section);
    expect(second.sections).toHaveLength(2);
  });

  it('preserves the editor and source when the question limit would be exceeded', () => {
    const current = {
      fields: Array.from({ length: 9 }, (_, index) => ({
        key: `q_${index}`,
        label: `質問${index}`,
        type: 'text' as const,
        required: false,
        maxLength: 20,
      })),
      sections: [],
    };
    const before = JSON.stringify(current);
    const createKey = vi.fn(() => 'unused');
    const result = appendCatalogQuestionSet(
      current,
      { fields: sourceFields, sections: sourceSections },
      createKey,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('あと1件');
    expect(createKey).not.toHaveBeenCalled();
    expect(JSON.stringify(current)).toBe(before);
  });

  it('preserves the editor when the section limit would be exceeded', () => {
    const current = {
      fields: [],
      sections: Array.from({ length: 10 }, (_, index) => ({
        key: `section_${index}`,
        title: `区分${index}`,
      })),
    };
    const before = JSON.stringify(current);
    expect(
      appendCatalogQuestionSet(current, { fields: sourceFields, sections: sourceSections }).ok,
    ).toBe(false);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('refuses dangling references instead of rebinding to similarly named existing questions', () => {
    const current = { fields: [sourceFields[0]], sections: sourceSections };
    expect(
      appendCatalogQuestionSet(current, { fields: [sourceFields[1]], sections: sourceSections }).ok,
    ).toBe(false);
    expect(
      appendCatalogQuestionSet(
        { fields: [], sections: [] },
        { fields: [sourceFields[0]], sections: [] },
      ).ok,
    ).toBe(false);
  });

  it('fails without changing data when key allocation cannot avoid a collision', () => {
    const current = {
      fields: [{ key: 'existing', label: '既存', type: 'checkbox' as const, required: false }],
      sections: [],
    };
    const before = JSON.stringify(current);
    expect(
      appendCatalogQuestionSet(
        current,
        { fields: [{ key: 'new', label: '新規', type: 'checkbox', required: false }] },
        () => 'existing',
      ).ok,
    ).toBe(false);
    expect(JSON.stringify(current)).toBe(before);
  });
});

describe('catalog checklist presentation and independent progress action', () => {
  const fulfillment = (canUpdate: boolean): CatalogFulfillment => ({
    ownerName: 'サービス責任者',
    groupName: '機器管理チーム',
    checklistVersion: 7,
    canUpdate,
    checks: [
      { key: 'prepare', label: '機器を準備する', required: true, completed: false },
      { key: 'notify', label: '受付を案内する', required: false, completed: true },
    ],
  });
  const html = (value: CatalogFulfillment) =>
    renderToStaticMarkup(
      createElement(CatalogChecklistForm, {
        requestId: 'synthetic-request',
        requestRevision: 3,
        fulfillment: value,
      }),
    );

  it('shows the assigned names and frozen checklist without editing controls for a readonly viewer', () => {
    const output = html(fulfillment(false));
    expect(output).toContain('サービス責任者');
    expect(output).toContain('機器管理チーム');
    expect(output).toContain('機器を準備する');
    expect(output).toContain('必須作業の完了 0 / 1件');
    expect(output).not.toContain('<form');
    expect(output).not.toContain('<button');
  });

  it('renders independent version data and explicit completion buttons only when permitted', () => {
    const output = html(fulfillment(true));
    expect(output).toContain('name="expectedVersion" value="7"');
    expect(output).toMatch(/<button\b(?=[^>]*name="key")(?=[^>]*value="prepare")/);
    expect(output).toContain('name="completed:prepare" value="true"');
    expect(output).toContain('name="completed:notify" value="false"');
    expect(output).toContain('aria-label="「機器を準備する」を完了にする"');
    expect(output).not.toContain('name="requestVersion"');
  });

  it('keeps responsibility visible without adding an empty checklist form', () => {
    const output = html({ ...fulfillment(true), checks: [] });
    expect(output).toContain('機器管理チーム');
    expect(output).not.toContain('<form');
    expect(
      renderToStaticMarkup(
        createElement(CatalogChecklistForm, { requestId: 'x', requestRevision: 1 }),
      ),
    ).toBe('');
  });

  it('disables every progress button while a save is pending and renders success separately from errors', () => {
    state.pending = true;
    const output = html(fulfillment(true));
    expect(output.match(/disabled=""/g)).toHaveLength(2);
    expect(output).toContain('作業チェックを保存しています');
    state.pending = false;
    state.feedback = { message: '', success: '作業チェックを更新しました。' };
    const saved = html(fulfillment(true));
    expect(saved).toContain('作業チェックを更新しました。');
    expect(saved).not.toContain('保存・送信できませんでした');
  });

  it('updates only checklist progress, revalidates the request page, and never redirects', async () => {
    state.update.mockResolvedValue({
      ok: true,
      data: { id: 'synthetic-request', checklistVersion: 8 },
    });
    const form = new FormData();
    form.set('expectedVersion', '7');
    form.set('key', 'prepare');
    form.set('completed:prepare', 'true');
    const result = await updateCatalogChecklist('synthetic-request', 3, { message: '' }, form);
    expect(state.update).toHaveBeenCalledWith('synthetic-request', {
      requestRevision: 3,
      expectedVersion: 7,
      key: 'prepare',
      completed: true,
    });
    expect(state.revalidate).toHaveBeenCalledExactlyOnceWith('/requests/synthetic-request');
    expect(state.redirect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ message: '', success: '作業チェックを更新しました。' });
  });

  it('keeps API conflicts visible without treating an uncertain update as success', async () => {
    state.update.mockResolvedValue({
      ok: false,
      problem: { title: '作業が更新されています。再読込してください。', status: 409 },
    });
    const form = new FormData();
    form.set('expectedVersion', '6');
    form.set('key', 'prepare');
    form.set('completed', 'false');
    const result = await updateCatalogChecklist(
      'synthetic-request',
      3,
      { message: '', attempt: 2 },
      form,
    );
    expect(result.message).toContain('更新されています');
    expect(result.attempt).toBe(3);
    expect(result.success).toBeUndefined();
    expect(state.revalidate).not.toHaveBeenCalled();
  });

  it('does not send malformed local operations to the API', async () => {
    const form = new FormData();
    form.set('key', 'prepare');
    form.set('completed', 'yes');
    expect(
      (await updateCatalogChecklist('synthetic-request', 3, { message: '' }, form)).message,
    ).toContain('選び直して');
    expect(state.update).not.toHaveBeenCalled();
  });
});
