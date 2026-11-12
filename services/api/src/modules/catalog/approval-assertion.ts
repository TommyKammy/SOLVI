import type pg from 'pg';
import { Problems, type Logger } from '@solvi/shared';
import { hash } from './snapshot-hash.js';

/**
 * 承認完了の実行前検証(WP-P4-APR-011 / ADR-0023 §2・§7)。
 *
 * 作業チェック更新・模擬完了の「承認済みか」の判定はこの1か所に集約する。
 * 現時点の1段承認に適用できる項目だけを持つ。多段の検証(ステップ数と行数の一致、
 * route_hash、route_generation)は WP-P4-APR-014 でこの関数を拡張して足す。
 *
 * **承認者の現在の有効性(所属・approver ロール・利用者状態)は要求しない**(ADR-0023 §7)。
 * 承認は決定時点の事実であり、後から承認者が無効になっても承認済みの申請の実行は止めない。
 * 不正な承認は承認取消(FR-CAT-009)で止める。決定時(decide)と申請・変更時の
 * validateApprover は別経路であり、ここでは変更しない。
 */

export type ApprovalFailure =
  | 'request_not_found'
  | 'request_not_approved'
  | 'no_current_approval'
  | 'approval_row_count'
  | 'approval_not_current'
  | 'approval_not_approved'
  | 'approval_expired'
  | 'decided_after_expiry'
  | 'snapshot_hash_mismatch'
  | 'snapshot_tampered'
  | 'revision_hash_mismatch'
  | 'revision_mismatch'
  | 'fixed_approver_mismatch'
  | 'self_approval'
  | 'duplicate_approver';

export type ApprovalStep = { approvalId: string; approverId: string };
export type ApprovalCheck =
  { ok: true; steps: ApprovalStep[] } | { ok: false; reason: ApprovalFailure };

type RequestRow = {
  id: string;
  organization_id: string;
  requester_id: string;
  revision: number;
  state: string;
  snapshot: { item: { definition: { approval?: { approverId: string } } } };
  snapshot_hash: string;
  current_approval_id: string;
};
type ApprovalRow = {
  id: string;
  approver_id: string;
  state: string;
  snapshot_hash: string;
  revision: number;
  expires_at: Date;
  decided_at: Date | null;
  /** 同じ版の local_request_revision.snapshot_hash と一致するか(SQL側で比較する) */
  revision_hash_ok: boolean;
};

/** 利用者へ返す文言。内部状態(他人のID・hash値)を含めない。詳細な理由はログにだけ残す。 */
const MESSAGES: Record<ApprovalFailure, string> = {
  request_not_found: '申請を確認できません',
  request_not_approved: '有効な承認がありません',
  no_current_approval: '承認記録を確認できません',
  approval_row_count: '承認記録を確認できません',
  approval_not_current: '承認記録を確認できません',
  approval_not_approved: '有効な承認がありません',
  approval_expired: '承認期限が過ぎています',
  decided_after_expiry: '承認期限が過ぎています',
  snapshot_hash_mismatch: '承認後に申請内容が変わっています',
  snapshot_tampered: '承認後に申請内容が変わっています',
  revision_hash_mismatch: '承認後に申請内容が変わっています',
  revision_mismatch: '承認後に申請内容が変わっています',
  fixed_approver_mismatch: '固定承認者が申請版と一致しません',
  self_approval: '自分の申請を承認することはできません',
  duplicate_approver: '承認記録を確認できません',
};

export async function checkApprovalComplete(
  client: pg.PoolClient,
  params: { organizationId: string; requestId: string },
): Promise<ApprovalCheck> {
  const fail = (reason: ApprovalFailure): ApprovalCheck => ({ ok: false, reason });
  const q = (
    await client.query<RequestRow>(
      'SELECT * FROM local_service_request WHERE id=$1 AND organization_id=$2',
      [params.requestId, params.organizationId],
    )
  ).rows[0];
  if (!q) return fail('request_not_found');
  // 1. 申請が approved(invalidated / pending / rejected / completed / cancelled は拒否)
  if (q.state !== 'approved') return fail('request_not_approved');
  // 2. 現在の版の有効な承認行がちょうど1行で、それが current_approval_id
  const rows = (
    await client.query<ApprovalRow>(
      `SELECT a.*, EXISTS(SELECT 1 FROM local_request_revision v
          WHERE v.request_id=a.request_id AND v.organization_id=a.organization_id
            AND v.revision=a.revision AND v.snapshot_hash=$4) AS revision_hash_ok
       FROM local_request_approval a
       WHERE a.request_id=$1 AND a.organization_id=$2 AND a.revision=$3 AND a.state<>'invalidated'`,
      [q.id, q.organization_id, q.revision, q.snapshot_hash],
    )
  ).rows;
  if (rows.length === 0) return fail('no_current_approval');
  if (rows.length !== 1) return fail('approval_row_count');
  const approval = rows[0]!;
  if (approval.id !== q.current_approval_id) return fail('approval_not_current');
  if (approval.state !== 'approved') return fail('approval_not_approved');
  // 3. 期限内。現行の挙動(expires_at > 現在時刻)を維持し、決定時刻が期限を超えていないことも見る
  // 列が欠けた行・型が違う行は通さない(fail closed)
  if (!(approval.expires_at instanceof Date)) return fail('approval_expired');
  if (approval.expires_at.getTime() <= Date.now()) return fail('approval_expired');
  if (!(approval.decided_at instanceof Date)) return fail('decided_after_expiry');
  if (approval.decided_at.getTime() > approval.expires_at.getTime())
    return fail('decided_after_expiry');
  // 4. snapshot_hash(申請・版・承認行)、再計算値、revision
  if (approval.snapshot_hash !== q.snapshot_hash) return fail('snapshot_hash_mismatch');
  if (hash(q.snapshot) !== q.snapshot_hash) return fail('snapshot_tampered');
  if (approval.revision_hash_ok !== true) return fail('revision_hash_mismatch');
  if (approval.revision !== q.revision) return fail('revision_mismatch');
  // 5. 固定承認者
  const fixed = q.snapshot.item.definition.approval;
  if (fixed && fixed.approverId !== approval.approver_id) return fail('fixed_approver_mismatch');
  // 6. 申請者と承認者が同一でない(静的な検査)/承認者同士が重複しない
  const approvers = rows.map((r) => r.approver_id);
  if (approvers.includes(q.requester_id)) return fail('self_approval');
  if (new Set(approvers).size !== approvers.length) return fail('duplicate_approver');
  // 7. 承認者の現在の有効性は要求しない(ADR-0023 §7)
  return {
    ok: true,
    steps: rows.map((r) => ({ approvalId: r.id, approverId: r.approver_id })),
  };
}

export async function assertApprovalComplete(
  client: pg.PoolClient,
  params: { organizationId: string; requestId: string },
  logger?: Logger,
): Promise<ApprovalStep[]> {
  const result = await checkApprovalComplete(client, params);
  if (result.ok) return result.steps;
  logger?.warn('catalog.approval.incomplete', {
    organizationId: params.organizationId,
    requestId: params.requestId,
    reason: result.reason,
  });
  throw Problems.conflict(MESSAGES[result.reason]);
}
