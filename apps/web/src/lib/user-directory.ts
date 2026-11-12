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
  /** 主部署 (WP-P4-IDM-013)。未設定は null。 */
  primaryDepartmentId: string | null;
  primaryDepartmentName: string | null;
  managerUserId: string | null;
  managerDisplayName: string | null;
  jobTitle: string | null;
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
  /** 主部署のID、`unset`(未設定)、`all` のいずれか。 */
  department: string;
  /** 上長の利用者ID、`unset`(未設定)、`all` のいずれか。 */
  manager: string;
  /** 役職の検索語。 */
  jobTitle: string;
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

export type DirectoryNotice =
  'created' | 'granted' | 'revoked' | 'stopped' | 'reactivated' | 'profile' | 'profile-unchanged';

export type DirectoryHrefOverrides = Partial<DirectoryQuery> & {
  selected?: string | null;
  create?: 'agent' | 'requester' | null;
  notice?: DirectoryNotice | null;
  count?: number;
  /** プロフィール更新のAPIが返した日本語の理由。URLにはこれだけを載せる。 */
  profileError?: string | null;
};

const PAGE_SIZE = 25;
const FILTER_ROLES = new Set<string>([...DIRECTORY_ROLES, 'platform_admin', 'platform_auditor']);
const NOTICES = new Set<string>([
  'created',
  'granted',
  'revoked',
  'stopped',
  'reactivated',
  'profile',
  'profile-unchanged',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function searchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

/** 部署・上長の絞り込みは、ID・未設定・すべてだけを受け付ける。 */
function readFilterId(value: unknown): string {
  if (typeof value !== 'string') return 'all';
  if (value === 'unset') return 'unset';
  return UUID.test(value) ? value.toLowerCase() : 'all';
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
  const jobTitle = typeof params.jobTitle === 'string' ? params.jobTitle.trim().slice(0, 200) : '';
  const candidate =
    typeof params.page === 'string' && /^[1-9]\d*$/.test(params.page) ? Number(params.page) : 1;
  const page = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 1;
  return {
    q,
    role,
    status,
    department: readFilterId(params.department),
    manager: readFilterId(params.manager),
    jobTitle,
    page,
  };
}

function sanitizedQuery(query: DirectoryQuery): DirectoryQuery {
  return parseDirectoryQuery({
    q: query.q,
    role: query.role,
    status: query.status,
    department: query.department,
    manager: query.manager,
    jobTitle: query.jobTitle,
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
  const jobTitle = searchText(normalized.jobTitle);
  const matching = members
    .filter(
      (member) =>
        (normalized.role === 'all' || member.roleCodes.includes(normalized.role)) &&
        (normalized.status === 'all' || member.status === normalized.status) &&
        (normalized.department === 'all' ||
          (normalized.department === 'unset'
            ? member.primaryDepartmentId === null
            : member.primaryDepartmentId === normalized.department)) &&
        (normalized.manager === 'all' ||
          (normalized.manager === 'unset'
            ? member.managerUserId === null
            : member.managerUserId === normalized.manager)) &&
        (!jobTitle || searchText(member.jobTitle ?? '').includes(jobTitle)) &&
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
  if (
    next.q !== current.q ||
    next.role !== current.role ||
    next.status !== current.status ||
    next.department !== current.department ||
    next.manager !== current.manager ||
    next.jobTitle !== current.jobTitle
  ) {
    next.page = 1;
  }

  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.role !== 'all') params.set('role', next.role);
  if (next.status !== 'all') params.set('status', next.status);
  if (next.department !== 'all') params.set('department', next.department);
  if (next.manager !== 'all') params.set('manager', next.manager);
  if (next.jobTitle) params.set('jobTitle', next.jobTitle);
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
  if (typeof overrides.profileError === 'string' && overrides.profileError.trim().length > 0) {
    params.set('profileError', overrides.profileError.trim().slice(0, 500));
  }
  const search = params.toString();
  return search ? `/ops/users?${search}` : '/ops/users';
}

export interface ManagerOption {
  userId: string;
  displayName: string;
  /** 選べない理由。null なら選べる。 */
  disabledReason: string | null;
}

/**
 * 上長候補 (WP-P4-IDM-013 §6 / ADR-0023 §3)。
 *
 * 候補は**同じ組織の在籍者**だけ。自分自身と、選ぶと循環になる人を外す。
 * 選べない候補も一覧に残し、理由を添える。**黙って消さない** — 消すと
 * 「なぜあの人が出ないのか」が分からない。
 */
export function managerOptions(
  members: readonly DirectoryMember[],
  target: DirectoryMember,
): ManagerOption[] {
  const byId = new Map(members.map((member) => [member.userId, member]));
  const reachesTarget = (startId: string): boolean => {
    const seen = new Set<string>();
    let current: string | null = startId;
    while (current && !seen.has(current)) {
      if (current === target.userId) return true;
      seen.add(current);
      current = byId.get(current)?.managerUserId ?? null;
    }
    return false;
  };
  return members
    .filter((member) => member.userId !== target.userId)
    .map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      disabledReason:
        member.status !== 'active'
          ? '停止中のため上長に選べません'
          : reachesTarget(member.userId)
            ? '選ぶと上長の関係が循環するため選べません'
            : null,
    }))
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName, 'ja') || a.userId.localeCompare(b.userId),
    );
}

/** 上長欄を無効にする理由。空配列なら編集できる。 */
export function managerFieldReasons(member: DirectoryMember, isSelf: boolean): string[] {
  const reasons: string[] = [];
  if (isSelf) {
    reasons.push(
      '自分自身の上長は自分では変更できません。別の組織管理者に設定を依頼してください。',
    );
  }
  if (member.roleCodes.includes('org_admin')) {
    reasons.push(
      '組織管理者の上長は設定できません。上長を設定するには、先に組織管理者の役割を取り消してください。',
    );
  }
  return reasons;
}
