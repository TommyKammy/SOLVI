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

export interface WorkspaceView {
  ticket: TicketView & { requesterId: string; assigneeId: string | null };
  comments: CommentView[];
  attachments: AttachmentView[];
  availableActions: AvailableAction[];
}

export const api = {
  login: (body: { email: string; password: string; organizationId?: string }) =>
    call<{ userId: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      forwardCookie: false,
    }),

  logout: () => call<void>('/auth/logout', { method: 'POST' }),

  me: () => call<SessionView>('/auth/me'),

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

  assign: (id: string, assigneeId: string | null) =>
    call<{ assigneeId: string | null }>(`/tickets/${encodeURIComponent(id)}/assignee`, {
      method: 'POST',
      body: JSON.stringify({ assigneeId }),
    }),
};
