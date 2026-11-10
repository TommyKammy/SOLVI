// NFR-UX-002, NFR-UX-003, NFR-UX-004. Unit component probes are separate from the real-form UI harness.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  api,
  requireSession,
  type CatalogAdminDetail,
  type SessionView,
} from '../../apps/web/src/lib/api';
import {
  CatalogAdminForm,
  CatalogPublicationForm,
  CatalogPreview,
} from '../../apps/web/src/components/CatalogAdminForm';
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
  api: { catalogManagementDetail: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/CatalogAdminForm', () => ({
  CatalogAdminForm: vi.fn(() => createElement('form', { 'data-admin-probe': true })),
  CatalogPublicationForm: vi.fn(() => createElement('form', { 'data-publication-probe': true })),
  CatalogPreview: vi.fn(() => createElement('section', { 'data-preview-probe': true })),
  CatalogManagement: vi.fn(({ item }: { item: CatalogAdminDetail }) =>
    createElement(
      'div',
      null,
      createElement(CatalogPreview, {
        title: item.draft.title,
        description: item.draft.description,
        definition: item.draft.definition,
        approvers: item.approvers,
      }),
      createElement(CatalogPublicationForm, {
        item,
        feedback: { message: '' },
        action: () => {},
        pending: false,
        blocked: () => false,
      }),
      createElement(CatalogAdminForm, { item, approvers: item.approvers }),
    ),
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  usePathname: () => '/catalog/manage/07800000-0000-4000-8000-000000000010',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (p: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...p, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: Page } = await vi.importActual<{
  default: (p: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/catalog/manage/[id]/page');
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '07800000-0000-4000-8000-000000000010';
const org = '07800000-0000-4000-8000-000000000001';
const user = '07800000-0000-4000-8000-000000000002';
const approver = '07800000-0000-4000-8000-000000000003';
const session: SessionView = {
  userId: user,
  organizationId: org,
  roles: [{ roleCode: 'org_admin', organizationId: org }],
};
function detail(view = 'draft'): CatalogAdminDetail {
  const newer = ['edited', 'inactive', 'invalid-approver'].includes(view);
  const makeRevision = (n: number, invalid = false) => ({
    revision: n,
    title: n === 1 ? '合成のカタログ定義' : '合成の新カタログ定義',
    description: '合成の説明',
    definition: {
      mode: 'local_simulation',
      action: 'simulate.access_grant',
      targetLabel: '合成の対象',
      allowedDurations: [7, 30, 90],
      maxReasonLength: 1500,
      approval: {
        mode: 'fixed',
        approverId: invalid ? '07800000-0000-4000-8000-000000000004' : approver,
      },
      fields: [{ key: 'department', label: '部署', type: 'text', required: true, maxLength: 80 }],
    },
  });
  return {
    id,
    code: 'synthetic-catalog-078',
    editVersion: view === 'draft' ? 1 : view === 'published' ? 2 : view === 'inactive' ? 4 : 3,
    active: !['draft', 'inactive'].includes(view),
    canEdit: true,
    canCreate: true,
    canPublish: true,
    canManageQuestionSets: true,
    viewerId: user,
    owners: [],
    groups: [],
    questionSets: [],
    publishedRevision: view === 'draft' ? null : 1,
    draft: makeRevision(newer ? 2 : 1, view === 'invalid-approver'),
    published: view === 'draft' ? null : makeRevision(1),
    history: [
      ...(newer
        ? [{ revision: 2, title: '合成の新カタログ定義', createdAt: '2026-10-09T15:10:00.000Z' }]
        : []),
      { revision: 1, title: '合成のカタログ定義', createdAt: '2026-10-09T14:10:00.000Z' },
    ],
    approvers: [{ id: approver, name: '合成の有効承認者' }],
  } as CatalogAdminDetail;
}
async function render(query: Query = {}, itemId = id) {
  return renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id: itemId }), searchParams: Promise.resolve(query) }),
  );
}
function failure(status = 503) {
  vi.mocked(api.catalogManagementDetail).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_PROBLEM', detail: 'PRIVATE_DETAIL' },
  });
}
function links(html: string) {
  return [...html.matchAll(/<a([^>]+)>(.*?)<\/a>/g)].map((m) => ({
    href: m[1].match(/href="([^"]*)"/)?.[1].replaceAll('&amp;', '&'),
    label: m[2],
    native: !m[1].includes('data-next-link'),
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  jar.calls = 0;
  jar.reject = false;
  jar.empty = false;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.catalogManagementDetail).mockResolvedValue({ ok: true, data: detail() });
});
afterEach(() => vi.unstubAllGlobals());
describe('catalog management detail page', () => {
  it('requires session before params/query and reads nothing on refusal', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_REQUIRED'));
    const params = { then: vi.fn() } as unknown as Promise<{ id: string }>;
    const query = { then: vi.fn() } as unknown as Promise<Query>;
    await expect(Page({ params, searchParams: query })).rejects.toThrow('SESSION_REQUIRED');
    expect(api.catalogManagementDetail).not.toHaveBeenCalled();
    expect(CatalogAdminForm).not.toHaveBeenCalled();
    expect(params.then).not.toHaveBeenCalled();
    expect(query.then).not.toHaveBeenCalled();
  });
  it('waits for params and query before the detail GET', async () => {
    let resolve!: (x: Query) => void;
    const searchParams = new Promise<Query>((r) => {
      resolve = r;
    });
    const pending = Page({ params: Promise.resolve({ id }), searchParams });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.catalogManagementDetail).not.toHaveBeenCalled();
    resolve({});
    await pending;
    expect(api.catalogManagementDetail).toHaveBeenCalledWith(id);
  });
  it.each([403, 404])('preserves HTTP %i notFound', async (status) => {
    failure(status);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(redirect).not.toHaveBeenCalled();
    expect(CatalogAdminForm).not.toHaveBeenCalled();
  });
  it.each([400, 401, 500, 502, 503])(
    'uses fixed Japanese recovery for HTTP %i with no private data or forms',
    async (status) => {
      failure(status);
      const html = await render({ saved: '1', unknown: 'PRIVATE_QUERY' });
      expect(html).toContain('<h1>カタログ項目を読み込めませんでした</h1>');
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        status === 400
          ? 'カタログ管理から項目を選び直してください'
          : status === 401
            ? 'ログイン状態を確認できませんでした'
            : '時間をおいて、もう一度お試しください',
      );
      for (const x of [
        'PRIVATE',
        '<form',
        '<input',
        '合成のカタログ定義',
        '合成の有効承認者',
        '保存した定義の版',
        'カタログ設定を保存しました',
      ])
        expect(html).not.toContain(x);
      expect(CatalogAdminForm).not.toHaveBeenCalled();
      expect(CatalogPublicationForm).not.toHaveBeenCalled();
      expect(CatalogPreview).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(links(html)).toEqual([
        { href: '/catalog/manage/' + id, label: '再取得する', native: true },
        { href: '/catalog/manage', label: 'カタログ管理へ戻る', native: true },
        { href: '/portal', label: 'ポータルへ戻る', native: true },
      ]);
    },
  );
  for (const role of ['org_admin', 'platform_admin'])
    for (const view of ['draft', 'published', 'edited', 'inactive', 'invalid-approver']) {
      it(`preserves successful ${role}/${view} component props, active link, flash and history`, async () => {
        vi.mocked(requireSession).mockResolvedValue({
          ...session,
          roles: [{ roleCode: role, organizationId: role === 'platform_admin' ? null : org }],
        });
        const data = detail(view);
        vi.mocked(api.catalogManagementDetail).mockResolvedValue({ ok: true, data });
        const html = await render({ saved: '1' });
        expect(html).toContain('<h1>' + data.draft.title + '</h1>');
        expect(html).toContain('カタログ設定を保存しました');
        expect(html).toContain('保存した定義の版');
        expect(vi.mocked(CatalogAdminForm).mock.calls[0][0]).toMatchObject({
          item: data,
          approvers: data.approvers,
        });
        expect(vi.mocked(CatalogPublicationForm).mock.calls[0][0]).toMatchObject({ item: data });
        expect(vi.mocked(CatalogPreview).mock.calls[0][0]).toMatchObject({
          title: data.draft.title,
          description: data.draft.description,
          definition: data.draft.definition,
          approvers: data.approvers,
        });
        expect(html.includes('現在の公開フォームを見る')).toBe(data.active);
        expect(html.includes('最後に公開した版')).toBe(data.publishedRevision !== null);
        if (data.draft.revision === 2)
          expect(html.indexOf('版2 ·')).toBeLessThan(html.indexOf('版1 ·'));
        expect(html).not.toContain('再取得する');
        expect(notFound).not.toHaveBeenCalled();
      });
    }
  it('retains only safe single returnTo and same ID on retry', async () => {
    failure();
    const html = await render({
      returnTo: '/catalog/manage?saved=1#items',
      saved: '1',
      created: '1',
      unknown: 'PRIVATE',
    });
    const retry = new URL(links(html)[0].href!, 'https://solvi.local');
    expect(retry.pathname).toBe('/catalog/manage/' + id);
    expect(Object.fromEntries(retry.searchParams)).toEqual({ returnTo: '/catalog/manage#items' });
    expect(links(html)[1]).toEqual({
      href: '/catalog/manage#items',
      label: '元の画面へ戻る',
      native: true,
    });
  });
  it.each([
    'https://outside.example',
    '//outside.example',
    '/admin',
    '/catalog\\x',
    '/catalog\nx',
    '/catalog x',
  ])('drops unsafe returnTo %s', async (returnTo) => {
    failure();
    const html = await render({ returnTo });
    expect(links(html)[0].href).toBe('/catalog/manage/' + id);
    expect(html).not.toContain('元の画面へ戻る');
  });
  it('drops plural returnTo', async () => {
    failure();
    const html = await render({ returnTo: ['/catalog/manage', '/portal'] });
    expect(links(html)[0].href).toBe('/catalog/manage/' + id);
    expect(html).not.toContain('元の画面へ戻る');
  });
  it.each(['ABCDEFAB-CDEF-0000-0000-ABCDEFABCDEF', '00000000-0000-0000-0000-000000000000'])(
    'preserves backend compatible UUID %s on retry',
    async (value) => {
      expect(z.string().uuid().safeParse(value).success).toBe(true);
      failure();
      expect(links(await render({}, value))[0].href).toBe('/catalog/manage/' + value);
    },
  );
  it.each([
    'bad',
    '',
    '.',
    '..',
    '../x',
    '{07800000-0000-4000-8000-000000000010}',
    '07800000000040008000000000000010',
  ])('has no retry for invalid ID %s', async (value) => {
    failure(400);
    const html = await render({}, value);
    expect(html).not.toContain('再取得する');
    expect(html).not.toContain('<form');
  });
});
describe('dedicated catalog management detail transport', () => {
  it('uses a fixed encoded GET path, cookies, no-store and abort signal', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(detail()), {
        headers: { 'set-cookie': 'synthetic=refreshed' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await reader.catalogManagementDetail(id)).toEqual({
      ok: true,
      data: detail(),
      setCookie: 'synthetic=refreshed',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://api:3001/catalog-admin/' + encodeURIComponent(id));
    expect(init.method).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic-session');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(['ABCDEFAB-CDEF-0000-0000-ABCDEFABCDEF', '00000000-0000-0000-0000-000000000000'])(
    'allows lexical case/version shape %s',
    async (value) => {
      expect(z.string().uuid().safeParse(value).success).toBe(true);
      const fetch = vi.fn().mockResolvedValue(new Response('{}'));
      vi.stubGlobal('fetch', fetch);
      expect((await reader.catalogManagementDetail(value)).ok).toBe(true);
      expect(fetch.mock.calls[0][0]).toBe('http://api:3001/catalog-admin/' + value);
    },
  );
  it.each([
    'bad',
    '',
    '.',
    '..',
    '../x',
    '{07800000-0000-4000-8000-000000000010}',
    '07800000000040008000000000000010',
    undefined,
    null,
    ['07800000-0000-4000-8000-000000000010'],
  ])('rejects invalid ID before cookies/fetch %j', async (value) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await reader.catalogManagementDetail(value as string)).toEqual({
      ok: false,
      problem: { status: 400, title: 'カタログ項目を取得できませんでした' },
    });
    expect(jar.calls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 500, 502, 503])(
    'keeps received HTTP %i without reading a conflicting body',
    async (status) => {
      const text = vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ status: status === 403 ? 503 : 404, title: 'PRIVATE' }),
        );
      const response = { ok: false, status, text };
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      expect(await reader.catalogManagementDetail(id)).toEqual({
        ok: false,
        problem: { status, title: 'カタログ項目を取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    },
  );
  it.each([401, 403, 404, 500])('does not await denied HTTP %i body/cancel', async (status) => {
    const text = vi.fn(() => new Promise(() => {})),
      cancel = vi.fn(() => new Promise(() => {}));
    const fetch = vi.fn().mockResolvedValue({ ok: false, status, text, body: { cancel } });
    vi.stubGlobal('fetch', fetch);
    const result = await Promise.race([
      reader.catalogManagementDetail(id),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 100)),
    ]);
    expect(result).toEqual({
      ok: false,
      problem: { status, title: 'カタログ項目を取得できませんでした' },
    });
    expect(text).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('classifies fetch failure as 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    expect(await reader.catalogManagementDetail(id)).toEqual({
      ok: false,
      problem: { status: 503, title: 'カタログ項目を取得できませんでした' },
    });
  });
  it('classifies cookie failure as 503 without fetching', async () => {
    jar.reject = true;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await reader.catalogManagementDetail(id)).toEqual({
      ok: false,
      problem: { status: 503, title: 'カタログ項目を取得できませんでした' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies interrupted 200 body as 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => {
          throw new Error('PRIVATE_CUT');
        },
      }),
    );
    expect(await reader.catalogManagementDetail(id)).toEqual({
      ok: false,
      problem: { status: 503, title: 'カタログ項目を取得できませんでした' },
    });
  });
  it('classifies invalid JSON as 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{PRIVATE')));
    expect(await reader.catalogManagementDetail(id)).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('preserves empty successful body as empty object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    expect(await reader.catalogManagementDetail(id)).toEqual({ ok: true, data: {} });
  });
  it('preserves 204/set-cookie without body read; strict page DTO is outside scope', async () => {
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
    expect(await reader.catalogManagementDetail(id)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=refreshed',
    });
    expect(text).not.toHaveBeenCalled();
  });
  it('omits cookie header for an empty jar', async () => {
    jar.empty = true;
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await reader.catalogManagementDetail(id);
    expect(fetch.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
});
