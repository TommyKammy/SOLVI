// NFR-UX-002, NFR-UX-003, NFR-UX-004: public request-entry GET recovery.
// Form props are probed here; the isolated Next harness renders the real RequestForm.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type SessionView,
  type CatalogItem,
} from '../../apps/web/src/lib/api';
import { RequestForm } from '../../apps/web/src/components/RequestForms';
import { notFound } from 'next/navigation';
const jar = vi.hoisted(() => ({ reject: false, empty: false }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    if (jar.reject) throw new Error('PRIVATE_COOKIE');
    return { getAll: () => (jar.empty ? [] : [{ name: 'solvi_session', value: 'synthetic' }]) };
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { catalogRequestOptions: vi.fn(), catalog: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/RequestForms', () => ({
  RequestForm: vi.fn(() => createElement('form', { 'data-unit-probe': true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  usePathname: () => '/catalog/item',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (p: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...p, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
type Page = (p: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Query>;
}) => Promise<ReactNode>;
const { default: Page } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/catalog/[itemId]/page',
);
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '07900000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '07900000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};
const item: CatalogItem = {
  id: '07900000-0000-4000-8000-00000000001a',
  version: 2,
  title: '合成公開サービス',
  description: '公開版の合成説明',
  definition: {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成対象',
    allowedDurations: [7, 30],
    maxReasonLength: 120,
    approval: { mode: 'fixed', approverId: '07900000-0000-4000-8000-000000000003' },
    fields: [],
  },
};
const approvers = [{ id: item.definition.approval!.approverId, name: '合成承認者' }];
const data = { items: [item], approvers, canManage: false, simulation: true };
const render = async (q: Query = {}, id = item.id) =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ itemId: id }), searchParams: Promise.resolve(q) }),
  );
const fail = (status = 503) =>
  vi.mocked(api.catalogRequestOptions).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' },
  });
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  jar.reject = false;
  jar.empty = false;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.catalogRequestOptions).mockResolvedValue({ ok: true, data });
});
afterEach(() => vi.unstubAllGlobals());
describe('public catalog entry renderer', () => {
  it('requires session before fixed GET and does not call old shared reader', async () => {
    await render();
    expect(api.catalogRequestOptions).toHaveBeenCalledExactlyOnceWith();
    expect(api.catalog).not.toHaveBeenCalled();
    expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.catalogRequestOptions).mock.invocationCallOrder[0],
    );
  });
  it('session refusal reads no catalog', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.catalogRequestOptions).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 500, 502, 503])(
    'HTTP %s stays failure, not missing item',
    async (status) => {
      fail(status);
      const html = await render();
      expect(html).toContain('申請画面を表示できません');
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        status === 401
          ? 'ログイン状態'
          : status === 403
            ? '表示する権限'
            : status === 400
              ? '取得条件'
              : status === 404
                ? 'サービスカタログを利用'
                : '一時的に申請画面',
      );
      expect(html).not.toMatch(/PRIVATE|合成|<form/);
      expect(RequestForm).not.toHaveBeenCalled();
      expect(notFound).not.toHaveBeenCalled();
      expect(links(html).every((x) => x.native)).toBe(true);
    },
  );
  it.each(['requester', 'approver', 'agent', 'org_admin'])(
    'retains successful public projection for %s',
    async (roleCode) => {
      vi.mocked(requireSession).mockResolvedValue({
        ...session,
        roles: [{ roleCode, organizationId: org }],
      });
      const html = await render();
      expect(html).toContain(item.title);
      expect(html).toContain(item.description);
      expect(html).toContain('ローカル模擬申請です');
      expect(html).toContain('固定の承認者が確認');
      expect(vi.mocked(RequestForm).mock.calls[0][0]).toEqual({
        item,
        approvers,
        scope: `${org}:${session.userId}`,
      });
      expect(notFound).not.toHaveBeenCalled();
    },
  );
  it.each([[], [{ id: '07900000-0000-4000-8000-000000000004', name: '別候補' }]])(
    'passes unavailable fixed candidates unchanged to the real form boundary',
    async (candidates) => {
      vi.mocked(api.catalogRequestOptions).mockResolvedValue({
        ok: true,
        data: { ...data, approvers: candidates },
      });
      await render();
      expect(vi.mocked(RequestForm).mock.calls[0][0]).toEqual({
        item,
        approvers: candidates,
        scope: `${org}:${session.userId}`,
      });
    },
  );
  it.each(['missing', item.id.toUpperCase()])(
    'only healthy unmatched ID is notFound: %s',
    async (id) => {
      await expect(render({}, id)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(api.catalogRequestOptions).toHaveBeenCalledExactlyOnceWith();
      expect(RequestForm).not.toHaveBeenCalled();
    },
  );
  it('native same-path retry retains only single sanitized returnTo', async () => {
    fail();
    const html = await render({
      returnTo: '/catalog?q=合成&saved=1',
      created: '1',
      unknown: 'PRIVATE',
    });
    const l = links(html);
    const r = new URL(l.find((x) => x.label === '再取得する')!.href, 'https://solvi.local');
    expect(r.pathname).toBe(`/catalog/${item.id}`);
    expect([...r.searchParams.keys()]).toEqual(['returnTo']);
    expect(r.searchParams.get('returnTo')).toBe('/catalog?q=%E5%90%88%E6%88%90');
    expect(l.find((x) => x.label === '元の画面へ戻る')!.href).toBe('/catalog?q=%E5%90%88%E6%88%90');
    expect(l.find((x) => x.label === 'ポータルへ戻る')!.href).toBe('/portal');
  });
  it.each(
    [
      undefined,
      'https://example.invalid',
      '//example.invalid',
      '/catalog\\bad',
      ['/catalog', '/portal'],
    ].map((value) => ({ value })),
  )('unsafe/plural/missing returnTo uses fixed fallback $value', async ({ value }) => {
    fail();
    const l = links(await render({ returnTo: value }));
    expect(l.find((x) => x.label === '再取得する')!.href).toBe(`/catalog/${item.id}`);
    expect(l.find((x) => x.label === 'カタログへ戻る')!.href).toBe('/catalog');
    expect(l.some((x) => x.label === '元の画面へ戻る')).toBe(false);
  });
  it.each(['legacy-code', '日本語 /?#', '%2E%2E'])(
    'does not impose UUID validation and safely encodes %s',
    async (id) => {
      fail();
      const l = links(await render({}, id));
      expect(l.find((x) => x.label === '再取得する')!.href).toBe(
        '/catalog/' + encodeURIComponent(id),
      );
      expect(api.catalogRequestOptions).toHaveBeenCalledExactlyOnceWith();
    },
  );
  it.each(['', '.', '..', '\ud800'])('unsafe path value omits only retry %s', async (id) => {
    fail();
    const l = links(await render({}, id));
    expect(l.some((x) => x.label === '再取得する')).toBe(false);
    expect(l.map((x) => x.href)).toEqual(['/catalog', '/portal']);
    expect(api.catalogRequestOptions).toHaveBeenCalledExactlyOnceWith();
  });
});
describe('dedicated fixed catalog GET transport', () => {
  it('uses fixed URL cookie no-store signal and keeps JSON/set-cookie', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(data), { headers: { 'set-cookie': 'synthetic-response' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await reader.catalogRequestOptions()).toEqual({
      ok: true,
      data,
      setCookie: 'synthetic-response',
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toMatch(/\/catalog$/);
    expect(init.method).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic');
    expect(init.headers.get('content-type')).toBe('application/json');
  });
  it('empty cookie jar omits cookie', async () => {
    jar.empty = true;
    const f = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', f);
    await reader.catalogRequestOptions();
    expect(f.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 500, 502, 503])(
    'HTTP %s is authoritative; does not read conflicting/cut body or await cancel',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('PRIVATE_CUT'));
      const cancel = vi.fn(() => new Promise(() => {}));
      const f = vi.fn().mockResolvedValue({
        ok: false,
        status,
        text,
        body: { cancel },
        json: () => ({ status: 200, title: 'PRIVATE' }),
      });
      vi.stubGlobal('fetch', f);
      expect(await reader.catalogRequestOptions()).toEqual({
        ok: false,
        problem: { status, title: 'サービスカタログを取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(f.mock.calls[0][1].signal.aborted).toBe(true);
    },
  );
  it('network failure is fixed 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    expect(await reader.catalogRequestOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: 'サービスカタログを取得できませんでした' },
    });
  });
  it('successful body cut is fixed 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: vi.fn().mockRejectedValue(new Error('PRIVATE_CUT')),
      }),
    );
    expect(await reader.catalogRequestOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: 'サービスカタログを取得できませんでした' },
    });
  });
  it('invalid JSON is fixed 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_INVALID')));
    expect(await reader.catalogRequestOptions()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('204 preserves transport-only undefined and set-cookie (not form data)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic-response' } }),
        ),
    );
    expect(await reader.catalogRequestOptions()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic-response',
    });
  });
  it('cookie failure is fixed503 without fetch', async () => {
    jar.reject = true;
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await reader.catalogRequestOptions()).toEqual({
      ok: false,
      problem: { status: 503, title: 'サービスカタログを取得できませんでした' },
    });
    expect(f).not.toHaveBeenCalled();
  });
});
