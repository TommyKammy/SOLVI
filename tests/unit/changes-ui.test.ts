// NFR-UX-002, NFR-UX-003, NFR-UX-004: bounded change-list recovery and state rendering.
// Browser/axe, actual identity, authorization and database evidence are separate.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type ChangeList,
  type ChangeSummary,
  type SessionView,
} from '../../apps/web/src/lib/api';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { changes: vi.fn(), createChange: vi.fn(), changeCommand: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  usePathname: () => '/changes',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
// Keep the actual page, ContextLink and shared labels; web TSX is also checked by its workspace.
const { default: ChangesPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/changes/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '06200000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '06200000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'agent', organizationId: org }],
};
const item = (overrides: Partial<ChangeSummary> = {}): ChangeSummary => ({
  id: '06200000-0000-4000-8000-000000000003',
  number: 'CHG-062',
  title: '合成の通常変更',
  type: 'normal',
  state: 'scheduled',
  version: 2,
  revision: 1,
  plannedStart: '2026-10-08T01:00:00Z',
  plannedEnd: '2026-10-08T02:00:00Z',
  ownerName: '合成担当者',
  ticket: {
    id: '06200000-0000-4000-8000-000000000004',
    number: 'TKT-062',
    subject: '詳細用のチケット件名',
  },
  assets: [
    {
      id: '06200000-0000-4000-8000-000000000005',
      assetTag: 'ASSET-062',
      name: '詳細用の資産名',
      kind: 'server',
      state: 'active',
      version: 1,
    },
  ],
  updatedAt: '2026-10-08T00:00:00Z',
  ...overrides,
});
const data = (overrides: Partial<ChangeList> = {}): ChangeList => ({
  items: [item()],
  total: 1,
  page: 1,
  pageSize: 25,
  canCreate: true,
  ...overrides,
});
const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await ChangesPage({ searchParams: Promise.resolve(searchParams) }));
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
const noWrites = () => {
  expect(api.createChange).not.toHaveBeenCalled();
  expect(api.changeCommand).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  navigation.params = new URLSearchParams();
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.changes).mockReset().mockResolvedValue({ ok: true, data: data() });
  vi.mocked(api.createChange).mockReset();
  vi.mocked(api.changeCommand).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('changes canonical fresh GET and session boundary', () => {
  const selected = {
    q: 'VPN & 日本語',
    state: 'scheduled',
    assetId: 'asset-selected',
    ticketId: 'ticket-selected',
    needsPir: '1',
    page: '3',
    from: '2026-10-07T15:30:00.000Z',
    to: '2026-10-08T04:00:00.000Z',
  };
  it.each([true, false])(
    'keeps exactly eight canonical conditions in a native GET (success=%s)',
    async (ok) => {
      if (!ok)
        vi.mocked(api.changes).mockResolvedValue({
          ok: false,
          problem: { status: 503, title: 'private' },
        });
      const html = await render({
        ...selected,
        organizationId: 'foreign',
        returnTo: 'https://outside.invalid',
        cursor: 'untrusted',
      });
      const refresh = link(html, ok ? '変更一覧を更新する' : '同じ条件で再取得する');
      expect(refresh.native).toBe(true);
      expect(refresh.url.pathname).toBe('/changes');
      expect([...refresh.url.searchParams]).toEqual(Object.entries(selected));
      expect(api.changes).toHaveBeenCalledExactlyOnceWith(new URLSearchParams(selected).toString());
      expect(html).not.toMatch(/outside\.invalid|foreign|untrusted/);
      noWrites();
    },
  );

  it.each([true, false])(
    'converts JST once, gives it precedence over raw UTC and preserves it in fresh GET (success=%s)',
    async (ok) => {
      if (!ok)
        vi.mocked(api.changes).mockResolvedValue({
          ok: false,
          problem: { status: 503, title: 'private' },
        });
      const html = await render({
        from: '2020-01-01T00:00:00Z',
        to: '2020-02-01T00:00:00Z',
        fromJst: '2026-10-08T00:30',
        toJst: '2026-10-08T13:00',
      });
      const refresh = link(html, ok ? '変更一覧を更新する' : '同じ条件で再取得する');
      expect([...refresh.url.searchParams]).toEqual([
        ['from', '2026-10-07T15:30:00.000Z'],
        ['to', '2026-10-08T04:00:00.000Z'],
      ]);
      expect(api.changes).toHaveBeenCalledExactlyOnceWith(refresh.url.search.slice(1));
      if (ok) {
        expect(html).toContain('name="fromJst" value="2026-10-08T00:30"');
        expect(html).toContain('name="toJst" value="2026-10-08T13:00"');
      }
    },
  );

  it('ignores duplicate, empty and undefined query values, including duplicate JST inputs', async () => {
    const html = await render({
      q: ['first', 'second'],
      state: '',
      assetId: undefined,
      ticketId: ['first', 'second'],
      needsPir: ['0', '1'],
      page: ['2', '3'],
      from: '2026-10-08T00:00:00Z',
      fromJst: ['2026-10-09T00:00', '2026-10-10T00:00'],
      toJst: '',
    });
    expect([...link(html, '変更一覧を更新する').url.searchParams]).toEqual([
      ['from', '2026-10-08T00:00:00Z'],
    ]);
    expect(api.changes).toHaveBeenCalledExactlyOnceWith('from=2026-10-08T00%3A00%3A00Z');
  });

  it('preserves invalid single-value conditions for 400 recovery with an explicit reset', async () => {
    vi.mocked(api.changes).mockResolvedValue({
      ok: false,
      problem: { status: 400, title: 'private' },
    });
    const html = await render({
      state: 'unsupported',
      page: 'bad-page',
      from: 'old',
      fromJst: 'invalid-date',
    });
    expect([...link(html, '同じ条件で再取得する').url.searchParams]).toEqual([
      ['state', 'unsupported'],
      ['page', 'bad-page'],
      ['from', 'invalid-date'],
    ]);
    expect(link(html, '条件を解除する').url.pathname).toBe('/changes');
    expect(link(html, '条件を解除する').url.search).toBe('');
  });

  it('does not fetch or write when the existing session guard redirects', async () => {
    const redirect = new Error('synthetic session redirect');
    vi.mocked(requireSession).mockRejectedValue(redirect);
    await expect(render()).rejects.toBe(redirect);
    expect(api.changes).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('changes fixed failure guidance', () => {
  it.each([
    [401, 'ログインの有効期限が切れた可能性があります。'],
    [403, 'この組織の変更一覧を表示する権限がありません。'],
    [404, '対象や機能が現在利用できない可能性があります。'],
    [400, '変更一覧の検索条件を確認できませんでした。'],
    [500, '変更一覧を取得できませんでした。'],
    [502, '変更一覧を取得できませんでした。'],
    [503, '変更一覧を取得できませんでした。'],
  ])(
    'renders HTTP %s safely without data, count, search or create actions',
    async (status, message) => {
      vi.mocked(api.changes).mockResolvedValue({
        ok: false,
        problem: {
          status: Number(status),
          title: 'PRIVATE_TITLE',
          detail: 'PRIVATE_DETAIL',
          errors: [{ field: 'PRIVATE_FIELD', message: 'PRIVATE_ERROR' }],
        },
      });
      const html = await render({ q: 'VPN', page: '2' });
      expect(html).toContain('<p role="alert">');
      expect(html).toContain(message);
      expect(link(html, 'ポータルへ戻る').url.pathname).toBe('/portal');
      expect(link(html, '同じ条件で再取得する').native).toBe(true);
      expect(html).not.toMatch(
        /PRIVATE_|全\d+件|合成担当者|合成の通常変更|<table|<form|<button|<select|通常変更の計画を作成する/,
      );
      noWrites();
    },
  );
});

describe('changes canonical filters, empty states and preserved display', () => {
  it.each([
    ['q', ' VPN '],
    ['state', 'failed'],
    ['assetId', 'selected-asset'],
    ['ticketId', 'selected-ticket'],
    ['from', '2026-10-08T00:00:00Z'],
    ['to', '2026-10-09T00:00:00Z'],
    ['needsPir', '1'],
  ])('uses canonical %s as a real filtering condition', async (key, value) => {
    vi.mocked(api.changes).mockResolvedValue({ ok: true, data: data({ items: [], total: 0 }) });
    const html = await render({ [key]: value });
    expect(html).toContain('絞り込み中 · 全0件');
    expect(html).toContain('条件に合う変更はありません。');
    expect(html).not.toContain('表示できる変更はまだありません。');
  });

  it.each([{}, { page: '3' }, { needsPir: '0' }, { page: '3', needsPir: '0' }, { q: '   ' }])(
    'does not treat page, all-PIR or whitespace as a filter: %j',
    async (query) => {
      vi.mocked(api.changes).mockResolvedValue({ ok: true, data: data({ items: [], total: 0 }) });
      const html = await render(query);
      expect(html).toContain('表示できる変更はまだありません。');
      expect(html).not.toContain('絞り込み中');
      expect(html).not.toContain('条件に合う変更はありません。');
    },
  );

  it.each([1, 3])(
    'distinguishes an empty current page %s from zero total and links to the first page',
    async (page) => {
      const query = { q: 'VPN', state: 'scheduled', needsPir: '0', page: String(page) };
      vi.mocked(api.changes).mockResolvedValue({
        ok: true,
        data: data({ items: [], total: 26, page }),
      });
      const html = await render(query);
      expect(html).toContain('全26件');
      expect(html).toContain('このページに変更はありません。最初のページへ戻ってください。');
      expect([...link(html, '最初のページへ').url.searchParams]).toEqual(
        Object.entries({ ...query, page: '1' }),
      );
      expect(html.match(/>最初のページへ<\/a>/g)).toHaveLength(1);
      expect(html).not.toContain('条件に合う変更はありません。');
    },
  );

  it.each([true, false])(
    'uses the API canCreate permission rather than inferring it from the session (%s)',
    async (canCreate) => {
      vi.mocked(requireSession).mockResolvedValue({
        ...session,
        roles: [{ roleCode: canCreate ? 'auditor' : 'agent', organizationId: org }],
      });
      vi.mocked(api.changes).mockResolvedValue({ ok: true, data: data({ canCreate }) });
      const html = await render();
      expect(html.includes('通常変更の計画を作成する')).toBe(canCreate);
      noWrites();
    },
  );

  it.each([
    ['draft', '下書き'],
    ['review', '承認待ち'],
    ['approved', '承認済み・予定未確定'],
    ['rejected', '却下・見直し待ち'],
    ['scheduled', '予定確定'],
    ['in_progress', '実施中（合成記録）'],
    ['completed', '成功（合成記録）'],
    ['failed', '失敗（合成記録）'],
    ['cancelled', '取り消し済み'],
  ])('keeps the existing %s label and simulation distinction', async (state, label) => {
    vi.mocked(api.changes).mockResolvedValue({
      ok: true,
      data: data({ items: [item({ state })] }),
    });
    const html = await render();
    expect(html).toContain(`data-state="${state}">${label}</span>`);
    expect(html).toContain('合成の実施結果');
    noWrites();
  });

  it('keeps JST, minimum related summaries, row order, hidden context and actual ContextLink return state', async () => {
    const first = item();
    const second = item({
      id: '06200000-0000-4000-8000-000000000006',
      title: '次の合成変更',
      plannedStart: null,
      plannedEnd: null,
    });
    const query = {
      q: 'VPN',
      state: 'scheduled',
      assetId: 'selected-asset',
      ticketId: 'selected-ticket',
      needsPir: '0',
      page: '2',
    };
    navigation.params = new URLSearchParams(query);
    vi.mocked(api.changes).mockResolvedValue({
      ok: true,
      data: data({ items: [first, second], total: 51, page: 2 }),
    });
    const html = await render(query);
    expect(html).toContain('2026年10月8日 10:00');
    expect(html).toContain('2026年10月8日 11:00');
    expect(html).toContain('開始未定');
    expect(html).toContain('終了未定');
    expect(html).toContain('合成担当者');
    expect(html).toContain('TKT-062');
    expect(html).toContain('ASSET-062');
    expect(html).not.toMatch(/詳細用のチケット件名|詳細用の資産名/);
    expect(html).toContain('資産から開いた関連変更');
    expect(html).toContain('type="hidden" name="assetId" value="selected-asset"');
    expect(html).toContain('type="hidden" name="ticketId" value="selected-ticket"');
    expect(html.indexOf(first.title)).toBeLessThan(html.indexOf(second.title));
    for (const [label, path] of [
      [first.number + ' · ' + first.title, '/changes/' + first.id],
      ['通常変更の計画を作成する', '/changes/new'],
    ]) {
      const target = link(html, label);
      expect(target.native).toBe(false);
      expect(target.url.pathname).toBe(path);
      expect(target.url.searchParams.get('returnTo')).toBe(
        '/changes?' + new URLSearchParams(query).toString(),
      );
    }
    for (const [label, page] of [
      ['前のページへ', '1'],
      ['次のページへ', '3'],
    ])
      expect([...link(html, label).url.searchParams]).toEqual(Object.entries({ ...query, page }));
    noWrites();
  });
});

describe('changes dedicated GET transport', () => {
  it('preserves GET, cookie, content type, no-store, data and set-cookie without aborting success', async () => {
    const payload = data();
    const fetch = vi.fn().mockResolvedValue(
      Response.json(payload, {
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.changes('q=VPN&needsPir=1&page=2')).toEqual({
      ok: true,
      data: payload,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname + new URL(url).search).toBe('/changes?q=VPN&needsPir=1&page=2');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('cookie')).toBe('solvi_session=synthetic-session');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([200, 401, 403, 404, 400, 500])(
    'preserves received HTTP denial on body cut (%s)',
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
      expect(await actualApi.changes()).toEqual({
        ok: false,
        problem: { status: status === 200 ? 503 : status, title: '変更一覧を取得できませんでした' },
      });
      expect(read).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      const [, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(status !== 200);
    },
  );

  it.each([
    [401, 503],
    [403, 200],
    [404, 401],
    [400, 500],
    [503, 403],
  ])(
    'uses HTTP %s rather than body status %s without reading raw problem data',
    async (status, bodyStatus) => {
      const response = Response.json(
        {
          status: bodyStatus,
          title: 'PRIVATE_TITLE',
          detail: 'PRIVATE_DETAIL',
          errors: [{ message: 'PRIVATE_ERROR' }],
        },
        { status },
      );
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      expect(await actualApi.changes()).toEqual({
        ok: false,
        problem: { status, title: '変更一覧を取得できませんでした' },
      });
      expect(read).not.toHaveBeenCalled();
      const [, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(true);
    },
  );

  it.each(['never-settles', 'rejects'] as const)(
    'aborts synchronously without awaiting unread body cancellation (%s)',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'rejects'
          ? Promise.reject(new Error('PRIVATE_CANCEL_SOURCE'))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          actualApi.changes(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('change list waited for unread body')),
              100,
            );
          }),
        ]);
        expect(result).toEqual({
          ok: false,
          problem: { status: 403, title: '変更一覧を取得できませんでした' },
        });
        const [, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(init.signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  it('returns fixed network and invalid-JSON failures', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK_SOURCE'))
      .mockResolvedValueOnce(new Response('{invalid', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.changes()).toEqual({
      ok: false,
      problem: { status: 503, title: '変更一覧を取得できませんでした' },
    });
    expect(await actualApi.changes()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });

  it('keeps successful 204/set-cookie compatibility', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
        }),
      ),
    );
    expect(await actualApi.changes()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
  });
});
