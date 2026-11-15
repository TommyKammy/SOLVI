import type pg from 'pg';
import { enqueueOutboxEvent, type OutboxEventType } from '../../common/outbox/outbox.js';
import { delegationValiditySql } from './approval-delegation.js';
import { activeMembershipSql } from './membership.js';

/**
 * 承認の通知の記録と、依頼の通知を積む唯一の場所(WP-P4-APR-019 / WP §6.1・§6.2)。
 *
 * ## 重複させない仕組み
 *
 * 通知を積む前に、同じトランザクションで `local_request_approval_notice` へ
 * 1行を `INSERT` する。主キーは `(approval_id, kind)` であり、2周目・同時実行・
 * プロセスの再起動のどれでも2件目は `ON CONFLICT DO NOTHING` で消える。
 * **記録できた側だけが Outbox へ積む。** 積む側と記録する側を分けると、
 * 「記録はあるが通知が無い」「通知が2件ある」のどちらかが必ず起きる。
 *
 * ## ペイロードに載せないもの
 *
 * 識別子だけを載せる(`approvalId` / `requestId`)。申請の入力値・理由・
 * 社員番号・役職・勤務地・カタログ項目の入力内容は、件名にもリンクにも
 * Outbox にも載せない。宛先は配送の時点でDBから解決する。
 */

export const APPROVAL_NOTICE_KINDS = [
  'requested',
  'expiring',
  'expired',
  'approver_unavailable',
] as const;
export type ApprovalNoticeKind = (typeof APPROVAL_NOTICE_KINDS)[number];

/** 通知の種類と Outbox のイベント型の対応。1種類につき1イベント型。 */
const OUTBOX_EVENT_TYPE: Record<ApprovalNoticeKind, OutboxEventType> = {
  requested: 'approval.notice.requested',
  expiring: 'approval.notice.expiring',
  expired: 'approval.notice.expired',
  approver_unavailable: 'approval.notice.approver_unavailable',
};

export const APPROVAL_NOTICE_EVENT_TYPES: readonly OutboxEventType[] = APPROVAL_NOTICE_KINDS.map(
  (kind) => OUTBOX_EVENT_TYPE[kind],
);

export function isApprovalNoticeEventType(eventType: string): boolean {
  return (APPROVAL_NOTICE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * 委任の作成・取消の通知 (WP-P4-APR-020 §6.5)。
 *
 * 承認の通知(依頼・期限前・期限切れ・承認者不在)とはイベント型を分ける。
 * 宛先は委任の行から配送の時点で解決し、payload には**委任のIDだけ**を載せる。
 * 件名・リンクに委任者の氏名・申請の入力値・個人データを載せない。
 */
export const DELEGATION_NOTICE_KINDS = ['created', 'revoked'] as const;
export type DelegationNoticeKind = (typeof DELEGATION_NOTICE_KINDS)[number];

const DELEGATION_OUTBOX_EVENT_TYPE: Record<DelegationNoticeKind, OutboxEventType> = {
  created: 'approval.delegation.created',
  revoked: 'approval.delegation.revoked',
};

export const DELEGATION_NOTICE_EVENT_TYPES: readonly OutboxEventType[] =
  DELEGATION_NOTICE_KINDS.map((kind) => DELEGATION_OUTBOX_EVENT_TYPE[kind]);

export function isDelegationNoticeEventType(eventType: string): boolean {
  return (DELEGATION_NOTICE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** 委任の作成・取消の通知を積む。**業務処理と同一のトランザクション**で呼ぶ。 */
export async function recordDelegationNotice(
  client: pg.PoolClient,
  input: { organizationId: string; delegationId: string; kind: DelegationNoticeKind },
): Promise<void> {
  await enqueueOutboxEvent(client, {
    eventType: DELEGATION_OUTBOX_EVENT_TYPE[input.kind],
    organizationId: input.organizationId,
    // **識別子だけ。** 宛先は配送時に委任の行から読む。
    payload: { delegationId: input.delegationId },
  });
}

/**
 * ある承認者宛ての、配送の時点で有効な委任の代理者(通知の宛先)。
 *
 * `delegationValiditySql` と同じ判定を使う(期間・取消・委任者の権限根拠・代理者の資格)。
 * 委任者が無効なら委任は効かないため、代理人へも送らない(ADR-0025 §3-3)。
 */
export function activeApprovalDelegateRecipientSql(input: {
  organizationId: string;
  approverId: string;
  authorityType: string;
  at: string;
}): string {
  return `SELECT DISTINCT u.id AS user_id, u.primary_email::text AS email
    FROM approval_delegation d
    JOIN app_user u ON u.id = d.delegate_id
   WHERE d.organization_id = ${input.organizationId}
     AND d.delegator_id = ${input.approverId}
     AND ${delegationValiditySql({
       alias: 'd',
       organizationId: input.organizationId,
       delegatorId: input.approverId,
       delegateId: 'd.delegate_id',
       at: input.at,
       authorityType: input.authorityType,
       delegateStatus: 'u.status',
     })}`;
}

export interface PendingApprovalStepInput {
  id: string;
  organizationId: string;
  requestId: string;
  revision: number;
  routeGeneration: number;
  stepNo: number;
  snapshotHash: string;
  approverId: string;
  authorityType: string;
  resolvedFrom: string | null;
}

/**
 * 送信の記録を積み、記録できたときだけ Outbox へ積む。
 *
 * @param client **業務処理と同一のトランザクションクライアント**。
 * @returns 2件目以降(既に記録済み)は false。
 */
export async function recordApprovalNotice(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    approvalId: string;
    requestId: string;
    kind: ApprovalNoticeKind;
  },
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO local_request_approval_notice (organization_id, approval_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (approval_id, kind) DO NOTHING
     RETURNING approval_id`,
    [input.organizationId, input.approvalId, input.kind],
  );
  if (inserted.rowCount !== 1) return false;

  await enqueueOutboxEvent(client, {
    eventType: OUTBOX_EVENT_TYPE[input.kind],
    organizationId: input.organizationId,
    // **識別子だけ。** 件名・リンク・本文に使う値は配送時にDBから読む。
    payload: { approvalId: input.approvalId, requestId: input.requestId },
  });
  return true;
}

/**
 * 新しい `pending` のステップを作り、同じトランザクションで依頼の通知を積む。
 *
 * ステップが `pending` になる4つの契機(申請・申請内容の変更・前の段の承認・再割当)は、
 * すべてここを通る。契機ごとに通知の SQL を書き写さない。
 */
export async function insertPendingApprovalStep(
  client: pg.PoolClient,
  input: PendingApprovalStepInput,
): Promise<void> {
  await client.query(
    `INSERT INTO local_request_approval(
       id, organization_id, request_id, revision, route_generation, step_no,
       snapshot_hash, approver_id, authority_type, resolved_from, state, expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',clock_timestamp()+interval '72 hours')`,
    [
      input.id,
      input.organizationId,
      input.requestId,
      input.revision,
      input.routeGeneration,
      input.stepNo,
      input.snapshotHash,
      input.approverId,
      input.authorityType,
      input.resolvedFrom,
    ],
  );
  await recordApprovalNotice(client, {
    organizationId: input.organizationId,
    approvalId: input.id,
    requestId: input.requestId,
    kind: 'requested',
  });
}

/** 通知の宛先になりうる利用者の一覧(有効な所属の判定は共有の述語)。 */
export function activeMemberRecipientSql(input: {
  organizationId: string;
  userId: string;
  at: string;
}): string {
  return `SELECT u.id AS user_id, u.primary_email::text AS email
    FROM app_user u
   WHERE u.id = ${input.userId}
     AND u.status = 'active'
     AND ${activeMembershipSql('u.id', input.organizationId, input.at)}`;
}

/**
 * ある組織の「現在有効な組織管理者」の一覧。
 * 承認者不在の通知の宛先はこの1つの式だけで決める(定期処理の0人判定と配送で共有)。
 */
export function activeOrgAdminRecipientSql(input: { organizationId: string; at: string }): string {
  return `SELECT DISTINCT u.id AS user_id, u.primary_email::text AS email
    FROM app_user u
    JOIN role_binding rb
      ON rb.user_id = u.id
     AND rb.organization_id = ${input.organizationId}
     AND rb.role_scope = 'org'
    JOIN role r ON r.id = rb.role_id AND r.code = 'org_admin'
   WHERE u.status = 'active'
     AND rb.valid_from <= ${input.at}
     AND (rb.valid_until IS NULL OR rb.valid_until > ${input.at})
     AND ${activeMembershipSql('u.id', input.organizationId, input.at)}`;
}
