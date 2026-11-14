/**
 * WP-P4-APR-019 段階A/B: 承認の通知の定数・表示規則(TL-02 / TL-16)。
 *
 * DBを要しない部分だけをここで固定する。重複防止・期限切れ・承認者不在の
 * 振る舞いは `tests/security/approval-notice.test.ts` が使い捨てDBで検査する。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_NOTICE_LEAD_HOURS, APPROVAL_NOTICE_SWEEP_INTERVAL_MS } from '@solvi/shared';
import { OUTBOX_EVENT_TYPES } from '../../services/api/src/common/outbox/outbox.js';
import {
  APPROVAL_NOTICE_EVENT_TYPES,
  APPROVAL_NOTICE_KINDS,
  isApprovalNoticeEventType,
} from '../../services/api/src/modules/catalog/approval-notice.js';
import { stepStateForDisplay } from '../../services/api/src/modules/catalog/approval-state.js';
import { displayStepState } from '../../apps/web/src/lib/approval-route.js';
import { NOTIFICATION_EVENTS } from '../../apps/web/src/lib/notification-list.js';

const ROOT = join(__dirname, '../..');
const NOW = new Date('2026-11-15T00:00:00Z');

describe('期限前の通知の時点 (WP §6.1)', () => {
  it('**期限の24時間前**である。値を画面・API・定期処理で別々に持たない', () => {
    expect(APPROVAL_NOTICE_LEAD_HOURS).toBe(24);
  });

  it('**定期処理の間隔は10分**である(WP §6.3)', () => {
    expect(APPROVAL_NOTICE_SWEEP_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});

describe('通知の一覧の表示名 (WP §6.1)', () => {
  it('**内部のイベント型を画面に出さない**。4種類とも日本語の表示名を持つ', () => {
    for (const type of APPROVAL_NOTICE_EVENT_TYPES) {
      expect(NOTIFICATION_EVENTS).toHaveProperty(type);
      expect(NOTIFICATION_EVENTS[type as keyof typeof NOTIFICATION_EVENTS]).not.toBe(type);
      expect(NOTIFICATION_EVENTS[type as keyof typeof NOTIFICATION_EVENTS]).toMatch(
        /[ぁ-んァ-ヶ一-龠]/,
      );
    }
  });
});

describe('通知の種類と Outbox のイベント型', () => {
  it('4種類だけを持つ(依頼・期限前・期限切れ・承認者不在)', () => {
    expect([...APPROVAL_NOTICE_KINDS]).toEqual([
      'requested',
      'expiring',
      'expired',
      'approver_unavailable',
    ]);
  });

  it('イベント型はすべて `OUTBOX_EVENT_TYPES` に登録されている(自由文字列を使わない)', () => {
    for (const type of APPROVAL_NOTICE_EVENT_TYPES) {
      expect(OUTBOX_EVENT_TYPES).toContain(type);
      expect(isApprovalNoticeEventType(type)).toBe(true);
    }
    expect(isApprovalNoticeEventType('approval.requested')).toBe(false);
  });

  it('**Migration 0041 の CHECK と種類が一致する**(片方だけ増やさない)', () => {
    const sql = readFileSync(
      join(ROOT, 'db/migrations/0041_local_request_approval_notice.sql'),
      'utf8',
    );
    for (const kind of APPROVAL_NOTICE_KINDS) expect(sql).toContain(`'${kind}'`);
  });

  it('**main.ts が4種類すべてを通知の処理へ登録している**(積んだまま処理されない経路を作らない)', () => {
    const source = readFileSync(join(ROOT, 'services/api/src/main.ts'), 'utf8');
    for (const type of APPROVAL_NOTICE_EVENT_TYPES) expect(source).toContain(`'${type}'`);
  });
});

describe('状態 expired の表示規則 (WP §6.4)', () => {
  const PAST = new Date('2026-11-14T23:59:59Z');
  const FUTURE = new Date('2026-11-15T00:00:01Z');

  it('**期限を過ぎた pending は expired として返す**(行が pending のままでも)', () => {
    expect(stepStateForDisplay({ state: 'pending', expiresAt: PAST, now: NOW })).toBe('expired');
  });

  it('期限内の pending は pending のまま', () => {
    expect(stepStateForDisplay({ state: 'pending', expiresAt: FUTURE, now: NOW })).toBe('pending');
  });

  it('期限がちょうど現在時刻なら期限切れの側に倒す(fail closed)', () => {
    expect(stepStateForDisplay({ state: 'pending', expiresAt: NOW, now: NOW })).toBe('expired');
  });

  it('**期限が読めない・欠けている pending は expired**(期限切れの側に倒す)', () => {
    expect(stepStateForDisplay({ state: 'pending', expiresAt: null, now: NOW })).toBe('expired');
    expect(stepStateForDisplay({ state: 'pending', expiresAt: '2026-11-15', now: NOW })).toBe(
      'expired',
    );
    expect(stepStateForDisplay({ state: 'pending', expiresAt: undefined, now: NOW })).toBe(
      'expired',
    );
  });

  it('pending 以外の状態は変えない(承認済み・取消・無効を期限で塗り替えない)', () => {
    for (const state of ['approved', 'rejected', 'invalidated', 'cancelled', 'expired']) {
      expect(stepStateForDisplay({ state, expiresAt: PAST, now: NOW })).toBe(state);
    }
  });

  it('**画面の表示規則がAPIと一致する**(pending のまま期限を過ぎた場合も expired)', () => {
    const cases: Array<{ state: string; at: Date; expiresAt: string }> = [
      { state: 'pending', at: PAST, expiresAt: PAST.toISOString() },
      { state: 'pending', at: FUTURE, expiresAt: FUTURE.toISOString() },
      { state: 'pending', at: NOW, expiresAt: NOW.toISOString() },
      { state: 'approved', at: PAST, expiresAt: PAST.toISOString() },
      { state: 'rejected', at: PAST, expiresAt: PAST.toISOString() },
      { state: 'invalidated', at: PAST, expiresAt: PAST.toISOString() },
      { state: 'cancelled', at: PAST, expiresAt: PAST.toISOString() },
      { state: 'expired', at: FUTURE, expiresAt: FUTURE.toISOString() },
    ];
    for (const item of cases)
      expect(
        displayStepState(item.state, item.expiresAt, NOW.getTime()),
        `${item.state} / ${item.expiresAt}`,
      ).toBe(stepStateForDisplay({ state: item.state, expiresAt: item.at, now: NOW }));

    // 期限が読めない pending は、どちらも期限切れの側に倒す(fail closed)。
    expect(displayStepState('pending', null, NOW.getTime())).toBe('expired');
    expect(displayStepState('pending', '2026-11-15', NOW.getTime())).toBe('expired');
    expect(displayStepState('pending', undefined, NOW.getTime())).toBe('expired');
    expect(stepStateForDisplay({ state: 'pending', expiresAt: null, now: NOW })).toBe('expired');
    expect(displayStepState(null, PAST.toISOString(), NOW.getTime())).toBeNull();
  });
});
