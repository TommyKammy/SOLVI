// NFR-UX-002, NFR-UX-003, NFR-UX-004: knowledge detail GET recovery.
// Unit probes preserve editor/action props; isolated Next renders the real components.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type KnowledgeArticle,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { KnowledgeManagement } from '../../apps/web/src/components/KnowledgeEditor';
import { notFound } from 'next/navigation';

const jar = vi.hoisted(() => ({ reject: false, empty: false, calls: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    jar.calls += 1;
    if (jar.reject) throw new Error('PRIVATE_COOKIE');
    return { getAll: () => (jar.empty ? [] : [{ name: 'solvi_session', value: 'synthetic' }]) };
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { knowledgeDetail: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/KnowledgeEditor', () => ({
  KnowledgeManagement: vi.fn(() => createElement('div', { 'data-management-probe': true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  usePathname: () => '/knowledge/article',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (p: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...p, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
type Page = (p: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) => Promise<ReactNode>;
const { default: Page } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/knowledge/[id]/page',
);
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '08000000-0000-4000-8000-00000000001a';
const org = '08000000-0000-4000-8000-000000000002';
const session: SessionView = {
  userId: '08000000-0000-4000-8000-000000000003',
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};
const article: KnowledgeArticle = {
  id,
  state: 'published',
  version: 2,
  publishedVersion: 2,
  contentVersion: 2,
  title: '合成公開記事',
  body: '公開本文 <script>literal</script>',
  tags: '公開タグ',
  audience: 'organization',
  versionCreatedAt: '2026-10-10T00:00:00.000Z',
};
const versions = [
  { number: 7, title: '合成編集記事', createdAt: '2026-10-10T00:00:00.000Z' },
  { number: 2, title: article.title, createdAt: '2026-10-09T00:00:00.000Z' },
];
const data = { article, versions: [] as typeof versions };
const render = async (query: Query = {}, articleId = id) =>
  renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ id: articleId }),
      searchParams: Promise.resolve(query),
    }),
  );
const fail = (status = 503) =>
  vi.mocked(api.knowledgeDetail).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' },
  });
const role = (roleCode: SessionView['roles'][number]['roleCode']) =>
  vi
    .mocked(requireSession)
    .mockResolvedValue({ ...session, roles: [{ roleCode, organizationId: org }] });
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
  jar.calls = 0;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.knowledgeDetail).mockResolvedValue({ ok: true, data });
});
afterEach(() => vi.unstubAllGlobals());

describe('knowledge detail renderer', () => {
  it('requires session before the sole reader', async () => {
    await render();
    expect(api.knowledgeDetail).toHaveBeenCalledExactlyOnceWith(id, false);
    expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.knowledgeDetail).mock.invocationCallOrder[0],
    );
  });
  it('does not read after session refusal', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.knowledgeDetail).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 409, 500, 502, 503])(
    'renders safe failure %s without article or actions',
    async (status) => {
      fail(status);
      const html = await render();
      expect(html).toContain('記事を表示できません');
      expect(html).toContain('role="alert"');
      expect(html).not.toMatch(/PRIVATE|<form|合成公開記事|公開本文/);
      expect(notFound).not.toHaveBeenCalled();
      expect(KnowledgeManagement).not.toHaveBeenCalled();
      expect(links(html)).toEqual([
        { href: `/knowledge/${id}`, label: '再取得する', native: true },
        { href: '/knowledge', label: '記事一覧へ戻る', native: true },
        { href: '/portal', label: 'ポータルへ戻る', native: true },
      ]);
      expect(html).toContain(
        status === 401
          ? 'ログインし直して'
          : status === 403
            ? '権限がありません'
            : status === 400
              ? '記事の指定が正しくありません'
              : '一時的に記事を読み込めませんでした',
      );
    },
  );
  it('retains 404 notFound', async () => {
    fail(404);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(KnowledgeManagement).not.toHaveBeenCalled();
  });
  it.each(['agent', 'org_admin', 'platform_admin'] as const)(
    'retains effective manage for %s',
    async (code) => {
      role(code);
      fail();
      const html = await render({ manage: '1', saved: '1', unknown: 'private' });
      expect(api.knowledgeDetail).toHaveBeenCalledExactlyOnceWith(id, true);
      expect(links(html)[0].href).toBe(`/knowledge/${id}?manage=1`);
      expect(links(html)[1].href).toBe('/knowledge?manage=1');
      expect(html).not.toContain('保存しました');
    },
  );
  it.each(['requester', 'approver', 'auditor'] as const)(
    'does not grant manage based on query for %s',
    async (code) => {
      role(code);
      fail();
      const html = await render({ manage: '1' });
      expect(api.knowledgeDetail).toHaveBeenCalledExactlyOnceWith(id, false);
      expect(links(html)[0].href).toBe(`/knowledge/${id}`);
    },
  );
  it('drops duplicate manage and retains a single sanitized return path', async () => {
    role('agent');
    fail();
    const html = await render({
      manage: ['1', '1'],
      returnTo: '/knowledge?q=VPN&manage=1&saved=1',
      saved: '1',
    });
    expect(api.knowledgeDetail).toHaveBeenCalledExactlyOnceWith(id, false);
    const expected = '/knowledge?q=VPN&manage=1';
    expect(links(html)[0].href).toBe(
      `/knowledge/${id}?${new URLSearchParams({ returnTo: expected })}`,
    );
    expect(links(html)[1]).toEqual({ href: expected, label: '元の画面へ戻る', native: true });
  });
  it.each([
    undefined,
    ['/knowledge', '/portal'],
    'https://outside.invalid',
    '//outside.invalid',
    '/not-allowed',
    '/knowledge\\evil',
    '/knowledge\nsecret',
  ])('ignores unsafe/plural return path %s', async (returnTo) => {
    fail();
    expect(links(await render({ returnTo }))[1].href).toBe('/knowledge');
  });
  it.each(['', '.', '..', 'a/b', '%2e%2e', '\uD800'])(
    'omits unsafe/nonUUID retry %s without URI error',
    async (articleId) => {
      fail(400);
      const html = await render({}, articleId);
      expect(links(html).map((l) => l.label)).toEqual(['記事一覧へ戻る', 'ポータルへ戻る']);
    },
  );
  it('preserves public version, escaping, tags and saved feedback without management forms', async () => {
    const html = await render({ saved: '1' });
    expect(html).toContain('版 2');
    expect(html).toContain('公開タグ');
    expect(html).toContain('&lt;script&gt;literal&lt;/script&gt;');
    expect(html).toContain('記事を保存しました');
    expect(html).toContain('/tickets/new?kind=incident');
    expect(KnowledgeManagement).not.toHaveBeenCalled();
  });
  it.each(['draft', 'review', 'published', 'retired'] as const)(
    'preserves management %s article and versions',
    async (state) => {
      role('org_admin');
      const current = { ...article, state, version: 7, contentVersion: 7, title: '合成編集記事' };
      vi.mocked(api.knowledgeDetail).mockResolvedValue({
        ok: true,
        data: { article: current, versions },
      });
      const html = await render({ manage: '1' });
      expect(html).toContain('版 7');
      expect(KnowledgeManagement).toHaveBeenCalledWith(
        expect.objectContaining({ article: current, versions, canPublish: true }),
        undefined,
      );
      if (state === 'review' || state === 'retired') {
        expect(html).toContain('公開本文');
      }
      expect(html.includes('利用者に公開している版を見る')).toBe(state !== 'retired');
    },
  );
  it('does not give agent publish permission', async () => {
    role('agent');
    await render({ manage: '1' });
    expect(KnowledgeManagement).toHaveBeenCalledWith(
      expect.objectContaining({ canPublish: false }),
      undefined,
    );
  });
});

describe('real knowledgeDetail GET transport', () => {
  it.each([false, true])(
    'uses encoded fixed path and manages=%s without mutation',
    async (manage) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'set-cookie': 'synthetic=value' },
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      expect(await reader.knowledgeDetail(id, manage)).toEqual({
        ok: true,
        data,
        setCookie: 'synthetic=value',
      });
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe(`http://api:3001/knowledge/${id}${manage ? '?manage=1' : ''}`);
      expect(init.method ?? 'GET').toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.cache).toBe('no-store');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
      expect(init.headers.get('cookie')).toBe('solvi_session=synthetic');
      expect(init.headers.get('content-type')).toBe('application/json');
    },
  );
  it.each([400, 401, 403, 404, 500, 503])(
    'HTTP %s wins without body read or unresolved cancel',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('PRIVATE_BODY_STATUS_200'));
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const fetcher = vi
        .fn()
        .mockResolvedValue({ ok: false, status, text, body: { cancel }, headers: new Headers() });
      vi.stubGlobal('fetch', fetcher);
      expect(await reader.knowledgeDetail(id)).toEqual({
        ok: false,
        problem: { status, title: '記事を取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    },
  );
  it('takes transport status rather than conflicting parsed problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ status: 404, title: 'PRIVATE' }), { status: 403 }),
        ),
    );
    expect(await reader.knowledgeDetail(id)).toEqual({
      ok: false,
      problem: { status: 403, title: '記事を取得できませんでした' },
    });
  });
  it.each(['', '.', '..', 'not-uuid', `${id}/save`, '\uD800'])(
    'rejects invalid id %s before cookie/fetch',
    async (value) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      expect(await reader.knowledgeDetail(value)).toEqual({
        ok: false,
        problem: { status: 400, title: '記事の指定が正しくありません' },
      });
      expect(jar.calls).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(['00000000-0000-0000-0000-000000000000', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'])(
    'keeps backend UUID lexical compatibility %s',
    async (value) => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
      vi.stubGlobal('fetch', fetcher);
      expect((await reader.knowledgeDetail(value)).ok).toBe(true);
      expect(fetcher.mock.calls[0][0]).toBe(`http://api:3001/knowledge/${value}`);
    },
  );
  it.each(['network', 'body', 'cookie'])(
    'contains private %s failures as fixed 503',
    async (kind) => {
      const fetcher =
        kind === 'network'
          ? vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK'))
          : vi.fn().mockResolvedValue({
              ok: true,
              status: 200,
              headers: new Headers(),
              text: vi.fn().mockRejectedValue(new Error('PRIVATE_BODY')),
            });
      if (kind === 'cookie') jar.reject = true;
      vi.stubGlobal('fetch', fetcher);
      expect(await reader.knowledgeDetail(id)).toEqual({
        ok: false,
        problem: { status: 503, title: '記事を取得できませんでした' },
      });
      if (kind === 'cookie') expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('contains invalid JSON as fixed 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_INVALID_JSON')));
    expect(await reader.knowledgeDetail(id)).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('preserves transport-only 204 and set-cookie', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic=value' } }),
        ),
    );
    expect(await reader.knowledgeDetail(id)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=value',
    });
  });
  it('allows an empty cookie jar without fabricating a cookie', async () => {
    jar.empty = true;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetcher);
    await reader.knowledgeDetail(id);
    expect(fetcher.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
});
