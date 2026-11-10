// NFR-UX-002, NFR-UX-003, NFR-UX-004. Actual AssetForm JSX/handlers; native dispatch has separate evidence.
import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetOptions, AssetView } from '../../apps/web/src/lib/api';
import type { FormFeedback } from '../../apps/web/src/lib/form-state';

const hooks = vi.hoisted(() => ({
  values: null as Record<string, string> | null,
  pending: false,
  feedback: { message: '' } as FormFeedback,
  setter: vi.fn(),
  save: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: Record<string, string>) => {
    hooks.values ??= initial;
    return [
      hooks.values,
      (next: (current: Record<string, string>) => Record<string, string>) => {
        hooks.setter(next);
        hooks.values = next(hooks.values!);
      },
    ];
  },
  useActionState: () => [hooks.feedback, vi.fn(), hooks.pending],
}));
vi.mock('../../apps/web/src/app/assets/actions', () => ({ saveAsset: hooks.save }));
vi.mock('../../apps/web/src/components/FeedbackForm', () => ({
  FeedbackForm: ({ children }: { children: ReactNode }) =>
    React.createElement('form', null, children),
  FormField: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));
import { AssetForm } from '../../apps/web/src/components/AssetForm';

const keys = [
  'assetTag',
  'name',
  'kind',
  'state',
  'model',
  'serialNumber',
  'hostname',
  'vendor',
  'assignedUserId',
  'location',
  'internalNotes',
  'reason',
] as const;
const options: AssetOptions = {
  kinds: [
    { code: 'pc', label: 'PC', requiredFields: ['model', 'serialNumber', 'hostname'] },
    { code: 'server', label: 'サーバー', requiredFields: ['model', 'serialNumber', 'hostname'] },
    { code: 'vm', label: '仮想マシン', requiredFields: ['hostname', 'vendor'] },
    {
      code: 'network',
      label: 'ネットワーク機器',
      requiredFields: ['model', 'serialNumber', 'hostname'],
    },
    { code: 'mobile', label: 'モバイル端末', requiredFields: ['model', 'serialNumber'] },
    { code: 'saas', label: 'SaaS', requiredFields: ['model', 'vendor'] },
  ],
  states: [
    { code: 'stocked', label: '在庫' },
    { code: 'in_use', label: '使用中' },
    { code: 'repair', label: '修理中' },
    { code: 'retired', label: '廃止' },
  ],
  fields: [
    { key: 'model', label: 'モデル・サービス名' },
    { key: 'serialNumber', label: 'シリアル番号' },
    { key: 'hostname', label: 'ホスト名' },
    { key: 'vendor', label: 'メーカー・提供元' },
  ],
  members: [{ id: '08800000-0000-4000-8000-000000000002', name: '合成担当者' }],
};
const asset: AssetView = {
  id: '08800000-0000-4000-8000-000000000010',
  assetTag: 'SYN-088',
  name: '合成資産',
  kind: 'pc',
  state: 'in_use',
  version: 17,
  model: '合成モデル',
  serialNumber: 'SYN-SERIAL-088',
  hostname: 'syn-host-088',
  vendor: '合成ベンダー',
  assignedUserId: options.members[0].id,
  assignedUserName: options.members[0].name,
  sourceKind: 'manual',
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
  location: '合成場所',
  internalNotes: '合成メモ\n二行目',
};
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render(current?: AssetView) {
  return nodes(AssetForm({ options, asset: current }));
}
function input(all: ReturnType<typeof render>, name: string) {
  const node = all.find(
    (n) =>
      ['input', 'select', 'textarea'].includes(String(n.type)) &&
      n.props.name === name &&
      n.props.type !== 'hidden',
  );
  expect(node, name).toBeDefined();
  return node!;
}
function change(all: ReturnType<typeof render>, key: string, value: string) {
  (input(all, key).props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  hooks.values = null;
  hooks.pending = false;
  hooks.feedback = { message: '' };
  hooks.setter.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('AssetForm pending input protection', () => {
  it.each(keys)('pending %s handler cannot mutate captured values', (key) => {
    hooks.pending = true;
    const all = render(asset);
    const original = { ...hooks.values };
    change(all, key, key === 'state' ? 'retired' : '変更しない');
    expect(hooks.setter).not.toHaveBeenCalled();
    expect(hooks.values).toEqual(original);
  });

  it.each(keys)('normal %s handler still changes its value', (key) => {
    const all = render(asset);
    const value = key === 'state' ? 'repair' : '変更した値';
    change(all, key, value);
    expect(hooks.setter).toHaveBeenCalledTimes(1);
    expect(hooks.values![key]).toBe(value);
  });

  it.each(['stocked', 'retired'])('normal state %s clears assignment', (state) => {
    change(render(asset), 'state', state);
    expect(hooks.values!.assignedUserId).toBe('');
    expect(hooks.values!.state).toBe(state);
    const all = render(asset);
    expect(input(all, 'assignedUserId').props.disabled).toBe(true);
    expect(
      all.find((n) => n.props.name === 'assignedUserId' && n.props.type === 'hidden')?.props.value,
    ).toBe('');
  });

  it.each(['in_use', 'repair'])('normal state %s retains assignment', (state) => {
    change(render(asset), 'state', state);
    expect(hooks.values!.assignedUserId).toBe(asset.assignedUserId);
    expect(input(render(asset), 'assignedUserId').props.disabled).toBe(false);
  });

  it.each([undefined, asset])('pending disables all 12 visible controls and submit', (current) => {
    hooks.pending = true;
    const all = render(current);
    for (const key of keys) expect(input(all, key).props.disabled, key).toBe(true);
    expect(all.find((n) => n.type === 'button')?.props.disabled).toBe(true);
    expect(all.find((n) => n.type === 'button')?.props.children).toBe('保存しています…');
    expect(all.find((n) => n.props.name === 'expectedVersion')?.props.value).toBe(
      current?.version ?? 1,
    );
  });

  it('normal create keeps kind editable and stocked assignment disabled', () => {
    const all = render();
    expect(input(all, 'kind').props.disabled).toBe(false);
    expect(input(all, 'assignedUserId').props.disabled).toBe(true);
    expect(input(all, 'state').props.disabled).toBe(false);
  });

  it('normal edit keeps kind fixed and its hidden value', () => {
    const all = render(asset);
    expect(input(all, 'kind').props.disabled).toBe(true);
    expect(all.find((n) => n.props.name === 'kind' && n.props.type === 'hidden')?.props.value).toBe(
      'pc',
    );
    expect(all.find((n) => n.props.name === 'expectedVersion')?.props.value).toBe(17);
  });

  it('retired edit exposes only the terminal state and no assignment', () => {
    const all = render({ ...asset, state: 'retired', assignedUserId: null });
    expect(
      nodes(input(all, 'state').props.children as ReactNode)
        .filter((n) => n.type === 'option')
        .map((n) => n.props.value),
    ).toEqual(['retired']);
    expect(input(all, 'assignedUserId').props.disabled).toBe(true);
  });

  it('required fields and Japanese labels keep their existing constraints', () => {
    const all = render();
    for (const key of ['assetTag', 'name', 'model', 'serialNumber', 'hostname', 'reason'])
      expect(input(all, key).props.required, key).toBe(true);
    expect(input(all, 'internalNotes').props.maxLength).toBe(4000);
    expect(input(all, 'reason').props.maxLength).toBe(1000);
    expect(all.some((n) => n.type === 'label' && n.props.htmlFor === 'asset-reason')).toBe(true);
  });

  it.each([400, 409, 503])(
    'failure %s releases pending without resetting entered values or edit version',
    (status) => {
      const all = render(asset);
      change(all, 'name', '変更した合成資産');
      change(render(asset), 'internalNotes', '入力を保持\n二行目');
      const original = { ...hooks.values };
      hooks.pending = true;
      render(asset);
      hooks.pending = false;
      hooks.feedback = { message: `合成失敗${status}`, values: original, attempt: 1 };
      const released = render(asset);
      expect(hooks.values).toEqual(original);
      for (const key of keys.filter((k) => k !== 'kind'))
        expect(input(released, key).props.disabled, key).toBe(false);
      expect(input(released, 'kind').props.disabled).toBe(true);
      expect(released.find((n) => n.props.name === 'expectedVersion')?.props.value).toBe(17);
    },
  );
});
