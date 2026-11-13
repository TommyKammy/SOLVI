import type { ApprovalRuleStep } from '@solvi/shared/catalog';

/**
 * 承認ルール管理の表示・入力の純関数 (WP-P4-APR-016 段階A)。
 *
 * 画面から送る値はここで既知の形に限定する。ルールの妥当性(同組織・有効な
 * 承認者か)はAPIが毎回再検証する。ここは「押すと必ず失敗する入力を作らない」
 * ための整理であり、認可の判定は行わない。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** 承認段の種別。APIの `authority_type` と同じ語彙だけを扱う。 */
export const AUTHORITY_LABELS: Record<string, string> = {
  fixed: '固定承認者',
  manager: '上長',
  department_head: '部署長',
  legacy: '従来の承認者',
};

export const RESOLVED_FROM_LABELS: Record<string, string> = {
  fixed: '固定承認者',
  requester_selected: '申請者が選択',
  manager: '申請者の上長',
  'manager>department_head': '上長が解決できないため部署長',
  'department_head:self': '主部署の部署長',
  'department_head:ancestor': '上位部署の部署長',
};

export const MISSING_LABELS: Record<string, string> = {
  requester: '申請者の所属',
  rule: '承認ルール',
  fixed_approver: '固定承認者',
  manager: '上長',
  department_head: '部署長',
  selected_approver: '承認者',
  duplicate: '重複しない承認者',
};

export function authorityLabel(value: string | null | undefined): string {
  return (value && AUTHORITY_LABELS[value]) || '種別を確認できません';
}

export function resolvedFromLabel(value: string | null | undefined): string {
  return (value && RESOLVED_FROM_LABELS[value]) || '解決方法を確認できません';
}

export function missingLabel(value: unknown): string | null {
  return typeof value === 'string' && MISSING_LABELS[value] ? MISSING_LABELS[value] : null;
}

export function stepLabel(step: ApprovalRuleStep): string {
  if (step.type === 'fixed') return '固定承認者';
  if (step.type === 'manager')
    return step.onUnresolved === 'department_head'
      ? '上長（未解決時は部署長へ）'
      : '上長（未解決時は拒否）';
  return '部署長';
}

/** 一覧に出す段の要約。壊れた保存内容は内容を推測せず「確認できません」と出す。 */
export function summarizeApprovalSteps(steps: readonly ApprovalRuleStep[], valid = true): string {
  if (!valid) return '内容を確認できません';
  if (steps.length === 0) return '段がありません';
  return steps.map(stepLabel).join(' → ');
}

export interface StepDraftInput {
  type?: unknown;
  approverId?: unknown;
  onUnresolved?: unknown;
}

export type StepsParseResult =
  { ok: true; steps: ApprovalRuleStep[] } | { ok: false; message: string };

/**
 * 画面の段入力を共有スキーマの形へ変換する。
 *
 * 空の段は末尾だけ許す(途中に空があると、どの段が抜けたのか分からない)。
 * 固定承認者は選択式だが、改ざんされたIDもここでは形式だけを見て、
 * 同組織・有効・`approver` ロールの検証はAPIに任せる。
 */
export function parseApprovalRuleSteps(rows: readonly StepDraftInput[]): StepsParseResult {
  if (rows.length > 3) return { ok: false, message: '承認ステップは3段以内にしてください。' };
  const steps: ApprovalRuleStep[] = [];
  let blankSeen = false;
  for (const [index, row] of rows.entries()) {
    const type = typeof row.type === 'string' ? row.type.trim() : '';
    if (!type) {
      blankSeen = true;
      continue;
    }
    if (blankSeen)
      return {
        ok: false,
        message: '承認ステップは前の段から順に選んでください。空の段は末尾だけにできます。',
      };
    const stepNo = index + 1;
    if (type === 'fixed') {
      const approverId = typeof row.approverId === 'string' ? row.approverId.trim() : '';
      if (!isUuid(approverId))
        return { ok: false, message: `段${stepNo}の固定承認者を選んでください。` };
      steps.push({ type: 'fixed', approverId });
    } else if (type === 'manager') {
      const onUnresolved =
        typeof row.onUnresolved === 'string' ? row.onUnresolved.trim() : 'reject';
      if (onUnresolved !== 'department_head' && onUnresolved !== 'reject')
        return {
          ok: false,
          message: `段${stepNo}の上長を解決できない場合の扱いを選んでください。`,
        };
      steps.push({ type: 'manager', onUnresolved });
    } else if (type === 'department_head') {
      steps.push({ type: 'department_head', onUnresolved: 'reject' });
    } else {
      return { ok: false, message: `段${stepNo}の種別を選んでください。` };
    }
  }
  if (steps.length === 0) return { ok: false, message: '承認ステップを1段以上設定してください。' };
  return { ok: true, steps };
}

/** 経路プレビューが返す解決不能の理由。APIの日本語の文をそのまま使う。 */
export function resolverReasonText(reason: unknown): string {
  if (reason === null || typeof reason !== 'object') return '経路を解決できませんでした。';
  const value = reason as { message?: unknown; missing?: unknown; stepNo?: unknown };
  const message =
    typeof value.message === 'string' && value.message.trim()
      ? value.message.trim()
      : '経路を解決できませんでした。';
  const stepNo =
    typeof value.stepNo === 'number' && Number.isInteger(value.stepNo) && value.stepNo > 0
      ? value.stepNo
      : null;
  const missing = missingLabel(value.missing);
  const step = stepNo === null ? '' : `段${stepNo}: `;
  return `${step}${message}${missing ? `（足りない設定: ${missing}）` : ''}`;
}

/* ------------------------------------------------------------------ */
/* 承認ルール管理画面のURLと状態                                       */
/* ------------------------------------------------------------------ */

export type ApprovalConfirm = 'deactivate' | 'enable-routing' | 'disable-routing';

export interface ApprovalQuery {
  /** 選択中のルール。未選択は空文字。 */
  rule: string;
  /** 取り消せない操作の確認画面。 */
  confirm: ApprovalConfirm | null;
  /** 解決できない人の一覧を開いているか。 */
  unresolved: boolean;
}

export interface ApprovalPreviewQuery {
  kind: '' | 'rule' | 'item';
  ruleId: string;
  itemId: string;
  requesterId: string;
}

export interface ApprovalsParseResult {
  query: ApprovalQuery;
  preview: ApprovalPreviewQuery;
}

export const APPROVAL_NOTICES = [
  'created',
  'revised',
  'deactivated',
  'routing-enabled',
  'routing-disabled',
] as const;

export type ApprovalNotice = (typeof APPROVAL_NOTICES)[number];

export function approvalNoticeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const notices: Record<ApprovalNotice, string> = {
    created: '承認ルールを作成しました。',
    revised: '承認ルールの新しい版を追加しました。保存済みの版は変わりません。',
    deactivated: '承認ルールを無効化しました。この操作は取り消せません。',
    'routing-enabled': '組織で承認ルールを使う設定にしました。',
    'routing-disabled': '組織で承認ルールを使わない設定に戻しました。',
  };
  return Object.hasOwn(notices, value) ? notices[value as ApprovalNotice] : null;
}

export function parseApprovalsQuery(
  params: Record<string, string | string[] | undefined>,
): ApprovalsParseResult {
  const single = (value: string | string[] | undefined): string =>
    typeof value === 'string' ? value : '';
  const confirmRaw = single(params.confirm);
  const confirm: ApprovalConfirm | null =
    confirmRaw === 'deactivate' ||
    confirmRaw === 'enable-routing' ||
    confirmRaw === 'disable-routing'
      ? confirmRaw
      : null;
  const kindRaw = single(params.previewKind);
  const kind: ApprovalPreviewQuery['kind'] =
    kindRaw === 'rule' || kindRaw === 'item' ? kindRaw : '';
  const rule = single(params.rule);
  const previewRuleId = single(params.previewRuleId);
  const previewItemId = single(params.previewItemId);
  const previewRequesterId = single(params.previewRequesterId);
  return {
    query: {
      rule: isUuid(rule) ? rule.toLowerCase() : '',
      confirm,
      unresolved: single(params.unresolved) === '1',
    },
    preview: {
      kind,
      ruleId: isUuid(previewRuleId) ? previewRuleId.toLowerCase() : '',
      itemId: isUuid(previewItemId) ? previewItemId.toLowerCase() : '',
      requesterId: isUuid(previewRequesterId) ? previewRequesterId.toLowerCase() : '',
    },
  };
}

export interface ApprovalHrefOverrides {
  rule?: string | null;
  confirm?: ApprovalConfirm | null;
  unresolved?: boolean;
  notice?: ApprovalNotice | null;
  /** APIが返した日本語の理由。個人データは含めない。 */
  error?: string | null;
}

function safeError(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

/** 内部の固定した行き先だけを組み立てる。任意の戻り先URLは受け取らない。 */
export function approvalHref(query: ApprovalQuery, overrides: ApprovalHrefOverrides = {}): string {
  const nextRule =
    typeof overrides.rule === 'string' && isUuid(overrides.rule)
      ? overrides.rule.toLowerCase()
      : overrides.rule === null || overrides.rule === ''
        ? ''
        : query.rule;
  const nextConfirm =
    overrides.confirm !== undefined
      ? overrides.confirm
      : nextRule === query.rule
        ? query.confirm
        : null;
  const nextUnresolved =
    overrides.unresolved !== undefined
      ? overrides.unresolved
      : nextRule === query.rule && nextConfirm === query.confirm
        ? query.unresolved
        : false;
  const params = new URLSearchParams();
  if (nextRule) params.set('rule', nextRule);
  if (nextConfirm) params.set('confirm', nextConfirm);
  if (nextUnresolved) params.set('unresolved', '1');
  if (overrides.notice && (APPROVAL_NOTICES as readonly string[]).includes(overrides.notice))
    params.set('notice', overrides.notice);
  const error = safeError(overrides.error);
  if (error) params.set('error', error);
  const search = params.toString();
  return search ? `/ops/approvals?${search}` : '/ops/approvals';
}

/* ------------------------------------------------------------------ */
/* 上長・部署長の変更履歴                                              */
/* ------------------------------------------------------------------ */

export const RELATIONSHIP_CHANGE_LABELS: Record<string, string> = {
  manager: '上長',
  primary_department: '主部署',
  manager_and_primary_department: '上長と主部署',
  department_head_assigned: '部署長の設定',
  department_head_removed: '部署長の終了',
};

export function relationshipChangeLabel(value: string): string {
  return RELATIONSHIP_CHANGE_LABELS[value] ?? '種類を確認できません';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dateOnly(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1]! : raw;
}

/**
 * 変更前後の表示。APIが返した項目だけを使い、社員番号・役職・勤務地は扱わない。
 * 値が無い場合は「未設定」「なし」と明示する(空欄にしない)。
 */
export function formatRelationshipChangeSide(changeType: string, value: unknown): string[] {
  if (changeType === 'department_head_assigned' || changeType === 'department_head_removed') {
    if (value === null || value === undefined) return ['なし'];
    const state = record(value);
    const parts: string[] = [];
    const department = text(state.departmentName);
    const head = text(state.headDisplayName);
    const from = dateOnly(state.validFrom);
    const until = dateOnly(state.validUntil);
    if (department) parts.push(`部署: ${department}`);
    if (head) parts.push(`部署長: ${head}`);
    if (from) parts.push(`開始: ${from}`);
    if (until) parts.push(`終了: ${until}`);
    return parts.length > 0 ? parts : ['内容を確認できません'];
  }
  const state = record(value);
  return [
    `上長: ${text(state.managerDisplayName) ?? '未設定'}`,
    `主部署: ${text(state.primaryDepartmentName) ?? '未設定'}`,
  ];
}

export const HISTORY_PERIOD_DAYS = 30;

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export interface RelationshipHistoryQuery {
  from: string;
  to: string;
  page: number;
}

/** 期間の初期値は直近30日。不正な値はAPIへ送らずに初期値へ戻す。 */
export function parseRelationshipHistoryQuery(
  params: Record<string, string | string[] | undefined>,
  today: string,
): RelationshipHistoryQuery {
  const single = (value: string | string[] | undefined): string =>
    typeof value === 'string' ? value : '';
  const todayValue = isDate(today) ? today : new Date().toISOString().slice(0, 10);
  const to = isDate(single(params.to)) ? single(params.to) : todayValue;
  const fromRaw = single(params.from);
  const fromDefault = new Date(Date.parse(`${todayValue}T00:00:00.000Z`));
  fromDefault.setUTCDate(fromDefault.getUTCDate() - (HISTORY_PERIOD_DAYS - 1));
  const from = isDate(fromRaw) ? fromRaw : fromDefault.toISOString().slice(0, 10);
  const pageRaw = single(params.page);
  const pageNumber = Number(pageRaw);
  const page =
    Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 10_000 ? pageNumber : 1;
  return { from, to, page };
}

export function relationshipHistoryHref(
  query: RelationshipHistoryQuery,
  overrides: Partial<RelationshipHistoryQuery> = {},
): string {
  const next = { ...query, ...overrides };
  const params = new URLSearchParams();
  params.set('from', next.from);
  params.set('to', next.to);
  if (next.page !== 1) params.set('page', String(next.page));
  return `/ops/approvals/changes?${params.toString()}`;
}
