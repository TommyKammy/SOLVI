import type pg from 'pg';
import { z } from 'zod';
import type { CatalogValues } from '@solvi/shared/catalog';
import { Problems, ProblemError, type Logger, type ObjectStorage } from '@solvi/shared';
import { hasRole, requireRole } from '../../common/authz/authz.js';
import { uuidv7, recordAuditEvent } from '../../common/audit/audit.js';
import { TicketService } from '../ticket/ticket.service.js';
import { CollaborationService } from '../ticket/collaboration.service.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  definitionSchema,
  validateValues,
  validateRequestInputs,
  type Definition,
} from './catalog-definition.js';
import { assertApprovalComplete, checkApprovalComplete } from './approval-assertion.js';
import {
  applyApprovalDecision,
  applyReassignment,
  checkRouteAgainstSteps,
  completeApprovalRequest,
  invalidateApprovalSteps,
  routeHash,
  type ApprovalRoute,
  type ApprovalRouteStep,
  type ApprovalStepRow,
  type RequestState,
} from './approval-state.js';
import {
  effectiveAuthorityTypeSql,
  effectiveGenerationForStep,
  effectiveGenerationSql,
  effectiveRouteStep,
  effectiveStepRow,
  isApproverUnavailable,
  approverAvailabilitySql,
  loadRouteState,
  type RouteState,
} from './approval-route-state.js';
import {
  approvalResolutionProblem,
  isActiveMember,
  loadRuleRevision,
  loadUserFacts,
  resolveRouteForRequest,
  resolveRouteRemainderForRequest,
  type ResolverFailure,
} from './approval-resolver.js';
import { canonical, hash } from './snapshot-hash.js';

const uuid = z.string().uuid();
const inputSchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
    durationDays: z.number().finite().optional(),
    // ルールで経路を決める版では使わない(WP §6.1)。ルールを使わない版では従来どおり必須。
    approverId: uuid.optional(),
    values: z
      .record(
        z.union([
          z.string().max(2000),
          z.boolean(),
          z.number().finite(),
          z.array(z.string().max(100)).max(10),
        ]),
      )
      .default({}),
  })
  .strict();
const createSchema = inputSchema.extend({
  itemId: uuid,
  itemVersion: z.number().int().positive(),
  idempotencyKey: uuid,
});
const editSchema = inputSchema.extend({ expectedVersion: z.number().int().positive() });
const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'revoke']),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().max(2000).default(''),
});
/**
 * 再割当の入力 (WP-P4-APR-018 §6-4)。
 * **承認者ID・段・経路を受け取らない。** 未知のキーは 400 にする。
 * 利用者入力は理由だけであり、承認者は固定したルールと現在の組織データからのみ解決する。
 */
const reassignSchema = z
  .object({
    reason: z
      .string({ required_error: '再割当の理由を入力してください' })
      .trim()
      .min(1, '再割当の理由を入力してください')
      .max(2000, '再割当の理由は2000文字以内で入力してください'),
  })
  .strict();
type Snapshot = {
  item: { id: string; version: number; title: string; definition: Definition };
  inputs: { reason?: string; durationDays?: number; values?: CatalogValues };
  requesterId: string;
};
type RequestRow = {
  id: string;
  organization_id: string;
  requester_id: string;
  ticket_id: string;
  version: number;
  revision: number;
  state: RequestState;
  snapshot: Snapshot;
  snapshot_hash: string;
  current_approval_id: string;
};
type RevisionRow = {
  request_id: string;
  organization_id: string;
  revision: number;
  snapshot: Snapshot;
  snapshot_hash: string;
  route: unknown;
  route_hash: unknown;
  route_generation: unknown;
  created_at: Date;
};
type ApprovalRow = ApprovalStepRow;
const approverSql = `SELECT DISTINCT u.id,u.display_name AS name FROM app_user u JOIN role_binding rb ON rb.user_id=u.id JOIN role r ON r.id=rb.role_id
 WHERE rb.organization_id=$1 AND r.code='approver' AND rb.valid_from<=clock_timestamp()
 AND (rb.valid_until IS NULL OR rb.valid_until>clock_timestamp()) AND u.status='active' AND u.id<>$2`;
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}
/** 再割当の再解決失敗を 409 と理由コードで返す(WP-P4-APR-018 §6-4)。 */
function reassignmentProblem(reason: ResolverFailure): ProblemError {
  return new ProblemError({
    status: 409,
    type: 'https://solvi.internal/problems/approval-reassign-unresolved',
    title: '再割当の承認者を解決できません',
    detail: reason.message,
    errors: [
      {
        field: reason.stepNo === undefined ? 'approval' : `approval.steps.${reason.stepNo}`,
        // 画面・テストが分岐に使えるよう、理由のコードを返す(個人データは含めない)。
        message: reason.code,
      },
    ],
  });
}
/**
 * 再割当の条件外を 409 と理由コードで返す。
 * 画面は理由コードから利用者向けの文を組み立てる(APIの日本語をそのまま出さない)。
 * コードの語彙は `apps/web/src/lib/approval-route.ts` の `REASSIGN_REASON_TEXT` と同じ。
 */
export type ReassignConflictCode =
  | 'not_pending'
  | 'legacy_route'
  | 'expired'
  | 'approver_available'
  | 'step_mismatch'
  | 'approver_unchanged'
  | 'concurrent_update';
function reassignConflict(code: ReassignConflictCode, detail: string): ProblemError {
  return new ProblemError({
    status: 409,
    type: 'https://solvi.internal/problems/approval-reassign-conflict',
    title: '再割当できません',
    detail,
    errors: [{ field: 'approval', message: code }],
  });
}
/** 経路解決の拒否。`run` がロールバック後に拒否の監査を書くために運ぶ。 */
class ApprovalRouteDenied extends Error {
  constructor(
    readonly reason: ResolverFailure,
    readonly target: { type: 'catalog_item' | 'service_request'; id: string },
  ) {
    super(reason.message);
    this.name = 'ApprovalRouteDenied';
  }
}
export class CatalogController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly storage: ObjectStorage,
    private readonly enabled: boolean,
    private readonly logger?: Logger,
  ) {}
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw Problems.notFound('ローカル検証機能');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      // 解決不能の監査は業務トランザクションの外に置く(拒否で業務は巻き戻るため)。
      // 同じ接続のロールバック後に独立したトランザクションで書く。
      if (e instanceof ApprovalRouteDenied) {
        await this.recordDenied(c, auth, e.target, e.reason);
        throw approvalResolutionProblem(e.reason);
      }
      throw e;
    } finally {
      c.release();
    }
  }
  /**
   * 読み取り専用のトランザクション。申請前の経路確認だけが使う。
   * 何も書き込まず、監査イベントも書かない(WP-P4-APR-016 §6.1)。
   */
  private async read<T>(
    auth: AuthenticatedRequest,
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw Problems.notFound('ローカル検証機能');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  /**
   * 解決不能の拒否を監査する(02.17 §2.2)。
   * 業務トランザクションは既にロールバック済み。同じ接続で新しいトランザクションを張り、
   * `outcome=denied` と足りない設定の種別だけを残す。拒否の事実を監査失敗で覆さない。
   */
  private async recordDenied(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    target: { type: 'catalog_item' | 'service_request'; id: string },
    reason: ResolverFailure,
  ): Promise<void> {
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org',$1,true)", [auth.authz.organizationId]);
      await recordAuditEvent(c, {
        eventType: 'approval.route.resolved',
        organizationId: auth.authz.organizationId,
        actorType: 'user',
        actorId: auth.userId,
        targetType: target.type,
        targetId: target.id,
        action: 'approval.route.resolved',
        outcome: 'denied',
        policyDecision: {
          reason: reason.code,
          missing: reason.missing,
          stepNo: reason.stepNo ?? null,
        },
        afterState: {
          resolved: false,
          stepNo: reason.stepNo ?? null,
          authorityType: reason.authorityType ?? null,
        },
      });
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      this.logger?.warn('catalog.approval.route.denial_audit_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private staff(auth: AuthenticatedRequest) {
    return hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
  }
  private async event(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
    action: 'submitted' | 'changed' | 'simulated',
    revision: number,
  ) {
    await recordAuditEvent(c, {
      eventType: `request.${action}`,
      organizationId: auth.authz.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'service_request',
      targetId: id,
      action: `request.${action}`,
      outcome: 'success',
      afterState: { revision, simulation: true },
    });
  }
  /**
   * ステップ単位の監査イベント(02.17 §2.1 / WP §6.1)。
   * after には版・経路世代・ステップ番号・段数・権限種別だけを入れ、
   * 申請の入力値・スナップショット本文は載せない。
   */
  private async approvalEvent(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    request: { id: string; organization_id: string },
    eventType:
      'approval.requested' | 'approval.approved' | 'approval.rejected' | 'approval.invalidated',
    step: {
      id: string;
      step_no: number;
      route_generation: number;
      authority_type: string;
    },
    revision: number,
    stepCount: number,
    extra: Record<string, string | number | boolean | null> = {},
  ) {
    await recordAuditEvent(c, {
      eventType,
      organizationId: request.organization_id,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'service_request',
      targetId: request.id,
      action: eventType,
      outcome: 'success',
      approvalRef: step.id,
      afterState: {
        revision,
        routeGeneration: step.route_generation,
        stepNo: step.step_no,
        stepCount,
        authorityType: step.authority_type,
        ...extra,
      },
    });
  }
  private async validateApprover(
    c: pg.PoolClient,
    organizationId: string,
    requesterId: string,
    approverId: string,
  ) {
    if (requesterId === approverId)
      throw Problems.forbidden('自分の申請を承認することはできません');
    if (
      !(await c.query(`${approverSql} AND u.id=$3`, [organizationId, requesterId, approverId]))
        .rowCount
    )
      throw Problems.forbidden('現在有効な同組織の承認者を選んでください');
  }
  /**
   * 申請・変更時に経路を決める**唯一の関数**(WP §6.1 / ADR-0023 §9)。
   *
   * 組織で有効化されていて定義に `ruleId` がある版だけルールで解決し、
   * それ以外は現行互換(固定承認者、無ければ申請者が選んだ承認者)の1段にする。
   * 解決できない場合は例外にし、申請者が選んだ承認者や固定承認者で代用しない。
   */
  private async resolveRoute(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    definition: Definition,
    selectedApproverId: string | null,
    target: { type: 'catalog_item' | 'service_request'; id: string },
  ): Promise<{ route: ApprovalRoute; usingRule: boolean; ruleRoutingEnabled: boolean }> {
    const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const resolution = await resolveRouteForRequest(c, {
      organizationId: auth.authz.organizationId,
      requesterId: auth.userId,
      definition,
      selectedApproverId,
      now,
    });
    const usingRule = resolution.ruleRoutingEnabled && Boolean(definition.approval?.ruleId);
    if (!resolution.ok) throw new ApprovalRouteDenied(resolution.reason, target);
    return {
      route: resolution.route,
      usingRule,
      ruleRoutingEnabled: resolution.ruleRoutingEnabled,
    };
  }
  /**
   * 経路を決めた各版に `approval.route.resolved` を記録する(WP §6.1 / 02.17 §2.2)。
   * after にはルール参照・段数・各段の種別と resolvedFrom だけを入れ、
   * 申請の入力値・個人データは載せない(承認者IDは参照でありPIIではない)。
   */
  private async routeResolvedEvent(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    requestId: string,
    route: ApprovalRoute,
    revision: number,
    ruleRoutingEnabled: boolean,
  ) {
    await recordAuditEvent(c, {
      eventType: 'approval.route.resolved',
      organizationId: auth.authz.organizationId,
      actorType: 'user',
      actorId: auth.userId,
      targetType: 'service_request',
      targetId: requestId,
      action: 'approval.route.resolved',
      outcome: 'success',
      afterState: {
        revision,
        routeGeneration: 1,
        ruleRoutingEnabled,
        ruleId: route.ruleRef?.ruleId ?? null,
        ruleRevision: route.ruleRef?.revision ?? null,
        stepCount: route.steps.length,
        stepTypes: route.steps.map((step) => step.authorityType).join(','),
        resolvedFrom: route.steps.map((step) => step.resolvedFrom ?? '').join(','),
        approverIds: route.steps.map((step) => step.approverId).join(','),
        routeHash: routeHash(route),
      },
    });
  }
  async catalog(auth: AuthenticatedRequest) {
    return this.run(auth, async (c) => ({
      items: (
        await c.query(
          'SELECT id,version,title,description,definition FROM local_catalog_item WHERE organization_id=$1 AND active ORDER BY code',
          [auth.authz.organizationId],
        )
      ).rows,
      approvers: (await c.query(approverSql, [auth.authz.organizationId, auth.userId])).rows,
      canManage: hasRole(auth.authz, 'org_admin', 'platform_admin', 'catalog_editor'),
      simulation: true,
    }));
  }
  /**
   * 申請者自身の経路の確認 (WP-P4-APR-016 §6.1)。
   *
   * 申請者は**ログイン中の本人**だけ。入力に申請者IDを持たず、他人の経路を調べる手段にしない。
   * 公開中(active)の同組織の項目だけを対象にし、見えない項目は404。
   * 何も書き込まず監査も書かない。承認者の表示名だけを返し、役職・勤務地・社員番号・
   * メールアドレス・承認者IDは返さない。
   */
  async approvalRoute(auth: AuthenticatedRequest, itemId: string) {
    parse(uuid, itemId);
    return this.read(auth, async (c) => {
      const item = (
        await c.query<{ id: string; version: number; title: string; definition: unknown }>(
          'SELECT id,version,title,definition FROM local_catalog_item WHERE id=$1 AND organization_id=$2 AND active',
          [itemId, auth.authz.organizationId],
        )
      ).rows[0];
      if (!item) throw Problems.notFound('カタログ');
      const parsed = definitionSchema.safeParse(item.definition);
      if (!parsed.success) throw Problems.conflict('カタログ定義を確認できません');
      const definition = parsed.data;
      const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const resolution = await resolveRouteForRequest(c, {
        organizationId: auth.authz.organizationId,
        requesterId: auth.userId,
        definition,
        // 入力から承認者を受け取らない。申請者が選ぶ方式の候補は既存のカタログAPIが返す。
        selectedApproverId: null,
        now,
        lockRule: false,
      });
      const ruleRoutingEnabled = resolution.ruleRoutingEnabled;
      const usingRule = ruleRoutingEnabled && Boolean(definition.approval?.ruleId);
      const mode = usingRule
        ? 'rule'
        : definition.approval?.approverId
          ? 'fixed'
          : 'requester_selected';
      const base = {
        itemId: item.id,
        itemVersion: item.version,
        mode,
        ruleRoutingEnabled,
      };
      if (!resolution.ok) {
        // 申請者が選ぶ方式は「解決できない」ではなく、従来どおり候補から選ぶ。
        if (
          mode === 'requester_selected' &&
          resolution.reason.code === 'requester_selected_missing'
        )
          return { ...base, resolved: false, rule: null, steps: [] };
        // 失敗時も、どのルールを使おうとしたかを返す(画面が現在の版の定義と照合できるように)。
        // 無効・不在のルールでは rule は null になる。
        return {
          ...base,
          resolved: false,
          rule: resolution.rule
            ? {
                id: resolution.rule.ruleId,
                code: resolution.rule.code,
                revision: resolution.rule.revision,
              }
            : null,
          steps: [],
          reason: resolution.reason,
        };
      }
      const approverIds = resolution.route.steps.map((step) => step.approverId);
      const names = approverIds.length
        ? (
            await c.query<{ id: string; display_name: string }>(
              'SELECT id,display_name FROM app_user WHERE id=ANY($1::uuid[])',
              [approverIds],
            )
          ).rows
        : [];
      return {
        ...base,
        resolved: true,
        rule: resolution.rule
          ? {
              id: resolution.rule.ruleId,
              code: resolution.rule.code,
              revision: resolution.rule.revision,
            }
          : null,
        steps: resolution.route.steps.map((step) => ({
          stepNo: step.stepNo,
          authorityType: step.authorityType,
          approverName: names.find((user) => user.id === step.approverId)?.display_name ?? '承認者',
        })),
      };
    });
  }
  async list(auth: AuthenticatedRequest, query = new URLSearchParams()) {
    const filter = parse(
      z
        .object({
          q: z.string().trim().max(160).default(''),
          state: z
            .enum([
              'all',
              'pending',
              'approved',
              'rejected',
              'invalidated',
              'completed',
              'cancelled',
              'expired',
            ])
            .default('all'),
          view: z.enum(['all', 'mine', 'approvals']).default('all'),
          // 承認者不在の申請だけに絞り込む(組織管理者だけ)。WP §6.1。
          approverUnavailable: z.enum(['0', '1']).default('0'),
          page: z.coerce.number().int().min(1).max(10000).default(1),
        })
        .strict(),
      Object.fromEntries(query),
    );
    return this.run(auth, async (c) => {
      // 承認者不在の絞り込みは組織管理者だけ。機能が無効な環境では 404 を優先する。
      if (filter.approverUnavailable === '1') requireRole(auth.authz, 'org_admin');
      const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const pageSize = 25;
      const values: unknown[] = [auth.authz.organizationId, this.staff(auth), auth.userId, now];
      const expired = "(q.state IN ('pending','approved') AND a.expires_at <= $4::timestamptz)";
      // 現在の承認ステップが属する有効な世代。再割当後は版の route_generation と異なる。
      const effectiveGeneration = effectiveGenerationSql({
        requestId: 'q.id',
        organizationId: 'q.organization_id',
        revision: 'q.revision',
        stepNo: 'a.step_no',
        baseGeneration: 'r.route_generation',
      });
      // 権限種別は有効な世代の経路を優先する。DBの承認行だけを信用しない。
      const authorityType = effectiveAuthorityTypeSql({
        requestId: 'q.id',
        organizationId: 'q.organization_id',
        revision: 'q.revision',
        stepNo: 'a.step_no',
        baseRouteAuthority: `r.route->'steps'->(a.step_no-1)->>'authorityType'`,
        fallback: 'a.authority_type',
      });
      // 承認者不在 = 有効な所属でない、または fixed/legacy で approver ロールが無い。
      // 判定は approval-route-state.ts の共有述語だけを使う(結論をここで書き直さない)。
      const approverAvailable = approverAvailabilitySql({
        organizationId: 'q.organization_id',
        approverId: 'a.approver_id',
        at: '$4',
        authorityType,
        userStatus: 'ap.status',
      });
      const conditions = [
        'q.organization_id=$1',
        '($2::boolean OR q.requester_id=$3 OR a.approver_id=$3)',
      ];
      if (filter.q) {
        values.push('%' + filter.q.replace(/([%_\\])/g, '\\$1') + '%');
        conditions.push(
          `(q.snapshot->'item'->>'title' ILIKE $${values.length} OR t.number ILIKE $${values.length} OR u.display_name ILIKE $${values.length})`,
        );
      }
      if (filter.view === 'mine') conditions.push('q.requester_id=$3');
      if (filter.view === 'approvals')
        // ロールではなく「自分が現在の pending ステップの approver_id である」で決める。
        conditions.push(
          `a.approver_id=$3 AND q.requester_id<>$3 AND q.state='pending' AND a.state='pending' AND NOT ${expired}`,
        );
      if (filter.approverUnavailable === '1') conditions.push(`NOT ${approverAvailable}`);
      if (filter.state === 'expired') conditions.push(expired);
      else if (filter.state !== 'all') {
        values.push(filter.state);
        conditions.push(`q.state=$${values.length}`);
        if (['pending', 'approved'].includes(filter.state)) conditions.push(`NOT ${expired}`);
      }
      // 一覧の項目は「現在のステップ」。現在の版の、その段の有効な世代の行だけを結合する。
      const from = `FROM local_service_request q
        JOIN local_request_revision r ON r.request_id=q.id AND r.organization_id=q.organization_id AND r.revision=q.revision
        JOIN local_request_approval a ON a.id=q.current_approval_id AND a.organization_id=q.organization_id
          AND a.request_id=q.id AND a.revision=q.revision
          AND a.route_generation=${effectiveGeneration}
        JOIN ticket t ON t.id=q.ticket_id AND t.organization_id=q.organization_id
        JOIN app_user u ON u.id=q.requester_id JOIN app_user ap ON ap.id=a.approver_id
        WHERE ${conditions.join(' AND ')}`;
      const total = (
        await c.query<{ total: number }>(
          `SELECT count(*)::int AS total, $4::timestamptz AS as_of ${from}`,
          values,
        )
      ).rows[0]!.total;
      const items = (
        await c.query(
          `SELECT q.id,q.state,q.version,q.snapshot->'item'->>'title' AS title,
          q.created_at AS "createdAt",q.updated_at AS "updatedAt",a.state AS "approvalState",q.ticket_id AS "ticketId",t.number,
          u.display_name AS "requesterName",ap.display_name AS "approverName",a.expires_at AS "expiresAt",
          a.reason AS "decisionReason",q.requester_id=$3 AS own,a.approver_id=$3 AS assigned,${expired} AS expired,
          NOT ${approverAvailable} AS "approverUnavailable"
         ${from} ORDER BY q.updated_at DESC,q.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, pageSize, (filter.page - 1) * pageSize],
        )
      ).rows.map((row) => {
        // 承認者不在は申請者・担当者・組織管理者にだけ返す(理由の詳細・役職は返さない)。
        const { approverUnavailable, ...rest } = row;
        const showUnavailable = row.own || this.staff(auth);
        const unavailable = showUnavailable && approverUnavailable === true;
        const nextAction =
          row.state === 'completed'
            ? '結果を確認する'
            : row.state === 'cancelled'
              ? '取消内容を確認する'
              : row.expired
                ? row.own
                  ? '期限切れの内容を修正して再承認を依頼する'
                  : '申請者の再承認を待っています'
                : ['rejected', 'invalidated'].includes(row.state)
                  ? row.own
                    ? '理由を確認して修正・再申請する'
                    : '申請者の修正を待っています'
                  : row.state === 'pending'
                    ? unavailable
                      ? row.own
                        ? '承認者が不在です。内容を変更して再承認を依頼してください'
                        : '承認者が不在です。申請者に内容の変更を依頼してください'
                      : row.assigned && !row.own
                        ? '内容を確認して承認・却下を判断する'
                        : '承認者の判断を待っています'
                    : row.state === 'approved'
                      ? this.staff(auth)
                        ? '承認内容を確認して模擬実行へ進む'
                        : '担当者の模擬実行を待っています'
                      : '内容を確認する';
        return {
          ...rest,
          ...(showUnavailable ? { approverUnavailable: approverUnavailable === true } : {}),
          nextAction,
        };
      });
      return { items, total, page: filter.page, pageSize, appliedFilter: filter };
    });
  }
  private async lock(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    id: string,
  ): Promise<RequestRow> {
    parse(uuid, id);
    const r = await c.query<RequestRow>(
      'SELECT * FROM local_service_request WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [id, auth.authz.organizationId],
    );
    if (!r.rows[0]) throw Problems.notFound('申請');
    return r.rows[0];
  }
  private async revision(c: pg.PoolClient, q: RequestRow): Promise<RevisionRow> {
    const r = await c.query<RevisionRow>(
      'SELECT * FROM local_request_revision WHERE request_id=$1 AND organization_id=$2 AND revision=$3',
      [q.id, q.organization_id, q.revision],
    );
    if (!r.rows[0]) throw Problems.conflict('申請の版を確認できません');
    return r.rows[0];
  }
  private async approval(c: pg.PoolClient, q: RequestRow): Promise<ApprovalRow> {
    const r = await c.query<ApprovalRow>(
      'SELECT * FROM local_request_approval WHERE id=$1 AND organization_id=$2 AND request_id=$3 AND revision=$4',
      [q.current_approval_id, q.organization_id, q.id, q.revision],
    );
    if (!r.rows[0]) throw Problems.conflict('承認記録を確認できません');
    return r.rows[0];
  }
  /**
   * 現在の版の全ステップ(全世代)。再割当で置き換えられた `invalidated` の行も含む。
   * 「現在の世代の行」だけが必要な表示では、`routeState.currentGeneration` で絞る。
   */
  private async steps(c: pg.PoolClient, q: RequestRow): Promise<ApprovalStepRow[]> {
    return (
      await c.query<ApprovalStepRow>(
        `SELECT * FROM local_request_approval
          WHERE request_id=$1 AND organization_id=$2 AND revision=$3
          ORDER BY route_generation, step_no, id`,
        [q.id, q.organization_id, q.revision],
      )
    ).rows;
  }
  /**
   * 版の列と世代の行から現在の経路を導出する。整合性が取れなければ 409(fail closed)。
   * 決定・変更・取消・再割当・詳細のすべてがこの関数を通る。
   */
  private async routeState(c: pg.PoolClient, q: RequestRow): Promise<RouteState> {
    const result = await loadRouteState(c, {
      organizationId: q.organization_id,
      requestId: q.id,
      revision: q.revision,
    });
    if (!result.ok) {
      this.logger?.warn('catalog.approval.route_state_invalid', {
        organizationId: q.organization_id,
        requestId: q.id,
        reason: result.reason,
      });
      throw Problems.conflict('承認経路が申請版と一致しません');
    }
    return result.state;
  }
  /**
   * 現在の承認ステップが「その段の有効な世代」に属し、前の段が承認済みで、
   * 後ろの段がまだ作られていないことを検証する(決定・再割当で同じ判定を使う)。
   * 有効な世代でない行は、置き換えられた `invalidated` だけを許す。
   */
  private currentStepPosition(
    state: RouteState,
    steps: ApprovalStepRow[],
    current: ApprovalStepRow,
  ): { stepCount: number } {
    const route = state.currentRoute;
    // 移行前(route NULL)の版は1段の legacy だけを許す。
    if (!route) {
      if (
        current.step_no !== 1 ||
        current.route_generation !== 1 ||
        current.authority_type !== 'legacy'
      )
        throw Problems.conflict('承認ステップが申請版と一致しません');
      const others = steps.filter((step) => step.id !== current.id && step.state !== 'invalidated');
      if (others.length > 0) throw Problems.conflict('承認ステップが申請版と一致しません');
      return { stepCount: 1 };
    }
    const stepCount = route.steps.length;
    const generation = effectiveGenerationForStep(state, current.step_no);
    if (generation === null || generation !== current.route_generation)
      throw Problems.conflict('承認ステップが申請版と一致しません');
    const routeStep = route.steps[current.step_no - 1];
    if (
      !routeStep ||
      current.approver_id !== routeStep.approverId ||
      current.authority_type !== routeStep.authorityType
    )
      throw Problems.conflict('承認ステップが申請版と一致しません');
    const effectiveCurrent = effectiveStepRow(state, steps, current.step_no);
    if (!effectiveCurrent || effectiveCurrent.id !== current.id)
      throw Problems.conflict('承認ステップが申請版と一致しません');
    for (let stepNo = 1; stepNo < current.step_no; stepNo += 1) {
      const prior = effectiveStepRow(state, steps, stepNo);
      const priorRouteStep = route.steps[stepNo - 1];
      if (
        !prior ||
        !priorRouteStep ||
        prior.approver_id !== priorRouteStep.approverId ||
        prior.authority_type !== priorRouteStep.authorityType
      )
        throw Problems.conflict('前の承認ステップが申請版と一致しません');
      if (prior.state !== 'approved') throw Problems.conflict('前の承認ステップが完了していません');
    }
    for (let stepNo = current.step_no + 1; stepNo <= stepCount; stepNo += 1) {
      if (effectiveStepRow(state, steps, stepNo))
        throw Problems.conflict('後続の承認ステップが既に存在します');
    }
    for (const step of steps) {
      if (step.state === 'invalidated') continue;
      if (effectiveStepRow(state, steps, step.step_no)?.id === step.id) continue;
      throw Problems.conflict('承認ステップが申請版と一致しません');
    }
    return { stepCount };
  }
  /**
   * 可視性は「申請者・担当者・その版のいずれかのステップの承認者」(WP-P4-APR-014 / ADR-0023 §5)。
   * 現在の1行だけを見ない。再割当で置き換えられた世代の承認者も、その版の承認者として扱う。
   */
  private async visible(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    q: RequestRow,
    revision: RevisionRow,
  ) {
    if (q.requester_id === auth.userId || this.staff(auth)) return;
    const r = await c.query(
      `SELECT 1 FROM local_request_approval
        WHERE request_id=$1 AND organization_id=$2 AND revision=$3
          AND approver_id=$4 LIMIT 1`,
      [q.id, q.organization_id, revision.revision, auth.userId],
    );
    if (!r.rowCount) throw Problems.notFound('申請');
  }
  private async checklistProgress(c: pg.PoolClient, q: RequestRow) {
    return (
      (
        await c.query<{
          version: number;
          completion: Record<
            string,
            { completed: boolean; completedBy: string; completedAt: string }
          >;
        }>(
          'SELECT version,completion FROM local_request_checklist_progress WHERE request_id=$1 AND organization_id=$2 AND request_revision=$3',
          [q.id, q.organization_id, q.revision],
        )
      ).rows[0] ?? { version: 1, completion: {} }
    );
  }
  private async fulfillment(c: pg.PoolClient, auth: AuthenticatedRequest, q: RequestRow) {
    const definition = q.snapshot.item.definition,
      progress = await this.checklistProgress(c, q);
    const owner = definition.ownerId
      ? (
          await c.query('SELECT display_name AS name FROM app_user WHERE id=$1', [
            definition.ownerId,
          ])
        ).rows[0]
      : undefined;
    const group = definition.fulfillmentGroupId
      ? (
          await c.query('SELECT name FROM assignment_group WHERE id=$1 AND organization_id=$2', [
            definition.fulfillmentGroupId,
            q.organization_id,
          ])
        ).rows[0]
      : undefined;
    return {
      ownerName: owner?.name ?? null,
      groupName: group?.name ?? null,
      checklistVersion: progress.version,
      checks: (definition.checklist ?? []).map((item) => ({
        ...item,
        completed: progress.completion[item.key]?.completed === true,
      })),
      canUpdate:
        this.staff(auth) &&
        (await checkApprovalComplete(c, { organizationId: q.organization_id, requestId: q.id })).ok,
    };
  }
  async detail(auth: AuthenticatedRequest, id: string) {
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id),
        revision = await this.revision(c, q),
        a = await this.approval(c, q);
      await this.visible(c, auth, q, revision);
      // 現在の経路は、版の列(世代1)と世代の行から共有関数で導出する。
      const state = await this.routeState(c, q);
      const steps = await this.steps(c, q);
      const currentSteps = steps.filter(
        (step) => step.route_generation === state.currentGeneration,
      );
      const route = state.currentRoute;
      // 承認の経過は「段ごとの有効な世代」の行で作る。承認済みの段は旧世代、
      // 再割当後の段は新世代の行になる。置き換えられた `invalidated` の行は
      // 現在の段として返さない(WP-P4-APR-018 §6-6)。
      const stepCount = route?.steps.length ?? 1;
      const effectiveSteps = Array.from({ length: stepCount }, (_, index) =>
        effectiveStepRow(state, steps, index + 1),
      ).filter((step): step is ApprovalStepRow => step !== null);
      const nameIds = [
        ...new Set([
          q.requester_id,
          ...steps.map((step) => step.approver_id),
          ...(route?.steps.map((step) => step.approverId) ?? []),
          // 再割当の実行者の表示名(世代の行の created_by)。
          ...state.generations.map((generation) => generation.createdBy),
        ]),
      ];
      const names = (
        await c.query<{ id: string; display_name: string }>(
          'SELECT id,display_name FROM app_user WHERE id=ANY($1::uuid[])',
          [nameIds],
        )
      ).rows;
      // 現在の pending ステップの承認者が、いま決定できる状態かを導出する
      // (一覧の approverUnavailable と同じ共有述語)。申請者本人にだけ返す。
      // 他の閲覧者(担当者・承認者)には、不要な所属の照会も行わない。
      const routeStep = effectiveRouteStep(state, a.step_no);
      const authorityType = routeStep?.authorityType ?? a.authority_type;
      let approverUnavailable = false;
      if (q.requester_id === auth.userId && a.state === 'pending') {
        const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
        approverUnavailable = await isApproverUnavailable(c, {
          organizationId: q.organization_id,
          approverId: a.approver_id,
          authorityType,
          now,
        });
      }
      const stepView = (step: ApprovalStepRow) => ({
        id: step.id,
        stepNo: step.step_no,
        state: step.state,
        approverId: step.approver_id,
        approverName: names.find((u) => u.id === step.approver_id)?.display_name ?? '承認者',
        authorityType: step.authority_type,
        resolvedFrom: step.resolved_from,
        reason: step.reason,
        decidedAt: step.decided_at,
        decidedBy: step.decided_by,
        expiresAt: step.expires_at,
        routeGeneration: step.route_generation,
      });
      // 承認の記録(全版・全世代)。再割当で無効になった行は、同じ段の次の世代が
      // あることで判別できる(append-only の世代の行だけを使い、推測しない)。
      const history = (
        await c.query<{
          id: string;
          state: string;
          revision: number;
          routeGeneration: number;
          stepNo: number;
          authorityType: string;
          approverId: string;
          approverName: string;
          reason: string | null;
          decidedAt: Date | null;
          expiresAt: Date;
          invalidatedByReassign: boolean;
          inputs: unknown;
          item: unknown;
        }>(
          `SELECT a.id,a.state,a.revision,a.route_generation AS "routeGeneration",a.step_no AS "stepNo",a.authority_type AS "authorityType",a.approver_id AS "approverId",u.display_name AS "approverName",a.reason,a.decided_at AS "decidedAt",a.expires_at AS "expiresAt",r.snapshot->'inputs' AS inputs,r.snapshot->'item' AS item,
             EXISTS (
               SELECT 1 FROM local_request_route_generation g
                WHERE g.request_id=a.request_id AND g.organization_id=a.organization_id
                  AND g.revision=a.revision AND g.route_generation=a.route_generation+1
                  AND g.from_step_no=a.step_no
             ) AS "invalidatedByReassign"
             FROM local_request_approval a JOIN local_request_revision r ON r.request_id=a.request_id AND r.organization_id=a.organization_id AND r.revision=a.revision JOIN app_user u ON u.id=a.approver_id
             WHERE a.request_id=$1 AND a.organization_id=$2 ORDER BY a.revision,a.route_generation,a.step_no`,
          [id, q.organization_id],
        )
      ).rows;
      return {
        requesterName: names.find((u) => u.id === q.requester_id)?.display_name ?? '申請者',
        approverName: names.find((u) => u.id === a.approver_id)?.display_name ?? '承認者',
        request: {
          id: q.id,
          state: q.state,
          version: q.version,
          revision: q.revision,
          snapshot: q.snapshot,
          snapshotHash: q.snapshot_hash,
          requesterId: q.requester_id,
          ticketId: q.ticket_id,
        },
        approval: a,
        // 現在の版の現在の経路世代の全ステップ(加算的な追加。既存の approval/history の形は変えない)
        steps: currentSteps.map(stepView),
        // 段ごとの有効な世代のステップ(加算的)。承認の経過の表示に使う。
        effectiveSteps: effectiveSteps.map(stepView),
        // 未作成の後続段も含む現在の経路(加算的な読み取り。認可・検証・状態遷移は変えない)。
        // 表示名だけを返し、役職・勤務地・社員番号は返さない。
        route: route
          ? {
              steps: route.steps.map((step) => ({
                stepNo: step.stepNo,
                approverId: step.approverId,
                approverName: names.find((u) => u.id === step.approverId)?.display_name ?? '承認者',
                authorityType: step.authorityType,
                resolvedFrom: step.resolvedFrom,
              })),
              ruleRef: route.ruleRef,
            }
          : null,
        // 再割当の記録(加算的)。世代1は版の列、2以降は追記専用の世代の行。
        // 無効になったステップと新しい承認者は、その世代の経路と1つ前の世代の行から決まる。
        currentRouteGeneration: state.currentGeneration,
        routeGenerations: [
          ...(state.baseRoute
            ? [
                {
                  routeGeneration: 1,
                  fromStepNo: 1,
                  routeHash: state.baseRouteHash,
                  reason: null,
                  createdBy: null,
                  createdByName: null,
                  createdAt: revision.created_at,
                  newApproverName: null,
                  invalidatedStepNo: null,
                  invalidatedApproverName: null,
                },
              ]
            : []),
          ...state.generations.map((generation) => {
            const newApproverId =
              generation.route.steps[generation.fromStepNo - 1]?.approverId ?? null;
            const invalidated = history.find(
              (row) =>
                row.revision === q.revision &&
                row.routeGeneration === generation.generation - 1 &&
                row.stepNo === generation.fromStepNo &&
                row.state === 'invalidated',
            );
            return {
              routeGeneration: generation.generation,
              fromStepNo: generation.fromStepNo,
              routeHash: generation.routeHash,
              reason: generation.reason,
              createdBy: generation.createdBy,
              createdByName:
                names.find((u) => u.id === generation.createdBy)?.display_name ?? '実行者',
              createdAt: generation.createdAt,
              newApproverName: newApproverId
                ? (names.find((u) => u.id === newApproverId)?.display_name ?? '承認者')
                : null,
              invalidatedStepNo: generation.fromStepNo,
              invalidatedApproverName: invalidated?.approverName ?? null,
            };
          }),
        ],
        approverUnavailable,
        history,
        receipt:
          (
            await c.query(
              'SELECT id,result,simulation,started_at AS "startedAt",finished_at AS "finishedAt",idempotency_key AS "idempotencyKey",snapshot_hash AS "snapshotHash" FROM local_simulation_receipt WHERE request_id=$1 AND organization_id=$2',
              [id, q.organization_id],
            )
          ).rows[0] ?? null,
        approvers: (await c.query(approverSql, [q.organization_id, q.requester_id])).rows,
        fulfillment: await this.fulfillment(c, auth, q),
        simulation: true,
      };
    });
  }
  /** 新しい版と最初のステップを保存する。経路は版に固定する。 */
  private async addRevisionAndStep(
    c: pg.PoolClient,
    auth: AuthenticatedRequest,
    q: RequestRow,
    revision: number,
    snapshot: Snapshot,
    snapshotHash: string,
    route: ApprovalRoute,
    approvalId: string,
    step: ApprovalRouteStep,
  ) {
    await c.query(
      'INSERT INTO local_request_revision(request_id,organization_id,revision,snapshot,snapshot_hash,changed_by,route,route_hash,route_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)',
      [
        q.id,
        q.organization_id,
        revision,
        snapshot,
        snapshotHash,
        auth.userId,
        route,
        routeHash(route),
      ],
    );
    await c.query(
      "INSERT INTO local_request_approval(id,organization_id,request_id,revision,route_generation,step_no,snapshot_hash,approver_id,authority_type,resolved_from,state,expires_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,'pending',clock_timestamp()+interval '72 hours')",
      [
        approvalId,
        q.organization_id,
        q.id,
        revision,
        step.stepNo,
        snapshotHash,
        step.approverId,
        step.authorityType,
        step.resolvedFrom,
      ],
    );
  }
  async create(auth: AuthenticatedRequest, value: unknown) {
    const input = parse(createSchema, value);
    return this.run(auth, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${auth.authz.organizationId}:${auth.userId}:${input.idempotencyKey}`,
      ]);
      const previous = (
        await c.query<RequestRow>(
          'SELECT * FROM local_service_request WHERE organization_id=$1 AND requester_id=$2 AND idempotency_key=$3',
          [auth.authz.organizationId, auth.userId, input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        const originalRevision = (
          await c.query<RevisionRow>(
            'SELECT * FROM local_request_revision WHERE request_id=$1 AND organization_id=$2 AND revision=1',
            [previous.id, previous.organization_id],
          )
        ).rows[0];
        if (!originalRevision) throw Problems.conflict('同じ送信キーの申請を確認できません');
        const original = originalRevision.snapshot;
        // 経路の同一性は route_hash で判定する(移行前の route NULL は従来の1行比較)。
        if (originalRevision.route_generation !== 1)
          throw Problems.conflict('同じ送信キーで異なる申請内容は送信できません');
        const originalSteps = (
          await c.query<ApprovalStepRow>(
            `SELECT * FROM local_request_approval
              WHERE request_id=$1 AND organization_id=$2 AND revision=1 AND route_generation=1
              ORDER BY step_no, id`,
            [previous.id, previous.organization_id],
          )
        ).rows;
        const routeCheck = checkRouteAgainstSteps({
          route: originalRevision.route,
          routeHash: originalRevision.route_hash,
          routeGeneration: originalRevision.route_generation,
          revision: 1,
          steps: originalSteps,
          allowPartial: true,
        });
        if (!routeCheck.ok) throw Problems.conflict('同じ送信キーの承認経路を確認できません');
        if (routeCheck.route === null) {
          if (
            originalSteps.length !== 1 ||
            !input.approverId ||
            originalSteps[0]!.approver_id !== input.approverId
          )
            throw Problems.conflict('同じ送信キーで異なる申請内容は送信できません');
        } else if (routeCheck.route.ruleRef === null) {
          // ルールを使わない版は、従来どおり入力の承認者が経路の承認者と一致すること。
          if (!input.approverId || routeCheck.route.steps[0]?.approverId !== input.approverId)
            throw Problems.conflict('同じ送信キーで異なる申請内容は送信できません');
        }
        // ルールで決めた版は、入力の approverId を経路決定に使っていない。
        // そのため approverId の違いだけを「別の申請内容」とみなさない(WP §6.1)。
        const normalized = validateRequestInputs(original.item.definition, input);
        if (
          original.item.id !== input.itemId ||
          original.item.version !== input.itemVersion ||
          original.inputs.reason !== normalized.reason ||
          original.inputs.durationDays !== normalized.durationDays ||
          canonical(original.inputs.values ?? {}) !==
            canonical(validateValues(original.item.definition, input.values))
        )
          throw Problems.conflict('同じ送信キーで異なる申請内容は送信できません');
        return { id: previous.id, ticketId: previous.ticket_id, replayed: true };
      }
      const item = (
        await c.query<{ id: string; version: number; title: string; definition: unknown }>(
          'SELECT * FROM local_catalog_item WHERE id=$1 AND organization_id=$2 AND active FOR SHARE',
          [input.itemId, auth.authz.organizationId],
        )
      ).rows[0];
      if (!item) throw Problems.notFound('カタログ');
      if (item.version !== input.itemVersion)
        throw Problems.conflict('カタログが更新されました。画面を更新してください');
      const definition = parse(definitionSchema, item.definition);
      if (
        definition.fulfillmentGroupId &&
        !(
          await c.query(
            'SELECT id FROM assignment_group WHERE id=$1 AND organization_id=$2 AND active FOR SHARE',
            [definition.fulfillmentGroupId, auth.authz.organizationId],
          )
        ).rowCount
      )
        throw Problems.validation([
          {
            field: 'fulfillmentGroupId',
            message: '処理グループが現在有効ではありません。担当者へ確認してください',
          },
        ]);
      const inputs = validateRequestInputs(definition, input);
      const values = validateValues(definition, input.values);
      const { route, usingRule, ruleRoutingEnabled } = await this.resolveRoute(
        c,
        auth,
        definition,
        input.approverId ?? null,
        { type: 'catalog_item', id: item.id },
      );
      if (!usingRule) {
        // ルールを使わない版では、従来どおり入力の承認者を必須とし、
        // 固定承認者が設定されていれば変更を拒否する。
        if (!input.approverId)
          throw Problems.validation([{ field: 'approverId', message: '承認者を選んでください' }]);
        if (definition.approval?.approverId && definition.approval.approverId !== input.approverId)
          throw Problems.forbidden('設定された固定承認者を変更できません');
      }
      const snapshot: Snapshot = {
        item: { id: item.id, version: item.version, title: item.title, definition },
        inputs: {
          ...inputs,
          ...(definition.fields ? { values } : {}),
        },
        requesterId: auth.userId,
      };
      const firstStep = route.steps[0]!;
      const ticket = await new TicketService(c).create(
        auth.authz,
        {
          kind: 'request',
          subject: item.title,
          body: [
            'ローカル模擬申請（外部変更なし）',
            ...(inputs.durationDays === undefined ? [] : [`利用日数: ${inputs.durationDays}`]),
            ...(inputs.reason === undefined ? [] : [`理由: ${inputs.reason}`]),
          ].join('\n'),
          impact: 'low',
          urgency: 'low',
        },
        definition.fulfillmentGroupId
          ? { groupId: definition.fulfillmentGroupId, itemId: item.id, revision: item.version }
          : undefined,
      );
      const q: RequestRow = {
        id: uuidv7(),
        organization_id: auth.authz.organizationId,
        requester_id: auth.userId,
        ticket_id: ticket.id,
        version: 1,
        revision: 1,
        state: 'pending',
        snapshot,
        snapshot_hash: hash(snapshot),
        current_approval_id: uuidv7(),
      };
      await c.query(
        'INSERT INTO local_service_request(id,organization_id,item_id,requester_id,ticket_id,idempotency_key,version,revision,state,snapshot,snapshot_hash,current_approval_id) VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10)',
        [
          q.id,
          q.organization_id,
          item.id,
          q.requester_id,
          ticket.id,
          input.idempotencyKey,
          q.state,
          snapshot,
          q.snapshot_hash,
          q.current_approval_id,
        ],
      );
      await this.addRevisionAndStep(
        c,
        auth,
        q,
        1,
        snapshot,
        q.snapshot_hash,
        route,
        q.current_approval_id,
        firstStep,
      );
      await this.routeResolvedEvent(c, auth, q.id, route, 1, ruleRoutingEnabled);
      await this.event(c, auth, q.id, 'submitted', 1);
      await this.approvalEvent(
        c,
        auth,
        q,
        'approval.requested',
        {
          id: q.current_approval_id,
          step_no: firstStep.stepNo,
          route_generation: 1,
          authority_type: firstStep.authorityType,
        },
        1,
        route.steps.length,
        { requestState: 'pending' },
      );
      return { id: q.id, ticketId: ticket.id, replayed: false };
    });
  }
  async edit(auth: AuthenticatedRequest, id: string, value: unknown) {
    const input = parse(editSchema, value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id);
      if (q.requester_id !== auth.userId) throw Problems.notFound('申請');
      if (q.version !== input.expectedVersion) throw Problems.stale('申請');
      // 変更を受け付けるのは pending / approved / rejected / invalidated。完了と取下げだけを拒否する
      // (承認取消・却下・期限切れの申請は、理由を確認して修正・再申請できる。WP §6.1 / 03.5)。
      if (['completed', 'cancelled'].includes(q.state))
        throw Problems.conflict('完了・取下げ済みの申請は変更できません');
      const definition = parse(definitionSchema, q.snapshot.item.definition);
      const inputs = validateRequestInputs(definition, input);
      const values = validateValues(definition, input.values);

      // 現在の経路(全世代)の整合性を先に検証する。この版の全ステップを無効化する。
      const state = await this.routeState(c, q);
      const stepCount = state.currentRoute?.steps.length ?? 1;
      const currentSteps = await this.steps(c, q);

      const nextRevision = q.revision + 1;
      const nextSnapshot: Snapshot = {
        ...q.snapshot,
        inputs: {
          ...inputs,
          ...(definition.fields ? { values } : {}),
        },
      };
      const nextSnapshotHash = hash(nextSnapshot);
      const { route, usingRule, ruleRoutingEnabled } = await this.resolveRoute(
        c,
        auth,
        definition,
        input.approverId ?? null,
        { type: 'service_request', id },
      );
      if (!usingRule) {
        if (!input.approverId)
          throw Problems.validation([{ field: 'approverId', message: '承認者を選んでください' }]);
        if (definition.approval?.approverId && definition.approval.approverId !== input.approverId)
          throw Problems.forbidden('この申請版の固定承認者を変更できません');
      }
      const firstStep = route.steps[0]!;
      const nextApprovalId = uuidv7();
      const invalidated = await invalidateApprovalSteps(c, {
        request: q,
        steps: currentSteps,
        trigger: 'edit',
        reason: '申請内容の変更による再承認',
        next: {
          snapshot: nextSnapshot,
          snapshotHash: nextSnapshotHash,
          revision: nextRevision,
          currentApprovalId: nextApprovalId,
        },
      });
      await this.addRevisionAndStep(
        c,
        auth,
        q,
        nextRevision,
        nextSnapshot,
        nextSnapshotHash,
        route,
        nextApprovalId,
        firstStep,
      );
      await this.routeResolvedEvent(c, auth, id, route, nextRevision, ruleRoutingEnabled);
      await this.event(c, auth, id, 'changed', nextRevision);
      for (const step of invalidated.invalidated)
        await this.approvalEvent(c, auth, q, 'approval.invalidated', step, q.revision, stepCount, {
          cause: 'request_changed',
          requestState: invalidated.requestState,
        });
      await this.approvalEvent(
        c,
        auth,
        q,
        'approval.requested',
        {
          id: nextApprovalId,
          step_no: firstStep.stepNo,
          route_generation: 1,
          authority_type: firstStep.authorityType,
        },
        nextRevision,
        route.steps.length,
        { requestState: 'pending' },
      );
      return { id, version: q.version + 1 };
    });
  }
  async decide(auth: AuthenticatedRequest, id: string, value: unknown) {
    const input = parse(decisionSchema, value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id),
        revision = await this.revision(c, q),
        a = await this.approval(c, q);
      await this.visible(c, auth, q, revision);
      // 現在の経路は、版の列(世代1)と世代の行から共有関数で導出する。
      const state = await this.routeState(c, q);
      const steps = await this.steps(c, q);
      if (input.decision === 'revoke') {
        if (q.requester_id === auth.userId)
          throw Problems.forbidden('自己承認・自己決定はできません');
        if (q.version !== input.expectedVersion) throw Problems.stale('申請');
        if (q.state !== 'approved') throw Problems.conflict('承認済みの申請だけ取り消せます');
        // 全段が有効な世代で承認済みであることを実行前検証と同じ関数で確かめる。
        const complete = await checkApprovalComplete(c, {
          organizationId: q.organization_id,
          requestId: q.id,
        });
        if (!complete.ok) throw Problems.conflict('承認済みの申請だけ取り消せます');
        if (
          !hasRole(auth.authz, 'org_admin', 'platform_admin') &&
          !steps.some((step) => step.state === 'approved' && step.approver_id === auth.userId)
        )
          throw Problems.forbidden();
        if (!input.reason)
          throw Problems.validation([{ field: 'reason', message: '取消理由を入力してください' }]);
        // 既に無効化済みの旧世代の行は更新しない(監査も重ねない)。
        const invalidated = await invalidateApprovalSteps(c, {
          request: q,
          steps: steps.filter((step) => step.state !== 'invalidated'),
          trigger: 'revoke',
          reason: input.reason,
        });
        const stepCount = state.currentRoute?.steps.length ?? 1;
        for (const step of invalidated.invalidated)
          await this.approvalEvent(
            c,
            auth,
            q,
            'approval.invalidated',
            step,
            q.revision,
            stepCount,
            { cause: 'revoked', requestState: invalidated.requestState },
          );
        return { id };
      }

      const route = state.currentRoute;
      // 現在のステップが、その段の有効な世代の行であること(再割当で置き換えられていない)。
      const { stepCount } = this.currentStepPosition(state, steps, a);

      // 権限種別は、DBの承認行と現在の経路の**両方**を照合した後の値だけを使う。
      const routeStep = effectiveRouteStep(state, a.step_no);
      const authorityType = routeStep?.authorityType ?? 'legacy';

      // 1. 決定者が現在のステップの approver_id と一致する。
      if (a.approver_id !== auth.userId)
        throw Problems.forbidden('指定された承認者だけが決定できます');
      // 3. 決定者が申請者本人でない。
      if (q.requester_id === auth.userId)
        throw Problems.forbidden('自己承認・自己決定はできません');
      // 4. ステップが pending で期限内、かつ現在の経路世代に属する。
      //    期限の判定はDBの現在時刻で行う(アプリ時計を信用しない)。
      const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      if (q.version !== input.expectedVersion) throw Problems.stale('申請');
      if (q.state !== 'pending' || a.state !== 'pending')
        throw Problems.conflict('承認待ちではないか、承認期限が過ぎています');
      if (!(a.expires_at instanceof Date) || a.expires_at.getTime() <= now.getTime())
        throw Problems.conflict('承認待ちではないか、承認期限が過ぎています');
      // 5. revision / snapshot_hash / route_hash の一致(route_hash は routeState が見る)。
      if (
        a.snapshot_hash !== q.snapshot_hash ||
        hash(q.snapshot) !== q.snapshot_hash ||
        revision.snapshot_hash !== q.snapshot_hash ||
        a.revision !== q.revision
      )
        throw Problems.conflict('申請内容のハッシュが承認対象と一致しません');
      if (
        revision.route === null &&
        q.snapshot.item.definition.approval &&
        q.snapshot.item.definition.approval.approverId !== a.approver_id
      )
        throw Problems.conflict('固定承認者が申請版と一致しません');

      // 2. 決定者が有効な所属である / 6. fixed・legacy は approver ロールを持つ。
      //    関係ベース(manager / department_head)は approver ロールを要求しない。
      //    どちらも毎回DBの現在の値で検証する。
      if (authorityType === 'fixed' || authorityType === 'legacy') {
        requireRole(auth.authz, 'approver');
        await this.validateApprover(c, q.organization_id, q.requester_id, a.approver_id);
      } else {
        // 所属の有効性はDBの現在時刻で判定する(アプリ時計を信用しない / ADR-0023 §1)。
        const facts = await loadUserFacts(c, q.organization_id, [a.approver_id], now);
        if (!isActiveMember(facts.get(a.approver_id)))
          throw Problems.forbidden('現在有効な所属の承認者だけが決定できます');
      }

      const isFinalStep = a.step_no === stepCount;
      const nextRouteStep = isFinalStep ? null : (route?.steps[a.step_no] ?? null);
      const nextRouteGeneration = isFinalStep
        ? null
        : effectiveGenerationForStep(state, a.step_no + 1);
      if (!isFinalStep && (!nextRouteStep || nextRouteGeneration === null))
        throw Problems.conflict('次の承認ステップを確認できません');

      if (input.decision === 'reject' && !input.reason)
        throw Problems.validation([{ field: 'reason', message: '却下理由を入力してください' }]);

      const result = await applyApprovalDecision(c, {
        request: q,
        step: a,
        decision: input.decision,
        isFinalStep,
        reason: input.reason || null,
        actorId: auth.userId,
        nextStep: nextRouteStep,
        nextRouteGeneration,
      });
      await this.approvalEvent(
        c,
        auth,
        q,
        result.stepState === 'approved' ? 'approval.approved' : 'approval.rejected',
        a,
        q.revision,
        stepCount,
        {
          requestState: result.requestState,
          finalStep: isFinalStep,
        },
      );
      if (result.nextStepId && nextRouteStep && nextRouteGeneration !== null)
        await this.approvalEvent(
          c,
          auth,
          q,
          'approval.requested',
          {
            id: result.nextStepId,
            step_no: nextRouteStep.stepNo,
            route_generation: nextRouteGeneration,
            authority_type: nextRouteStep.authorityType,
          },
          q.revision,
          stepCount,
          { requestState: 'pending' },
        );
      // `state` は従来どおり**申請**の状態(途中ステップの承認なら pending)。
      // ステップの状態は `stepState` として加算する。
      return { id, state: result.requestState, stepState: result.stepState };
    });
  }
  /**
   * 承認者不在の申請を再割当する (WP-P4-APR-018 §6-4 / ADR-0024 §3)。
   *
   * - `org_admin` だけ。**申請者本人は org_admin でも拒否する**(403)。
   * - 対象は、承認ルールで決めた経路で、現在の pending ステップの承認者が
   *   承認者不在(ADR-0023 §2 を満たさない)の申請だけ。それ以外は 409。
   * - 承認者のID・段・経路は入力で受け取らない。申請時に固定したルールの版と
   *   現時点の組織データから、現在のステップ以降だけを解決する。
   * - 申請の行をロックし、決定・再割当と直列化する。監査の書込みに失敗したら全体を失敗させる。
   */
  async reassign(auth: AuthenticatedRequest, id: string, value: unknown) {
    // 認可を広げない。再割当を許すのは org_admin だけである。
    requireRole(auth.authz, 'org_admin');
    const input = parse(reassignSchema, value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id);
      // 申請者本人は org_admin であっても再割当できない(T-26 / ADR-0024 §3)。
      if (q.requester_id === auth.userId)
        throw Problems.forbidden('自分の申請を再割当することはできません');
      const revision = await this.revision(c, q);
      const a = await this.approval(c, q);
      const state = await this.routeState(c, q);
      const route = state.currentRoute;
      if (q.state !== 'pending' || a.state !== 'pending')
        throw reassignConflict('not_pending', '承認待ちの申請だけ再割当できます');
      // ルールを使わない経路(固定承認者・申請者選択)は再割当の対象外(WP §5)。
      if (revision.route === null || route === null || route.ruleRef === null)
        throw reassignConflict('legacy_route', '承認ルールを使わない経路は再割当できません');
      const now = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      if (!(a.expires_at instanceof Date) || a.expires_at.getTime() <= now.getTime())
        throw reassignConflict('expired', '承認期限が過ぎています。申請者による再申請が必要です');
      const steps = await this.steps(c, q);
      // 現在のステップが有効な世代に属し、前の段が承認済みであること。
      const { stepCount } = this.currentStepPosition(state, steps, a);
      const routeStep = effectiveRouteStep(state, a.step_no);
      const authorityType = routeStep?.authorityType ?? a.authority_type;
      // 承認者不在の判定は、滞留の導出と同じ共有述語を使う(判定を二重に書かない)。
      const unavailable = await isApproverUnavailable(c, {
        organizationId: q.organization_id,
        approverId: a.approver_id,
        authorityType,
        now,
      });
      if (!unavailable)
        throw reassignConflict('approver_available', '現在の承認者は有効なため再割当できません');

      // 申請時に固定したルールの版(経路が指すもの)を使う。現在の版へ読み替えない。
      const ruleRef = route.ruleRef;
      const loaded = await loadRuleRevision(c, q.organization_id, ruleRef.ruleId, ruleRef.revision);
      if (loaded.state !== 'ok')
        throw reassignmentProblem({
          code: loaded.state === 'missing' ? 'rule_unavailable' : 'rule_invalid',
          message: '申請時に固定した承認ルールの版を確認できません',
          missing: 'rule',
        });
      const resolution = await resolveRouteRemainderForRequest(c, {
        organizationId: q.organization_id,
        requesterId: q.requester_id,
        rule: loaded.rule,
        fromStepNo: a.step_no,
        prefix: route.steps.slice(0, a.step_no - 1),
        now,
      });
      if (!resolution.ok) throw reassignmentProblem(resolution.reason);
      // 段数は固定したルールの版で決まる。変わっていれば経路を保存しない。
      if (resolution.route.steps.length !== route.steps.length)
        throw reassignConflict('step_mismatch', '再割当後の承認経路を確認できません');
      const newStep = resolution.route.steps[a.step_no - 1]!;
      if (newStep.stepNo !== a.step_no || newStep.approverId === a.approver_id)
        throw reassignConflict('approver_unchanged', '再割当後の承認者が現在の承認者と同じです');
      const nextGeneration = state.currentGeneration + 1;

      // 世代の行を追記する(版は書き換えない)。
      try {
        await c.query(
          `INSERT INTO local_request_route_generation(
             request_id, organization_id, revision, route_generation, from_step_no,
             route, route_hash, reason, created_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            q.id,
            q.organization_id,
            q.revision,
            nextGeneration,
            a.step_no,
            resolution.route,
            resolution.routeHash,
            input.reason,
            auth.userId,
          ],
        );
      } catch (error) {
        // 同時実行で世代が二重に作られた場合は 500 ではなく 409 にする。
        if ((error as { code?: string }).code === '23505')
          throw reassignConflict(
            'concurrent_update',
            '承認経路が同時に更新されました。申請を再読み込みしてください',
          );
        throw error;
      }

      const result = await applyReassignment(c, {
        request: q,
        step: a,
        nextStep: newStep,
        nextRouteGeneration: nextGeneration,
        reason: input.reason,
        actorId: auth.userId,
      });

      await this.approvalEvent(c, auth, q, 'approval.invalidated', a, q.revision, stepCount, {
        cause: 'reassigned',
        requestState: result.requestState,
      });
      await recordAuditEvent(c, {
        eventType: 'approval.reassigned',
        organizationId: q.organization_id,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'service_request',
        targetId: q.id,
        action: 'approval.reassigned',
        outcome: 'success',
        approvalRef: result.newApprovalId,
        afterState: {
          revision: q.revision,
          fromRouteGeneration: state.currentGeneration,
          toRouteGeneration: nextGeneration,
          fromStepNo: a.step_no,
          stepCount,
          ruleId: ruleRef.ruleId,
          ruleRevision: ruleRef.revision,
          invalidatedApprovalId: a.id,
          invalidatedStepNo: a.step_no,
          invalidatedApproverId: a.approver_id,
          newApprovalId: result.newApprovalId,
          newStepNo: newStep.stepNo,
          newApproverId: newStep.approverId,
          authorityType: newStep.authorityType,
          reason: input.reason,
        },
      });
      await this.approvalEvent(
        c,
        auth,
        q,
        'approval.requested',
        {
          id: result.newApprovalId,
          step_no: newStep.stepNo,
          route_generation: nextGeneration,
          authority_type: newStep.authorityType,
        },
        q.revision,
        stepCount,
        { requestState: 'pending' },
      );
      return {
        id,
        version: q.version + 1,
        routeGeneration: nextGeneration,
        fromStepNo: a.step_no,
        invalidatedApprovalId: a.id,
        approvalId: result.newApprovalId,
        stepNo: newStep.stepNo,
        approverId: newStep.approverId,
      };
    });
  }
  async updateChecklist(auth: AuthenticatedRequest, id: string, value: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(
      z
        .object({
          requestRevision: z.number().int().positive(),
          expectedVersion: z.number().int().positive(),
          key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          completed: z.boolean(),
        })
        .strict(),
      value,
    );
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id);
      if (q.revision !== input.requestRevision) throw Problems.stale('申請の作業チェック');
      await assertApprovalComplete(
        c,
        { organizationId: q.organization_id, requestId: q.id },
        this.logger,
      );
      if (!(q.snapshot.item.definition.checklist ?? []).some((item) => item.key === input.key))
        throw Problems.validation([
          { field: 'key', message: '申請時の定義にある作業項目を選んでください' },
        ]);
      const progress = await this.checklistProgress(c, q);
      if (progress.version !== input.expectedVersion) throw Problems.stale('作業チェック');
      const nextVersion = progress.version + 1;
      const completion = {
        ...progress.completion,
        [input.key]: {
          completed: input.completed,
          completedBy: auth.userId,
          completedAt: new Date().toISOString(),
        },
      };
      await c.query(
        'INSERT INTO local_request_checklist_progress(request_id,organization_id,request_revision,version,completion,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id,organization_id,request_revision) DO UPDATE SET version=EXCLUDED.version,completion=EXCLUDED.completion,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()',
        [q.id, q.organization_id, q.revision, nextVersion, completion, auth.userId],
      );
      await recordAuditEvent(c, {
        eventType: 'request.checklist.updated',
        organizationId: q.organization_id,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'service_request',
        targetId: q.id,
        action: 'request.checklist.updated',
        outcome: 'success',
        beforeState: {
          requestRevision: q.revision,
          checklistVersion: progress.version,
          key: input.key,
          completed: progress.completion[input.key]?.completed === true,
        },
        afterState: {
          requestRevision: q.revision,
          checklistVersion: nextVersion,
          key: input.key,
          completed: input.completed,
        },
      });
      return { id, checklistVersion: nextVersion };
    });
  }
  async simulate(auth: AuthenticatedRequest, id: string, value: unknown) {
    requireRole(auth.authz, 'agent', 'org_admin', 'platform_admin');
    const input = parse(z.object({ expectedVersion: z.number().int().positive() }), value);
    return this.run(auth, async (c) => {
      const q = await this.lock(c, auth, id);
      const existing = (
        await c.query(
          'SELECT id,result FROM local_simulation_receipt WHERE request_id=$1 AND organization_id=$2',
          [id, q.organization_id],
        )
      ).rows[0];
      if (existing) return { receipt: existing, replayed: true };
      if (q.version !== input.expectedVersion) throw Problems.stale('申請');
      const steps = await assertApprovalComplete(
        c,
        { organizationId: q.organization_id, requestId: q.id },
        this.logger,
      );
      const finalStep = steps[steps.length - 1]!;
      const definition = parse(definitionSchema, q.snapshot.item.definition);
      validateRequestInputs(definition, q.snapshot.inputs);
      validateValues(definition, q.snapshot.inputs.values ?? {});
      const progress = await this.checklistProgress(c, q);
      if (
        (definition.checklist ?? []).some(
          (item) => item.required && progress.completion[item.key]?.completed !== true,
        )
      )
        throw Problems.conflict('必須の作業チェックを完了してから模擬実行してください');
      const key = hash({
        requestId: id,
        revision: q.revision,
        step: 'local-simulation',
        action: definition.action,
        target: definition.targetLabel,
        subject: q.requester_id,
      });
      const receiptId = uuidv7();
      const result = {
        mode: 'local_simulation',
        status: 'succeeded',
        action: definition.action,
        targetLabel: definition.targetLabel,
        subjectId: q.requester_id,
        ...(q.snapshot.inputs.durationDays === undefined
          ? {}
          : { durationDays: q.snapshot.inputs.durationDays }),
        externalChanges: 0,
        summary:
          '承認済みの入力を検証し模擬結果を保存しました。外部のアカウント・権限は変更していません。',
      };
      await c.query(
        'INSERT INTO local_simulation_receipt(id,organization_id,request_id,approval_id,snapshot_hash,idempotency_key,simulation,result) VALUES($1,$2,$3,$4,$5,$6,true,$7)',
        [receiptId, q.organization_id, id, finalStep.approvalId, q.snapshot_hash, key, result],
      );
      const tickets = new TicketService(c);
      let ticket = await tickets.findById(auth.authz, q.ticket_id);
      if (['closed', 'cancelled', 'merged'].includes(ticket.state))
        throw Problems.conflict('関連チケットが完了・取消・統合済みです');
      if (ticket.state === 'new') {
        await tickets.assign(auth.authz, ticket.id, auth.userId, ticket.version);
        ticket = await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'assigned',
          reason: 'assign',
        });
      }
      if (ticket.state === 'assigned')
        ticket = await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'in_progress',
          reason: 'start',
        });
      if (ticket.state === 'pending')
        ticket = await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'in_progress',
          reason: 'resume',
        });
      if (ticket.state === 'in_progress')
        await tickets.transition(auth.authz, {
          ticketId: ticket.id,
          to: 'resolved',
          reason: 'resolve',
        });
      await new CollaborationService(c, this.storage).addComment(auth.authz, {
        ticketId: ticket.id,
        visibility: 'public',
        body: [
          'ローカル模擬実行が完了しました。外部変更は0件です。',
          `対象: ${definition.targetLabel}`,
          ...(q.snapshot.inputs.durationDays === undefined
            ? []
            : [`利用日数: ${q.snapshot.inputs.durationDays}`]),
          `結果証跡: ${receiptId}`,
        ].join('\n'),
      });
      await completeApprovalRequest(c, {
        requestId: id,
        organizationId: q.organization_id,
        expectedVersion: q.version,
      });
      await this.event(c, auth, id, 'simulated', q.revision);
      return { receipt: { id: receiptId, result }, replayed: false };
    });
  }
}
