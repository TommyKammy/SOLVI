// NFR-UX-002, NFR-UX-003, NFR-UX-004: bounded asset-list recovery and state rendering.
// Browser/axe, actual identity, authorization and database evidence are separate.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type AssetList,
  type AssetView,
  type SessionView,
} from '../../apps/web/src/lib/api';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    assets: vi.fn(),
    createAsset: vi.fn(),
    editAsset: vi.fn(),
    linkAsset: vi.fn(),
    unlinkAsset: vi.fn(),
    inspectAssetCsv: vi.fn(),
    previewAssetCsv: vi.fn(),
    applyAssetImport: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  usePathname: () => '/assets',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
// Keep the actual page, ContextLink and shared labels; web TSX is checked by its workspace.
const { default: AssetsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '06400000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '06400000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'agent', organizationId: org }],
};
const item = (overrides: Partial<AssetView> = {}): AssetView => ({
  id: '06400000-0000-4000-8000-000000000003',
  assetTag: 'AST-064',
  name: '合成の端末',
  kind: 'pc',
  state: 'in_use',
  version: 1,
  model: '合成モデル',
  serialNumber: 'SYNTHETIC-SERIAL',
  hostname: 'synthetic-host',
  vendor: '合成メーカー',
  assignedUserId: session.userId,
  assignedUserName: '合成利用者',
  sourceKind: 'manual',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T01:00:00Z',
  location: 'PRIVATE_LOCATION',
  internalNotes: 'PRIVATE_INTERNAL_NOTE',
  ...overrides,
});

const data = (overrides: Partial<AssetList> = {}): AssetList => ({
  items: [item()],
  total: 1,
  page: 1,
  pageSize: 25,
  canManage: true,
  canReadAll: true,
  kinds: [
    { code: 'pc', label: 'PC', requiredFields: ['model'] },
    { code: 'server', label: 'サーバー', requiredFields: [] },
  ],
  states: [
    { code: 'in_use', label: '使用中' },
    { code: 'stocked', label: '在庫' },
  ],
  ...overrides,
});
const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await AssetsPage({ searchParams: Promise.resolve(searchParams) }));
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
const writes = () => [
  api.createAsset,
  api.editAsset,
  api.linkAsset,
  api.unlinkAsset,
  api.inspectAssetCsv,
  api.previewAssetCsv,
  api.applyAssetImport,
];
const noWrites = () => {
  for (const action of writes()) expect(action).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  navigation.params = new URLSearchParams();
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.assets).mockReset().mockResolvedValue({ ok: true, data: data() });
  for (const action of writes()) vi.mocked(action).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('assets canonical fresh GET and session boundary', () => {
  const selected = {
    q: '端末 & 日本語',
    state: 'in_use',
    kind: 'pc',
    assignment: 'mine',
    page: '2',
  };
  it.each([true, false])(
    'keeps the five allowed values in a native GET (success=%s)',
    async (ok) => {
      if (!ok)
        vi.mocked(api.assets).mockResolvedValue({
          ok: false,
          problem: { status: 503, title: 'private' },
        });
      const html = await render({
        ...selected,
        organizationId: 'foreign',
        returnTo: 'https://outside.invalid',
        cursor: 'untrusted',
      });
      const refresh = link(html, ok ? '資産一覧を更新する' : '同じ条件で再取得する');
      expect(refresh.native).toBe(true);
      expect(refresh.url.pathname).toBe('/assets');
      expect([...refresh.url.searchParams]).toEqual(Object.entries(selected));
      expect(api.assets).toHaveBeenCalledExactlyOnceWith(new URLSearchParams(selected).toString());
      expect(html).not.toMatch(/outside\.invalid|foreign|untrusted/);
      noWrites();
    },
  );

  it('drops all duplicate, empty and undefined values rather than selecting one', async () => {
    const html = await render({
      q: ['one', 'two'],
      state: '',
      kind: undefined,
      assignment: ['all', 'mine'],
      page: ['1', '2'],
    });
    expect(api.assets).toHaveBeenCalledExactlyOnceWith('');
    expect(link(html, '資産一覧を更新する').url.search).toBe('');
  });

  it('keeps unsupported single values on 400 and offers a separate condition reset', async () => {
    vi.mocked(api.assets).mockResolvedValue({
      ok: false,
      problem: { status: 400, title: 'private' },
    });
    const selected = {
      state: 'unsupported',
      kind: 'other',
      assignment: 'invalid',
      page: 'bad-page',
    };
    const html = await render(selected);
    expect([...link(html, '同じ条件で再取得する').url.searchParams]).toEqual(
      Object.entries(selected),
    );
    expect(link(html, '条件を解除する').url.pathname).toBe('/assets');
    expect(link(html, '条件を解除する').url.search).toBe('');
  });

  it('does not fetch data or write when the existing session guard redirects', async () => {
    const redirect = new Error('synthetic session redirect');
    vi.mocked(requireSession).mockRejectedValue(redirect);
    await expect(render()).rejects.toBe(redirect);
    expect(api.assets).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('assets fixed failure guidance', () => {
  it.each([
    [401, 'ログインの有効期限が切れた可能性があります。'],
    [403, 'この組織の資産一覧を表示する権限がありません。'],
    [404, '対象や機能が現在利用できない可能性があります。'],
    [400, '資産一覧の検索条件を確認できませんでした。'],
    [500, '資産一覧を取得できませんでした。'],
    [502, '資産一覧を取得できませんでした。'],
    [503, '資産一覧を取得できませんでした。'],
  ])(
    'shows status %s without raw problems, data, counts, registration or CSV controls',
    async (status, message) => {
      vi.mocked(api.assets).mockResolvedValue({
        ok: false,
        problem: {
          status: Number(status),
          title: 'PRIVATE_TITLE',
          detail: 'PRIVATE_DETAIL',
          errors: [{ field: 'PRIVATE_FIELD', message: 'PRIVATE_ERROR' }],
        },
      });
      const html = await render({ q: 'VPN', page: '2' });
      expect(html).toContain('<h1>資産</h1>');
      expect(html).toContain('<p role="alert">');
      expect(html).toContain(message);
      expect(link(html, 'ポータルへ戻る').url.pathname).toBe('/portal');
      expect(link(html, '同じ条件で再取得する').native).toBe(true);
      expect(html.includes('条件を解除する')).toBe(status === 400);
      expect(html).not.toMatch(
        /PRIVATE_|全\d+件|合成利用者|合成の端末|<table|<form|<button|<select|新しい資産を登録する|CSV取込と履歴|条件に合う資産はありません/,
      );
      noWrites();
    },
  );
});

describe('assets filters, empty states and existing role controls', () => {
  it.each([
    ['q', '  端末  '],
    ['state', 'in_use'],
    ['kind', 'pc'],
    ['assignment', 'mine'],
    ['assignment', 'unassigned'],
  ])('recognizes %s=%s as a filter without inventing an appliedFilter DTO', async (key, value) => {
    vi.mocked(api.assets).mockResolvedValue({ ok: true, data: data({ items: [], total: 0 }) });
    const html = await render({ [key]: value });
    expect(html).toContain('絞り込み中 · 全0件');
    expect(html).toContain(
      '条件に合う資産はありません。条件を解除するか、検索条件を見直してください。',
    );
    expect(html).not.toContain('表示できる資産はまだありません。');
  });

  it.each([
    {},
    { page: '3' },
    { assignment: 'all' },
    { page: '3', assignment: 'all' },
    { q: '   ' },
  ])('does not mark page, assignment=all or whitespace as a filter: %j', async (query) => {
    vi.mocked(api.assets).mockResolvedValue({ ok: true, data: data({ items: [], total: 0 }) });
    const html = await render(query);
    expect(html).toContain('表示できる資産はまだありません。');
    expect(html).not.toContain('絞り込み中');
    expect(html).not.toContain('条件に合う資産はありません。');
  });

  it.each(['mine', 'unassigned'])(
    'keeps assignment=%s even when the assignment control is hidden',
    async (assignment) => {
      vi.mocked(api.assets).mockResolvedValue({
        ok: true,
        data: data({ items: [], total: 0, canReadAll: false, canManage: false }),
      });
      const html = await render({ assignment });
      expect(api.assets).toHaveBeenCalledExactlyOnceWith('assignment=' + assignment);
      expect(html).toContain('<h1>自分の資産</h1>');
      expect(html).toContain('絞り込み中 · 全0件');
      expect(html).toContain('条件に合う資産はありません。');
      expect(html).not.toContain('id="asset-filter-user"');
      expect(link(html, '資産一覧を更新する').url.searchParams.get('assignment')).toBe(assignment);
    },
  );

  it.each([1, 3])(
    'distinguishes positive total and empty current page %s, preserving conditions back to page 1',
    async (page) => {
      const query = {
        q: '端末',
        state: 'in_use',
        kind: 'pc',
        assignment: 'mine',
        page: String(page),
      };
      vi.mocked(api.assets).mockResolvedValue({
        ok: true,
        data: data({ items: [], total: 26, page }),
      });
      const html = await render(query);
      expect(html).toContain('全26件');
      expect(html).toContain('このページに資産はありません。最初のページへ戻ってください。');
      const first = link(html, '最初のページへ');
      expect(first.native).toBe(true);
      expect([...first.url.searchParams]).toEqual(Object.entries({ ...query, page: '1' }));
      expect(html.match(/>最初のページへ<\/a>/g)).toHaveLength(1);
      expect(html).not.toContain('条件に合う資産はありません。');
    },
  );

  it.each([
    ['requester', false, false],
    ['agent', true, true],
    ['auditor', false, true],
  ] as const)(
    'preserves existing %s heading, registration, CSV and assignment control',
    async (roleCode, canManage, canReadAll) => {
      vi.mocked(requireSession).mockResolvedValue({
        ...session,
        roles: [{ roleCode, organizationId: org }],
      });
      vi.mocked(api.assets).mockResolvedValue({ ok: true, data: data({ canManage, canReadAll }) });
      const html = await render();
      expect(html).toContain(`<h1>${canReadAll ? '資産台帳' : '自分の資産'}</h1>`);
      expect(html.includes('新しい資産を登録する')).toBe(canManage);
      expect(html.includes('CSV取込と履歴')).toBe(canReadAll);
      expect(html.includes('id="asset-filter-user"')).toBe(canReadAll);
      noWrites();
    },
  );

  it('uses API permission flags rather than inferring controls from session role', async () => {
    vi.mocked(api.assets).mockResolvedValue({
      ok: true,
      data: data({ canManage: false, canReadAll: false }),
    });
    const html = await render();
    expect(html).toContain('<h1>自分の資産</h1>');
    expect(html).not.toMatch(/新しい資産を登録する|CSV取込と履歴|id="asset-filter-user"/);
  });

  it.each([
    ['pc', 'PC'],
    ['server', 'サーバー'],
    ['vm', '仮想マシン'],
    ['network', 'ネットワーク機器'],
    ['mobile', 'モバイル端末'],
    ['saas', 'SaaS'],
  ])('preserves the existing %s asset kind label', async (kind, label) => {
    vi.mocked(api.assets).mockResolvedValue({ ok: true, data: data({ items: [item({ kind })] }) });
    expect(await render()).toContain(`<td>${label}</td>`);
  });

  it.each([
    ['stocked', '在庫'],
    ['in_use', '使用中'],
    ['repair', '修理中'],
    ['retired', '廃止'],
  ])('preserves the existing %s state label', async (state, label) => {
    vi.mocked(api.assets).mockResolvedValue({ ok: true, data: data({ items: [item({ state })] }) });
    expect(await render()).toContain(`data-state="${state}">${label}</span>`);
  });

  it('preserves response options, selected values, row order, private-field omission and actual ContextLink return state', async () => {
    const first = item();
    const second = item({
      id: '06400000-0000-4000-8000-000000000004',
      name: '次の合成端末',
      assignedUserId: null,
      assignedUserName: null,
    });
    const query = { q: '端末', state: 'in_use', kind: 'pc', assignment: 'mine', page: '2' };
    navigation.params = new URLSearchParams(query);
    vi.mocked(api.assets).mockResolvedValue({
      ok: true,
      data: data({ items: [first, second], total: 51, page: 2 }),
    });
    const html = await render(query);
    expect(html).toContain('全51件 · 2ページ目（1ページ25件）');
    expect(html).toContain('value="端末"');
    expect(html).toContain('value="pc" selected="">PC');
    expect(html).toContain('value="in_use" selected="">使用中');
    expect(html).toContain('value="mine" selected="">自分');
    expect(html).toContain('<option value="server">サーバー</option>');
    expect(html).toContain('合成利用者');
    expect(html).toContain('<td>割当なし</td>');
    expect(html).not.toMatch(/PRIVATE_LOCATION|PRIVATE_INTERNAL_NOTE|SYNTHETIC-SERIAL/);
    expect(html.indexOf(first.name)).toBeLessThan(html.indexOf(second.name));
    for (const [label, path] of [
      [first.assetTag + ' · ' + first.name, '/assets/' + first.id],
      ['新しい資産を登録する', '/assets/new'],
      ['CSV取込と履歴', '/assets/imports'],
    ]) {
      const target = link(html, label);
      expect(target.native).toBe(false);
      expect(target.url.pathname).toBe(path);
      expect(target.url.searchParams.get('returnTo')).toBe(
        '/assets?' + new URLSearchParams(query).toString(),
      );
    }
    for (const [label, page] of [
      ['前のページへ', '1'],
      ['次のページへ', '3'],
    ]) {
      const target = link(html, label);
      expect(target.native).toBe(false);
      expect([...target.url.searchParams]).toEqual(Object.entries({ ...query, page }));
    }
    noWrites();
  });
});

describe('assets dedicated GET transport', () => {
  it('preserves GET, cookie, content type, no-store, data and set-cookie without aborting success', async () => {
    const payload = data();
    const fetch = vi.fn().mockResolvedValue(
      Response.json(payload, {
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.assets('q=VPN&assignment=unassigned&page=2')).toEqual({
      ok: true,
      data: payload,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname + new URL(url).search).toBe(
      '/assets?q=VPN&assignment=unassigned&page=2',
    );
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
      expect(await actualApi.assets()).toEqual({
        ok: false,
        problem: { status: status === 200 ? 503 : status, title: '資産一覧を取得できませんでした' },
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
      expect(await actualApi.assets()).toEqual({
        ok: false,
        problem: { status, title: '資産一覧を取得できませんでした' },
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
          actualApi.assets(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('asset list waited for unread body')), 100);
          }),
        ]);
        expect(result).toEqual({
          ok: false,
          problem: { status: 403, title: '資産一覧を取得できませんでした' },
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
    expect(await actualApi.assets()).toEqual({
      ok: false,
      problem: { status: 503, title: '資産一覧を取得できませんでした' },
    });
    expect(await actualApi.assets()).toEqual({
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
    expect(await actualApi.assets()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
  });
});
