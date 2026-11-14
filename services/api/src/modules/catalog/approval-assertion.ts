import type pg from 'pg';
import { Problems, type Logger } from '@solvi/shared';
import { type ApprovalStepRow, type RouteCheckFailure } from './approval-state.js';
import {
  effectiveGenerationForStep,
  loadRouteState,
  type RouteGenerationFailure,
} from './approval-route-state.js';
import { hash } from './snapshot-hash.js';

/**
 * 承認完了の実行前検証(WP-P4-APR-011 / WP-P4-APR-014 / WP-P4-APR-018 / ADR-0023 §2・§7 / ADR-0024 §2)。
 *
 * 作業チェック更新・模擬完了の「承認済みか」の判定はこの1か所に集約する。
 * 現在の版の**段ごとの有効な世代**(再割当で増えた世代を含む)のステップ行を要求する。
 * 世代・経路の導出は `approval-route-state.ts` の共有関数だけを使い、ここで書き直さない。
 *
 * - 各段について、有効な世代のステップ行が `approved` で、承認者・権限種別が
 *   現在の経路と一致すること。
 * - 有効な世代でない行は `invalidated` でなければならない。
 * - 世代の行が読めない・欠けている・並びが飛ぶ・前の世代と食い違う場合は失敗する。
 *
 * **承認者の現在の有効性(所属・approver ロール・利用者状態)は要求しない**(ADR-0023 §7)。
 * 承認は決定時点の事実であり、後から承認者が無効になっても承認済みの申請の実行は止めない。
 * 不正な承認は承認取消(FR-CAT-009)で止める。
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
  | RouteCheckFailure
  | RouteGenerationFailure;

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
  revision_missing: '承認経路を確認できません',
  route_generation_sequence: '承認経路の世代が申請版と一致しません',
  route_generation_shape: '承認経路を確認できません',
  route_generation_step_count: '承認ステップの数が申請版と一致しません',
  route_generation_prefix_mismatch: '承認経路が申請版と一致しません',
  route_generation_rule_mismatch: '承認経路が申請版と一致しません',
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

  // 2. 現在の版の経路。版の列と世代の行を共有関数で導出する(列が欠けた行は通さない)。
  const routeState = await loadRouteState(client, {
    organizationId: q.organization_id,
    requestId: q.id,
    revision: q.revision,
  });
  if (!routeState.ok) return fail(routeState.reason);
  const state = routeState.state;

  // 3. 現在の版の全承認行(全世代)。有効な世代は段ごとに異なる。
  const rows = (
    await client.query<ApprovalRow>(
      `SELECT a.*, EXISTS(SELECT 1 FROM local_request_revision v
         WHERE v.request_id=a.request_id AND v.organization_id=a.organization_id
           AND v.revision=a.revision AND v.snapshot_hash=$4) AS revision_hash_ok
         FROM local_request_approval a
         WHERE a.request_id=$1 AND a.organization_id=$2 AND a.revision=$3
         ORDER BY a.route_generation, a.step_no, a.id`,
      [q.id, q.organization_id, q.revision, q.snapshot_hash],
    )
  ).rows;
  if (rows.length === 0) return fail('no_current_approval');

  let effectiveRows: ApprovalRow[];
  if (state.currentRoute === null) {
    // 移行前(route NULL)の版。世代の行は無く、無効化されていない1行だけを許す。
    const active = rows.filter((row) => row.state !== 'invalidated');
    if (active.length === 0) return fail('no_current_approval');
    if (active.length !== 1) return fail('approval_row_count');
    const step = active[0]!;
    if (
      step.revision !== q.revision ||
      step.route_generation !== 1 ||
      step.step_no !== 1 ||
      step.authority_type !== 'legacy'
    )
      return fail('route_step_mismatch');
    effectiveRows = [step];
  } else {
    const stepCount = state.currentRoute.steps.length;
    effectiveRows = [];
    for (let stepNo = 1; stepNo <= stepCount; stepNo += 1) {
      const generation = effectiveGenerationForStep(state, stepNo);
      if (generation === null) return fail('route_generation_mismatch');
      const candidates = rows.filter(
        (row) => row.step_no === stepNo && row.route_generation === generation,
      );
      if (candidates.length === 0) return fail('route_step_count');
      if (candidates.length !== 1) return fail('approval_row_count');
      const row = candidates[0]!;
      const expected = state.currentRoute.steps[stepNo - 1]!;
      if (
        row.revision !== q.revision ||
        row.approver_id !== expected.approverId ||
        row.authority_type !== expected.authorityType
      )
        return fail('route_step_mismatch');
      effectiveRows.push(row);
    }
    // 有効な世代でない行は、置き換えられた `invalidated` だけを許す。
    const effectiveIds = new Set(effectiveRows.map((row) => row.id));
    const knownGenerations = new Set([1, ...state.generations.map((item) => item.generation)]);
    for (const row of rows) {
      if (effectiveIds.has(row.id)) continue;
      if (row.revision !== q.revision) return fail('revision_mismatch');
      if (row.step_no < 1 || row.step_no > stepCount) return fail('route_step_count');
      if (row.route_generation > state.currentGeneration) return fail('route_generation_mismatch');
      if (!knownGenerations.has(row.route_generation)) return fail('route_generation_mismatch');
      if (row.state !== 'invalidated') return fail('route_generation_mismatch');
    }
    // 世代の行があるのに、その世代の承認行が1つも無い状態は説明できない。
    for (const generation of state.generations) {
      if (!rows.some((row) => row.route_generation === generation.generation))
        return fail('route_generation_mismatch');
    }
  }

  // 4. 全ステップが approved で、current_approval_id が最終ステップを指す
  if (effectiveRows.some((approval) => approval.state !== 'approved'))
    return fail('approval_not_approved');
  if (
    !q.current_approval_id ||
    effectiveRows[effectiveRows.length - 1]!.id !== q.current_approval_id
  )
    return fail('approval_not_current');

  for (const approval of effectiveRows) {
    // 5. 期限内。現行の挙動(expires_at > 現在時刻)を維持し、決定時刻が期限を超えていないことも見る
    // 列が欠けた行・型が違う行は通さない(fail closed)
    if (!(approval.expires_at instanceof Date)) return fail('approval_expired');
    if (approval.expires_at.getTime() <= Date.now()) return fail('approval_expired');
    if (!(approval.decided_at instanceof Date)) return fail('decided_after_expiry');
    if (approval.decided_at.getTime() > approval.expires_at.getTime())
      return fail('decided_after_expiry');
    // 6. snapshot_hash(申請・版・承認行)、再計算値、revision
    if (approval.snapshot_hash !== q.snapshot_hash) return fail('snapshot_hash_mismatch');
    if (approval.revision_hash_ok !== true) return fail('revision_hash_mismatch');
    if (approval.revision !== q.revision) return fail('revision_mismatch');
  }
  if (hash(q.snapshot) !== q.snapshot_hash) return fail('snapshot_tampered');

  // 7. 固定承認者。route が NULL の移行前の1行にだけ、カタログ定義との一致を要求する。
  if (state.currentRoute === null) {
    const fixed = q.snapshot.item.definition.approval;
    if (fixed?.approverId && fixed.approverId !== effectiveRows[0]!.approver_id)
      return fail('fixed_approver_mismatch');
  }

  // 8. 申請者と承認者が同一でない(静的な検査)/承認者同士が重複しない
  const approvers = effectiveRows.map((row) => row.approver_id);
  if (approvers.includes(q.requester_id)) return fail('self_approval');
  if (new Set(approvers).size !== approvers.length) return fail('duplicate_approver');

  // 9. 承認者の現在の有効性は要求しない(ADR-0023 §7)
  return {
    ok: true,
    steps: effectiveRows.map((row) => ({ approvalId: row.id, approverId: row.approver_id })),
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
