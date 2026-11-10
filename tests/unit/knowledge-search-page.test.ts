import { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type KnowledgeArticle,
  type KnowledgeList,
  type SessionView,
} from '../../apps/web/src/lib/api';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { knowledgeList: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props),
}));

// The web workspace type-checks TSX; this root test config deliberately has no JSX setting.
const { default: KnowledgePage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/knowledge/page');

const session: SessionView = {
  userId: '05400000-0000-4000-8000-000000000001',
  organizationId: '05400000-0000-4000-8000-000000000002',
  roles: [{ roleCode: 'agent', organizationId: '05400000-0000-4000-8000-000000000002' }],
};
const article = (id: string, overrides: Partial<KnowledgeArticle> = {}): KnowledgeArticle => ({
  id,
  state: 'published',
  version: 2,
  publishedVersion: 1,
  contentVersion: 1,
  title: `記事 ${id}`,
  body: '接続の確認手順です。',
  tags: 'VPN',
  audience: 'organization',
  versionCreatedAt: '2026-10-07T01:02:03Z',
  ...overrides,
});
const data = (overrides: Partial<KnowledgeList> = {}): KnowledgeList => ({
  items: [article('first')],
  total: 205,
  previousCursor: null,
  nextCursor: 'nextCursor',
  ...overrides,
});
const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await KnowledgePage({ searchParams: Promise.resolve(searchParams) }));
const links = (html: string) =>
  [...html.matchAll(/href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((match) => ({
    href: (match[1] ?? '').replaceAll('&amp;', '&'),
    text: match[2],
  }));
const link = (html: string, label: string) => {
  const found = links(html).find((item) => item.text === label);
  if (!found) throw new Error(`missing expected link: ${label}`);
  return new URL(found.href, 'https://solvi.test');
};

beforeEach(() => {
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.knowledgeList).mockReset().mockResolvedValue({ ok: true, data: data() });
});

describe('NFR-UX-002/003/004 knowledge list rendering and URL recovery', () => {
  it('requests 20 results, keeps backend order and reports total separately from visible count', async () => {
    vi.mocked(api.knowledgeList).mockResolvedValue({
      ok: true,
      data: data({ items: [article('z'), article('a')] }),
    });
    const html = await render({ q: ' VPN ', cursor: 'currentCursor' });
    expect(api.knowledgeList).toHaveBeenCalledExactlyOnceWith('VPN', false, {
      limit: 20,
      cursor: 'currentCursor',
    });
    expect(html).toContain('<h1>ナレッジを探す</h1>');
    expect(html).toContain('<strong>205件</strong>の検索結果');
    expect(html).toContain('この画面に2件を表示');
    expect(html.indexOf('記事 z')).toBeLessThan(html.indexOf('記事 a'));
    expect(html).not.toContain('2ページ');
    expect(html).toContain('aria-label="ナレッジを検索"');
    expect(html).toContain('aria-label="ナレッジ検索結果のページ（上）"');
  });

  it('preserves q and manage through detail, next/previous, and first while resetting mode cursors', async () => {
    vi.mocked(api.knowledgeList).mockResolvedValue({
      ok: true,
      data: data({ previousCursor: 'previousCursor' }),
    });
    const html = await render({ q: 'VPN', manage: '1', cursor: 'currentCursor' });
    const next = link(html, '次の結果');
    expect([...next.searchParams]).toEqual([
      ['q', 'VPN'],
      ['manage', '1'],
      ['cursor', 'nextCursor'],
    ]);
    expect(link(html, '前の結果').searchParams.get('cursor')).toBe('previousCursor');
    expect([...link(html, '最初の結果へ').searchParams]).toEqual([
      ['q', 'VPN'],
      ['manage', '1'],
    ]);
    expect([...link(html, '公開された記事を見る').searchParams]).toEqual([['q', 'VPN']]);
    const detail = link(html, '記事 first');
    expect(detail.searchParams.get('manage')).toBe('1');
    expect(detail.searchParams.get('returnTo')).toBe(
      '/knowledge?q=VPN&manage=1&cursor=currentCursor',
    );
    expect(html).toContain('name="manage"');
    expect(html).not.toContain('name="cursor"');
    expect(html).toContain('公開済み');
  });

  it('keeps the full maximum Japanese query and cursor in detail returnTo without shared navigation changes', async () => {
    const q = '日'.repeat(200);
    const html = await render({ q, manage: '1', cursor: 'A'.repeat(168) });
    const returnTo = link(html, '記事 first').searchParams.get('returnTo');
    expect(returnTo).toHaveLength(1998);
    expect(new URL(returnTo ?? '', 'https://solvi.test').searchParams.get('q')).toBe(q);
  });

  // FR-KNW-003 is partial: display correctness does not prove the separate 50-question Top-5 gate.
  it('FR-KNW-003 partial: renders safe text and exposes a body match beyond the leading summary', async () => {
    vi.mocked(api.knowledgeList).mockResolvedValue({
      ok: true,
      data: data({
        items: [
          article('html', {
            title: '<script>alert(1)</script>',
            body: '前'.repeat(300) + '<img src=x onerror=alert(1)>後方検索' + '後'.repeat(300),
            tags: '<svg/onload=alert(1)>',
          }),
        ],
      }),
    });
    const html = await render({ q: '後方検索' });
    expect(html).toContain('<mark>後方検索</mark>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;svg/onload=alert(1)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
  });

  it('uses the current organization staff visibility and never enables management for a requester', async () => {
    vi.mocked(requireSession).mockResolvedValue({
      ...session,
      roles: [
        { roleCode: 'agent', organizationId: 'another-org' },
        { roleCode: 'requester', organizationId: session.organizationId },
      ],
    });
    const html = await render({ q: 'VPN', manage: '1' });
    expect(api.knowledgeList).toHaveBeenCalledWith('VPN', false, { limit: 20 });
    expect(html).toContain('<h1>ナレッジを探す</h1>');
    expect(html).not.toContain('記事を作成・管理する');
    expect(html).not.toContain('新しい記事を書く');
    expect(html).not.toContain('公開済み');
  });

  it('leaves session recovery to the shared session path before requesting knowledge', async () => {
    const recovery = new Error('shared session recovery');
    vi.mocked(requireSession).mockRejectedValue(recovery);
    await expect(render()).rejects.toBe(recovery);
    expect(api.knowledgeList).not.toHaveBeenCalled();
  });
});

describe('knowledge list recovery', () => {
  it.each([
    { query: {}, heading: '公開中の記事はありません', action: '問い合わせる' },
    {
      query: { q: '不一致' },
      heading: '条件に合う記事はありません',
      action: '条件を解除してすべて表示',
    },
    { query: { manage: '1' }, heading: '記事はまだ登録されていません', action: '新しい記事を書く' },
  ])('distinguishes empty states: $heading', async ({ query, heading, action }) => {
    vi.mocked(api.knowledgeList).mockResolvedValue({
      ok: true,
      data: data({ items: [], total: 0, nextCursor: null }),
    });
    const html = await render(query);
    expect(html).toContain(`<h2>${heading}</h2>`);
    expect(link(html, action)).toBeInstanceOf(URL);
    expect(html).not.toContain('role="alert"');
  });

  it('recovers an empty continuation without losing its exact total or q/mode', async () => {
    vi.mocked(api.knowledgeList).mockResolvedValue({
      ok: true,
      data: data({ items: [], previousCursor: 'previousCursor', nextCursor: null }),
    });
    const html = await render({ q: 'VPN', manage: '1', cursor: 'pastEnd' });
    expect(html).toContain('この取得位置に記事はありません');
    expect(html).toContain('<strong>205件</strong>');
    expect(html).toContain('この画面に0件を表示');
    expect([...link(html, '最初の結果へ').searchParams]).toEqual([
      ['q', 'VPN'],
      ['manage', '1'],
    ]);
  });

  it.each([400, 401, 403, 503])(
    'shows a recoverable API %i without reporting zero results',
    async (status) => {
      vi.mocked(api.knowledgeList).mockResolvedValue({
        ok: false,
        problem: { status, title: 'internal test title', detail: 'internal diagnostic' },
      });
      const html = await render({ q: 'VPN', manage: '1', cursor: 'currentCursor' });
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('class="knowledge-result"');
      expect(html).not.toContain('0件');
      expect(html).not.toContain('internal diagnostic');
      expect(html).toContain('value="VPN"');
      expect([...link(html, '再読み込み').searchParams]).toEqual([
        ['q', 'VPN'],
        ['manage', '1'],
        ['cursor', 'currentCursor'],
      ]);
      expect(html).toContain(
        status === 400
          ? '検索条件を確認してください'
          : status === 401
            ? 'ログイン状態を確認してください'
            : status === 403
              ? '記事を表示する権限がありません'
              : '記事を読み込めませんでした',
      );
    },
  );

  it('does not discard a duplicated cursor and silently show unrelated first-page results', async () => {
    const html = await render({ q: 'VPN', cursor: ['one', 'two'] });
    expect(api.knowledgeList).not.toHaveBeenCalled();
    expect(html).toContain('検索条件を確認してください');
    expect([...link(html, '最初の結果へ').searchParams]).toEqual([['q', 'VPN']]);
    expect(html).not.toContain('class="knowledge-result"');
  });
});
