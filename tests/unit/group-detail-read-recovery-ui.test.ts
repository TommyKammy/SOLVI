// NFR-UX-002, NFR-UX-003, NFR-UX-004: group detail read failure recovery.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession } from '../../apps/web/src/lib/api';

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
  redirect: () => {
    throw new Error('REDIRECT');
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
  memberCount: 1,
};
const people = [
  {
    userId: 'synthetic-user',
    displayName: '合成利用者',
    email: 'person@example.invalid',
    status: 'active' as const,
    deactivatedAt: null,
    roleCodes: [],
    temporaryRoles: [],
  },
  {
    userId: 'synthetic-available',
    displayName: '合成候補',
    email: 'available@example.invalid',
    status: 'active' as const,
    deactivatedAt: null,
    roleCodes: [],
    temporaryRoles: [],
  },
];
const roster = [
  { userId: people[0].userId, displayName: people[0].displayName, addedAt: '2026-10-10T00:00:00Z' },
];
const failure = (status: number) => ({
  ok: false as const,
  problem: { status, title: 'PRIVATE_PROBLEM', detail: 'PRIVATE_DETAIL' },
});
const render = async (values: Values = {}) =>
  renderToStaticMarkup(
    await Members({ params: Promise.resolve({ id }), searchParams: Promise.resolve(values) }),
  );
const anchors = (html: string) =>
  [
    ...html.matchAll(/<a href="([^"]+)"[^>]*>(メンバーを再取得する|在籍者候補を再取得する)<\/a>/g),
  ].map((m) => ({ href: m[1].replaceAll('&amp;', '&'), label: m[2] }));
const noCandidateStatus = (html: string) => {
  expect(html).not.toContain('（検索結果内）');
  expect(html).not.toContain('表示条件に一致');
  expect(html).not.toContain('aria-label="在籍者候補のページ"');
  expect(html).not.toContain('この組織の在籍者が居ません');
  expect(html).not.toContain('検索条件に一致する在籍者が居ません');
  expect(html).not.toContain('このページに在籍者が居ません');
  expect(html).toMatch(/<select[^>]*id="member-id"[^>]*disabled=""/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>選んだ在籍者を追加する<\/button>/);
  expect(html).not.toContain('PRIVATE_PROBLEM');
  expect(html).not.toContain('PRIVATE_DETAIL');
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

describe('existing failed reads get fixed native recovery', () => {
  it.each([403, 503])('members %i has no false count or empty roster', async (status) => {
    vi.mocked(api.listGroupMembers).mockResolvedValue(failure(status));
    const html = await render();
    expect(html).toContain('<h2>現在のメンバー</h2>');
    expect(html).not.toContain('現在のメンバー ·');
    expect(html).not.toContain('メンバーが居ません');
    expect(html).toContain(
      '<p role="alert">メンバーを取得できませんでした。再読み込みしてください。</p>',
    );
    expect(html).toContain('検索条件を保ったまま、もう一度読み込めます。');
    expect(anchors(html)).toEqual([{ href: '/ops/groups/' + id, label: 'メンバーを再取得する' }]);
    noCandidateStatus(html);
  });
  it.each([403, 503])(
    'users %i preserves successful roster with unknown affiliation',
    async (status) => {
      vi.mocked(api.listMembers).mockResolvedValue(failure(status));
      const html = await render();
      expect(html).toContain('<h2>現在のメンバー · 1人</h2>');
      expect(html).toContain('合成利用者');
      expect(html).toContain('2026-10-10T00:00:00Z');
      expect(html).toContain('このグループから外す');
      expect(html).toContain('在籍状態を取得できません');
      expect(html).not.toContain('person@example.invalid');
      expect(html).toContain(
        '<p role="alert">在籍者候補を取得できないため追加できません。再読み込みしてください。</p>',
      );
      expect(anchors(html)).toEqual([
        { href: '/ops/groups/' + id, label: '在籍者候補を再取得する' },
      ]);
      noCandidateStatus(html);
    },
  );
  it('both failed reads retain both alerts and identical canonical GET targets', async () => {
    vi.mocked(api.listGroupMembers).mockResolvedValue(failure(503));
    vi.mocked(api.listMembers).mockResolvedValue(failure(403));
    const html = await render({
      q: ' 合成 ',
      filter: 'available',
      page: '2',
      returnTo: '/ops/groups?q=group&state=active&page=2',
      notice: 'added',
      error: 'flash',
      unknown: 'private',
    });
    const expected =
      '/ops/groups/' +
      id +
      '?q=' +
      encodeURIComponent('合成') +
      '&filter=available&page=2&returnTo=' +
      encodeURIComponent('/ops/groups?q=group&state=active&page=2');
    expect(anchors(html)).toEqual([
      { href: expected, label: 'メンバーを再取得する' },
      { href: expected, label: '在籍者候補を再取得する' },
    ]);
    expect(html).toContain('<h2>現在のメンバー</h2>');
    expect(html.match(/検索条件を保ったまま、もう一度読み込めます。/g)).toHaveLength(2);
    noCandidateStatus(html);
  });
  it('drops duplicate and unsafe values from retry independently of existing back navigation', async () => {
    vi.mocked(api.listGroupMembers).mockResolvedValue(failure(503));
    const html = await render({
      q: ['a', 'b'],
      filter: ['available', 'all'],
      page: ['2', '3'],
      returnTo: ['/ops', '/ops/groups'],
      notice: 'removed',
      unknown: 'private',
    });
    expect(anchors(html)[0].href).toBe('/ops/groups/' + id);
    const invalid = await render({
      q: ' %_.* ',
      filter: 'active',
      page: '01',
      returnTo: 'https://outside.invalid',
    });
    expect(anchors(invalid)[0].href).toBe('/ops/groups/' + id + '?q=%25_.*');
  });
  it('retains a valid empty current page and truncates the existing canonical query without splitting pairs', async () => {
    vi.mocked(api.listGroupMembers).mockResolvedValue(failure(503));
    const html = await render({ q: '長'.repeat(199) + '😀', page: '100000' });
    const href = new URL(anchors(html)[0].href, 'http://localhost');
    expect(href.searchParams.get('q')).toBe('長'.repeat(199));
    expect(href.searchParams.get('page')).toBe('100000');
    noCandidateStatus(html);
  });
});

describe('success and protected entry paths remain intact', () => {
  it('populated success has count, email, existing candidate state and no recovery links', async () => {
    const html = await render();
    expect(html).toContain('<h2>現在のメンバー · 1人</h2>');
    expect(html).toContain('person@example.invalid');
    expect(html).toContain('現在この組織に在籍');
    expect(html).toContain('表示条件に一致');
    expect(html).toContain('aria-label="在籍者候補のページ"');
    expect(anchors(html)).toEqual([]);
    expect(api.listGroups).toHaveBeenCalledExactlyOnceWith(true);
    expect(api.listGroupMembers).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.listMembers).toHaveBeenCalledExactlyOnceWith();
    expect(vi.mocked(api.listGroups).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.listGroupMembers).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(api.listGroupMembers).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.listMembers).mock.invocationCallOrder[0],
    );
  });
  it('real zero members retains count and the existing notice', async () => {
    vi.mocked(api.listGroupMembers).mockResolvedValue({ ok: true, data: { items: [] } });
    const html = await render();
    expect(html).toContain('<h2>現在のメンバー · 0人</h2>');
    expect(html).toContain('メンバーが居ません');
    expect(anchors(html)).toEqual([]);
  });
  it('users failure with a real zero roster still displays the existing zero notice', async () => {
    vi.mocked(api.listGroupMembers).mockResolvedValue({ ok: true, data: { items: [] } });
    vi.mocked(api.listMembers).mockResolvedValue(failure(503));
    const html = await render();
    expect(html).toContain('<h2>現在のメンバー · 0人</h2>');
    expect(html).toContain('メンバーが居ません');
    noCandidateStatus(html);
  });
  it('inactive group retains its notice and existing removal form', async () => {
    vi.mocked(api.listGroups).mockResolvedValue({
      ok: true,
      data: { items: [{ ...group, active: false }] },
    });
    const html = await render();
    expect(html).toContain('このグループは無効です。');
    expect(html).toContain('このグループから外す');
    expect(html).toMatch(/<select[^>]*id="member-id"[^>]*disabled=""/);
    expect(anchors(html)).toEqual([]);
  });
  it('agent denial occurs before management reads', async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: 's',
      organizationId: 's',
      roles: [{ roleCode: 'agent', organizationId: 's' }],
    });
    const html = await render();
    expect(html).toContain('この画面を表示する権限がありません。');
    expect(api.listGroups).not.toHaveBeenCalled();
    expect(api.listGroupMembers).not.toHaveBeenCalled();
    expect(api.listMembers).not.toHaveBeenCalled();
    expect(anchors(html)).toEqual([]);
  });
  it('platform admin retains the current detail read path', async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: 's',
      organizationId: 's',
      roles: [{ roleCode: 'platform_admin', organizationId: null }],
    });
    expect(await render()).toContain('合成利用者');
    expect(api.listGroupMembers).toHaveBeenCalledExactlyOnceWith(id);
  });
  it.each([403, 404])(
    'primary group %i remains notFound before dependent reads',
    async (status) => {
      vi.mocked(api.listGroups).mockResolvedValue(failure(status));
      await expect(render()).rejects.toThrow('NOT_FOUND');
      expect(api.listGroupMembers).not.toHaveBeenCalled();
      expect(api.listMembers).not.toHaveBeenCalled();
    },
  );
  it('unknown group remains notFound before dependent reads', async () => {
    vi.mocked(api.listGroups).mockResolvedValue({ ok: true, data: { items: [] } });
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect(api.listGroupMembers).not.toHaveBeenCalled();
    expect(api.listMembers).not.toHaveBeenCalled();
  });
});
