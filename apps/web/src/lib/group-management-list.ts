import { safeReturnTo } from './navigation';

export const groupListPageSize = 25;
const states = ['all', 'active', 'inactive'] as const;
type GroupListState = (typeof states)[number];
type SearchValues = Record<string, string | string[] | undefined>;

export interface GroupListItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  memberCount: number;
}
export interface GroupListQuery {
  q: string;
  state: GroupListState;
  page: number;
  returnTo: string | null;
}

export function groupListQuery(values: SearchValues): GroupListQuery {
  const source =
    typeof values.q === 'string'
      ? (new URLSearchParams({ q: values.q }).get('q') ?? '').trim()
      : '';
  let q = source.slice(0, 200);
  const last = q.charCodeAt(q.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) q = q.slice(0, -1);
  return {
    q,
    state: states.includes(values.state as GroupListState)
      ? (values.state as GroupListState)
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

export function groupListUrl(query: GroupListQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.state !== 'all') params.set('state', query.state);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.returnTo) params.set('returnTo', query.returnTo);
  return '/ops/groups' + (params.size ? '?' + params.toString() : '');
}

export function groupListContext(query: GroupListQuery): string {
  const full = groupListUrl(query);
  return safeReturnTo(full) ?? groupListUrl({ ...query, returnTo: null });
}

export function groupListOperationError(destination: string, detail: string): string {
  return (
    destination + (destination.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(detail)
  );
}

/** Validate only this directory's read DTO; do not change the shared API call. */
export function groupListItems(value: unknown): GroupListItem[] | null {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items))
    return null;
  return value.items.every(
    (item: unknown) =>
      item !== null &&
      typeof item === 'object' &&
      'id' in item &&
      typeof item.id === 'string' &&
      'code' in item &&
      typeof item.code === 'string' &&
      'name' in item &&
      typeof item.name === 'string' &&
      'description' in item &&
      (item.description === null || typeof item.description === 'string') &&
      'active' in item &&
      typeof item.active === 'boolean' &&
      'memberCount' in item &&
      typeof item.memberCount === 'number' &&
      Number.isInteger(item.memberCount) &&
      item.memberCount >= 0,
  )
    ? value.items
    : null;
}

export function groupListView(items: readonly GroupListItem[], query: GroupListQuery) {
  const needle = query.q.toLowerCase();
  const matched = items.filter(
    (item) =>
      (query.state === 'all' || (query.state === 'active' ? item.active : !item.active)) &&
      (!needle ||
        [item.name, item.code, item.description ?? ''].some((value) =>
          value.toLowerCase().includes(needle),
        )),
  );
  const offset = (query.page - 1) * groupListPageSize;
  const visible = matched.slice(offset, offset + groupListPageSize);
  const pages = Math.max(1, Math.ceil(matched.length / groupListPageSize));
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
