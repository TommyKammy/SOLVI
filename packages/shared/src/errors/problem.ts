/**
 * エラー表現は RFC 9457 (Problem Details) に統一する(ADR-0017)。
 *
 * 存在秘匿の方針: 権限がないリソースは 403 ではなく 404 を返す(NFR-SEC-006)。
 * 403 を返すと「そのIDのリソースは存在する」ことを教えてしまうため。
 */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  correlationId?: string;
  /** 入力検証エラーの内訳。値そのものは含めない。 */
  errors?: Array<{ field: string; message: string }>;
}

const TYPE_BASE = 'https://solvi.internal/problems';

export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly errors?: Array<{ field: string; message: string }>;

  constructor(params: {
    status: number;
    type: string;
    title: string;
    detail?: string;
    errors?: Array<{ field: string; message: string }>;
  }) {
    super(params.detail ?? params.title);
    this.name = 'ProblemError';
    this.status = params.status;
    this.type = params.type;
    this.title = params.title;
    if (params.errors) this.errors = params.errors;
  }

  toProblemDetails(correlationId?: string, instance?: string): ProblemDetails {
    const problem: ProblemDetails = { type: this.type, title: this.title, status: this.status };
    if (this.message && this.message !== this.title) problem.detail = this.message;
    if (instance) problem.instance = instance;
    if (correlationId) problem.correlationId = correlationId;
    if (this.errors) problem.errors = this.errors;
    return problem;
  }
}

export const Problems = {
  validation: (errors: Array<{ field: string; message: string }>) =>
    new ProblemError({
      status: 400,
      type: `${TYPE_BASE}/validation-failed`,
      title: '入力内容を確認してください',
      errors,
    }),

  unauthenticated: () =>
    new ProblemError({
      status: 401,
      type: `${TYPE_BASE}/unauthenticated`,
      title: 'ログインが必要です',
    }),

  /**
   * 権限不足。**リソースの所在を秘匿する場合は notFound() を使う。**
   * forbidden() は「対象の存在は明らかだが操作が許されない」場合に限る
   * (例: 自分の申請を自分で承認しようとした)。
   */
  forbidden: (detail?: string) =>
    new ProblemError({
      status: 403,
      type: `${TYPE_BASE}/forbidden`,
      title: 'この操作は許可されていません',
      ...(detail ? { detail } : {}),
    }),

  notFound: (resource = 'リソース') =>
    new ProblemError({
      status: 404,
      type: `${TYPE_BASE}/not-found`,
      title: `${resource}が見つかりません`,
    }),

  conflict: (detail: string) =>
    new ProblemError({
      status: 409,
      type: `${TYPE_BASE}/conflict`,
      title: '競合が発生しました',
      detail,
    }),

  invalidTransition: (from: string, to: string) =>
    new ProblemError({
      status: 422,
      type: `${TYPE_BASE}/invalid-state-transition`,
      title: 'この状態変更はできません',
      detail: `${from} から ${to} への遷移は許可されていません`,
    }),

  internal: () =>
    new ProblemError({
      status: 500,
      type: `${TYPE_BASE}/internal-error`,
      title: '処理に失敗しました',
    }),

  serviceUnavailable: (detail?: string) =>
    new ProblemError({
      status: 503,
      type: `${TYPE_BASE}/service-unavailable`,
      title: '一時的に利用できません',
      ...(detail ? { detail } : {}),
    }),
} as const;
