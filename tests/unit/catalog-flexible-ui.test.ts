// WP-P2-UIX-042: public controls, draft recovery and real server-action payloads.
import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem } from '../../apps/web/src/lib/api';
import type { DraftValues } from '../../apps/web/src/lib/form-draft';
import type { CatalogField, CatalogValues } from '@solvi/shared/catalog';
import { CatalogFieldInputs } from '../../apps/web/src/components/CatalogFieldInputs';

type Recovery = {
  baseline: DraftValues;
  values: DraftValues;
  labels: Record<string, string>;
  onRestore: (values: DraftValues) => void;
};
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  recovery: null as Recovery | null,
  submit: vi.fn(),
  edit: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;
      },
    ];
  },
  useEffect: () => undefined,
  useActionState: (_action: unknown, initial: unknown) => [initial, vi.fn(), false],
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { submitRequest: hooks.submit, editRequest: hooks.edit },
}));
vi.mock('../../apps/web/src/lib/form-scope', () => ({ formScopeError: async () => undefined }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../apps/web/src/components/FeedbackForm', () => ({
  FeedbackForm: ({ children }: { children: ReactNode }) =>
    React.createElement('form', null, children),
  FormField: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));
vi.mock('../../apps/web/src/components/FormDraftRecovery', () => ({
  FormDraftRecovery: (props: Recovery) => {
    hooks.recovery = props;
    return null;
  },
}));
import { RequestForm } from '../../apps/web/src/components/RequestForms';
import { saveServiceRequest } from '../../apps/web/src/app/requests/actions';

const item: CatalogItem = {
  id: '04200000-0000-4000-8000-000000000001',
  version: 1,
  title: '合成機器申請',
  description: '機器を選んでください。',
  definition: {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成対象',
    allowedDurations: [7, 30],
    maxReasonLength: 100,
    approval: { mode: 'fixed', approverId: '04200000-0000-4000-8000-000000000002' },
    fields: [],
  },
};
const render = (current = item) => {
  hooks.cursor = 0;
  return renderToStaticMarkup(
    React.createElement(RequestForm, {
      item: current,
      approvers: [{ id: current.definition.approval!.approverId, name: '合成承認者' }],
      scope: 'synthetic:synthetic',
    }),
  );
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  hooks.values = [];
  hooks.cursor = 0;
  hooks.recovery = null;
  hooks.submit.mockReset().mockResolvedValue({ ok: true, data: { id: item.id } });
  hooks.edit.mockReset().mockResolvedValue({ ok: true, data: { id: item.id } });
});
afterEach(() => vi.unstubAllGlobals());

describe('flexible public catalog form', () => {
  it('clears a membership branch and its descendant when an item is unchecked', () => {
    const fields: CatalogField[] = [
      {
        key: 'items',
        label: '必要なアイテム',
        type: 'multiselect',
        required: true,
        options: ['PC', 'モニター'],
      },
      {
        key: 'pc_kind',
        label: 'PCの利用区分',
        type: 'select',
        required: true,
        options: ['貸出', '購入'],
        visibleWhen: { field: 'items', contains: 'PC' },
      },
      {
        key: 'return_date',
        label: '返却予定日',
        type: 'date',
        required: true,
        visibleWhen: { field: 'pc_kind', equals: '貸出' },
      },
    ];
    type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
    const nodes = (value: unknown): Node[] => {
      if (Array.isArray(value)) return value.flatMap(nodes);
      if (!value || typeof value !== 'object' || !('props' in value)) return [];
      const node = value as Node;
      return [node, ...nodes(node.props.children)];
    };
    const onChange = vi.fn();
    const values: CatalogValues = {
      items: ['PC', 'モニター'],
      pc_kind: '貸出',
      return_date: '2027-01-01',
    };
    const tree = CatalogFieldInputs({ fields, values, onChange });
    const checkbox = nodes(tree).find(
      (node) => node.props.name === 'value:items' && node.props.value === 'PC',
    )!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    expect(onChange).toHaveBeenLastCalledWith({ items: ['モニター'] });
    const hidden = onChange.mock.calls[0]![0] as CatalogValues;
    const html = renderToStaticMarkup(
      React.createElement(CatalogFieldInputs, { fields, values: hidden }),
    );
    expect(html).not.toContain('name="value:pc_kind"');
    expect(html).not.toContain('name="value:return_date"');
    const next = CatalogFieldInputs({ fields, values: hidden, onChange });
    const restored = nodes(next).find(
      (node) => node.props.name === 'value:items' && node.props.value === 'PC',
    )!;
    (restored.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    expect(onChange.mock.calls[1]![0]).toEqual({ items: ['モニター', 'PC'] });
    expect(values.return_date).toBe('2027-01-01');
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'renders and recovers only enabled common fields: reason=%s duration=%s',
    (reason, duration) => {
      const current = {
        ...item,
        definition: { ...item.definition, requestFields: { reason, duration } },
      };
      const html = render(current);
      expect(html.includes('name="reason"')).toBe(reason);
      expect(html.includes('name="durationDays"')).toBe(duration);
      expect(Object.hasOwn(hooks.recovery!.values, 'reason')).toBe(reason);
      expect(Object.hasOwn(hooks.recovery!.values, 'durationDays')).toBe(duration);
      expect(Object.hasOwn(hooks.recovery!.baseline, 'reason')).toBe(reason);
      expect(Object.hasOwn(hooks.recovery!.labels, 'durationDays')).toBe(duration);
      hooks.recovery!.onRestore({ reason: '復元する理由', durationDays: '30' });
      const restored = render(current);
      expect(restored.includes('復元する理由')).toBe(reason);
      expect(hooks.recovery!.values).toEqual({
        ...(reason ? { reason: '復元する理由' } : {}),
        ...(duration ? { durationDays: '30' } : {}),
      });
    },
  );

  it('retains legacy required controls when no requestFields property is present', () => {
    const html = render();
    expect(html).toMatch(/name="reason"[^>]*required=""/);
    expect(html).toContain('name="durationDays"');
    expect(hooks.recovery!.baseline).toEqual({ reason: '', durationDays: '7' });
  });

  it('ignores stale local recovery values for both disabled common fields', () => {
    const current = {
      ...item,
      definition: { ...item.definition, requestFields: { reason: false, duration: false } },
    };
    render(current);
    hooks.recovery!.onRestore({ reason: '古い非表示の理由', durationDays: '30' });
    render(current);
    expect(hooks.recovery!.values).toEqual({});
    const html = render(item);
    expect(html).not.toContain('古い非表示の理由');
    expect(hooks.recovery!.values).toEqual({ reason: '', durationDays: '7' });
  });
});

describe('optional common fields in request server actions', () => {
  it.each([null, item.id])(
    'omits missing reason and duration in create/edit action %s',
    async (id) => {
      const form = new FormData();
      form.set('itemId', item.id);
      form.set('itemVersion', '1');
      form.set('expectedVersion', '2');
      form.set('approverId', item.definition.approval!.approverId);
      form.set('idempotencyKey', item.id);
      await saveServiceRequest(id, { message: '' }, form);
      const payload = id ? hooks.edit.mock.calls[0]![1] : hooks.submit.mock.calls[0]![0];
      expect(payload).not.toHaveProperty('reason');
      expect(payload).not.toHaveProperty('durationDays');
      expect(payload.values).toEqual({});
    },
  );

  it('sends an enabled empty reason for server rejection and preserves the chosen duration', async () => {
    const form = new FormData();
    form.set('reason', '');
    form.set('durationDays', '7');
    form.set('approverId', item.definition.approval!.approverId);
    await saveServiceRequest(null, { message: '' }, form);
    expect(hooks.submit.mock.calls[0]![0]).toMatchObject({ reason: '', durationDays: 7 });
  });
});
