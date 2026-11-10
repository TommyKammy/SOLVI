// NFR-UX-002, NFR-UX-003, NFR-UX-004: edit read recovery and preserved form boundary.
// Unit form probe only; the isolated Next harness separately inspects the real form.
import React, { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type ChangeDetail,
  type ChangeOptions,
} from '../../apps/web/src/lib/api';
import { ChangePlanForm } from '../../apps/web/src/components/ChangeForms';
import { notFound } from 'next/navigation';
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    changeDetail: vi.fn(),
    changeFormOptions: vi.fn(),
    change: vi.fn(),
    changeOptions: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/ChangeForms', () => ({
  ChangePlanForm: vi.fn(() => createElement('form', { 'data-plan-probe': true })),
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: Page } = await vi.importActual<{
  default: (p: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/changes/[id]/edit/page');
const id = '07600000-0000-4000-8000-000000000006';
const ticketId = '07600000-0000-4000-8000-000000000010';
const assetId = '07600000-0000-4000-8000-000000000020';
const userId = '07600000-0000-4000-8000-000000000002';
const org = '07600000-0000-4000-8000-000000000001';
const current = {
  id,
  number: 'CHG-076',
  state: 'draft',
  version: 7,
  ticket: { id: ticketId, number: 'TKT-076', subject: '合成チケット' },
  assets: [
    {
      id: assetId,
      assetTag: 'AST-076',
      name: '合成資産',
      kind: 'server',
      state: 'active',
      version: 3,
    },
  ],
  snapshot: { title: '合成の変更計画' },
  createdBy: userId,
} as unknown as ChangeDetail['change'];
const options: ChangeOptions = {
  owners: [{ id: userId, name: '合成担当者' }],
  approvers: [{ id: '07600000-0000-4000-8000-000000000003', name: '合成承認者' }],
  assets: current.assets,
  tickets: [current.ticket],
};
const dto = (state = 'draft', actions = ['edit', 'cancel']) =>
  ({ change: { ...current, state }, availableActions: actions }) as unknown as ChangeDetail;
const render = async (query: Query = {}, value = id) =>
  renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ id: value }),
      searchParams: Promise.resolve(query),
    }),
  );
const fail = (target: 'main' | 'options', status: number) => {
  vi.mocked(target === 'main' ? api.changeDetail : api.changeFormOptions).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_PROBLEM_TITLE', detail: 'PRIVATE_PROBLEM_BODY' },
  });
};
const anchors = (html: string) =>
  [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({
    href: m[1].replaceAll('&amp;', '&'),
    label: m[2],
  }));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { React });
  vi.mocked(requireSession).mockResolvedValue({
    userId,
    organizationId: org,
    roles: [{ roleCode: 'agent', organizationId: org }],
  });
  vi.mocked(api.changeDetail).mockResolvedValue({ ok: true, data: dto() });
  vi.mocked(api.changeFormOptions).mockResolvedValue({ ok: true, data: options });
});
describe('edit retrieval boundaries', () => {
  it('requires session first and reads neither resource on refusal', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('NO_SESSION'));
    await expect(render()).rejects.toThrow('NO_SESSION');
    expect(api.changeDetail).not.toHaveBeenCalled();
    expect(api.changeFormOptions).not.toHaveBeenCalled();
  });
  it('reads primary then DTO-derived candidates only, ignoring user seeds', async () => {
    await render({ ticketId: 'PRIVATE', assetIds: 'PRIVATE' });
    expect(api.changeDetail).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.changeFormOptions).toHaveBeenCalledExactlyOnceWith(
      new URLSearchParams({ ticketId, assetIds: assetId }).toString(),
    );
    expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.changeDetail).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(api.changeDetail).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.changeFormOptions).mock.invocationCallOrder[0],
    );
    expect(api.change).not.toHaveBeenCalled();
    expect(api.changeOptions).not.toHaveBeenCalled();
  });
  it('preserves selected asset order in the query', async () => {
    const other = { ...current.assets[0], id: '07600000-0000-4000-8000-000000000021' };
    vi.mocked(api.changeDetail).mockResolvedValue({
      ok: true,
      data: { ...dto(), change: { ...current, assets: [other, current.assets[0]] } },
    });
    await render();
    expect(api.changeFormOptions).toHaveBeenCalledExactlyOnceWith(
      new URLSearchParams({ ticketId, assetIds: other.id + ',' + assetId }).toString(),
    );
  });
  it.each([400, 401, 403, 404, 409, 429, 600])(
    'keeps primary %i notFound and no options',
    async (status) => {
      fail('main', status);
      await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalledOnce();
      expect(api.changeFormOptions).not.toHaveBeenCalled();
    },
  );
  it.each([500, 502, 503, 504, 599])('recovers primary %i without DTO or form', async (status) => {
    fail('main', status);
    const html = await render();
    expect(html).toContain('変更計画を読み込めませんでした');
    expect(html).toContain(
      '変更計画を取得できませんでした。時間をおいて、もう一度お試しください。',
    );
    expect(html).toContain('role="alert"');
    for (const value of ['PRIVATE_', 'CHG-076', 'TKT-076', 'AST-076', '<form'])
      expect(html).not.toContain(value);
    expect(api.changeFormOptions).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
  it.each(['auditor', 'named-approver', 'non-owner', 'completed', 'in_progress', 'cancelled'])(
    'keeps non-edit %s notFound before options',
    async () => {
      vi.mocked(api.changeDetail).mockResolvedValue({ ok: true, data: dto('completed', []) });
      await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
      expect(api.changeFormOptions).not.toHaveBeenCalled();
    },
  );
  it.each([400, 401, 403, 404, 500, 502, 503, 504])(
    'shows options %i failure without notFound or DTO',
    async (status) => {
      fail('options', status);
      const html = await render();
      expect(html).toContain('入力候補を読み込めませんでした');
      expect(html).toContain('role="alert"');
      const message =
        status === 400
          ? '変更計画や変更一覧から開き直してください。'
          : status === 401
            ? 'ログインし直してから、もう一度お試しください。'
            : status === 403
              ? '操作中の組織と編集権限を確認してください。'
              : status === 404
                ? '対象の現在の内容を変更計画で確認してください。'
                : '時間をおいて、もう一度お試しください。';
      expect(html).toContain(message);
      for (const value of ['PRIVATE_', 'CHG-076', 'TKT-076', 'AST-076', '<form'])
        expect(html).not.toContain(value);
      expect(notFound).not.toHaveBeenCalled();
    },
  );
});
describe('retry and preserved success', () => {
  const from = '/changes?' + new URLSearchParams({ q: '合成', state: 'review', page: '2' });
  it.each(['main', 'options'] as const)(
    'uses native same-edit GET with one safe returnTo for %s',
    async (target) => {
      fail(target, 503);
      const links = anchors(
        await render({ returnTo: from, saved: 'true', ticketId, unknown: 'PRIVATE' }),
      );
      expect(links).toEqual([
        {
          href: '/changes/' + id + '/edit?' + new URLSearchParams({ returnTo: from }),
          label: '再取得する',
        },
        { href: from, label: '元の画面へ戻る' },
        { href: '/changes', label: '変更一覧へ戻る' },
        { href: '/portal', label: 'ポータルへ戻る' },
      ]);
    },
  );
  it.each([
    undefined,
    '//evil.example',
    'https://evil.example',
    '/login',
    '/changes/../login',
    ['/', '/changes'],
  ])('drops unsafe or plural returnTo %j', async (returnTo) => {
    fail('options', 503);
    const links = anchors(await render({ returnTo }));
    expect(links[0].href).toBe('/changes/' + id + '/edit');
    expect(links[1]).toEqual({ href: '/changes/' + id, label: '変更計画へ戻る' });
  });
  it.each(['ABCDEFAB-CDEF-0000-0000-ABCDEFABCDEF', '00000000-0000-0000-0000-000000000000'])(
    'keeps backend-compatible UUID %s in retry',
    async (value) => {
      fail('main', 503);
      expect(anchors(await render({}, value))[0].href).toBe('/changes/' + value + '/edit');
    },
  );
  it.each(['invalid', '..', '07600000-0000-4000-000000000006'])(
    'offers no invalid ID retry %s in a synthetic failure probe',
    async (value) => {
      fail('main', 503);
      const links = anchors(await render({}, value));
      expect(links.map((l) => l.label)).toEqual(['変更一覧へ戻る', 'ポータルへ戻る']);
    },
  );
  for (const roleCode of ['agent', 'org_admin', 'platform_admin'])
    for (const state of ['draft', 'review', 'approved', 'rejected', 'scheduled']) {
      it(`preserves successful form props ${roleCode}/${state}`, async () => {
        vi.mocked(requireSession).mockResolvedValue({
          userId,
          organizationId: org,
          roles: [{ roleCode, organizationId: roleCode === 'platform_admin' ? null : org }],
        });
        const detail = dto(state);
        vi.mocked(api.changeDetail).mockResolvedValue({ ok: true, data: detail });
        const html = await render();
        expect(html).toContain('CHG-076 · 計画を見直す');
        expect(ChangePlanForm).toHaveBeenCalledOnce();
        const props = vi.mocked(ChangePlanForm).mock.calls[0][0];
        expect(props.current).toBe(detail.change);
        expect(props.options).toBe(options);
        expect(props.userId).toBe(userId);
        for (const key of ['creationKey', 'commandKey'] as const)
          expect(props[key]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          );
        expect(props.creationKey).not.toBe(props.commandKey);
        expect(notFound).not.toHaveBeenCalled();
      });
    }
  it('passes minimal current ticket/assets and zero eligible people without inventing candidates', async () => {
    const minimal = { ...options, owners: [], approvers: [] };
    vi.mocked(api.changeFormOptions).mockResolvedValue({ ok: true, data: minimal });
    await render();
    expect(vi.mocked(ChangePlanForm).mock.calls[0][0].options).toBe(minimal);
  });
});
