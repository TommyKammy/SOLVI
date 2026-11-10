// NFR-UX-002, NFR-UX-003, NFR-UX-004: group directory display and protected recovery.
import React, {
  createElement,
  isValidElement,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession } from '../../apps/web/src/lib/api';
import { revalidatePath } from 'next/cache';
import {
  groupListContext,
  groupListItems,
  groupListPageSize,
  groupListQuery,
  groupListUrl,
  groupListView,
  type GroupListItem,
} from '../../apps/web/src/lib/group-management-list';
import { safeReturnTo, withReturnTo } from '../../apps/web/src/lib/navigation';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { listGroups: vi.fn(), createGroup: vi.fn(), setGroupActive: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error('REDIRECT:' + href);
  },
  usePathname: () => '/ops/groups',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props),
}));
type Values = Record<string, string | string[] | undefined>;
type Page = (props: { searchParams: Promise<Values> }) => Promise<ReactNode>;
const { default: Manage } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/ops/groups/page',
);
const items: GroupListItem[] = Array.from({ length: 53 }, (_, index) => ({
  id: '08900000-0000-4000-8000-' + String(index + 10).padStart(12, '0'),
  code: 'group-' + String(index + 1).padStart(3, '0'),
  name: index === 0 ? '合成SpecialName' : '合成グループ' + (index + 1),
  description: index === 1 ? 'DescriptionNeedle' : index === 2 ? 'literal %_.*' : null,
  active: index % 3 !== 0,
  memberCount: index % 5,
}));
const normal = (values: Values = {}) => groupListQuery(values);
const tree = (values: Values = {}) => Manage({ searchParams: Promise.resolve(values) });
const render = async (values: Values = {}) => renderToStaticMarkup(await tree(values));
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
const actions = (node: ReactNode): Array<(fd: FormData) => Promise<void>> => {
  if (Array.isArray(node)) return node.flatMap(actions);
  if (!isValidElement<{ action?: unknown; children?: ReactNode }>(node)) return [];
  return [
    ...(node.type === 'form' && typeof node.props.action === 'function'
      ? [node.props.action as (fd: FormData) => Promise<void>]
      : []),
    ...actions(node.props.children),
  ];
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  vi.mocked(api.listGroups).mockResolvedValue({ ok: true, data: { items } });
  vi.mocked(requireSession).mockResolvedValue({
    userId: 'synthetic',
    organizationId: 'synthetic',
    roles: [{ roleCode: 'org_admin', organizationId: 'synthetic' }],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('canonical directory conditions and non-destructive projection', () => {
  it('ignores plural/unknown/flash/unsafe conditions', () => {
    expect(normal({ q: ['x'], state: ['active'], page: ['2'], returnTo: ['x'] })).toEqual({
      q: '',
      state: 'all',
      page: 1,
      returnTo: null,
    });
    expect(
      groupListUrl(
        normal({
          error: 'PRIVATE',
          notice: 'done',
          unknown: 'x',
          returnTo: 'https://outside.invalid',
        }),
      ),
    ).toBe('/ops/groups');
    expect(normal({ state: 'published' }).state).toBe('all');
  });
  it.each(['', '0', '-1', '01', '1.1', '1e3', ' 2', '2 ', '+2', '100001', '999999', '1000000'])(
    'defaults malformed page %j',
    (page) => expect(normal({ page }).page).toBe(1),
  );
  it.each(['1', '2', '99999', '100000'])('accepts page %s', (page) =>
    expect(normal({ page }).page).toBe(Number(page)),
  );
  it('normalizes USV, trims and preserves supplementary characters at 200 UTF16 units', () => {
    expect(normal({ q: '  合成  ' }).q).toBe('合成');
    expect(normal({ q: 'x'.repeat(201) }).q).toBe('x'.repeat(200));
    expect(normal({ q: 'a'.repeat(199) + '😀' }).q).toBe('a'.repeat(199));
    expect(normal({ q: 'a'.repeat(198) + '😀' }).q).toBe('a'.repeat(198) + '😀');
    expect(normal({ q: '\ud800z\udfff' }).q).toBe('\ufffdz\ufffd');
  });
  it('round trips only approved values and retains a safe parent', () => {
    const parsed = normal({
      q: '  日本語😀%  ',
      state: 'inactive',
      page: '2',
      returnTo: '/ops?q=親',
      error: 'bad',
    });
    expect(
      normal(Object.fromEntries(new URL(groupListUrl(parsed), 'https://solvi.local').searchParams)),
    ).toEqual(parsed);
    expect(groupListUrl(normal({ q: 'a', state: 'active', page: '2', returnTo: '/ops' }))).toBe(
      '/ops/groups?q=a&state=active&page=2&returnTo=%2Fops',
    );
  });
  it('drops only an oversized parent for detail context', () => {
    const q = normal({
      q: '日本語'.repeat(60) + '😀',
      state: 'active',
      page: '2',
      returnTo: '/ops?q=' + 'a'.repeat(1950),
    });
    expect(safeReturnTo(groupListUrl(q))).toBeNull();
    const context = groupListContext(q);
    expect(safeReturnTo(context)).toBe(context);
    expect(new URL(context, 'https://solvi.local').searchParams.has('returnTo')).toBe(false);
    expect(new URL(context, 'https://solvi.local').searchParams.get('q')).toBe(q.q);
    expect(
      new URL(
        withReturnTo('/ops/groups/' + items[1].id, context),
        'https://solvi.local',
      ).searchParams.get('returnTo'),
    ).toBe(context);
  });
  it.each([
    ['specialname', 0],
    ['GROUP-002', 1],
    ['descriptionneedle', 1],
    ['%_.*', 2],
  ] as const)('literal case-insensitive OR %s', (q, index) =>
    expect(groupListView(items, normal({ q })).items).toEqual([items[index]]),
  );
  it.each(['all', 'active', 'inactive'] as const)(
    'filters state %s without changing order',
    (state) => {
      const expected = items.filter(
        (i) => state === 'all' || (state === 'active' ? i.active : !i.active),
      );
      expect(groupListView(items, normal({ state })).items).toEqual(expected.slice(0, 25));
    },
  );
  it('returns 25/25/3 stable slices and keeps source bytes unchanged', () => {
    const before = JSON.stringify(items);
    expect(groupListPageSize).toBe(25);
    for (const page of [1, 2, 3])
      expect(groupListView(items, normal({ page: String(page) })).items).toEqual(
        items.slice((page - 1) * 25, page * 25),
      );
    expect(JSON.stringify(items)).toBe(before);
    expect(groupListView(items, normal({ page: '3' }))).toMatchObject({
      start: 51,
      end: 53,
      next: false,
      previous: true,
    });
  });
  it('distinguishes all-empty, filter-empty and valid oversized page without clamping', () => {
    expect(groupListView([], normal())).toMatchObject({ total: 0, matched: 0, items: [] });
    expect(groupListView(items, normal({ q: 'missing' }))).toMatchObject({
      total: 53,
      matched: 0,
      items: [],
    });
    expect(groupListView(items, normal({ page: '100000' }))).toMatchObject({
      total: 53,
      matched: 53,
      start: 0,
      end: 0,
      items: [],
      previous: false,
      next: false,
    });
  });
});

describe('actual directory read and protected rendering', () => {
  it('uses the same full list API, shows first 25, counts, and canonical detail links', async () => {
    const html = await render({
      q: '合成',
      returnTo: '/ops?q=親',
      unknown: 'secret',
      error: 'flash',
    });
    expect(api.listGroups).toHaveBeenCalledExactlyOnceWith(true);
    expect(html).toContain('全53件');
    expect((html.match(/class="group(?: inactive)?"/g) ?? []).length).toBe(25);
    const detail = hrefs(html).find((h) => h.startsWith('/ops/groups/' + items[0].id));
    expect(new URL(detail!, 'https://solvi.local').searchParams.get('returnTo')).toBe(
      groupListContext(normal({ q: '合成', returnTo: '/ops?q=親' })),
    );
    expect(html).toContain('name="returnTo"');
    expect(html).not.toContain('name="page"');
  });
  it('renders different empty states and a safe first-page exit', async () => {
    expect(await render({ q: 'missing' })).toContain('条件に一致するグループがありません');
    const oversize = await render({ q: '合成', page: '100000', returnTo: '/ops' });
    expect(oversize).toContain('このページにグループがありません');
    expect(hrefs(oversize)).toContain('/ops/groups?q=%E5%90%88%E6%88%90&returnTo=%2Fops');
    vi.mocked(api.listGroups).mockResolvedValue({ ok: true, data: { items: [] } });
    expect(await render()).toContain('まだグループがありません');
  });
  it.each([400, 401, 500, 502, 503])(
    'HTTP %s gives fixed recovery with approved conditions and no write',
    async (status) => {
      vi.mocked(api.listGroups).mockResolvedValue({
        ok: false,
        problem: { status, title: 'PRIVATE', detail: 'PRIVATE' },
      });
      const html = await render({
        q: '合成',
        state: 'active',
        page: '2',
        returnTo: '/ops',
        error: 'PRIVATE',
        unknown: 'PRIVATE',
      });
      expect(html).toContain('担当グループを取得できませんでした');
      expect(hrefs(html)).toContain(
        groupListUrl(normal({ q: '合成', state: 'active', page: '2', returnTo: '/ops' })),
      );
      expect(html).not.toMatch(/<form|PRIVATE|group-001/);
      expect(api.createGroup).not.toHaveBeenCalled();
      expect(api.setGroupActive).not.toHaveBeenCalled();
    },
  );
  it.each([403, 404])(
    'HTTP %s is protected and offers no retry, form, DTO or raw error',
    async (status) => {
      vi.mocked(api.listGroups).mockResolvedValue({
        ok: false,
        problem: { status, title: 'PRIVATE' },
      });
      const html = await render();
      expect(html).toContain(
        status === 403 ? 'この画面を表示する権限がありません' : '担当グループを表示できません',
      );
      expect(html).not.toMatch(/<form|もう一度取得する|PRIVATE|group-001/);
    },
  );
  it('catches response body/network rejection only for this read', async () => {
    vi.mocked(api.listGroups).mockRejectedValue(new Error('PRIVATE body failure'));
    expect(await render()).toContain('担当グループを取得できませんでした');
    expect(await render()).not.toContain('PRIVATE');
  });
  it.each([
    undefined,
    null,
    {},
    [],
    { items: null },
    { items: [{}] },
    { items: [null] },
    { items: [{ ...items[0], description: 4 }] },
    { items: [{ ...items[0], active: 'false' }] },
    { items: [{ ...items[0], memberCount: -1 }] },
    { items: [{ ...items[0], memberCount: 1.5 }] },
    { items: [{ ...items[0], memberCount: Infinity }] },
  ])('does not mistake malformed or 204 DTO %j for emptiness', async (data) => {
    vi.mocked(api.listGroups).mockResolvedValue({ ok: true, data } as Awaited<
      ReturnType<typeof api.listGroups>
    >);
    expect(groupListItems(data)).toBeNull();
    const html = await render();
    expect(html).toContain('担当グループを取得できませんでした');
    expect(html).not.toMatch(/まだグループがありません|<form/);
    expect(html).toContain('もう一度取得する');
  });
  it('accepts normal nullable descriptions and valid empty DTO', () => {
    expect(groupListItems({ items })).toBe(items);
    expect(groupListItems({ items: [] })).toEqual([]);
  });
  it.each(['requester', 'agent', 'auditor'])(
    'keeps pre-read role denial for %s',
    async (roleCode) => {
      vi.mocked(requireSession).mockResolvedValue({
        userId: 's',
        organizationId: 's',
        roles: [{ roleCode, organizationId: 's' }],
      });
      expect(await render()).toContain('この画面を表示する権限がありません');
      expect(api.listGroups).not.toHaveBeenCalled();
    },
  );
  it.each(['/login', '/select-organization', '/unavailable'])(
    'does not catch session redirect %s',
    async (href) => {
      vi.mocked(requireSession).mockRejectedValue(new Error('REDIRECT:' + href));
      await expect(render()).rejects.toThrow('REDIRECT:' + href);
      expect(api.listGroups).not.toHaveBeenCalled();
    },
  );
  it('keeps platform admin access without changing the API call', async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: 's',
      organizationId: 's',
      roles: [{ roleCode: 'platform_admin', organizationId: null }],
    });
    expect(await render()).toContain('合成SpecialName');
    expect(api.listGroups).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('existing inline action contract and return conditions', () => {
  const values = {
    q: '合成',
    state: 'active',
    page: '2',
    returnTo: '/ops',
    unknown: 'PRIVATE',
    error: 'old',
  };
  it('keeps complete create parameters/order and revalidate on 201 success', async () => {
    vi.mocked(api.createGroup).mockResolvedValue({
      ok: true,
      data: { id: 'new', code: 'synthetic', name: '合成' },
    });
    const handlers = actions(await tree(values));
    const fd = new FormData();
    fd.set('code', 'synthetic');
    fd.set('name', '合成');
    fd.set('description', '');
    fd.set('injected', 'PRIVATE');
    await expect(handlers.at(-1)!(fd)).rejects.toThrow('REDIRECT:' + groupListUrl(normal(values)));
    expect(api.createGroup).toHaveBeenCalledExactlyOnceWith({
      code: 'synthetic',
      name: '合成',
      description: '',
    });
    expect(Object.keys(vi.mocked(api.createGroup).mock.calls[0][0])).toEqual([
      'code',
      'name',
      'description',
    ]);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/ops/groups');
  });
  it('keeps create failure detail and approved conditions without revalidate', async () => {
    vi.mocked(api.createGroup).mockResolvedValue({
      ok: false,
      problem: { status: 400, title: 'fallback', errors: [{ field: 'code', message: '既存記号' }] },
    });
    const handlers = actions(await tree(values));
    await expect(handlers.at(-1)!(new FormData())).rejects.toThrow(
      'REDIRECT:' + groupListUrl(normal(values)) + '&error=' + encodeURIComponent('既存記号'),
    );
    expect(api.createGroup).toHaveBeenCalledExactlyOnceWith({
      code: '',
      name: '',
      description: '',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each([true, false])('keeps toggle boolean %s, raw ID and 204/void result', async (active) => {
    vi.mocked(api.setGroupActive).mockResolvedValue({ ok: true, data: undefined });
    const handlers = actions(await tree(values));
    const fd = new FormData();
    fd.set('groupId', 'opaque/id');
    fd.set('active', String(active));
    await expect(handlers[0](fd)).rejects.toThrow('REDIRECT:' + groupListUrl(normal(values)));
    expect(api.setGroupActive).toHaveBeenCalledExactlyOnceWith('opaque/id', active);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/ops/groups');
  });
  it('keeps toggle error=1 and approved conditions on failure', async () => {
    vi.mocked(api.setGroupActive).mockResolvedValue({
      ok: false,
      problem: { status: 400, title: 'PRIVATE' },
    });
    const handlers = actions(await tree(values));
    const fd = new FormData();
    fd.set('groupId', items[1].id);
    fd.set('active', 'anything');
    await expect(handlers[0](fd)).rejects.toThrow(
      'REDIRECT:' + groupListUrl(normal(values)) + '&error=1',
    );
    expect(api.setGroupActive).toHaveBeenCalledExactlyOnceWith(items[1].id, false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
