import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { approvalRuleStepsSchema, type ApprovalRuleStep } from '@solvi/shared/catalog';
import { requireRole, type AuthzContext } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { definitionSchema } from './catalog-definition.js';
import {
  activeMembershipSql,
  loadOrganizationResolverSnapshot,
  loadRuleById,
  loadUserFacts,
  resolveApprovalRoute,
  resolveRouteForRequest,
  resolveRouteForRule,
  type ResolverFailure,
  type RuleForResolution,
} from './approval-resolver.js';

/**
 * 承認ルール・組織の有効化設定・経路プレビュー (WP-P4-APR-015 段階A)。
 *
 * ## 版は append-only
 *
 * 「編集」は新しい版の追加だけである。`approval_rule_revision` を UPDATE/DELETE する
 * コードをここに置かない(DBのトリガとGRANTでも拒否する)。
 *
 * ## 保存時の検証
 *
 * 固定承認者は、保存時点で同じ組織の有効な所属かつ `approver` ロールを持つことを
 * リゾルバと同じ判定(`loadUserFacts`)で確かめる。上長・部署長は申請者からたどるため、
 * ルール保存時には特定の承認者を確定しない(申請時に解決する)。
 *
 * ## 監査
 *
 * 作成・改版・無効化・有効化の切替は、業務の書込みと同一トランザクションで記録する。
 * 監査に載せるのはルールの識別子・版・段の種別・固定承認者のIDだけであり、
 * 申請の入力値や個人データ(役職・勤務地・社員番号)は載せない。
 */

const CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export type ApprovalRuleSummary = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  currentRevision: number;
  steps: ApprovalRuleStep[];
  stepsValid: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalRuleRevisionSummary = {
  revision: number;
  steps: ApprovalRuleStep[];
  stepsValid: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
};

type RuleRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  current_revision: number;
  created_at: Date;
  updated_at: Date;
};

type RevisionRow = {
  revision: number;
  steps: unknown;
  created_by: string;
  created_at: Date;
  created_by_name?: string | null;
};

function parseStoredSteps(value: unknown): { steps: ApprovalRuleStep[]; valid: boolean } {
  const parsed = approvalRuleStepsSchema.safeParse(value);
  return parsed.success ? { steps: parsed.data, valid: true } : { steps: [], valid: false };
}

function auditSteps(steps: readonly ApprovalRuleStep[]) {
  return {
    stepCount: steps.length,
    stepTypes: steps.map((step) => step.type).join(','),
    fixedApproverIds: steps
      .filter((step): step is Extract<ApprovalRuleStep, { type: 'fixed' }> => step.type === 'fixed')
      .map((step) => step.approverId)
      .join(','),
  };
}

function translateRuleError(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505') throw Problems.conflict('同じコードの承認ルールが既にあります');
  if (code === '23514')
    throw Problems.validation([
      { field: 'steps', message: '承認ステップを1〜3段で設定してください' },
    ]);
  if (code === '23503')
    throw Problems.validation([
      { field: 'steps', message: '承認ルールの参照先を確認してください' },
    ]);
  throw error;
}

export class ApprovalRuleService {
  constructor(private readonly client: pg.PoolClient) {}

  private requireAdmin(ctx: AuthzContext): void {
    // WP §6.1 / ADR-0023 §13: 有効化もルール管理も org_admin だけ。
    requireRole(ctx, 'org_admin');
  }

  private async now(): Promise<Date> {
    return (await this.client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  }

  /**
   * 固定承認者が保存時点で有効な所属かつ approver ロールを持つことを確かめる。
   * 申請者との同一性は申請時にしか分からないため、ここでは見ない(解決時に拒否する)。
   */
  private async assertFixedApprovers(
    ctx: AuthzContext,
    steps: readonly ApprovalRuleStep[],
    now: Date,
  ): Promise<void> {
    const fixed = steps
      .map((step, index) => ({ step, index }))
      .filter(
        (entry): entry is { step: Extract<ApprovalRuleStep, { type: 'fixed' }>; index: number } =>
          entry.step.type === 'fixed',
      );
    if (fixed.length === 0) return;
    const ids = [...new Set(fixed.map((entry) => entry.step.approverId))];
    const facts = await loadUserFacts(this.client, ctx.organizationId, ids, now);
    const seen = new Set<string>();
    for (const { step, index } of fixed) {
      if (seen.has(step.approverId))
        throw Problems.validation([
          {
            field: `steps.${index}.approverId`,
            message: '同じ固定承認者を複数の段に指定できません',
          },
        ]);
      seen.add(step.approverId);
      const user = facts.get(step.approverId);
      if (!user || user.status !== 'active' || !user.activeMembership)
        throw Problems.validation([
          {
            field: `steps.${index}.approverId`,
            message: '現在有効な同じ組織の承認者を選んでください',
          },
        ]);
      if (!user.hasApproverRole)
        throw Problems.validation([
          {
            field: `steps.${index}.approverId`,
            message: '承認者ロールを持つ利用者を固定承認者に選んでください',
          },
        ]);
    }
  }

  private async audit(
    ctx: AuthzContext,
    eventType:
      | 'approval.rule.created'
      | 'approval.rule.revised'
      | 'approval.rule.deactivated'
      | 'approval.routing.enabled'
      | 'approval.routing.disabled',
    ruleId: string | null,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown>,
  ): Promise<void> {
    await recordAuditEvent(this.client, {
      eventType,
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: ruleId ? 'approval_rule' : 'organization',
      targetId: ruleId ?? ctx.organizationId,
      action: eventType,
      outcome: 'success',
      beforeState,
      afterState,
    });
  }

  async list(ctx: AuthzContext): Promise<ApprovalRuleSummary[]> {
    this.requireAdmin(ctx);
    const { rows } = await this.client.query<RuleRow & { steps: unknown }>(
      `SELECT r.id, r.code, r.name, r.active, r.current_revision, r.created_at, r.updated_at,
              rev.steps
         FROM approval_rule r
         JOIN approval_rule_revision rev
           ON rev.rule_id = r.id AND rev.organization_id = r.organization_id
          AND rev.revision = r.current_revision
        WHERE r.organization_id = $1
        ORDER BY r.code, r.id`,
      [ctx.organizationId],
    );
    return rows.map((row) => {
      const parsed = parseStoredSteps(row.steps);
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        active: row.active,
        currentRevision: row.current_revision,
        steps: parsed.steps,
        stepsValid: parsed.valid,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }

  async create(
    ctx: AuthzContext,
    input: { code: string; name: string; steps: ApprovalRuleStep[] },
  ): Promise<{ id: string; revision: number }> {
    this.requireAdmin(ctx);
    const code = input.code.trim();
    const name = input.name.trim();
    if (!CODE_PATTERN.test(code))
      throw Problems.validation([
        {
          field: 'code',
          message: 'コードは英小文字から始まる64文字以内の英小文字・数字・ハイフンにしてください',
        },
      ]);
    if (name.length < 1 || name.length > 200)
      throw Problems.validation([
        { field: 'name', message: 'ルール名は1〜200文字で入力してください' },
      ]);
    const steps = approvalRuleStepsSchema.parse(input.steps);
    const now = await this.now();
    await this.assertFixedApprovers(ctx, steps, now);

    const id = uuidv7();
    try {
      await this.client.query(
        `INSERT INTO approval_rule(id, organization_id, code, name, active, current_revision, created_by)
         VALUES($1,$2,$3,$4,true,1,$5)`,
        [id, ctx.organizationId, code, name, ctx.principal.userId],
      );
      await this.client.query(
        `INSERT INTO approval_rule_revision(rule_id, organization_id, revision, steps, created_by)
         VALUES($1,$2,1,$3::jsonb,$4)`,
        [id, ctx.organizationId, JSON.stringify(steps), ctx.principal.userId],
      );
    } catch (error) {
      translateRuleError(error);
    }
    await this.audit(ctx, 'approval.rule.created', id, null, {
      code,
      revision: 1,
      active: true,
      ...auditSteps(steps),
    });
    return { id, revision: 1 };
  }

  async revise(
    ctx: AuthzContext,
    ruleId: string,
    input: { expectedRevision: number; steps: ApprovalRuleStep[]; name?: string },
  ): Promise<{ id: string; revision: number }> {
    this.requireAdmin(ctx);
    const steps = approvalRuleStepsSchema.parse(input.steps);
    const now = await this.now();
    const { rows } = await this.client.query<RuleRow>(
      `SELECT id, code, name, active, current_revision, created_at, updated_at
         FROM approval_rule
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [ruleId, ctx.organizationId],
    );
    const rule = rows[0];
    if (!rule) throw Problems.notFound('承認ルール');
    if (!rule.active) throw Problems.conflict('無効化された承認ルールは変更できません');
    if (rule.current_revision !== input.expectedRevision) throw Problems.stale('承認ルール');
    await this.assertFixedApprovers(ctx, steps, now);

    const previous = await this.client.query<RevisionRow>(
      `SELECT revision, steps, created_by, created_at
         FROM approval_rule_revision
        WHERE rule_id = $1 AND organization_id = $2 AND revision = $3`,
      [ruleId, ctx.organizationId, rule.current_revision],
    );
    const previousSteps = parseStoredSteps(previous.rows[0]?.steps).steps;
    const revision = rule.current_revision + 1;
    const name = input.name === undefined ? rule.name : input.name.trim();
    if (name.length < 1 || name.length > 200)
      throw Problems.validation([
        { field: 'name', message: 'ルール名は1〜200文字で入力してください' },
      ]);
    try {
      await this.client.query(
        `INSERT INTO approval_rule_revision(rule_id, organization_id, revision, steps, created_by)
         VALUES($1,$2,$3,$4::jsonb,$5)`,
        [ruleId, ctx.organizationId, revision, JSON.stringify(steps), ctx.principal.userId],
      );
      await this.client.query(
        `UPDATE approval_rule
            SET current_revision = $2, name = $3, updated_at = clock_timestamp()
          WHERE id = $1 AND organization_id = $4 AND current_revision = $5`,
        [ruleId, revision, name, ctx.organizationId, rule.current_revision],
      );
    } catch (error) {
      translateRuleError(error);
    }
    await this.audit(
      ctx,
      'approval.rule.revised',
      ruleId,
      {
        code: rule.code,
        revision: rule.current_revision,
        ...auditSteps(previousSteps),
      },
      {
        code: rule.code,
        revision,
        name,
        active: true,
        ...auditSteps(steps),
      },
    );
    return { id: ruleId, revision };
  }

  async deactivate(ctx: AuthzContext, ruleId: string): Promise<{ id: string; active: false }> {
    this.requireAdmin(ctx);
    const { rows } = await this.client.query<RuleRow>(
      `SELECT id, code, name, active, current_revision, created_at, updated_at
         FROM approval_rule
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [ruleId, ctx.organizationId],
    );
    const rule = rows[0];
    if (!rule) throw Problems.notFound('承認ルール');
    if (!rule.active) throw Problems.conflict('この承認ルールは既に無効化されています');
    await this.client.query(
      `UPDATE approval_rule
          SET active = false, updated_at = clock_timestamp()
        WHERE id = $1 AND organization_id = $2 AND active`,
      [ruleId, ctx.organizationId],
    );
    await this.audit(
      ctx,
      'approval.rule.deactivated',
      ruleId,
      { code: rule.code, revision: rule.current_revision, active: true },
      { code: rule.code, revision: rule.current_revision, active: false },
    );
    return { id: ruleId, active: false };
  }

  async history(ctx: AuthzContext, ruleId: string): Promise<ApprovalRuleRevisionSummary[]> {
    this.requireAdmin(ctx);
    const rule = await this.client.query(
      'SELECT 1 FROM approval_rule WHERE id = $1 AND organization_id = $2',
      [ruleId, ctx.organizationId],
    );
    if (!rule.rowCount) throw Problems.notFound('承認ルール');
    const { rows } = await this.client.query<RevisionRow>(
      `SELECT rev.revision, rev.steps, rev.created_by, rev.created_at,
              u.display_name AS created_by_name
         FROM approval_rule_revision rev
         LEFT JOIN app_user u ON u.id = rev.created_by
        WHERE rev.rule_id = $1 AND rev.organization_id = $2
        ORDER BY rev.revision DESC`,
      [ruleId, ctx.organizationId],
    );
    return rows.map((row) => {
      const parsed = parseStoredSteps(row.steps);
      return {
        revision: row.revision,
        steps: parsed.steps,
        stepsValid: parsed.valid,
        createdBy: row.created_by,
        createdByName: row.created_by_name ?? null,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  async settings(ctx: AuthzContext): Promise<{
    enabled: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
  }> {
    this.requireAdmin(ctx);
    const { rows } = await this.client.query<{
      rule_routing_enabled: boolean;
      updated_at: Date;
      updated_by: string;
    }>(
      `SELECT rule_routing_enabled, updated_at, updated_by
         FROM org_approval_setting WHERE organization_id = $1`,
      [ctx.organizationId],
    );
    const row = rows[0];
    return row
      ? {
          enabled: row.rule_routing_enabled === true,
          updatedAt: row.updated_at.toISOString(),
          updatedBy: row.updated_by,
        }
      : { enabled: false, updatedAt: null, updatedBy: null };
  }

  async setRouting(
    ctx: AuthzContext,
    enabled: boolean,
  ): Promise<{ enabled: boolean; changed: boolean }> {
    this.requireAdmin(ctx);
    const current = await this.client.query<{ rule_routing_enabled: boolean }>(
      'SELECT rule_routing_enabled FROM org_approval_setting WHERE organization_id = $1',
      [ctx.organizationId],
    );
    const before = current.rows[0]?.rule_routing_enabled === true;
    if (before === enabled) return { enabled, changed: false };
    if (enabled) {
      await this.client.query(
        `INSERT INTO org_approval_setting(organization_id, rule_routing_enabled, updated_by, updated_at)
         VALUES($1, true, $2, clock_timestamp())
         ON CONFLICT (organization_id) DO UPDATE
           SET rule_routing_enabled = true,
               updated_by = EXCLUDED.updated_by,
               updated_at = clock_timestamp()`,
        [ctx.organizationId, ctx.principal.userId],
      );
    } else {
      await this.client.query(
        `UPDATE org_approval_setting
            SET rule_routing_enabled = false,
                updated_by = $2,
                updated_at = clock_timestamp()
          WHERE organization_id = $1`,
        [ctx.organizationId, ctx.principal.userId],
      );
    }
    await this.audit(
      ctx,
      enabled ? 'approval.routing.enabled' : 'approval.routing.disabled',
      null,
      { enabled: before },
      { enabled },
    );
    return { enabled, changed: true };
  }

  private async requesterName(
    organizationId: string,
    userId: string,
    now: Date,
  ): Promise<string | null> {
    const { rows } = await this.client.query<{ display_name: string }>(
      `SELECT u.display_name
         FROM app_user u
        WHERE u.id = $1 AND u.status = 'active'
          AND ${activeMembershipSql('u.id', '$2', '$3')}`,
      [userId, organizationId, now],
    );
    return rows[0]?.display_name ?? null;
  }

  private async approverNames(
    organizationId: string,
    ids: readonly string[],
    now: Date,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const { rows } = await this.client.query<{ id: string; display_name: string }>(
      `SELECT u.id, u.display_name
         FROM app_user u
        WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'
          AND ${activeMembershipSql('u.id', '$2', '$3')}`,
      [ids, organizationId, now],
    );
    for (const row of rows) names.set(row.id, row.display_name);
    return names;
  }

  async preview(
    ctx: AuthzContext,
    input: { requesterId: string; itemId?: string; ruleId?: string; approverId?: string },
  ): Promise<Record<string, unknown>> {
    this.requireAdmin(ctx);
    const now = await this.now();
    const setting = await this.client.query<{ rule_routing_enabled: boolean }>(
      'SELECT rule_routing_enabled FROM org_approval_setting WHERE organization_id = $1',
      [ctx.organizationId],
    );
    const ruleRoutingEnabled = setting.rows[0]?.rule_routing_enabled === true;
    const requesterName = await this.requesterName(ctx.organizationId, input.requesterId, now);

    let resolution;
    let rule: RuleForResolution | null = null;
    if (input.itemId) {
      const { rows } = await this.client.query<{
        id: string;
        version: number;
        title: string;
        definition: unknown;
      }>(
        `SELECT id, version, title, definition
           FROM local_catalog_item
          WHERE id = $1 AND organization_id = $2 AND active`,
        [input.itemId, ctx.organizationId],
      );
      const item = rows[0];
      if (!item) throw Problems.notFound('カタログ');
      const parsed = definitionSchema.safeParse(item.definition);
      if (!parsed.success) throw Problems.conflict('カタログ定義を確認できません');
      resolution = await resolveRouteForRequest(this.client, {
        organizationId: ctx.organizationId,
        requesterId: input.requesterId,
        definition: parsed.data,
        selectedApproverId: input.approverId ?? null,
        now,
      });
      rule = resolution.rule;
    } else {
      const loaded = await loadRuleById(this.client, ctx.organizationId, input.ruleId!);
      if (loaded.state === 'missing') throw Problems.notFound('承認ルール');
      if (loaded.state === 'invalid')
        return {
          resolved: false,
          requesterId: input.requesterId,
          requesterName,
          ruleRoutingEnabled,
          rule: null,
          reason: {
            code: 'rule_invalid',
            message: '承認ルールの内容を確認できません',
            missing: 'rule',
          },
        };
      rule = loaded.rule;
      resolution = await resolveRouteForRule(this.client, {
        organizationId: ctx.organizationId,
        requesterId: input.requesterId,
        now,
        rule: loaded.rule,
      });
    }

    const ruleInfo = rule
      ? { id: rule.ruleId, code: rule.code, revision: rule.revision, active: rule.active }
      : null;
    if (!resolution.ok)
      return {
        resolved: false,
        requesterId: input.requesterId,
        requesterName,
        ruleRoutingEnabled,
        rule: ruleInfo,
        reason: resolution.reason,
      };

    const names = await this.approverNames(
      ctx.organizationId,
      resolution.route.steps.map((step) => step.approverId),
      now,
    );
    return {
      resolved: true,
      requesterId: input.requesterId,
      requesterName,
      ruleRoutingEnabled,
      rule: ruleInfo,
      steps: resolution.route.steps.map((step) => ({
        stepNo: step.stepNo,
        approverId: step.approverId,
        approverName: names.get(step.approverId) ?? null,
        authorityType: step.authorityType,
        resolvedFrom: step.resolvedFrom,
      })),
      routeHash: resolution.routeHash,
    };
  }

  async unresolved(ctx: AuthzContext, ruleId: string): Promise<Record<string, unknown>> {
    this.requireAdmin(ctx);
    const loaded = await loadRuleById(this.client, ctx.organizationId, ruleId);
    if (loaded.state === 'missing') throw Problems.notFound('承認ルール');
    if (loaded.state === 'invalid') throw Problems.conflict('承認ルールの内容を確認できません');
    const now = await this.now();
    const snapshot = await loadOrganizationResolverSnapshot(this.client, ctx.organizationId, now);
    const { rows: members } = await this.client.query<{
      id: string;
      display_name: string;
    }>(
      `SELECT u.id, u.display_name
         FROM app_user u
        WHERE u.status = 'active'
          AND ${activeMembershipSql('u.id', '$1', '$2')}
        ORDER BY u.display_name, u.id`,
      [ctx.organizationId, now],
    );
    const items: Array<{
      userId: string;
      displayName: string;
      reason: ResolverFailure;
    }> = [];
    for (const member of members) {
      const result = resolveApprovalRoute({
        organizationId: ctx.organizationId,
        requesterId: member.id,
        definition: { approval: { ruleId: loaded.rule.ruleId } },
        now,
        ruleRoutingEnabled: true,
        rule: loaded.rule,
        selectedApproverId: null,
        snapshot,
      });
      if (!result.ok)
        items.push({
          userId: member.id,
          displayName: member.display_name,
          reason: result.reason,
        });
    }
    return {
      rule: {
        id: loaded.rule.ruleId,
        code: loaded.rule.code,
        revision: loaded.rule.revision,
        active: loaded.rule.active,
      },
      scanned: members.length,
      items,
    };
  }
}

/** カタログ定義の保存時に、同じ組織の有効なルールかを確かめる(WP §4 / §6.1)。 */
export async function activeRuleExists(
  client: pg.PoolClient,
  organizationId: string,
  ruleId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM approval_rule WHERE id = $1 AND organization_id = $2 AND active',
    [ruleId, organizationId],
  );
  return (result.rowCount ?? 0) > 0;
}
