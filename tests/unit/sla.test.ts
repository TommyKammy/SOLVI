/**
 * SLAクロック(TL-01 / FR-TKT-008)。
 *
 * 時刻を引数で与えて決定的に検証する。実時刻に依存させると、
 * テストが環境の速度で揺れて信頼できなくなる。
 *
 * 重点は停止条件。「利用者からの返信待ち」を応答時間に数えると、
 * 担当者は返信を待つほど成績が悪くなる。
 */
import { describe, it, expect } from 'vitest';
import {
  applyClockAction,
  clockActionFor,
  currentElapsedSeconds,
  evaluateSla,
  DEFAULT_SLA_TARGETS,
  type SlaClockState,
} from '../../packages/shared/src/ticket/sla.js';
import { TRANSITIONS } from '../../packages/shared/src/ticket/state-machine.js';

const T0 = new Date('2026-07-01T09:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('遷移表との対応', () => {
  it('遷移表のすべての規則に対して挙動が引ける', () => {
    for (const rule of TRANSITIONS) {
      expect(clockActionFor(rule.from, rule.to, rule.reason)).toBe(rule.slaClock);
    }
  });

  it('遷移表にない組合せは null', () => {
    expect(clockActionFor('new', 'resolved', 'resolve')).toBeNull();
  });

  it('pending への遷移はすべて pause', () => {
    for (const rule of TRANSITIONS.filter((r) => r.to === 'pending')) {
      expect(clockActionFor(rule.from, rule.to, rule.reason)).toBe('pause');
    }
  });
});

describe('クロックの加算', () => {
  const running: SlaClockState = { startedAt: T0, elapsedSeconds: 0 };

  it('動作中に停止すると経過が加算される', () => {
    const paused = applyClockAction(running, 'pause', at(30));
    expect(paused.startedAt).toBeNull();
    expect(paused.elapsedSeconds).toBe(1800);
  });

  it('停止中は経過が増えない', () => {
    const paused = applyClockAction(running, 'pause', at(30));
    // 停止したまま2時間が経過しても加算されない
    expect(currentElapsedSeconds(paused, at(150))).toBe(1800);
  });

  it('再開すると以降の時間が加算される', () => {
    const paused = applyClockAction(running, 'pause', at(30)); // 30分
    const resumed = applyClockAction(paused, 'run', at(150)); // 2時間停止後に再開
    const stopped = applyClockAction(resumed, 'stop', at(180)); // さらに30分
    expect(stopped.elapsedSeconds).toBe(3600); // 30分 + 30分
  });

  it('停止・再開を繰り返しても正しく累積する', () => {
    let state: SlaClockState = { startedAt: T0, elapsedSeconds: 0 };
    // 10分作業 → 60分待ち → 20分作業 → 120分待ち → 15分作業
    state = applyClockAction(state, 'pause', at(10));
    state = applyClockAction(state, 'run', at(70));
    state = applyClockAction(state, 'pause', at(90));
    state = applyClockAction(state, 'run', at(210));
    state = applyClockAction(state, 'stop', at(225));
    expect(state.elapsedSeconds).toBe((10 + 20 + 15) * 60);
  });

  it('動作中に run を重ねても開始時刻を上書きしない(経過が失われない)', () => {
    const again = applyClockAction(running, 'run', at(30));
    expect(again.startedAt).toEqual(T0);
    expect(currentElapsedSeconds(again, at(60))).toBe(3600);
  });

  it('停止中に stop を重ねても二重加算しない', () => {
    const paused = applyClockAction(running, 'pause', at(30));
    const again = applyClockAction(paused, 'stop', at(60));
    expect(again.elapsedSeconds).toBe(1800);
  });

  it('時計が巻き戻っても経過が減らない', () => {
    // NTP調整などで now が過去になる場合。負の加算を許すと経過が縮む。
    const state = applyClockAction(running, 'pause', new Date(T0.getTime() - 60_000));
    expect(state.elapsedSeconds).toBe(0);
  });
});

describe('現在の経過時間', () => {
  it('動作中は開始からの差分を足して返す', () => {
    expect(currentElapsedSeconds({ startedAt: T0, elapsedSeconds: 600 }, at(10))).toBe(1200);
  });

  it('停止中は保持値をそのまま返す', () => {
    expect(currentElapsedSeconds({ startedAt: null, elapsedSeconds: 600 }, at(999))).toBe(600);
  });
});

describe('SLA判定 (超過しても止めない)', () => {
  const target = DEFAULT_SLA_TARGETS.high; // 応答2時間 / 解決1日

  it('目標内なら未超過', () => {
    const status = evaluateSla({
      clock: { startedAt: T0, elapsedSeconds: 0 },
      target,
      firstRespondedAt: at(60),
      createdAt: T0,
      resolvedAt: null,
      now: at(90),
    });
    expect(status.responseBreached).toBe(false);
    expect(status.resolutionBreached).toBe(false);
    expect(status.remainingSeconds).toBeGreaterThan(0);
  });

  it('初回応答が目標を超えると応答SLA違反', () => {
    const status = evaluateSla({
      clock: { startedAt: T0, elapsedSeconds: 0 },
      target,
      firstRespondedAt: at(150), // 2時間30分後
      createdAt: T0,
      resolvedAt: null,
      now: at(150),
    });
    expect(status.responseBreached).toBe(true);
  });

  it('未応答なら現在までの経過で応答SLAを判定する', () => {
    const status = evaluateSla({
      clock: { startedAt: T0, elapsedSeconds: 0 },
      target,
      firstRespondedAt: null,
      createdAt: T0,
      resolvedAt: null,
      now: at(150),
    });
    expect(status.responseBreached).toBe(true);
  });

  it('**待ち時間はSLAに算入されない**', () => {
    // 30分作業 → 5時間待ち。実時間は5時間30分だがクロックは30分。
    let clock: SlaClockState = { startedAt: T0, elapsedSeconds: 0 };
    clock = applyClockAction(clock, 'pause', at(30));

    const status = evaluateSla({
      clock,
      target,
      firstRespondedAt: null,
      createdAt: T0,
      resolvedAt: null,
      now: at(330), // 5時間30分後
    });
    expect(status.elapsedSeconds).toBe(1800);
    // 応答目標2時間に対しクロックは30分なので未超過
    expect(status.responseBreached).toBe(false);
  });

  it('解決期限を超えると解決SLA違反', () => {
    const status = evaluateSla({
      clock: { startedAt: T0, elapsedSeconds: 0 },
      target,
      firstRespondedAt: at(10),
      createdAt: T0,
      resolvedAt: null,
      now: at(1500), // 25時間
    });
    expect(status.resolutionBreached).toBe(true);
    expect(status.remainingSeconds).toBeLessThan(0);
  });

  it('優先度により目標値が変わる', () => {
    expect(DEFAULT_SLA_TARGETS.critical.responseTargetMinutes).toBeLessThan(
      DEFAULT_SLA_TARGETS.low.responseTargetMinutes,
    );
    for (const p of ['critical', 'high', 'medium', 'low'] as const) {
      const t = DEFAULT_SLA_TARGETS[p];
      expect(t.resolutionTargetMinutes).toBeGreaterThanOrEqual(t.responseTargetMinutes);
    }
  });
});
