import type pg from 'pg';
import { activeMembershipSql } from './approval-resolver.js';
import {
  parseApprovalRoute,
  routeHash,
  type ApprovalRoute,
  type ApprovalStepRow,
  type ApprovalRouteStep,
} from './approval-state.js';

/**
 * 現在の承認経路の導出 (WP-P4-APR-018 §6-2 / ADR-0024 §1・§2)。
 *
 * 版(`local_request_revision`)の列は**世代1の記録**であり、再割当では書き換えない。
 * 世代2以降は追記専用の `local_request_route_generation` に積む。
 * 「現在の経路」「段ごとの有効な世代」を決める判定はこのファイルだけに置き、
 * 決定・実行前検証・一覧・詳細・滞留の導出がそれぞれ書き直さない。
 *
 * ## 有効な世代
 *
 * 段 k の有効な世代は `from_step_no <= k` を満たす**最大**の世代である
 * (世代1は `from_step_no = 1` とみなす)。再割当は承認済みの段を複製せず、
 * 世代の `route` は全段を持つ。`from_step_no` より前の段は直前の世代と
 * 一致しなければならない。ここでは保存された行の整合性を fail closed で検証する。
 *
 * ## SQL 版
 *
 * 一覧・受信箱はページングのため SQL で同じ導出を行う。式はこのファイルの
 * `effectiveGenerationSql` / `effectiveAuthorityTypeSql` / `approverAvailabilitySql`
 * だけが生成する(呼び出し側で書き直さない)。式に渡してよいのは固定のSQL式だけで、
 * 利用者入力を連結しない。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export type RouteGenerationFailure =
  | 'revision_missing'
  | 'route_invalid'
  | 'route_hash_mismatch'
  | 'route_generation_mismatch'
  | 'route_generation_sequence'
  | 'route_generation_shape'
  | 'route_generation_step_count'
  | 'route_generation_prefix_mismatch'
  | 'route_generation_rule_mismatch';

export type RouteGeneration = {
  generation: number;
  fromStepNo: number;
  route: ApprovalRoute;
  routeHash: string;
  reason: string;
  createdBy: string;
  createdAt: Date;
};

export type RouteState = {
  revision: number;
  /** 版の列が持つ世代1。移行前の版は null。 */
  baseRoute: ApprovalRoute | null;
  baseRouteHash: string | null;
  /** 世代の行があれば最大の世代、無ければ版の列。 */
  currentRoute: ApprovalRoute | null;
  currentRouteHash: string | null;
  currentGeneration: number;
  generations: RouteGeneration[];
  /** 段番号 -> 有効な世代。世代の行が無い版は全段 1。 */
  effectiveByStep: Map<number, number>;
};

export type RouteStateResult =
  { ok: true; state: RouteState } | { ok: false; reason: RouteGenerationFailure };

export type RouteBaseRow = {
  route: unknown;
  route_hash: unknown;
  route_generation: unknown;
};

export type RouteGenerationRow = {
  route_generation: unknown;
  from_step_no: unknown;
  route: unknown;
  route_hash: unknown;
  reason: unknown;
  created_by: unknown;
  created_at: unknown;
};

export type DeriveRouteStateInput = {
  revision: number;
  base: RouteBaseRow;
  generations: RouteGenerationRow[];
};

function sameStep(left: ApprovalRouteStep, right: ApprovalRouteStep): boolean {
  return (
    left.stepNo === right.stepNo &&
    left.approverId === right.approverId &&
    left.authorityType === right.authorityType &&
    left.resolvedFrom === right.resolvedFrom
  );
}

function sameRuleRef(left: ApprovalRoute['ruleRef'], right: ApprovalRoute['ruleRef']): boolean {
  if (left === null || right === null) return left === right;
  return left.ruleId === right.ruleId && left.revision === right.revision;
}

/**
 * 版の列と世代の行から現在の経路を導出する(純粋関数)。
 * 値が読めない・型が違う・並びが飛ぶ・前の世代と食い違う場合は失敗にする。
 */
export function deriveRouteState(input: DeriveRouteStateInput): RouteStateResult {
  const fail = (reason: RouteGenerationFailure): RouteStateResult => ({ ok: false, reason });
  if (
    !has(input.base, 'route') ||
    !has(input.base, 'route_hash') ||
    !has(input.base, 'route_generation')
  )
    return fail('route_invalid');
  const generation = input.base.route_generation;
  if (!Number.isInteger(generation) || (generation as number) < 1)
    return fail('route_generation_mismatch');

  if (input.base.route === null) {
    if (input.base.route_hash !== null) return fail('route_hash_mismatch');
    if (generation !== 1) return fail('route_generation_mismatch');
    // 移行前の版に世代の行は無い。あれば整合性を説明できないため失敗にする。
    if (input.generations.length > 0) return fail('route_generation_mismatch');
    return {
      ok: true,
      state: {
        revision: input.revision,
        baseRoute: null,
        baseRouteHash: null,
        currentRoute: null,
        currentRouteHash: null,
        currentGeneration: 1,
        generations: [],
        effectiveByStep: new Map([[1, 1]]),
      },
    };
  }

  const baseRoute = parseApprovalRoute(input.base.route);
  if (!baseRoute) return fail('route_invalid');
  if (
    typeof input.base.route_hash !== 'string' ||
    !HASH.test(input.base.route_hash) ||
    routeHash(baseRoute) !== input.base.route_hash
  )
    return fail('route_hash_mismatch');
  // 版の列は世代1の記録である。ここが1以外なら、どの世代が正本か決められない。
  if (generation !== 1) return fail('route_generation_mismatch');

  const stepCount = baseRoute.steps.length;
  const generations: RouteGeneration[] = [];
  let previousRoute = baseRoute;
  let expected = 2;
  for (const row of input.generations) {
    if (
      !has(row, 'route_generation') ||
      !has(row, 'from_step_no') ||
      !has(row, 'route') ||
      !has(row, 'route_hash') ||
      !has(row, 'reason') ||
      !has(row, 'created_by') ||
      !has(row, 'created_at')
    )
      return fail('route_generation_shape');
    if (!Number.isInteger(row.route_generation)) return fail('route_generation_shape');
    if (row.route_generation !== expected) return fail('route_generation_sequence');
    const fromStepNo = row.from_step_no;
    if (!Number.isInteger(fromStepNo) || (fromStepNo as number) < 1 || (fromStepNo as number) > 3)
      return fail('route_generation_shape');
    const from = fromStepNo as number;
    if (from > stepCount) return fail('route_generation_step_count');
    const route = parseApprovalRoute(row.route);
    if (!route) return fail('route_invalid');
    if (
      typeof row.route_hash !== 'string' ||
      !HASH.test(row.route_hash) ||
      routeHash(route) !== row.route_hash
    )
      return fail('route_hash_mismatch');
    if (route.steps.length !== stepCount) return fail('route_generation_step_count');
    if (!sameRuleRef(route.ruleRef, baseRoute.ruleRef))
      return fail('route_generation_rule_mismatch');
    // from_step_no より前の段は、直前の世代と同じでなければならない。
    for (let index = 0; index < from - 1; index += 1) {
      const previous = previousRoute.steps[index];
      const current = route.steps[index];
      if (!previous || !current || !sameStep(previous, current))
        return fail('route_generation_prefix_mismatch');
    }
    if (
      typeof row.reason !== 'string' ||
      row.reason.length < 1 ||
      row.reason.length > 2000 ||
      typeof row.created_by !== 'string' ||
      !UUID.test(row.created_by) ||
      !(row.created_at instanceof Date)
    )
      return fail('route_generation_shape');
    generations.push({
      generation: row.route_generation,
      fromStepNo: from,
      route,
      routeHash: row.route_hash,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    });
    previousRoute = route;
    expected += 1;
  }

  const effectiveByStep = new Map<number, number>();
  for (let stepNo = 1; stepNo <= stepCount; stepNo += 1) {
    let effective = 1;
    for (const item of generations) if (item.fromStepNo <= stepNo) effective = item.generation;
    effectiveByStep.set(stepNo, effective);
  }
  const current = generations[generations.length - 1];
  return {
    ok: true,
    state: {
      revision: input.revision,
      baseRoute,
      baseRouteHash: input.base.route_hash,
      currentRoute: current ? current.route : baseRoute,
      currentRouteHash: current ? current.routeHash : input.base.route_hash,
      currentGeneration: current ? current.generation : 1,
      generations,
      effectiveByStep,
    },
  };
}

/**
 * 申請の版の現在の経路を読む。版の列と世代の行を1か所で読み、
 * `deriveRouteState` の検証を通す。行が無ければ失敗(fail closed)。
 */
export async function loadRouteState(
  client: pg.PoolClient,
  input: { organizationId: string; requestId: string; revision: number },
): Promise<RouteStateResult> {
  const base = (
    await client.query<RouteBaseRow>(
      `SELECT route, route_hash, route_generation FROM local_request_revision
        WHERE request_id=$1 AND organization_id=$2 AND revision=$3`,
      [input.requestId, input.organizationId, input.revision],
    )
  ).rows[0];
  if (!base) return { ok: false, reason: 'revision_missing' };
  const generations = (
    await client.query<RouteGenerationRow>(
      `SELECT route_generation, from_step_no, route, route_hash, reason, created_by, created_at
         FROM local_request_route_generation
        WHERE request_id=$1 AND organization_id=$2 AND revision=$3
        ORDER BY route_generation`,
      [input.requestId, input.organizationId, input.revision],
    )
  ).rows;
  return deriveRouteState({ revision: input.revision, base, generations });
}

/** 段 k の有効な世代。範囲外は null。 */
export function effectiveGenerationForStep(state: RouteState, stepNo: number): number | null {
  return state.effectiveByStep.get(stepNo) ?? null;
}

/** 段 k の有効な経路ステップ。 */
export function effectiveRouteStep(state: RouteState, stepNo: number): ApprovalRouteStep | null {
  return state.currentRoute?.steps[stepNo - 1] ?? null;
}

/** 段 k の有効な承認行。見つからなければ null。 */
export function effectiveStepRow(
  state: RouteState,
  rows: readonly ApprovalStepRow[],
  stepNo: number,
): ApprovalStepRow | null {
  const generation = effectiveGenerationForStep(state, stepNo);
  if (generation === null) return null;
  const matches = rows.filter(
    (row) => row.step_no === stepNo && row.route_generation === generation,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * 段 `stepNo` の有効な世代を返すSQL式。一覧・受信箱の結合条件に使う。
 * `baseGeneration` は版の `route_generation` を指す式。
 */
export function effectiveGenerationSql(input: {
  requestId: string;
  organizationId: string;
  revision: string;
  stepNo: string;
  baseGeneration: string;
}): string {
  return `COALESCE((
    SELECT max(g.route_generation) FROM local_request_route_generation g
     WHERE g.request_id=${input.requestId}
       AND g.organization_id=${input.organizationId}
       AND g.revision=${input.revision}
       AND g.from_step_no <= ${input.stepNo}
  ), ${input.baseGeneration})`;
}

/**
 * 段 `stepNo` の有効な権限種別を返すSQL式。世代の行の経路を優先し、
 * 無ければ版の経路、最後に承認行の値を返す(表示のための導出)。
 */
export function effectiveAuthorityTypeSql(input: {
  requestId: string;
  organizationId: string;
  revision: string;
  stepNo: string;
  baseRouteAuthority: string;
  fallback: string;
}): string {
  return `COALESCE((
    SELECT g.route->'steps'->(${input.stepNo}-1)->>'authorityType'
      FROM local_request_route_generation g
     WHERE g.request_id=${input.requestId}
       AND g.organization_id=${input.organizationId}
       AND g.revision=${input.revision}
       AND g.from_step_no <= ${input.stepNo}
     ORDER BY g.route_generation DESC
     LIMIT 1
  ), ${input.baseRouteAuthority}, ${input.fallback})`;
}

/**
 * 承認者が現在有効か(ADR-0023 §1・§2)を返すSQL述語。
 * 承認者不在の判定はこの1つの式だけを使う(一覧・詳細・再割当の条件)。
 */
export function approverAvailabilitySql(input: {
  organizationId: string;
  approverId: string;
  at: string;
  authorityType: string;
  userStatus: string;
}): string {
  return `(${input.userStatus} = 'active'
    AND ${activeMembershipSql(input.approverId, input.organizationId, input.at)}
    AND (${input.authorityType} NOT IN ('fixed','legacy')
      OR EXISTS (
        SELECT 1 FROM role_binding arb JOIN role ar ON ar.id=arb.role_id
         WHERE arb.user_id=${input.approverId}
           AND arb.organization_id=${input.organizationId}
           AND arb.role_scope='org' AND ar.code='approver'
           AND arb.valid_from<=${input.at}
           AND (arb.valid_until IS NULL OR arb.valid_until>${input.at}))))`;
}

/**
 * 単一の承認者について、承認者不在かどうかを判定する。
 * `approverAvailabilitySql` と同じ述語を実行する(判定を二重に書かない)。
 * 利用者が見つからない場合も「不在」とする(fail closed)。
 */
export async function isApproverUnavailable(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    approverId: string;
    authorityType: string;
    now: Date;
  },
): Promise<boolean> {
  const row = (
    await client.query<{ available: boolean }>(
      `SELECT ${approverAvailabilitySql({
        organizationId: '$1',
        approverId: '$2',
        at: '$3',
        authorityType: '$4',
        userStatus: 'ap.status',
      })} AS available
         FROM app_user ap WHERE ap.id=$2`,
      [input.organizationId, input.approverId, input.now, input.authorityType],
    )
  ).rows[0];
  return row?.available !== true;
}
