import { TRANSITIONS, type TicketState, type TransitionReason } from './state-machine.js';
import type { Priority } from './priority.js';

/**
 * SLAクロック(FR-TKT-008)。
 *
 * この機能の要点は停止条件にある。「利用者からの返信待ち」の時間を
 * IT部門の応答時間に数えると、担当者は返信を待つほど成績が悪くなる。
 * 結果として、指標を守るための不要な催促や、実態と合わない期限設定が起きる。
 *
 * 停止・再開の条件は状態機械の `slaClock` を唯一の根拠とする。
 * ここで独自の条件分岐を書くと、遷移表と実際の挙動が食い違う。
 */

export interface SlaClockState {
  /** クロックが動いている場合の開始時刻。停止中は null。 */
  startedAt: Date | null;
  /** 停止までに積み上がった経過秒数 */
  elapsedSeconds: number;
}

export interface SlaTarget {
  responseTargetMinutes: number;
  resolutionTargetMinutes: number;
}

export type ClockAction = 'run' | 'pause' | 'stop';

/**
 * 遷移に対応するクロックの挙動を返す。
 * 遷移表にない組合せは null(呼び出し側が遷移自体を拒否しているはず)。
 */
export function clockActionFor(
  from: TicketState,
  to: TicketState,
  reason: TransitionReason,
): ClockAction | null {
  const rule = TRANSITIONS.find((r) => r.from === from && r.to === to && r.reason === reason);
  return rule?.slaClock ?? null;
}

/**
 * クロックの状態を遷移に応じて更新する。
 *
 * - run: 停止中なら開始する。既に動いていれば何もしない(二重加算を防ぐ)
 * - pause / stop: 動いていれば経過を加算して止める
 */
export function applyClockAction(
  state: SlaClockState,
  action: ClockAction,
  now: Date,
): SlaClockState {
  const isRunning = state.startedAt !== null;

  if (action === 'run') {
    // 既に動いているなら開始時刻を上書きしない。
    // 上書きすると、それまでの経過が失われる。
    return isRunning ? state : { startedAt: now, elapsedSeconds: state.elapsedSeconds };
  }

  // pause / stop: 動いていた分を加算して止める
  if (!isRunning) return { startedAt: null, elapsedSeconds: state.elapsedSeconds };

  const delta = Math.max(0, Math.floor((now.getTime() - state.startedAt!.getTime()) / 1000));
  return { startedAt: null, elapsedSeconds: state.elapsedSeconds + delta };
}

/**
 * 現時点での経過秒数。動いていれば開始からの差分を足して返す。
 * DBの値をそのまま表示すると、動作中のチケットで実態より短く見える。
 */
export function currentElapsedSeconds(state: SlaClockState, now: Date): number {
  if (state.startedAt === null) return state.elapsedSeconds;
  const delta = Math.max(0, Math.floor((now.getTime() - state.startedAt.getTime()) / 1000));
  return state.elapsedSeconds + delta;
}

export interface SlaStatus {
  elapsedSeconds: number;
  responseTargetSeconds: number;
  resolutionTargetSeconds: number;
  /** 初回応答が目標を超えたか */
  responseBreached: boolean;
  /** 解決が目標を超えたか(未解決なら現時点の経過で判定) */
  resolutionBreached: boolean;
  /** 解決期限までの残り秒数。超過時は負値。 */
  remainingSeconds: number;
}

/**
 * SLAの判定。
 *
 * **超過しても何も止めない。** SLAは計測指標であり統制ではない(WP §6)。
 * 超過を理由に業務を止めると現場が回らない。
 */
export function evaluateSla(params: {
  clock: SlaClockState;
  target: SlaTarget;
  /** 初回応答の時刻。未応答なら null */
  firstRespondedAt: Date | null;
  /** チケット作成時刻。応答SLAの起点 */
  createdAt: Date;
  /** 解決済みならその時刻。未解決なら null */
  resolvedAt: Date | null;
  now: Date;
}): SlaStatus {
  const elapsed = currentElapsedSeconds(params.clock, params.now);
  const responseTargetSeconds = params.target.responseTargetMinutes * 60;
  const resolutionTargetSeconds = params.target.resolutionTargetMinutes * 60;

  // 応答SLA: 初回応答があればその時点までの経過、なければ現在までの経過で判定。
  // 応答前の待ち時間もクロックの対象なので、elapsed をそのまま使う。
  const responseElapsed = params.firstRespondedAt
    ? Math.max(
        0,
        Math.floor((params.firstRespondedAt.getTime() - params.createdAt.getTime()) / 1000),
      )
    : elapsed;

  return {
    elapsedSeconds: elapsed,
    responseTargetSeconds,
    resolutionTargetSeconds,
    responseBreached: responseElapsed > responseTargetSeconds,
    resolutionBreached: elapsed > resolutionTargetSeconds,
    remainingSeconds: resolutionTargetSeconds - elapsed,
  };
}

/** 優先度別の既定値(migration 0008 と一致させること) */
export const DEFAULT_SLA_TARGETS: Record<Priority, SlaTarget> = {
  critical: { responseTargetMinutes: 30, resolutionTargetMinutes: 240 },
  high: { responseTargetMinutes: 120, resolutionTargetMinutes: 1440 },
  medium: { responseTargetMinutes: 480, resolutionTargetMinutes: 4320 },
  low: { responseTargetMinutes: 1440, resolutionTargetMinutes: 10080 },
};
