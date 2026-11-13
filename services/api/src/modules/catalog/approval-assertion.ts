import type pg from 'pg';
import { Problems, type Logger } from '@solvi/shared';
import {
  checkRouteAgainstSteps,
  type ApprovalStepRow,
  type RouteCheckFailure,
} from './approval-state.js';
import { hash } from './snapshot-hash.js';

/**
 * 承認完了の実行前検証(WP-P4-APR-011 / WP-P4-APR-014 / ADR-0023 §2・§7)。
 *
 * 作業チェック更新・模擬完了の「承認済みか」の判定はこの1か所に集約する。
 * 現在の版・現在の経路世代の**全ステップ**を要求する。`route` の段数と行数、
 * `route_hash`、`route_generation` を検証し、`route` が NULL の移行前の行は
 * 従来どおり1行の検証で動く。**どちらの場合も fail closed**。
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
  | 'duplicate_approver'
  | RouteCheckFailure;

export type ApprovalStep = { approvalId: string; approverId: string };
export type ApprovalCheck =
  { ok: true; steps: ApprovalStep[] } | { ok: false; reason: ApprovalFailure };

type RequestRow = {
  id: string;
  organization_id: string;
  requester_id: string;
  revision: number;
  state: string;
  snapshot: { item: { definition: { approval?: { approverId?: string; ruleId?: string } } } };
  snapshot_hash: string;
  current_approval_id: string;
};
type RevisionRow = {
  route: unknown;
  route_hash: unknown;
  route_generation: unknown;
  snapshot_hash: string;
};
type ApprovalRow = ApprovalStepRow & {
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
  route_invalid: '承認経路を確認できません',
  route_hash_mismatch: '承認経路が申請版と一致しません',
  route_generation_mismatch: '承認経路の世代が申請版と一致しません',
  route_step_count: '承認ステップの数が申請版と一致しません',
  route_step_mismatch: '承認ステップが申請版と一致しません',
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

  // 2. 現在の版の経路。列が欠けた行は通さない(fail closed)
  const revision = (
    await client.query<RevisionRow>(
      `SELECT route,route_hash,route_generation,snapshot_hash FROM local_request_revision
        WHERE request_id=$1 AND organization_id=$2 AND revision=$3`,
      [q.id, q.organization_id, q.revision],
    )
  ).rows[0];
  if (!revision) return fail('revision_mismatch');
  if (
    !Object.prototype.hasOwnProperty.call(revision, 'route') ||
    !Object.prototype.hasOwnProperty.call(revision, 'route_hash') ||
    !Object.prototype.hasOwnProperty.call(revision, 'route_generation')
  )
    return fail('route_invalid');

  // 3. 現在の版・現在の経路世代のステップ。移行前(route NULL)は無効化されていない1行だけを見る。
  const rows = (
    await client.query<ApprovalRow>(
      revision.route === null
        ? `SELECT a.*, EXISTS(SELECT 1 FROM local_request_revision v
             WHERE v.request_id=a.request_id AND v.organization_id=a.organization_id
               AND v.revision=a.revision AND v.snapshot_hash=$4) AS revision_hash_ok
           FROM local_request_approval a
           WHERE a.request_id=$1 AND a.organization_id=$2 AND a.revision=$3
             AND a.route_generation=$5 AND a.state<>'invalidated'`
        : `SELECT a.*, EXISTS(SELECT 1 FROM local_request_revision v
             WHERE v.request_id=a.request_id AND v.organization_id=a.organization_id
               AND v.revision=a.revision AND v.snapshot_hash=$4) AS revision_hash_ok
           FROM local_request_approval a
           WHERE a.request_id=$1 AND a.organization_id=$2 AND a.revision=$3
             AND a.route_generation=$5
           ORDER BY a.step_no, a.id`,
      [q.id, q.organization_id, q.revision, q.snapshot_hash, revision.route_generation],
    )
  ).rows;
  if (rows.length === 0) return fail('no_current_approval');
  if (revision.route === null && rows.length !== 1) return fail('approval_row_count');

  // 4. 経路の段数・stepNo・承認者・権限種別・世代・route_hash
  const routeCheck = checkRouteAgainstSteps({
    route: revision.route,
    routeHash: revision.route_hash,
    routeGeneration: revision.route_generation,
    revision: q.revision,
    steps: rows,
  });
  if (!routeCheck.ok) return fail(routeCheck.reason);

  // 5. 全ステップが approved で、current_approval_id が最終ステップを指す
  if (rows.some((approval) => approval.state !== 'approved')) return fail('approval_not_approved');
  if (!q.current_approval_id || rows[rows.length - 1]!.id !== q.current_approval_id)
    return fail('approval_not_current');

  for (const approval of rows) {
    // 6. 期限内。現行の挙動(expires_at > 現在時刻)を維持し、決定時刻が期限を超えていないことも見る
    // 列が欠けた行・型が違う行は通さない(fail closed)
    if (!(approval.expires_at instanceof Date)) return fail('approval_expired');
    if (approval.expires_at.getTime() <= Date.now()) return fail('approval_expired');
    if (!(approval.decided_at instanceof Date)) return fail('decided_after_expiry');
    if (approval.decided_at.getTime() > approval.expires_at.getTime())
      return fail('decided_after_expiry');
    // 7. snapshot_hash(申請・版・承認行)、再計算値、revision
    if (approval.snapshot_hash !== q.snapshot_hash) return fail('snapshot_hash_mismatch');
    if (approval.revision_hash_ok !== true) return fail('revision_hash_mismatch');
    if (approval.revision !== q.revision) return fail('revision_mismatch');
  }
  if (hash(q.snapshot) !== q.snapshot_hash) return fail('snapshot_tampered');
  if (revision.snapshot_hash !== q.snapshot_hash) return fail('revision_hash_mismatch');

  // 8. 固定承認者。route が NULL の移行前の1行にだけ、カタログ定義との一致を要求する。
  if (revision.route === null) {
    const fixed = q.snapshot.item.definition.approval;
    if (fixed?.approverId && fixed.approverId !== rows[0]!.approver_id)
      return fail('fixed_approver_mismatch');
  }

  // 9. 申請者と承認者が同一でない(静的な検査)/承認者同士が重複しない
  const approvers = rows.map((r) => r.approver_id);
  if (approvers.includes(q.requester_id)) return fail('self_approval');
  if (new Set(approvers).size !== approvers.length) return fail('duplicate_approver');

  // 10. 承認者の現在の有効性は要求しない(ADR-0023 §7)
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
