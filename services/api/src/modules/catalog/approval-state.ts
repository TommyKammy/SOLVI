import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { uuidv7 } from '../../common/audit/audit.js';
import { hash } from './snapshot-hash.js';

/**
 * 承認の状態機械とステップの更新(WP-P4-APR-014 / 03.5 / ADR-0023 §6・§8)。
 *
 * 03.5 の「多段での読み方」を**遷移表**として定義し、承認行・申請行の状態更新は
 * このファイルの関数だけが行う。`catalog.routes.ts` に状態を直接更新する SQL を置かない。
 *
 * 未定義の遷移(承認済みの再承認、却下後の承認など)は null になり、呼び出し側が 409 にする。
 * ここではフラグによる切替を設けない。
 */

export const AUTHORITY_TYPES = ['legacy', 'fixed', 'manager', 'department_head'] as const;
export type AuthorityType = (typeof AUTHORITY_TYPES)[number];

export const STEP_STATES = [
  'pending',
  'approved',
  'rejected',
  'invalidated',
  'cancelled',
  'expired',
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const REQUEST_STATES = [
  'pending',
  'approved',
  'rejected',
  'invalidated',
  'completed',
  'cancelled',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** 経路の1ステップ。`route` の JSON と同じ形(ADR-0023 §11 / WP §6.1)。 */
export type ApprovalRouteStep = {
  stepNo: number;
  approverId: string;
  authorityType: AuthorityType;
  resolvedFrom: string | null;
};

/**
 * 版に固定する経路。`ruleRef` は WP-P4-APR-015 が入れる。
 * 本WPの製品コードは常に1段(`steps.length === 1`)を生成する。
 */
export type ApprovalRoute = {
  steps: ApprovalRouteStep[];
  ruleRef: null | { ruleId: string; revision: number };
};

export type ApprovalTrigger = 'approve' | 'reject' | 'edit' | 'revoke' | 'expire' | 'reassign';
export type TransitionPosition = 'intermediate' | 'final' | 'any';

export type ApprovalTransition = {
  trigger: ApprovalTrigger;
  stepFrom: StepState;
  requestFrom: RequestState | 'any';
  position: TransitionPosition;
  stepTo: StepState;
  /** 遷移後に申請が取る状態。`unchanged` は申請の状態を変えない(期限切れの導出)。 */
  requestTo: RequestState | 'unchanged';
  /** 途中ステップの承認で次のステップ行を作るか。 */
  createNextStep: boolean;
};

/**
 * 03.5「承認状態機械(正本)」の多段での読み方と 1:1 の遷移表。
 * **この表を変えるときは tests/unit/approval-state.test.ts の表も同じ変更で直す。**
 */
export const APPROVAL_TRANSITIONS: readonly ApprovalTransition[] = [
  // 途中ステップの承認: 当該 Approved、次のステップを Pending で作成、申請は Pending のまま
  {
    trigger: 'approve',
    stepFrom: 'pending',
    requestFrom: 'pending',
    position: 'intermediate',
    stepTo: 'approved',
    requestTo: 'pending',
    createNextStep: true,
  },
  // 最終ステップの承認: 当該 Approved、申請 Approved
  {
    trigger: 'approve',
    stepFrom: 'pending',
    requestFrom: 'pending',
    position: 'final',
    stepTo: 'approved',
    requestTo: 'approved',
    createNextStep: false,
  },
  // いずれかのステップの却下: 当該 Rejected、申請 Rejected
  {
    trigger: 'reject',
    stepFrom: 'pending',
    requestFrom: 'pending',
    position: 'any',
    stepTo: 'rejected',
    requestTo: 'rejected',
    createNextStep: false,
  },
  // 申請内容の変更: その版の全ステップ Invalidated、新しい版で Pending
  {
    trigger: 'edit',
    stepFrom: 'pending',
    requestFrom: 'pending',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  {
    trigger: 'edit',
    stepFrom: 'approved',
    requestFrom: 'pending',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  {
    trigger: 'edit',
    stepFrom: 'approved',
    requestFrom: 'approved',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  {
    trigger: 'edit',
    stepFrom: 'rejected',
    requestFrom: 'rejected',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  // 却下された申請で、先行ステップが承認済みのまま残っている場合
  {
    trigger: 'edit',
    stepFrom: 'approved',
    requestFrom: 'rejected',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  // 承認取消済みの申請の変更: ステップは既に Invalidated。
  // 状態は変えず(更新も approval.invalidated も重ねて書かない)、新しい版で Pending にする。
  {
    trigger: 'edit',
    stepFrom: 'invalidated',
    requestFrom: 'invalidated',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  {
    trigger: 'edit',
    stepFrom: 'expired',
    requestFrom: 'pending',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  {
    trigger: 'edit',
    stepFrom: 'expired',
    requestFrom: 'approved',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'pending',
    createNextStep: false,
  },
  // 承認取消: その版の全ステップ Invalidated、申請 Invalidated
  {
    trigger: 'revoke',
    stepFrom: 'approved',
    requestFrom: 'approved',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'invalidated',
    createNextStep: false,
  },
  // 期限切れ: 当該 Expired。申請の Expired は導出で、状態は変えない
  {
    trigger: 'expire',
    stepFrom: 'pending',
    requestFrom: 'pending',
    position: 'any',
    stepTo: 'expired',
    requestTo: 'unchanged',
    createNextStep: false,
  },
  {
    trigger: 'expire',
    stepFrom: 'pending',
    requestFrom: 'approved',
    position: 'any',
    stepTo: 'expired',
    requestTo: 'unchanged',
    createNextStep: false,
  },
  // 再割当: 承認者不在の未決定ステップだけを Invalidated にし、申請の状態は変えない。
  // 経路を変える唯一の遷移である(ADR-0024 §2・§3)。
  {
    trigger: 'reassign',
    stepFrom: 'pending',
    requestFrom: 'pending',
    position: 'any',
    stepTo: 'invalidated',
    requestTo: 'unchanged',
    createNextStep: false,
  },
] as const;

export function transitionFor(
  trigger: ApprovalTrigger,
  input: {
    stepState: StepState;
    requestState: RequestState;
    position: TransitionPosition;
  },
): ApprovalTransition | null {
  return (
    APPROVAL_TRANSITIONS.find(
      (row) =>
        row.trigger === trigger &&
        row.stepFrom === input.stepState &&
        (row.requestFrom === 'any' || row.requestFrom === input.requestState) &&
        (row.position === 'any' || row.position === input.position),
    ) ?? null
  );
}

/** 経路・世代・ステップ行の整合性。fail closed で、少しでも欠ければ通さない。 */
export type RouteCheckFailure =
  | 'route_invalid'
  | 'route_hash_mismatch'
  | 'route_generation_mismatch'
  | 'route_step_count'
  | 'route_step_mismatch';

export type RouteStepRow = {
  id: string;
  revision: number;
  route_generation: unknown;
  step_no: unknown;
  approver_id: string;
  authority_type: string;
  state: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/**
 * `route` の JSON を検証して正規化する。不正なら null。
 * `null` は「経路が無い(移行前の行)」として呼び出し側が区別する。
 */
export function parseApprovalRoute(value: unknown): ApprovalRoute | null {
  if (!isObject(value) || !onlyKeys(value, ['steps', 'ruleRef'])) return null;
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 3) return null;

  const parsed: ApprovalRouteStep[] = [];
  const approvers = new Set<string>();
  for (const [index, raw] of steps.entries()) {
    if (!isObject(raw) || !onlyKeys(raw, ['stepNo', 'approverId', 'authorityType', 'resolvedFrom']))
      return null;
    if (raw.stepNo !== index + 1) return null;
    if (typeof raw.approverId !== 'string' || !UUID.test(raw.approverId)) return null;
    if (
      typeof raw.authorityType !== 'string' ||
      !AUTHORITY_TYPES.includes(raw.authorityType as never)
    )
      return null;
    if (
      raw.resolvedFrom !== null &&
      (typeof raw.resolvedFrom !== 'string' || raw.resolvedFrom.length > 200)
    )
      return null;
    // 同一人物の重複は統合しない(ADR-0023 §9)。経路として拒否する。
    if (approvers.has(raw.approverId)) return null;
    approvers.add(raw.approverId);
    parsed.push({
      stepNo: raw.stepNo,
      approverId: raw.approverId,
      authorityType: raw.authorityType as AuthorityType,
      resolvedFrom: raw.resolvedFrom,
    });
  }

  let ruleRef: ApprovalRoute['ruleRef'] = null;
  if (value.ruleRef !== null) {
    const raw = value.ruleRef;
    if (!isObject(raw) || !onlyKeys(raw, ['ruleId', 'revision'])) return null;
    if (typeof raw.ruleId !== 'string' || raw.ruleId.length < 1 || raw.ruleId.length > 100)
      return null;
    if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) return null;
    ruleRef = { ruleId: raw.ruleId, revision: raw.revision as number };
  }
  return { steps: parsed, ruleRef };
}

export const routeHash = (route: ApprovalRoute): string => hash(route);

/**
 * 版の `route` / `route_hash` / `route_generation` と、その世代のステップ行を突き合わせる。
 *
 * - `route` が NULL の版(移行前)は、`step_no=1, authority_type='legacy',
 *   route_generation=1` の1行だけを許す。
 * - `route` がある版は、段数・stepNo・承認者・権限種別・世代・route_hash をすべて検査する。
 * - `allowPartial` は、まだ後続ステップが作られていない途中状態(決定・変更)で使う。
 *   実行前検証と取消は全ステップを要求する。
 */
export function checkRouteAgainstSteps(input: {
  route: unknown;
  routeHash: unknown;
  routeGeneration: unknown;
  revision: number;
  steps: RouteStepRow[];
  allowPartial?: boolean;
}):
  | { ok: true; route: ApprovalRoute | null; stepCount: number }
  | { ok: false; reason: RouteCheckFailure } {
  const fail = (reason: RouteCheckFailure) => ({ ok: false as const, reason });
  const generation = input.routeGeneration;
  if (!Number.isInteger(generation) || (generation as number) < 1)
    return fail('route_generation_mismatch');

  if (input.route === null) {
    if (input.routeHash !== null) return fail('route_hash_mismatch');
    if (generation !== 1) return fail('route_generation_mismatch');
    if (input.steps.length !== 1) return fail('route_step_count');
    const step = input.steps[0]!;
    if (
      step.revision !== input.revision ||
      step.route_generation !== 1 ||
      step.step_no !== 1 ||
      step.authority_type !== 'legacy'
    )
      return fail('route_step_mismatch');
    return { ok: true, route: null, stepCount: 1 };
  }

  const route = parseApprovalRoute(input.route);
  if (!route) return fail('route_invalid');
  if (typeof input.routeHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.routeHash))
    return fail('route_hash_mismatch');
  if (routeHash(route) !== input.routeHash) return fail('route_hash_mismatch');

  const max = route.steps.length;
  if (input.allowPartial ? input.steps.length > max : input.steps.length !== max)
    return fail('route_step_count');
  if (input.steps.length === 0) return fail('route_step_count');
  if (input.steps.some((step) => step.route_generation !== generation))
    return fail('route_generation_mismatch');

  for (const [index, step] of input.steps.entries()) {
    const expected = route.steps[index]!;
    if (
      step.revision !== input.revision ||
      step.route_generation !== generation ||
      step.step_no !== expected.stepNo ||
      step.approver_id !== expected.approverId ||
      step.authority_type !== expected.authorityType
    )
      return fail('route_step_mismatch');
  }
  return { ok: true, route, stepCount: max };
}

/** 承認行(ステップ)。`local_request_approval` の行。 */
export type ApprovalStepRow = {
  id: string;
  request_id: string;
  organization_id: string;
  revision: number;
  route_generation: number;
  step_no: number;
  approver_id: string;
  authority_type: string;
  state: string;
  snapshot_hash: string;
  reason: string | null;
  expires_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  resolved_from: string | null;
};

type RequestDescriptor = {
  id: string;
  organization_id: string;
  revision: number;
  version: number;
  state: RequestState;
  snapshot_hash: string;
};

function conflict(detail = '承認状態が更新されています。申請を再読み込みしてください') {
  return Problems.conflict(detail);
}

/**
 * 承認・却下を適用する。ステップ行の更新、申請行の状態更新、次ステップの作成を
 * 同一トランザクション内で行う。呼び出し側は申請行を `FOR UPDATE` していること。
 */
export async function applyApprovalDecision(
  client: pg.PoolClient,
  input: {
    request: RequestDescriptor;
    step: ApprovalStepRow;
    decision: 'approve' | 'reject';
    isFinalStep: boolean;
    reason: string | null;
    actorId: string;
    nextStep: ApprovalRouteStep | null;
    /** 次のステップを作る世代。有効な世代の導出結果を呼び出し側が渡す。 */
    nextRouteGeneration: number | null;
  },
): Promise<{ stepState: StepState; requestState: RequestState; nextStepId: string | null }> {
  const transition = transitionFor(input.decision, {
    stepState: input.step.state as StepState,
    requestState: input.request.state,
    position: input.isFinalStep ? 'final' : 'intermediate',
  });
  if (!transition) throw conflict('この承認ステップでは、その決定を受け付けられません');
  if (transition.createNextStep && !input.nextStep)
    throw conflict('次の承認ステップを確認できません');
  if (transition.createNextStep && input.nextRouteGeneration === null)
    throw conflict('次の承認ステップの世代を確認できません');

  const updated = await client.query<{ id: string }>(
    `UPDATE local_request_approval
        SET state=$2, reason=$3, decided_at=clock_timestamp(), decided_by=$4
      WHERE id=$1 AND organization_id=$5 AND request_id=$6 AND revision=$7
        AND route_generation=$8 AND step_no=$9 AND state=$10
      RETURNING id`,
    [
      input.step.id,
      transition.stepTo,
      input.reason,
      input.actorId,
      input.step.organization_id,
      input.request.id,
      input.request.revision,
      input.step.route_generation,
      input.step.step_no,
      input.step.state,
    ],
  );
  if (updated.rowCount !== 1) throw conflict();

  let nextStepId: string | null = null;
  if (transition.createNextStep) {
    const next = input.nextStep!;
    nextStepId = uuidv7();
    try {
      await client.query(
        `INSERT INTO local_request_approval(
           id, organization_id, request_id, revision, route_generation, step_no,
           snapshot_hash, approver_id, authority_type, resolved_from, state, expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',clock_timestamp()+interval '72 hours')`,
        [
          nextStepId,
          input.step.organization_id,
          input.request.id,
          input.request.revision,
          input.nextRouteGeneration,
          next.stepNo,
          input.step.snapshot_hash,
          next.approverId,
          next.authorityType,
          next.resolvedFrom,
        ],
      );
    } catch (error) {
      // ロックの内側で直列化しているが、念のため一意制約違反を 500 にしない。
      if ((error as { code?: string }).code === '23505') throw conflict();
      throw error;
    }
  }

  const requestState =
    transition.requestTo === 'unchanged' ? input.request.state : transition.requestTo;
  const currentApprovalId = nextStepId ?? input.step.id;
  const request = await client.query<{ version: number }>(
    `UPDATE local_service_request
        SET state=$2, current_approval_id=$3, version=version+1, updated_at=clock_timestamp()
      WHERE id=$1 AND organization_id=$4 AND version=$5 AND state=$6
      RETURNING version`,
    [
      input.request.id,
      requestState,
      currentApprovalId,
      input.request.organization_id,
      input.request.version,
      input.request.state,
    ],
  );
  if (request.rowCount !== 1) throw conflict();
  return { stepState: transition.stepTo, requestState, nextStepId };
}

/**
 * 版の全ステップを無効化する(申請内容の変更・承認取消)。
 * すべてのステップに遷移表上の遷移があることを先に確かめてから更新する。
 * 既に無効化済みのステップ(承認取消済みの申請の変更、再割当で置き換えられた
 * 旧世代の行)は更新せず、`approval.invalidated` の監査も重ねて書かない。
 * 戻り値の `invalidated` は**実際に状態が変わったステップ**だけを含む。
 *
 * ## 除外してよい `invalidated` の行
 *
 * 除外してよいのは、**同じ版の中で再割当に置き換えられた旧世代の行**である
 * (ADR-0024 §2)。再割当は未決定のステップだけを `invalidated` にし、
 * 申請の状態は変えない。そのため、その行には遷移表の `edit` / `revoke` を
 * 重ねて要求しない。一方、全行が `invalidated` のときに申請の状態を決めるのは
 * 遷移表だけであり、表に行が無ければ拒否する(下の `work.length === 0` の分岐)。
 */
export async function invalidateApprovalSteps(
  client: pg.PoolClient,
  input: {
    request: RequestDescriptor;
    steps: ApprovalStepRow[];
    trigger: 'edit' | 'revoke';
    reason: string;
    /** 申請内容の変更時だけ: 新しい版の内容 */
    next?: {
      snapshot: unknown;
      snapshotHash: string;
      revision: number;
      currentApprovalId: string;
    };
  },
): Promise<{ invalidated: ApprovalStepRow[]; requestState: RequestState }> {
  if (input.steps.length === 0) throw conflict('無効化する承認ステップを確認できません');
  // 既に無効化済みの行(再割当で置き換えられた旧世代)は更新も監査も重ねない。
  const work = input.steps.filter((step) => step.state !== 'invalidated');
  const transitions = work.map((step) =>
    transitionFor(input.trigger, {
      stepState: step.state as StepState,
      requestState: input.request.state,
      position: 'any',
    }),
  );
  if (transitions.some((transition) => transition === null))
    throw conflict('この申請の状態では承認を無効化できません');
  let requestTo: ApprovalTransition['requestTo'];
  if (transitions.length > 0) {
    requestTo = transitions[0]!.requestTo;
    if (transitions.some((transition) => transition!.requestTo !== requestTo))
      throw conflict('承認ステップの状態が揃っていません');
  } else {
    // 全ステップが既に無効化済み。ここでも遷移表を引く。
    // `edit / invalidated / invalidated → pending` だけが通り、`revoke` や
    // それ以外の申請の状態は表に行が無いため拒否する(fail closed)。
    const transition = transitionFor(input.trigger, {
      stepState: 'invalidated',
      requestState: input.request.state,
      position: 'any',
    });
    if (!transition) throw conflict('この申請の状態では承認を無効化できません');
    requestTo = transition.requestTo;
  }

  const invalidated: ApprovalStepRow[] = [];
  for (const [index, step] of work.entries()) {
    const transition = transitions[index]!;
    // 既に無効化済みのステップは更新しない(同じ監査を重ねて書かない)。
    if (transition.stepTo === step.state) continue;
    const updated = await client.query<{ id: string }>(
      `UPDATE local_request_approval
          SET state=$2, reason=$3
        WHERE id=$1 AND organization_id=$4 AND request_id=$5 AND revision=$6
          AND route_generation=$7 AND step_no=$8 AND state=$9
        RETURNING id`,
      [
        step.id,
        transition.stepTo,
        input.reason,
        step.organization_id,
        input.request.id,
        input.request.revision,
        step.route_generation,
        step.step_no,
        step.state,
      ],
    );
    if (updated.rowCount !== 1) throw conflict();
    invalidated.push(step);
  }

  const requestState = requestTo === 'unchanged' ? input.request.state : requestTo;
  if (input.next) {
    const request = await client.query<{ version: number }>(
      `UPDATE local_service_request
          SET state=$2, snapshot=$3, snapshot_hash=$4, revision=$5,
              current_approval_id=$6, version=version+1, updated_at=clock_timestamp()
        WHERE id=$1 AND organization_id=$7 AND version=$8 AND state=$9
        RETURNING version`,
      [
        input.request.id,
        requestState,
        input.next.snapshot,
        input.next.snapshotHash,
        input.next.revision,
        input.next.currentApprovalId,
        input.request.organization_id,
        input.request.version,
        input.request.state,
      ],
    );
    if (request.rowCount !== 1) throw conflict();
  } else {
    const request = await client.query<{ version: number }>(
      `UPDATE local_service_request
          SET state=$2, version=version+1, updated_at=clock_timestamp()
        WHERE id=$1 AND organization_id=$3 AND version=$4 AND state=$5
        RETURNING version`,
      [
        input.request.id,
        requestState,
        input.request.organization_id,
        input.request.version,
        input.request.state,
      ],
    );
    if (request.rowCount !== 1) throw conflict();
  }
  return { invalidated, requestState };
}

/**
 * 再割当を適用する(ADR-0024 §2・§3)。
 *
 * - 現在の pending ステップだけを遷移表 `reassign` 経由で `invalidated` にする。
 * - 新しい世代の最初の未決定ステップを `pending` で作る(期限はこの時点から72時間)。
 * - 承認済みステップの行は複製も更新もしない。
 * - 申請の状態は変えない。`current_approval_id` と版だけを進める。
 *
 * 呼び出し側は申請行を `FOR UPDATE` していること(決定と直列化する)。
 */
export async function applyReassignment(
  client: pg.PoolClient,
  input: {
    request: RequestDescriptor;
    step: ApprovalStepRow;
    nextStep: ApprovalRouteStep;
    nextRouteGeneration: number;
    reason: string;
    actorId: string;
  },
): Promise<{
  newApprovalId: string;
  invalidatedStep: ApprovalStepRow;
  requestState: RequestState;
}> {
  const transition = transitionFor('reassign', {
    stepState: input.step.state as StepState,
    requestState: input.request.state,
    position: 'any',
  });
  if (!transition || transition.stepTo !== 'invalidated' || transition.requestTo !== 'unchanged')
    throw conflict('この承認ステップは再割当できません');

  const updated = await client.query<{ id: string }>(
    `UPDATE local_request_approval
        SET state=$2, reason=$3
      WHERE id=$1 AND organization_id=$4 AND request_id=$5 AND revision=$6
        AND route_generation=$7 AND step_no=$8 AND state=$9
      RETURNING id`,
    [
      input.step.id,
      transition.stepTo,
      input.reason,
      input.step.organization_id,
      input.request.id,
      input.request.revision,
      input.step.route_generation,
      input.step.step_no,
      input.step.state,
    ],
  );
  if (updated.rowCount !== 1) throw conflict();

  const newApprovalId = uuidv7();
  try {
    await client.query(
      `INSERT INTO local_request_approval(
         id, organization_id, request_id, revision, route_generation, step_no,
         snapshot_hash, approver_id, authority_type, resolved_from, state, expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',clock_timestamp()+interval '72 hours')`,
      [
        newApprovalId,
        input.step.organization_id,
        input.request.id,
        input.request.revision,
        input.nextRouteGeneration,
        input.nextStep.stepNo,
        input.step.snapshot_hash,
        input.nextStep.approverId,
        input.nextStep.authorityType,
        input.nextStep.resolvedFrom,
      ],
    );
  } catch (error) {
    // ロックの内側で直列化しているが、主キー・一意制約違反を 500 にしない。
    if ((error as { code?: string }).code === '23505') throw conflict();
    throw error;
  }

  const request = await client.query<{ version: number }>(
    `UPDATE local_service_request
        SET current_approval_id=$2, version=version+1, updated_at=clock_timestamp()
      WHERE id=$1 AND organization_id=$3 AND version=$4 AND state=$5
      RETURNING version`,
    [
      input.request.id,
      newApprovalId,
      input.request.organization_id,
      input.request.version,
      input.request.state,
    ],
  );
  if (request.rowCount !== 1) throw conflict();
  return {
    newApprovalId,
    invalidatedStep: input.step,
    requestState: input.request.state,
  };
}

/** 模擬完了(承認済みの申請だけ)。承認の状態遷移ではないため、状態機械の外に置く。 */
export async function completeApprovalRequest(
  client: pg.PoolClient,
  input: { requestId: string; organizationId: string; expectedVersion: number },
): Promise<void> {
  const request = await client.query(
    `UPDATE local_service_request
        SET state='completed', version=version+1, updated_at=clock_timestamp()
      WHERE id=$1 AND organization_id=$2 AND version=$3 AND state='approved'`,
    [input.requestId, input.organizationId, input.expectedVersion],
  );
  if (request.rowCount !== 1) throw conflict('承認済みの申請だけ模擬完了できます');
}
