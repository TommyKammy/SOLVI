import type { CatalogAdminSummary } from './api';
import { safeReturnTo } from './navigation';

export const catalogListPageSize = 20;
const states = ['all', 'published', 'unpublished', 'changed'] as const;
type CatalogListState = (typeof states)[number];
type SearchValues = Record<string, string | string[] | undefined>;

export interface CatalogListQuery {
  q: string;
  state: CatalogListState;
  page: number;
  returnTo: string | null;
}

export function catalogListQuery(values: SearchValues): CatalogListQuery {
  // Match the URL's USV representation before filtering, including lone surrogates.
  const source =
    typeof values.q === 'string'
      ? (new URLSearchParams({ q: values.q }).get('q') ?? '').trim()
      : '';
  let q = source.slice(0, 100);
  const last = q.charCodeAt(q.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) q = q.slice(0, -1);
  return {
    q,
    state: states.includes(values.state as CatalogListState)
      ? (values.state as CatalogListState)
      : 'all',
    page:
      typeof values.page === 'string' &&
      /^[1-9][0-9]{0,5}$/.test(values.page) &&
      Number(values.page) <= 100000
        ? Number(values.page)
        : 1,
    returnTo: safeReturnTo(values.returnTo),
  };
}

export function catalogListUrl(query: CatalogListQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.state !== 'all') params.set('state', query.state);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.returnTo) params.set('returnTo', query.returnTo);
  return '/catalog/manage' + (params.size ? '?' + params.toString() : '');
}

/** Keep the displayed conditions even when nesting the parent exceeds navigation's limit. */
export function catalogListContext(query: CatalogListQuery): string {
  const full = catalogListUrl(query);
  return safeReturnTo(full) ?? catalogListUrl({ ...query, returnTo: null });
}

export function catalogListView(items: readonly CatalogAdminSummary[], query: CatalogListQuery) {
  const needle = query.q.toLowerCase();
  const matched = items.filter((item) => {
    const stateMatches =
      query.state === 'all' ||
      (query.state === 'published' && item.active) ||
      (query.state === 'unpublished' && !item.active) ||
      (query.state === 'changed' && item.active && item.draftRevision !== item.publishedRevision);
    return (
      stateMatches &&
      (!needle ||
        [item.title, item.description, item.code].some((value) =>
          value.toLowerCase().includes(needle),
        ))
    );
  });
  const offset = (query.page - 1) * catalogListPageSize;
  const visible = matched.slice(offset, offset + catalogListPageSize);
  const pages = Math.max(1, Math.ceil(matched.length / catalogListPageSize));
  return {
    items: visible,
    total: items.length,
    matched: matched.length,
    pages,
    start: visible.length ? offset + 1 : 0,
    end: visible.length ? offset + visible.length : 0,
    previous: visible.length > 0 && query.page > 1,
    next: visible.length > 0 && query.page < pages,
  };
}
