import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

/**
 * API 呼び出し (WP-P2-PORTAL-002)。
 *
 * ブラウザから直接 API を叩かせず、**Next.js のサーバ側を経由する**。
 *
 * 理由は2つ。
 *   1. セッションCookieが `HttpOnly` なので、ブラウザのJSからは読めない。
 *      サーバ側で読んで転送する必要がある
 *   2. API のオリジンをブラウザへ露出させない。露出させると CORS の設定が要り、
 *      設定を緩めた分だけ攻撃面が広がる
 */

const API_BASE = process.env.API_BASE_URL ?? 'http://api:3001';

export interface ProblemDetails {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  errors?: Array<{ field: string; message: string }>;
  correlationId?: string;
}

export type ApiResult<T> =
  { ok: true; data: T; setCookie?: string } | { ok: false; problem: ProblemDetails };

async function call<T>(
  path: string,
  init: RequestInit & { forwardCookie?: boolean } = {},
): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');

  if (init.forwardCookie !== false) {
    const jar = await cookies();
    const all = jar.getAll();
    if (all.length > 0) {
      headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      // 画面は常に最新の状態を出す。チケットの状態はキャッシュしてよい情報ではない。
      cache: 'no-store',
    });
  } catch {
    // ネットワーク到達不能。**原因の詳細を利用者へ出さない。**
    // 内部のホスト名やポートが画面に出ると、それ自体が偵察の材料になる。
    return {
      ok: false,
      problem: { title: '接続できませんでした', status: 503 },
    };
  }

  const setCookie = response.headers.get('set-cookie') ?? undefined;

  if (response.status === 204) {
    return { ok: true, data: undefined as T, ...(setCookie ? { setCookie } : {}) };
  }

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const problem = parsed as ProblemDetails;
    return {
      ok: false,
      problem: { ...problem, status: problem.status ?? response.status },
    };
  }

  return { ok: true, data: parsed as T, ...(setCookie ? { setCookie } : {}) };
}

export interface TicketView {
  id: string;
  number: string;
  kind: 'incident' | 'request';
  state: string;
  subject: string;
  body: string;
  impact: string;
  urgency: string;
  priority: string;
  createdAt: string;
  resolvedAt: string | null;
  assigned: boolean;
}

export interface SessionView {
  userId: string;
  organizationId: string;
  roles: Array<{ roleCode: string; organizationId: string | null }>;
}

export interface CommentView {
  id: string;
  authorId: string;
  visibility: 'public' | 'internal';
  body: string;
  createdAt: string;
}

export interface AvailableAction {
  to: string;
  reason: string;
  label: string;
}

export interface AttachmentView {
  id: string;
  uploadedBy: string;
  fileName: string;
  sizeBytes: number;
  visibility: 'public' | 'internal';
  scanStatus: 'pending' | 'clean' | 'infected';
  createdAt: string;
  /** 開けるかどうか。画面が scanStatus を解釈して判断しない。 */
  downloadable: boolean;
}

export interface RelationView {
  relationId: string;
  ticketId: string;
  number: string;
  subject: string;
  state: string;
  role: 'related' | 'parent' | 'child';
}

export interface RelationListView {
  items: RelationView[];
  /**
   * 未解決の子。**解決を止めるためではなく、判断材料として渡される。**
   * 子が別チームの担当で長期化することがあり、拒否すると運用が詰まる。
   */
  unresolvedChildren: Array<{ ticketId: string; number: string; subject: string; state: string }>;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberCount: number;
}

export interface WorkspaceView {
  ticket: TicketView & {
    requesterId: string;
    assigneeId: string | null;
    assigneeGroupId: string | null;
  };
  comments: CommentView[];
  attachments: AttachmentView[];
  availableActions: AvailableAction[];
  /** 保存されている優先度が影響度×緊急度の規則どおりか (WP-P2-PRIO-013)。 */
  priorityIsDerived: boolean;
  /** 振り先の候補。**無効化したグループは含まれない** (FR-TKT-003)。 */
  availableGroups: GroupSummary[];
}

export interface MemberOrganization {
  id: string;
  code: string;
  name: string;
}

export const api = {
  login: (body: { email: string; password: string; organizationId?: string }) =>
    call<{
      userId: string;
      /** 所属が1つなら決まっている。兼務者は null で、画面が選ばせる。 */
      organizationId: string | null;
      organizations: MemberOrganization[];
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      forwardCookie: false,
    }),

  logout: () => call<void>('/auth/logout', { method: 'POST' }),

  me: () => call<SessionView>('/auth/me'),

  /**
   * 本人が所属する組織。**組織が未選択でも呼べる。**
   * 選択画面を出すための情報が、選択していないと取れないという
   * 行き止まりを作らないため。
   */
  myOrganizations: () =>
    call<{ selected: string | null; organizations: MemberOrganization[] }>('/auth/organizations'),

  selectOrganization: (organizationId: string) =>
    call<{ organizationId: string }>('/auth/organization', {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    }),

  createTicket: (body: {
    kind: string;
    subject: string;
    body: string;
    impact: string;
    urgency: string;
  }) => call<TicketView>('/tickets', { method: 'POST', body: JSON.stringify(body) }),

  listTickets: (limit = 10, filter?: URLSearchParams) => {
    const query = new URLSearchParams(filter);
    query.set('limit', String(limit));
    return call<{
      items: TicketView[];
      total: number;
      scope: string;
      appliedFilter: Record<string, unknown>;
    }>(`/tickets?${query.toString()}`);
  },

  getTicket: (id: string) => call<TicketView>(`/tickets/${encodeURIComponent(id)}`),

  workspace: (id: string) => call<WorkspaceView>(`/tickets/${encodeURIComponent(id)}/workspace`),

  listComments: (id: string) =>
    call<{ items: CommentView[] }>(`/tickets/${encodeURIComponent(id)}/comments`),

  addComment: (id: string, body: { visibility: string; body: string }) =>
    call<CommentView>(`/tickets/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  transition: (id: string, body: { to: string; reason: string }) =>
    call<{ state: string }>(`/tickets/${encodeURIComponent(id)}/transitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listAttachments: (id: string) =>
    call<{ items: AttachmentView[] }>(`/tickets/${encodeURIComponent(id)}/attachments`),

  requestUpload: (
    id: string,
    body: { fileName: string; contentType: string; sizeBytes: number; visibility: string },
  ) =>
    call<{ attachmentId: string; uploadUrl: string; expiresAt: string }>(
      `/tickets/${encodeURIComponent(id)}/attachments`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteAttachment: (attachmentId: string, reason: string) =>
    call<void>(`/attachments/${encodeURIComponent(attachmentId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  downloadUrl: (attachmentId: string) =>
    call<{ url: string; expiresAt: string }>(
      `/attachments/${encodeURIComponent(attachmentId)}/download`,
    ),

  listRelations: (id: string) =>
    call<RelationListView>(`/tickets/${encodeURIComponent(id)}/relations`),

  linkTicket: (id: string, body: { relationType: string; targetTicketNumber: string }) =>
    call<{ relationId: string; relationType: string; targetTicketId: string }>(
      `/tickets/${encodeURIComponent(id)}/relations`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  unlinkTicket: (relationId: string) =>
    call<void>(`/relations/${encodeURIComponent(relationId)}/delete`, { method: 'POST' }),

  /** 統合前の確認に使う。閲覧できない番号は「見つかりません」で返る。 */
  lookupByNumber: (number: string) =>
    call<{ ticketId: string; number: string; subject: string; state: string }>(
      `/tickets/by-number/${encodeURIComponent(number)}`,
    ),

  mergeTicket: (id: string, body: { targetTicketNumber: string; reason: string }) =>
    call<{
      sourceTicketId: string;
      targetTicketId: string;
      retained: { comments: number; attachments: number };
    }>(`/tickets/${encodeURIComponent(id)}/merge`, { method: 'POST', body: JSON.stringify(body) }),

  /** 影響度・緊急度の見直し。**優先度は送らない** — サーバが導く。 */
  reassess: (id: string, body: { impact: string; urgency: string; reason: string }) =>
    call<{ impact: string; urgency: string; priority: string }>(
      `/tickets/${encodeURIComponent(id)}/assessment`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** 担当グループの割当。**個人の担当とは別の経路** (FR-TKT-003)。 */
  assignGroup: (id: string, groupId: string | null) =>
    call<{ assigneeGroupId: string | null }>(`/tickets/${encodeURIComponent(id)}/group`, {
      method: 'POST',
      body: JSON.stringify({ groupId }),
    }),

  listGroups: (includeInactive = false) =>
    call<{
      items: Array<{
        id: string;
        code: string;
        name: string;
        description: string | null;
        active: boolean;
        memberCount: number;
      }>;
    }>(`/groups${includeInactive ? '?includeInactive=1' : ''}`),

  myGroups: () =>
    call<{ items: Array<{ id: string; code: string; name: string }> }>('/groups/mine'),

  createGroup: (body: { code: string; name: string; description?: string }) =>
    call<{ id: string; code: string; name: string }>('/groups', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setGroupActive: (groupId: string, active: boolean) =>
    call<void>(`/groups/${encodeURIComponent(groupId)}/active`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    }),

  listGroupMembers: (groupId: string) =>
    call<{ items: Array<{ userId: string; displayName: string; addedAt: string }> }>(
      `/groups/${encodeURIComponent(groupId)}/members`,
    ),

  addGroupMember: (groupId: string, userId: string) =>
    call<void>(`/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  removeGroupMember: (groupId: string, userId: string) =>
    call<void>(`/groups/${encodeURIComponent(groupId)}/members/remove`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  assign: (id: string, assigneeId: string | null) =>
    call<{ assigneeId: string | null }>(`/tickets/${encodeURIComponent(id)}/assignee`, {
      method: 'POST',
      body: JSON.stringify({ assigneeId }),
    }),
};

/**
 * ログイン済みでなければログイン画面へ、組織が未選択なら選択画面へ送る。
 *
 * **401 と「組織未選択」を同じ扱いにしない。** 兼務者を401としてログイン画面へ
 * 送り返すと、正しい資格情報で何度ログインしても同じ画面に戻ってくる。
 * 利用者から見て**直しようのない行き止まり**になる。
 *
 * 各画面が個別に判定すると、新しい画面を足した人が片方を書き忘れる。
 * 判定はここ1か所に閉じる。
 */
export async function requireSession(): Promise<SessionView> {
  const session = await api.me();
  if (session.ok) return session.data;

  if (session.problem.type?.endsWith('/organization-not-selected')) {
    redirect('/select-organization');
  }
  redirect('/login');
}
