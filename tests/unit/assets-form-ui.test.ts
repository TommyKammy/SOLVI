// NFR-UX-002, NFR-UX-003, NFR-UX-004: bounded asset form-options read recovery.
// The form is a props probe here; real form rendering/axe and DB authorization are separate evidence.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';
import {
  api,
  requireSession,
  type AssetDetail,
  type AssetOptions,
  type AssetView,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { AssetForm } from '../../apps/web/src/components/AssetForm';

const navigation = vi.hoisted(() => ({ path: '/assets/new', params: new URLSearchParams() }));
const cookieState = vi.hoisted(() => ({
  values: [{ name: 'solvi_session', value: 'synthetic-session' }],
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    assetFormOptions: vi.fn(),
    assetOptions: vi.fn(),
    asset: vi.fn(),
    createAsset: vi.fn(),
    editAsset: vi.fn(),
    linkAsset: vi.fn(),
    unlinkAsset: vi.fn(),
    inspectAssetCsv: vi.fn(),
    previewAssetCsv: vi.fn(),
    applyAssetImport: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/AssetForm', () => ({
  AssetForm: vi.fn(() => createElement('form', { 'data-asset-form': 'true' })),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => cookieState.values }) }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(),
  usePathname: () => navigation.path,
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: NewAssetPage } = await vi.importActual<{
  default: (props: { searchParams: Promise<Query> }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/new/page');
const { default: EditAssetPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/[id]/edit/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '06700000-0000-4000-8000-000000000003';
const session: SessionView = {
  userId: '06700000-0000-4000-8000-000000000002',
  organizationId: '06700000-0000-4000-8000-000000000001',
  roles: [{ roleCode: 'agent', organizationId: '06700000-0000-4000-8000-000000000001' }],
};
const options: AssetOptions = {
  kinds: [
    { code: 'pc', label: 'PC', requiredFields: ['model'] },
    { code: 'saas', label: 'SaaS', requiredFields: ['vendor'] },
  ],
  states: [
    { code: 'stocked', label: '在庫' },
    { code: 'in_use', label: '使用中' },
  ],
  fields: [{ key: 'model', label: 'モデル・サービス名' }],
  members: [{ id: session.userId, name: 'PRIVATE_SYNTHETIC_MEMBER' }],
};
const asset: AssetView = {
  id,
  assetTag: 'PRIVATE_ASSET_TAG',
  name: 'PRIVATE_ASSET_NAME',
  kind: 'pc',
  state: 'in_use',
  version: 7,
  model: 'PRIVATE_MODEL',
  serialNumber: 'SYNTHETIC-SERIAL',
  hostname: 'synthetic-host',
  vendor: '合成メーカー',
  assignedUserId: session.userId,
  assignedUserName: '合成利用者',
  sourceKind: 'manual',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T01:00:00Z',
  location: 'PRIVATE_LOCATION',
  internalNotes: 'PRIVATE_INTERNAL_NOTE',
};
const detail: AssetDetail = {
  asset,
  canManage: true,
  revisions: [],
  tickets: [],
  relationHistory: [],
};
type Mode = 'new' | 'edit';
const render = async (mode: Mode, query: Query = {}, assetId = id) => {
  navigation.path = mode === 'new' ? '/assets/new' : `/assets/${assetId}/edit`;
  return renderToStaticMarkup(
    await (mode === 'new'
      ? NewAssetPage({ searchParams: Promise.resolve(query) })
      : EditAssetPage({
          params: Promise.resolve({ id: assetId }),
          searchParams: Promise.resolve(query),
        })),
  );
};
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const link = (html: string, label: string) => {
  const found = links(html).find((item) => item.label === label);
  expect(found, label).toBeDefined();
  return found!;
};
const failOptions = (status = 503) =>
  vi.mocked(api.assetFormOptions).mockResolvedValue({
    ok: false,
    problem: {
      status,
      title: 'PRIVATE_TITLE',
      detail: 'PRIVATE_DETAIL',
      type: 'https://private.invalid/problem',
      correlationId: 'PRIVATE_ID',
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  navigation.params = new URLSearchParams();
  cookieState.values = [{ name: 'solvi_session', value: 'synthetic-session' }];
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.asset).mockReset().mockResolvedValue({ ok: true, data: detail });
  vi.mocked(api.assetFormOptions).mockReset().mockResolvedValue({ ok: true, data: options });
});
afterEach(() => {
  for (const action of [
    api.assetOptions,
    api.createAsset,
    api.editAsset,
    api.linkAsset,
    api.unlinkAsset,
    api.inspectAssetCsv,
    api.previewAssetCsv,
    api.applyAssetImport,
  ]) {
    expect(action).not.toHaveBeenCalled();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('asset form entry denial precedes candidate recovery', () => {
  it.each(['new', 'edit'] as const)(
    'keeps %s candidate HTTP 403 as notFound even if the body declares success',
    async (mode) => {
      vi.mocked(api.assetFormOptions).mockImplementation(actualApi.assetFormOptions);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ status: 200, title: 'PRIVATE_TITLE' }, { status: 403 }),
          ),
      );
      await expect(render(mode)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalledOnce();
      expect(AssetForm).not.toHaveBeenCalled();
    },
  );

  it.each([400, 401, 403, 404, 500, 503])(
    'retains edit asset-side %s as notFound before candidate failure UI',
    async (status) => {
      vi.mocked(api.asset).mockResolvedValue({
        ok: false,
        problem: { status, title: 'PRIVATE_ASSET_ERROR' },
      });
      failOptions();
      if (status === 500 || status === 503) {
        const html = await render('edit');
        expect(html).toContain('一時的に資産を取得できませんでした。');
        expect(html).not.toContain('PRIVATE_');
        expect(notFound).not.toHaveBeenCalled();
      } else {
        await expect(render('edit')).rejects.toThrow('NEXT_NOT_FOUND');
        expect(notFound).toHaveBeenCalledOnce();
      }
      expect(AssetForm).not.toHaveBeenCalled();
      expect(api.asset).toHaveBeenCalledExactlyOnceWith(id);
      expect(api.assetFormOptions).toHaveBeenCalledOnce();
    },
  );

  it.each([200, 401, 403, 404, 503])(
    'rejects canManage=false before candidate status %s without inferring session permission',
    async (status) => {
      vi.mocked(api.asset).mockResolvedValue({ ok: true, data: { ...detail, canManage: false } });
      if (status !== 200) failOptions(status);
      await expect(render('edit')).rejects.toThrow('NEXT_NOT_FOUND');
      expect(AssetForm).not.toHaveBeenCalled();
    },
  );

  it.each(['new', 'edit'] as const)(
    'honors requireSession before any %s page read',
    async (mode) => {
      vi.mocked(requireSession).mockRejectedValue(new Error('EXISTING_SESSION_REDIRECT'));
      await expect(render(mode)).rejects.toThrow('EXISTING_SESSION_REDIRECT');
      expect(api.asset).not.toHaveBeenCalled();
      expect(api.assetFormOptions).not.toHaveBeenCalled();
      expect(notFound).not.toHaveBeenCalled();
      expect(AssetForm).not.toHaveBeenCalled();
    },
  );

  it('keeps edit detail and options reads parallel while preserving denial order', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.asset>>) => void;
    vi.mocked(api.asset).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    failOptions(503);
    const pending = render('edit');
    await vi.waitFor(() => expect(api.assetFormOptions).toHaveBeenCalledOnce());
    expect(AssetForm).not.toHaveBeenCalled();
    finish({ ok: false, problem: { status: 404, title: 'PRIVATE_ASSET_ERROR' } });
    await expect(pending).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it.each(['../options', '\ud800'])(
    'keeps an invalid edit id on the existing asset denial path (%s)',
    async (assetId) => {
      vi.mocked(api.asset).mockImplementation(actualApi.asset);
      failOptions(503);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(render('edit', {}, assetId)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(fetch).not.toHaveBeenCalled();
      expect(AssetForm).not.toHaveBeenCalled();
    },
  );
});

describe.each(['new', 'edit'] as const)('%s form-options fixed guidance and navigation', (mode) => {
  it.each([
    [400, '画面を開くための情報が正しくありません。元の画面から開き直してください。'],
    [401, 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'],
    [404, '登録・編集に必要な候補を取得できませんでした。元の画面から開き直してください。'],
    [500, '一時的に入力候補を取得できませんでした。時間をおいて、もう一度お試しください。'],
    [502, '一時的に入力候補を取得できませんでした。時間をおいて、もう一度お試しください。'],
    [503, '一時的に入力候補を取得できませんでした。時間をおいて、もう一度お試しください。'],
  ])('shows only fixed candidate guidance for %s with read-only exits', async (status, message) => {
    failOptions(status as number);
    const html = await render(mode);
    expect(html).toContain(
      `<h1>${mode === 'new' ? '登録' : '編集'}画面を読み込めませんでした</h1>`,
    );
    expect(html).toContain(`<p role="alert">${message}</p>`);
    expect(html).not.toContain('PRIVATE_');
    expect(html).not.toContain('private.invalid');
    expect(html).not.toContain('<form');
    expect(AssetForm).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    expect(links(html)).toHaveLength(3);
    expect(links(html).every((item) => item.native)).toBe(true);
    expect(link(html, '再取得する').href).toBe(
      mode === 'new' ? '/assets/new' : `/assets/${id}/edit`,
    );
    expect(link(html, mode === 'new' ? '資産台帳へ戻る' : '資産の詳細へ戻る').href).toBe(
      mode === 'new' ? '/assets' : `/assets/${id}`,
    );
    expect(link(html, 'ポータルへ戻る').href).toBe('/portal');
  });

  it('preserves only one safe returnTo and its conditions on the fixed retry path', async () => {
    failOptions();
    const returnTo = '/assets?q=%E7%AB%AF%E6%9C%AB&kind=pc&state=in_use&assignment=mine&page=2';
    const html = await render(mode, {
      returnTo,
      saved: '1',
      created: '1',
      updated: '1',
      unknown: 'PRIVATE_QUERY',
    });
    const retry = new URL(link(html, '再取得する').href, 'https://solvi.local');
    expect(retry.pathname).toBe(mode === 'new' ? '/assets/new' : `/assets/${id}/edit`);
    expect([...retry.searchParams]).toEqual([['returnTo', returnTo]]);
    expect(link(html, '元の画面へ戻る').href).toBe(returnTo);
    expect(html).not.toContain('PRIVATE_QUERY');
  });

  it('keeps an existing permitted non-asset return path and removes its flash', async () => {
    failOptions();
    const html = await render(mode, { returnTo: '/changes?state=planned&saved=1' });
    expect(link(html, '元の画面へ戻る').href).toBe('/changes?state=planned');
  });

  it.each([
    { name: 'missing', returnTo: undefined },
    { name: 'empty', returnTo: '' },
    { name: 'multiple', returnTo: ['/assets?page=1', '/assets?page=2'] },
    { name: 'external', returnTo: 'https://outside.invalid/assets' },
    { name: 'protocol-relative', returnTo: '//outside.invalid/assets' },
    { name: 'backslash', returnTo: '/assets\\outside' },
    { name: 'control-character', returnTo: '/assets?line=\nsecret' },
    { name: 'unapproved-page', returnTo: '/settings/notifications' },
    { name: 'overlength', returnTo: '/assets?q=' + 'x'.repeat(2001) },
  ])('uses the fixed fallback for $name returnTo', async ({ returnTo }) => {
    failOptions();
    const html = await render(mode, { returnTo });
    expect(html).not.toContain('元の画面へ戻る');
    expect(link(html, '再取得する').href).toBe(
      mode === 'new' ? '/assets/new' : `/assets/${id}/edit`,
    );
    expect(link(html, mode === 'new' ? '資産台帳へ戻る' : '資産の詳細へ戻る').href).toBe(
      mode === 'new' ? '/assets' : `/assets/${id}`,
    );
  });
});

describe('asset form unchanged successful props and markup', () => {
  it('passes exact new options to AssetForm without fetching a detail', async () => {
    const html = await render('new');
    expect(html).toContain('<h1>新しい資産を登録する</h1>');
    expect(link(html, '資産台帳へ戻る').href).toBe('/assets');
    expect(vi.mocked(AssetForm).mock.calls[0][0]).toEqual({ options });
    expect(vi.mocked(AssetForm).mock.calls[0][0].options).toBe(options);
    expect(api.asset).not.toHaveBeenCalled();
    expect(api.assetFormOptions).toHaveBeenCalledOnce();
  });
  it('passes exact edit asset/options/version and preserves existing ContextLink', async () => {
    navigation.params = new URLSearchParams({ returnTo: '/assets?assignment=mine&page=2' });
    const html = await render('edit');
    expect(html).toContain('<h1>資産を編集する</h1>');
    expect(html).toContain(
      '保存時に版が競合したら最新の内容を確認してください。入力は保持されます。',
    );
    expect(link(html, '元の画面へ戻る').href).toBe('/assets?assignment=mine&page=2');
    const props = vi.mocked(AssetForm).mock.calls[0][0];
    expect(props).toEqual({ asset, options });
    expect(props.asset).toBe(asset);
    expect(props.asset?.version).toBe(7);
    expect(props.options).toBe(options);
    expect(html).not.toContain('再取得する');
  });
});

describe('asset form-options dedicated GET transport', () => {
  it('uses the fixed endpoint with GET/cookie/no-store and returns unchanged successful DTO/set-cookie', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(options, {
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.assetFormOptions()).toEqual({
      ok: true,
      data: options,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname + new URL(url).search).toBe('/assets/options');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('cookie')).toBe('solvi_session=synthetic-session');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [400, 500],
    [401, 503],
    [403, 200],
    [404, 401],
    [500, 403],
    [503, 404],
  ])('keeps HTTP %s instead of body %s without reading raw details', async (status, bodyStatus) => {
    const response = Response.json(
      {
        status: bodyStatus,
        title: 'PRIVATE_TITLE',
        detail: 'PRIVATE_DETAIL',
        instance: 'PRIVATE_INSTANCE',
      },
      { status },
    );
    const text = vi.spyOn(response, 'text');
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.assetFormOptions()).toEqual({
      ok: false,
      problem: { status, title: '入力候補を取得できませんでした' },
    });
    expect(text).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });
  it.each([200, 400, 401, 403, 404, 500, 503])(
    'handles a cut body without losing a received rejection (%s)',
    async (status) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('PRIVATE_BODY_ERROR'));
        },
      });
      const response = new Response(body, { status });
      const text = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      expect(await actualApi.assetFormOptions()).toEqual({
        ok: false,
        problem: { status: status === 200 ? 503 : status, title: '入力候補を取得できませんでした' },
      });
      expect(text).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(status !== 200);
    },
  );
  it.each(['never-settles', 'rejects'] as const)(
    'aborts without invoking or awaiting body.cancel (%s)',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'rejects'
          ? Promise.reject(new Error('PRIVATE_CANCEL'))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          actualApi.assetFormOptions(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('BODY_CANCEL_WAIT')), 100);
          }),
        ]);
        expect(result).toEqual({
          ok: false,
          problem: { status: 403, title: '入力候補を取得できませんでした' },
        });
        expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timer);
      }
    },
  );
  it('maps network and malformed JSON to fixed 503 and 502', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK'))
      .mockResolvedValueOnce(new Response('PRIVATE_NOT_JSON'));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.assetFormOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: '入力候補を取得できませんでした' },
    });
    expect(await actualApi.assetFormOptions()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('preserves 204/set-cookie compatibility and omits a missing cookie', async () => {
    cookieState.values = [];
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.assetFormOptions()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(init.signal?.aborted).toBe(false);
  });
  it('leaves the old CSV-shared assetOptions method and its common transport unchanged', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(options));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.assetOptions()).toEqual({ ok: true, data: options });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/assets/options');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeUndefined();
    expect(new Headers(init.headers).get('cookie')).toBe('solvi_session=synthetic-session');
  });
});
