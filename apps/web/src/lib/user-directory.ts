/** The existing /users response. Directory presentation does not add authority. */
export interface DirectoryMember {
  userId: string;
  displayName: string;
  email: string;
  status: 'active' | 'deactivated';
  deactivatedAt: string | null;
  roleCodes: string[];
  temporaryRoles: Array<{
    roleCode: string;
    validUntil: string;
    daysRemaining: number;
    expiringSoon: boolean;
  }>;
  openTicketCount: number;
}

/** Existing grantable organization roles; platform roles are display filters only. */
export const DIRECTORY_ROLES = [
  'org_admin',
  'agent',
  'approver',
  'auditor',
  'requester',
  'catalog_editor',
] as const;

export const DIRECTORY_ROLE_LABELS: Record<string, string> = {
  requester: 'リクエスター',
  agent: 'オペレーター',
  catalog_editor: 'カタログ編集者',
  approver: '承認者',
  auditor: '監査',
  org_admin: '組織管理者',
  platform_admin: 'プラットフォーム管理者',
  platform_auditor: 'プラットフォーム監査者',
};

export interface DirectoryQuery {
  q: string;
  role: string;
  status: 'all' | 'active' | 'deactivated';
  page: number;
}

export interface DirectorySelection {
  items: DirectoryMember[];
  total: number;
  filtered: number;
  page: number;
  pageCount: number;
  from: number;
  to: number;
}

export type DirectoryNotice = 'created' | 'granted' | 'revoked' | 'stopped' | 'reactivated';

export type DirectoryHrefOverrides = Partial<DirectoryQuery> & {
  selected?: string | null;
  create?: 'agent' | 'requester' | null;
  notice?: DirectoryNotice | null;
  count?: number;
};

const PAGE_SIZE = 25;
const FILTER_ROLES = new Set<string>([...DIRECTORY_ROLES, 'platform_admin', 'platform_auditor']);
const NOTICES = new Set<string>(['created', 'granted', 'revoked', 'stopped', 'reactivated']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function searchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

/** Repeated or unsupported URL values fall back to the neutral directory view. */
export function parseDirectoryQuery(
  params: Record<string, string | string[] | undefined>,
): DirectoryQuery {
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 200) : '';
  const role =
    typeof params.role === 'string' && FILTER_ROLES.has(params.role) ? params.role : 'all';
  const status =
    params.status === 'active' || params.status === 'deactivated' ? params.status : 'all';
  const candidate =
    typeof params.page === 'string' && /^[1-9]\d*$/.test(params.page) ? Number(params.page) : 1;
  const page = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 1;
  return { q, role, status, page };
}

function sanitizedQuery(query: DirectoryQuery): DirectoryQuery {
  return parseDirectoryQuery({
    q: query.q,
    role: query.role,
    status: query.status,
    page: String(query.page),
  });
}

/** Page only the members already authorized and returned by the existing API. */
export function selectDirectoryMembers(
  members: readonly DirectoryMember[],
  query: DirectoryQuery,
): DirectorySelection {
  const normalized = sanitizedQuery(query);
  const search = searchText(normalized.q);
  const matching = members
    .filter(
      (member) =>
        (normalized.role === 'all' || member.roleCodes.includes(normalized.role)) &&
        (normalized.status === 'all' || member.status === normalized.status) &&
        (!search ||
          searchText(member.displayName).includes(search) ||
          searchText(member.email).includes(search)),
    )
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName, 'ja') || a.userId.localeCompare(b.userId),
    );
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = Math.min(normalized.page, pageCount);
  const offset = (page - 1) * PAGE_SIZE;
  const items = matching.slice(offset, offset + PAGE_SIZE);
  return {
    items,
    total: members.length,
    filtered: matching.length,
    page,
    pageCount,
    from: items.length === 0 ? 0 : offset + 1,
    to: offset + items.length,
  };
}

/** Build a fixed internal destination; never copy an arbitrary return URL. */
export function directoryHref(
  query: DirectoryQuery,
  overrides: DirectoryHrefOverrides = {},
): string {
  const current = sanitizedQuery(query);
  const next = sanitizedQuery({ ...current, ...overrides });
  if (next.q !== current.q || next.role !== current.role || next.status !== current.status) {
    next.page = 1;
  }

  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.role !== 'all') params.set('role', next.role);
  if (next.status !== 'all') params.set('status', next.status);
  if (next.page !== 1) params.set('page', String(next.page));
  if (typeof overrides.selected === 'string' && UUID.test(overrides.selected)) {
    params.set('selected', overrides.selected.toLowerCase());
  }
  if (overrides.create === 'agent' || overrides.create === 'requester') {
    params.set('create', overrides.create);
  }
  if (typeof overrides.notice === 'string' && NOTICES.has(overrides.notice)) {
    params.set('notice', overrides.notice);
  }
  if (
    typeof overrides.count === 'number' &&
    Number.isSafeInteger(overrides.count) &&
    overrides.count >= 0
  ) {
    params.set('count', String(overrides.count));
  }
  const search = params.toString();
  return search ? `/ops/users?${search}` : '/ops/users';
}
