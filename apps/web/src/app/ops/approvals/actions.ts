'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, type ProblemDetails } from '../../../lib/api';
import { isOrgAdmin } from '../../../lib/navigation';
import {
  approvalHref,
  isUuid,
  parseApprovalRuleSteps,
  reassignmentFailureText,
  type ApprovalQuery,
  type StepDraftInput,
} from '../../../lib/approval-route';
import type { FormFeedback } from '../../../lib/form-state';

type Scope = { userId: string; organizationId: string | null };

/** APIの日本語の理由だけを画面へ返す。内部の例外文・スタックは使わない。 */
function problemMessage(problem: ProblemDetails): string {
  if (problem.status === 401) {
    return 'ログインの有効期限が切れました。別のタブでログインしてから再度お試しください。';
  }
  if (problem.status === 403) {
    return 'この操作を行う権限がありません。組織の管理者へご連絡ください。';
  }
  if (problem.status >= 500) {
    return '操作できませんでした。時間をおいて、もう一度お試しください。';
  }
  return (
    problem.errors?.[0]?.message ??
    problem.detail ??
    problem.title ??
    '操作できませんでした。入力内容を確認してください。'
  ).slice(0, 500);
}

function back(query: ApprovalQuery, message: string, ruleId?: string): never {
  redirect(
    approvalHref(query, {
      rule: ruleId ?? (query.rule || null),
      confirm: null,
      error: message,
    }),
  );
}

/**
 * 操作のたびに、アカウント・組織・権限を確認し直す。
 * 画面を出した時点の権限を信じない(AGENTS §1.4 と同じ考え方)。
 */
async function approvalAdminError(
  scope: Scope,
  failureText: (problem: ProblemDetails) => string = problemMessage,
): Promise<string | null> {
  const authentication = await api.me();
  if (!authentication.ok) return failureText(authentication.problem);
  const session = authentication.data;
  if (session.userId !== scope.userId || session.organizationId !== scope.organizationId) {
    return '操作中のアカウントまたは組織が変わりました。画面を開き直してください。';
  }
  if (!isOrgAdmin(session)) {
    return 'この操作を行う権限がありません。組織の管理者へご連絡ください。';
  }
  return null;
}

async function requireApprovalAdmin(scope: Scope, query: ApprovalQuery): Promise<void> {
  const error = await approvalAdminError(scope);
  if (error) back(query, error);
}

function read(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function stepRows(formData: FormData): StepDraftInput[] {
  return [0, 1, 2].map((index) => ({
    type: read(formData, `steps.${index}.type`),
    approverId: read(formData, `steps.${index}.approverId`),
    onUnresolved: read(formData, `steps.${index}.onUnresolved`),
  }));
}

function refreshApprovals(): void {
  revalidatePath('/ops/approvals');
  revalidatePath('/catalog/manage');
}

export async function createApprovalRuleAction(
  scope: Scope,
  query: ApprovalQuery,
  formData: FormData,
): Promise<void> {
  await requireApprovalAdmin(scope, query);
  const parsed = parseApprovalRuleSteps(stepRows(formData));
  if (!parsed.ok) back(query, parsed.message);
  const result = await api.createApprovalRule({
    code: read(formData, 'code'),
    name: read(formData, 'name'),
    steps: parsed.steps,
  });
  if (!result.ok) back(query, problemMessage(result.problem));
  refreshApprovals();
  redirect(
    approvalHref(
      { rule: result.data.rule.id, confirm: null, unresolved: false },
      { notice: 'created' },
    ),
  );
}

export async function reviseApprovalRuleAction(
  scope: Scope,
  query: ApprovalQuery,
  ruleId: string,
  formData: FormData,
): Promise<void> {
  if (!isUuid(ruleId)) back(query, '対象の承認ルールを一覧から選び直してください。');
  await requireApprovalAdmin(scope, query);
  const expectedRevision = Number(read(formData, 'expectedRevision'));
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    back(query, '変更する版を一覧から選び直してください。', ruleId);
  }
  const parsed = parseApprovalRuleSteps(stepRows(formData));
  if (!parsed.ok) back(query, parsed.message, ruleId);
  const result = await api.reviseApprovalRule(ruleId, {
    expectedRevision,
    steps: parsed.steps,
    ...(read(formData, 'name').trim() ? { name: read(formData, 'name').trim() } : {}),
  });
  if (!result.ok) back(query, problemMessage(result.problem), ruleId);
  refreshApprovals();
  redirect(approvalHref({ rule: ruleId, confirm: null, unresolved: false }, { notice: 'revised' }));
}

export async function deactivateApprovalRuleAction(
  scope: Scope,
  query: ApprovalQuery,
  ruleId: string,
): Promise<void> {
  if (!isUuid(ruleId)) back(query, '対象の承認ルールを一覧から選び直してください。');
  await requireApprovalAdmin(scope, query);
  const result = await api.deactivateApprovalRule(ruleId);
  if (!result.ok) back(query, problemMessage(result.problem), ruleId);
  refreshApprovals();
  redirect(
    approvalHref({ rule: ruleId, confirm: null, unresolved: false }, { notice: 'deactivated' }),
  );
}

export async function updateApprovalRoutingAction(
  scope: Scope,
  query: ApprovalQuery,
  enabled: boolean,
): Promise<void> {
  await requireApprovalAdmin(scope, query);
  const result = await api.updateApprovalRouting(enabled);
  if (!result.ok) back(query, problemMessage(result.problem));
  refreshApprovals();
  redirect(
    approvalHref(query, {
      confirm: null,
      notice: enabled ? 'routing-enabled' : 'routing-disabled',
    }),
  );
}

/**
 * 承認者不在の申請の再割当 (WP-P4-APR-018 §6-6)。
 *
 * 入力は理由と確認だけである。承認者・段・経路は送らず、APIが現在の組織データから
 * 決め直す。結果は同じ画面に表示する(遷移して一覧を失わせない)。
 */
export async function reassignApprovalAction(
  scope: Scope,
  requestId: string,
  previous: FormFeedback,
  formData: FormData,
): Promise<FormFeedback> {
  const attempt = (previous.attempt ?? 0) + 1;
  if (!isUuid(requestId)) return { message: '対象の申請を一覧から選び直してください。', attempt };
  const error = await approvalAdminError(scope, reassignmentFailureText);
  if (error) return { message: error, attempt };
  const reason = read(formData, 'reason').trim();
  if (!reason) return { message: '再割当の理由を入力してください。', attempt };
  if (reason.length > 2000)
    return { message: '再割当の理由は2000文字以内で入力してください。', attempt };
  if (read(formData, 'confirm') !== '1')
    return { message: '再割当を実行するには、確認の欄にチェックを入れてください。', attempt };
  const result = await api.reassignRequest(requestId, { reason });
  if (!result.ok) return { message: reassignmentFailureText(result.problem), attempt };
  // 成功すると一覧の行は最新の状態で消える(承認者が有効になったため)。
  // 成功の文(段・新しい承認者・日時)は、申請IDをURLに残して同じ画面で詳細を
  // 読み直して出す。再割当の記録が無い場合は出さない。表示名をURLへ載せない。
  // 個人データを履歴・ログに残さないためである。
  redirect(
    approvalHref(
      { rule: '', confirm: null, unresolved: false },
      { reassigned: requestId },
    ) + '#approval-unavailable',
  );
}
