import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type KnowledgeList } from '../../apps/web/src/lib/api';
import {
  KNOWLEDGE_CURSOR_MAX_LENGTH,
  KNOWLEDGE_PAGE_SIZE,
  KNOWLEDGE_SEARCH_MAX_LENGTH,
  knowledgeExcerpt,
  knowledgeHighlights,
  knowledgeHref,
  parseKnowledgeQuery,
} from '../../apps/web/src/lib/knowledge-search';
import { safeReturnTo, withReturnTo } from '../../apps/web/src/lib/navigation';

vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

const url = (href: string) => new URL(href, 'https://solvi.test');
const text = (excerpt: ReturnType<typeof knowledgeExcerpt>) =>
  excerpt.parts.map((part) => part.text).join('');

describe('knowledge search URL and display contracts', () => {
  it('uses the API first value, trimming and UTF-16 cap without changing matching semantics', () => {
    expect(
      parseKnowledgeQuery({ q: ['  ＶＰＮ　認証  ', 'ignored'], manage: ['1', '0'] }, true),
    ).toEqual({ q: 'ＶＰＮ　認証', manage: true, error: null });
    expect(parseKnowledgeQuery({ q: '字'.repeat(201) }, false).q).toBe('字'.repeat(200));
    expect(
      parseKnowledgeQuery({ q: '\t \n', page: '400', limit: '1000', role: 'admin' }, false),
    ).toEqual({ q: '', manage: false, error: null });
    expect(KNOWLEDGE_PAGE_SIZE).toBe(20);
    expect(KNOWLEDGE_SEARCH_MAX_LENGTH).toBe(200);
  });

  it('caps emoji by UTF-16 and safely round trips a truncated surrogate using URL replacement', () => {
    expect(parseKnowledgeQuery({ q: '😀'.repeat(101) }, true).q).toBe('😀'.repeat(100));
    const query = parseKnowledgeQuery({ q: '字'.repeat(199) + '😀続き' }, true);
    expect(query.q).toBe('字'.repeat(199) + '\uFFFD');
    expect(url(knowledgeHref(query)).searchParams.get('q')).toBe(query.q);
    expect(parseKnowledgeQuery({ q: query.q }, true).q).toBe(query.q);
  });

  it('keeps opaque cursors and restricts manage to staff while dropping unknown browser controls', () => {
    const query = parseKnowledgeQuery(
      { q: ' VPN ', manage: '1', cursor: 'opaque_-123', limit: '100', returnTo: '//evil.test' },
      true,
    );
    expect(query.cursor).toBe('opaque_-123');
    expect([...url(knowledgeHref(query)).searchParams]).toEqual([
      ['q', 'VPN'],
      ['manage', '1'],
      ['cursor', 'opaque_-123'],
    ]);
    expect(parseKnowledgeQuery({ manage: '1' }, false).manage).toBe(false);
    expect(knowledgeHref({ q: '', manage: false })).toBe('/knowledge');
  });

  it.each(['', 'bad=padding', 'bad/cursor', 'x'.repeat(169), ['first', 'second']])(
    'keeps an invalid cursor visible as an error: %j',
    (cursor) => {
      expect(parseKnowledgeQuery({ q: 'VPN', cursor }, true).error).toBe('cursor');
    },
  );

  it('preserves the maximum Japanese query, mode and issued cursor through a safe detail return', () => {
    const query = parseKnowledgeQuery(
      { q: '日'.repeat(200), manage: '1', cursor: 'A'.repeat(KNOWLEDGE_CURSOR_MAX_LENGTH) },
      true,
    );
    const href = knowledgeHref(query);
    expect(href.length).toBe(1998);
    expect(safeReturnTo(href)).toBe(href);
    const detail = withReturnTo('/knowledge/05400000-0000-4000-8000-000000000001?manage=1', href);
    expect(safeReturnTo(url(detail).searchParams.get('returnTo'))).toBe(href);
    const reset = knowledgeHref({ q: query.q, manage: false });
    expect(url(reset).searchParams.has('cursor')).toBe(false);
    expect(url(reset).searchParams.get('q')).toBe(query.q);
  });

  it('decorates literal text and regex metacharacters without treating them as markup or patterns', () => {
    const literal = '%_\\[a].*?<script>';
    expect(knowledgeHighlights(`前${literal}後${literal}`, literal)).toEqual([
      { text: '前', match: false },
      { text: literal, match: true },
      { text: '後', match: false },
      { text: literal, match: true },
    ]);
    expect(
      knowledgeHighlights('VPN vpn ＶＰＮ', 'vpn')
        .filter((part) => part.match)
        .map((part) => part.text),
    ).toEqual(['VPN', 'vpn']);
    expect(knowledgeHighlights('任意の本文', '')).toEqual([{ text: '任意の本文', match: false }]);
  });

  it('finds a body match after the old preview boundary and keeps bounded Unicode context', () => {
    const body = '😀'.repeat(300) + '後方の接続手順' + '終'.repeat(300);
    const excerpt = knowledgeExcerpt(body, '接続手順');
    expect(excerpt.leading).toBe(true);
    expect(excerpt.trailing).toBe(true);
    expect(excerpt.matched).toBe(true);
    expect(excerpt.parts.some((part) => part.match && part.text === '接続手順')).toBe(true);
    expect(Array.from(text(excerpt))).toHaveLength(220);
    expect(text(excerpt)).not.toContain('\uFFFD');
  });

  it('shows a bounded summary for a title/tag-only hit without inventing a body match', () => {
    const excerpt = knowledgeExcerpt('本文'.repeat(200), 'タイトルだけ');
    expect(excerpt.matched).toBe(false);
    expect(excerpt.leading).toBe(false);
    expect(excerpt.trailing).toBe(true);
    expect(Array.from(text(excerpt))).toHaveLength(220);
    expect(knowledgeExcerpt('', '検索')).toEqual({
      parts: [{ text: '', match: false }],
      leading: false,
      trailing: false,
      matched: false,
    });
  });

  it('limits an unfiltered summary to 140 Unicode characters with a trailing ellipsis only', () => {
    const excerpt = knowledgeExcerpt('😀'.repeat(200), '  ');
    expect(text(excerpt)).toBe('😀'.repeat(140));
    expect(excerpt).toMatchObject({ leading: false, trailing: true, matched: false });
  });

  it('does not backfill an end match with unnecessary opening text', () => {
    const excerpt = knowledgeExcerpt(
      '不要な冒頭' + '前'.repeat(300) + '末尾の解決手順',
      '解決手順',
    );
    expect(text(excerpt)).toBe('前'.repeat(57) + '末尾の解決手順');
    expect(excerpt.parts[0]?.text).toHaveLength(60);
    expect(excerpt).toMatchObject({ leading: true, trailing: false, matched: true });
    expect(excerpt.parts.filter((part) => part.match)).toEqual([{ text: '解決手順', match: true }]);
  });

  it('keeps a complete short article without leading or trailing ellipses', () => {
    const body = '短い案内。' + '手順'.repeat(40) + '解決';
    const excerpt = knowledgeExcerpt(body, '解決');
    expect(text(excerpt)).toBe(body);
    expect(excerpt).toMatchObject({ leading: false, trailing: false, matched: true });
    expect(text(knowledgeExcerpt(body, ''))).toBe(body);
  });

  it.each([
    { label: 'Japanese BMP', keyword: '字'.repeat(200) },
    { label: 'emoji', keyword: '😀'.repeat(100) },
  ])('keeps the complete 200 UTF-16 query in a bounded $label excerpt', ({ keyword }) => {
    const excerpt = knowledgeExcerpt('前'.repeat(500) + keyword + '後'.repeat(10), keyword);
    expect(keyword).toHaveLength(200);
    expect(Array.from(text(excerpt)).length).toBeLessThanOrEqual(220);
    expect(excerpt.parts.filter((part) => part.match)).toEqual([{ text: keyword, match: true }]);
    expect(excerpt).toMatchObject({ leading: true, trailing: false, matched: true });
    expect(text(excerpt)).not.toContain('\uFFFD');
  });
});

describe('knowledge API client compatibility', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const result: KnowledgeList = { items: [], total: 205, previousCursor: null, nextCursor: 'next' };
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps old callers on API defaults and retains all additive metadata', async () => {
    expect(await api.knowledgeList('VPN %_\\')).toEqual({ ok: true, data: result });
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('expected request');
    expect([...new URL(String(call[0])).searchParams]).toEqual([['q', 'VPN %_\\']]);
    expect(call[1]?.cache).toBe('no-store');
  });

  it('forwards explicit cursor/limit and encodes malformed UTF-16 without throwing', async () => {
    await api.knowledgeList('字\uD83D', true, { limit: 20, cursor: 'next_-12' });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('expected request');
    expect([...new URL(String(call[0])).searchParams]).toEqual([
      ['q', '字\uFFFD'],
      ['manage', '1'],
      ['limit', '20'],
      ['cursor', 'next_-12'],
    ]);
  });
});
