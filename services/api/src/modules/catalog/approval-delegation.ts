import type pg from 'pg';
import { APPROVAL_DELEGATION_MAX_PERIOD_DAYS } from '@solvi/shared/catalog';
import { approverAvailabilitySql } from './approval-route-state.js';

/**
 * 代理承認の委任(ADR-0025 / WP-P4-APR-020 §6.2〜§6.5)。
 *
 * ## 判定を書き写さない
 *
 * 「いま有効な委任か」は、期間・取消・**委任者の権限根拠**・**代理者の資格**の
 * 4つで決まる。この判定はこのファイルの `delegationValiditySql` だけに置き、
 * 可視性(一覧・受信箱・詳細)・決定・通知の宛先がそれぞれ書き直さない。
 * 有効な所属と `approver` ロールの判定は `approval-route-state.ts` の
 * `approverAvailabilitySql`(実体は `membership.ts`)を使う。
 *
 * ## 委任者と代理者の資格
 *
 * - 委任者は、**そのステップの種別の権限根拠**を満たすこと(ADR-0025 §3-3)。
 *   `fixed` / `legacy` は `approver` ロールも要り、`manager` / `department_head` は
 *   有効な所属だけで足りる(ADR-0023 §2)。委任者が無効なら委任は効かない。
 * - 代理者は、段の種別によらず**有効な所属かつ `approver` ロール**を持つこと
 *   (ADR-0025 §2)。そのため代理者の判定は常に `fixed` の権限根拠で行う。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELEGATION_MAX_PERIOD_MS = APPROVAL_DELEGATION_MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/** 委任の状態(APIの応答。WP-P4-APR-020 §6.2)。 `unknown` は値が読めない場合(fail closed)。 */
export const DELEGATION_STATES = [
  'scheduled',
  'active',
  'ended',
  'revoked',
  'delegate_ineligible',
  'unknown',
] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];

export type DelegationRow = {
  id: string;
  organization_id: string;
  delegator_id: string;
  delegate_id: string;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
};

/**
 * 委任の状態を導出する(純粋関数)。**取消を最優先**にし、その後に期間を見る。
 * 代理者の資格は呼び出し側が判定した値を渡す(判定をここで書き直さない)。
 * 値が読めない場合は `unknown`(使用不可)にする。
 */
export function delegationStateFor(input: {
  startsAt: unknown;
  endsAt: unknown;
  revokedAt: unknown;
  delegateEligible: boolean;
  now: Date;
}): DelegationState {
  if (
    !(input.startsAt instanceof Date) ||
    !(input.endsAt instanceof Date) ||
    Number.isNaN(input.startsAt.getTime()) ||
    Number.isNaN(input.endsAt.getTime())
  )
    return 'unknown';
  if (input.revokedAt !== null && !(input.revokedAt instanceof Date)) return 'unknown';
  if (input.revokedAt instanceof Date) return 'revoked';
  if (input.endsAt.getTime() <= input.now.getTime()) return 'ended';
  if (input.startsAt.getTime() > input.now.getTime()) return 'scheduled';
  if (input.delegateEligible !== true) return 'delegate_ineligible';
  return 'active';
}

export type DelegationPeriodProblem =
  'ends_not_after_start' | 'ends_not_future' | 'period_too_long' | 'starts_too_early';

/**
 * 作成時の期間の検証(ADR-0025 §3)。判定は**呼び出し側が1回読んだDBの時刻**で行う。
 * 開始は「現在より5分前」まで許す。それより前は拒否する(遡って有効な委任を作らせない)。
 * 呼び出し側は `APPROVAL_DELEGATION_START_TOLERANCE_MINUTES` を分に足した値を使う。
 */
export function checkDelegationPeriod(input: {
  startsAt: Date;
  endsAt: Date;
  now: Date;
  startToleranceMs: number;
}): DelegationPeriodProblem | null {
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) return 'ends_not_after_start';
  if (input.endsAt.getTime() <= input.now.getTime()) return 'ends_not_future';
  if (input.endsAt.getTime() - input.startsAt.getTime() > DELEGATION_MAX_PERIOD_MS)
    return 'period_too_long';
  if (input.startsAt.getTime() < input.now.getTime() - input.startToleranceMs)
    return 'starts_too_early';
  return null;
}

/**
 * 代理者の資格(有効な所属かつ `approver` ロール)の SQL 述語。
 * `userStatus` は利用者行の状態を返す固定のSQL式を渡す(利用者入力を連結しない)。
 */
export function delegationEligibilitySql(input: {
  organizationId: string;
  userId: string;
  at: string;
  userStatus: string;
}): string {
  return approverAvailabilitySql({
    organizationId: input.organizationId,
    approverId: input.userId,
    at: input.at,
    authorityType: "'fixed'",
    userStatus: input.userStatus,
  });
}

/**
 * 委任の有効性の SQL 述語(`alias` の行について)。**この1か所だけが条件を持つ。**
 *
 * - 取り消されていない
 * - 判定時刻が `[starts_at, ends_at)` に入る
 * - 委任者が、そのステップの権限根拠を満たす
 * - 代理者が、段の種別によらず `approver` ロールと有効な所属を持つ
 *
 * `delegatorStatus` / `delegateStatus` を省略すると、`app_user` から状態を引く
 * スカラー副問い合わせになる(利用者が見つからない場合は NULL で不成立)。
 */
export function delegationValiditySql(input: {
  alias: string;
  organizationId: string;
  delegatorId: string;
  delegateId: string;
  at: string;
  authorityType: string;
  delegatorStatus?: string;
  delegateStatus?: string;
}): string {
  const statusOf = (userId: string) => `(SELECT su.status FROM app_user su WHERE su.id=${userId})`;
  const delegatorStatus = input.delegatorStatus ?? statusOf(input.delegatorId);
  const delegateStatus = input.delegateStatus ?? statusOf(input.delegateId);
  return `(${input.alias}.revoked_at IS NULL
    AND ${input.alias}.starts_at <= ${input.at}
    AND ${input.alias}.ends_at > ${input.at}
    AND ${approverAvailabilitySql({
      organizationId: input.organizationId,
      approverId: input.delegatorId,
      at: input.at,
      authorityType: input.authorityType,
      userStatus: delegatorStatus,
    })}
    AND ${delegationEligibilitySql({
      organizationId: input.organizationId,
      userId: input.delegateId,
      at: input.at,
      userStatus: delegateStatus,
    })})`;
}

/** 段の承認者宛ての、代理者にとって有効な委任があるかを返す SQL 述語。 */
export function effectiveDelegationSql(input: {
  organizationId: string;
  delegatorId: string;
  delegateId: string;
  at: string;
  authorityType: string;
}): string {
  return `EXISTS (
    SELECT 1 FROM approval_delegation d
     WHERE d.organization_id=${input.organizationId}
       AND d.delegator_id=${input.delegatorId}
       AND d.delegate_id=${input.delegateId}
       AND ${delegationValiditySql({ ...input, alias: 'd' })}
  )`;
}

export type DecisionDelegation = {
  id: string;
  delegatorId: string;
  delegateId: string;
  startsAt: Date;
  endsAt: Date;
};

export type DecisionDelegationResult =
  | { ok: true; delegation: DecisionDelegation }
  | { ok: false; reason: 'none' | 'multiple' | 'shape' };

/**
 * 決定に使える委任を1件引く。**呼び出し側は申請の行をロックしていること。**
 * 委任の行は `FOR SHARE` でロックし、取消(`FOR UPDATE`)と直列化する。
 *
 * - 該当が無ければ `none`。資格を失った委任・期間外・取消済みも `none` になる。
 * - 該当が2件以上なら `multiple`(設計上ありえない。fail closed で拒否する)。
 * - 値が読めない・型が違う場合は `shape`。
 */
export async function loadDecisionDelegation(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    delegatorId: string;
    delegateId: string;
    authorityType: string;
    now: Date;
  },
): Promise<DecisionDelegationResult> {
  if (
    !UUID.test(input.delegatorId) ||
    !UUID.test(input.delegateId) ||
    !(input.now instanceof Date) ||
    Number.isNaN(input.now.getTime())
  )
    return { ok: false, reason: 'shape' };
  const rows = (
    await client.query<{
      id: unknown;
      delegator_id: unknown;
      delegate_id: unknown;
      starts_at: unknown;
      ends_at: unknown;
    }>(
      `SELECT d.id, d.delegator_id, d.delegate_id, d.starts_at, d.ends_at
         FROM approval_delegation d
         JOIN app_user du ON du.id=d.delegate_id
        WHERE d.organization_id=$1
          AND d.delegator_id=$2
          AND d.delegate_id=$3
          AND ${delegationValiditySql({
            alias: 'd',
            organizationId: '$1',
            delegatorId: '$2',
            delegateId: '$3',
            at: '$4',
            authorityType: '$5',
            delegateStatus: 'du.status',
          })}
        ORDER BY d.starts_at DESC, d.id
        FOR SHARE OF d`,
      [input.organizationId, input.delegatorId, input.delegateId, input.now, input.authorityType],
    )
  ).rows;
  if (rows.length === 0) return { ok: false, reason: 'none' };
  if (rows.length !== 1) return { ok: false, reason: 'multiple' };
  const row = rows[0];
  if (
    !row ||
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    typeof row.delegator_id !== 'string' ||
    typeof row.delegate_id !== 'string' ||
    !(row.starts_at instanceof Date) ||
    !(row.ends_at instanceof Date)
  )
    return { ok: false, reason: 'shape' };
  return {
    ok: true,
    delegation: {
      id: row.id,
      delegatorId: row.delegator_id,
      delegateId: row.delegate_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    },
  };
}

/**
 * ある段の、ある代理者にとって有効な委任を1件読む(読み取り専用)。
 * 詳細の「誰の代理か」の表示に使う。ロックはしない。
 */
export async function findEffectiveDelegation(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    delegatorId: string;
    delegateId: string;
    authorityType: string;
    now: Date;
  },
): Promise<{ id: string; delegatorId: string } | null> {
  const row = (
    await client.query<{ id: unknown; delegator_id: unknown }>(
      `SELECT d.id, d.delegator_id
         FROM approval_delegation d
        WHERE d.organization_id=$1
          AND d.delegator_id=$2
          AND d.delegate_id=$3
          AND ${delegationValiditySql({
            alias: 'd',
            organizationId: '$1',
            delegatorId: '$2',
            delegateId: '$3',
            at: '$4',
            authorityType: '$5',
          })}
        ORDER BY d.starts_at DESC, d.id
        LIMIT 1`,
      [input.organizationId, input.delegatorId, input.delegateId, input.now, input.authorityType],
    )
  ).rows[0];
  if (!row || typeof row.id !== 'string' || typeof row.delegator_id !== 'string') return null;
  return { id: row.id, delegatorId: row.delegator_id };
}
