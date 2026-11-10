// NFR-UX-002, NFR-UX-003, NFR-UX-004: catalog management entry GET recovery.
// Unit form probes are separate from the real form in the production Next harness.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type SessionView } from '../../apps/web/src/lib/api';
import { CatalogAdminForm } from '../../apps/web/src/components/CatalogAdminForm';
import { notFound } from 'next/navigation';
const jar = vi.hoisted(() => ({ calls: 0, reject: false, empty: false }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    jar.calls++;
    if (jar.reject) throw new Error('PRIVATE_COOKIE');
    return { getAll: () => (jar.empty ? [] : [{ name: 'solvi_session', value: 'synthetic' }]) };
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { catalogManagementRead: vi.fn(), catalogAdmin: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/CatalogAdminForm', () => ({
  CatalogAdminForm: vi.fn(() => createElement('form', { 'data-unit-probe': true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  usePathname: () => '/catalog/manage',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
type Page = (p: { searchParams: Promise<Query> }) => Promise<ReactNode>;
const { default: Manage } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/catalog/manage/page',
);
const { default: New } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/catalog/manage/new/page',
);
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '07700000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '07700000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'org_admin', organizationId: org }],
};
const data = {
  viewerId: session.userId,
  owners: [],
  groups: [],
  questionSets: [],
  canCreate: true,
  canPublish: true,
  canManageQuestionSets: true,
  items: [
    {
      id: '07700000-0000-4000-8000-000000000010',
      code: 'a-draft',
      editVersion: 1,
      draftRevision: 1,
      publishedRevision: null,
      active: false,
      title: '合成下書き',
      description: '合成説明A',
    },
    {
      id: '07700000-0000-4000-8000-000000000011',
      code: 'b-live',
      editVersion: 2,
      draftRevision: 1,
      publishedRevision: 1,
      active: true,
      title: '合成公開',
      description: '合成説明B',
    },
    {
      id: '07700000-0000-4000-8000-000000000012',
      code: 'c-changed',
      editVersion: 4,
      draftRevision: 2,
      publishedRevision: 1,
      active: true,
      title: '合成未公開変更',
      description: '合成説明C',
    },
  ],
  approvers: [
    { id: '07700000-0000-4000-8000-000000000003', name: '合成承認者A' },
    { id: '07700000-0000-4000-8000-000000000004', name: '合成承認者B' },
  ],
};
const render = async (page: Page, q: Query = {}) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve(q) }));
const failure = (status = 503) =>
  vi.mocked(api.catalogManagementRead).mockResolvedValue({
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
  jar.calls = 0;
  jar.reject = false;
  jar.empty = false;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.catalogManagementRead).mockResolvedValue({ ok: true, data });
});
afterEach(() => vi.unstubAllGlobals());
for (const [label, page, path, fallback] of [
  ['manage', Manage, '/catalog/manage', '/catalog'],
  ['new', New, '/catalog/manage/new', '/catalog/manage'],
] as const) {
  describe(label + ' page recovery', () => {
    it('requires session before GET; session refusal reads nothing', async () => {
      vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
      await expect(render(page)).rejects.toThrow('SESSION_DENIED');
      expect(api.catalogManagementRead).not.toHaveBeenCalled();
    });
    it('adopts only dedicated fixed GET after session', async () => {
      await render(page);
      expect(api.catalogManagementRead).toHaveBeenCalledExactlyOnceWith();
      expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(api.catalogManagementRead).mock.invocationCallOrder[0],
      );
      expect(api.catalogAdmin).not.toHaveBeenCalled();
    });
    it.each([400, 401, 500, 502, 503])(
      'fixed status %s has no private DTO or form',
      async (status) => {
        failure(status);
        const html = await render(page);
        expect(html).toContain('role="alert"');
        expect(html).toContain(
          label === 'manage'
            ? 'カタログ管理を読み込めませんでした'
            : '承認者の候補を読み込めませんでした',
        );
        expect(html).toContain(
          status === 401 ? 'ログイン状態' : status === 400 ? '開き直してください' : '時間をおいて',
        );
        expect(html).not.toMatch(/PRIVATE|合成|<form/);
        expect(CatalogAdminForm).not.toHaveBeenCalled();
        expect(notFound).not.toHaveBeenCalled();
        expect(links(html).every((x) => x.native)).toBe(true);
      },
    );
    it.each([403, 404])('retains notFound status %s', async (status) => {
      failure(status);
      await expect(render(page)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(CatalogAdminForm).not.toHaveBeenCalled();
    });
    it('native retry and fallback retain only safe single returnTo', async () => {
      failure();
      const target = '/catalog?q=合成&saved=1';
      const html = await render(page, { returnTo: target, unknown: 'PRIVATE', created: '1' });
      const l = links(html),
        retry = new URL(l.find((x) => x.label === '再取得する')!.href, 'https://solvi.local');
      expect(retry.pathname).toBe(path);
      expect([...retry.searchParams.keys()]).toEqual(['returnTo']);
      expect(retry.searchParams.get('returnTo')).toBe('/catalog?q=%E5%90%88%E6%88%90');
      expect(l.map((x) => x.href)).toContain(fallback);
      expect(l.map((x) => x.href)).toContain('/portal');
      expect(l.map((x) => x.label)).toContain('元の画面へ戻る');
    });
    it.each(
      [
        'https://example.invalid',
        ['/catalog', '/portal'],
        '//example.invalid',
        '/catalog\\private',
      ].map((value) => ({ value })),
    )('rejects unsafe or plural returnTo $value', async ({ value }) => {
      failure();
      const html = await render(page, { returnTo: value });
      expect(links(html).find((x) => x.label === '再取得する')!.href).toBe(path);
      expect(html).not.toContain('元の画面へ戻る');
    });
  });
}
describe('normal renderer boundary', () => {
  it('preserves list labels, descriptions, code order and creation link', async () => {
    const html = await render(Manage);
    expect(html).toContain('非公開');
    expect(html).toContain('公開中（版1）');
    expect(html).toContain('未公開の変更あり');
    expect(html.indexOf('合成下書き')).toBeLessThan(html.indexOf('合成公開'));
    expect(html.indexOf('合成公開')).toBeLessThan(html.indexOf('合成未公開変更'));
    expect(html).toContain('合成説明C');
    expect(html).toContain('管理コード: c-changed');
    expect(html).toContain('/catalog/manage/new');
    expect(CatalogAdminForm).not.toHaveBeenCalled();
  });
  it('preserves successful empty list guidance', async () => {
    vi.mocked(api.catalogManagementRead).mockResolvedValue({
      ok: true,
      data: { ...data, items: [] },
    });
    const html = await render(Manage);
    expect(html).toContain('まだサービスがありません。最初の下書きを作成してください。');
    expect(html).not.toContain('role="alert"');
  });
  it.each([{ approvers: data.approvers }, { approvers: [] }])(
    'preserves new form props and simulation-only copy',
    async ({ approvers }) => {
      vi.mocked(api.catalogManagementRead).mockResolvedValue({
        ok: true,
        data: { ...data, approvers },
      });
      const html = await render(New);
      expect(html).toContain('ローカルの模擬申請専用です。');
      expect(CatalogAdminForm).toHaveBeenCalled();
      expect(vi.mocked(CatalogAdminForm).mock.calls[0][0]).toEqual({
        approvers,
        options: { ...data, approvers },
        initialContent: undefined,
      });
    },
  );
});
describe('dedicated fixed GET transport', () => {
  it('sends fixed URL cookie, content type, no-store and signal without write method', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(data), { headers: { 'set-cookie': 'synthetic-response' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await reader.catalogManagementRead();
    expect(result).toEqual({ ok: true, data, setCookie: 'synthetic-response' });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toMatch(/\/catalog-admin$/);
    expect(init.method).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic');
    expect(init.headers.get('content-type')).toBe('application/json');
  });
  it('empty cookie jar has no cookie header', async () => {
    jar.empty = true;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetcher);
    await reader.catalogManagementRead();
    expect(fetcher.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 500, 502, 503])(
    'status %s rejects body synchronously',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('PRIVATE_BODY'));
      const fetcher = vi.fn().mockResolvedValue({ ok: false, status, text });
      vi.stubGlobal('fetch', fetcher);
      const result = await reader.catalogManagementRead();
      expect(result).toEqual({
        ok: false,
        problem: { status, title: 'カタログ管理を取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    },
  );
  it('network failure is fixed 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    expect(await reader.catalogManagementRead()).toEqual({
      ok: false,
      problem: { status: 503, title: 'カタログ管理を取得できませんでした' },
    });
  });
  it('200 body interruption is fixed 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: vi.fn().mockRejectedValue(new Error('PRIVATE_CUT')),
      }),
    );
    expect(await reader.catalogManagementRead()).toEqual({
      ok: false,
      problem: { status: 503, title: 'カタログ管理を取得できませんでした' },
    });
  });
  it('invalid JSON is fixed 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_INVALID')));
    expect(await reader.catalogManagementRead()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('204 preserves transport no-body behavior and set-cookie, not a page DTO claim', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic-response' } }),
        ),
    );
    expect(await reader.catalogManagementRead()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic-response',
    });
  });
  it('cookie failure is fixed 503 without fetch', async () => {
    jar.reject = true;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await reader.catalogManagementRead()).toEqual({
      ok: false,
      problem: { status: 503, title: 'カタログ管理を取得できませんでした' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
