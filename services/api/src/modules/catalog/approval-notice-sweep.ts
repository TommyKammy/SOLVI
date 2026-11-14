import type pg from 'pg';
import { APPROVAL_NOTICE_LEAD_HOURS, newContext, runWithContext, type Logger } from '@solvi/shared';
import { recordAuditEvent } from '../../common/audit/audit.js';
import {
  REQUEST_STATES,
  transitionFor,
  type RequestState,
  type StepState,
} from './approval-state.js';
import {
  approverAvailabilitySql,
  effectiveAuthorityTypeSql,
  isApproverUnavailable,
} from './approval-route-state.js';
import { activeOrgAdminRecipientSql, recordApprovalNotice } from './approval-notice.js';

/**
 * 承認の通知と期限切れの定期処理(WP-P4-APR-019 §6.3)。
 *
 * ## 組織をまたがない
 *
 * 組織の一覧だけを、登録した読み取り専用の例外(`app.approval_sweep`、
 * 02.18 §3.6)で読む。読むのは `organization` の `id` だけで、その
 * トランザクションでは業務テーブルを読み書きしない。承認・申請・通知・
 * 利用者のテーブルは越境させず、組織を1つずつ、その組織の文脈
 * (`app.current_org`)で処理する([[99.4_Decision_Log]] DL-019)。
 *
 * ## 1件ごとに1トランザクション
 *
 * 期限切れは申請の行をロックし(決定・再割当と同じロック)、ロック後に状態と期限を
 * 読み直してから遷移表の `expire` を通す。監査の書込みに失敗したら**その1件だけ**を
 * 丸ごと失敗させ、ほかの件は続ける。1つのトランザクションにまとめると、
 * 壊れた1件が滞留全体を止める。
 *
 * ## 自動で承認者を差し替えない
 *
 * 承認者が不在でも、この処理は通知を積むだけである。経路・世代・ステップの行は
 * 変えない(ADR-0023 §6 / ADR-0024 §3)。
 */

/** 1周で扱う上限。**一度に全部を書かない**(監査の連鎖に長い書き込みを作らない)。 */
export const APPROVAL_NOTICE_BATCH_LIMIT = 200;

export interface ApprovalNoticeSweeperOptions {
  /**
   * 1周で扱う上限。既定は {@link APPROVAL_NOTICE_BATCH_LIMIT}。
   * テストで小さくするためだけに開いている。**環境変数では切り替えない**
   * (本番の挙動が設定で変わり、試した値と動く値が食い違うのを避ける)。
   */
  batchLimit?: number;
}

export interface ApprovalNoticeSweepSummary {
  /** 期限前の通知を積んだ件数 */
  expiringQueued: number;
  expiringFailed: number;
  /** `expired` にした件数 */
  expired: number;
  /** 期限切れの処理に失敗した件数(状態は変わっていない) */
  expiredFailed: number;
  /** 承認者不在の通知を積んだ件数 */
  unavailableQueued: number;
  unavailableFailed: number;
  /** 承認者が0人のため積まなかった件数(次の周で再挑戦できる) */
  unavailableSkippedNoAdmin: number;
}

/** 組織の一覧から回した1周分の集計。 */
export interface ApprovalNoticeSweepRunSummary extends ApprovalNoticeSweepSummary {
  /** 一覧で読んだ組織の数 */
  organizationCount: number;
  /** 1周を最後まで処理できた組織の数 */
  processedOrganizations: number;
  /** 失敗した組織の数(ほかの組織は続けて処理する) */
  failedOrganizations: number;
  /** 前の周が終わっていないため、この周を始めなかったか */
  skippedOverlap: boolean;
}

type ExpiringCandidate = { approval_id: string; request_id: string };
type ExpiredCandidate = { approval_id: string; request_id: string };
type UnavailableCandidate = { approval_id: string; request_id: string; approver_id: string };

type RequestSnapshot = {
  id: string;
  state: string;
  revision: number;
  current_approval_id: string | null;
};

type StepSnapshot = {
  id: string;
  request_id: string;
  approver_id: string;
  state: string;
  step_no: number;
  route_generation: number;
  expires_at: Date | null;
};

export class ApprovalNoticeSweeper {
  private readonly batchLimit: number;
  /** 前の周が終わっていないうちに次の周を始めない(同じプロセス内)。 */
  private sweeping = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger?: Logger,
    options: ApprovalNoticeSweeperOptions = {},
  ) {
    const limit = options.batchLimit ?? APPROVAL_NOTICE_BATCH_LIMIT;
    // fail closed: 不正な上限で「全件」や「0件」の周回にしない。
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('承認の通知の1周の上限が不正です');
    this.batchLimit = limit;
  }

  private async transaction<T>(
    organizationId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [organizationId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 現在の承認ステップ(申請が指す pending の行)だけを対象にする読み取り。 */
  private async candidates<T extends pg.QueryResultRow>(
    organizationId: string,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    return this.transaction(organizationId, async (client) => {
      const { rows } = await client.query<T>(sql, params);
      return rows;
    });
  }

  /** 期限前の通知の候補。期限内で、期限まで24時間以内の pending のステップ。 */
  private findExpiring(organizationId: string, now: Date): Promise<ExpiringCandidate[]> {
    return this.candidates<ExpiringCandidate>(
      organizationId,
      `SELECT a.id AS approval_id, a.request_id
         FROM local_request_approval a
         JOIN local_service_request q
           ON q.id=a.request_id AND q.organization_id=a.organization_id
        WHERE a.organization_id=$1
          AND q.state='pending'
          AND a.state='pending'
          AND a.id=q.current_approval_id
          AND a.expires_at > $2::timestamptz
          AND a.expires_at <= $2::timestamptz + ($3 || ' hours')::interval
          -- 既に積んだステップを候補から外す。上限で切るのは**未通知**だけにする。
          -- 記録の主キーによる重複防止は残す(抽出は効率、主キーは正しさ)。
          AND NOT EXISTS (
            SELECT 1 FROM local_request_approval_notice n
             WHERE n.approval_id = a.id AND n.kind = 'expiring'
          )
        ORDER BY a.expires_at, a.id
        LIMIT ${this.batchLimit}`,
      [organizationId, now, String(APPROVAL_NOTICE_LEAD_HOURS)],
    );
  }

  /** 期限切れの候補。期限を過ぎた pending のステップ。 */
  private findExpired(organizationId: string, now: Date): Promise<ExpiredCandidate[]> {
    return this.candidates<ExpiredCandidate>(
      organizationId,
      `SELECT a.id AS approval_id, a.request_id
         FROM local_request_approval a
         JOIN local_service_request q
           ON q.id=a.request_id AND q.organization_id=a.organization_id
        WHERE a.organization_id=$1
          AND q.state IN ('pending','approved')
          AND a.state='pending'
          AND a.id=q.current_approval_id
          AND a.expires_at <= $2::timestamptz
        ORDER BY a.expires_at, a.id
        LIMIT ${this.batchLimit}`,
      [organizationId, now],
    );
  }

  /**
   * 承認者不在の候補。期限内の pending のステップで、承認者が有効な所属でない
   * (または fixed/legacy で approver ロールが無い)。判定は共有の述語だけを使う。
   */
  private findUnavailable(organizationId: string, now: Date): Promise<UnavailableCandidate[]> {
    const authorityType = effectiveAuthorityTypeSql({
      requestId: 'q.id',
      organizationId: 'q.organization_id',
      revision: 'q.revision',
      stepNo: 'a.step_no',
      baseRouteAuthority: `r.route->'steps'->(a.step_no-1)->>'authorityType'`,
      fallback: 'a.authority_type',
    });
    const available = approverAvailabilitySql({
      organizationId: 'q.organization_id',
      approverId: 'a.approver_id',
      at: '$2',
      authorityType,
      userStatus: 'ap.status',
    });
    return this.candidates<UnavailableCandidate>(
      organizationId,
      `SELECT a.id AS approval_id, a.request_id, a.approver_id
         FROM local_request_approval a
         JOIN local_service_request q
           ON q.id=a.request_id AND q.organization_id=a.organization_id
         JOIN local_request_revision r
           ON r.request_id=q.id AND r.organization_id=q.organization_id
          AND r.revision=q.revision
         JOIN app_user ap ON ap.id=a.approver_id
        WHERE a.organization_id=$1
          AND q.state='pending'
          AND a.state='pending'
          AND a.id=q.current_approval_id
          AND a.expires_at > $2::timestamptz
          AND NOT ${available}
          -- 既に積んだステップを候補から外す。上限で切るのは**未通知**だけにする。
          -- 記録の主キーによる重複防止は残す(抽出は効率、主キーは正しさ)。
          AND NOT EXISTS (
            SELECT 1 FROM local_request_approval_notice n
             WHERE n.approval_id = a.id AND n.kind = 'approver_unavailable'
          )
        ORDER BY a.expires_at, a.id
        LIMIT ${this.batchLimit}`,
      [organizationId, now],
    );
  }

  /**
   * その組織に現在有効な組織管理者が何人いるか。
   * 承認者不在の宛先と同じ式(`activeOrgAdminRecipientSql`)で数える。
   */
  private async countActiveOrgAdmins(organizationId: string, now: Date): Promise<number> {
    const rows = await this.candidates<{ n: number }>(
      organizationId,
      `SELECT count(*)::int AS n
         FROM (${activeOrgAdminRecipientSql({ organizationId: '$1', at: '$2' })}) admins`,
      [organizationId, now],
    );
    return rows[0]?.n ?? 0;
  }

  /** 対象のステップと申請を読み直す。**ロックの外で読んだ候補を信じない。** */
  private async reload(
    client: pg.PoolClient,
    organizationId: string,
    approvalId: string,
    requestId: string,
    lockRequest: boolean,
  ): Promise<{ request: RequestSnapshot; step: StepSnapshot } | null> {
    const lock = lockRequest ? ' FOR UPDATE' : '';
    const request = (
      await client.query<RequestSnapshot>(
        `SELECT id, state, revision, current_approval_id
           FROM local_service_request
          WHERE id=$1 AND organization_id=$2${lock}`,
        [requestId, organizationId],
      )
    ).rows[0];
    if (!request) return null;
    const step = (
      await client.query<StepSnapshot>(
        `SELECT id, request_id, approver_id, state, step_no, route_generation, expires_at
           FROM local_request_approval
          WHERE id=$1 AND organization_id=$2 AND request_id=$3`,
        [approvalId, organizationId, requestId],
      )
    ).rows[0];
    if (!step) return null;
    return { request, step };
  }

  /** 期限前の通知を1件積む。既に積んであれば false。 */
  private async queueExpiringOne(
    organizationId: string,
    candidate: ExpiringCandidate,
    now: Date,
  ): Promise<boolean> {
    return this.transaction(organizationId, async (client) => {
      const loaded = await this.reload(
        client,
        organizationId,
        candidate.approval_id,
        candidate.request_id,
        false,
      );
      if (!loaded) return false;
      const { request, step } = loaded;
      if (request.state !== 'pending' || request.current_approval_id !== step.id) return false;
      if (step.state !== 'pending') return false;
      // 期限が読めない行には通知しない(期限切れの側に倒す)。
      if (!(step.expires_at instanceof Date)) return false;
      const remaining = step.expires_at.getTime() - now.getTime();
      if (remaining <= 0 || remaining > APPROVAL_NOTICE_LEAD_HOURS * 60 * 60 * 1000) return false;
      return recordApprovalNotice(client, {
        organizationId,
        approvalId: step.id,
        requestId: step.request_id,
        kind: 'expiring',
      });
    });
  }

  /**
   * 期限切れの1件を処理する。
   *
   * 申請の行をロックし(決定・再割当と同じロック)、ロック後に状態と期限を読み直す。
   * 遷移表の `expire` を通して `expired` にし、`approval.expired` を記録し、
   * 申請者への通知を積む。申請の状態は変えない(期限切れは導出のまま)。
   */
  private async expireOne(
    organizationId: string,
    candidate: ExpiredCandidate,
    now: Date,
  ): Promise<'expired' | 'skipped'> {
    return this.transaction(organizationId, async (client) => {
      const loaded = await this.reload(
        client,
        organizationId,
        candidate.approval_id,
        candidate.request_id,
        true,
      );
      if (!loaded) return 'skipped';
      const { request, step } = loaded;
      if (request.current_approval_id !== step.id) return 'skipped';
      if (step.state !== 'pending') return 'skipped';
      if (!(step.expires_at instanceof Date)) return 'skipped';
      if (step.expires_at.getTime() > now.getTime()) return 'skipped';
      if (!(REQUEST_STATES as readonly string[]).includes(request.state)) return 'skipped';

      const transition = transitionFor('expire', {
        stepState: step.state as StepState,
        requestState: request.state as RequestState,
        position: 'any',
      });
      if (!transition || transition.stepTo !== 'expired' || transition.requestTo !== 'unchanged')
        return 'skipped';

      const updated = await client.query(
        `UPDATE local_request_approval
            SET state=$2
          WHERE id=$1 AND organization_id=$3 AND request_id=$4
            AND state='pending' AND route_generation=$5 AND step_no=$6
          RETURNING id`,
        [
          step.id,
          transition.stepTo,
          organizationId,
          request.id,
          step.route_generation,
          step.step_no,
        ],
      );
      if (updated.rowCount !== 1) return 'skipped';

      // 監査の書込みに失敗したら、この1件を丸ごと失敗させる(状態も変えない)。
      await recordAuditEvent(client, {
        eventType: 'approval.expired',
        organizationId,
        // 人が行った操作ではない。**期限が来ただけである。**
        actorType: 'system',
        actorDisplay: 'approval_expiry',
        targetType: 'service_request',
        targetId: request.id,
        action: 'approval.expired',
        outcome: 'success',
        approvalRef: step.id,
        beforeState: {
          stepState: 'pending',
          requestState: request.state,
          revision: request.revision,
          routeGeneration: step.route_generation,
          stepNo: step.step_no,
          expiresAt: step.expires_at,
        },
        afterState: {
          stepState: transition.stepTo,
          requestState: transition.requestTo === 'unchanged' ? request.state : transition.requestTo,
          revision: request.revision,
          routeGeneration: step.route_generation,
          stepNo: step.step_no,
          expiresAt: step.expires_at,
        },
      });

      // 申請者への通知。**同じトランザクションで記録と Outbox を積む。**
      await recordApprovalNotice(client, {
        organizationId,
        approvalId: step.id,
        requestId: step.request_id,
        kind: 'expired',
      });
      return 'expired';
    });
  }

  /**
   * 承認者不在の通知を1件積む。
   * 有効な組織管理者が0人のときは、記録も Outbox も作らない
   * (後で任命されたら次の周で送れるようにするため)。
   */
  private async queueUnavailableOne(
    organizationId: string,
    candidate: UnavailableCandidate,
    now: Date,
  ): Promise<'queued' | 'skipped' | 'no_admin'> {
    return this.transaction(organizationId, async (client) => {
      const loaded = await this.reload(
        client,
        organizationId,
        candidate.approval_id,
        candidate.request_id,
        false,
      );
      if (!loaded) return 'skipped';
      const { request, step } = loaded;
      if (request.state !== 'pending' || request.current_approval_id !== step.id) return 'skipped';
      if (step.state !== 'pending') return 'skipped';
      if (!(step.expires_at instanceof Date)) return 'skipped';
      if (step.expires_at.getTime() <= now.getTime()) return 'skipped';
      if (step.approver_id !== candidate.approver_id) return 'skipped';

      const authorityType = (
        await client.query<{ authority_type: unknown }>(
          `SELECT ${effectiveAuthorityTypeSql({
            requestId: 'q.id',
            organizationId: 'q.organization_id',
            revision: 'q.revision',
            stepNo: 'a.step_no',
            baseRouteAuthority: `r.route->'steps'->(a.step_no-1)->>'authorityType'`,
            fallback: 'a.authority_type',
          })} AS authority_type
             FROM local_request_approval a
             JOIN local_service_request q
               ON q.id=a.request_id AND q.organization_id=a.organization_id
             JOIN local_request_revision r
               ON r.request_id=q.id AND r.organization_id=q.organization_id
              AND r.revision=q.revision
            WHERE a.id=$1 AND a.organization_id=$2`,
          [step.id, organizationId],
        )
      ).rows[0]?.authority_type;
      if (typeof authorityType !== 'string') return 'skipped';

      // 判定は滞留の導出と同じ共有述語。ここで結論を書き直さない。
      const unavailable = await isApproverUnavailable(client, {
        organizationId,
        approverId: step.approver_id,
        authorityType,
        now,
      });
      if (!unavailable) return 'skipped';

      const admins = (
        await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (${activeOrgAdminRecipientSql({
            organizationId: '$1',
            at: '$2',
          })}) admins`,
          [organizationId, now],
        )
      ).rows[0]?.n;
      if (admins === undefined) return 'skipped';
      if (admins === 0) return 'no_admin';

      const queued = await recordApprovalNotice(client, {
        organizationId,
        approvalId: step.id,
        requestId: step.request_id,
        kind: 'approver_unavailable',
      });
      return queued ? 'queued' : 'skipped';
    });
  }

  /**
   * 1周分。期限前 → 期限切れ → 承認者不在の順に処理する。
   * 期限を過ぎたステップは期限前・不在の候補から外れているため、順序で二重にならない。
   */
  async runOnce(input: { organizationId: string; now: Date }): Promise<ApprovalNoticeSweepSummary> {
    const { organizationId, now } = input;
    const summary: ApprovalNoticeSweepSummary = {
      expiringQueued: 0,
      expiringFailed: 0,
      expired: 0,
      expiredFailed: 0,
      unavailableQueued: 0,
      unavailableFailed: 0,
      unavailableSkippedNoAdmin: 0,
    };

    for (const candidate of await this.findExpiring(organizationId, now)) {
      try {
        if (await this.queueExpiringOne(organizationId, candidate, now))
          summary.expiringQueued += 1;
      } catch (error) {
        // 1件の失敗で全体を止めない。ただし**黙って飛ばさない**(件数とログに残す)。
        summary.expiringFailed += 1;
        this.logger?.error('approval notice expiring failed', error);
      }
    }

    for (const candidate of await this.findExpired(organizationId, now)) {
      try {
        if ((await this.expireOne(organizationId, candidate, now)) === 'expired')
          summary.expired += 1;
      } catch (error) {
        summary.expiredFailed += 1;
        this.logger?.error('approval expiry failed', error);
      }
    }

    // 承認者不在の候補は、**1件ずつ処理する前に**組織管理者の人数を見る。
    //
    // 管理者が0人の組織では記録を作らない設計のため、候補は周回ごとに残り続ける。
    // 候補を並べてから1件ずつ「0人なので積まない」と判断すると、上限まで
    // 同じ結論のトランザクションを繰り返すだけになる。ここで打ち切れば、
    // 未通知の候補がほかの候補を押し出さない(管理者が任命された次の周から進む)。
    const unavailable = await this.findUnavailable(organizationId, now);
    if (unavailable.length > 0) {
      const admins = await this.countActiveOrgAdmins(organizationId, now);
      if (admins === 0) {
        summary.unavailableSkippedNoAdmin = unavailable.length;
        this.logger?.info('approval notice approver unavailable skipped', {
          count: unavailable.length,
          message: 'no active org admin for this organization',
        });
      } else {
        for (const candidate of unavailable) {
          try {
            const result = await this.queueUnavailableOne(organizationId, candidate, now);
            if (result === 'queued') summary.unavailableQueued += 1;
            else if (result === 'no_admin') summary.unavailableSkippedNoAdmin += 1;
          } catch (error) {
            summary.unavailableFailed += 1;
            this.logger?.error('approval notice approver unavailable failed', error);
          }
        }
      }
    }

    return summary;
  }

  /**
   * 処理する組織の一覧。**登録制の例外(02.18 §3.6)を使う唯一の場所。**
   *
   * 専用の短いトランザクションで `app.approval_sweep` を立て、`organization` の
   * `id` だけを読んでコミットする。このトランザクションで業務テーブルは
   * 一切読み書きしない(`SET LOCAL` なので次のトランザクションへ残らない)。
   */
  async listOrganizationIds(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.approval_sweep', 'on', true)");
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM organization ORDER BY id',
      );
      await client.query('COMMIT');
      return rows.map((row) => row.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 全組織の1周。**組織を1つずつ、その組織の文脈で処理する**(DL-019)。
   *
   * 1つの組織の失敗はほかの組織を止めない。失敗は数えてログに残し、次へ進む。
   * 前の周が終わっていないうちに次の周を始めない(同じプロセス内の重なり防止)。
   * 別プロセスとの重なりは、通知の記録の主キーと申請行のロックで吸収する。
   */
  async sweepAllOnce(now: Date): Promise<ApprovalNoticeSweepRunSummary> {
    const summary: ApprovalNoticeSweepRunSummary = {
      expiringQueued: 0,
      expiringFailed: 0,
      expired: 0,
      expiredFailed: 0,
      unavailableQueued: 0,
      unavailableFailed: 0,
      unavailableSkippedNoAdmin: 0,
      organizationCount: 0,
      processedOrganizations: 0,
      failedOrganizations: 0,
      skippedOverlap: false,
    };
    if (this.sweeping) return { ...summary, skippedOverlap: true };
    this.sweeping = true;
    try {
      const organizationIds = await this.listOrganizationIds();
      summary.organizationCount = organizationIds.length;
      for (const organizationId of organizationIds) {
        try {
          const one = await this.runOnce({ organizationId, now });
          summary.expiringQueued += one.expiringQueued;
          summary.expiringFailed += one.expiringFailed;
          summary.expired += one.expired;
          summary.expiredFailed += one.expiredFailed;
          summary.unavailableQueued += one.unavailableQueued;
          summary.unavailableFailed += one.unavailableFailed;
          summary.unavailableSkippedNoAdmin += one.unavailableSkippedNoAdmin;
          summary.processedOrganizations += 1;
        } catch (error) {
          // 1つの組織の失敗で全体を止めない。**黙って飛ばさない**(件数とログに残す)。
          summary.failedOrganizations += 1;
          this.logger?.error('approval notice sweep failed for organization', error);
        }
      }
      return summary;
    } finally {
      this.sweeping = false;
    }
  }
}

/**
 * 定期実行の入口。`startRoleBindingExpiryLoop` と同じ形にする
 * (`main.ts` が開始し、停止時にタイマーを止める)。
 *
 * - **起動時に1周走る。** 落ちていた間に期限を過ぎた分を取りこぼさない。
 * - 前の周が終わっていないうちに次の周を始めない(`sweepAllOnce` が判定する)。
 */
export function startApprovalNoticeLoop(
  sweeper: ApprovalNoticeSweeper,
  logger: Logger,
  intervalMs: number,
  now: () => Date = () => new Date(),
): NodeJS.Timeout {
  const tick = (): void => {
    void runWithContext(newContext(), async () => {
      try {
        const summary = await sweeper.sweepAllOnce(now());
        if (summary.skippedOverlap) {
          logger.info('approval notice sweep skipped', {
            message: 'the previous round is still running',
          });
          return;
        }
        // 平時に何も出さないと、止まっていることと対象が無いことを区別できない。
        logger.info('approval notice sweep', {
          count: summary.expiringQueued + summary.expired + summary.unavailableQueued,
          message:
            `organizations=${summary.organizationCount} ` +
            `processed=${summary.processedOrganizations} ` +
            `failedOrganizations=${summary.failedOrganizations} ` +
            `expiringQueued=${summary.expiringQueued} expired=${summary.expired} ` +
            `unavailableQueued=${summary.unavailableQueued} ` +
            `unavailableSkippedNoAdmin=${summary.unavailableSkippedNoAdmin} ` +
            `errors=${summary.expiringFailed + summary.expiredFailed + summary.unavailableFailed}`,
        });
      } catch (error) {
        logger.error('approval notice sweep failed', error);
      }
    });
  };
  tick();
  return setInterval(tick, intervalMs);
}
