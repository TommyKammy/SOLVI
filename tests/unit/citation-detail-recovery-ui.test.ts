// NFR-UX-002, NFR-UX-003, NFR-UX-004: immutable citation detail GET recovery.
// Actual Page/reader; session and Next navigation are unit mocks, not authorization proof.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type SessionView } from '../../apps/web/src/lib/api';
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
  api: { citationContent: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  usePathname: () => '/tickets/ticket/citations/comment',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (p: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...p, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
type Page = (p: {
  params: Promise<{ id: string; commentId: string }>;
  searchParams?: Promise<Query>;
}) => Promise<ReactNode>;
const { default: Page } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/tickets/[id]/citations/[commentId]/page',
);
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const ticketId = '08100000-0000-4000-8000-00000000001a';
const commentId = '08100000-0000-4000-8000-00000000001b';
const articleId = '08100000-0000-4000-8000-00000000001c';
const org = '08100000-0000-4000-8000-000000000002';
const session: SessionView = {
  userId: '08100000-0000-4000-8000-000000000003',
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};
const data = {
  articleId,
  version: 1,
  title: '合成の引用版記事',
  body: '引用本文 <script>literal</script>',
  tags: '引用, 手順',
  audience: 'organization',
  number: 1,
};
const render = async (query: Query = {}, id = ticketId, comment = commentId) =>
  renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ id, commentId: comment }),
      searchParams: Promise.resolve(query),
    }),
  );
const fail = (status = 503) =>
  vi.mocked(api.citationContent).mockResolvedValue({
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
    native: !m[1].includes('data-next-link') && !m[3].includes('data-next-link'),
  }));
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  jar.reject = false;
  jar.empty = false;
  jar.calls = 0;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.citationContent).mockResolvedValue({ ok: true, data });
});
afterEach(() => vi.unstubAllGlobals());

describe('citation page recovery', () => {
  it('requires the session before the reader and does not read after session denial', async () => {
    await render();
    expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.citationContent).mock.invocationCallOrder[0],
    );
    vi.mocked(api.citationContent).mockClear();
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.citationContent).not.toHaveBeenCalled();
  });
  it('supports the existing params-only invocation', async () => {
    const html = renderToStaticMarkup(
      await Page({ params: Promise.resolve({ id: ticketId, commentId }) }),
    );
    expect(html).toContain(data.title);
    expect(api.citationContent).toHaveBeenCalledWith(ticketId, commentId);
  });
  it.each([400, 401, 403, 409, 500, 502, 503])(
    'renders safe fixed failure for %i',
    async (status) => {
      fail(status);
      const html = await render({ returnTo: '/requests?q=test' });
      expect(html).toContain('引用記事を表示できません');
      expect(html).toContain('role="alert"');
      expect(html).not.toMatch(/PRIVATE|合成の引用版記事|引用本文|<article|<form/);
      expect(notFound).not.toHaveBeenCalled();
      expect(links(html).find((x) => x.label === '再取得する')?.native).toBe(true);
      expect(html).toContain(
        status === 401
          ? 'ログイン状態を確認できませんでした'
          : status === 403
            ? '引用記事を表示する権限がありません'
            : status === 400
              ? '引用記事の指定が正しくありません'
              : '一時的に引用記事を読み込めませんでした',
      );
    },
  );
  it('keeps 404 hidden', async () => {
    fail(404);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('preserves only sanitized single returnTo in a same-citation retry', async () => {
    fail();
    const html = await render({
      returnTo: '/requests?q=PC&saved=1',
      saved: '1',
      manage: '1',
      unknown: 'discard',
    });
    const retry = links(html).find((x) => x.label === '再取得する')!;
    const url = new URL(retry.href, 'https://solvi.local');
    expect(url.pathname).toBe(`/tickets/${ticketId}/citations/${commentId}`);
    expect([...url.searchParams]).toEqual([['returnTo', '/requests?q=PC']]);
    expect(links(html).find((x) => x.label === '元の画面へ戻る')).toMatchObject({
      href: '/requests?q=PC',
      native: true,
    });
    expect(links(html).find((x) => x.label === 'ポータルへ戻る')?.href).toBe('/portal');
  });
  it.each(['https://invalid.example/', '//invalid.example/', '/invalid', ['/', '/ops']])(
    'ignores unsafe or plural returnTo %j',
    async (value) => {
      fail();
      const html = await render({ returnTo: value });
      expect(links(html).find((x) => x.label === '再取得する')?.href).toBe(
        `/tickets/${ticketId}/citations/${commentId}`,
      );
      expect(links(html).find((x) => x.label === '問い合わせへ戻る')?.href).toBe(
        `/tickets/${ticketId}`,
      );
    },
  );
  it.each(['requester', 'approver', 'auditor', 'agent', 'org_admin', 'platform_admin'] as const)(
    'uses existing role fallback for %s and preserves the immutable normal article',
    async (code) => {
      role(code);
      const prefix = ['agent', 'org_admin', 'platform_admin'].includes(code) ? 'ops' : 'tickets';
      const normal = await render();
      expect(normal).toContain(data.title);
      expect(normal).toContain('返信で引用した版 1');
      expect(normal).toContain('記事の最新の版とは異なる場合があります');
      expect(normal).toContain('&lt;script&gt;literal&lt;/script&gt;');
      expect(normal).not.toContain('<script>');
      expect(links(normal).find((x) => x.label === '問い合わせへ戻る')?.href).toBe(
        `/${prefix}/${ticketId}`,
      );
      const currentLink = new URL(
        links(normal).find((x) => x.label === '現在公開されている記事を確認する')!.href,
        'https://solvi.local',
      );
      expect(currentLink.pathname).toBe(`/knowledge/${articleId}`);
      expect(currentLink.searchParams.get('returnTo')).toBe('/tickets/ticket/citations/comment');
      fail();
      expect(links(await render()).find((x) => x.label === '問い合わせへ戻る')).toMatchObject({
        href: `/${prefix}/${ticketId}`,
        native: true,
      });
    },
  );
  it.each(['', '.', '..', '\ud800'])(
    'invalid ticket %j has no retry and safe list fallback',
    async (id) => {
      fail(400);
      const html = await render({}, id);
      expect(links(html).some((x) => x.label === '再取得する')).toBe(false);
      expect(links(html).find((x) => x.label === '一覧へ戻る')?.href).toBe('/tickets');
      role('agent');
      expect(links(await render({}, id)).find((x) => x.label === '一覧へ戻る')?.href).toBe('/ops');
    },
  );
  it.each(['', '.', '..', '\udfff'])(
    'invalid comment %j keeps safe ticket exit without retry',
    async (comment) => {
      fail(400);
      const html = await render({}, ticketId, comment);
      expect(links(html).some((x) => x.label === '再取得する')).toBe(false);
      expect(links(html).find((x) => x.label === '問い合わせへ戻る')?.href).toBe(
        `/tickets/${ticketId}`,
      );
    },
  );
  it('independently encodes safe nonUUID IDs in retry and ticket exit without changing case', async () => {
    fail();
    const html = await render({}, 'Ticket/Upper?x', 'Comment/#引用');
    expect(links(html).find((x) => x.label === '再取得する')?.href).toBe(
      '/tickets/Ticket%2FUpper%3Fx/citations/Comment%2F%23%E5%BC%95%E7%94%A8',
    );
    expect(links(html).find((x) => x.label === '問い合わせへ戻る')?.href).toBe(
      '/tickets/Ticket%2FUpper%3Fx',
    );
  });
});

describe('actual citation GET reader', () => {
  it('forwards full immutable DTO with cookies, no-store, signal, set-cookie', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(data), { headers: { 'set-cookie': 'synthetic=updated' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(await reader.citationContent(ticketId, commentId)).toEqual({
      ok: true,
      data,
      setCookie: 'synthetic=updated',
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toMatch(new RegExp(`/tickets/${ticketId}/comments/${commentId}/citation$`));
    expect(init.cache).toBe('no-store');
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic');
    expect(init.headers.get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 500, 502, 503])(
    'preserves received HTTP %i without reading or waiting for cancellation',
    async (status) => {
      const text = vi.fn(() => Promise.reject(new Error('PRIVATE_BODY_CUT')));
      const cancel = vi.fn(() => new Promise(() => {}));
      const fetcher = vi.fn().mockResolvedValue({
        ok: false,
        status,
        text,
        body: { cancel },
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', fetcher);
      expect(await reader.citationContent(ticketId, commentId)).toEqual({
        ok: false,
        problem: { status, title: '引用記事を取得できませんでした' },
      });
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      expect(text).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    },
  );
  it('ignores a conflicting problem body status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ status: 404, title: 'PRIVATE' }), { status: 403 }),
        ),
    );
    expect(await reader.citationContent(ticketId, commentId)).toEqual({
      ok: false,
      problem: { status: 403, title: '引用記事を取得できませんでした' },
    });
  });
  it.each(['', '.', '..', '\ud800', '\udfff'])(
    'rejects invalid ticket %j before cookies/fetch',
    async (id) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      expect(await reader.citationContent(id, commentId)).toEqual({
        ok: false,
        problem: { status: 400, title: '引用記事の指定が正しくありません' },
      });
      expect(jar.calls).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(['', '.', '..', '\ud800', '\udfff'])(
    'rejects invalid comment %j before cookies/fetch',
    async (id) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      expect((await reader.citationContent(ticketId, id)).ok).toBe(false);
      expect(jar.calls).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['safe-ticket', 'safe-comment'],
    [ticketId.toUpperCase(), commentId.toUpperCase()],
    ['a/b?c#d', '引用/文章#?'],
    ['%2e%2e', '%2F'],
    ['a\\b', 'c\\d'],
  ])(
    'forwards independent encoded segments without normalization: %s / %s',
    async (ticket, comment) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      vi.stubGlobal('fetch', fetcher);
      expect((await reader.citationContent(ticket, comment)).ok).toBe(false);
      expect(fetcher.mock.calls[0][0]).toMatch(
        new RegExp(
          `/tickets/${encodeURIComponent(ticket)}/comments/${encodeURIComponent(comment)}/citation$`,
        ),
      );
      expect(jar.calls).toBe(1);
    },
  );
  it.each(['network', 'body', 'cookie'])('returns fixed 503 for %s failure', async (kind) => {
    const fetcher = vi.fn();
    if (kind === 'network') fetcher.mockRejectedValue(new Error('PRIVATE_NETWORK'));
    else
      fetcher.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: vi.fn().mockRejectedValue(new Error('PRIVATE_BODY')),
      });
    if (kind === 'cookie') jar.reject = true;
    vi.stubGlobal('fetch', fetcher);
    expect(await reader.citationContent(ticketId, commentId)).toEqual({
      ok: false,
      problem: { status: 503, title: '引用記事を取得できませんでした' },
    });
    if (kind === 'cookie') expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns fixed 502 for invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('PRIVATE_INVALID_JSON')));
    expect(await reader.citationContent(ticketId, commentId)).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
  it('preserves 204 transport compatibility without claiming a healthy detail page', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic=updated' } }),
        ),
    );
    expect(await reader.citationContent(ticketId, commentId)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=updated',
    });
  });
  it('omits Cookie for an empty jar', async () => {
    jar.empty = true;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetcher);
    await reader.citationContent(ticketId, commentId);
    expect(fetcher.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
});
