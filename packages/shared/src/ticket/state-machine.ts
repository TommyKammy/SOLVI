/**
 * チケットの状態機械。
 *
 * 正本: docs/planning/03_Requirements/03.3_Ticket_Requirements.md §状態機械
 *
 * 状態遷移を文字列比較の分岐で書かない(FR-TKT-002)。分岐で書くと、
 * 「どこかに書き漏らした遷移」が実装を読まないと分からなくなる。
 * ここに表として置き、テストが同じ表を参照することで、
 * 表・実装・テストが乖離しない構造にする。
 */

export const TICKET_STATES = [
  'new',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
  'cancelled',
  'merged',
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/** 終端状態。ここからの遷移は一切許可しない(再開は新規チケット)。 */
export const TERMINAL_STATES: readonly TicketState[] = ['closed', 'cancelled', 'merged'] as const;

/**
 * 遷移の理由。誰が何のために動かしたのかを監査へ残す。
 * `reopen` と `merge` は追加の条件検査を伴うため、他と区別する。
 */
export const TRANSITION_REASONS = [
  'assign',
  'start',
  'wait_requester',
  'wait_external',
  'resume',
  'resolve',
  'close',
  'auto_close',
  'cancel',
  'reopen',
  'merge',
] as const;

export type TransitionReason = (typeof TRANSITION_REASONS)[number];

export interface TransitionRule {
  from: TicketState;
  to: TicketState;
  reason: TransitionReason;
  /** SLAクロックを止めるか(FR-TKT-008)。pending で停止し in_progress で再開する。 */
  slaClock: 'run' | 'pause' | 'stop';
}

/**
 * 許可される遷移の全体。**ここにない遷移はすべて拒否される。**
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'new', to: 'assigned', reason: 'assign', slaClock: 'run' },
  { from: 'new', to: 'cancelled', reason: 'cancel', slaClock: 'stop' },
  { from: 'new', to: 'merged', reason: 'merge', slaClock: 'stop' },

  { from: 'assigned', to: 'in_progress', reason: 'start', slaClock: 'run' },
  { from: 'assigned', to: 'assigned', reason: 'assign', slaClock: 'run' },
  { from: 'assigned', to: 'cancelled', reason: 'cancel', slaClock: 'stop' },
  { from: 'assigned', to: 'merged', reason: 'merge', slaClock: 'stop' },

  { from: 'in_progress', to: 'pending', reason: 'wait_requester', slaClock: 'pause' },
  { from: 'in_progress', to: 'pending', reason: 'wait_external', slaClock: 'pause' },
  { from: 'in_progress', to: 'resolved', reason: 'resolve', slaClock: 'stop' },
  { from: 'in_progress', to: 'assigned', reason: 'assign', slaClock: 'run' },
  { from: 'in_progress', to: 'cancelled', reason: 'cancel', slaClock: 'stop' },
  { from: 'in_progress', to: 'merged', reason: 'merge', slaClock: 'stop' },

  { from: 'pending', to: 'in_progress', reason: 'resume', slaClock: 'run' },
  { from: 'pending', to: 'resolved', reason: 'resolve', slaClock: 'stop' },
  { from: 'pending', to: 'cancelled', reason: 'cancel', slaClock: 'stop' },
  { from: 'pending', to: 'merged', reason: 'merge', slaClock: 'stop' },

  // Reopen は期限内のみ(FR-TKT-012)。期限判定は canTransition が行う。
  { from: 'resolved', to: 'in_progress', reason: 'reopen', slaClock: 'run' },
  { from: 'resolved', to: 'closed', reason: 'close', slaClock: 'stop' },
  { from: 'resolved', to: 'closed', reason: 'auto_close', slaClock: 'stop' },
] as const;

/** Resolved から Reopen できる期間(FR-TKT-012)。これを過ぎたら新規起票。 */
export const REOPEN_WINDOW_DAYS = 14;

export type TransitionDenialCode =
  'terminal_state' | 'undefined_transition' | 'reopen_window_expired' | 'missing_resolved_at';

export interface TransitionDecision {
  allowed: boolean;
  rule?: TransitionRule;
  denialCode?: TransitionDenialCode;
  message?: string;
}

export interface TransitionContext {
  /** resolved へ遷移した時刻。reopen の期限判定に使う。 */
  resolvedAt?: Date | null;
  now?: Date;
}

export function isTerminal(state: TicketState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/**
 * 遷移の可否を判定する。
 *
 * 判定できない場合は拒否する(fail closed)。
 * 例: reopen なのに resolvedAt が渡されていない → 期限を確認できないので拒否。
 */
export function canTransition(
  from: TicketState,
  to: TicketState,
  reason: TransitionReason,
  context: TransitionContext = {},
): TransitionDecision {
  if (isTerminal(from)) {
    return {
      allowed: false,
      denialCode: 'terminal_state',
      message: `${from} は終端状態です。再開する場合は新しいチケットを作成してください。`,
    };
  }

  const rule = TRANSITIONS.find((r) => r.from === from && r.to === to && r.reason === reason);
  if (!rule) {
    return {
      allowed: false,
      denialCode: 'undefined_transition',
      message: `${from} から ${to}(理由: ${reason})への遷移は定義されていません。`,
    };
  }

  if (reason === 'reopen') {
    if (!context.resolvedAt) {
      return {
        allowed: false,
        denialCode: 'missing_resolved_at',
        message: '解決時刻が不明なため再開の可否を判定できません。',
      };
    }
    const elapsed = daysBetween(context.resolvedAt, context.now ?? new Date());
    if (elapsed > REOPEN_WINDOW_DAYS) {
      return {
        allowed: false,
        denialCode: 'reopen_window_expired',
        message: `解決から${REOPEN_WINDOW_DAYS}日を過ぎているため再開できません。新しいチケットを作成してください。`,
      };
    }
  }

  return { allowed: true, rule };
}

/** 指定状態から遷移可能な (to, reason) の一覧。UIの操作候補に使う。 */
export function allowedTransitionsFrom(state: TicketState): readonly TransitionRule[] {
  return isTerminal(state) ? [] : TRANSITIONS.filter((r) => r.from === state);
}
