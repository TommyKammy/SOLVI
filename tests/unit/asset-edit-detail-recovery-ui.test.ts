// NFR-UX-002, NFR-UX-003, NFR-UX-004: only asset edit primary 5xx becomes recoverable.
// AssetForm is a props probe; the separate owned Next UI run renders the actual form.
import React, { createElement, type ReactNode, type AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';
import {
  api,
  requireSession,
  type AssetDetail,
  type AssetOptions,
} from '../../apps/web/src/lib/api';
import { AssetForm } from '../../apps/web/src/components/AssetForm';
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { asset: vi.fn(), assetFormOptions: vi.fn(), editAsset: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/AssetForm', () => ({
  AssetForm: vi.fn(() => createElement('form', { 'data-form-probe': true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  usePathname: () => '/assets/08200000-0000-4000-8000-000000000001/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: Page } = await vi.importActual<{
  default: (p: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/[id]/edit/page');
const id = '08200000-0000-4000-8000-000000000001';
const options: AssetOptions = {
  kinds: [{ code: 'pc', label: 'PC', requiredFields: ['model'] }],
  states: [{ code: 'in_use', label: '使用中' }],
  fields: [{ key: 'model', label: 'モデル' }],
  members: [{ id, name: '合成利用者' }],
};
const detail: AssetDetail = {
  asset: {
    id,
    assetTag: 'PRIVATE_TAG',
    name: 'PRIVATE_NAME',
    kind: 'pc',
    state: 'in_use',
    version: 7,
    model: '合成モデル',
    serialNumber: '合成番号',
    hostname: 'synthetic',
    vendor: '合成',
    assignedUserId: id,
    assignedUserName: '合成利用者',
    sourceKind: 'manual',
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T01:00:00Z',
    location: 'PRIVATE_LOCATION',
    internalNotes: 'PRIVATE_NOTES',
  },
  canManage: true,
  revisions: [],
  tickets: [],
  relationHistory: [],
};
const failure = (status: number) => ({
  ok: false as const,
  problem: { status, title: 'PRIVATE_TITLE', detail: 'PRIVATE_BODY' },
});
const render = async (query: Query = {}) =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) }),
  );
const href = (html: string, label: string) => {
  const item = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].find(
    (m) => m[2] === label,
  );
  expect(item).toBeDefined();
  return item![1]!.replaceAll('&amp;', '&');
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.mocked(requireSession)
    .mockReset()
    .mockResolvedValue({ userId: id, organizationId: id, roles: [] });
  vi.mocked(api.asset).mockReset().mockResolvedValue({ ok: true, data: detail });
  vi.mocked(api.assetFormOptions).mockReset().mockResolvedValue({ ok: true, data: options });
});
afterEach(() => {
  expect(api.editAsset).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe('asset edit primary recovery', () => {
  it.each([500, 501, 502, 503, 504, 599])(
    'recovers primary %s using fixed text and native links',
    async (status) => {
      vi.mocked(api.asset).mockResolvedValue(failure(status));
      const html = await render();
      expect(html).toContain('<h1>編集画面を表示できません</h1>');
      expect(html).toContain(
        '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。',
      );
      expect(html).not.toContain('PRIVATE_');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('data-next-link');
      expect(href(html, '再取得する')).toBe(`/assets/${id}/edit`);
      expect(href(html, '資産の詳細へ戻る')).toBe(`/assets/${id}`);
      expect(href(html, 'ポータルへ戻る')).toBe('/portal');
      expect(notFound).not.toHaveBeenCalled();
      expect(AssetForm).not.toHaveBeenCalled();
    },
  );
  it.each([400, 401, 403, 404, 409, 499, 600])(
    'keeps primary %s refusal ahead of candidate 503',
    async (status) => {
      vi.mocked(api.asset).mockResolvedValue(failure(status));
      vi.mocked(api.assetFormOptions).mockResolvedValue(failure(503));
      await expect(render()).rejects.toThrow('NOT_FOUND');
      expect(AssetForm).not.toHaveBeenCalled();
    },
  );
  it.each([400, 401, 403, 404, 503])(
    'keeps canManage=false ahead of candidate %s',
    async (status) => {
      vi.mocked(api.asset).mockResolvedValue({ ok: true, data: { ...detail, canManage: false } });
      vi.mocked(api.assetFormOptions).mockResolvedValue(failure(status));
      await expect(render()).rejects.toThrow('NOT_FOUND');
    },
  );
  it('keeps candidate 403 ahead of primary 503', async () => {
    vi.mocked(api.asset).mockResolvedValue(failure(503));
    vi.mocked(api.assetFormOptions).mockResolvedValue(failure(403));
    await expect(render()).rejects.toThrow('NOT_FOUND');
  });
  it('uses primary guidance when both reads fail 503', async () => {
    vi.mocked(api.asset).mockResolvedValue(failure(503));
    vi.mocked(api.assetFormOptions).mockResolvedValue(failure(503));
    const html = await render();
    expect(html).toContain('一時的に資産を取得できませんでした。');
    expect(html).not.toContain('入力候補');
  });
  it('starts both readers and awaits delayed candidate 403 before choosing UI', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.assetFormOptions>>) => void;
    vi.mocked(api.asset).mockResolvedValue(failure(503));
    vi.mocked(api.assetFormOptions).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = render();
    await vi.waitFor(() => expect(api.assetFormOptions).toHaveBeenCalledOnce());
    expect(api.asset).toHaveBeenCalledExactlyOnceWith(id);
    expect(AssetForm).not.toHaveBeenCalled();
    finish(failure(403));
    await expect(pending).rejects.toThrow('NOT_FOUND');
  });
  it('keeps session first with zero reads', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_REDIRECT'));
    await expect(render()).rejects.toThrow('SESSION_REDIRECT');
    expect(api.asset).not.toHaveBeenCalled();
    expect(api.assetFormOptions).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    ['/assets', '/portal'],
    'https://example.invalid',
    '//example.invalid',
    '/assets\\x',
  ])('falls back for absent/invalid/plural returnTo %s', async (returnTo) => {
    vi.mocked(api.asset).mockResolvedValue(failure(503));
    const html = await render({ returnTo, saved: '1', unknown: 'PRIVATE' });
    expect(href(html, '再取得する')).toBe(`/assets/${id}/edit`);
    expect(href(html, '資産の詳細へ戻る')).toBe(`/assets/${id}`);
  });
  it('preserves raw Japanese nested conditions with exact canonical and decoded meaning', async () => {
    vi.mocked(api.asset).mockResolvedValue(failure(503));
    const parent =
      '/assets?' +
      new URLSearchParams({
        q: '合成',
        state: 'in_use',
        kind: 'pc',
        assignment: 'mine',
        page: '2',
      });
    const raw = `/assets/${id}?returnTo=${encodeURIComponent('/assets?q=合成&state=in_use&kind=pc&assignment=mine&page=2')}&saved=1`;
    const expected = `/assets/${id}?` + new URLSearchParams({ returnTo: parent });
    const html = await render({ returnTo: raw, saved: '1', unknown: 'PRIVATE' });
    const url = new URL(href(html, '再取得する'), 'https://solvi.local');
    expect(url.pathname).toBe(`/assets/${id}/edit`);
    expect([...url.searchParams]).toEqual([['returnTo', expected]]);
    expect(href(html, '元の画面へ戻る')).toBe(expected);
    const nested = new URL(new URL(expected, url).searchParams.get('returnTo')!, url);
    expect([...nested.searchParams]).toEqual([
      ['q', '合成'],
      ['state', 'in_use'],
      ['kind', 'pc'],
      ['assignment', 'mine'],
      ['page', '2'],
    ]);
  });
  it('preserves exact successful asset/options/version and normal guidance', async () => {
    const html = await render();
    expect(html).toContain('資産を編集する');
    expect(html).toContain('入力は保持されます。');
    expect(AssetForm).toHaveBeenCalledOnce();
    expect(vi.mocked(AssetForm).mock.calls[0]![0]).toEqual({ asset: detail.asset, options });
    expect(notFound).not.toHaveBeenCalled();
  });
  it.each([400, 401, 404, 503])(
    'preserves existing candidate failure wording %s when primary succeeds',
    async (status) => {
      vi.mocked(api.assetFormOptions).mockResolvedValue(failure(status));
      const html = await render();
      expect(html).not.toContain('一時的に資産を取得できませんでした。');
      expect(html).not.toContain('PRIVATE_');
      expect(AssetForm).not.toHaveBeenCalled();
      if (status === 503) expect(html).toContain('一時的に入力候補を取得できませんでした。');
    },
  );
});
