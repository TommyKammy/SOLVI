import { safeReturnTo } from './navigation';

export const groupMemberPageSize = 25;
type SearchValues = Record<string, string | string[] | undefined>;
export interface GroupMemberQuery {
  q: string;
  filter: 'all' | 'available';
  page: number;
  returnTo: string | null;
}
export interface GroupMemberPerson {
  userId: string;
  displayName: string;
  email: string;
  status: 'active' | 'deactivated';
}

export function groupMemberQuery(values: SearchValues): GroupMemberQuery {
  const source =
    typeof values.q === 'string'
      ? (new URLSearchParams({ q: values.q }).get('q') ?? '').trim()
      : '';
  let q = source.slice(0, 200);
  const last = q.charCodeAt(q.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) q = q.slice(0, -1);
  return {
    q,
    filter: values.filter === 'available' ? 'available' : 'all',
    page:
      typeof values.page === 'string' &&
      /^[1-9][0-9]{0,5}$/.test(values.page) &&
      Number(values.page) <= 100000
        ? Number(values.page)
        : 1,
    returnTo: safeReturnTo(values.returnTo),
  };
}

export function groupMemberUrl(id: string, query: GroupMemberQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.filter !== 'all') params.set('filter', query.filter);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.returnTo) params.set('returnTo', query.returnTo);
  return `/ops/groups/${id}` + (params.size ? '?' + params.toString() : '');
}

export function groupMemberOperationUrl(
  id: string,
  query: GroupMemberQuery,
  key: 'notice' | 'error',
  value: string,
): string {
  const destination = groupMemberUrl(id, query);
  return (
    destination + (destination.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(value)
  );
}

export function groupMemberView<T extends GroupMemberPerson>(
  people: readonly T[],
  memberIds: ReadonlySet<string>,
  query: GroupMemberQuery,
) {
  const matches = people.filter((person) =>
    `${person.displayName} ${person.email}`
      .toLocaleLowerCase()
      .includes(query.q.toLocaleLowerCase()),
  );
  const eligible = (person: T) => person.status === 'active' && !memberIds.has(person.userId);
  const available = matches.filter(eligible);
  const filtered = query.filter === 'available' ? available : matches;
  const offset = (query.page - 1) * groupMemberPageSize;
  const items = filtered.slice(offset, offset + groupMemberPageSize);
  const pages = Math.max(1, Math.ceil(filtered.length / groupMemberPageSize));
  return {
    items,
    total: people.length,
    matched: matches.length,
    filtered: filtered.length,
    available: available.length,
    member: matches.filter((person) => memberIds.has(person.userId)).length,
    stopped: matches.filter((person) => person.status === 'deactivated').length,
    pageEligible: items.filter(eligible).length,
    pages,
    start: items.length ? offset + 1 : 0,
    end: items.length ? offset + items.length : 0,
    previous: items.length > 0 && query.page > 1,
    next: items.length > 0 && query.page < pages,
    empty: !people.length
      ? 'users'
      : !matches.length
        ? 'search'
        : !filtered.length
          ? 'available'
          : !items.length
            ? 'page'
            : null,
  };
}
