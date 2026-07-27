/**
 * 状態機械の網羅テスト(TL-02 / FR-TKT-002 / FR-TKT-012)。
 *
 * 遷移表の**全セル**(from × to × reason)を機械的に生成し、
 * 表にあるものは許可・ないものは拒否されることを確認する。
 * テストが遷移表を参照するため、表を書き換えればテストも自動的に追随する
 * (表とテストが乖離した状態を作らない)。
 */
import { describe, it, expect } from 'vitest';
import {
  TICKET_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  TRANSITION_REASONS,
  REOPEN_WINDOW_DAYS,
  canTransition,
  allowedTransitionsFrom,
  isTerminal,
  type TicketState,
  type TransitionReason,
} from '../../packages/shared/src/ticket/state-machine.js';
import {
  derivePriority,
  IMPACT_LEVELS,
  URGENCY_LEVELS,
  isDerivedPriority,
} from '../../packages/shared/src/ticket/priority.js';

const RESOLVED_AT = new Date('2026-07-01T00:00:00Z');
const WITHIN_WINDOW = new Date('2026-07-10T00:00:00Z'); // 9日後
const AFTER_WINDOW = new Date('2026-07-16T00:00:01Z'); // 15日と1秒後

/** reopen は期限で結果が変わるため、常に「期限内」の文脈を渡して表との一致だけを見る */
const context = { resolvedAt: RESOLVED_AT, now: WITHIN_WINDOW };

describe('遷移表の全セル網羅', () => {
  const allCells: Array<[TicketState, TicketState, TransitionReason]> = [];
  for (const from of TICKET_STATES) {
    for (const to of TICKET_STATES) {
      for (const reason of TRANSITION_REASONS) {
        allCells.push([from, to, reason]);
      }
    }
  }

  const inTable = (from: TicketState, to: TicketState, reason: TransitionReason) =>
    TRANSITIONS.some((r) => r.from === from && r.to === to && r.reason === reason);

  it('全セル数と表の件数が想定どおり', () => {
    expect(allCells.length).toBe(
      TICKET_STATES.length * TICKET_STATES.length * TRANSITION_REASONS.length,
    );
    expect(TRANSITIONS.length).toBeGreaterThan(0);
  });

  it.each(allCells)('%s → %s (%s)', (from, to, reason) => {
    const decision = canTransition(from, to, reason, context);
    expect(decision.allowed).toBe(inTable(from, to, reason));
  });

  it('許可される遷移と拒否される遷移の件数を記録する', () => {
    const allowed = allCells.filter(([f, t, r]) => canTransition(f, t, r, context).allowed);
    const denied = allCells.length - allowed.length;
    // 表に載っている遷移がすべて許可されていること
    expect(allowed.length).toBe(TRANSITIONS.length);
    expect(denied).toBe(allCells.length - TRANSITIONS.length);
    console.log(
      `  遷移表: 許可 ${allowed.length} 件 / 拒否 ${denied} 件 (全 ${allCells.length} 組合せ)`,
    );
  });
});

describe('終端状態', () => {
  it.each(TERMINAL_STATES)('%s からはどの遷移も拒否される', (terminal) => {
    for (const to of TICKET_STATES) {
      for (const reason of TRANSITION_REASONS) {
        const decision = canTransition(terminal, to, reason, context);
        expect(decision.allowed).toBe(false);
        expect(decision.denialCode).toBe('terminal_state');
      }
    }
  });

  it('allowedTransitionsFrom が終端状態で空を返す', () => {
    for (const terminal of TERMINAL_STATES) {
      expect(allowedTransitionsFrom(terminal)).toHaveLength(0);
      expect(isTerminal(terminal)).toBe(true);
    }
  });

  it('closed は終端。再開は新規チケットになる', () => {
    expect(canTransition('closed', 'in_progress', 'reopen', context).allowed).toBe(false);
  });
});

describe('Reopen の期限 (FR-TKT-012)', () => {
  it(`解決から${REOPEN_WINDOW_DAYS}日以内は再開できる`, () => {
    expect(
      canTransition('resolved', 'in_progress', 'reopen', {
        resolvedAt: RESOLVED_AT,
        now: WITHIN_WINDOW,
      }).allowed,
    ).toBe(true);
  });

  it('ちょうど14日は再開できる(境界値)', () => {
    const exactly14 = new Date(RESOLVED_AT.getTime() + REOPEN_WINDOW_DAYS * 86_400_000);
    expect(
      canTransition('resolved', 'in_progress', 'reopen', {
        resolvedAt: RESOLVED_AT,
        now: exactly14,
      }).allowed,
    ).toBe(true);
  });

  it('15日目は拒否される', () => {
    const decision = canTransition('resolved', 'in_progress', 'reopen', {
      resolvedAt: RESOLVED_AT,
      now: AFTER_WINDOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('reopen_window_expired');
  });

  it('解決時刻が不明なら拒否する(判定できないときは通さない)', () => {
    const decision = canTransition('resolved', 'in_progress', 'reopen', {
      resolvedAt: null,
      now: WITHIN_WINDOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('missing_resolved_at');
  });
});

describe('SLAクロック (FR-TKT-008 の前提)', () => {
  it('pending への遷移でクロックが止まる', () => {
    const toPending = TRANSITIONS.filter((r) => r.to === 'pending');
    expect(toPending.length).toBeGreaterThan(0);
    for (const rule of toPending) expect(rule.slaClock).toBe('pause');
  });

  it('pending から in_progress でクロックが再開する', () => {
    const resume = TRANSITIONS.find((r) => r.from === 'pending' && r.to === 'in_progress');
    expect(resume?.slaClock).toBe('run');
  });

  it('終端状態への遷移でクロックが停止する', () => {
    for (const rule of TRANSITIONS.filter((r) => isTerminal(r.to) || r.to === 'resolved')) {
      expect(rule.slaClock).toBe('stop');
    }
  });
});

describe('優先度の導出 (FR-TKT-009)', () => {
  it('全ての Impact × Urgency の組合せで値が返る', () => {
    for (const impact of IMPACT_LEVELS) {
      for (const urgency of URGENCY_LEVELS) {
        expect(derivePriority(impact, urgency)).toBeTruthy();
      }
    }
  });

  it('同一入力で常に同一結果(決定論)', () => {
    for (let i = 0; i < 100; i++) {
      expect(derivePriority('high', 'medium')).toBe('high');
    }
  });

  it('critical は影響大かつ緊急のときだけ', () => {
    const criticals: string[] = [];
    for (const impact of IMPACT_LEVELS) {
      for (const urgency of URGENCY_LEVELS) {
        if (derivePriority(impact, urgency) === 'critical') criticals.push(`${impact}/${urgency}`);
      }
    }
    expect(criticals).toEqual(['high/high']);
  });

  it('影響・緊急が上がると優先度は下がらない(単調性)', () => {
    const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
    for (const urgency of URGENCY_LEVELS) {
      expect(rank[derivePriority('high', urgency)]).toBeGreaterThanOrEqual(
        rank[derivePriority('medium', urgency)],
      );
      expect(rank[derivePriority('medium', urgency)]).toBeGreaterThanOrEqual(
        rank[derivePriority('low', urgency)],
      );
    }
  });

  it('提案された優先度が規則と一致するか判定できる(AI提案の検証用)', () => {
    expect(isDerivedPriority('high', 'high', 'critical')).toBe(true);
    expect(isDerivedPriority('low', 'low', 'critical')).toBe(false);
  });
});
