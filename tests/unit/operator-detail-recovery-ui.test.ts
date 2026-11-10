// NFR-UX-002, NFR-UX-003, NFR-UX-004: operator detail read recovery.
// Real identity/authz/DB and browser accessibility evidence are separate.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type WorkspaceView } from '../../apps/web/src/lib/api';
import { notFound, redirect } from 'next/navigation';

const jar = vi.hoisted(() => ({ calls: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    jar.calls++;
    return { getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] };
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    operatorWorkspaceDetail: vi.fn(),
    workspace: vi.fn(),
    knowledgeList: vi.fn(),
    listRelations: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  usePathname: () => '/ops/07200000-0000-4000-8000-000000000004',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': true }),
}));
// Async related asset component is rendered by the separate real Next/browser harness.
vi.mock('../../apps/web/src/components/TicketAssetPanel', () => ({
  TicketAssetPanel: ({ ticketId }: { ticketId: string }) =>
    createElement('section', { 'data-ticket-assets': ticketId }),
}));
vi.mock('../../apps/web/src/components/RelatedChangePanel', () => ({
  RelatedChangePanel: () => createElement('section', { 'data-related-changes': true }),
}));
const { default: Page } = await vi.importActual<{
  default: (p: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/ops/[id]/page');
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '07200000-0000-4000-8000-000000000004';
const ticket: WorkspaceView['ticket'] = {
  id,
  number: 'TKT-072',
  kind: 'incident',
  state: 'new',
  subject: '合成の問い合わせ',
  body: '合成の問い合わせ本文',
  impact: 'low',
  urgency: 'low',
  priority: 'low',
  createdAt: '2026-10-10T00:00:00Z',
  resolvedAt: null,
  assigned: false,
  requesterId: '07200000-0000-4000-8000-000000000003',
  assigneeId: null,
  assigneeGroupId: null,
  version: '1',
};
const workspace: WorkspaceView = {
  ticket,
  comments: [],
  attachments: [],
  replyContext: { ticketVersion: '1', latestCommentId: null },
  availableActions: [{ to: 'in_progress', label: '対応を始める', reason: 'none' }],
  priorityIsDerived: true,
  availableGroups: [],
  sla: {
    elapsedSeconds: 0,
    responseTargetSeconds: 900,
    resolutionTargetSeconds: 3600,
    responseBreached: false,
    resolutionBreached: false,
    remainingSeconds: 3600,
  },
};
const render = async (query: Record<string, string | string[] | undefined> = {}, target = id) =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id: target }), searchParams: Promise.resolve(query) }),
  );
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const fail = (status: number) =>
  vi.mocked(api.operatorWorkspaceDetail).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  jar.calls = 0;
  vi.stubGlobal('React', React);
  vi.mocked(requireSession).mockResolvedValue({
    userId: '07200000-0000-4000-8000-000000000002',
    organizationId: '07200000-0000-4000-8000-000000000001',
    roles: [{ roleCode: 'agent', organizationId: '07200000-0000-4000-8000-000000000001' }],
  });
  vi.mocked(api.operatorWorkspaceDetail).mockResolvedValue({ ok: true, data: workspace });
  vi.mocked(api.knowledgeList).mockResolvedValue({
    ok: true,
    data: {
      items: [],
      total: 0,
      page: 1,
      hasPrevious: false,
      hasNext: false,
      appliedQuery: '',
      neighbors: { previousCursor: null, nextCursor: null },
    },
  });
  vi.mocked(api.listRelations).mockResolvedValue({
    ok: true,
    data: { items: [], unresolvedChildren: [] },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('operator detail recovery page', () => {
  it('requires the session before the detail reader and does not read after denial', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.operatorWorkspaceDetail).not.toHaveBeenCalled();
  });
  it('keeps the original 401 login redirect', async () => {
    fail(401);
    await expect(render()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/login');
    expect(notFound).not.toHaveBeenCalled();
  });
  it.each([403, 404])('conceals HTTP %i with notFound', async (status) => {
    fail(status);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(api.knowledgeList).not.toHaveBeenCalled();
  });
  it.each([400, 500, 502, 503])(
    'shows only a fixed recoverable failure for HTTP %i',
    async (status) => {
      fail(status);
      const html = await render({ created: '1', commentSaved: '1', reopenError: 'PRIVATE_FLASH' });
      expect(html).toContain('問い合わせを読み込めませんでした');
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        status === 400 ? '一覧から選び直してください' : '時間をおいて、もう一度お試しください',
      );
      for (const text of [
        'PRIVATE',
        'TKT-072',
        '合成の問い合わせ本文',
        '受け付けました',
        '<form',
        '<textarea',
      ])
        expect(html).not.toContain(text);
      expect(api.knowledgeList).not.toHaveBeenCalled();
      expect(api.listRelations).not.toHaveBeenCalled();
      const retry = links(html).find((l) => l.label === '再取得する');
      expect(retry).toEqual({ href: '/ops/' + id, label: '再取得する', native: true });
    },
  );
  it('keeps only one normalized safe return path on the native retry', async () => {
    fail(503);
    const html = await render({
      returnTo: '/portal?q=合成&state=pending&page=2&created=1#list',
      created: '1',
      commentError: '1',
      unknown: 'PRIVATE',
    });
    const retry = links(html).find((l) => l.label === '再取得する')!;
    const url = new URL(retry.href, 'https://solvi.local');
    expect([...url.searchParams.keys()]).toEqual(['returnTo']);
    expect(url.searchParams.get('returnTo')).toBe(
      '/portal?q=%E5%90%88%E6%88%90&state=pending&page=2#list',
    );
    expect(links(html).find((l) => l.label === '元の画面へ戻る')?.href).toBe(
      url.searchParams.get('returnTo'),
    );
  });
  it.each(['https://evil.invalid', '//evil.invalid', '/admin', ['/portal', '/ops']])(
    'rejects unsafe or multiple returnTo %j',
    async (from) => {
      fail(503);
      const html = await render({ returnTo: from });
      expect(links(html).find((l) => l.label === '再取得する')?.href).toBe('/ops/' + id);
      expect(links(html).find((l) => l.label === '対応待ちの一覧へ戻る')?.href).toBe('/ops');
    },
  );
  it.each([
    '/ops?assignment=mine',
    '/requests?state=submitted',
    '/changes?page=2',
    '/assets?kind=pc',
    '/catalog',
    '/knowledge?q=合成',
    '/inbox?unread=1',
    '/ops/' + id,
  ])('keeps an allowed return destination %s', async (from) => {
    fail(503);
    const html = await render({ returnTo: from });
    const normalized = new URL(from, 'https://solvi.local');
    expect(links(html).find((l) => l.label === '元の画面へ戻る')?.href).toBe(
      normalized.pathname + normalized.search,
    );
    expect(
      new URL(
        links(html).find((l) => l.label === '再取得する')!.href,
        'https://solvi.local',
      ).searchParams.get('returnTo'),
    ).toBe(normalized.pathname + normalized.search);
  });
  it.each(['', '.', '..', '\ud800'])(
    'does not offer retry for unsafe URI segment %j',
    async (target) => {
      fail(400);
      const html = await render({}, target);
      expect(links(html).some((l) => l.label === '再取得する')).toBe(false);
      expect(html).toContain('対応待ちの一覧へ戻る');
    },
  );
  it.each([id.replaceAll('-', ''), '{' + id + '}', '07200000-0000-0000-0000-000000000004'])(
    'keeps a safe alternate ID retry %s',
    async (target) => {
      fail(503);
      const html = await render({}, target);
      expect(links(html).find((l) => l.label === '再取得する')?.href).toBe(
        '/ops/' + encodeURIComponent(target),
      );
    },
  );
  it.each(['new', 'pending', 'resolved'])(
    'preserves successful %s workspace and controls',
    async (state) => {
      vi.mocked(api.operatorWorkspaceDetail).mockResolvedValue({
        ok: true,
        data: {
          ...workspace,
          ticket: {
            ...ticket,
            state,
            pendingReason: state === 'pending' ? 'wait_requester' : null,
            resolvedAt: state === 'resolved' ? '2026-10-10T01:00:00Z' : null,
          },
        },
      });
      const html = await render();
      for (const text of [
        '合成の問い合わせ本文',
        '返信・対応を記録する',
        '優先度と影響',
        'data-ticket-assets',
        'data-related-changes',
      ])
        expect(html).toContain(text);
      expect(html).not.toContain('問い合わせを読み込めませんでした');
      expect(api.knowledgeList).toHaveBeenCalledExactlyOnceWith('');
      expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(api.operatorWorkspaceDetail).mock.invocationCallOrder[0],
      );
      expect(vi.mocked(api.operatorWorkspaceDetail).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(api.knowledgeList).mock.invocationCallOrder[0],
      );
      expect(vi.mocked(api.knowledgeList).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(api.listRelations).mock.invocationCallOrder[0],
      );
      if (state === 'pending') expect(html).toContain('依頼者の返答を待っています');
    },
  );
  it.each(['agent', 'org_admin', 'platform_admin'])(
    'retains allowed %s workspace',
    async (roleCode) => {
      vi.mocked(requireSession).mockResolvedValue({
        userId: 'synthetic-user',
        organizationId: 'synthetic-org',
        roles: [{ roleCode, organizationId: 'synthetic-org' }],
      });
      expect(await render()).toContain('返信・対応を記録する');
      expect(api.operatorWorkspaceDetail).toHaveBeenCalledOnce();
    },
  );
  it.each(['requester', 'approver', 'auditor'])(
    'redirects denied %s before main GET',
    async (roleCode) => {
      vi.mocked(requireSession).mockResolvedValue({
        userId: 'synthetic-user',
        organizationId: 'synthetic-org',
        roles: [{ roleCode, organizationId: 'synthetic-org' }],
      });
      await expect(render()).rejects.toThrow('NEXT_REDIRECT');
      expect(redirect).toHaveBeenCalledWith('/');
      expect(api.operatorWorkspaceDetail).not.toHaveBeenCalled();
      expect(api.knowledgeList).not.toHaveBeenCalled();
    },
  );
  it('uses one portal return link when portal is the normalized parent', async () => {
    fail(503);
    const html = await render({ returnTo: '/portal' });
    expect(links(html).filter((l) => l.href === '/portal')).toHaveLength(1);
  });
});

describe('dedicated operator detail GET', () => {
  it.each(['', '.', '..', '\ud800', null, undefined])(
    'rejects unsafe %j without cookies/fetch',
    async (input) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      expect(await reader.operatorWorkspaceDetail(input as string)).toMatchObject({
        ok: false,
        problem: { status: 400 },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(jar.calls).toBe(0);
    },
  );
  it.each([
    id,
    '072ABCDE-ABCD-4000-8000-000000000004',
    id.replaceAll('-', ''),
    '{' + id + '}',
    '07200000-0000-0000-0000-000000000004',
    'a/b?c#d',
  ])('retains encoded fixed endpoint and success for %s', async (input) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(workspace), { headers: { 'set-cookie': 'synthetic=renewed' } }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await reader.operatorWorkspaceDetail(input)).toEqual({
      ok: true,
      data: workspace,
      setCookie: 'synthetic=renewed',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/tickets/' + encodeURIComponent(input) + '/workspace');
    expect(init.cache).toBe('no-store');
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic-session');
    expect(init.signal.aborted).toBe(false);
  });
  it.each([400, 401, 403, 404, 500, 503])(
    'keeps HTTP %i without reading a conflicting/refused body',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('BODY_CUT'));
      const cancel = vi.fn(() => new Promise(() => {}));
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          signal = init.signal;
          return { ok: false, status, text, body: { cancel }, headers: new Headers() };
        }),
      );
      expect(await reader.operatorWorkspaceDetail(id)).toMatchObject({
        ok: false,
        problem: { status },
      });
      expect(text).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(true);
    },
  );
  it.each(['network', 'body-cut'])('classifies %s as 503', async (mode) => {
    vi.stubGlobal(
      'fetch',
      mode === 'network'
        ? vi.fn().mockRejectedValue(new Error('PRIVATE'))
        : vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: vi.fn().mockRejectedValue(new Error('PRIVATE')),
          }),
    );
    expect(await reader.operatorWorkspaceDetail(id)).toMatchObject({
      ok: false,
      problem: { status: 503 },
    });
  });
  it('classifies invalid JSON as 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{')));
    expect(await reader.operatorWorkspaceDetail(id)).toMatchObject({
      ok: false,
      problem: { status: 502 },
    });
  });
  it('preserves 204 transport without consuming a body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic=renewed' } }),
        ),
    );
    expect(await reader.operatorWorkspaceDetail(id)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=renewed',
    });
  });
});
