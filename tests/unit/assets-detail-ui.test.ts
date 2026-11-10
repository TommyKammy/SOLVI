// NFR-UX-002, NFR-UX-003, NFR-UX-004: asset-detail read recovery and safe return paths.
// Browser/axe, actual identity, authorization and database evidence are separate.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type AssetDetail,
  type AssetView,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { notFound } from 'next/navigation';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
const cookieState = vi.hoisted(() => ({
  values: [{ name: 'solvi_session', value: 'synthetic-session' }],
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    asset: vi.fn(),
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
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => cookieState.values }) }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(),
  usePathname: () => '/assets/06600000-0000-4000-8000-000000000003',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
// The separate async related-change renderer is covered by the browser harness.
// Keep its placement and target observable without replacing the detail page or ContextLink.
vi.mock('../../apps/web/src/components/RelatedChangePanel', () => ({
  RelatedChangePanel: ({ kind, id }: { kind: string; id: string }) =>
    createElement('section', { 'data-related-kind': kind, 'data-related-id': id }),
}));
const { default: AssetPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/[id]/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '06600000-0000-4000-8000-000000000003';
const session: SessionView = {
  userId: '06600000-0000-4000-8000-000000000002',
  organizationId: '06600000-0000-4000-8000-000000000001',
  roles: [{ roleCode: 'agent', organizationId: '06600000-0000-4000-8000-000000000001' }],
};
const asset = (overrides: Partial<AssetView> = {}): AssetView => ({
  id,
  assetTag: 'AST-066',
  name: '合成の端末',
  kind: 'pc',
  state: 'in_use',
  version: 2,
  model: '合成モデル',
  serialNumber: 'SYNTHETIC-SERIAL',
  hostname: 'synthetic-host',
  vendor: '合成メーカー',
  assignedUserId: session.userId,
  assignedUserName: '合成利用者',
  sourceKind: 'manual',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T01:00:00Z',
  ...overrides,
});
const ticketId = '06600000-0000-4000-8000-000000000004';
const data = (privateFields = true, canManage = true): AssetDetail => ({
  asset: asset(privateFields ? { location: '合成保管場所', internalNotes: '合成内部メモ' } : {}),
  canManage,
  revisions: privateFields
    ? [
        {
          version: 2,
          snapshot: asset({ name: '更新後の端末' }),
          reason: '合成の更新理由',
          actorName: '合成担当者',
          createdAt: '2026-10-09T01:00:00Z',
        },
        {
          version: 1,
          snapshot: asset({ version: 1, name: '登録時の端末' }),
          reason: '合成の登録理由',
          actorName: '合成担当者',
          createdAt: '2026-10-09T00:00:00Z',
        },
      ]
    : [],
  tickets: [
    { id: ticketId, number: 'TKT-066', subject: '合成の問い合わせ', state: 'new', version: 1 },
  ],
  relationHistory: privateFields
    ? [
        {
          id: '06600000-0000-4000-8000-000000000005',
          operation: 'linked',
          reason: '合成の関連理由',
          createdAt: '2026-10-09T01:00:00Z',
          actorName: '合成担当者',
          ticketId,
          number: 'TKT-066',
          subject: '合成の問い合わせ',
        },
      ]
    : [],
});
const render = async (
  searchParams: Record<string, string | string[] | undefined> = {},
  assetId = id,
) =>
  renderToStaticMarkup(
    await AssetPage({
      params: Promise.resolve({ id: assetId }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const link = (html: string, label: string) => {
  const found = links(html).find((item) => item.label === label);
  expect(found, label).toBeDefined();
  return found!;
};
const fail = (status = 503) =>
  vi.mocked(api.asset).mockResolvedValue({
    ok: false,
    problem: {
      status,
      title: 'PRIVATE_TITLE',
      detail: 'PRIVATE_DETAIL',
      type: 'https://private.invalid/PRIVATE_TYPE',
      correlationId: 'PRIVATE_ID',
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  navigation.params = new URLSearchParams();
  cookieState.values = [{ name: 'solvi_session', value: 'synthetic-session' }];
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.asset).mockReset().mockResolvedValue({ ok: true, data: data() });
});
afterEach(() => {
  for (const action of [
    api.createAsset,
    api.editAsset,
    api.linkAsset,
    api.unlinkAsset,
    api.inspectAssetCsv,
    api.previewAssetCsv,
    api.applyAssetImport,
  ])
    expect(action).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('asset detail failure classification and session boundary', () => {
  it.each([
    [401, 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'],
    [403, 'この資産を表示する権限がありません。必要な場合は管理者に確認してください。'],
    [400, '資産を指定する情報が正しくありません。一覧から資産を選び直してください。'],
    [500, '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。'],
    [502, '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。'],
    [503, '一時的に資産を取得できませんでした。時間をおいて、もう一度お試しください。'],
  ])(
    'renders only fixed guidance for %s, with no success data or actions',
    async (status, message) => {
      fail(status as number);
      const html = await render({ saved: '1' });
      expect(html).toContain('<h1>資産を読み込めませんでした</h1>');
      expect(html).toContain(`<p role="alert">${message}</p>`);
      for (const hidden of [
        'PRIVATE_',
        '合成の端末',
        '内部メモ',
        '資産と履歴を保存しました。',
        '編集する',
        '変更履歴',
        'data-related-kind',
      ]) {
        expect(html).not.toContain(hidden);
      }
      expect(links(html)).toHaveLength(3);
      expect(links(html).every((item) => item.native)).toBe(true);
      expect(link(html, '再取得する').href).toBe(`/assets/${id}`);
      expect(link(html, '資産一覧へ戻る').href).toBe('/assets');
      expect(link(html, 'ポータルへ戻る').href).toBe('/portal');
    },
  );

  it('retains real HTTP 404 as notFound without exposing a different recovery state', async () => {
    vi.mocked(api.asset).mockImplementation(actualApi.asset);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ status: 403, title: 'PRIVATE_TITLE' }, { status: 404 })),
    );
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('does not fetch an asset or render recovery when requireSession redirects', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('EXISTING_SESSION_REDIRECT'));
    await expect(render()).rejects.toThrow('EXISTING_SESSION_REDIRECT');
    expect(api.asset).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe('asset detail recovery URL boundary', () => {
  it('retains the single safe return path and its conditions, but drops flash and arbitrary detail queries', async () => {
    fail();
    const returnTo = '/assets?q=%E7%AB%AF%E6%9C%AB&state=in_use&kind=pc&assignment=mine&page=2';
    const html = await render({
      returnTo,
      saved: '1',
      created: '1',
      updated: '1',
      unknown: 'PRIVATE_QUERY',
    });
    const retry = new URL(link(html, '再取得する').href, 'https://solvi.local');
    expect(retry.pathname).toBe(`/assets/${id}`);
    expect([...retry.searchParams]).toEqual([['returnTo', returnTo]]);
    expect(link(html, '元の画面へ戻る').href).toBe(returnTo);
    expect(html).not.toContain('PRIVATE_QUERY');
  });

  it('labels a permitted non-assets return path accurately and removes its stale flash', async () => {
    fail();
    const html = await render({ returnTo: '/changes?state=planned&saved=1' });
    expect(link(html, '元の画面へ戻る').href).toBe('/changes?state=planned');
    expect(
      new URL(link(html, '再取得する').href, 'https://solvi.local').searchParams.get('returnTo'),
    ).toBe('/changes?state=planned');
  });

  it.each([
    undefined,
    '',
    ['/assets?page=2', '/assets?page=3'],
    'https://outside.invalid/assets',
    '//outside.invalid/assets',
    '/assets\\outside',
    '/assets?line=\nsecret',
    '/settings/notifications',
    '/assets?q=' + 'x'.repeat(2001),
  ])(
    'falls back to the fixed asset list for invalid or multiple return paths (%s)',
    async (returnTo) => {
      fail();
      const html = await render({ returnTo });
      expect(link(html, '資産一覧へ戻る').href).toBe('/assets');
      expect(link(html, '再取得する').href).toBe(`/assets/${id}`);
      expect(html).not.toContain('元の画面へ戻る');
      expect(html).not.toContain('outside.invalid');
    },
  );

  it.each(['../options', 'options', `${id}?view=other`, `${id}/edit`, '.', '\ud800'])(
    'does not expose a retry to another endpoint for invalid id %s',
    async (assetId) => {
      vi.mocked(api.asset).mockImplementation(actualApi.asset);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const html = await render({}, assetId);
      expect(html).toContain('資産を指定する情報が正しくありません。');
      expect(html).not.toContain('再取得する');
      expect(links(html).map((item) => item.href)).toEqual(['/assets', '/portal']);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('asset detail unchanged success contract', () => {
  it.each([
    ['agent', true, true],
    ['auditor', true, false],
    ['requester', false, false],
  ] as const)(
    'preserves %s DTO visibility, history, links and saved notice',
    async (roleCode, privateFields, canManage) => {
      vi.mocked(requireSession).mockResolvedValue({
        ...session,
        roles: [{ roleCode, organizationId: session.organizationId }],
      });
      vi.mocked(api.asset).mockResolvedValue({ ok: true, data: data(privateFields, canManage) });
      navigation.params = new URLSearchParams({
        returnTo: '/assets?assignment=mine&page=2',
        saved: '1',
      });
      const html = await render({ saved: '1' });
      expect(html).toContain('AST-066 · 合成の端末');
      expect(html).toContain('資産と履歴を保存しました。');
      expect(html).toContain('2026年10月9日');
      expect(html).toContain('10:00');
      expect(html).toContain(`data-related-kind="asset" data-related-id="${id}"`);
      expect(link(html, '元の画面へ戻る').href).toBe('/assets?assignment=mine&page=2');
      expect(link(html, 'TKT-066 · 合成の問い合わせ').href).toBe(
        `/${canManage ? 'ops' : 'tickets'}/${ticketId}`,
      );
      expect(html.includes('合成内部メモ')).toBe(privateFields);
      expect(html.includes('合成保管場所')).toBe(privateFields);
      expect(html.includes('合成の更新理由')).toBe(privateFields);
      expect(html.includes('合成の関連理由')).toBe(privateFields);
      expect(html.includes('資産・状態・利用者を編集する')).toBe(canManage);
      if (privateFields) {
        expect(html).toContain('登録時の端末');
        expect(html).toContain('更新後の端末');
        expect(html).toContain('版1 → 版2：変更した');
      }
      if (canManage) {
        const edit = new URL(
          link(html, '資産・状態・利用者を編集する').href,
          'https://solvi.local',
        );
        expect(edit.pathname).toBe(`/assets/${id}/edit`);
        expect(edit.searchParams.get('returnTo')).toBe(
          `/assets/${id}?returnTo=%2Fassets%3Fassignment%3Dmine%26page%3D2`,
        );
      }
      expect(html).not.toContain('再取得する');
      expect(api.asset).toHaveBeenCalledExactlyOnceWith(id);
    },
  );

  it('does not infer editing permission from the session role', async () => {
    vi.mocked(api.asset).mockResolvedValue({ ok: true, data: data(true, false) });
    const html = await render();
    expect(html).not.toContain('資産・状態・利用者を編集する');
    expect(html).not.toContain('資産と履歴を保存しました。');
  });
});

describe('asset detail dedicated GET transport', () => {
  it.each([
    id,
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    '00000000-0000-0000-0000-000000000000',
    '12345678-abcd-1234-1234-abcdef012345',
    '12345678-abcd-7234-1234-abcdef012345',
  ])(
    'preserves UUID lexical compatibility without version/variant restrictions (%s)',
    async (assetId) => {
      const fetch = vi.fn().mockResolvedValue(
        Response.json(data(), {
          headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
        }),
      );
      vi.stubGlobal('fetch', fetch);
      expect(await actualApi.asset(assetId)).toEqual({
        ok: true,
        data: data(),
        setCookie: 'synthetic_refresh=updated; HttpOnly',
      });
      const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(new URL(url).pathname + new URL(url).search).toBe(`/assets/${assetId}`);
      expect(init.method ?? 'GET').toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.cache).toBe('no-store');
      expect(new Headers(init.headers).get('cookie')).toBe('solvi_session=synthetic-session');
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(init.signal?.aborted).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    '',
    '.',
    '..',
    'options',
    '../options',
    `${id}/edit`,
    `${id}?page=1`,
    `${id}#fragment`,
    `${id}%2Fedit`,
    `${id}\n`,
    ` ${id}`,
    id.slice(1),
    id.replace('0', 'g'),
  ])('rejects invalid id without fetching (%s)', async (assetId) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.asset(assetId)).toEqual({
      ok: false,
      problem: { status: 400, title: '資産の指定が正しくありません' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 503],
    [403, 200],
    [404, 401],
    [400, 500],
    [500, 403],
    [503, 404],
  ])(
    'uses HTTP %s rather than body %s and does not read secret fields',
    async (status, declaredStatus) => {
      const response = Response.json(
        {
          status: declaredStatus,
          title: 'PRIVATE_TITLE',
          detail: 'PRIVATE_DETAIL',
          instance: 'PRIVATE_INSTANCE',
        },
        { status },
      );
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      expect(await actualApi.asset(id)).toEqual({
        ok: false,
        problem: { status, title: '資産を取得できませんでした' },
      });
      expect(read).not.toHaveBeenCalled();
      expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    },
  );

  it.each([200, 401, 403, 404, 400, 500, 503])(
    'handles a cut response body without losing HTTP denial (%s)',
    async (status) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('PRIVATE_BODY_SOURCE'));
        },
      });
      const response = new Response(body, { status });
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      expect(await actualApi.asset(id)).toEqual({
        ok: false,
        problem: { status: status === 200 ? 503 : status, title: '資産を取得できませんでした' },
      });
      expect(read).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(status !== 200);
    },
  );

  it.each(['never-settles', 'rejects'] as const)(
    'does not await or call unread body cancel (%s)',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'rejects'
          ? Promise.reject(new Error('PRIVATE_CANCEL'))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          actualApi.asset(id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('UNREAD_BODY_WAIT')), 100);
          }),
        ]);
        expect(result).toEqual({
          ok: false,
          problem: { status: 403, title: '資産を取得できませんでした' },
        });
        expect((fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it('returns bounded network and invalid-JSON failures', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK'))
      .mockResolvedValueOnce(new Response('PRIVATE_NOT_JSON'));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.asset(id)).toEqual({
      ok: false,
      problem: { status: 503, title: '資産を取得できませんでした' },
    });
    expect(await actualApi.asset(id)).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });

  it('preserves 204/set-cookie and omits cookie when there is none', async () => {
    cookieState.values = [];
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.asset(id)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(init.signal?.aborted).toBe(false);
  });
});
