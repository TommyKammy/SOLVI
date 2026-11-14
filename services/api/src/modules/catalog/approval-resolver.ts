import type pg from 'pg';
import { ProblemError, Problems } from '@solvi/shared';
import { approvalRuleStepsSchema, type ApprovalRuleStep } from '@solvi/shared/catalog';
import {
  routeHash,
  type ApprovalRoute,
  type ApprovalRouteStep,
  type AuthorityType,
} from './approval-state.js';

/**
 * 承認者の解決 (WP-P4-APR-015 段階A / ADR-0023 §1・§9 / WP §6.1)。
 *
 * ## 決定性
 *
 * 解決ロジック(`resolveApprovalRoute`)は純粋関数である。現在時刻・乱数・DBを内部で読まない。
 * DBから事実を読む部分(`resolveRouteForRequest` / `resolveRouteForRule`)が `now` を受け取り、
 * その時刻で有効な所属・部署長だけをスナップショットへ入れる。
 *
 * ## 有効な所属の定義は1か所
 *
 * `isActiveMember` / `activeMembershipSql` が ADR-0023 §1 の定義を持つ。
 * リゾルバ・ルール保存時の検証・プレビュー・解決不能一覧はすべてこれを使う。
 * `org_member_profile` 行の存在は所属の証明にしない。
 *
 * ## 黙って現行互換へ落とさない
 *
 * 組織で有効化されていて定義に `ruleId` がある版は、ルールで解決する。
 * ルールが無効・他組織・存在しない・内容不正なら失敗を返す。固定承認者や
 * 申請者が選んだ承認者で代用しない(明示された `onUnresolved` の部署長移行だけが例外)。
 */

export type ResolverFailureCode =
  | 'requester_not_active_member'
  | 'rule_unavailable'
  | 'rule_invalid'
  | 'fixed_approver_invalid'
  | 'fixed_approver_self'
  | 'manager_unset'
  | 'manager_inactive'
  | 'manager_self'
  | 'department_head_missing'
  | 'duplicate_approver'
  | 'requester_selected_missing'
  | 'requester_selected_invalid'
  | 'requester_selected_self'
  | 'approver_self';

export type ResolverMissing =
  | 'requester'
  | 'rule'
  | 'fixed_approver'
  | 'manager'
  | 'department_head'
  | 'selected_approver'
  | 'duplicate';

export type ResolverFailure = {
  code: ResolverFailureCode;
  /** 利用者にそのまま示せる理由。氏名・社員番号などの個人データは含めない。 */
  message: string;
  missing: ResolverMissing;
  stepNo?: number;
  authorityType?: AuthorityType;
};

export type ResolverResult =
  { ok: true; route: ApprovalRoute; routeHash: string } | { ok: false; reason: ResolverFailure };

/** `approval_rule` の現在の版。`active` はプレビュー・一覧の表示に使う。 */
export type RuleForResolution = {
  ruleId: string;
  code: string;
  revision: number;
  active: boolean;
  steps: ApprovalRuleStep[];
};

export type UserFacts = {
  status: 'active' | 'deactivated';
  activeMembership: boolean;
  hasApproverRole: boolean;
  isOrgAdmin: boolean;
};

export type ProfileFacts = {
  managerUserId: string | null;
  primaryDepartmentId: string | null;
};

export type DepartmentFacts = {
  parentId: string | null;
  active: boolean;
};

/** 解決に必要な事実だけを持つスナップショット。純粋ロジックはこれ以外を読まない。 */
export type ResolverSnapshot = {
  users: ReadonlyMap<string, UserFacts>;
  profiles: ReadonlyMap<string, ProfileFacts>;
  departments: ReadonlyMap<string, DepartmentFacts>;
  departmentHeads: ReadonlyMap<string, string | null>;
};

export type DefinitionApproval = {
  approverId?: string | undefined;
  ruleId?: string | undefined;
};

/** ADR-0023 §1 の「有効な所属」。role_binding の有効期間と app_user.status だけを見る。 */
export function isActiveMember(user: UserFacts | null | undefined): boolean {
  return user?.status === 'active' && user.activeMembership === true;
}

/**
 * 有効な所属を判定する SQL 述語。`userExpr` は利用者IDを返す式、
 * `orgParam` / `atParam` は外側クエリのプレースホルダである。
 * 文字列は呼び出し側の固定リテラルだけを渡す(利用者入力を連結しない)。
 */
export function activeMembershipSql(userExpr: string, orgParam: string, atParam: string): string {
  return `EXISTS (
    SELECT 1 FROM role_binding rb
     WHERE rb.user_id = ${userExpr}
       AND rb.role_scope = 'org'
       AND rb.organization_id = ${orgParam}
       AND rb.valid_from <= ${atParam}
       AND (rb.valid_until IS NULL OR rb.valid_until > ${atParam})
  )`;
}

type StepResolution =
  | {
      ok: true;
      approverId: string;
      authorityType: AuthorityType;
      resolvedFrom: string;
    }
  | { ok: false; reason: ResolverFailure };

function failure(
  code: ResolverFailureCode,
  message: string,
  missing: ResolverMissing,
  stepNo?: number,
  authorityType?: AuthorityType,
): ResolverResult {
  return { ok: false, reason: { code, message, missing, stepNo, authorityType } };
}

function stepFailure(
  code: ResolverFailureCode,
  message: string,
  missing: ResolverMissing,
  stepNo: number,
  authorityType: AuthorityType,
): StepResolution {
  return { ok: false, reason: { code, message, missing, stepNo, authorityType } };
}

function fixedApprover(
  approverId: string,
  requesterId: string,
  snapshot: ResolverSnapshot,
  stepNo: number,
): StepResolution {
  if (approverId === requesterId)
    return stepFailure(
      'fixed_approver_self',
      '自分の申請を承認することはできません',
      'fixed_approver',
      stepNo,
      'fixed',
    );
  const user = snapshot.users.get(approverId);
  if (!isActiveMember(user))
    return stepFailure(
      'fixed_approver_invalid',
      '固定承認者が現在有効な所属ではありません',
      'fixed_approver',
      stepNo,
      'fixed',
    );
  if (!user?.hasApproverRole)
    return stepFailure(
      'fixed_approver_invalid',
      '固定承認者に承認者ロールがありません',
      'fixed_approver',
      stepNo,
      'fixed',
    );
  return { ok: true, approverId, authorityType: 'fixed', resolvedFrom: 'fixed' };
}

/**
 * 申請者の主部署から祖先へ部署長を探す。
 * - 無効な部署は飛ばす(親へは進む)。
 * - その時点で有効な部署長で、有効な所属かつ申請者本人でない者を採用する。
 * - 探索は10階層で打ち切る(ADR-0023 §3・§9)。
 */
function findDepartmentHead(
  requesterId: string,
  snapshot: ResolverSnapshot,
): {
  approverId: string;
  resolvedFrom: 'department_head:self' | 'department_head:ancestor';
} | null {
  let departmentId = snapshot.profiles.get(requesterId)?.primaryDepartmentId ?? null;
  let source: 'self' | 'ancestor' = 'self';
  let depth = 0;
  const visited = new Set<string>();
  while (departmentId && depth < 10 && !visited.has(departmentId)) {
    visited.add(departmentId);
    const department = snapshot.departments.get(departmentId);
    if (!department) break;
    if (department.active) {
      const headId = snapshot.departmentHeads.get(departmentId) ?? null;
      if (headId && headId !== requesterId && isActiveMember(snapshot.users.get(headId)))
        return {
          approverId: headId,
          resolvedFrom: source === 'self' ? 'department_head:self' : 'department_head:ancestor',
        };
    }
    departmentId = department.parentId;
    source = 'ancestor';
    depth += 1;
  }
  return null;
}

function departmentHeadStep(
  requesterId: string,
  snapshot: ResolverSnapshot,
  stepNo: number,
): StepResolution {
  const head = findDepartmentHead(requesterId, snapshot);
  if (!head)
    return stepFailure(
      'department_head_missing',
      '申請者の部署または祖先部署に有効な部署長がいません',
      'department_head',
      stepNo,
      'department_head',
    );
  return {
    ok: true,
    approverId: head.approverId,
    authorityType: 'department_head',
    resolvedFrom: head.resolvedFrom,
  };
}

function managerStep(
  step: Extract<ApprovalRuleStep, { type: 'manager' }>,
  requesterId: string,
  snapshot: ResolverSnapshot,
  stepNo: number,
): StepResolution {
  const requester = snapshot.users.get(requesterId);
  const reasonFor = (
    code: 'manager_unset' | 'manager_inactive' | 'manager_self',
    message: string,
  ) => {
    if (step.onUnresolved === 'reject')
      return stepFailure(
        code,
        `${message}。承認ルールの設定により申請を拒否しました`,
        'manager',
        stepNo,
        'manager',
      );
    const head = findDepartmentHead(requesterId, snapshot);
    if (!head)
      return stepFailure(
        'department_head_missing',
        `${message}。部署長も見つかりません。承認ルールの設定を確認してください`,
        'department_head',
        stepNo,
        'manager',
      );
    return {
      ok: true as const,
      approverId: head.approverId,
      authorityType: 'manager' as const,
      resolvedFrom: 'manager>department_head',
    };
  };

  // ADR-0023 §3: 組織管理者の上長は常に未設定として扱う。
  if (requester?.isOrgAdmin)
    return reasonFor('manager_unset', '申請者は組織管理者のため上長が未設定です');

  const managerId = snapshot.profiles.get(requesterId)?.managerUserId ?? null;
  if (!managerId) return reasonFor('manager_unset', '申請者の上長が未設定です');
  if (managerId === requesterId) return reasonFor('manager_self', '申請者の上長が申請者本人です');
  if (!isActiveMember(snapshot.users.get(managerId)))
    return reasonFor('manager_inactive', '申請者の上長が現在有効な所属ではありません');
  return { ok: true, approverId: managerId, authorityType: 'manager', resolvedFrom: 'manager' };
}

function resolveRuleStep(
  definition: ApprovalRuleStep,
  requesterId: string,
  snapshot: ResolverSnapshot,
  stepNo: number,
): StepResolution {
  return definition.type === 'fixed'
    ? fixedApprover(definition.approverId, requesterId, snapshot, stepNo)
    : definition.type === 'manager'
      ? managerStep(definition, requesterId, snapshot, stepNo)
      : departmentHeadStep(requesterId, snapshot, stepNo);
}

function resolveRule(
  rule: RuleForResolution,
  requesterId: string,
  snapshot: ResolverSnapshot,
): ResolverResult {
  if (rule.steps.length < 1 || rule.steps.length > 3)
    return failure('rule_invalid', '承認ルールの段数を確認できません', 'rule');
  const seen = new Set<string>();
  const steps: ApprovalRouteStep[] = [];
  for (const [index, definition] of rule.steps.entries()) {
    const stepNo = index + 1;
    const resolved = resolveRuleStep(definition, requesterId, snapshot, stepNo);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (seen.has(resolved.approverId))
      return {
        ok: false,
        reason: {
          code: 'duplicate_approver',
          message: '同じ承認者が複数の承認段に指定されています',
          missing: 'duplicate',
          stepNo,
          authorityType: resolved.authorityType,
        },
      };
    seen.add(resolved.approverId);
    steps.push({
      stepNo,
      approverId: resolved.approverId,
      authorityType: resolved.authorityType,
      resolvedFrom: resolved.resolvedFrom,
    });
  }
  const route: ApprovalRoute = {
    steps,
    ruleRef: { ruleId: rule.ruleId, revision: rule.revision },
  };
  return { ok: true, route, routeHash: routeHash(route) };
}

function compatibleRoute(
  definition: { approval?: DefinitionApproval | undefined },
  requesterId: string,
  selectedApproverId: string | null,
  snapshot: ResolverSnapshot,
): ResolverResult {
  const fixed = definition.approval?.approverId;
  if (fixed) {
    const resolved = fixedApprover(fixed, requesterId, snapshot, 1);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const route: ApprovalRoute = {
      steps: [
        {
          stepNo: 1,
          approverId: resolved.approverId,
          authorityType: 'fixed',
          resolvedFrom: 'fixed',
        },
      ],
      ruleRef: null,
    };
    return { ok: true, route, routeHash: routeHash(route) };
  }

  if (!selectedApproverId)
    return failure('requester_selected_missing', '承認者を選んでください', 'selected_approver');
  if (selectedApproverId === requesterId)
    return failure(
      'requester_selected_self',
      '自分の申請を承認することはできません',
      'selected_approver',
    );
  const user = snapshot.users.get(selectedApproverId);
  if (!isActiveMember(user) || !user?.hasApproverRole)
    return failure(
      'requester_selected_invalid',
      '現在有効な同組織の承認者を選んでください',
      'selected_approver',
    );
  const route: ApprovalRoute = {
    steps: [
      {
        stepNo: 1,
        approverId: selectedApproverId,
        authorityType: 'legacy',
        resolvedFrom: 'requester_selected',
      },
    ],
    ruleRef: null,
  };
  return { ok: true, route, routeHash: routeHash(route) };
}

export type ResolveApprovalRouteInput = {
  organizationId: string;
  requesterId: string;
  definition: { approval?: DefinitionApproval | undefined };
  /** 契約として受け取る。事実は既にこの時刻で絞り込まれている。 */
  now: Date;
  /** 組織でルールが有効化されているか。 */
  ruleRoutingEnabled: boolean;
  /** 使用するルール(無効・他組織・不在なら null)。 */
  rule: RuleForResolution | null;
  /** 現行互換で申請者が選んだ承認者。 */
  selectedApproverId: string | null;
  snapshot: ResolverSnapshot;
};

/** 純粋な解決ロジック。DB・時計・乱数を読まない。 */
export function resolveApprovalRoute(input: ResolveApprovalRouteInput): ResolverResult {
  if (!isActiveMember(input.snapshot.users.get(input.requesterId)))
    return failure(
      'requester_not_active_member',
      '申請者が現在有効な所属ではありません',
      'requester',
    );

  const ruleId = input.definition.approval?.ruleId ?? null;
  if (input.ruleRoutingEnabled && ruleId) {
    if (!input.rule || input.rule.ruleId !== ruleId)
      return failure(
        'rule_unavailable',
        '承認ルールが無効か、存在しません。承認ルールの設定を確認してください',
        'rule',
      );
    return resolveRule(input.rule, input.requesterId, input.snapshot);
  }
  return compatibleRoute(
    input.definition,
    input.requesterId,
    input.selectedApproverId,
    input.snapshot,
  );
}

export type ResolveRuleRemainderInput = {
  rule: RuleForResolution;
  requesterId: string;
  /** 再解決する最初の段(1始まり)。この段より前は prefix をそのまま使う。 */
  fromStepNo: number;
  /** 現在の経路の 1..fromStepNo-1。承認済みの段を保持する。 */
  prefix: ApprovalRouteStep[];
  snapshot: ResolverSnapshot;
};

/**
 * 再割当のための部分解決(ADR-0024 §3 / WP-P4-APR-018 §4)。
 *
 * 申請時に固定したルールの版のうち、`fromStepNo` 以降だけを**現時点の**組織データで
 * 解決する。承認済みの段(`prefix`)は再解決しない。自己承認と重複は申請時と同じ規則で
 * 拒否し、prefix の承認者と申請者を除外する。
 */
export function resolveRuleRemainder(input: ResolveRuleRemainderInput): ResolverResult {
  if (!isActiveMember(input.snapshot.users.get(input.requesterId)))
    return failure(
      'requester_not_active_member',
      '申請者が現在有効な所属ではありません',
      'requester',
    );
  if (
    !Number.isInteger(input.fromStepNo) ||
    input.fromStepNo < 1 ||
    input.fromStepNo > input.rule.steps.length
  )
    return failure('rule_invalid', '再解決する承認段を確認できません', 'rule');
  if (input.prefix.length !== input.fromStepNo - 1)
    return failure('rule_invalid', '承認済みの経路を確認できません', 'rule');

  const seen = new Set<string>();
  for (const [index, step] of input.prefix.entries()) {
    if (step.stepNo !== index + 1 || typeof step.approverId !== 'string')
      return failure('rule_invalid', '承認済みの経路を確認できません', 'rule');
    if (step.approverId === input.requesterId)
      return failure(
        'approver_self',
        '申請者本人が承認段に含まれています',
        'duplicate',
        step.stepNo,
        step.authorityType,
      );
    if (seen.has(step.approverId))
      return failure(
        'duplicate_approver',
        '同じ承認者が複数の承認段に指定されています',
        'duplicate',
        step.stepNo,
        step.authorityType,
      );
    seen.add(step.approverId);
  }

  const steps: ApprovalRouteStep[] = [...input.prefix];
  for (let index = input.fromStepNo - 1; index < input.rule.steps.length; index += 1) {
    const stepNo = index + 1;
    const resolved = resolveRuleStep(
      input.rule.steps[index]!,
      input.requesterId,
      input.snapshot,
      stepNo,
    );
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (resolved.approverId === input.requesterId)
      return failure(
        'approver_self',
        '申請者本人が承認段に含まれています',
        'duplicate',
        stepNo,
        resolved.authorityType,
      );
    if (seen.has(resolved.approverId))
      return failure(
        'duplicate_approver',
        '同じ承認者が複数の承認段に指定されています',
        'duplicate',
        stepNo,
        resolved.authorityType,
      );
    seen.add(resolved.approverId);
    steps.push({
      stepNo,
      approverId: resolved.approverId,
      authorityType: resolved.authorityType,
      resolvedFrom: resolved.resolvedFrom,
    });
  }
  const route: ApprovalRoute = {
    steps,
    ruleRef: { ruleId: input.rule.ruleId, revision: input.rule.revision },
  };
  return { ok: true, route, routeHash: routeHash(route) };
}

/** 解決失敗を API の応答へ変換する。既存の申請者選択・固定承認者の拒否は従来の 403/400 を保つ。 */
export function approvalResolutionProblem(reason: ResolverFailure): ProblemError {
  if (reason.code === 'requester_selected_missing')
    return Problems.validation([{ field: 'approverId', message: reason.message }]);
  if (
    reason.code === 'requester_selected_invalid' ||
    reason.code === 'requester_selected_self' ||
    reason.code === 'fixed_approver_invalid' ||
    reason.code === 'fixed_approver_self'
  )
    return Problems.forbidden(reason.message);
  return new ProblemError({
    status: 409,
    type: 'https://solvi.internal/problems/approval-unresolved',
    title: '承認者を解決できません',
    detail: reason.message,
    errors: [
      {
        field: reason.stepNo === undefined ? 'approval' : `approval.steps.${reason.stepNo}`,
        message: reason.message,
      },
    ],
  });
}

type RuleLoad =
  | { state: 'ok'; rule: RuleForResolution }
  | { state: 'missing' | 'inactive' | 'invalid'; rule: null };

async function loadRule(
  client: pg.PoolClient,
  organizationId: string,
  ruleId: string,
  options: { activeOnly: boolean; lock: boolean },
): Promise<RuleLoad> {
  const { rows } = await client.query(
    `SELECT r.id, r.code, r.active, r.current_revision, rev.steps
       FROM approval_rule r
       LEFT JOIN approval_rule_revision rev
         ON rev.rule_id = r.id AND rev.organization_id = r.organization_id
        AND rev.revision = r.current_revision
      WHERE r.id = $1 AND r.organization_id = $2${options.lock ? ' FOR SHARE OF r' : ''}`,
    [ruleId, organizationId],
  );
  const row = rows[0] as
    | {
        id: string;
        code: string;
        active: boolean;
        current_revision: number;
        steps: unknown;
      }
    | undefined;
  if (!row) return { state: 'missing', rule: null };
  if (options.activeOnly && row.active !== true) return { state: 'inactive', rule: null };
  if (row.steps === null || row.steps === undefined) return { state: 'invalid', rule: null };
  const parsed = approvalRuleStepsSchema.safeParse(row.steps);
  if (!parsed.success) return { state: 'invalid', rule: null };
  return {
    state: 'ok',
    rule: {
      ruleId: row.id,
      code: row.code,
      revision: row.current_revision,
      active: row.active,
      steps: parsed.data,
    },
  };
}

type UserFactRow = {
  id: string;
  status: 'active' | 'deactivated';
  active_membership: boolean;
  has_approver_role: boolean;
  is_org_admin: boolean;
};

function toUserFacts(row: UserFactRow): UserFacts {
  return {
    status: row.status,
    activeMembership: row.active_membership === true,
    hasApproverRole: row.has_approver_role === true,
    isOrgAdmin: row.is_org_admin === true,
  };
}

/** 指定利用者の事実を読む。所属判定は `activeMembershipSql` に一元化している。 */
export async function loadUserFacts(
  client: pg.PoolClient,
  organizationId: string,
  userIds: readonly string[],
  now: Date,
): Promise<Map<string, UserFacts>> {
  const facts = new Map<string, UserFacts>();
  if (userIds.length === 0) return facts;
  const { rows } = await client.query<UserFactRow>(
    `SELECT u.id, u.status,
            ${activeMembershipSql('u.id', '$1', '$3')} AS active_membership,
            EXISTS (
              SELECT 1 FROM role_binding rb
                JOIN role r ON r.id = rb.role_id
               WHERE rb.user_id = u.id AND rb.role_scope = 'org'
                 AND rb.organization_id = $1 AND r.code = 'approver'
                 AND rb.valid_from <= $3
                 AND (rb.valid_until IS NULL OR rb.valid_until > $3)
            ) AS has_approver_role,
            EXISTS (
              SELECT 1 FROM role_binding rb
                JOIN role r ON r.id = rb.role_id
               WHERE rb.user_id = u.id AND rb.role_scope = 'org'
                 AND rb.organization_id = $1 AND r.code = 'org_admin'
                 AND rb.valid_from <= $3
                 AND (rb.valid_until IS NULL OR rb.valid_until > $3)
            ) AS is_org_admin
       FROM app_user u
      WHERE u.id = ANY($2::uuid[])`,
    [organizationId, userIds, now],
  );
  for (const row of rows) facts.set(row.id, toUserFacts(row));
  return facts;
}

type ChainRow = {
  id: string;
  parent_id: string | null;
  active: boolean;
  head_user_id: string | null;
};

async function loadDepartmentChain(
  client: pg.PoolClient,
  organizationId: string,
  departmentId: string,
  now: Date,
): Promise<ChainRow[]> {
  const { rows } = await client.query<ChainRow>(
    `WITH RECURSIVE up(id, parent_id, active, depth) AS (
       SELECT d.id, d.parent_id, d.active, 1
         FROM department d
        WHERE d.id = $1 AND d.organization_id = $2
       UNION ALL
       SELECT p.id, p.parent_id, p.active, up.depth + 1
         FROM department p
         JOIN up ON p.id = up.parent_id AND p.organization_id = $2
        WHERE up.depth < 10
     )
     SELECT up.id, up.parent_id, up.active,
       (SELECT h.user_id
          FROM department_head h
         WHERE h.department_id = up.id AND h.organization_id = $2
           AND h.valid_from <= $3
           AND (h.valid_until IS NULL OR h.valid_until > $3)
         ORDER BY h.valid_from DESC, h.id
         LIMIT 1) AS head_user_id
       FROM up
      ORDER BY up.depth`,
    [departmentId, organizationId, now],
  );
  return rows;
}

async function loadResolverSnapshot(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    requesterId: string;
    now: Date;
    definition: { approval?: DefinitionApproval | undefined };
    selectedApproverId: string | null;
    rule: RuleForResolution | null;
  },
): Promise<ResolverSnapshot> {
  const userIds = new Set<string>([input.requesterId]);
  if (input.rule) {
    for (const step of input.rule.steps) if (step.type === 'fixed') userIds.add(step.approverId);
  } else {
    const fixed = input.definition.approval?.approverId;
    if (fixed) userIds.add(fixed);
    else if (input.selectedApproverId) userIds.add(input.selectedApproverId);
  }

  const needsManager = input.rule?.steps.some((step) => step.type === 'manager') ?? false;
  const needsDepartment =
    input.rule?.steps.some(
      (step) =>
        step.type === 'department_head' ||
        (step.type === 'manager' && step.onUnresolved === 'department_head'),
    ) ?? false;

  const profiles = new Map<string, ProfileFacts>();
  if (needsManager || needsDepartment) {
    const { rows } = await client.query<{
      user_id: string;
      manager_user_id: string | null;
      primary_department_id: string | null;
    }>(
      `SELECT user_id, manager_user_id, primary_department_id
         FROM org_member_profile
        WHERE organization_id = $1 AND user_id = $2`,
      [input.organizationId, input.requesterId],
    );
    const row = rows[0];
    if (row)
      profiles.set(row.user_id, {
        managerUserId: row.manager_user_id,
        primaryDepartmentId: row.primary_department_id,
      });
  }

  const departments = new Map<string, DepartmentFacts>();
  const departmentHeads = new Map<string, string | null>();
  if (needsDepartment) {
    const primary = profiles.get(input.requesterId)?.primaryDepartmentId ?? null;
    if (primary) {
      for (const row of await loadDepartmentChain(
        client,
        input.organizationId,
        primary,
        input.now,
      )) {
        departments.set(row.id, { parentId: row.parent_id, active: row.active });
        departmentHeads.set(row.id, row.head_user_id);
        if (row.head_user_id) userIds.add(row.head_user_id);
      }
    }
  }
  if (needsManager) {
    const managerId = profiles.get(input.requesterId)?.managerUserId ?? null;
    if (managerId) userIds.add(managerId);
  }

  return {
    users: await loadUserFacts(client, input.organizationId, [...userIds], input.now),
    profiles,
    departments,
    departmentHeads,
  };
}

export type RouteResolution = ResolverResult & {
  ruleRoutingEnabled: boolean;
  rule: RuleForResolution | null;
  ruleState: 'none' | 'ok' | 'missing' | 'inactive' | 'invalid';
};

/**
 * 申請・変更・カタログ項目のプレビュー用。組織の有効化設定を読み、
 * 有効化されていて `ruleId` がある場合だけルールを使う。
 */
export async function resolveRouteForRequest(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    requesterId: string;
    definition: { approval?: DefinitionApproval | undefined };
    selectedApproverId: string | null;
    now: Date;
    /**
     * ルール行を `FOR SHARE` で固定するか。申請・変更の解決は既定(true)のまま、
     * 読み取り専用トランザクション(申請前の経路確認)だけ false にする。
     * READ ONLY トランザクションでは行ロックを取れないため。
     */
    lockRule?: boolean;
  },
): Promise<RouteResolution> {
  const setting = await client.query<{ rule_routing_enabled: boolean }>(
    'SELECT rule_routing_enabled FROM org_approval_setting WHERE organization_id = $1',
    [input.organizationId],
  );
  const ruleRoutingEnabled = setting.rows[0]?.rule_routing_enabled === true;
  const ruleId = input.definition.approval?.ruleId ?? null;
  let rule: RuleForResolution | null = null;
  let ruleState: RouteResolution['ruleState'] = 'none';
  if (ruleRoutingEnabled && ruleId) {
    const loaded = await loadRule(client, input.organizationId, ruleId, {
      activeOnly: true,
      lock: input.lockRule ?? true,
    });
    ruleState = loaded.state;
    if (loaded.state === 'ok') rule = loaded.rule;
    if (loaded.state === 'invalid')
      return {
        ok: false,
        reason: {
          code: 'rule_invalid',
          message: '承認ルールの内容を確認できません',
          missing: 'rule',
        },
        ruleRoutingEnabled,
        rule,
        ruleState,
      };
  }

  const snapshot = await loadResolverSnapshot(client, { ...input, rule });
  const result = resolveApprovalRoute({
    ...input,
    ruleRoutingEnabled,
    rule,
    snapshot,
  });
  return { ...result, ruleRoutingEnabled, rule, ruleState };
}

/** ルールIDを指定したプレビュー・解決不能一覧用。組織の有効化設定に関係なくルールを使う。 */
export async function resolveRouteForRule(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    requesterId: string;
    now: Date;
    rule: RuleForResolution;
  },
): Promise<ResolverResult> {
  const snapshot = await loadResolverSnapshot(client, {
    organizationId: input.organizationId,
    requesterId: input.requesterId,
    now: input.now,
    definition: {},
    selectedApproverId: null,
    rule: input.rule,
  });
  return resolveApprovalRoute({
    organizationId: input.organizationId,
    requesterId: input.requesterId,
    definition: { approval: { ruleId: input.rule.ruleId } },
    now: input.now,
    ruleRoutingEnabled: true,
    rule: input.rule,
    selectedApproverId: null,
    snapshot,
  });
}

export async function loadRuleById(
  client: pg.PoolClient,
  organizationId: string,
  ruleId: string,
): Promise<
  | { state: 'ok'; rule: RuleForResolution }
  | { state: 'missing'; rule: null }
  | { state: 'invalid'; rule: null }
> {
  const loaded = await loadRule(client, organizationId, ruleId, {
    activeOnly: false,
    lock: false,
  });
  if (loaded.state === 'ok') return loaded;
  return { state: loaded.state === 'missing' ? 'missing' : 'invalid', rule: null };
}

/**
 * 申請時に固定したルールの版を読む(ADR-0024 §3)。
 *
 * `loadRule` は `current_revision` を読むが、再割当は**経路が指す版**を使う。
 * ルールが無効化されていても、進行中の申請の経路は変えないため `active` は要求しない。
 */
export async function loadRuleRevision(
  client: pg.PoolClient,
  organizationId: string,
  ruleId: string,
  revision: number,
): Promise<
  | { state: 'ok'; rule: RuleForResolution }
  | { state: 'missing'; rule: null }
  | { state: 'invalid'; rule: null }
> {
  const { rows } = await client.query(
    `SELECT r.code, r.active, rev.revision, rev.steps
       FROM approval_rule r
       JOIN approval_rule_revision rev
         ON rev.rule_id = r.id AND rev.organization_id = r.organization_id
        AND rev.revision = $3
      WHERE r.id = $1 AND r.organization_id = $2`,
    [ruleId, organizationId, revision],
  );
  const row = rows[0] as
    { code: string; active: boolean; revision: number; steps: unknown } | undefined;
  if (!row) return { state: 'missing', rule: null };
  if (row.steps === null || row.steps === undefined) return { state: 'invalid', rule: null };
  const parsed = approvalRuleStepsSchema.safeParse(row.steps);
  if (!parsed.success) return { state: 'invalid', rule: null };
  return {
    state: 'ok',
    rule: {
      ruleId,
      code: row.code,
      revision: row.revision,
      active: row.active,
      steps: parsed.data,
    },
  };
}

/**
 * 再割当用の部分解決。固定したルールの版と現時点の組織データから、
 * `fromStepNo` 以降だけを解決する。prefix は現在の経路(承認済み)を渡す。
 */
export async function resolveRouteRemainderForRequest(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    requesterId: string;
    rule: RuleForResolution;
    fromStepNo: number;
    prefix: ApprovalRouteStep[];
    now: Date;
  },
): Promise<ResolverResult> {
  const snapshot = await loadResolverSnapshot(client, {
    organizationId: input.organizationId,
    requesterId: input.requesterId,
    now: input.now,
    definition: { approval: { ruleId: input.rule.ruleId } },
    selectedApproverId: null,
    rule: input.rule,
  });
  return resolveRuleRemainder({
    rule: input.rule,
    requesterId: input.requesterId,
    fromStepNo: input.fromStepNo,
    prefix: input.prefix,
    snapshot,
  });
}

/**
 * 解決不能な人の一覧用に、組織の全有効所属と全部署・部署長を1回で読む。
 * 個々の申請者の解決は純粋関数 `resolveApprovalRoute` で行う。
 */
export async function loadOrganizationResolverSnapshot(
  client: pg.PoolClient,
  organizationId: string,
  now: Date,
): Promise<ResolverSnapshot> {
  const { rows: members } = await client.query<UserFactRow>(
    `SELECT u.id, u.status,
            ${activeMembershipSql('u.id', '$1', '$2')} AS active_membership,
            EXISTS (
              SELECT 1 FROM role_binding rb
                JOIN role r ON r.id = rb.role_id
               WHERE rb.user_id = u.id AND rb.role_scope = 'org'
                 AND rb.organization_id = $1 AND r.code = 'approver'
                 AND rb.valid_from <= $2
                 AND (rb.valid_until IS NULL OR rb.valid_until > $2)
            ) AS has_approver_role,
            EXISTS (
              SELECT 1 FROM role_binding rb
                JOIN role r ON r.id = rb.role_id
               WHERE rb.user_id = u.id AND rb.role_scope = 'org'
                 AND rb.organization_id = $1 AND r.code = 'org_admin'
                 AND rb.valid_from <= $2
                 AND (rb.valid_until IS NULL OR rb.valid_until > $2)
            ) AS is_org_admin
       FROM app_user u
      WHERE u.status = 'active'
        AND ${activeMembershipSql('u.id', '$1', '$2')}`,
    [organizationId, now],
  );
  const users = new Map<string, UserFacts>();
  for (const row of members) users.set(row.id, toUserFacts(row));

  const { rows: profileRows } = await client.query<{
    user_id: string;
    manager_user_id: string | null;
    primary_department_id: string | null;
  }>(
    `SELECT user_id, manager_user_id, primary_department_id
       FROM org_member_profile WHERE organization_id = $1`,
    [organizationId],
  );
  const profiles = new Map<string, ProfileFacts>();
  for (const row of profileRows)
    profiles.set(row.user_id, {
      managerUserId: row.manager_user_id,
      primaryDepartmentId: row.primary_department_id,
    });

  const { rows: departmentRows } = await client.query<ChainRow>(
    `SELECT d.id, d.parent_id, d.active,
       (SELECT h.user_id
          FROM department_head h
         WHERE h.department_id = d.id AND h.organization_id = $1
           AND h.valid_from <= $2
           AND (h.valid_until IS NULL OR h.valid_until > $2)
         ORDER BY h.valid_from DESC, h.id
         LIMIT 1) AS head_user_id
       FROM department d
      WHERE d.organization_id = $1`,
    [organizationId, now],
  );
  const departments = new Map<string, DepartmentFacts>();
  const departmentHeads = new Map<string, string | null>();
  for (const row of departmentRows) {
    departments.set(row.id, { parentId: row.parent_id, active: row.active });
    departmentHeads.set(row.id, row.head_user_id);
  }

  return { users, profiles, departments, departmentHeads };
}
