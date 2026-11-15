import type pg from 'pg';
import { z } from 'zod';
import {
  approvalDelegationCreateSchema,
  approvalDelegationRevokeSchema,
  APPROVAL_DELEGATION_START_TOLERANCE_MINUTES,
} from '@solvi/shared/catalog';
import { Problems, type Logger } from '@solvi/shared';
import { hasRole } from '../../common/authz/authz.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import {
  checkDelegationPeriod,
  delegationEligibilitySql,
  delegationStateFor,
  type DelegationRow,
} from './approval-delegation.js';
import { recordDelegationNotice } from './approval-notice.js';
import { isActiveMember, loadUserFacts } from './approval-resolver.js';

/**
 * 委任の作成・取消・一覧 (WP-P4-APR-020 §6.2 / ADR-0025 §1・§2・§5)。
 *
 * ## 委任者は常に認証済みの本人
 *
 * 本文は代理者・開始・終了だけを受け取り、未知のキー(委任者IDを含む)を拒否する。
 * `org_admin` でも他人の委任は作れない。代理者のIDは組織の利用者の一覧
 * (`GET /approval-delegations/candidates`)から選ぶ形にし、一覧が返すのは
 * 表示名とIDだけである(メールアドレス・社員番号・役職を返さない)。
 *
 * ## 存在を漏らさない
 *
 * 代理者が存在しない・他組織・停止・所属切れ・`approver` ロールが無い・本人、
 * のどれも**同じ 403 と同じ文言**で拒否する。作成の応答の違いから、
 * 他人の存在や資格を調べられないようにする。
 */

const uuid = z.string().uuid();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw Problems.validation(
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  return r.data;
}

export type ApprovalDelegationItem = {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegateId: string;
  delegateName: string;
  startsAt: string;
  endsAt: string;
  state: ReturnType<typeof delegationStateFor>;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  /** 一覧の閲覧者から見た関係。`admin` は org_admin として見ている行。 */
  relation: 'delegator' | 'delegate' | 'admin';
};

export class ApprovalDelegationController {
  constructor(
    private readonly pool: pg.Pool,
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
      throw e;
    } finally {
      c.release();
    }
  }

  /** DBの時計を1回だけ読む。期間・取消・状態の判定はすべてこの値を使う。 */
  private async now(c: pg.PoolClient): Promise<Date> {
    const row = (await c.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0];
    if (!row || !(row.now instanceof Date)) throw Problems.conflict('現在時刻を確認できません');
    return row.now;
  }

  async create(auth: AuthenticatedRequest, value: unknown) {
    const input = parse(approvalDelegationCreateSchema, value);
    return this.run(auth, async (c) => {
      const now = await this.now(c);
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()))
        throw Problems.validation([{ field: 'startsAt', message: '期間を確認してください' }]);

      const periodProblem = checkDelegationPeriod({
        startsAt,
        endsAt,
        now,
        startToleranceMs: APPROVAL_DELEGATION_START_TOLERANCE_MINUTES * 60 * 1000,
      });
      if (periodProblem) {
        const messages: Record<typeof periodProblem, { field: string; message: string }> = {
          ends_not_after_start: {
            field: 'endsAt',
            message: '終了は開始より後にしてください',
          },
          ends_not_future: { field: 'endsAt', message: '終了は現在より後にしてください' },
          period_too_long: { field: 'endsAt', message: '期間は30日以内にしてください' },
          starts_too_early: {
            field: 'startsAt',
            message: '開始は現在より5分前までにしてください',
          },
        };
        throw Problems.validation([messages[periodProblem]]);
      }

      // 委任者は本人だけ。有効な所属でなければ作れない(ADR-0025 §1)。
      const delegatorFacts = (
        await loadUserFacts(c, auth.authz.organizationId, [auth.userId], now)
      ).get(auth.userId);
      if (!isActiveMember(delegatorFacts))
        throw Problems.forbidden('委任できるのは現在有効な所属の本人だけです');

      // 代理者は本人以外で、有効な所属かつ approver ロール。
      // 存在しない・他組織・停止・所属切れ・ロール無し・本人を、同じ応答にする。
      const delegateFacts = (
        await loadUserFacts(c, auth.authz.organizationId, [input.delegateId], now)
      ).get(input.delegateId);
      if (
        input.delegateId === auth.userId ||
        !isActiveMember(delegateFacts) ||
        delegateFacts?.hasApproverRole !== true
      )
        throw Problems.forbidden('現在有効な所属の承認者を代理者に選んでください');

      // 同じ委任者の、取り消されていない委任の期間の重なりを防ぐ。
      // 助言ロックは委任者単位(DBのトリガと同じ鍵)。同時に作っても片方だけが通る。
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `approval_delegation:${auth.authz.organizationId}:${auth.userId}`,
      ]);
      const overlap = await c.query(
        `SELECT 1 FROM approval_delegation
          WHERE organization_id=$1 AND delegator_id=$2 AND revoked_at IS NULL
            AND tstzrange(starts_at, ends_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
          LIMIT 1`,
        [auth.authz.organizationId, auth.userId, startsAt, endsAt],
      );
      if (overlap.rowCount) throw Problems.conflict('期間が重なる委任があります');

      const id = uuidv7();
      let createdAt: Date;
      try {
        const inserted = await c.query<{ created_at: Date }>(
          `INSERT INTO approval_delegation(
             id, organization_id, delegator_id, delegate_id, starts_at, ends_at, created_by
           ) VALUES($1,$2,$3,$4,$5,$6,$7)
           RETURNING created_at`,
          [
            id,
            auth.authz.organizationId,
            auth.userId,
            input.delegateId,
            startsAt,
            endsAt,
            auth.userId,
          ],
        );
        const value = inserted.rows[0]?.created_at;
        if (!(value instanceof Date)) throw Problems.conflict('委任の作成日時を確認できません');
        createdAt = value;
      } catch (error) {
        // トリガの重なり検査(23514)。同時実行で事前検査をすり抜けた場合も 409 にする。
        if ((error as { code?: string }).code === '23514')
          throw Problems.conflict('期間が重なる委任があります');
        throw error;
      }

      await recordAuditEvent(c, {
        eventType: 'approval.delegated',
        organizationId: auth.authz.organizationId,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'approval_delegation',
        targetId: id,
        action: 'approval.delegated',
        outcome: 'success',
        afterState: {
          delegationId: id,
          delegatorId: auth.userId,
          delegateId: input.delegateId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
      });
      await recordDelegationNotice(c, {
        organizationId: auth.authz.organizationId,
        delegationId: id,
        kind: 'created',
      });

      return {
        id,
        delegatorId: auth.userId,
        delegateId: input.delegateId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        createdAt: createdAt.toISOString(),
        state: delegationStateFor({
          startsAt,
          endsAt,
          revokedAt: null,
          delegateEligible: true,
          now,
        }),
      };
    });
  }

  async revoke(auth: AuthenticatedRequest, id: string, value: unknown) {
    parse(uuid, id);
    const input = parse(approvalDelegationRevokeSchema, value);
    return this.run(auth, async (c) => {
      const row = (
        await c.query<DelegationRow>(
          'SELECT * FROM approval_delegation WHERE id=$1 AND organization_id=$2 FOR UPDATE',
          [id, auth.authz.organizationId],
        )
      ).rows[0];
      // 他組織・存在しないIDは 404(存在を漏らさない)。
      if (!row) throw Problems.notFound('委任');
      const isDelegator = row.delegator_id === auth.userId;
      const isDelegate = row.delegate_id === auth.userId;
      const isAdmin = hasRole(auth.authz, 'org_admin', 'platform_admin');
      if (!isDelegator && !isDelegate && !isAdmin)
        throw Problems.forbidden('委任を取り消せるのは委任者・代理者・組織管理者だけです');
      if (!(row.starts_at instanceof Date) || !(row.ends_at instanceof Date))
        throw Problems.conflict('委任の期間を確認できません');
      if (row.revoked_at !== null) throw Problems.conflict('取り消し済みの委任です');
      const now = await this.now(c);
      if (row.ends_at.getTime() <= now.getTime())
        throw Problems.conflict('期間の終わった委任は取り消せません');

      const updated = (
        await c.query<{ revoked_at: Date }>(
          `UPDATE approval_delegation
              SET revoked_at=clock_timestamp(), revoked_by=$3, revoke_reason=$4
            WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL
            RETURNING revoked_at`,
          [id, auth.authz.organizationId, auth.userId, input.reason],
        )
      ).rows[0];
      if (!updated || !(updated.revoked_at instanceof Date))
        throw Problems.conflict('委任の状態が同時に更新されました。再読み込みしてください');

      await recordAuditEvent(c, {
        eventType: 'approval.delegation_revoked',
        organizationId: auth.authz.organizationId,
        actorType: 'user',
        actorId: auth.userId,
        targetType: 'approval_delegation',
        targetId: id,
        action: 'approval.delegation_revoked',
        outcome: 'success',
        afterState: {
          delegationId: id,
          delegatorId: row.delegator_id,
          delegateId: row.delegate_id,
          revokedAt: updated.revoked_at.toISOString(),
          revokeReason: input.reason,
        },
      });
      await recordDelegationNotice(c, {
        organizationId: auth.authz.organizationId,
        delegationId: id,
        kind: 'revoked',
      });
      return { id, revokedAt: updated.revoked_at.toISOString() };
    });
  }

  /**
   * 委任の一覧。自分が委任者のもの・自分が代理者のもの。`org_admin` は組織のすべて。
   * 状態は導出し、代理者の資格は一覧の時点で判定する。
   */
  async list(auth: AuthenticatedRequest) {
    return this.run(auth, async (c) => {
      const now = await this.now(c);
      const isAdmin = hasRole(auth.authz, 'org_admin', 'platform_admin');
      const eligible = delegationEligibilitySql({
        organizationId: '$1',
        userId: 'd.delegate_id',
        at: '$4',
        userStatus: 'du.status',
      });
      const rows = (
        await c.query<
          DelegationRow & {
            delegator_name: string;
            delegate_name: string;
            delegate_eligible: boolean;
          }
        >(
          `SELECT d.*, gu.display_name AS delegator_name, du.display_name AS delegate_name,
                  ${eligible} AS delegate_eligible
             FROM approval_delegation d
             JOIN app_user gu ON gu.id=d.delegator_id
             JOIN app_user du ON du.id=d.delegate_id
            WHERE d.organization_id=$1
              AND (d.delegator_id=$2 OR d.delegate_id=$2 OR $3::boolean)
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT 200`,
          [auth.authz.organizationId, auth.userId, isAdmin, now],
        )
      ).rows;
      const items: ApprovalDelegationItem[] = rows.map((row) => ({
        id: row.id,
        delegatorId: row.delegator_id,
        delegatorName: row.delegator_name,
        delegateId: row.delegate_id,
        delegateName: row.delegate_name,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        state: delegationStateFor({
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          revokedAt: row.revoked_at,
          delegateEligible: row.delegate_eligible === true,
          now,
        }),
        revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        revokeReason: row.revoke_reason,
        createdAt: row.created_at.toISOString(),
        relation:
          row.delegator_id === auth.userId
            ? 'delegator'
            : row.delegate_id === auth.userId
              ? 'delegate'
              : 'admin',
      }));
      return { items, asOf: now.toISOString() };
    });
  }

  /**
   * 委任の代理者の候補(表示名とIDだけ)。
   * 有効な所属かつ `approver` ロールを持つ、自分以外の利用者。
   * **メールアドレス・社員番号・役職・勤務地を返さない。**
   */
  async candidates(auth: AuthenticatedRequest) {
    return this.run(auth, async (c) => {
      const now = await this.now(c);
      const eligible = delegationEligibilitySql({
        organizationId: '$1',
        userId: 'u.id',
        at: '$3',
        userStatus: 'u.status',
      });
      const rows = (
        await c.query<{ id: string; displayName: string }>(
          `SELECT u.id, u.display_name AS "displayName"
             FROM app_user u
            WHERE u.id <> $2
              AND ${eligible}
            ORDER BY u.display_name, u.id
            LIMIT 200`,
          [auth.authz.organizationId, auth.userId, now],
        )
      ).rows;
      return { items: rows, asOf: now.toISOString() };
    });
  }
}
