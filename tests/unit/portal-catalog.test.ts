import { describe, expect, it } from 'vitest';
import type { CatalogItem, TicketView } from '../../apps/web/src/lib/api';
import { safeReturnTo, withReturnTo } from '../../apps/web/src/lib/navigation';
import {
  CATALOG_SEARCH_MAX_LENGTH,
  PORTAL_OPEN_STATES,
  catalogHref,
  catalogQueryError,
  parseCatalogQuery,
  parsePortalQuery,
  portalHref,
  portalNavigationQuery,
  portalTicketFilter,
  portalTicketNextAction,
  selectCatalogItems,
} from '../../apps/web/src/lib/portal-overview';

const self = '03900000-0000-4000-8000-000000000001';
const cursorCreatedAt = '2026-10-04 01:02:03.123456+00';
const cursorId = '03900000-0000-4000-8000-000000000002';
const params = (href: string) => new URL(href, 'https://solvi.test').searchParams;
const item = (index: number, overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: `03900000-0000-4000-8001-${String(index).padStart(12, '0')}`,
  version: 1,
  title: `サービス${index}`,
  description: `サービス${index}の説明`,
  definition: {
    mode: 'local_simulation',
    targetLabel: index % 2 ? 'PC・機器' : 'アカウント',
    allowedDurations: [7],
    maxReasonLength: 200,
  },
  ...overrides,
});

describe('personal portal query boundaries', () => {
  it('defaults to the four unresolved states and fixes the requester to the supplied session', () => {
    const query = parsePortalQuery({
      requester: 'other-user',
      organizationId: 'other-org',
      state: 'closed',
      limit: '100',
    });
    expect(query).toEqual({ view: 'open', page: 1, cursor: null });
    const api = portalTicketFilter(self, query);
    expect(api.get('requester')).toBe(self);
    expect(api.getAll('state')).toEqual(['new', 'assigned', 'in_progress', 'pending']);
    expect([...api.keys()]).toEqual(['requester', 'state', 'state', 'state', 'state']);
    expect(PORTAL_OPEN_STATES).not.toContain('resolved');
    expect(portalHref(query)).toBe('/portal');
  });

  it('all means all of the current user tickets, never organization tickets', () => {
    const query = parsePortalQuery({ view: 'all', requester: 'other-user' });
    expect([...portalTicketFilter(self, query)]).toEqual([['requester', self]]);
    expect([...portalNavigationQuery(query)]).toEqual([['view', 'all']]);
    expect(portalHref(query)).toBe('/portal?view=all');
  });

  it('preserves a complete microsecond cursor in both API and browser navigation', () => {
    const query = parsePortalQuery({ view: 'all', page: '3', cursorCreatedAt, cursorId });
    expect(query).toEqual({
      view: 'all',
      page: 3,
      cursor: { createdAt: cursorCreatedAt, id: cursorId },
    });
    expect(portalTicketFilter(self, query).get('cursorCreatedAt')).toBe(cursorCreatedAt);
    expect(params(portalHref(query)).get('cursorCreatedAt')).toBe(cursorCreatedAt);
    expect(params(portalHref(query)).get('cursorId')).toBe(cursorId);
    expect(params(portalHref(query)).get('page')).toBe('3');
    expect(portalTicketFilter(self, query).has('page')).toBe(false);
    expect(portalNavigationQuery(query).has('requester')).toBe(false);
    expect(portalNavigationQuery(query).has('state')).toBe(false);
  });

  it('page-only and incomplete cursors recover to the first page', () => {
    for (const raw of [
      { page: '999' },
      { page: '2', cursorCreatedAt },
      { page: '2', cursorId },
      { page: '2', cursorCreatedAt, cursorId: '' },
      { page: '2', cursorCreatedAt: [cursorCreatedAt], cursorId },
    ]) {
      const query = parsePortalQuery(raw);
      expect(query.page).toBe(1);
      expect(query.cursor).toBeNull();
      expect(portalTicketFilter(self, query).has('cursorCreatedAt')).toBe(false);
      expect(portalHref(query)).toBe('/portal');
    }
  });

  it('unknown or repeated view uses unresolved without forwarding arbitrary URL controls', () => {
    for (const view of ['mine', 'https://evil.test', ['all', 'open']]) {
      const query = parsePortalQuery({ view, returnTo: '//evil.test', role: 'admin' });
      expect(query.view).toBe('open');
      expect(portalHref(query)).toBe('/portal');
      expect(portalTicketFilter(self, query).getAll('state')).toEqual([...PORTAL_OPEN_STATES]);
    }
  });

  it('view switching can explicitly discard paging and cannot carry identity keys', () => {
    const current = parsePortalQuery({ view: 'all', page: '3', cursorCreatedAt, cursorId });
    const switched = { ...current, view: 'open' as const, page: 1, cursor: null };
    expect(portalHref(switched)).toBe('/portal');
    expect(portalTicketFilter(self, switched).get('requester')).toBe(self);
    const hostile = {
      ...current,
      cursor: { createdAt: 'https://evil.test/#q', id: '//evil.test' },
    };
    const url = new URL(portalHref(hostile), 'https://solvi.test');
    expect(url.pathname).toBe('/portal');
    expect(url.origin).toBe('https://solvi.test');
    expect(url.hash).toBe('');
    expect(url.searchParams.get('cursorCreatedAt')).toBe('https://evil.test/#q');
  });
});

describe('personal next-action text', () => {
  const ticket = (
    state: string,
    pendingReason: TicketView['pendingReason'] = null,
    assigned = true,
  ) => ({ state, pendingReason, assigned });

  it('only a requester wait asks the user for a reply', () => {
    expect(portalTicketNextAction(ticket('pending', 'wait_requester'))).toBe('あなたの返答待ち');
    expect(portalTicketNextAction(ticket('pending', 'wait_external'))).toBe('外部の対応待ち');
    expect(portalTicketNextAction(ticket('pending'))).toBe('担当者が待ち先を確認します');
    expect(portalTicketNextAction(ticket('in_progress', 'wait_requester'))).not.toContain(
      '返答待ち',
    );
  });

  it('keeps unassigned, active, resolved, and terminal actions distinct without claiming a transition', () => {
    expect(portalTicketNextAction(ticket('new', null, false))).toBe('担当者の受付・割当待ち');
    expect(portalTicketNextAction(ticket('assigned', null, false))).toBe('担当者の割当待ち');
    expect(portalTicketNextAction(ticket('in_progress'))).toBe('担当者が対応します');
    expect(portalTicketNextAction(ticket('resolved'))).toBe('解決内容を確認する');
    expect(portalTicketNextAction(ticket('closed'))).toBe('対応は完了しています');
    expect(portalTicketNextAction(ticket('cancelled'))).toBe('問い合わせは取り消されました');
    expect(portalTicketNextAction(ticket('merged'))).toBe('統合先の問い合わせを確認する');
    expect(portalTicketNextAction(ticket('unknown'))).toBe('詳細で状況を確認してください');
  });
});

describe('published catalog selection', () => {
  it('shows 25 API-authorized items as 12/12/1 in the original order without modifying input', () => {
    const items = Object.freeze(Array.from({ length: 25 }, (_, index) => item(index + 1)));
    const before = structuredClone(items);
    const pages = [1, 2, 3].map((page) => selectCatalogItems(items, { q: '', target: '', page }));
    expect(pages.map((p) => p.items.length)).toEqual([12, 12, 1]);
    expect(pages.map((p) => [p.from, p.to])).toEqual([
      [1, 12],
      [13, 24],
      [25, 25],
    ]);
    expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(items.map((i) => i.id));
    expect(pages.every((p) => p.total === 25 && p.filtered === 25 && p.pageCount === 3)).toBe(true);
    expect(items).toEqual(before);
  });

  it('normalizes Unicode and case for title, description and existing target text', () => {
    const items = [
      item(1, {
        title: 'ＶＰＮ access',
        description: 'リモート接続',
        definition: { ...item(1).definition, targetLabel: 'ＡＣＭＥ' },
      }),
    ];
    for (const q of ['vpn', 'Ｖｐｎ', 'ACCESS', 'リモート', 'acme', 'ＡＣＭＥ']) {
      expect(selectCatalogItems(items, { q, target: '', page: 1 }).filtered).toBe(1);
    }
  });

  it('uses exact existing target labels as a facet, including when search is active', () => {
    const items = [item(1), item(2), item(3)];
    expect(selectCatalogItems(items, { q: '', target: '', page: 1 }).targets).toEqual([
      'PC・機器',
      'アカウント',
    ]);
    expect(
      selectCatalogItems(items, { q: 'サービス3', target: 'PC・機器', page: 1 }).items.map(
        (i) => i.id,
      ),
    ).toEqual([item(3).id]);
    for (const target of ['PC', 'pc・機器', ' PC・機器', '不明な対象']) {
      expect(selectCatalogItems(items, { q: '', target, page: 1 }).filtered).toBe(0);
    }
  });

  it('offers business categories independently of legacy target labels and keeps old items uncategorized', () => {
    const items = [
      item(1, {
        definition: { ...item(1).definition, category: 'PC・機器', targetLabel: '合成対象A' },
      }),
      item(2, {
        definition: { ...item(2).definition, category: '業務アプリ', targetLabel: '合成対象A' },
      }),
      item(3, { definition: { ...item(3).definition, targetLabel: 'PC・機器' } }),
    ];
    const result = selectCatalogItems(items, { q: '', target: '', page: 1 });
    expect(new Set(result.categories)).toEqual(new Set(['PC・機器', '業務アプリ', '未分類']));
    expect(result.categories).not.toContain('合成対象A');
    expect(new Set(result.targets)).toEqual(new Set(['合成対象A', 'PC・機器']));
    expect(
      selectCatalogItems(items, { q: '', category: '未分類', target: '', page: 1 }).items.map(
        (entry) => entry.id,
      ),
    ).toEqual([item(3).id]);
    expect(items[2]!.definition).not.toHaveProperty('category');
  });

  it('combines an exact business category with search and the independent old target filter', () => {
    const items = [
      item(1, {
        definition: { ...item(1).definition, category: 'PC・機器', targetLabel: '合成対象A' },
      }),
      item(2, {
        definition: { ...item(2).definition, category: 'PC・機器', targetLabel: '合成対象B' },
      }),
      item(3, {
        definition: { ...item(3).definition, category: '業務アプリ', targetLabel: '合成対象A' },
      }),
    ];
    const selected = selectCatalogItems(items, {
      q: 'サービス1',
      target: '合成対象A',
      category: 'PC・機器',
      page: 1,
    });
    expect(selected.items.map((entry) => entry.id)).toEqual([item(1).id]);
    expect(new Set(selected.categories)).toEqual(new Set(['PC・機器', '業務アプリ']));
    expect(
      selectCatalogItems(items, { q: '', target: '合成対象B', category: '業務アプリ', page: 1 })
        .filtered,
    ).toBe(0);
    for (const category of ['PC', 'pc・機器', ' PC・機器', '未定義カテゴリ'])
      expect(selectCatalogItems(items, { q: '', target: '', category, page: 1 }).filtered).toBe(0);
  });

  it('searches the business category without using it as an execution target or modifying the source', () => {
    const items = [
      item(1, {
        title: '合成の貸与申請',
        description: '申請内容を入力します。',
        definition: { ...item(1).definition, category: 'ＰＣ・機器', targetLabel: '合成対象A' },
      }),
    ];
    const before = structuredClone(items);
    expect(selectCatalogItems(items, { q: 'pc・機器', target: '', page: 1 }).filtered).toBe(1);
    expect(selectCatalogItems(items, { q: '', target: 'ＰＣ・機器', page: 1 }).filtered).toBe(0);
    expect(selectCatalogItems(items, { q: '', target: '合成対象A', page: 1 }).filtered).toBe(1);
    expect(items).toEqual(before);
  });

  it('distinguishes empty API result, no search match, and an out-of-range page', () => {
    expect(selectCatalogItems([], { q: '', target: '', page: 1 })).toMatchObject({
      total: 0,
      filtered: 0,
      items: [],
      from: 0,
      to: 0,
    });
    const items = Array.from({ length: 13 }, (_, index) => item(index + 1));
    expect(selectCatalogItems(items, { q: '存在しない', target: '', page: 1 })).toMatchObject({
      total: 13,
      filtered: 0,
      items: [],
    });
    expect(selectCatalogItems(items, { q: '', target: '', page: 999 })).toMatchObject({
      total: 13,
      filtered: 13,
      page: 999,
      pageCount: 2,
      items: [],
      from: 0,
      to: 0,
    });
  });
});

describe('catalog and portal URL validation', () => {
  it.each(['0', '-1', '2.5', '1e2', '2x', 'Infinity', '9007199254740992', ''])(
    'invalid page %s becomes first without modifying opaque cursor',
    (page) => {
      expect(parseCatalogQuery({ page }).page).toBe(1);
      const query = parsePortalQuery({ page, cursorCreatedAt, cursorId });
      expect(query.page).toBe(1);
      expect(query.cursor).toEqual({ createdAt: cursorCreatedAt, id: cursorId });
    },
  );

  it('parses supported scalar fields without accepting hidden control keys', () => {
    expect(
      parseCatalogQuery({
        q: ' ＶＰＮ ',
        target: 'PC・機器',
        page: '2',
        organizationId: 'other',
        redirect: '//evil.test',
      }),
    ).toEqual({ q: ' ＶＰＮ ', target: 'PC・機器', category: '', page: 2 });
    expect(parseCatalogQuery({ q: ['a', 'b'], target: ['one', 'two'], page: ['2', '3'] })).toEqual({
      q: '',
      target: '',
      category: '',
      page: 1,
    });
  });

  it('preserves query and exact unknown target for page changes and resets page for changed conditions', () => {
    const query = { q: 'VPN', target: 'まだない対象', page: 4 };
    expect(Object.fromEntries(params(catalogHref(query)))).toEqual({
      q: 'VPN',
      target: 'まだない対象',
      page: '4',
    });
    expect(params(catalogHref(query, { page: 2 })).get('page')).toBe('2');
    expect(params(catalogHref(query, { page: 1 })).has('page')).toBe(false);
    expect(params(catalogHref(query, { q: 'Wi-Fi', page: 4 })).has('page')).toBe(false);
    expect(params(catalogHref(query, { target: '', page: 4 })).has('page')).toBe(false);
    expect(catalogHref({ q: '', target: '', page: 1 })).toBe('/catalog');
  });

  it('parses, encodes and retains the category independently while resetting pages after a category change', () => {
    const query = parseCatalogQuery({
      q: 'PC',
      category: '機器・貸与',
      target: '合成対象',
      page: '4',
    });
    expect(query).toEqual({ q: 'PC', category: '機器・貸与', target: '合成対象', page: 4 });
    expect(Object.fromEntries(params(catalogHref(query)))).toEqual({
      q: 'PC',
      category: '機器・貸与',
      target: '合成対象',
      page: '4',
    });
    expect(params(catalogHref(query, { page: 2 })).get('category')).toBe('機器・貸与');
    const changed = params(catalogHref(query, { category: '業務アプリ', page: 4 }));
    expect(changed.has('page')).toBe(false);
    expect(changed.get('target')).toBe('合成対象');
    expect(changed.get('category')).toBe('業務アプリ');
    expect(params(catalogHref(query, { category: '' })).has('category')).toBe(false);
    expect(parseCatalogQuery({ category: ['PC・機器', '業務アプリ'] }).category).toBe('');
  });

  it('retains an invalid category for explicit correction without widening to all services', () => {
    const category = '器'.repeat(81);
    const query = parseCatalogQuery({ category });
    expect(query.category).toBe(category);
    expect(catalogQueryError(query)).toBeTruthy();
    expect(params(catalogHref(query)).get('category')).toBe(category);
    expect(selectCatalogItems([item(1)], query).filtered).toBe(0);
    expect(catalogQueryError({ ...query, category: '器'.repeat(80) })).toBeNull();
  });

  it('keeps an encoded combined filter for correction when it exceeds the safe return URL budget', () => {
    const query = parseCatalogQuery({
      q: '機'.repeat(CATALOG_SEARCH_MAX_LENGTH),
      target: '器'.repeat(100),
      category: '貸'.repeat(80),
      page: '2',
    });
    const href = catalogHref(query);
    expect(href.length).toBeGreaterThan(2000);
    expect(catalogQueryError(query)).toBeTruthy();
    expect(params(href).get('q')).toBe(query.q);
    expect(params(href).get('target')).toBe(query.target);
    expect(params(href).get('category')).toBe(query.category);
    expect(selectCatalogItems([item(1)], query).items).toEqual([]);
    expect(safeReturnTo(href)).not.toBe(href);
    expect(catalogQueryError({ ...query, category: '' })).toBeNull();
    expect(catalogQueryError({ ...query, target: '' })).toBeNull();
  });

  it('encodes hostile-looking input as values on the fixed local catalog route', () => {
    const target = '//evil.test?role=admin#section';
    const q = 'https://evil.test/?target=other&q=word';
    const query = parseCatalogQuery({ q, target, returnTo: 'https://evil.test' });
    const url = new URL(catalogHref(query), 'https://solvi.test');
    expect(url.origin).toBe('https://solvi.test');
    expect(url.pathname).toBe('/catalog');
    expect(url.hash).toBe('');
    expect([...url.searchParams]).toEqual([
      ['q', q],
      ['target', target],
    ]);
  });

  it('keeps the longest supported BMP search and target within the existing safe return URL limit', () => {
    const query = {
      q: '機'.repeat(CATALOG_SEARCH_MAX_LENGTH),
      target: '器'.repeat(100),
      page: Number.MAX_SAFE_INTEGER,
    };
    expect(CATALOG_SEARCH_MAX_LENGTH).toBe(100);
    expect(catalogQueryError(query)).toBeNull();
    const href = catalogHref(query);
    expect(href.length).toBeLessThan(2000);
    const detail = withReturnTo(`/catalog/${item(1).id}`, href);
    const returnTo = params(detail).get('returnTo');
    expect(returnTo).toBe(href);
    expect(safeReturnTo(returnTo)).toBe(href);
    expect(Object.fromEntries(params(returnTo!))).toEqual({
      q: query.q,
      target: query.target,
      page: String(query.page),
    });
  });

  it('marks an overlength search invalid without truncating or dropping the original URL input', () => {
    const raw = '  ' + '機'.repeat(101) + '  ';
    const query = parseCatalogQuery({ q: raw, target: 'PC・機器', page: '2' });
    expect(query.q).toBe(raw);
    expect(catalogQueryError(query)).toBe('検索語は100文字以内で入力してください');
    expect(params(catalogHref(query)).get('q')).toBe(raw);
    expect(params(catalogHref(query)).get('target')).toBe('PC・機器');
    expect(catalogQueryError({ ...query, q: '機'.repeat(100) })).toBeNull();
  });

  it('retains an overlength unknown target for explicit correction instead of widening to every target', () => {
    const target = '対象'.repeat(51);
    const query = parseCatalogQuery({ q: 'VPN', target });
    expect(query.target).toBe(target);
    expect(catalogQueryError(query)).toBe('対象の指定は100文字以内で選び直してください');
    expect(params(catalogHref(query)).get('target')).toBe(target);
    expect(selectCatalogItems([item(1)], query).filtered).toBe(0);
    expect(catalogQueryError({ ...query, target: '' })).toBeNull();
  });
});
