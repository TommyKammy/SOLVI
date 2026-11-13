import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { parseOperationsOverview, type OperationsOverviewCounts } from './operations-overview';
import {
  parseNotificationList,
  notificationQueryString,
  type NotificationList,
  type NotificationQuery,
} from './notification-list';
export type { NotificationList, NotificationItem } from './notification-list';
import {
  parseNotificationPreference,
  type NotificationPreference,
} from './notification-preference';
export type { NotificationPreference } from './notification-preference';
import {
  parseNotificationRetry,
  retryTarget,
  retryVersion,
  type NotificationRetryStatus,
} from './notification-retry';

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
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return { ok: false, problem: { title: '応答を読み取れませんでした', status: 502 } };
  }

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

export interface ReplyContext {
  ticketVersion: string;
  latestCommentId: string | null;
}

export interface TicketView {
  assigneeName?: string | null;
  assigneeGroupName?: string | null;
  requesterName?: string | null;
  pendingReason?: 'wait_requester' | 'wait_external' | null;
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

/** 部署ツリー (WP-P4-IDM-013)。管理画面だけが使う。 */
export interface DepartmentNode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  active: boolean;
  depth: number;
  children: DepartmentNode[];
}

export interface DepartmentRecord {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentHeadView {
  id: string;
  departmentId: string;
  userId: string;
  displayName: string;
  validFrom: string;
  validUntil: string | null;
}

export interface DepartmentMemberView {
  userId: string;
  displayName: string;
  status: 'active' | 'deactivated';
  jobTitle: string | null;
  managerUserId: string | null;
  managerDisplayName: string | null;
  activeMembership: boolean;
}

/** 組織プロフィール (FR-IDM-014)。`limited` は agent 向けの最小表示。 */
export interface MemberProfileView {
  userId: string;
  displayName: string;
  visibility: 'full' | 'limited';
  primaryDepartmentId?: string | null;
  primaryDepartmentName?: string | null;
  managerUserId?: string | null;
  managerDisplayName?: string | null;
  jobTitle?: string | null;
  location?: string | null;
  employeeId?: string | null;
}

export interface ProfileCompleteness {
  totalMembers: number;
  missingManager: number;
  missingDepartment: number;
  totalDepartments: number;
  missingDepartmentHead: number;
}

export interface CommentView {
  authorIsRequester?: boolean;
  id: string;
  ticketId: string;
  authorId: string;
  visibility: 'public' | 'internal';
  body: string;
  createdAt: string;
  citation?: {
    articleId: string;
    version: number;
    title: string | null;
    available: boolean;
  } | null;
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
  replyContext: ReplyContext;
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
  notificationPreference: async (): Promise<ApiResult<NotificationPreference>> => {
    try {
      const result = await call<unknown>('/me/notification-preferences');
      if (!result.ok) return result;
      const data = parseNotificationPreference(result.data);
      return data
        ? { ok: true, data }
        : { ok: false, problem: { status: 502, title: '通知設定を確認できませんでした' } };
    } catch {
      return { ok: false, problem: { status: 503, title: '通知設定を確認できませんでした' } };
    }
  },
  saveNotificationPreference: async (
    ticketEmailEnabled: boolean,
    scope: string,
  ): Promise<ApiResult<NotificationPreference>> => {
    try {
      const result = await call<unknown>('/me/notification-preferences', {
        method: 'PATCH',
        headers: { 'x-solvi-form-scope': scope },
        body: JSON.stringify({ ticketEmailEnabled }),
      });
      if (!result.ok) return result;
      const data = parseNotificationPreference(result.data);
      return data
        ? { ok: true, data }
        : { ok: false, problem: { status: 502, title: '通知設定を確認できませんでした' } };
    } catch {
      return { ok: false, problem: { status: 503, title: '通知設定を確認できませんでした' } };
    }
  },
  notifications: async (query: NotificationQuery): Promise<ApiResult<NotificationList>> => {
    if (query.invalid)
      return { ok: false, problem: { status: 400, title: '表示条件を確認してください' } };
    try {
      const result = await call<unknown>(`/notifications?${notificationQueryString(query)}`);
      if (!result.ok) return result;
      const data = parseNotificationList(result.data, query.status);
      return data
        ? { ok: true, data }
        : { ok: false, problem: { status: 502, title: '通知状況を確認できませんでした' } };
    } catch {
      // Receiving headers does not guarantee that the response body can be read.
      return { ok: false, problem: { status: 503, title: '通知状況を確認できませんでした' } };
    }
  },
  notificationRetry: async (id: string): Promise<ApiResult<NotificationRetryStatus>> => {
    if (!retryTarget(id))
      return { ok: false, problem: { status: 400, title: '対象を確認してください' } };
    try {
      const result = await call<unknown>(`/notifications/${encodeURIComponent(id)}/manual-retry`);
      if (!result.ok)
        return {
          ok: false,
          problem: { status: result.problem.status, title: '予約状態を確認できませんでした' },
        };
      const data = parseNotificationRetry(result.data);
      return data
        ? { ok: true, data }
        : { ok: false, problem: { status: 502, title: '予約状態を確認できませんでした' } };
    } catch {
      return { ok: false, problem: { status: 503, title: '予約状態を確認できませんでした' } };
    }
  },
  reserveNotificationRetry: async (
    id: string,
    version: string,
    scope: string,
  ): Promise<ApiResult<NotificationRetryStatus>> => {
    if (!retryTarget(id) || !retryVersion(version))
      return { ok: false, problem: { status: 400, title: '確認内容を確認してください' } };
    try {
      const result = await call<unknown>(`/notifications/${encodeURIComponent(id)}/manual-retry`, {
        method: 'POST',
        headers: { 'x-solvi-form-scope': scope },
        body: JSON.stringify({ version }),
      });
      if (!result.ok)
        return {
          ok: false,
          problem: { status: result.problem.status, title: '予約結果を確認できませんでした' },
        };
      const data = parseNotificationRetry(result.data);
      return data && data.state !== 'not_requested'
        ? { ok: true, data }
        : { ok: false, problem: { status: 502, title: '予約結果を確認できませんでした' } };
    } catch {
      return { ok: false, problem: { status: 503, title: '予約結果を確認できませんでした' } };
    }
  },
  inbox: async (query = ''): Promise<ApiResult<InboxView>> => {
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/inbox${query ? '?' + query : ''}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      // HTTPの拒否を本文の欠損や本文内のstatusで上書きしない。
      if (!response.ok) {
        const status = response.status;
        // 未読本文のcancel完了を待たず、このGETを中止する。
        controller.abort();
        return {
          ok: false,
          problem: { status, title: '受信箱を取得できませんでした' },
        };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as InboxView,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { title: '応答を読み取れませんでした', status: 502 } };
      }
      return { ok: true, data: parsed as InboxView, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '受信箱を取得できませんでした' } };
    }
  },
  readInbox: (body: Record<string, unknown>) =>
    call<{ receiptId: string; replayed: boolean; href: string }>('/inbox/read', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  changes: async (query = ''): Promise<ApiResult<ChangeList>> => {
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/changes${query ? '?' + query : ''}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 本文内のstatusや未読本文のcancel完了に依存せず、HTTPの拒否を保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '変更一覧を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as ChangeList,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { title: '応答を読み取れませんでした', status: 502 } };
      }
      return { ok: true, data: parsed as ChangeList, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '変更一覧を取得できませんでした' } };
    }
  },
  change: (id: string) => call<ChangeDetail>(`/changes/${encodeURIComponent(id)}`),
  changeDetail: async (id: string): Promise<ApiResult<ChangeDetail>> => {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      return { ok: false, problem: { status: 400, title: '変更の指定が正しくありません' } };
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/changes/${encodeURIComponent(id)}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '変更を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as ChangeDetail,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as ChangeDetail, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '変更を取得できませんでした' } };
    }
  },
  changeOptions: (query = '') => call<ChangeOptions>(`/changes/options${query ? '?' + query : ''}`),
  changeFormOptions: async (query = ''): Promise<ApiResult<ChangeOptions>> => {
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/changes/options${query ? '?' + query : ''}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文を読まず、受信したHTTPstatusを同期abort後も保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '入力候補を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as ChangeOptions,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as ChangeOptions, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '入力候補を取得できませんでした' } };
    }
  },
  createChange: (body: Record<string, unknown>) =>
    call<{ id: string }>('/changes', { method: 'POST', body: JSON.stringify(body) }),
  changeCommand: (id: string, action: string, body: Record<string, unknown>) =>
    call<{ id: string }>(`/changes/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  relatedChanges: (kind: 'ticket' | 'asset', id: string) =>
    call<{ items: ChangeSummary[]; canCreate: boolean }>(
      `/${kind === 'ticket' ? 'tickets' : 'assets'}/${encodeURIComponent(id)}/changes`,
    ),
  inspectAssetCsv: (csv: string) =>
    call<AssetCsvInspection>('/assets/imports/inspect', {
      method: 'POST',
      body: JSON.stringify({ csv }),
    }),
  previewAssetCsv: (body: {
    csv: string;
    sourceKey: string;
    reason: string;
    mapping: Record<string, string>;
  }) =>
    call<{ id: string }>('/assets/imports/preview', { method: 'POST', body: JSON.stringify(body) }),
  assetImports: async (): Promise<ApiResult<AssetImportList>> => {
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/assets/imports`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文の内容やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '取込履歴を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as AssetImportList,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as AssetImportList, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '取込履歴を取得できませんでした' } };
    }
  },
  assetImport: (id: string) => call<AssetImportDetail>(`/assets/imports/${encodeURIComponent(id)}`),
  assetImportDetail: async (id: string): Promise<ApiResult<AssetImportDetail>> => {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      return { ok: false, problem: { status: 400, title: '取込内容の指定が正しくありません' } };
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/assets/imports/${encodeURIComponent(id)}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文の内容やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '取込内容を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as AssetImportDetail,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as AssetImportDetail, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '取込内容を取得できませんでした' } };
    }
  },
  applyAssetImport: (id: string, body: { planHash: string; confirmed: boolean }) =>
    call<AssetImportResult & { replayed: boolean }>(
      `/assets/imports/${encodeURIComponent(id)}/apply`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  assets: async (query = ''): Promise<ApiResult<AssetList>> => {
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/assets${query ? '?' + query : ''}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 本文内のstatusや未読本文のcancel完了に依存せず、HTTPの拒否を保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '資産一覧を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as AssetList,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { title: '応答を読み取れませんでした', status: 502 } };
      }
      return { ok: true, data: parsed as AssetList, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '資産一覧を取得できませんでした' } };
    }
  },
  asset: async (id: string): Promise<ApiResult<AssetDetail>> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { ok: false, problem: { status: 400, title: '資産の指定が正しくありません' } };
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/assets/${encodeURIComponent(id)}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文の内容やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '資産を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as AssetDetail,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as AssetDetail, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '資産を取得できませんでした' } };
    }
  },
  assetOptions: () => call<AssetOptions>('/assets/options'),
  assetFormOptions: async (): Promise<ApiResult<AssetOptions>> => {
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/assets/options`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文の内容やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '入力候補を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as AssetOptions,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as AssetOptions, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '入力候補を取得できませんでした' } };
    }
  },
  createAsset: (body: Record<string, unknown>) =>
    call<{ id: string; version: number }>('/assets', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  editAsset: (id: string, body: Record<string, unknown>) =>
    call<{ id: string; version: number }>(`/assets/${id}/edit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  ticketAssets: (id: string) => call<TicketAssets>(`/tickets/${id}/assets`),
  linkAsset: (id: string, body: Record<string, unknown>) =>
    call<{ active: boolean }>(`/tickets/${id}/assets`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  unlinkAsset: (id: string, assetId: string, body: Record<string, unknown>) =>
    call<{ active: boolean }>(`/tickets/${id}/assets/${assetId}/unlink`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  catalog: () =>
    call<{
      items: CatalogItem[];
      approvers: Array<{ id: string; name: string }>;
      canManage: boolean;
    }>('/catalog'),
  catalogRequestOptions: async (): Promise<
    ApiResult<{
      items: CatalogItem[];
      approvers: Array<{ id: string; name: string }>;
      canManage: boolean;
    }>
  > => {
    type Data = {
      items: CatalogItem[];
      approvers: Array<{ id: string; name: string }>;
      canManage: boolean;
    };
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/catalog`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        controller.abort();
        return { ok: false, problem: { status, title: 'サービスカタログを取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as Data,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as Data, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return {
        ok: false,
        problem: { status: 503, title: 'サービスカタログを取得できませんでした' },
      };
    }
  },
  catalogAdmin: () => call<CatalogAdminList>('/catalog-admin'),
  catalogAdminItem: (id: string) =>
    call<CatalogAdminDetail>(`/catalog-admin/${encodeURIComponent(id)}`),
  catalogQuestionSets: () =>
    call<{ items: CatalogQuestionSet[]; canManage: boolean }>('/catalog-question-sets'),
  saveCatalogQuestionSet: (id: string | null, body: Record<string, unknown>) =>
    call<{ id: string; revision: number }>(
      id ? `/catalog-question-sets/${encodeURIComponent(id)}/save` : '/catalog-question-sets',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateRequestChecklist: (id: string, body: Record<string, unknown>) =>
    call<{ id: string; checklistVersion: number }>(
      `/service-requests/${encodeURIComponent(id)}/checklist`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  catalogManagementDetail: async (id: string): Promise<ApiResult<CatalogAdminDetail>> => {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
      return { ok: false, problem: { status: 400, title: 'カタログ項目を取得できませんでした' } };
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/catalog-admin/${encodeURIComponent(id)}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文は読まず、同期abort後も受信HTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: 'カタログ項目を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as CatalogAdminDetail,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as CatalogAdminDetail, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: 'カタログ項目を取得できませんでした' } };
    }
  },
  catalogManagementRead: async (): Promise<ApiResult<CatalogAdminList>> => {
    type Data = CatalogAdminList;
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/catalog-admin`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        controller.abort();
        return { ok: false, problem: { status, title: 'カタログ管理を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as Data,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as Data, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: 'カタログ管理を取得できませんでした' } };
    }
  },
  saveCatalogItem: (id: string | null, body: Record<string, unknown>) =>
    call<{ id: string }>(id ? `/catalog-admin/${encodeURIComponent(id)}/save` : '/catalog-admin', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  publishCatalogItem: (id: string, body: Record<string, unknown>) =>
    call<{ id: string }>(`/catalog-admin/${encodeURIComponent(id)}/publication`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 承認ルールの管理 (WP-P4-APR-016 段階A)。すべて org_admin。 */
  approvalRules: () => call<{ items: ApprovalRuleSummary[] }>('/approval-rules'),
  createApprovalRule: (body: { code: string; name: string; steps: ApprovalRuleStepView[] }) =>
    call<{ rule: { id: string; revision: number } }>('/approval-rules', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reviseApprovalRule: (
    id: string,
    body: { expectedRevision: number; steps: ApprovalRuleStepView[]; name?: string },
  ) =>
    call<{ rule: { id: string; revision: number } }>(
      `/approval-rules/${encodeURIComponent(id)}/revisions`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  deactivateApprovalRule: (id: string) =>
    call<{ rule: { id: string; active: false } }>(
      `/approval-rules/${encodeURIComponent(id)}/deactivate`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  approvalRuleHistory: (id: string) =>
    call<{ items: ApprovalRuleRevisionSummary[] }>(
      `/approval-rules/${encodeURIComponent(id)}/history`,
    ),
  approvalRuleUnresolved: (id: string) =>
    call<ApprovalUnresolvedResult>(`/approval-rules/${encodeURIComponent(id)}/unresolved`),

  /** 組織で承認ルールを使うかの設定。行が無ければ無効。 */
  approvalRouting: () => call<{ setting: ApprovalRuleSettings }>('/approval-routing'),
  updateApprovalRouting: (enabled: boolean) =>
    call<{ setting: { enabled: boolean; changed: boolean } }>('/approval-routing', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  approvalPreview: (body: {
    requesterId: string;
    itemId?: string;
    ruleId?: string;
    approverId?: string;
  }) =>
    call<ApprovalPreviewResult>('/approval-routing/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 上長・主部署・部署長の変更履歴 (org_admin / auditor)。 */
  relationshipChanges: (query: { from: string; to: string; page: number }) => {
    const params = new URLSearchParams({
      from: query.from,
      to: query.to,
      page: String(query.page),
    });
    return call<RelationshipChangeResult>(`/relationship-changes?${params.toString()}`);
  },
  serviceRequests: async (query = '') => {
    type List = {
      items: ServiceRequestSummary[];
      total: number;
      page: number;
      pageSize: number;
      appliedFilter: { q: string; state: string; view: string; page: number };
    };
    const failure = (
      status: number,
      title = '申請一覧を取得できませんでした',
    ): ApiResult<List> => ({
      ok: false,
      problem: { status, title },
    });
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/service-requests${query ? '?' + query : ''}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 本文内のstatusや未読本文のcancel完了に依存せず、HTTPの拒否を保持する。
        controller.abort();
        return failure(status);
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true as const,
          data: undefined as unknown as List,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return failure(502, '応答を読み取れませんでした');
      }
      return { ok: true as const, data: parsed as List, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return failure(503);
    }
  },
  serviceRequest: (id: string) => call<ServiceRequestDetail>(`/service-requests/${id}`),
  requestDetail: async (id: string): Promise<ApiResult<ServiceRequestDetail>> => {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      return { ok: false, problem: { status: 400, title: '申請の指定が正しくありません' } };
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/service-requests/${encodeURIComponent(id)}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '申請を取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as ServiceRequestDetail,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return {
        ok: true,
        data: parsed as ServiceRequestDetail,
        ...(setCookie ? { setCookie } : {}),
      };
    } catch {
      return { ok: false, problem: { status: 503, title: '申請を取得できませんでした' } };
    }
  },
  submitRequest: (body: Record<string, unknown>, scope?: string) =>
    call<{ id: string; ticketId: string }>('/service-requests', {
      method: 'POST',
      headers: scope ? { 'x-solvi-form-scope': scope } : {},
      body: JSON.stringify(body),
    }),
  editRequest: (id: string, body: Record<string, unknown>, scope?: string) =>
    call<{ id: string }>(`/service-requests/${id}/edit`, {
      method: 'POST',
      headers: scope ? { 'x-solvi-form-scope': scope } : {},
      body: JSON.stringify(body),
    }),
  decideRequest: (id: string, body: Record<string, unknown>) =>
    call<{ id: string }>(`/service-requests/${id}/decisions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  simulateRequest: (id: string, body: Record<string, unknown>) =>
    call<{ receipt: { id: string } }>(`/service-requests/${id}/simulate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  knowledgeList: (q: string, manage = false, options: { limit?: number; cursor?: string } = {}) => {
    const params = new URLSearchParams({ q });
    if (manage) params.set('manage', '1');
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    return call<KnowledgeList>(`/knowledge?${params}`);
  },
  knowledgeDetail: async (id: string, manage = false) => {
    type Detail = {
      article: KnowledgeArticle;
      versions: Array<{ number: number; title: string; createdAt: string }>;
    };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return {
        ok: false,
        problem: { status: 400, title: '記事の指定が正しくありません' },
      } as ApiResult<Detail>;
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      const response = await fetch(
        `${API_BASE}/knowledge/${encodeURIComponent(id)}${manage ? '?manage=1' : ''}`,
        {
          headers,
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const status = response.status;
        controller.abort();
        return {
          ok: false,
          problem: { status, title: '記事を取得できませんでした' },
        } as ApiResult<Detail>;
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as Detail,
          ...(setCookie ? { setCookie } : {}),
        } as ApiResult<Detail>;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return {
          ok: false,
          problem: { status: 502, title: '応答を読み取れませんでした' },
        } as ApiResult<Detail>;
      }
      return {
        ok: true,
        data: parsed as Detail,
        ...(setCookie ? { setCookie } : {}),
      } as ApiResult<Detail>;
    } catch {
      return {
        ok: false,
        problem: { status: 503, title: '記事を取得できませんでした' },
      } as ApiResult<Detail>;
    }
  },
  knowledgeCreate: (body: Record<string, unknown>) =>
    call<{ id: string; version: number }>('/knowledge', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  knowledgeSave: (id: string, body: Record<string, unknown>) =>
    call<{ id: string; version: number }>(`/knowledge/${id}/save`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  knowledgeAction: (id: string, body: Record<string, unknown>) =>
    call<{ id: string; version: number }>(`/knowledge/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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

  createTicket: (
    body: {
      kind: string;
      subject: string;
      body: string;
      impact: string;
      urgency: string;
    },
    scope?: string,
  ) =>
    call<TicketView>('/tickets', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: scope ? { 'x-solvi-form-scope': scope } : {},
    }),

  ticketOverview: async (group = ''): Promise<ApiResult<OperationsOverviewCounts>> => {
    const query = new URLSearchParams();
    if (group) query.set('group', group);
    let response: ApiResult<unknown>;
    try {
      response = await call<unknown>(`/tickets/overview${query.size ? `?${query}` : ''}`);
    } catch {
      // A failed response stream must not discard independently loaded deadlines/groups.
      return { ok: false, problem: { title: '集計を取得できませんでした', status: 503 } };
    }
    if (!response.ok) return response;
    const data = parseOperationsOverview(response.data);
    if (!data)
      return { ok: false, problem: { title: '集計の応答を確認できませんでした', status: 502 } };
    return { ...response, data };
  },

  listTickets: (limit = 10, filter?: URLSearchParams) => {
    const query = new URLSearchParams(filter);
    query.set('limit', String(limit));
    return call<{
      items: TicketView[];
      total: number;
      scope: string;
      appliedFilter: Record<string, unknown>;
      nextCursor: { createdAt: string; id: string } | null;
    }>(`/tickets?${query.toString()}`);
  },

  getTicket: (id: string) => call<TicketView>(`/tickets/${encodeURIComponent(id)}`),

  ticketDetail: async (id: string): Promise<ApiResult<TicketView>> => {
    let encodedId: string;
    try {
      if (typeof id !== 'string' || !id.length || id === '.' || id === '..') throw new Error();
      encodedId = encodeURIComponent(id);
    } catch {
      return { ok: false, problem: { status: 400, title: '問い合わせの指定が正しくありません' } };
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/tickets/${encodedId}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '問い合わせを取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as TicketView,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as TicketView, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '問い合わせを取得できませんでした' } };
    }
  },

  workspace: (id: string) => call<WorkspaceView>(`/tickets/${encodeURIComponent(id)}/workspace`),

  operatorWorkspaceDetail: async (id: string): Promise<ApiResult<WorkspaceView>> => {
    let encodedId: string;
    try {
      if (typeof id !== 'string' || !id.length || id === '.' || id === '..') throw new Error();
      encodedId = encodeURIComponent(id);
    } catch {
      return { ok: false, problem: { status: 400, title: '問い合わせの指定が正しくありません' } };
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) {
        headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      }
      const response = await fetch(`${API_BASE}/tickets/${encodedId}/workspace`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        // 拒否本文やcancel完了に依存せず、受信したHTTPstatusを保持する。
        controller.abort();
        return { ok: false, problem: { status, title: '問い合わせを取得できませんでした' } };
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as WorkspaceView,
          ...(setCookie ? { setCookie } : {}),
        };
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return { ok: false, problem: { status: 502, title: '応答を読み取れませんでした' } };
      }
      return { ok: true, data: parsed as WorkspaceView, ...(setCookie ? { setCookie } : {}) };
    } catch {
      return { ok: false, problem: { status: 503, title: '問い合わせを取得できませんでした' } };
    }
  },

  listComments: (id: string) =>
    call<{ items: CommentView[]; replyContext: ReplyContext }>(
      `/tickets/${encodeURIComponent(id)}/comments`,
    ),

  citationContent: async (ticketId: string, commentId: string) => {
    type Detail = { articleId: string; version: number; title: string; body: string };
    let ticket: string;
    let comment: string;
    try {
      if ([ticketId, commentId].some((value) => value === '' || value === '.' || value === '..')) {
        return {
          ok: false,
          problem: { status: 400, title: '引用記事の指定が正しくありません' },
        } as ApiResult<Detail>;
      }
      ticket = encodeURIComponent(ticketId);
      comment = encodeURIComponent(commentId);
    } catch {
      return {
        ok: false,
        problem: { status: 400, title: '引用記事の指定が正しくありません' },
      } as ApiResult<Detail>;
    }
    try {
      const controller = new AbortController();
      const headers = new Headers({ 'content-type': 'application/json' });
      const all = (await cookies()).getAll();
      if (all.length > 0) headers.set('cookie', all.map((c) => `${c.name}=${c.value}`).join('; '));
      const response = await fetch(`${API_BASE}/tickets/${ticket}/comments/${comment}/citation`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        controller.abort();
        return {
          ok: false,
          problem: { status, title: '引用記事を取得できませんでした' },
        } as ApiResult<Detail>;
      }
      const setCookie = response.headers.get('set-cookie') ?? undefined;
      if (response.status === 204) {
        return {
          ok: true,
          data: undefined as unknown as Detail,
          ...(setCookie ? { setCookie } : {}),
        } as ApiResult<Detail>;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        return {
          ok: false,
          problem: { status: 502, title: '応答を読み取れませんでした' },
        } as ApiResult<Detail>;
      }
      return {
        ok: true,
        data: parsed as Detail,
        ...(setCookie ? { setCookie } : {}),
      } as ApiResult<Detail>;
    } catch {
      return {
        ok: false,
        problem: { status: 503, title: '引用記事を取得できませんでした' },
      } as ApiResult<Detail>;
    }
  },
  addComment: (
    id: string,
    body: {
      visibility: string;
      body: string;
      citation?: { articleId: string; version: number };
      replyContext?: ReplyContext;
    },
    scope?: string,
  ) =>
    call<CommentView>(`/tickets/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: scope ? { 'x-solvi-form-scope': scope } : {},
    }),

  takeOwnership: (id: string, expectedVersion: string) =>
    call<{ state: string }>(`/tickets/${encodeURIComponent(id)}/take`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    }),

  resolveWithReply: (
    id: string,
    body: {
      body: string;
      visibility: string;
      expectedVersion: string;
      citation?: { articleId: string; version: number };
      replyContext?: ReplyContext;
    },
    scope?: string,
  ) =>
    call<{ state: string; comment: CommentView }>(`/tickets/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: scope ? { 'x-solvi-form-scope': scope } : {},
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

  // ---- アクセスレビュー (NFR-SEC-002 / WP-P1-SEC-024) -----------------------

  listAccessReviews: () =>
    call<{
      items: Array<{
        id: string;
        periodLabel: string;
        openedAt: string;
        source: 'manual' | 'scheduled';
        completedAt: string | null;
        totalItems: number;
        pendingItems: number;
      }>;
    }>('/access-reviews'),

  openAccessReview: (periodLabel: string) =>
    call<{ reviewId: string; items: number }>('/access-reviews', {
      method: 'POST',
      body: JSON.stringify({ periodLabel }),
    }),

  accessReview: (reviewId: string) =>
    call<{
      review: {
        id: string;
        periodLabel: string;
        openedAt: string;
        completedAt: string | null;
        totalItems: number;
        pendingItems: number;
      };
      items: Array<{
        id: string;
        userId: string;
        displayName: string;
        email: string;
        roleCode: string;
        validUntilAtOpen: string | null;
        decision: 'pending' | 'keep' | 'revoke';
        reason: string | null;
        alreadyInactive: boolean;
        selfReviewed: boolean;
      }>;
    }>(`/access-reviews/${encodeURIComponent(reviewId)}`),

  decideAccessReviewItem: (
    reviewId: string,
    itemId: string,
    body: { decision: 'keep' | 'revoke'; reason: string },
  ) =>
    call<void>(
      `/access-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  completeAccessReview: (reviewId: string) =>
    call<{ decided: number }>(`/access-reviews/${encodeURIComponent(reviewId)}/complete`, {
      method: 'POST',
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
        /** 主部署 (WP-P4-IDM-013)。未設定は null。 */
        primaryDepartmentId: string | null;
        primaryDepartmentName: string | null;
        managerUserId: string | null;
        managerDisplayName: string | null;
        jobTitle: string | null;
      }>;
      /** プロフィール充足率 (WP-P4-IDM-013 §6)。 */
      profileCompleteness: ProfileCompleteness;
    }>('/users'),

  /** 組織プロフィール (FR-IDM-014 / WP-P4-IDM-013)。閲覧範囲はAPIが決める。 */
  getProfile: (userId: string) =>
    call<{ profile: MemberProfileView }>(`/users/${encodeURIComponent(userId)}/profile`),

  /** 主部署・上長・役職・勤務地・社員番号の更新。 */
  updateProfile: (
    userId: string,
    body: {
      primaryDepartmentId?: string | null;
      managerUserId?: string | null;
      jobTitle?: string | null;
      location?: string | null;
      employeeId?: string | null;
    },
  ) =>
    call<{ profile: MemberProfileView }>(`/users/${encodeURIComponent(userId)}/profile`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 部署ツリー (WP-P4-IDM-013)。org_admin のみ。 */
  listDepartments: () => call<{ items: DepartmentNode[] }>('/departments'),

  departmentMembers: (departmentId: string) =>
    call<{ items: DepartmentMemberView[] }>(
      `/departments/${encodeURIComponent(departmentId)}/members`,
    ),

  /** 現在の部署長。未設定は null。 */
  departmentHead: (departmentId: string) =>
    call<{ head: DepartmentHeadView | null }>(
      `/departments/${encodeURIComponent(departmentId)}/head`,
    ),

  createDepartment: (body: { code: string; name: string; parentId?: string | null }) =>
    call<{ department: DepartmentRecord }>('/departments', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  editDepartment: (
    departmentId: string,
    body: { code?: string; name?: string; parentId?: string | null },
  ) =>
    call<{ department: DepartmentRecord }>(
      `/departments/${encodeURIComponent(departmentId)}/edit`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deactivateDepartment: (departmentId: string) =>
    call<{ department: DepartmentRecord }>(
      `/departments/${encodeURIComponent(departmentId)}/deactivate`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  assignDepartmentHead: (departmentId: string, userId: string) =>
    call<{ head: DepartmentHeadView }>(`/departments/${encodeURIComponent(departmentId)}/head`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  endDepartmentHead: (departmentId: string, validUntil: string | null) =>
    call<{ head: DepartmentHeadView }>(
      `/departments/${encodeURIComponent(departmentId)}/head/end`,
      { method: 'POST', body: JSON.stringify({ validUntil }) },
    ),

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

export interface KnowledgeArticle {
  id: string;
  state: 'draft' | 'review' | 'published' | 'retired';
  version: number;
  publishedVersion: number | null;
  contentVersion: number;
  title: string;
  body: string;
  tags: string;
  audience: 'organization' | 'staff';
  versionCreatedAt: string;
}

export interface KnowledgeList {
  items: KnowledgeArticle[];
  total: number;
  previousCursor: string | null;
  nextCursor: string | null;
}

export type {
  CatalogField,
  CatalogSection,
  CatalogValue,
  CatalogValues,
} from '@solvi/shared/catalog';
export interface CatalogQuestionSet {
  id: string;
  revision: number;
  title: string;
  description: string;
  fields: import('@solvi/shared/catalog').CatalogField[];
  sections: import('@solvi/shared/catalog').CatalogSection[];
  updatedAt: string;
}
export interface CatalogAuthoringOptions {
  viewerId?: string;
  owners?: Array<{ id: string; name: string }>;
  groups?: Array<{ id: string; name: string }>;
  questionSets?: CatalogQuestionSet[];
  /** 定義に結び付けられる、同じ組織で有効な承認ルール (WP-P4-APR-016)。 */
  rules?: Array<{ id: string; code: string; name: string; currentRevision: number }>;
  canCreate?: boolean;
  canPublish?: boolean;
  canManageQuestionSets?: boolean;
}
export interface CatalogAdminList extends CatalogAuthoringOptions {
  items: CatalogAdminSummary[];
  approvers: Array<{ id: string; name: string }>;
}
export interface CatalogFulfillment {
  ownerName: string | null;
  groupName: string | null;
  checklistVersion: number;
  checks: Array<{ key: string; label: string; required: boolean; completed: boolean }>;
  canUpdate: boolean;
}
export interface CatalogAdminSummary {
  id: string;
  code: string;
  editVersion: number;
  draftRevision: number;
  publishedRevision: number | null;
  active: boolean;
  title: string;
  description: string;
  ownerName?: string;
  updatedAt?: string;
  readiness?: { ready: boolean; issues: string[]; warnings?: string[] };
}
export interface CatalogAdminDetail extends CatalogAuthoringOptions {
  id: string;
  code: string;
  editVersion: number;
  active: boolean;
  publishedRevision: number | null;
  draft: {
    revision: number;
    title: string;
    description: string;
    definition: CatalogItem['definition'];
  };
  published: {
    revision: number;
    title: string;
    description: string;
    definition: CatalogItem['definition'];
  } | null;
  history: Array<{ revision: number; title: string; createdAt: string }>;
  approvers: Array<{ id: string; name: string }>;
  canEdit?: boolean;
  readiness?: { ready: boolean; issues: string[]; warnings?: string[] };
}
export interface CatalogItem {
  id: string;
  version: number;
  title: string;
  description: string;
  definition: Omit<import('@solvi/shared/catalog').CatalogDefinition, 'action'> & {
    action?: 'simulate.access_grant';
  };
}
export interface ServiceRequestSummary {
  number: string;
  requesterName: string;
  approverName: string;
  updatedAt: string;
  expiresAt: string;
  decisionReason: string | null;
  own: boolean;
  assigned: boolean;
  expired: boolean;
  nextAction: string;
  id: string;
  state: string;
  version: number;
  title: string;
  createdAt: string;
  ticketId: string;
  approvalState: string;
  /** 現在の pending ステップの承認者が有効な所属でない (WP-P4-APR-015 §6.1)。 */
  approverUnavailable?: boolean;
}
export interface ServiceRequestDetail {
  requesterName: string;
  approverName: string;
  fulfillment?: CatalogFulfillment;
  request: {
    id: string;
    state: string;
    version: number;
    revision: number;
    snapshot: {
      item: { id: string; version: number; title: string; definition: CatalogItem['definition'] };
      inputs: {
        reason?: string;
        durationDays?: number;
        values?: import('@solvi/shared/catalog').CatalogValues;
      };
      requesterId: string;
    };
    snapshotHash: string;
    requesterId: string;
    ticketId: string;
  };
  approval: {
    id: string;
    state: string;
    approver_id: string;
    expires_at: string;
    reason: string | null;
  };
  approvers: Array<{ id: string; name: string }>;
  history: Array<{
    id: string;
    state: string;
    revision: number;
    approverId: string;
    approverName: string;
    item: { version: number; definition: CatalogItem['definition'] };
    inputs: {
      reason?: string;
      durationDays?: number;
      values?: import('@solvi/shared/catalog').CatalogValues;
    };
    reason: string | null;
    decidedAt: string | null;
    expiresAt: string;
  }>;
  receipt: {
    id: string;
    simulation: true;
    result: {
      status: string;
      targetLabel: string;
      durationDays?: number;
      externalChanges: number;
      summary: string;
    };
    startedAt: string;
    finishedAt: string;
    idempotencyKey: string;
    snapshotHash: string;
  } | null;
}

export type ApprovalRuleStepView = import('@solvi/shared/catalog').ApprovalRuleStep;

/** 承認ルールの一覧行 (WP-P4-APR-016 段階A)。 */
export interface ApprovalRuleSummary {
  id: string;
  code: string;
  name: string;
  active: boolean;
  currentRevision: number;
  steps: ApprovalRuleStepView[];
  /** 保存済みの steps が共有スキーマで読めるか。false なら内容を推測しない。 */
  stepsValid: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRuleRevisionSummary {
  revision: number;
  steps: ApprovalRuleStepView[];
  stepsValid: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ApprovalRuleSettings {
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ApprovalResolverReason {
  code: string;
  message: string;
  missing: string;
  stepNo?: number;
  authorityType?: string;
}

export interface ApprovalPreviewStep {
  stepNo: number;
  approverId: string;
  approverName: string | null;
  authorityType: string;
  resolvedFrom: string;
}

export interface ApprovalPreviewResult {
  resolved: boolean;
  requesterId: string;
  requesterName: string | null;
  ruleRoutingEnabled: boolean;
  rule: { id: string; code: string; revision: number; active: boolean } | null;
  steps?: ApprovalPreviewStep[];
  routeHash?: string;
  reason?: ApprovalResolverReason;
}

export interface ApprovalUnresolvedResult {
  rule: { id: string; code: string; revision: number; active: boolean };
  scanned: number;
  items: Array<{ userId: string; displayName: string; reason: ApprovalResolverReason }>;
}

export type RelationshipChangeType =
  | 'manager'
  | 'primary_department'
  | 'manager_and_primary_department'
  | 'department_head_assigned'
  | 'department_head_removed';

export interface RelationshipChangeItem {
  eventId: string;
  occurredAt: string;
  changeType: RelationshipChangeType;
  actor: { userId: string | null; displayName: string | null };
  subject: { userId: string | null; displayName: string | null };
  before: unknown;
  after: unknown;
}

export interface RelationshipChangeResult {
  items: RelationshipChangeItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  from: string;
  to: string;
}

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

export interface AssetView {
  id: string;
  assetTag: string;
  name: string;
  kind: string;
  state: string;
  version: number;
  model: string;
  serialNumber: string;
  hostname: string;
  vendor: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
  sourceKind: 'manual' | 'csv';
  createdAt: string;
  updatedAt: string;
  location?: string;
  internalNotes?: string;
}
export interface AssetOptions {
  kinds: Array<{ code: string; label: string; requiredFields: string[] }>;
  states: Array<{ code: string; label: string }>;
  fields: Array<{ key: string; label: string }>;
  members: Array<{ id: string; name: string }>;
}
export interface AssetList {
  items: AssetView[];
  total: number;
  page: number;
  pageSize: number;
  canManage: boolean;
  canReadAll: boolean;
  kinds: AssetOptions['kinds'];
  states: AssetOptions['states'];
}
export interface AssetDetail {
  asset: AssetView;
  canManage: boolean;
  revisions: Array<{
    version: number;
    snapshot: AssetView;
    reason: string;
    createdAt: string;
    actorName: string;
  }>;
  tickets: Array<{ id: string; number: string; subject: string; state: string; version: number }>;
  relationHistory: Array<{
    id: string;
    operation: string;
    reason: string;
    createdAt: string;
    actorName: string;
    ticketId: string;
    number: string;
    subject: string;
  }>;
}
export interface TicketAssets {
  canManage: boolean;
  items: Array<{
    id: string;
    assetTag: string;
    name: string;
    kind: string;
    state: string;
    linkVersion: number;
    canOpen: boolean;
  }>;
  history: Array<{
    id: string;
    operation: string;
    reason: string;
    createdAt: string;
    actorName: string;
    assetId: string;
    assetTag: string;
    name: string;
  }>;
}

export interface AssetCsvInspection {
  headers: string[];
  sample: string[][];
  fields: Array<{ key: string; label: string; required: boolean }>;
}
export interface AssetImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  assets: Array<{ row: number; id: string; version: number }>;
}
export interface AssetImportDetail {
  id: string;
  sourceKey: string;
  contentHash: string;
  planHash: string;
  createdAt: string;
  creatorName: string;
  canManage: boolean;
  plan: {
    headers: string[];
    mapping: Record<string, string>;
    reason: string;
    counts: Record<'add' | 'update' | 'unchanged' | 'error', number>;
    rows: Array<{
      row: number;
      externalId: string;
      assetTag: string;
      operation: 'add' | 'update' | 'unchanged' | 'error';
      assetId: string | null;
      expectedVersion: number | null;
      identityExists: boolean;
      match: 'external_id' | 'asset_tag' | 'new';
      input: Record<string, unknown> | null;
      assignedEmail: string | null;
      issues: string[];
      changes: Array<{ field: string; label: string; before: string | null; after: string | null }>;
    }>;
  };
  receipt: { result: AssetImportResult; appliedAt: string; actorName: string } | null;
}
export interface AssetImportList {
  canManage: boolean;
  items: Array<{
    id: string;
    sourceKey: string;
    createdAt: string;
    appliedAt: string | null;
    counts: AssetImportDetail['plan']['counts'];
  }>;
}

export interface ChangeTarget {
  id: string;
  assetTag: string;
  name: string;
  kind: string;
  state: string;
  version: number;
}
export interface ChangePlan {
  type: 'normal';
  title: string;
  purpose: string;
  impact: string;
  risk: 'low' | 'medium' | 'high';
  implementationPlan: string;
  testPlan: string;
  backoutPlan: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  ticket: { id: string; number: string; subject: string };
  assets: ChangeTarget[];
  owner: { id: string; name: string };
  approver: { id: string; name: string } | null;
}
export interface ChangeSummary {
  id: string;
  number: string;
  title: string;
  type: 'normal';
  state: string;
  version: number;
  revision: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  ownerName: string;
  ticket: ChangePlan['ticket'];
  assets: ChangeTarget[];
  updatedAt: string;
}
export interface ChangeOptions {
  owners: Array<{ id: string; name: string }>;
  approvers: Array<{ id: string; name: string }>;
  assets: ChangeTarget[];
  tickets: Array<ChangePlan['ticket']>;
}
export interface ChangeList {
  items: ChangeSummary[];
  total: number;
  page: number;
  pageSize: number;
  canCreate: boolean;
}
export interface ChangeDetail {
  change: ChangeSummary & {
    snapshot: ChangePlan;
    snapshotHash: string;
    currentApprovalId: string | null;
    createdBy: string;
    startedAt: string | null;
  };
  canManage: boolean;
  availableActions: string[];
  readiness: { issues: string[]; withinWindow: boolean; now: string };
  ticketCanOpen: boolean;
  assetAccess: Array<{ id: string; canOpen: boolean }>;
  result: null | {
    id: string;
    revision: number;
    approvalId: string;
    snapshotHash: string;
    outcome: string;
    summary: string;
    testResults: string;
    backoutPerformed: boolean;
    backoutReason: string;
    simulation: true;
    externalChanges: 0;
    startedAt: string;
    finishedAt: string;
    actorName: string;
  };
  pir: null | {
    id: string;
    rootCause: string;
    lessons: string;
    prevention: string;
    createdAt: string;
    actorName: string;
  };
  conflicts: Array<{
    id: string;
    number: string;
    title: string;
    plannedStart: string;
    plannedEnd: string;
  }>;
  approvals: Array<{
    id: string;
    revision: number;
    snapshotHash: string;
    approverId: string;
    approverName: string;
    expiresAt: string;
    createdAt: string;
    decision: string | null;
    reason: string | null;
    decidedAt: string | null;
    isCurrent: boolean;
  }>;
  revisions: Array<{
    revision: number;
    snapshot: ChangePlan;
    snapshotHash: string;
    reason: string;
    createdAt: string;
    actorName: string;
  }>;
  history: Array<{
    version: number;
    revision: number;
    action: string;
    beforeState: string | null;
    afterState: string;
    reason: string;
    createdAt: string;
    actorName: string;
  }>;
}

export interface InboxItem {
  kind: 'ticket' | 'request_approval' | 'change';
  id: string;
  number: string;
  title: string;
  state: string;
  stateLabel: string;
  scopeLabel: string;
  nextAction: string;
  href: string;
  waiting: boolean;
  eventKey: string;
  updatedAt: string;
  unread: boolean;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  deadline: {
    label: string;
    status: 'none' | 'paused' | 'upcoming' | 'within' | 'overdue';
    at: string | null;
    remainingSeconds: number | null;
  };
}
export interface InboxView {
  items: InboxItem[];
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  asOf: string;
  canIncludeUnassigned: boolean;
  counts: { ticket: number; approval: number; change: number };
  appliedFilter: {
    kind: 'all' | 'ticket' | 'approval' | 'change';
    q: string;
    unread: '0' | '1';
    unassigned: '0' | '1';
    page: number;
  };
}
