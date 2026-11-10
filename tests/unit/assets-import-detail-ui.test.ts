// NFR-UX-002, NFR-UX-003, NFR-UX-004: CSV detail recovery through the real page and dedicated reader.
// ApplyAssetCsvForm is a render probe; real authorization, CSV writes and browser a11y are separate evidence.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  api,
  requireSession,
  type AssetImportDetail,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { ApplyAssetCsvForm } from '../../apps/web/src/components/AssetCsvForms';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), path: '' }));
const cookieState = vi.hoisted(() => ({
  values: [{ name: 'solvi_session', value: 'synthetic-session' }],
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    assetImportDetail: vi.fn(),
    assetImport: vi.fn(),
    assetImports: vi.fn(),
    assetOptions: vi.fn(),
    assetFormOptions: vi.fn(),
    asset: vi.fn(),
    assets: vi.fn(),
    createAsset: vi.fn(),
    editAsset: vi.fn(),
    inspectAssetCsv: vi.fn(),
    previewAssetCsv: vi.fn(),
    applyAssetImport: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/AssetCsvForms', () => ({
  ApplyAssetCsvForm: vi.fn(() => createElement('form', { 'data-apply-probe': 'true' })),
}));
vi.mock('../../apps/web/src/components/AssetImportInspection', async () => {
  // Preserve this recovery suite's original table expectations; new inspection behavior has its own real-component unit/UI proof.
  const { ContextLink } = await import('../../apps/web/src/components/ContextLink');
  const labels = { add: '追加', update: '更新', unchanged: '変更なし', error: '不正・隔離' };
  return {
    AssetImportInspection: ({
      rows,
    }: {
      rows: import('../../apps/web/src/components/AssetImportInspection').AssetImportInspectionRow[];
    }) =>
      createElement(
        'table',
        null,
        createElement('thead', null, createElement('tr')),
        createElement(
          'tbody',
          null,
          rows.map((row) =>
            createElement(
              'tr',
              { key: row.row },
              createElement('td', null, row.row),
              createElement(
                'td',
                null,
                row.externalId,
                row.assetId
                  ? createElement(ContextLink, { href: '/assets/' + row.assetId }, row.assetTag)
                  : row.assetTag,
              ),
              createElement('td', null, labels[row.operation]),
              createElement(
                'td',
                null,
                row.issues.map((issue, index) => createElement('p', { key: index }, issue)),
                row.operation !== 'error' &&
                  createElement(
                    React.Fragment,
                    null,
                    createElement(
                      'p',
                      null,
                      row.match === 'asset_tag'
                        ? '初回の資産タグ一致: この資産へ外部IDを対応付けます。'
                        : row.match === 'external_id'
                          ? '登録済みの外部IDで一致'
                          : '新しい資産を登録',
                      row.expectedVersion ? '（確認時の版' + row.expectedVersion + '）' : '',
                    ),
                    row.changes.length
                      ? row.changes.map((change) =>
                          createElement(
                            'p',
                            { key: change.field },
                            change.label +
                              ': ' +
                              (change.before ?? '（なし）') +
                              ' → ' +
                              (change.after || '（空欄）'),
                          ),
                        )
                      : createElement('p', null, '資産の内容・版を変更しません。'),
                  ),
              ),
            ),
          ),
        ),
      ),
  };
});
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ getAll: () => cookieState.values })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(),
  usePathname: () => navigation.path,
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: AssetImportPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/assets/imports/[id]/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const { GET: getErrors } = await vi.importActual<
  typeof import('../../apps/web/src/app/assets/imports/[id]/errors/route')
>('../../apps/web/src/app/assets/imports/[id]/errors/route');
const id = '07000000-0000-4000-8000-000000000010';
const assetId = '07000000-0000-4000-8000-000000000020';
const savedAssetId = '07000000-0000-4000-8000-000000000021';
const session: SessionView = {
  userId: '07000000-0000-4000-8000-000000000002',
  organizationId: '07000000-0000-4000-8000-000000000001',
  roles: [{ roleCode: 'agent', organizationId: '07000000-0000-4000-8000-000000000001' }],
};
const detail: AssetImportDetail = {
  id,
  sourceKey: 'synthetic-source',
  contentHash: 'a'.repeat(64),
  planHash: 'b'.repeat(64),
  createdAt: '2026-10-09T00:00:00.000Z',
  creatorName: '合成作成者',
  canManage: true,
  plan: {
    headers: ['外部ID', '名前'],
    mapping: { externalId: '外部ID', name: '名前', location: '' },
    reason: '合成の取込理由',
    counts: { add: 1, update: 1, unchanged: 1, error: 1 },
    rows: (['add', 'update', 'unchanged', 'error'] as const).map((operation, index) => ({
      row: index + 2,
      externalId: `synthetic-external-${index}`,
      assetTag: `SYN-${index}`,
      operation,
      assetId: index === 1 || index === 2 ? assetId : null,
      expectedVersion: index === 1 || index === 2 ? 7 : null,
      identityExists: index === 2,
      match: index === 1 ? 'asset_tag' : index === 2 ? 'external_id' : 'new',
      input: operation === 'error' ? null : { name: '合成資産' },
      assignedEmail: null,
      issues: operation === 'error' ? ['合成の隔離理由'] : [],
      changes:
        index === 0
          ? [{ field: 'name', label: '名前', before: null, after: '合成資産' }]
          : index === 1
            ? [{ field: 'location', label: '設置場所', before: '旧設置場所', after: '' }]
            : [],
    })),
  },
  receipt: null,
};
const receipt: NonNullable<AssetImportDetail['receipt']> = {
  appliedAt: '2026-10-09T01:00:00.000Z',
  actorName: '合成確定者',
  result: {
    added: 1,
    updated: 1,
    unchanged: 1,
    skipped: 1,
    assets: [{ row: 3, id: savedAssetId, version: 8 }],
  },
};
const render = async (query: Query = {}, target = id) => {
  navigation.path = '/assets/imports/' + target;
  navigation.params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') navigation.params.set(key, value);
    else if (Array.isArray(value)) for (const item of value) navigation.params.append(key, item);
  }
  return renderToStaticMarkup(
    await AssetImportPage({
      params: Promise.resolve({ id: target }),
      searchParams: Promise.resolve(query),
    }),
  );
};
const plainText = (html: string) => html.replace(/<[^>]*>/g, '');
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/gs)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: plainText(m[4]),
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const link = (html: string, label: string) => {
  const found = links(html).find((item) => item.label === label);
  expect(found, label).toBeDefined();
  return found!;
};
const message = (status: number) =>
  status === 401
    ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
    : status === 400
      ? '取込内容を指定する情報が正しくありません。取込履歴から選び直してください。'
      : '一時的に取込内容を読み込めませんでした。時間をおいて、もう一度お試しください。';
const noDetailOrActions = (html: string) => {
  expect(html).not.toMatch(
    /PRIVATE_|synthetic-source|合成の取込理由|<table|<form|<button|CSV SHA-256|プレビューID|確定済み|不正行のレポート|別のCSV|<input/,
  );
  expect(plainText(html)).not.toContain(id);
  expect(ApplyAssetCsvForm).not.toHaveBeenCalled();
};
const rejected = async (status: number) => {
  if (status === 403 || status === 404) {
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(ApplyAssetCsvForm).not.toHaveBeenCalled();
  } else {
    const html = await render();
    expect(html).toContain('<h1>取込内容を読み込めませんでした</h1>');
    expect(html).toContain(`<p role="alert">${message(status)}</p>`);
    expect(links(html)).toEqual([
      { label: '再取得する', href: '/assets/imports/' + id, native: true },
      { label: '取込履歴へ戻る', href: '/assets/imports', native: true },
      { label: 'ポータルへ戻る', href: '/portal', native: true },
    ]);
    expect(notFound).not.toHaveBeenCalled();
    noDetailOrActions(html);
  }
};
const transportResult = () => vi.mocked(api.assetImportDetail).mock.results[0].value;
const failDetail = (status = 503) =>
  vi.mocked(api.assetImportDetail).mockResolvedValue({
    ok: false,
    problem: {
      status,
      title: 'PRIVATE_TITLE',
      detail: 'PRIVATE_DETAIL',
      type: 'https://private.invalid/problem',
      correlationId: 'PRIVATE_ID',
    },
  });
let legacyRoute = false;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(detail)));
  cookieState.values = [{ name: 'solvi_session', value: 'synthetic-session' }];
  navigation.params = new URLSearchParams();
  navigation.path = '/assets/imports/' + id;
  legacyRoute = false;
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.assetImportDetail).mockReset().mockImplementation(actualApi.assetImportDetail);
  vi.mocked(api.assetImport).mockReset().mockImplementation(actualApi.assetImport);
});
afterEach(() => {
  for (const action of [
    api.assetImports,
    api.assetOptions,
    api.assetFormOptions,
    api.asset,
    api.assets,
    api.createAsset,
    api.editAsset,
    api.inspectAssetCsv,
    api.previewAssetCsv,
    api.applyAssetImport,
  ])
    expect(action).not.toHaveBeenCalled();
  if (!legacyRoute) expect(api.assetImport).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CSV detail session and unchanged successful renderer', () => {
  it('awaits authentication before requesting the detail', async () => {
    let release!: (value: SessionView) => void;
    vi.mocked(requireSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = render();
    expect(requireSession).toHaveBeenCalledOnce();
    expect(api.assetImportDetail).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    release(session);
    await pending;
    expect(api.assetImportDetail).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('does not fetch or render a form when requireSession rejects', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_REDIRECT'));
    await expect(render()).rejects.toThrow('SESSION_REDIRECT');
    expect(api.assetImportDetail).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ApplyAssetCsvForm).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'preserves preview rows, diffs, JST and canManage=%s',
    async (canManage) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...detail, canManage })));
      const html = await render();
      const text = plainText(html);
      expect(html).toContain('<h1>CSV取込プレビュー</h1>');
      expect(text).toContain('synthetic-source · 2026年10月9日 09:00 · 合成作成者');
      expect(text).toContain('取込理由: 合成の取込理由');
      expect(text).toMatch(/追加1件 · 更新1件 · 変更なし1件 · 不正1件/);
      expect(html.match(/<tr>/g)).toHaveLength(5);
      for (const label of ['追加', '更新', '変更なし', '不正・隔離'])
        expect(html).toContain(`<td>${label}</td>`);
      expect(text).toContain('名前: （なし） → 合成資産');
      expect(text).toContain('設置場所: 旧設置場所 → （空欄）');
      expect(text).toContain('初回の資産タグ一致: この資産へ外部IDを対応付けます。（確認時の版7）');
      expect(text).toContain('登録済みの外部IDで一致（確認時の版7）');
      expect(text).toContain('資産の内容・版を変更しません。');
      expect(text).toContain('合成の隔離理由');
      expect(text).toContain('CSV SHA-256: ' + detail.contentHash);
      expect(text).toContain('プレビューID: ' + id);
      expect(html).toContain('<dd>対応なし</dd>');
      expect(
        new URL(link(html, '不正行のレポートを保存する（JSON）').href, 'https://solvi.local')
          .pathname,
      ).toBe('/assets/imports/' + id + '/errors');
      expect(link(html, '不正行のレポートを保存する（JSON）').native).toBe(false);
      expect(ApplyAssetCsvForm).toHaveBeenCalledTimes(canManage ? 1 : 0);
      if (canManage)
        expect(vi.mocked(ApplyAssetCsvForm).mock.calls[0][0]).toEqual({
          id,
          planHash: detail.planHash,
          count: 3,
        });
      expect(html).not.toMatch(/再取得する|正常行がありません|確定済み/);
    },
  );
  it.each([true, false])(
    'retains zero normal rows and canManage=%s without an apply form',
    async (canManage) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json({
            ...detail,
            canManage,
            plan: {
              ...detail.plan,
              counts: { add: 0, update: 0, unchanged: 0, error: 1 },
              rows: [detail.plan.rows[3]],
            },
          }),
        ),
      );
      const html = await render();
      expect(html).toContain('正常行がありません。CSVを修正し再プレビューしてください。');
      expect(ApplyAssetCsvForm).not.toHaveBeenCalled();
      expect(link(html, '不正行のレポートを保存する（JSON）')).toBeDefined();
    },
  );
  it('retains receipt results and saved asset identity without rendering the apply form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...detail, receipt })));
    const html = await render();
    const text = plainText(html);
    expect(html).toContain('<h1>CSV取込の確定結果</h1>');
    expect(text).toContain('確定済み · 2026年10月9日 10:00 · 合成確定者');
    expect(text).toMatch(/保存: 追加1 \/ 更新1 \/ 変更なし1 \/ 隔離1/);
    expect(new URL(link(html, 'SYN-1').href, 'https://solvi.local').pathname).toBe(
      '/assets/' + savedAssetId,
    );
    expect(new URL(link(html, 'SYN-2').href, 'https://solvi.local').pathname).toBe(
      '/assets/' + assetId,
    );
    expect(link(html, '保存した資産を見る')).toEqual({
      label: '保存した資産を見る',
      href: '/assets',
      native: true,
    });
    expect(ApplyAssetCsvForm).not.toHaveBeenCalled();
    expect(html).not.toContain('まだ資産を変更していません');
  });
  it('preserves successful ContextLink back and forward context', async () => {
    const returnTo = '/assets?q=synthetic&state=in_use&kind=pc&assignment=mine&page=2';
    const html = await render({ returnTo });
    expect(link(html, '元の画面へ戻る')).toEqual({
      label: '元の画面へ戻る',
      href: returnTo,
      native: false,
    });
    const forward = new URL(link(html, '別のCSVをプレビューする').href, 'https://solvi.local');
    expect(forward.pathname).toBe('/assets/imports/new');
    expect(forward.searchParams.get('returnTo')).toBe(
      '/assets/imports/' + id + '?' + new URLSearchParams({ returnTo }),
    );
  });
});

describe('CSV detail dedicated GET transport and UUID boundary', () => {
  it.each([id, 'ABCDEF00-ABCD-FABC-0DEF-ABCDEFABCDEF', '00000000-0000-0000-0000-000000000000'])(
    'accepts backend UUID lexical form without version or variant restriction (%s)',
    async (target) => {
      const setCookie = 'synthetic_refresh=ok; HttpOnly';
      cookieState.values.push({ name: 'synthetic_context', value: 'selected' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(Response.json(detail, { headers: { 'set-cookie': setCookie } })),
      );
      expect(await actualApi.assetImportDetail(target)).toEqual({
        ok: true,
        data: detail,
        setCookie,
      });
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(new URL(String(url)).pathname).toBe('/assets/imports/' + target);
      expect(new URL(String(url)).search).toBe('');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.cache).toBe('no-store');
      expect(new Headers(init?.headers).get('cookie')).toBe(
        'solvi_session=synthetic-session; synthetic_context=selected',
      );
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    },
  );
  it.each([
    '',
    'invalid',
    '../options',
    id + '/errors',
    id + '?q=x',
    id + '#fragment',
    '%2f',
    '07000000-0000-4000-8000-00000000001g',
    '\ud800',
  ])('rejects non-UUID before cookies/fetch and avoids retry encoding (%j)', async (target) => {
    const html = await render({}, target);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 400, title: '取込内容の指定が正しくありません' },
    });
    expect(cookies).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(html).toContain(message(400));
    expect(links(html)).toEqual([
      { label: '取込履歴へ戻る', href: '/assets/imports', native: true },
      { label: 'ポータルへ戻る', href: '/portal', native: true },
    ]);
    noDetailOrActions(html);
  });
  it.each([null, undefined, 123, {}])(
    'rejects a non-string runtime ID before encoding (%j)',
    async (target) => {
      expect(await actualApi.assetImportDetail(target as unknown as string)).toEqual({
        ok: false,
        problem: { status: 400, title: '取込内容の指定が正しくありません' },
      });
      expect(cookies).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 'synthetic_refresh=ok; HttpOnly'])(
    'retains 204/set-cookie compatibility only at the transport boundary (%s)',
    async (setCookie) => {
      cookieState.values = [];
      const response = new Response(null, {
        status: 204,
        headers: setCookie ? { 'set-cookie': setCookie } : {},
      });
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      expect(await actualApi.assetImportDetail(id)).toEqual({
        ok: true,
        data: undefined,
        ...(setCookie ? { setCookie } : {}),
      });
      expect(text).not.toHaveBeenCalled();
      expect(requireSession).not.toHaveBeenCalled();
      expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has('cookie')).toBe(false);
    },
  );
  it.each([
    [400, 500],
    [401, 503],
    [403, 200],
    [404, 401],
    [500, 403],
    [503, 404],
  ])(
    'preserves received HTTP %s over body-declared %s without reading raw details',
    async (status, bodyStatus) => {
      const response = Response.json(
        { status: bodyStatus, title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL' },
        { status },
      );
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await rejected(status);
      expect(await transportResult()).toEqual({
        ok: false,
        problem: { status, title: '取込内容を取得できませんでした' },
      });
      expect(text).not.toHaveBeenCalled();
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
  it.each([200, 400, 401, 403, 404, 500, 503])(
    'keeps denial classification through a cut body (%s)',
    async (status) => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('PRIVATE_BODY'));
          },
        }),
        { status },
      );
      const text = vi.spyOn(response, 'text');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const expected = status === 200 ? 503 : status;
      await rejected(expected);
      expect(await transportResult()).toEqual({
        ok: false,
        problem: { status: expected, title: '取込内容を取得できませんでした' },
      });
      expect(text).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(status !== 200);
    },
  );
  it.each(['never-settles', 'rejects'] as const)(
    'returns notFound without invoking or waiting for cancel (%s)',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'rejects'
          ? Promise.reject(new Error('PRIVATE_CANCEL'))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            render(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('CANCEL_WAIT')), 100);
            }),
          ]),
        ).rejects.toThrow('NEXT_NOT_FOUND');
        expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timer);
      }
    },
  );
  it('maps network failure to fixed 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PRIVATE_NETWORK')));
    await rejected(503);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 503, title: '取込内容を取得できませんでした' },
    });
  });
  it('maps invalid successful JSON to fixed 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('PRIVATE_JSON', { status: 200 })),
    );
    await rejected(502);
    expect(await transportResult()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });
});

describe('CSV detail fixed failure rendering and native URL boundaries', () => {
  it.each([400, 401, 500, 502, 503])(
    'does not render raw problem or partial detail (%s)',
    async (status) => {
      failDetail(status);
      await rejected(status);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('retains only one normalized returnTo on the same detail GET', async () => {
    failDetail();
    const returnTo =
      '/assets?' +
      new URLSearchParams({
        q: '合成 &%_\\?',
        state: 'in_use',
        kind: 'pc',
        assignment: 'mine',
        page: '2',
      });
    const html = await render({
      returnTo: returnTo + '&saved=1&created=1&updated=1',
      q: 'PRIVATE_Q',
      state: 'applied',
      page: ['9', '10'],
      applied: '1',
      saved: '1',
      created: '1',
      updated: '1',
      unknown: 'PRIVATE_UNKNOWN',
    });
    const retry = link(html, '再取得する');
    const url = new URL(retry.href, 'https://solvi.local');
    expect(retry.native).toBe(true);
    expect(url.pathname).toBe('/assets/imports/' + id);
    expect([...url.searchParams.keys()]).toEqual(['returnTo']);
    expect(url.searchParams.get('returnTo')).toBe(returnTo);
    expect(link(html, '元の画面へ戻る')).toEqual({
      label: '元の画面へ戻る',
      href: returnTo,
      native: true,
    });
    noDetailOrActions(html);
  });
  it('permits a normalized history return path and never forwards it to the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const html = await render({ returnTo: '/assets/imports?saved=1', applied: '1' });
    expect(link(html, '元の画面へ戻る').href).toBe('/assets/imports');
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).search).toBe('');
  });
  it.each([
    undefined,
    '',
    [],
    ['/assets'],
    ['/assets', '/requests'],
    'https://evil.invalid/assets',
    '//evil.invalid/assets',
    '/\\evil.invalid/assets',
    '/assets\n',
    '/admin',
    '/assets?' + 'x'.repeat(2000),
  ])('falls back to fixed history for absent/unsafe/non-single returnTo (%j)', async (returnTo) => {
    failDetail();
    const html = await render({ returnTo });
    expect(link(html, '再取得する')).toEqual({
      label: '再取得する',
      href: '/assets/imports/' + id,
      native: true,
    });
    expect(link(html, '取込履歴へ戻る')).toEqual({
      label: '取込履歴へ戻る',
      href: '/assets/imports',
      native: true,
    });
    expect(links(html)).toHaveLength(3);
    noDetailOrActions(html);
  });
  it('keeps a safe back link but no retry for an invalid ID', async () => {
    const html = await render({ returnTo: '/assets?state=in_use' }, '\ud800');
    expect(link(html, '元の画面へ戻る').href).toBe('/assets?state=in_use');
    expect(links(html)).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('unchanged legacy errors route consumer', () => {
  it('uses the old reader and returns only isolated error fields with download headers', async () => {
    legacyRoute = true;
    const response = await getErrors(
      new Request('https://solvi.local/assets/imports/' + id + '/errors'),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      importId: id,
      rows: [
        {
          row: 5,
          externalId: 'synthetic-external-3',
          assetTag: 'SYN-3',
          issues: ['合成の隔離理由'],
        },
      ],
    });
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="asset-import-${id}-errors.json"`,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(api.assetImport).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.assetImportDetail).not.toHaveBeenCalled();
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).pathname).toBe(
      '/assets/imports/' + id,
    );
  });
  it.each([403, 404])('preserves the legacy errors response for HTTP %s', async (status) => {
    legacyRoute = true;
    const problem = { status, title: 'synthetic denial' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(problem, { status })));
    const response = await getErrors(
      new Request('https://solvi.local/assets/imports/' + id + '/errors'),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(problem);
    expect(api.assetImport).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.assetImportDetail).not.toHaveBeenCalled();
    expect(response.headers.has('content-disposition')).toBe(false);
  });
});
