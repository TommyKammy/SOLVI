// NFR-UX-002, NFR-UX-003, NFR-UX-004: new change candidate GET recovery.
// The form is a unit render probe; the real Next harness separately reads the real form.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  api,
  requireSession,
  type ChangeOptions,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { ChangePlanForm } from '../../apps/web/src/components/ChangeForms';
import { notFound, redirect } from 'next/navigation';
const jar = vi.hoisted(() => ({ calls: 0, reject: false, empty: false }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    jar.calls++;
    if (jar.reject) throw new Error('PRIVATE_COOKIE');
    return {
      getAll: () => (jar.empty ? [] : [{ name: 'solvi_session', value: 'synthetic-session' }]),
    };
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { changeFormOptions: vi.fn(), changeOptions: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/ChangeForms', () => ({
  ChangePlanForm: vi.fn(() => createElement('form', { 'data-plan-probe': true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  usePathname: () => '/changes/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: Page } = await vi.importActual<{
  default: (p: { searchParams: Promise<Query> }) => Promise<ReactNode>;
}>('../../apps/web/src/app/changes/new/page');
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '07500000-0000-4000-8000-000000000001';
const user = '07500000-0000-4000-8000-000000000002';
const ticketId = '07500000-0000-4000-8000-000000000010';
const assetId = '07500000-0000-4000-8000-000000000020';
const session: SessionView = {
  userId: user,
  organizationId: org,
  roles: [{ roleCode: 'agent', organizationId: org }],
};
const options: ChangeOptions = {
  owners: [{ id: user, name: '合成担当者' }],
  approvers: [{ id: '07500000-0000-4000-8000-000000000003', name: '合成承認者' }],
  tickets: [{ id: ticketId, number: 'TKT-075', subject: '合成の元チケット' }],
  assets: [
    {
      id: assetId,
      assetTag: 'AST-075',
      name: '合成の対象資産',
      kind: 'pc',
      state: 'in_use',
      version: 3,
    },
  ],
};
const render = async (query: Query = {}) =>
  renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const failure = (status = 503) =>
  vi.mocked(api.changeFormOptions).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' },
  });
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  jar.calls = 0;
  jar.reject = false;
  jar.empty = false;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.changeFormOptions).mockResolvedValue({ ok: true, data: options });
});
afterEach(() => vi.unstubAllGlobals());
describe('new change page and preserved form boundary', () => {
  it('requires session before search parameters and candidates; refusal reads nothing', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.changeFormOptions).not.toHaveBeenCalled();
    expect(ChangePlanForm).not.toHaveBeenCalled();
  });
  it('reads candidates only after session and query resolve', async () => {
    let release!: (q: Query) => void;
    const promise = Page({
      searchParams: new Promise((resolve) => {
        release = resolve;
      }),
    });
    await Promise.resolve();
    expect(api.changeFormOptions).not.toHaveBeenCalled();
    release({ ticketId, assetId });
    await promise;
    expect(requireSession).toHaveBeenCalledOnce();
    expect(api.changeFormOptions).toHaveBeenCalledWith(
      new URLSearchParams({ ticketId, assetIds: assetId }).toString(),
    );
  });
  it.each([403, 404])('keeps HTTP %i notFound without redirect', async (status) => {
    failure(status);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(redirect).not.toHaveBeenCalled();
    expect(ChangePlanForm).not.toHaveBeenCalled();
  });
  it.each([400, 401, 500, 502, 503])(
    'shows fixed Japanese recovery for HTTP %i',
    async (status) => {
      failure(status);
      const html = await render({ saved: '1', unknown: 'PRIVATE_QUERY' });
      expect(html).toContain('<h1>入力候補を読み込めませんでした</h1>');
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        status === 400
          ? '元の画面や変更一覧から開き直してください'
          : status === 401
            ? 'ログイン状態を確認できませんでした'
            : '時間をおいて、もう一度お試しください',
      );
      for (const value of ['PRIVATE', '<form', '<input', 'TKT-075', 'AST-075', ticketId, assetId])
        expect(html).not.toContain(value);
      expect(ChangePlanForm).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(links(html)).toEqual([
        { href: '/changes/new', label: '再取得する', native: true },
        { href: '/changes', label: '変更一覧へ戻る', native: true },
        { href: '/portal', label: 'ポータルへ戻る', native: true },
      ]);
    },
  );
  for (const role of ['agent', 'org_admin', 'platform_admin'])
    for (const shape of ['none', 'ticket', 'asset', 'both']) {
      it(`preserves successful form props ${role}/${shape}`, async () => {
        vi.mocked(requireSession).mockResolvedValue({
          ...session,
          roles: [{ roleCode: role, organizationId: role === 'platform_admin' ? null : org }],
        });
        const query = {
          ...(shape === 'ticket' || shape === 'both' ? { ticketId } : {}),
          ...(shape === 'asset' || shape === 'both' ? { assetId } : {}),
        };
        const html = await render(query);
        expect(html).toContain('通常変更の計画を作成する');
        expect(html).toContain('data-plan-probe');
        const props = vi.mocked(ChangePlanForm).mock.calls[0][0];
        expect(props.options).toBe(options);
        expect(props.userId).toBe(user);
        expect(props.ticketId).toBe(query.ticketId);
        expect(props.assetId).toBe(query.assetId);
        expect(z.string().uuid().safeParse(props.creationKey).success).toBe(true);
        expect(z.string().uuid().safeParse(props.commandKey).success).toBe(true);
        expect(props.creationKey).not.toBe(props.commandKey);
        expect(api.changeFormOptions).toHaveBeenCalledWith(
          new URLSearchParams({
            ...(query.ticketId ? { ticketId } : {}),
            ...(query.assetId ? { assetIds: assetId } : {}),
          }).toString(),
        );
        expect(api.changeOptions).not.toHaveBeenCalled();
      });
    }
  it('preserves a valid empty candidate DTO for the existing form', async () => {
    const empty = { owners: [], approvers: [], assets: [], tickets: [] };
    vi.mocked(api.changeFormOptions).mockResolvedValue({ ok: true, data: empty });
    expect(await render()).toContain('data-plan-probe');
    expect(vi.mocked(ChangePlanForm).mock.calls[0][0].options).toBe(empty);
  });
  it.each(['none', 'ticket', 'asset', 'both'])(
    'retries only valid seeds for %s and a single safe return path',
    async (shape) => {
      failure();
      const query = {
        ...(shape === 'ticket' || shape === 'both' ? { ticketId } : {}),
        ...(shape === 'asset' || shape === 'both' ? { assetId } : {}),
      };
      const html = await render({
        ...query,
        returnTo: '/changes?state=review&page=2&saved=1#list',
        saved: '1',
        created: '1',
        updated: '1',
        unknown: 'PRIVATE',
      });
      const target = new URL(
        links(html).find((x) => x.label === '再取得する')!.href,
        'https://solvi.local',
      );
      expect(target.pathname).toBe('/changes/new');
      expect(Object.fromEntries(target.searchParams)).toEqual({
        ...query,
        returnTo: '/changes?state=review&page=2#list',
      });
      expect(links(html).find((x) => x.label === '元の画面へ戻る')).toEqual({
        href: '/changes?state=review&page=2#list',
        label: '元の画面へ戻る',
        native: true,
      });
    },
  );
  it.each(['ABCDEFAB-CDEF-0000-0000-ABCDEFABCDEF', '00000000-0000-0000-0000-000000000000'])(
    'keeps backend compatible UUID case/version shape %s',
    async (seed) => {
      expect(z.string().uuid().safeParse(seed).success).toBe(true);
      failure();
      const html = await render({ ticketId: seed, assetId: seed });
      expect(new URL(links(html)[0].href, 'https://solvi.local').searchParams.get('ticketId')).toBe(
        seed,
      );
      expect(new URL(links(html)[0].href, 'https://solvi.local').searchParams.get('assetId')).toBe(
        seed,
      );
    },
  );
  it.each([
    'bad',
    '',
    '.',
    '..',
    '../x',
    '{07500000-0000-4000-8000-000000000010}',
    '07500000000040008000000000000010',
  ])('drops invalid retry seed %s without changing initial GET acceptance', async (seed) => {
    failure();
    const html = await render({ ticketId: seed, assetId: seed });
    expect(links(html)[0].href).toBe('/changes/new');
    expect(api.changeFormOptions).toHaveBeenCalledWith(
      new URLSearchParams(seed ? { ticketId: seed, assetIds: seed } : {}).toString(),
    );
  });
  it('drops plural seeds and return paths only from retry, keeping the old initial query behavior', async () => {
    failure();
    const html = await render({
      ticketId: [ticketId, ticketId],
      assetId: [assetId, assetId],
      returnTo: ['/changes', '/portal'],
    });
    expect(links(html)[0].href).toBe('/changes/new');
    expect(links(html).some((x) => x.label === '元の画面へ戻る')).toBe(false);
    expect(api.changeFormOptions).toHaveBeenCalledWith(
      new URLSearchParams({
        ticketId: `${ticketId},${ticketId}`,
        assetIds: `${assetId},${assetId}`,
      }).toString(),
    );
  });
  it.each([
    'https://outside.example',
    '//outside.example',
    '/admin',
    '/changes\\x',
    '/changes\nx',
    '/changes x',
  ])('drops unsafe return path %s', async (returnTo) => {
    failure();
    const html = await render({ ticketId, returnTo });
    const url = new URL(links(html)[0].href, 'https://solvi.local');
    expect(url.searchParams.has('returnTo')).toBe(false);
    expect(url.searchParams.get('ticketId')).toBe(ticketId);
    expect(links(html).some((x) => x.label === '元の画面へ戻る')).toBe(false);
  });
});
describe('dedicated change form options transport', () => {
  it('uses the fixed options path, encoded query, cookie, no-store and abort signal', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(options), { headers: { 'set-cookie': 'synthetic=refreshed' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const query = new URLSearchParams({ q: '合成 &?', ticketId, assetIds: assetId }).toString();
    expect(await reader.changeFormOptions(query)).toEqual({
      ok: true,
      data: options,
      setCookie: 'synthetic=refreshed',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://api:3001/changes/options?' + query);
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.get('content-type')).toBe('application/json');
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic-session');
    expect(jar.calls).toBe(1);
  });
  it.each([400, 401, 403, 404, 500, 502, 503])(
    'keeps received HTTP %i without reading conflicting body',
    async (status) => {
      const text = vi.fn(() => Promise.resolve('{"status":200,"detail":"PRIVATE"}'));
      let signal!: AbortSignal;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url, init) => {
          signal = init.signal;
          return Promise.resolve({ ok: false, status, text, headers: new Headers() });
        }),
      );
      expect(await reader.changeFormOptions()).toEqual({
        ok: false,
        problem: { status, title: '入力候補を取得できませんでした' },
      });
      expect(signal.aborted).toBe(true);
      expect(text).not.toHaveBeenCalled();
    },
  );
  it.each([401, 403, 404, 500])(
    'does not await denied HTTP %i body or stream cancel',
    async (status) => {
      const text = vi.fn(() => new Promise(() => {})),
        cancel = vi.fn(() => new Promise(() => {}));
      let signal!: AbortSignal;
      vi.stubGlobal(
        'fetch',
        vi.fn((_url, init) => {
          signal = init.signal;
          return Promise.resolve({
            ok: false,
            status,
            text,
            body: { cancel },
            headers: new Headers(),
          });
        }),
      );
      expect(await reader.changeFormOptions()).toEqual({
        ok: false,
        problem: { status, title: '入力候補を取得できませんでした' },
      });
      expect(signal.aborted).toBe(true);
      expect(text).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    },
  );
  it('classifies fetch failure as 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    expect(await reader.changeFormOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: '入力候補を取得できませんでした' },
    });
  });
  it('classifies cookie failure as 503 without fetching', async () => {
    jar.reject = true;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await reader.changeFormOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: '入力候補を取得できませんでした' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies an interrupted 200 body as 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(new Error('PRIVATE_CUT')),
      }),
    );
    expect(await reader.changeFormOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: '入力候補を取得できませんでした' },
    });
  });
  it('classifies invalid JSON as 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_JSON')));
    expect(await reader.changeFormOptions()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('keeps empty successful body transport as an empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    expect(await reader.changeFormOptions()).toEqual({ ok: true, data: {} });
  });
  it('preserves 204/set-cookie without body read; page DTO strictness is outside scope', async () => {
    const text = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers({ 'set-cookie': 'synthetic=refreshed' }),
        text,
      }),
    );
    expect(await reader.changeFormOptions()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=refreshed',
    });
    expect(text).not.toHaveBeenCalled();
  });
  it('omits a cookie header for an empty jar', async () => {
    jar.empty = true;
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(options)));
    vi.stubGlobal('fetch', fetch);
    await reader.changeFormOptions();
    expect(fetch.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
});
