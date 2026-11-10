// NFR-UX-002, NFR-UX-003, NFR-UX-004: CSV history recovery through the real page and reader.
// Synthetic responses verify rendering/transport; real authorization, CSV writes and browser a11y are separate evidence.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';
import {
  api,
  requireSession,
  type AssetImportList,
  type SessionView,
} from '../../apps/web/src/lib/api';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
const cookieState = vi.hoisted(() => ({
  values: [{ name: 'solvi_session', value: 'synthetic-session' }],
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    assetImports: vi.fn(),
    assetImport: vi.fn(),
    assetOptions: vi.fn(),
    assetFormOptions: vi.fn(),
    asset: vi.fn(),
    assets: vi.fn(),
    createAsset: vi.fn(),
    editAsset: vi.fn(),
    inspectAssetCsv: vi.fn(),
    previewAssetCsv: vi.fn(),
    applyAssetImport: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => cookieState.values }) }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(),
  usePathname: () => '/assets/imports',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: AssetImportsPage } = await vi.importActual<{
  default: (props: { searchParams: Promise<Query> }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/imports/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const session: SessionView = {
  userId: '06900000-0000-4000-8000-000000000002',
  organizationId: '06900000-0000-4000-8000-000000000001',
  roles: [{ roleCode: 'agent', organizationId: '06900000-0000-4000-8000-000000000001' }],
};
const items: AssetImportList['items'] = Array.from({ length: 50 }, (_, index) => ({
  id: '06900000-0000-4000-8000-' + String(100 + index).padStart(12, '0'),
  sourceKey: 'synthetic-' + String(50 - index).padStart(3, '0'),
  createdAt: new Date(Date.parse('2026-10-09T00:00:00.000Z') - index * 60_000).toISOString(),
  appliedAt: index % 2 === 0 ? '2026-10-09T01:00:00.000Z' : null,
  counts: { add: index + 1, update: 2, unchanged: 3, error: 0 },
}));
const list: AssetImportList = { canManage: true, items };
const render = async (query: Query = {}) => {
  navigation.params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') navigation.params.set(key, value);
    else if (Array.isArray(value)) for (const item of value) navigation.params.append(key, item);
  }
  return renderToStaticMarkup(await AssetImportsPage({ searchParams: Promise.resolve(query) }));
};
const plainText = (html: string) => html.replace(/<[^>]*>/g, '');
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/gs)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: plainText(m[4]),
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const link = (html: string, label: string) => {
  const found = links(html).find((item) => item.label === label);
  expect(found, label).toBeDefined();
  return found!;
};
const message = (status: number) =>
  status === 401
    ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
    : status === 400
      ? '画面を開くための情報が正しくありません。元の画面から開き直してください。'
      : status === 404
        ? '取込履歴を取得できませんでした。元の画面から開き直してください。'
        : '一時的に取込履歴を読み込めませんでした。時間をおいて、もう一度お試しください。';
const noHistoryOrActions = (html: string) => {
  expect(html).not.toMatch(
    /PRIVATE_|synthetic-|<ul|<li|<form|<input|<select|<textarea|<button|取込プレビューはまだありません|資産CSVを取り込む|最新50件|確定済み|未確定|変更なし/,
  );
};
const rejected = async (status: number) => {
  if (status === 403) {
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  } else {
    const html = await render();
    expect(html).toContain('<h1>取込履歴を読み込めませんでした</h1>');
    expect(html).toContain(`<p role="alert">${message(status)}</p>`);
    expect(links(html)).toEqual([
      { label: '再取得する', href: '/assets/imports', native: true },
      { label: '資産台帳へ戻る', href: '/assets', native: true },
      { label: 'ポータルへ戻る', href: '/portal', native: true },
    ]);
    expect(notFound).not.toHaveBeenCalled();
    noHistoryOrActions(html);
  }
};
const transportResult = () => vi.mocked(api.assetImports).mock.results[0].value;
const failHistory = (status = 503) =>
  vi.mocked(api.assetImports).mockResolvedValue({
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(list)));
  cookieState.values = [{ name: 'solvi_session', value: 'synthetic-session' }];
  navigation.params = new URLSearchParams();
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.assetImports).mockReset().mockImplementation(actualApi.assetImports);
});
afterEach(() => {
  for (const action of [
    api.assetImport,
    api.assetOptions,
    api.assetFormOptions,
    api.asset,
    api.assets,
    api.createAsset,
    api.editAsset,
    api.inspectAssetCsv,
    api.previewAssetCsv,
    api.applyAssetImport,
  ])
    expect(action).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CSV history session and unchanged successful renderer', () => {
  it('waits for the session before requesting history', async () => {
    let release!: (session: SessionView) => void;
    vi.mocked(requireSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = render();
    expect(requireSession).toHaveBeenCalledOnce();
    expect(api.assetImports).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    release(session);
    await pending;
    expect(api.assetImports).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not request history when requireSession rejects', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_REDIRECT'));
    await expect(render()).rejects.toThrow('SESSION_REDIRECT');
    expect(api.assetImports).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'preserves all 50 rows, server order and canManage=%s',
    async (canManage) => {
      const data = { canManage, items };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
      const html = await render();
      expect(html).toContain('<h1>CSV取込と履歴</h1>');
      expect(html).toContain('最新50件のプレビューと確定結果です。CSVにない資産を変更しません。');
      expect(html.match(/<li class="attachment">/g) ?? []).toHaveLength(50);
      const details = links(html).filter((item) =>
        /^\/assets\/imports\/[0-9a-f-]+\?/.test(item.href),
      );
      expect(details.map((item) => new URL(item.href, 'https://solvi.local').pathname)).toEqual(
        items.map((item) => '/assets/imports/' + item.id),
      );
      expect(details.every((item) => !item.native)).toBe(true);
      expect(
        details.every(
          (item) =>
            new URL(item.href, 'https://solvi.local').searchParams.get('returnTo') ===
            '/assets/imports',
        ),
      ).toBe(true);
      expect(details[0].label).toBe('synthetic-050 · 2026年10月9日 09:00');
      expect(details.at(-1)?.label).toBe('synthetic-001 · 2026年10月9日 08:11');
      expect(plainText(html)).toMatch(/確定済み · 追加1 \/ 更新2 \/\s*変更なし3 \/ 不正0/);
      expect(plainText(html)).toMatch(/未確定 · 追加2 \/ 更新2 \/\s*変更なし3 \/ 不正0/);
      const create = links(html).filter((item) => item.label === '資産CSVを取り込む');
      expect(create).toHaveLength(canManage ? 1 : 0);
      if (canManage)
        expect(create[0]).toEqual({
          label: '資産CSVを取り込む',
          href: '/assets/imports/new?returnTo=%2Fassets%2Fimports',
          native: false,
        });
      expect(link(html, '資産台帳へ戻る')).toEqual({
        label: '資産台帳へ戻る',
        href: '/assets',
        native: false,
      });
      expect(html).not.toMatch(
        /role="alert"|再取得する|取込プレビューはまだありません|<form|<button/,
      );
      expect(await transportResult()).toEqual({ ok: true, data });
    },
  );
  it.each([true, false])(
    'preserves the existing empty state and canManage=%s',
    async (canManage) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ canManage, items: [] })));
      const html = await render();
      expect(html).toContain('取込プレビューはまだありません。');
      expect(html).not.toMatch(/<ul|<li|role="alert"|再取得する|絞り込み|次のページ/);
      expect(links(html).filter((item) => item.label === '資産CSVを取り込む')).toHaveLength(
        canManage ? 1 : 0,
      );
    },
  );
  it('keeps existing successful ContextLink navigation and nested returnTo', async () => {
    const returnTo = '/assets?q=synthetic&state=in_use&kind=pc&assignment=mine&page=2';
    const html = await render({ returnTo });
    expect(link(html, '元の画面へ戻る')).toEqual({
      label: '元の画面へ戻る',
      href: returnTo,
      native: false,
    });
    const created = new URL(link(html, '資産CSVを取り込む').href, 'https://solvi.local');
    expect(created.searchParams.get('returnTo')).toBe(
      '/assets/imports?' + new URLSearchParams({ returnTo }),
    );
  });
});

describe('CSV history fixed dedicated GET transport', () => {
  it('uses the fixed endpoint with cookies/no-store and does not forward page query parameters', async () => {
    const setCookie = 'synthetic_refresh=ok; HttpOnly';
    cookieState.values.push({ name: 'synthetic_context', value: 'selected' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json(list, { headers: { 'set-cookie': setCookie } })),
    );
    await render({ q: 'PRIVATE_QUERY', state: 'applied', page: '999', returnTo: '/assets' });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/assets/imports');
    expect(new URL(String(url)).search).toBe('');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.cache).toBe('no-store');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('cookie')).toBe(
      'solvi_session=synthetic-session; synthetic_context=selected',
    );
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(await transportResult()).toEqual({ ok: true, data: list, setCookie });
  });
  it.each([undefined, 'synthetic_refresh=ok; HttpOnly'])(
    'retains 204/set-cookie compatibility only at the transport boundary (%s)',
    async (setCookie) => {
      cookieState.values = [];
      const response = new Response(null, {
        status: 204,
        headers: setCookie ? { 'set-cookie': setCookie } : {},
      });
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      expect(await actualApi.assetImports()).toEqual({
        ok: true,
        data: undefined,
        ...(setCookie ? { setCookie } : {}),
      });
      expect(text).not.toHaveBeenCalled();
      expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has('cookie')).toBe(false);
      expect(api.assetImports).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
    },
  );
  it.each([
    [400, 500],
    [401, 503],
    [403, 200],
    [404, 401],
    [500, 403],
    [503, 404],
  ])(
    'preserves HTTP %s over body status %s without reading raw problem data',
    async (status, bodyStatus) => {
      const response = Response.json(
        { status: bodyStatus, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL', items },
        { status },
      );
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await rejected(status);
      expect(await transportResult()).toEqual({
        ok: false,
        problem: { status, title: '取込履歴を取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
  it.each([200, 400, 401, 403, 404, 500, 503])(
    'handles a cut body after HTTP %s',
    async (status) => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('PRIVATE_BODY'));
          },
        }),
        { status },
      );
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const expected = status === 200 ? 503 : status;
      await rejected(expected);
      expect(await transportResult()).toEqual({
        ok: false,
        problem: { status: expected, title: '取込履歴を取得できませんでした' },
      });
      expect(text).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(status !== 200);
    },
  );
  it.each(['never-settles', 'rejects'] as const)(
    'aborts rejection without waiting for body.cancel (%s)',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'rejects'
          ? Promise.reject(new Error('PRIVATE_CANCEL'))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            render(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('CANCEL_WAIT')), 100);
            }),
          ]),
        ).rejects.toThrow('NEXT_NOT_FOUND');
        expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timer);
      }
    },
  );
  it('maps network rejection to fixed 503 guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    await rejected(503);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 503, title: '取込履歴を取得できませんでした' },
    });
  });
  it('maps malformed successful JSON to fixed 502 guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('PRIVATE_JSON', { status: 200 })),
    );
    await rejected(502);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
});

describe('CSV history failure rendering and native URL boundaries', () => {
  it.each([400, 401, 404, 500, 502, 503])(
    'does not render raw problem, history, counts or actions (%s)',
    async (status) => {
      failHistory(status);
      await rejected(status);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('retains only a single normalized returnTo without inventing history filters', async () => {
    failHistory();
    const returnTo =
      '/assets?' +
      new URLSearchParams({
        q: '合成 &%_\\?',
        state: 'in_use',
        kind: 'pc',
        assignment: 'mine',
        page: '2',
      });
    const html = await render({
      returnTo: returnTo + '&saved=1&created=1&updated=1',
      q: 'PRIVATE_Q',
      state: 'applied',
      page: ['9', '10'],
      saved: '1',
      created: '1',
      updated: '1',
      applied: '1',
      unknown: 'PRIVATE_UNKNOWN',
    });
    const retry = link(html, '再取得する');
    const url = new URL(retry.href, 'https://solvi.local');
    expect(retry.native).toBe(true);
    expect(url.pathname).toBe('/assets/imports');
    expect([...url.searchParams.keys()]).toEqual(['returnTo']);
    expect(url.searchParams.get('returnTo')).toBe(returnTo);
    expect(link(html, '元の画面へ戻る')).toEqual({
      label: '元の画面へ戻る',
      href: returnTo,
      native: true,
    });
    expect(link(html, 'ポータルへ戻る')).toEqual({
      label: 'ポータルへ戻る',
      href: '/portal',
      native: true,
    });
    noHistoryOrActions(html);
  });
  it('keeps an existing permitted non-asset return href', async () => {
    failHistory();
    const html = await render({ returnTo: '/requests?q=synthetic&view=mine&page=2&saved=1' });
    expect(link(html, '元の画面へ戻る').href).toBe('/requests?q=synthetic&view=mine&page=2');
  });
  it.each([
    undefined,
    '',
    [],
    ['/assets'],
    ['/assets', '/requests'],
    'https://evil.invalid/assets',
    '//evil.invalid/assets',
    '/\\evil.invalid/assets',
    '/assets\n',
    '/admin',
    '/assets?' + 'x'.repeat(2000),
  ])(
    'uses the fixed asset fallback for absent/unsafe/non-single returnTo (%j)',
    async (returnTo) => {
      failHistory();
      const html = await render({ returnTo });
      expect(link(html, '再取得する')).toEqual({
        label: '再取得する',
        href: '/assets/imports',
        native: true,
      });
      expect(link(html, '資産台帳へ戻る')).toEqual({
        label: '資産台帳へ戻る',
        href: '/assets',
        native: true,
      });
      expect(links(html)).toHaveLength(3);
      noHistoryOrActions(html);
    },
  );
});
