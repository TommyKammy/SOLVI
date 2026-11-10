// NFR-UX-002, NFR-UX-003, NFR-UX-004: native member selection and condition recovery.
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
  groupMemberPageSize,
  groupMemberQuery,
  groupMemberUrl,
  groupMemberOperationUrl,
  groupMemberView,
} from '../../apps/web/src/lib/group-member-selection';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    listGroups: vi.fn(),
    listGroupMembers: vi.fn(),
    listMembers: vi.fn(),
    addGroupMember: vi.fn(),
    removeGroupMember: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (href: string) => {
    throw new Error('REDIRECT:' + href);
  },
  usePathname: () => '/ops/groups/synthetic-group',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props),
}));
type Values = Record<string, string | string[] | undefined>;
type Page = (props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Values>;
}) => Promise<ReactNode>;
const { default: Members } = await vi.importActual<{ default: Page }>(
  '../../apps/web/src/app/ops/groups/[id]/page',
);
const id = 'synthetic-group';
const group = {
  id,
  code: 'synthetic',
  name: '合成グループ',
  description: null,
  active: true,
  memberCount: 20,
};
const people = Array.from({ length: 53 }, (_, i) => ({
  userId: 'synthetic-user-' + i,
  displayName: i === 0 ? '合成SpecialName' : i === 26 || i === 27 ? '合成同名' : '合成在籍者' + i,
  email: 'person' + i + '@example.invalid',
  status: i >= 18 && i < 25 ? ('deactivated' as const) : ('active' as const),
  deactivatedAt: null,
  roleCodes: [],
  temporaryRoles: [],
}));
const roster = people
  .slice(0, 20)
  .map((p) => ({ userId: p.userId, displayName: p.displayName, addedAt: '2026-10-10T00:00:00Z' }));
const memberIds = new Set(roster.map((p) => p.userId));
const query = (v: Values = {}) => groupMemberQuery(v);
const tree = (v: Values = {}) =>
  Members({ params: Promise.resolve({ id }), searchParams: Promise.resolve(v) });
const render = async (v: Values = {}) => renderToStaticMarkup(await tree(v));
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
  vi.mocked(requireSession).mockResolvedValue({
    userId: 's',
    organizationId: 's',
    roles: [{ roleCode: 'org_admin', organizationId: 's' }],
  });
  vi.mocked(api.listGroups).mockResolvedValue({ ok: true, data: { items: [group] } });
  vi.mocked(api.listGroupMembers).mockResolvedValue({ ok: true, data: { items: roster } });
  vi.mocked(api.listMembers).mockResolvedValue({ ok: true, data: { items: people } });
});
afterEach(() => vi.unstubAllGlobals());

describe('single conditions and native candidate projection', () => {
  it('drops arrays, unknowns, flash, unsafe parent and default values', () => {
    expect(query({ q: ['x'], filter: ['available'], page: ['2'], returnTo: ['/ops'] })).toEqual({
      q: '',
      filter: 'all',
      page: 1,
      returnTo: null,
    });
    expect(
      groupMemberUrl(
        id,
        query({
          unknown: 'secret',
          error: 'private',
          notice: 'added',
          returnTo: 'https://outside.invalid',
          filter: 'active',
        }),
      ),
    ).toBe('/ops/groups/' + id);
  });
  it.each(['', '0', '-1', '01', '1.1', '1e3', ' 2', '2 ', '+2', '100001', '999999', '1000000'])(
    'defaults invalid page %j',
    (page) => expect(query({ page }).page).toBe(1),
  );
  it.each(['1', '2', '99999', '100000'])('accepts valid page %s without clamping', (page) =>
    expect(query({ page }).page).toBe(Number(page)),
  );
  it('normalizes USV, trim, literal and pair-safe 200 UTF16 units', () => {
    expect(query({ q: '  %_.*  ' }).q).toBe('%_.*');
    expect(query({ q: 'x'.repeat(201) }).q.length).toBe(200);
    expect(query({ q: 'x'.repeat(199) + '😀' }).q).toBe('x'.repeat(199));
    expect(query({ q: 'x'.repeat(198) + '😀' }).q).toBe('x'.repeat(198) + '😀');
    expect(query({ q: '\ud800z\udfff' }).q).toBe('\ufffdz\ufffd');
  });
  it('builds canonical context in order and keeps error encoding', () => {
    const q = query({
      q: ' 合成 ',
      filter: 'available',
      page: '2',
      returnTo: '/ops/groups?q=group&state=active&page=2',
      error: 'old',
    });
    const url = groupMemberUrl(id, q);
    expect([...new URL(url, 'http://localhost').searchParams.keys()]).toEqual([
      'q',
      'filter',
      'page',
      'returnTo',
    ]);
    expect(groupMemberOperationUrl(id, q, 'error', '入力 %')).toBe(
      url + '&error=' + encodeURIComponent('入力 %'),
    );
    expect(groupMemberOperationUrl(id, query(), 'notice', 'added')).toBe(
      '/ops/groups/' + id + '?notice=added',
    );
  });
  it.each([1, 2, 3])('slices API order for page %i without mutation', (page) => {
    const before = structuredClone(people);
    const view = groupMemberView(people, memberIds, query({ page: String(page) }));
    expect(groupMemberPageSize).toBe(25);
    expect(view.items).toEqual(people.slice((page - 1) * 25, page * 25));
    expect(view.items.length).toBe(page === 3 ? 3 : 25);
    expect(view.pages).toBe(3);
    expect(people).toEqual(before);
  });
  it('uses joined name-space-email locale substring including the boundary', () => {
    expect(groupMemberView(people, memberIds, query({ q: 'SPECIALNAME PERSON0@' })).items).toEqual([
      people[0],
    ]);
    expect(
      groupMemberView(people, memberIds, query({ q: 'PERSON1@EXAMPLE.INVALID' })).items,
    ).toEqual([people[1]]);
    expect(groupMemberView(people, memberIds, query({ q: '%_.*' })).items).toEqual([]);
  });
  it('keeps same names distinct by email/userId', () => {
    expect(
      groupMemberView(people, memberIds, query({ q: '合成同名' })).items.map((p) => [
        p.userId,
        p.email,
      ]),
    ).toEqual(people.slice(26, 28).map((p) => [p.userId, p.email]));
  });
  it('uses exact active nonmember set while retaining overlapping search counts', () => {
    const view = groupMemberView(people, memberIds, query({ filter: 'available' }));
    expect(view.items).toEqual(people.slice(25, 50));
    expect(view).toMatchObject({
      total: 53,
      matched: 53,
      filtered: 28,
      available: 28,
      member: 20,
      stopped: 7,
      pageEligible: 25,
    });
    expect(groupMemberView(people, memberIds, query()).pageEligible).toBe(0);
    expect(groupMemberView(people, memberIds, query({ page: '2' })).pageEligible).toBe(25);
  });
  it('keeps duplicate membership semantics of row counts', () => {
    const duplicatePeople = [people[18], people[18], people[25]];
    expect(groupMemberView(duplicatePeople, memberIds, query())).toMatchObject({
      member: 2,
      stopped: 2,
      available: 1,
    });
  });
  it('distinguishes users, search, available and valid oversize page emptiness', () => {
    expect(groupMemberView([], memberIds, query()).empty).toBe('users');
    expect(groupMemberView(people, memberIds, query({ q: 'absent' })).empty).toBe('search');
    expect(
      groupMemberView(people.slice(0, 25), memberIds, query({ filter: 'available' })).empty,
    ).toBe('available');
    expect(groupMemberView(people, memberIds, query({ page: '100000' }))).toMatchObject({
      empty: 'page',
      start: 0,
      end: 0,
      previous: false,
      next: false,
    });
  });
});

describe('actual detail candidate rendering and protected reads', () => {
  it('renders 25 options plus placeholder; closes page without eligible people and shows escape', async () => {
    const html = await render({ q: '合成', returnTo: '/ops' });
    const select = html.match(/<select id="member-id"[^]*?<\/select>/)![0];
    expect((select.match(/<option/g) ?? []).length).toBe(26);
    expect(select).toContain('disabled=""');
    expect(html).toContain('追加可能のみを表示する');
    expect(html).toContain('filter=available&amp;returnTo=%2Fops');
    expect(html).toContain('追加可能 28人 · 所属済み 20人 · 停止中 7人');
    expect(html).toContain('（所属済み）');
    expect(html).toContain('（停止中）');
    expect(html).toContain('person18@example.invalid（所属済み）');
  });
  it('enables select and submit only on eligible current page', async () => {
    const html = await render({ page: '2' });
    expect(html.match(/<select id="member-id"[^>]*>/)![0]).not.toContain('disabled');
    expect(html).toContain('<button type="submit">選んだ在籍者を追加する');
    expect(html).toContain('26〜50人を表示');
  });
  it('keeps roster name/email/status/time and each hidden removal field', async () => {
    const html = await render();
    expect(html).toContain('<strong>合成SpecialName</strong>');
    expect(html).toContain('person0@example.invalid');
    expect(html).toContain('利用停止中 · 追加候補には表示しません');
    expect(html).toContain('現在この組織に在籍');
    expect(html).toContain('dateTime="2026-10-10T00:00:00Z"');
    expect(html).toContain('name="userId" value="synthetic-user-0"');
    expect((html.match(/このグループから外す/g) ?? []).length).toBe(20);
  });
  it('GET form has parent and filter but no page hidden; clear retains only safe parent', async () => {
    const html = await render({ q: '合成', filter: 'available', page: '2', returnTo: '/ops' });
    const form = html.match(
      /<form\b(?=[^>]*action="\/ops\/groups\/synthetic-group")(?=[^>]*method="get")[^]*?<\/form>/,
    )![0];
    expect(form).toContain('name="returnTo" value="/ops"');
    expect(form).toContain('name="filter"');
    expect(form).not.toContain('name="page"');
    expect(html).toContain('href="/ops/groups/synthetic-group?returnTo=%2Fops">検索を解除する');
    expect(html).not.toContain('page=1');
  });
  it('preserves unavailable group addition denial while keeping removal actions', async () => {
    vi.mocked(api.listGroups).mockResolvedValue({
      ok: true,
      data: { items: [{ ...group, active: false }] },
    });
    const html = await render({ page: '2' });
    expect(html).toContain('既存メンバーの確認・解除はできます');
    expect(html.match(/<select id="member-id"[^>]*>/)![0]).toContain('disabled');
    expect(html).toContain('<button type="submit" class="secondary">このグループから外す');
  });
  it.each(['members', 'people'])(
    'keeps %s failure alert and hides fake counts/empty/nav',
    async (which) => {
      const result = { ok: false as const, problem: { status: 503, title: 'PRIVATE' } };
      if (which === 'members') vi.mocked(api.listGroupMembers).mockResolvedValue(result);
      else vi.mocked(api.listMembers).mockResolvedValue(result);
      const html = await render({ page: '2' });
      expect(html).toContain(
        which === 'members'
          ? 'メンバーを取得できませんでした。再読み込みしてください。'
          : '在籍者候補を取得できないため追加できません。再読み込みしてください。',
      );
      expect(html).not.toMatch(
        /追加可能 \d|検索結果 \d|このページに在籍者|在籍者候補のページ|PRIVATE/,
      );
      expect(html.match(/<select id="member-id"[^>]*>/)![0]).toContain('disabled');
    },
  );
  it('keeps users403 as existing alert and addition closed', async () => {
    vi.mocked(api.listMembers).mockResolvedValue({
      ok: false,
      problem: { status: 403, title: 'PRIVATE' },
    });
    expect(await render()).toContain('在籍者候補を取得できないため追加できません');
  });
  it.each(['agent', 'requester', 'auditor'])(
    'denies real %s role before all three reads',
    async (roleCode) => {
      vi.mocked(requireSession).mockResolvedValue({
        userId: 's',
        organizationId: 's',
        roles: [{ roleCode, organizationId: 's' }],
      });
      expect(await render()).toContain('この画面を表示する権限がありません');
      expect(api.listGroups).not.toHaveBeenCalled();
      expect(api.listGroupMembers).not.toHaveBeenCalled();
      expect(api.listMembers).not.toHaveBeenCalled();
    },
  );
  it.each([403, 404])('keeps main GET%d notFound without member/user reads', async (status) => {
    vi.mocked(api.listGroups).mockResolvedValue({
      ok: false,
      problem: { status, title: 'PRIVATE' },
    });
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect(api.listGroupMembers).not.toHaveBeenCalled();
    expect(api.listMembers).not.toHaveBeenCalled();
  });
  it('keeps missing group notFound and session redirect uncaught', async () => {
    vi.mocked(api.listGroups).mockResolvedValue({ ok: true, data: { items: [] } });
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect(api.listMembers).not.toHaveBeenCalled();
    vi.mocked(requireSession).mockRejectedValue(new Error('REDIRECT:/login'));
    await expect(render()).rejects.toThrow('REDIRECT:/login');
  });
  it('keeps platform read arguments and session/main/member/user order', async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: 's',
      organizationId: 's',
      roles: [{ roleCode: 'platform_admin', organizationId: null }],
    });
    await render();
    expect(api.listGroups).toHaveBeenCalledExactlyOnceWith(true);
    expect(api.listGroupMembers).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.listMembers).toHaveBeenCalledExactlyOnceWith();
    expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.listGroups).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(api.listGroups).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.listGroupMembers).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(api.listGroupMembers).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.listMembers).mock.invocationCallOrder[0],
    );
  });
});

describe('existing inline add/remove complete call and redirect contract', () => {
  const values = {
    q: '合成',
    filter: 'available',
    page: '2',
    returnTo: '/ops/groups?q=group&state=active&page=2',
    unknown: 'PRIVATE',
    notice: 'old',
    error: 'old',
  };
  it.each(['add', 'remove'])(
    'keeps %s 204/void, only id/userId and detail revalidate',
    async (operation) => {
      const call = operation === 'add' ? api.addGroupMember : api.removeGroupMember;
      vi.mocked(call).mockResolvedValue({ ok: true, data: undefined });
      const handlers = actions(await tree(values));
      const fd = new FormData();
      fd.set('userId', 'same-synthetic');
      fd.set('injected', 'PRIVATE');
      await expect((operation === 'add' ? handlers.at(-1)! : handlers[0])(fd)).rejects.toThrow(
        'REDIRECT:' +
          groupMemberOperationUrl(
            id,
            query(values),
            'notice',
            operation === 'add' ? 'added' : 'removed',
          ),
      );
      expect(call).toHaveBeenCalledExactlyOnceWith(id, 'same-synthetic');
      expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/ops/groups/' + id);
    },
  );
  it.each([
    [
      'add',
      {
        status: 400,
        title: 'fallback',
        detail: 'detail',
        errors: [{ field: 'userId', message: 'field' }],
      },
      'field',
    ],
    ['add', { status: 409, title: 'fallback', detail: 'detail' }, 'detail'],
    ['add', { status: 503, title: 'fallback' }, 'fallback'],
    [
      'remove',
      {
        status: 400,
        title: 'fallback',
        detail: 'detail',
        errors: [{ field: 'userId', message: 'field' }],
      },
      'detail',
    ],
    ['remove', { status: 503, title: 'fallback' }, 'fallback'],
  ] as const)(
    'preserves %s failure priority/conditions without revalidate',
    async (operation, problem, detail) => {
      const call = operation === 'add' ? api.addGroupMember : api.removeGroupMember;
      vi.mocked(call).mockResolvedValue({
        ok: false,
        problem: { ...problem, ...('errors' in problem ? { errors: [...problem.errors] } : {}) },
      });
      const handlers = actions(await tree(values));
      await expect(
        (operation === 'add' ? handlers.at(-1)! : handlers[0])(new FormData()),
      ).rejects.toThrow('REDIRECT:' + groupMemberOperationUrl(id, query(values), 'error', detail));
      expect(call).toHaveBeenCalledExactlyOnceWith(id, '');
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
});
