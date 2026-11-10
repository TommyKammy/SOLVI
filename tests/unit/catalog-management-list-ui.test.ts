// NFR-UX-002, NFR-UX-003, NFR-UX-004: catalog list conditions and read-only recovery.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type CatalogAdminSummary } from '../../apps/web/src/lib/api';
import { safeReturnTo, withReturnTo } from '../../apps/web/src/lib/navigation';
import {
  catalogListContext,
  catalogListPageSize,
  catalogListQuery,
  catalogListUrl,
  catalogListView,
} from '../../apps/web/src/lib/catalog-management-list';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { catalogManagementRead: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => '/catalog/manage',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props),
}));
type Values = Record<string, string | string[] | undefined>;
type Page = (props: { searchParams: Promise<Values> }) => Promise<ReactNode>;
const { default: Manage } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/catalog/manage/page',
);
const items: CatalogAdminSummary[] = Array.from({ length: 43 }, (_, index) => ({
  id: '08700000-0000-4000-8000-' + String(index + 10).padStart(12, '0'),
  code: 'service-' + String(index + 1).padStart(3, '0'),
  title: index === 0 ? '合成SpecialTitle' : '合成サービス' + (index + 1),
  description: index === 1 ? 'DescriptionNeedle' : index === 2 ? 'literal %_.*' : '合成説明',
  editVersion: 7,
  draftRevision: index % 3 === 2 ? 5 : 3,
  publishedRevision: index % 3 === 0 ? null : 3,
  active: index % 3 !== 0,
}));
const normal = (values: Values = {}) => catalogListQuery(values);
const render = async (values: Values = {}) =>
  renderToStaticMarkup(await Manage({ searchParams: Promise.resolve(values) }));
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  vi.mocked(api.catalogManagementRead).mockResolvedValue({
    ok: true,
    data: { items, approvers: [] },
  });
  vi.mocked(requireSession).mockResolvedValue({
    userId: 'synthetic',
    organizationId: 'synthetic',
    roles: [],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('canonical catalog conditions', () => {
  it('ignores duplicate, unknown, flash and unsafe values', () => {
    expect(normal({ q: ['a', 'b'], state: ['published'], page: ['2'], returnTo: ['x'] })).toEqual({
      q: '',
      state: 'all',
      page: 1,
      returnTo: null,
    });
    expect(catalogListUrl(normal({ unknown: 'secret', created: '1', saved: '1' }))).toBe(
      '/catalog/manage',
    );
    expect(normal({ state: 'inactive', returnTo: 'https://outside.invalid' }).state).toBe('all');
    expect(normal({ returnTo: 'https://outside.invalid' }).returnTo).toBeNull();
  });
  it.each(['', '0', '-1', '01', '1.1', '1e3', ' 2', '2 ', '+2', '100001', '999999', '1000000'])(
    'defaults invalid page %j',
    (page) => expect(normal({ page }).page).toBe(1),
  );
  it.each(['1', '2', '99999', '100000'])('accepts valid page %s', (page) => {
    expect(normal({ page }).page).toBe(Number(page));
  });
  it('trims and limits q before using it consistently', () => {
    expect(normal({ q: '  合成  ' }).q).toBe('合成');
    expect(normal({ q: 'x'.repeat(101) }).q).toBe('x'.repeat(100));
    expect(normal({ q: 'a'.repeat(99) + '😀' }).q).toBe('a'.repeat(99));
    expect(normal({ q: 'a'.repeat(98) + '😀' }).q).toBe('a'.repeat(98) + '😀');
    expect(normal({ q: '\ud800z\udfff' }).q).toBe('\ufffdz\ufffd');
  });
  it('round trips the same USV q and approved returnTo', () => {
    for (const q of ['a'.repeat(99) + '😀', '\ud800', '%_.*', '  合成  ']) {
      const parsed = normal({
        q,
        state: 'changed',
        page: '2',
        returnTo: '/catalog?q=from&saved=1',
      });
      const encoded = new URL(catalogListUrl(parsed), 'https://solvi.local');
      expect(normal(Object.fromEntries(encoded.searchParams))).toEqual(parsed);
      expect(encoded.searchParams.get('returnTo')).toBe('/catalog?q=from');
    }
  });
  it('uses deterministic approved order and omits defaults', () => {
    expect(
      catalogListUrl(normal({ q: '合成', state: 'changed', page: '2', returnTo: '/catalog' })),
    ).toBe('/catalog/manage?q=%E5%90%88%E6%88%90&state=changed&page=2&returnTo=%2Fcatalog');
    expect(catalogListUrl(normal({ state: 'all', page: '1' }))).toBe('/catalog/manage');
  });
  it('drops only the parent when its nested URL exceeds the shared limit', () => {
    const query = normal({
      q: '合成',
      state: 'changed',
      page: '2',
      returnTo: '/catalog?q=' + 'a'.repeat(1980),
    });
    expect(query.returnTo).not.toBeNull();
    expect(safeReturnTo(catalogListUrl(query))).toBeNull();
    expect(catalogListContext(query)).toBe(catalogListUrl({ ...query, returnTo: null }));
    const target = new URL(
      withReturnTo('/catalog/manage/' + items[0].id, catalogListContext(query)),
      'https://solvi.local',
    );
    expect(target.searchParams.get('returnTo')).toBe(
      '/catalog/manage?q=%E5%90%88%E6%88%90&state=changed&page=2',
    );
  });
  it.each(['日'.repeat(100), '😀'.repeat(50), '%'.repeat(100), '\u0001'.repeat(100)])(
    'keeps maximal parent-free encoded conditions within navigation acceptance',
    (q) => {
      for (const state of ['all', 'published', 'unpublished', 'changed']) {
        const path = catalogListContext(normal({ q, state, page: '100000' }));
        expect(path.length).toBeLessThanOrEqual(2000);
        expect(safeReturnTo(path)).toBe(path);
      }
    },
  );
});

describe('authorized item presentation', () => {
  it.each([
    ['specialtitle', 0],
    ['descriptionneedle', 1],
    ['SERVICE-003', 2],
    ['%_.*', 2],
  ])('searches literal title/description/code %s', (q, index) => {
    expect(catalogListView(items, normal({ q })).items).toEqual([items[index as number]]);
  });
  it('applies original publication predicates without sorting or mutating', () => {
    const before = JSON.stringify(items);
    for (const state of ['published', 'unpublished', 'changed']) {
      const matches = items.filter((i) =>
        state === 'published'
          ? i.active
          : state === 'unpublished'
            ? !i.active
            : i.active && i.draftRevision !== i.publishedRevision,
      );
      const view = catalogListView(items, normal({ state }));
      expect(view.matched).toBe(matches.length);
      expect(view.items).toEqual(matches.slice(0, catalogListPageSize));
    }
    expect(catalogListView(items, normal({ q: 'service-003', state: 'unpublished' })).matched).toBe(
      0,
    );
    expect(JSON.stringify(items)).toBe(before);
  });
  it('keeps page boundaries and never clamps a valid empty current page', () => {
    expect(catalogListView(items, normal()).items).toEqual(items.slice(0, 20));
    expect(catalogListView(items, normal({ page: '2' }))).toMatchObject({
      start: 21,
      end: 40,
      previous: true,
      next: true,
    });
    expect(catalogListView(items, normal({ page: '3' }))).toMatchObject({
      start: 41,
      end: 43,
      previous: true,
      next: false,
    });
    expect(catalogListView(items, normal({ page: '100000' }))).toMatchObject({
      items: [],
      start: 0,
      end: 0,
      previous: false,
      next: false,
    });
  });
});

describe('management page and original recovery', () => {
  it('renders GET controls, counts, version text and canonical links', async () => {
    const html = await render({
      q: 'service',
      page: '2',
      returnTo: '/catalog',
      unknown: 'PRIVATE',
    });
    expect(html).toContain('method="get"');
    expect(html).toContain('全43件');
    expect(html).toContain('21〜40件');
    expect(html).toContain('公開中（版3）');
    expect(html).toContain('下書き版5');
    expect(html).toContain('未公開の変更あり');
    expect(html).not.toContain('name="page"');
    expect(html).not.toContain('PRIVATE');
    const target = hrefs(html).find((h) => h.startsWith('/catalog/manage/' + items[20].id))!;
    expect(new URL(target, 'https://solvi.local').searchParams.get('returnTo')).toBe(
      '/catalog/manage?q=service&page=2&returnTo=%2Fcatalog',
    );
    expect(hrefs(html)).toContain('/catalog/manage?returnTo=%2Fcatalog');
    expect(api.catalogManagementRead).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['ordinary', 'filtered', 'current'])('distinguishes %s emptiness', async (kind) => {
    if (kind === 'ordinary')
      vi.mocked(api.catalogManagementRead).mockResolvedValue({
        ok: true,
        data: { items: [], approvers: [] },
      });
    const html = await render(
      kind === 'filtered' ? { q: 'none' } : kind === 'current' ? { page: '4' } : {},
    );
    expect(html).toContain(
      kind === 'ordinary'
        ? 'まだサービスがありません'
        : kind === 'filtered'
          ? '条件に一致するサービスがありません'
          : 'このページにサービスがありません',
    );
    if (kind === 'current') expect(html).toContain('先頭ページへ戻る');
  });
  it.each([400, 401, 503])(
    'preserves status %s guidance and retry conditions without DTO/form',
    async (status) => {
      vi.mocked(api.catalogManagementRead).mockResolvedValue({
        ok: false,
        problem: { status, title: 'PRIVATE', detail: 'PRIVATE' },
      });
      const html = await render({
        q: '合成',
        state: 'changed',
        page: '2',
        returnTo: '/catalog?created=1',
        unknown: 'PRIVATE',
      });
      expect(html).toContain(
        status === 400
          ? '元の画面やカタログから開き直してください'
          : status === 401
            ? 'ログインし直してから'
            : '時間をおいて',
      );
      expect(hrefs(html)).toContain(
        '/catalog/manage?q=%E5%90%88%E6%88%90&state=changed&page=2&returnTo=%2Fcatalog',
      );
      expect(html).not.toContain('<form');
      expect(html).not.toContain('PRIVATE');
      expect(html).not.toContain('service-');
    },
  );
  it.each([403, 404])('retains status %s notFound', async (status) => {
    vi.mocked(api.catalogManagementRead).mockResolvedValue({
      ok: false,
      problem: { status, title: 'PRIVATE' },
    });
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('requires session before the unchanged main GET', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.catalogManagementRead).not.toHaveBeenCalled();
  });
});
