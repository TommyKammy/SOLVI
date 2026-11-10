// NFR-UX-002, NFR-UX-003, NFR-UX-004: bounded inbox recovery and state rendering.
// Browser/axe, real authentication and RLS evidence remain separate.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type InboxItem,
  type InboxView,
  type SessionView,
} from '../../apps/web/src/lib/api';

const openForm = vi.hoisted(() => vi.fn());

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { inbox: vi.fn(), readInbox: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
vi.mock('../../apps/web/src/components/InboxOpenForm', () => ({
  InboxOpenForm: ({ item }: { item: InboxItem }) => {
    openForm(item);
    return createElement('button', { type: 'button' }, item.nextAction);
  },
}));

// The web workspace checks TSX; the root unit config uses classic JSX.
const { default: InboxPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/inbox/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);

const org = '06000000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '06000000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'agent', organizationId: org }],
};
const item: InboxItem = {
  kind: 'ticket',
  id: '06000000-0000-4000-8000-000000000003',
  number: 'TKT-060',
  title: '合成の担当チケット',
  state: 'new',
  stateLabel: '新規',
  scopeLabel: '自分の担当',
  nextAction: 'チケットを確認する',
  href: '/ops/tickets/06000000-0000-4000-8000-000000000003',
  waiting: false,
  eventKey: 'synthetic-current-update',
  updatedAt: '2026-10-08T01:00:00Z',
  unread: true,
  deadline: { label: '解決期限', status: 'none', at: null, remainingSeconds: null },
};
const data = (overrides: Partial<InboxView> = {}): InboxView => ({
  items: [item],
  total: 1,
  unread: 1,
  page: 1,
  pageSize: 25,
  asOf: '2026-10-08T01:00:00Z',
  canIncludeUnassigned: true,
  counts: { ticket: 1, approval: 0, change: 0 },
  appliedFilter: { kind: 'all', q: '', unread: '0', unassigned: '0', page: 1 },
  ...overrides,
});
const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve(searchParams) }));
const link = (html: string, label: string) => {
  const match = [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].find(
    (entry) => entry[4] === label,
  );
  if (!match) throw new Error(`missing link: ${label}`);
  return {
    url: new URL((match[2] ?? '').replaceAll('&amp;', '&'), 'https://solvi.test'),
    native: !`${match[1]}${match[3]}`.includes('data-next-link'),
  };
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.inbox).mockReset().mockResolvedValue({ ok: true, data: data() });
  vi.mocked(api.readInbox).mockReset();
  openForm.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('inbox same-query GET recovery', () => {
  const selected = { kind: 'ticket', q: 'VPN & 日本語', unread: '1', unassigned: '1', page: '3' };
  it.each([true, false])(
    'preserves only permitted single-string query values (success=%s)',
    async (ok) => {
      if (!ok)
        vi.mocked(api.inbox).mockResolvedValue({
          ok: false,
          problem: { status: 503, title: 'private' },
        });
      const html = await render({
        ...selected,
        organizationId: 'other-organization',
        returnTo: 'https://outside.invalid',
        cursor: 'untrusted',
      });
      const retry = link(html, ok ? '受信箱を更新する' : '同じ条件で再取得する');
      expect(retry.native).toBe(true);
      expect(retry.url.pathname).toBe('/inbox');
      expect([...retry.url.searchParams]).toEqual(Object.entries(selected));
      expect(api.inbox).toHaveBeenCalledExactlyOnceWith(new URLSearchParams(selected).toString());
      expect(api.readInbox).not.toHaveBeenCalled();
      expect(html).not.toContain('other-organization');
      expect(html).not.toContain('outside.invalid');
    },
  );

  it('ignores duplicate, empty and undefined values without taking their first value', async () => {
    vi.mocked(api.inbox).mockResolvedValue({
      ok: false,
      problem: { status: 503, title: 'private' },
    });
    const html = await render({
      kind: ['ticket', 'change'],
      q: ['first', 'second'],
      unread: '',
      unassigned: undefined,
      page: ['2', '3'],
    });
    expect(api.inbox).toHaveBeenCalledExactlyOnceWith('');
    expect(link(html, '同じ条件で再取得する').url.pathname).toBe('/inbox');
    expect(link(html, '同じ条件で再取得する').url.search).toBe('');
  });

  it('preserves invalid single-string conditions for a retry while offering an explicit reset', async () => {
    vi.mocked(api.inbox).mockResolvedValue({
      ok: false,
      problem: { status: 400, title: 'private' },
    });
    const invalid = { kind: 'unsupported', page: 'not-a-page' };
    const html = await render(invalid);
    expect([...link(html, '同じ条件で再取得する').url.searchParams]).toEqual(
      Object.entries(invalid),
    );
    expect(link(html, '条件を解除する').url.pathname).toBe('/inbox');
    expect(link(html, '条件を解除する').url.search).toBe('');
  });

  it('keeps requireSession first and does not request an inbox after session rejection', async () => {
    const redirect = new Error('synthetic session redirect');
    vi.mocked(requireSession).mockRejectedValue(redirect);
    await expect(render()).rejects.toBe(redirect);
    expect(api.inbox).not.toHaveBeenCalled();
    expect(api.readInbox).not.toHaveBeenCalled();
  });
});

describe('inbox failed reads do not reveal data or invent zero results', () => {
  it.each([
    [401, 'ログインの有効期限が切れた可能性があります。'],
    [403, 'この組織の受信箱を表示する権限がありません。'],
    [404, '対象や機能が現在利用できない可能性があります。'],
    [400, '受信箱の検索条件を確認できませんでした。'],
    [500, '受信箱を取得できませんでした。'],
    [502, '受信箱を取得できませんでした。'],
    [503, '受信箱を取得できませんでした。'],
  ])('renders a fixed message and exit for status %s', async (status, message) => {
    const refused = {
      ok: false as const,
      problem: {
        status: Number(status),
        title: 'PRIVATE_TITLE',
        detail: 'PRIVATE_DETAIL',
        correlationId: 'PRIVATE_TRACE',
      },
      data: data(),
    };
    vi.mocked(api.inbox).mockResolvedValue(refused);
    const html = await render({ unassigned: '1', page: '2' });
    expect(html).toContain('<p role="alert">');
    expect(html).toContain(message);
    expect(link(html, 'ポータルへ戻る').url.pathname).toBe('/portal');
    expect(link(html, '同じ条件で再取得する').native).toBe(true);
    expect(html).not.toMatch(
      /PRIVATE_|現在の業務件数|表示対象|新しい更新|合成の担当チケット|<form|<button|<table|業務はありません/,
    );
    expect(openForm).not.toHaveBeenCalled();
    expect(api.readInbox).not.toHaveBeenCalled();
  });
});

describe('inbox applied conditions and existing results', () => {
  it('recognizes an applied unassigned-only filter and gives accurate empty guidance', async () => {
    vi.mocked(api.inbox).mockResolvedValue({
      ok: true,
      data: data({
        items: [],
        total: 0,
        unread: 0,
        counts: { ticket: 0, approval: 0, change: 0 },
        appliedFilter: { kind: 'all', q: '', unread: '0', unassigned: '1', page: 1 },
      }),
    });
    const html = await render();
    expect(html).toContain('絞り込み中 · 表示対象 0件');
    expect(html).toContain('条件に合う業務はありません');
    expect(html).toContain('未割当の条件を見直してください。');
    expect(html).not.toContain('条件を解除すると、既読の業務も確認できます。');
    expect(html).toContain('checked=""');
  });

  it('uses appliedFilter rather than the raw URL for the displayed filtering state', async () => {
    const html = await render({ kind: 'ticket', q: 'ignored', unread: '1', unassigned: '1' });
    expect(html).not.toContain('絞り込み中');
    expect(html).not.toContain('value="ignored"');
    expect(html).not.toContain('checked=""');
  });

  it.each(['kind', 'q', 'unread'] as const)(
    'preserves the existing %s filtering predicate',
    async (key) => {
      const appliedFilter = data().appliedFilter;
      if (key === 'kind') appliedFilter.kind = 'ticket';
      if (key === 'q') appliedFilter.q = 'VPN';
      if (key === 'unread') appliedFilter.unread = '1';
      vi.mocked(api.inbox).mockResolvedValue({ ok: true, data: data({ appliedFilter }) });
      expect(await render()).toContain('絞り込み中');
    },
  );

  it('distinguishes genuine zero from an empty later page with a positive total', async () => {
    vi.mocked(api.inbox).mockResolvedValue({
      ok: true,
      data: data({ items: [], total: 0, unread: 0, counts: { ticket: 0, approval: 0, change: 0 } }),
    });
    expect(await render()).toContain('いま対応・確認する業務はありません');
    vi.mocked(api.inbox).mockResolvedValue({
      ok: true,
      data: data({
        items: [],
        total: 26,
        page: 3,
        appliedFilter: { ...data().appliedFilter, page: 3 },
      }),
    });
    const html = await render({ q: 'VPN', page: '3' });
    expect(html).toContain('このページに業務はありません');
    expect(html).toContain('表示対象 26件');
    expect([...link(html, '前のページ').url.searchParams]).toEqual([
      ['q', 'VPN'],
      ['page', '2'],
    ]);
    expect(html).not.toContain('いま対応・確認する業務はありません');
  });

  it('retains item order, counts and the existing open-form input without recording a read', async () => {
    const second = {
      ...item,
      id: '06000000-0000-4000-8000-000000000004',
      title: '合成の次の業務',
      eventKey: 'synthetic-next-update',
    };
    vi.mocked(api.inbox).mockResolvedValue({
      ok: true,
      data: data({
        items: [item, second],
        total: 26,
        counts: { ticket: 26, approval: 0, change: 0 },
      }),
    });
    const html = await render({ unread: '1', unassigned: '1', page: '1' });
    expect(html.indexOf(item.title)).toBeLessThan(html.indexOf(second.title));
    expect(html).toContain('表示対象 26 件中 2 件を表示');
    expect(openForm.mock.calls.map(([passedItem]) => passedItem)).toEqual([item, second]);
    expect([...link(html, '次のページ').url.searchParams]).toEqual([
      ['unread', '1'],
      ['unassigned', '1'],
      ['page', '2'],
    ]);
    expect(api.readInbox).not.toHaveBeenCalled();
  });
});

describe('inbox GET transport boundary', () => {
  it('keeps GET, no-store, existing cookies and the complete successful response', async () => {
    const payload = data();
    const fetch = vi.fn().mockResolvedValue(
      Response.json(payload, {
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.inbox('kind=ticket&q=VPN&page=2')).toEqual({
      ok: true,
      data: payload,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname + new URL(url).search).toBe('/inbox?kind=ticket&q=VPN&page=2');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(new Headers(init.headers).get('cookie')).toBe('solvi_session=synthetic-session');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([200, 401, 403, 404, 400, 500])(
    'preserves a known HTTP denial when the body is cut, and treats successful-header cuts as unavailable (%s)',
    async (status) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":'));
          controller.error(new Error('PRIVATE_BODY_SOURCE'));
        },
      });
      const response = new Response(body, { status });
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      const result = await actualApi.inbox();
      expect(result).toEqual({
        ok: false,
        problem: { status: status === 200 ? 503 : status, title: '受信箱を取得できませんでした' },
      });
      if (status === 200) expect(read).toHaveBeenCalledOnce();
      else expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY_SOURCE');
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('returns fixed network and invalid-JSON failures without exposing their source', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK_SOURCE'))
      .mockResolvedValueOnce(new Response('{invalid', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.inbox()).toEqual({
      ok: false,
      problem: { status: 503, title: '受信箱を取得できませんでした' },
    });
    expect(await actualApi.inbox()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });

  it.each([
    [401, 503],
    [403, 200],
    [404, 401],
    [400, 500],
    [503, 403],
  ])(
    'uses HTTP %s instead of a conflicting body status %s and discards private details',
    async (httpStatus, bodyStatus) => {
      const problem = { status: bodyStatus, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' };
      const response = Response.json(problem, { status: httpStatus });
      const read = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      expect(await actualApi.inbox()).toEqual({
        ok: false,
        problem: { status: httpStatus, title: '受信箱を取得できませんでした' },
      });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(['never-settles', 'rejects'] as const)(
    'aborts this GET and returns HTTP 403 without waiting for unread-body cancellation (%s)',
    async (cancellation) => {
      const cancel = vi.fn(() => {
        if (cancellation === 'rejects') return Promise.reject(new Error('PRIVATE_CANCEL_SOURCE'));
        return new Promise<void>(() => {});
      });
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          actualApi.inbox(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('inbox waited for an unread body')), 100);
          }),
        ]);
        expect(result).toEqual({
          ok: false,
          problem: { status: 403, title: '受信箱を取得できませんでした' },
        });
        const [, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('PRIVATE_CANCEL_SOURCE');
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  it('keeps the existing successful 204 and set-cookie result shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
        }),
      ),
    );
    expect(await actualApi.inbox()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
  });
});
