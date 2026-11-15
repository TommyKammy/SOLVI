import { approvalRuleStepsSchema } from '@solvi/shared/catalog';
import { AUTHORITY_TYPES } from './approval-state.js';

/**
 * 高リスク申請の承認条件の判定 (WP-P4-APR-021 §6.2 / ADR-0024 §4・§5 / ADR-0026)。
 *
 * ## 判定はこの1か所だけ
 *
 * 高リスクかどうかは、カタログ定義の版属性 `approval.highRisk` で決まる。
 * 「高リスクなのに条件を満たしているか」の判定は**このファイルの3つの純粋関数だけ**に置き、
 * 公開・ルールの版の追加・ルールの無効化・ルールの使用の停止・申請・申請内容の変更・
 * 再割当・実行前検証がそれぞれ書き直さない。
 *
 *   - `evaluateHighRiskDefinition`: 定義とルールの段から判定する(公開・ルール/設定の変更)。
 *   - `checkHighRiskRoute`: 解決した経路から判定する(申請・申請内容の変更・再割当)。
 *   - `checkHighRiskApprovals`: 承認済みのステップから判定する(実行前検証)。
 *
 * ## fail closed
 *
 * 属性が読めない・型が違う場合は「高リスクではない」とみなさず、拒否する。
 * 属性が**無い**場合だけは「高リスクではない」として受理する(旧版・過去の申請を
 * 補完しない。ADR-0024 §4)。真偽値の `true` のときだけ高リスクである。
 *
 * ## 判定の内容(ADR-0024 §5)
 *
 * 1. 定義が `approval.ruleId` を持ち、組織でルールの使用が有効で、ルールが有効であること。
 * 2. ルールの段のうち `fixed` が2つ以上あり、その承認者が互いに別人であること。
 * 3. 解決した経路に `authorityType = 'fixed'` の段が2つ以上あり、承認者が互いに別人で、
 *    どれも申請者でないこと。
 * 4. 承認済みの `fixed` の段が2つ以上あり、決定者(`decided_by`)が互いに別人で、
 *    代理による決定が無いこと。
 */

export const HIGH_RISK_ATTRIBUTES = ['true', 'false', 'missing', 'invalid'] as const;
export type HighRiskAttribute = (typeof HIGH_RISK_ATTRIBUTES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 定義の `approval`(版の JSON)から高リスクの属性を読む。
 *
 * - `approval` が無い(`undefined` / `null`)場合は `missing`(高リスクではない)。
 * - `approval` がオブジェクトでない場合は `invalid`。
 * - `highRisk` が無い場合は `missing`、真偽値なら `true` / `false`、それ以外は `invalid`。
 */
export function readHighRiskAttribute(approval: unknown): HighRiskAttribute {
  if (approval === null || approval === undefined) return 'missing';
  if (!isObject(approval)) return 'invalid';
  if (!Object.prototype.hasOwnProperty.call(approval, 'highRisk')) return 'missing';
  const value = approval.highRisk;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'invalid';
}

/** 定義とルールの段から判定した結果の失敗。文言へは呼び出し側で対応付ける。 */
export type HighRiskDefinitionFailure =
  | 'attribute_invalid'
  | 'rule_missing'
  | 'rule_routing_disabled'
  | 'rule_unavailable'
  | 'fixed_approvers_insufficient'
  | 'fixed_approvers_duplicate';

export type HighRiskDefinitionEvaluation =
  | { highRisk: false }
  | { highRisk: true; ok: true; fixedApproverIds: string[] }
  | { highRisk: true; ok: false; code: HighRiskDefinitionFailure };

/**
 * 定義とルールの段から条件を判定する(公開時・ルール/設定の変更時)。
 *
 * `rule` は**判定に使う段**を渡す(版の追加なら新しい段、無効化なら現在の段と
 * `active: false`)。`rule.steps` は保存された JSON をそのまま渡してよい(ここで検証する)。
 */
export function evaluateHighRiskDefinition(input: {
  approval: unknown;
  ruleRoutingEnabled: unknown;
  rule: { active: unknown; steps: unknown } | null;
}): HighRiskDefinitionEvaluation {
  const attribute = readHighRiskAttribute(input.approval);
  if (attribute === 'invalid') return { highRisk: true, ok: false, code: 'attribute_invalid' };
  if (attribute !== 'true') return { highRisk: false };

  const approval = input.approval as Record<string, unknown>;
  if (typeof approval.ruleId !== 'string' || approval.ruleId.length === 0)
    return { highRisk: true, ok: false, code: 'rule_missing' };
  if (input.ruleRoutingEnabled !== true)
    return { highRisk: true, ok: false, code: 'rule_routing_disabled' };
  if (!input.rule || input.rule.active !== true)
    return { highRisk: true, ok: false, code: 'rule_unavailable' };

  const parsed = approvalRuleStepsSchema.safeParse(input.rule.steps);
  if (!parsed.success) return { highRisk: true, ok: false, code: 'rule_unavailable' };
  const fixedApproverIds: string[] = [];
  for (const step of parsed.data)
    if (step.type === 'fixed') fixedApproverIds.push(step.approverId);
  if (fixedApproverIds.length < 2)
    return { highRisk: true, ok: false, code: 'fixed_approvers_insufficient' };
  if (new Set(fixedApproverIds).size !== fixedApproverIds.length)
    return { highRisk: true, ok: false, code: 'fixed_approvers_duplicate' };
  return { highRisk: true, ok: true, fixedApproverIds };
}

/** 解決した経路から判定した結果の失敗。 */
export type HighRiskRouteFailure =
  | 'route_missing'
  | 'route_invalid'
  | 'fixed_approvers_insufficient'
  | 'fixed_approvers_duplicate'
  | 'requester_is_approver';

export type HighRiskRouteEvaluation = { ok: true } | { ok: false; code: HighRiskRouteFailure };

type ParsedRouteStep = { stepNo: number; approverId: string; authorityType: string };

/** 経路の JSON を、判定に必要な形だけ検証して読む。読めなければ null。 */
function parseRouteSteps(route: unknown): { steps: ParsedRouteStep[] } | null {
  if (!isObject(route)) return null;
  const steps = route.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 3) return null;
  const parsed: ParsedRouteStep[] = [];
  for (const [index, raw] of steps.entries()) {
    if (!isObject(raw)) return null;
    if (raw.stepNo !== index + 1) return null;
    if (typeof raw.approverId !== 'string' || !UUID.test(raw.approverId)) return null;
    if (
      typeof raw.authorityType !== 'string' ||
      !(AUTHORITY_TYPES as readonly string[]).includes(raw.authorityType)
    )
      return null;
    parsed.push({
      stepNo: raw.stepNo,
      approverId: raw.approverId,
      authorityType: raw.authorityType,
    });
  }
  return { steps: parsed };
}

/**
 * 解決した経路から条件を判定する(申請・申請内容の変更・再割当)。
 * **高リスクの申請にだけ呼ぶ。** `route` が null(移行前の版)は拒否する。
 */
export function checkHighRiskRoute(input: {
  route: unknown;
  requesterId: unknown;
}): HighRiskRouteEvaluation {
  if (input.route === null || input.route === undefined)
    return { ok: false, code: 'route_missing' };
  const route = parseRouteSteps(input.route);
  if (!route) return { ok: false, code: 'route_invalid' };
  if (typeof input.requesterId !== 'string' || !UUID.test(input.requesterId))
    return { ok: false, code: 'route_invalid' };
  const fixed = route.steps.filter((step) => step.authorityType === 'fixed');
  if (fixed.length < 2) return { ok: false, code: 'fixed_approvers_insufficient' };
  const approvers = fixed.map((step) => step.approverId);
  if (new Set(approvers).size !== approvers.length)
    return { ok: false, code: 'fixed_approvers_duplicate' };
  if (approvers.includes(input.requesterId)) return { ok: false, code: 'requester_is_approver' };
  return { ok: true };
}

/** 承認済みのステップから判定した結果の失敗。 */
export type HighRiskApprovalFailure =
  | 'unreadable'
  | 'delegated_decision'
  | 'insufficient_approvers';

export type HighRiskApprovalEvaluation = { ok: true } | { ok: false; code: HighRiskApprovalFailure };

/**
 * 承認済みのステップから条件を判定する(実行前検証)。
 *
 * `steps` は現在の版の**有効な世代**の行(`stepNo` / `approverId` / `state` / `decidedBy`)。
 * `decidedBy` が null の行は承認者本人が決定したものとして扱う(ADR-0025 §4)。
 * 値が読めない・型が違う場合は `unreadable` で失敗する。
 */
export function checkHighRiskApprovals(input: {
  route: unknown;
  requesterId: unknown;
  steps: unknown;
}): HighRiskApprovalEvaluation {
  if (input.route === null || input.route === undefined) return { ok: false, code: 'unreadable' };
  const route = parseRouteSteps(input.route);
  if (!route) return { ok: false, code: 'unreadable' };
  if (typeof input.requesterId !== 'string' || !UUID.test(input.requesterId))
    return { ok: false, code: 'unreadable' };
  if (!Array.isArray(input.steps)) return { ok: false, code: 'unreadable' };

  const rows = new Map<
    number,
    { approverId: string; state: string; decidedBy: string }
  >();
  for (const raw of input.steps) {
    if (!isObject(raw)) return { ok: false, code: 'unreadable' };
    const stepNo = raw.stepNo;
    if (!Number.isInteger(stepNo) || (stepNo as number) < 1 || (stepNo as number) > 3)
      return { ok: false, code: 'unreadable' };
    if (typeof raw.approverId !== 'string' || !UUID.test(raw.approverId))
      return { ok: false, code: 'unreadable' };
    if (typeof raw.state !== 'string') return { ok: false, code: 'unreadable' };
    let decidedBy: string;
    if (raw.decidedBy === null || raw.decidedBy === undefined) decidedBy = raw.approverId;
    else if (typeof raw.decidedBy === 'string' && UUID.test(raw.decidedBy)) decidedBy = raw.decidedBy;
    else return { ok: false, code: 'unreadable' };
    if (rows.has(stepNo as number)) return { ok: false, code: 'unreadable' };
    rows.set(stepNo as number, { approverId: raw.approverId, state: raw.state, decidedBy });
  }

  const deciders = new Set<string>();
  let approvedFixed = 0;
  let delegated = false;
  for (const step of route.steps) {
    const row = rows.get(step.stepNo);
    if (!row || row.state !== 'approved') continue;
    // 経路の承認者と承認行の承認者が食い違う記録は読めないものとして扱う(fail closed)。
    if (row.approverId !== step.approverId) return { ok: false, code: 'unreadable' };
    // 代理による決定は、段の種別によらず認めない(ADR-0026 §1。関係ベースの段も含む)。
    if (row.decidedBy !== row.approverId) delegated = true;
    if (step.authorityType !== 'fixed') continue;
    approvedFixed += 1;
    deciders.add(row.decidedBy);
  }
  if (delegated) return { ok: false, code: 'delegated_decision' };
  if (approvedFixed < 2 || deciders.size < 2)
    return { ok: false, code: 'insufficient_approvers' };
  return { ok: true };
}

/**
 * 委任による可視性から高リスクの申請を除く SQL 述語(一覧・受信箱)。
 *
 * 申請の `snapshot` を指す固定のSQL式を受け取る(利用者入力を連結しない)。
 * 属性が**無い**か**偽**のときだけ真。属性の親がオブジェクトでない場合や、
 * 存在して真偽値でない値は高リスクとして扱う(fail closed。画面側の判定に頼らない)。
 */
export function definitelyNotHighRiskSql(snapshot: string): string {
  const approval = `(${snapshot}->'item'->'definition'->'approval')`;
  return `(${approval} IS NULL
    OR (jsonb_typeof(${approval}) = 'object' AND NOT (${approval} ? 'highRisk'))
    OR ${approval}->'highRisk' = 'false'::jsonb)`;
}
