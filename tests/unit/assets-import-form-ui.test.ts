// NFR-UX-002, NFR-UX-003, NFR-UX-004: CSV entry read recovery through the real page and reader.
// AssetCsvForm is a render probe; real form rendering/axe, authorization and submissions are separate evidence.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';
import { api, requireSession, type SessionView } from '../../apps/web/src/lib/api';
import { AssetCsvForm } from '../../apps/web/src/components/AssetCsvForms';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
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
    inspectAssetCsv: vi.fn(),
    previewAssetCsv: vi.fn(),
    applyAssetImport: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/AssetCsvForms', () => ({
  AssetCsvForm: vi.fn(() => createElement('form', { 'data-csv-form': 'true' })),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => cookieState.values }) }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(),
  usePathname: () => '/assets/imports/new',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: NewAssetImportPage } = await vi.importActual<{
  default: (props: { searchParams: Promise<Query> }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/imports/new/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const session: SessionView = {
  userId: '06800000-0000-4000-8000-000000000002',
  organizationId: '06800000-0000-4000-8000-000000000001',
  roles: [{ roleCode: 'agent', organizationId: '06800000-0000-4000-8000-000000000001' }],
};
const options = {
  kinds: [],
  states: [],
  fields: [],
  members: [{ id: session.userId, name: 'PRIVATE_CANDIDATE' }],
};
const render = async (query: Query = {}) =>
  renderToStaticMarkup(await NewAssetImportPage({ searchParams: Promise.resolve(query) }));
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/gs)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
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
        ? '取込に必要な情報を取得できませんでした。元の画面から開き直してください。'
        : '一時的に取込画面を読み込めませんでした。時間をおいて、もう一度お試しください。';
const noForm = (html: string) => {
  expect(html).not.toMatch(/PRIVATE_|<form|<input|<select|<textarea|<button|プレビュー|確定します/);
  expect(AssetCsvForm).not.toHaveBeenCalled();
};
const rejected = async (status: number) => {
  if (status === 403) {
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(AssetCsvForm).not.toHaveBeenCalled();
  } else {
    const html = await render();
    expect(html).toContain('<h1>CSV取込画面を読み込めませんでした</h1>');
    expect(html).toContain(`<p role="alert">${message(status)}</p>`);
    expect(links(html)).toEqual([
      { label: '再取得する', href: '/assets/imports/new', native: true },
      { label: '取込履歴へ戻る', href: '/assets/imports', native: true },
      { label: 'ポータルへ戻る', href: '/portal', native: true },
    ]);
    expect(notFound).not.toHaveBeenCalled();
    noForm(html);
  }
};
const transportResult = () => vi.mocked(api.assetFormOptions).mock.results[0].value;
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(options)));
  navigation.params = new URLSearchParams();
  cookieState.values = [{ name: 'solvi_session', value: 'synthetic-session' }];
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.assetFormOptions).mockReset().mockImplementation(actualApi.assetFormOptions);
});
afterEach(() => {
  for (const action of [
    api.assetOptions,
    api.asset,
    api.createAsset,
    api.editAsset,
    api.inspectAssetCsv,
    api.previewAssetCsv,
    api.applyAssetImport,
  ]) {
    expect(action).not.toHaveBeenCalled();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CSV entry session and successful access guard', () => {
  it('waits for the session before calling the actual options reader', async () => {
    let release!: (session: SessionView) => void;
    vi.mocked(requireSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = render();
    expect(requireSession).toHaveBeenCalledOnce();
    expect(api.assetFormOptions).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    release(session);
    await pending;
    expect(api.assetFormOptions).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not read options or render a form when the session rejects', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_REDIRECT'));
    await expect(render()).rejects.toThrow('SESSION_REDIRECT');
    expect(api.assetFormOptions).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(AssetCsvForm).not.toHaveBeenCalled();
  });
  it.each([options, {}, null, { ignored: 'PRIVATE_VALUE' }])(
    'retains successful CSV markup without using the options DTO (%j)',
    async (data) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
      const html = await render({ saved: '1', unknown: 'PRIVATE_QUERY' });
      expect(html).toContain('<h1>資産CSVを取り込む</h1>');
      expect(html).toContain(
        '合成データで試すローカル取込です。列を選び、差分を確認してから確定します。',
      );
      expect(html).toContain('CSVにない資産の削除・廃止は行いません。');
      expect(html).toContain('data-csv-form="true"');
      expect(html).not.toMatch(/role="alert"|再取得する|PRIVATE_/);
      expect(link(html, '取込履歴へ戻る')).toEqual({
        label: '取込履歴へ戻る',
        href: '/assets/imports',
        native: false,
      });
      expect(AssetCsvForm).toHaveBeenCalledOnce();
      expect(vi.mocked(AssetCsvForm).mock.calls[0][0]).toEqual({});
      expect(await transportResult()).toEqual({ ok: true, data });
    },
  );
  it('preserves successful ContextLink return navigation', async () => {
    const returnTo = '/assets?q=synthetic&state=in_use&kind=pc&assignment=mine&page=2';
    navigation.params.set('returnTo', returnTo);
    const html = await render({ returnTo });
    expect(link(html, '元の画面へ戻る')).toEqual({
      label: '元の画面へ戻る',
      href: returnTo,
      native: false,
    });
  });
  it('uses only the existing fixed GET endpoint, cookies and no-store', async () => {
    const cookie = 'synthetic_refresh=ok; HttpOnly';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json(options, { headers: { 'set-cookie': cookie } })),
    );
    await render();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/assets/options');
    expect(new URL(String(url)).search).toBe('');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.cache).toBe('no-store');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('cookie')).toBe('solvi_session=synthetic-session');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(await transportResult()).toEqual({ ok: true, data: options, setCookie: cookie });
  });
  it.each([undefined, 'synthetic_refresh=ok; HttpOnly'])(
    'keeps 204 access success without reading data or requiring cookies (%s)',
    async (setCookie) => {
      cookieState.values = [];
      const response = new Response(null, {
        status: 204,
        headers: setCookie ? { 'set-cookie': setCookie } : {},
      });
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const html = await render();
      expect(html).toContain('data-csv-form="true"');
      expect(text).not.toHaveBeenCalled();
      expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has('cookie')).toBe(false);
      expect(await transportResult()).toEqual({
        ok: true,
        data: undefined,
        ...(setCookie ? { setCookie } : {}),
      });
    },
  );
});

describe('CSV entry real-reader failures and denial', () => {
  it.each([
    [400, 500],
    [401, 503],
    [403, 200],
    [404, 401],
    [500, 403],
    [503, 404],
  ])(
    'uses HTTP %s instead of body-declared %s without reading the problem',
    async (status, bodyStatus) => {
      const response = Response.json(
        { status: bodyStatus, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' },
        { status },
      );
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await rejected(status);
      expect(await transportResult()).toEqual({
        ok: false,
        problem: { status, title: '入力候補を取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
  it.each([200, 400, 401, 403, 404, 500, 503])(
    'retains a received denial through a cut body (%s)',
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
        problem: { status: expected, title: '入力候補を取得できませんでした' },
      });
      expect(text).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(status !== 200);
    },
  );
  it.each(['never-settles', 'rejects'] as const)(
    'returns existing notFound without invoking or waiting for cancel (%s)',
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
  it('maps transport rejection to fixed 503 without leaking its text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    await rejected(503);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 503, title: '入力候補を取得できませんでした' },
    });
  });
  it('maps invalid successful JSON to 502 with fixed recovery guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('PRIVATE_INVALID_JSON', { status: 200 })),
    );
    await rejected(502);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it.each([400, 401, 404, 500, 502, 503])(
    'never renders raw problem fields or candidate/form information (%s)',
    async (status) => {
      failOptions(status);
      await rejected(status);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('CSV entry native retry and back boundaries', () => {
  it('keeps a single normalized returnTo and drops all other top-level parameters', async () => {
    failOptions();
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
      saved: '1',
      created: '1',
      updated: '1',
      unknown: 'PRIVATE_QUERY',
      page: ['9', '10'],
    });
    const retry = link(html, '再取得する');
    const url = new URL(retry.href, 'https://solvi.local');
    expect(retry.native).toBe(true);
    expect(url.pathname).toBe('/assets/imports/new');
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
    noForm(html);
  });
  it('preserves an existing allowed non-asset return path without expanding the allowlist', async () => {
    failOptions();
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
    'uses fixed history fallback for an absent/unsafe/non-single returnTo (%j)',
    async (returnTo) => {
      failOptions();
      const html = await render({ returnTo });
      expect(link(html, '再取得する')).toEqual({
        label: '再取得する',
        href: '/assets/imports/new',
        native: true,
      });
      expect(link(html, '取込履歴へ戻る')).toEqual({
        label: '取込履歴へ戻る',
        href: '/assets/imports',
        native: true,
      });
      expect(links(html)).toHaveLength(3);
      noForm(html);
    },
  );
});
