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

export interface TicketSlaView {
  /** 解決期限までの残り。**負値は超過**。目標未設定なら null。 */
  remainingSeconds: number | null;
  breached: boolean;
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
  /** 期限 (FR-TKT-008)。目標が設定されていない組織では付かない。 */
  sla?: TicketSlaView;
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
    /** 見ていた版 (WP-P2-UISTATE-020)。操作と一緒に送り返す。 */
    version: string;
  };
  comments: CommentView[];
  attachments: AttachmentView[];
  availableActions: AvailableAction[];
  /** 保存されている優先度が影響度×緊急度の規則どおりか (WP-P2-PRIO-013)。 */
  priorityIsDerived: boolean;
  /** 振り先の候補。**無効化したグループは含まれない** (FR-TKT-003)。 */
  availableGroups: GroupSummary[];
  /** 期限の詳細 (FR-TKT-008)。**その場で計算した値**であり保存値ではない。 */
  sla: {
    elapsedSeconds: number;
    responseTargetSeconds: number;
    resolutionTargetSeconds: number;
    responseBreached: boolean;
    resolutionBreached: boolean;
    remainingSeconds: number;
  };
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

  transition: (id: string, body: { to: string; reason: string; expectedVersion?: string }) =>
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
  reassess: (
    id: string,
    body: { impact: string; urgency: string; reason: string; expectedVersion?: string },
  ) =>
    call<{ impact: string; urgency: string; priority: string }>(
      `/tickets/${encodeURIComponent(id)}/assessment`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** 担当グループの割当。**個人の担当とは別の経路** (FR-TKT-003)。 */
  assignGroup: (id: string, groupId: string | null, expectedVersion?: string) =>
    call<{ assigneeGroupId: string | null }>(`/tickets/${encodeURIComponent(id)}/group`, {
      method: 'POST',
      body: JSON.stringify({ groupId, expectedVersion }),
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

  /** 在籍者の一覧 (FR-IDM-007)。org_admin のみ。 */
  listMembers: () =>
    call<{
      items: Array<{
        userId: string;
        displayName: string;
        email: string;
        status: 'active' | 'deactivated';
        deactivatedAt: string | null;
        roleCodes: string[];
        /** 期限つきの役割 (FR-IDM-006)。兼務・出向。 */
        temporaryRoles: Array<{
          roleCode: string;
          validUntil: string;
          daysRemaining: number;
          /** まもなく切れるか。**判定はサーバが持つ** (WP-P1-IDM-017)。 */
          expiringSoon: boolean;
        }>;
        openTicketCount: number;
      }>;
    }>('/users'),

  /** 利用者を作る (WP-P1-IDM-016)。作るだけで、入れるようにはしない。 */
  createUser: (body: { email: string; displayName: string; roleCode: string; reason: string }) =>
    call<{ userId: string }>('/users', { method: 'POST', body: JSON.stringify(body) }),

  deactivateUser: (userId: string, reason: string) =>
    call<{ revokedSessions: number; openTicketCount: number }>(
      `/users/${encodeURIComponent(userId)}/deactivate`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  /** 役割を与える (WP-P1-IDM-015)。org スコープのみ。 */
  grantRole: (userId: string, roleCode: string, reason: string, validUntil?: string) =>
    call<void>(`/users/${encodeURIComponent(userId)}/roles`, {
      method: 'POST',
      body: JSON.stringify({ roleCode, reason, validUntil: validUntil || undefined }),
    }),

  revokeRole: (userId: string, roleCode: string, reason: string) =>
    call<void>(`/users/${encodeURIComponent(userId)}/roles/revoke`, {
      method: 'POST',
      body: JSON.stringify({ roleCode, reason }),
    }),

  reactivateUser: (userId: string, reason: string) =>
    call<void>(`/users/${encodeURIComponent(userId)}/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  assign: (id: string, assigneeId: string | null, expectedVersion?: string) =>
    call<{ assigneeId: string | null }>(`/tickets/${encodeURIComponent(id)}/assignee`, {
      method: 'POST',
      body: JSON.stringify({ assigneeId, expectedVersion }),
    }),
};

/**
 * ログイン済みでなければログイン画面へ、組織が未選択なら選択画面へ送る。
 *
 * **401 と「組織未選択」を同じ扱いにしない。** 兼務者を401としてログイン画面へ
 * 送り返すと、正しい資格情報で何度ログインしても同じ画面に戻ってくる。
 * 利用者から見て**直しようのない行き止まり**になる。
 *
 * **「基盤へ届かない」も同じ扱いにしない。** ここが本WPで直した欠陥である。
 * 以前は `api.me()` が失敗すれば理由を問わずログイン画面へ送っていた。
 * APIが落ちているとき、利用者は黙ってログアウトさせられ、
 * **そのログイン画面でも同じ理由で失敗する。**
 * 画面上は「パスワードが違う」ようにしか見えず、
 * 全員が自分の資格情報を疑いながら何度も試すことになる。
 *
 * `call()` は最初から 503 を返していた(`ApiResult.problem.status`)。
 * **判別できる情報はあり、呼ぶ側が捨てていた。**
 *
 * 各画面が個別に判定すると、新しい画面を足した人が書き忘れる。
 * 判定はここ1か所に閉じる。
 */
export async function requireSession(): Promise<SessionView> {
  const session = await api.me();
  if (session.ok) return session.data;

  if (session.problem.type?.endsWith('/organization-not-selected')) {
    redirect('/select-organization');
  }

  // 5xx は「あなたが誰か分からない」ではなく「こちらの都合で答えられない」。
  //
  // **投げずに専用の画面へ送る。** サーバ側の描画中に投げた例外は
  // `error.tsx` へ届かず、Next.js の既定の500画面(日本語ですらない)が出る。
  // `error.tsx` が効くのは画面遷移中とハイドレーション後であり、
  // 最初の1枚には効かない。
  if (session.problem.status >= 500) {
    redirect('/unavailable');
  }

  // ここまで来たら本当に認証が要る。
  // **一度入っていた人と、まだ入っていない人を区別する。**
  // セッションの Cookie を持っているのに 401 なら、期限切れか失効である。
  // 「なぜ画面から追い出されたのか」が分からないまま戻されると、
  // 利用者は自分の操作を疑う。
  const jar = await cookies();
  const hadSession = jar.getAll().some((c) => c.name.startsWith('solvi_session'));
  redirect(hadSession ? '/login?expired=1' : '/login');
}
