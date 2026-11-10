import type { CatalogItem, TicketView } from './api';

type QueryInput = Record<string, string | string[] | undefined>;
export const PORTAL_OPEN_STATES = ['new', 'assigned', 'in_progress', 'pending'] as const;
export type PortalQuery = {
  view: 'open' | 'all';
  page: number;
  cursor: { createdAt: string; id: string } | null;
};
export type CatalogQuery = { q: string; target: string; page: number };
export const CATALOG_PAGE_SIZE = 12;
export const CATALOG_SEARCH_MAX_LENGTH = 100;

const scalar = (value: string | string[] | undefined): string =>
  typeof value === 'string' ? value : '';
const pageValue = (value: string | string[] | undefined): number => {
  const raw = scalar(value);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 1;
};

export function parsePortalQuery(raw: QueryInput): PortalQuery {
  const createdAt = scalar(raw.cursorCreatedAt);
  const id = scalar(raw.cursorId);
  const cursor = createdAt && id ? { createdAt, id } : null;
  return {
    view: raw.view === 'all' ? 'all' : 'open',
    page: cursor ? pageValue(raw.page) : 1,
    cursor,
  };
}

/** The caller supplies the current session's user ID, never an ID from URL parameters. */
export function portalTicketFilter(userId: string, query: PortalQuery): URLSearchParams {
  const filter = new URLSearchParams({ requester: userId });
  if (query.view !== 'all') PORTAL_OPEN_STATES.forEach((state) => filter.append('state', state));
  if (query.cursor) {
    filter.set('cursorCreatedAt', query.cursor.createdAt);
    filter.set('cursorId', query.cursor.id);
  }
  return filter;
}

/** Browser navigation carries presentation state, not API identity or arbitrary input keys. */
export function portalNavigationQuery(query: PortalQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.view === 'all') params.set('view', 'all');
  if (query.cursor) {
    params.set('cursorCreatedAt', query.cursor.createdAt);
    params.set('cursorId', query.cursor.id);
  }
  return params;
}

export function portalHref(query: PortalQuery): string {
  const params = portalNavigationQuery(query);
  if (query.cursor && Number.isSafeInteger(query.page) && query.page > 1)
    params.set('page', String(query.page));
  return `/portal${params.size ? `?${params}` : ''}`;
}

export function portalTicketNextAction(
  ticket: Pick<TicketView, 'state' | 'pendingReason' | 'assigned'>,
): string {
  switch (ticket.state) {
    case 'pending':
      return ticket.pendingReason === 'wait_requester'
        ? 'あなたの返答待ち'
        : ticket.pendingReason === 'wait_external'
          ? '外部の対応待ち'
          : '担当者が待ち先を確認します';
    case 'new':
      return '担当者の受付・割当待ち';
    case 'assigned':
    case 'in_progress':
      return ticket.assigned ? '担当者が対応します' : '担当者の割当待ち';
    case 'resolved':
      return '解決内容を確認する';
    case 'closed':
      return '対応は完了しています';
    case 'cancelled':
      return '問い合わせは取り消されました';
    case 'merged':
      return '統合先の問い合わせを確認する';
    default:
      return '詳細で状況を確認してください';
  }
}

export function parseCatalogQuery(raw: QueryInput): CatalogQuery {
  return { q: scalar(raw.q), target: scalar(raw.target), page: pageValue(raw.page) };
}

/** Keep supported catalog return URLs within the existing navigation length limit. */
export function catalogQueryError(query: CatalogQuery): string | null {
  if (query.q.length > CATALOG_SEARCH_MAX_LENGTH) return '検索語は100文字以内で入力してください';
  if (query.target.length > 100) return '対象の指定は100文字以内で選び直してください';
  return null;
}

const normalized = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('ja-JP');

/** Search only the already authorized published catalog returned by the API. */
export function selectCatalogItems<
  T extends Pick<CatalogItem, 'title' | 'description' | 'definition'>,
>(items: readonly T[], query: CatalogQuery) {
  const needle = normalized(query.q.trim());
  const filteredItems = items.filter(
    (item) =>
      (!query.target || item.definition.targetLabel === query.target) &&
      (!needle ||
        normalized([item.title, item.description, item.definition.targetLabel].join('\n')).includes(
          needle,
        )),
  );
  const page = Number.isSafeInteger(query.page) && query.page > 0 ? query.page : 1;
  const offset = (page - 1) * CATALOG_PAGE_SIZE;
  const selected = filteredItems.slice(offset, offset + CATALOG_PAGE_SIZE);
  return {
    items: selected,
    total: items.length,
    filtered: filteredItems.length,
    page,
    pageCount: Math.max(1, Math.ceil(filteredItems.length / CATALOG_PAGE_SIZE)),
    from: selected.length ? offset + 1 : 0,
    to: selected.length ? offset + selected.length : 0,
    targets: [...new Set(items.map((item) => item.definition.targetLabel))].filter(
      (target) => target.trim().length > 0,
    ),
  };
}

export function catalogHref(query: CatalogQuery, overrides: Partial<CatalogQuery> = {}): string {
  const next = { ...query, ...overrides };
  if (
    (overrides.q !== undefined && overrides.q !== query.q) ||
    (overrides.target !== undefined && overrides.target !== query.target)
  )
    next.page = 1;
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.target) params.set('target', next.target);
  if (Number.isSafeInteger(next.page) && next.page > 1) params.set('page', String(next.page));
  return `/catalog${params.size ? `?${params}` : ''}`;
}
