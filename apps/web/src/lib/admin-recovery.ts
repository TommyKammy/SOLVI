type Query = Record<string, string | string[] | undefined>;

const viewParams: Record<string, readonly string[]> = {
  '/ops/admin': [],
  '/ops/users': ['q', 'role', 'status', 'department', 'manager', 'jobTitle', 'page', 'selected'],
  '/ops/departments': ['department'],
  '/ops/groups': ['q', 'state', 'page'],
  '/ops/approvals': ['rule', 'unresolved'],
  '/ops/notifications': ['status'],
  '/ops/access-review': ['review'],
};
const groupDetail =
  /^\/ops\/groups\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const origin = 'https://solvi.local';

/** Carry only management views and their read-only selections across authentication. */
export function adminReturnTo(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /\s/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    const keys = Object.hasOwn(viewParams, url.pathname)
      ? viewParams[url.pathname]
      : groupDetail.test(url.pathname)
        ? ['q', 'filter', 'page']
        : null;
    if (!keys) return null;
    const query = new URLSearchParams();
    for (const key of keys) {
      const matches = url.searchParams.getAll(key);
      if (matches.length === 1 && matches[0].length <= 200) query.set(key, matches[0]);
    }
    const address = url.pathname + (query.size ? '?' + query.toString() : '');
    return address.length <= 4096 ? address : url.pathname;
  } catch {
    return null;
  }
}

export function adminViewPath(path: string, query: Query = {}): string | null {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.length <= 200) params.set(key, value);
  }
  return adminReturnTo(path + (params.size ? '?' + params.toString() : ''));
}

export function withAdminReturnTo(path: string, returnTo: unknown): string {
  const target = adminReturnTo(returnTo);
  if (!target) return path;
  return path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ returnTo: target });
}
