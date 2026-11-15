/**
 * WP-P4-APR-020 段階A: 代理承認の純粋な部分(TL-02 / TL-16)。
 *
 * 入力スキーマ・期間の検証・状態の導出・通知の種別・SQL述語の材料を固定する。
 * 実PostgreSQLでの振る舞いは `tests/security/approval-delegation.test.ts` が検査する。
 * 合成データだけを使い、DBを読まない。
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DELEGATION_MAX_PERIOD_DAYS,
  APPROVAL_DELEGATION_START_TOLERANCE_MINUTES,
  approvalDelegationCreateSchema,
  approvalDelegationRevokeSchema,
} from '@solvi/shared/catalog';
import { AUDIT_EVENT_TYPES } from '../../services/api/src/common/audit/audit.js';
import { OUTBOX_EVENT_TYPES } from '../../services/api/src/common/outbox/outbox.js';
import {
  checkDelegationPeriod,
  DELEGATION_MAX_PERIOD_MS,
  DELEGATION_STATES,
  delegationStateFor,
  delegationValiditySql,
  effectiveDelegationSql,
  delegationEligibilitySql,
} from '../../services/api/src/modules/catalog/approval-delegation.js';
import {
  DELEGATION_NOTICE_EVENT_TYPES,
  DELEGATION_NOTICE_KINDS,
  isApprovalNoticeEventType,
  isDelegationNoticeEventType,
} from '../../services/api/src/modules/catalog/approval-notice.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-15T00:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('委任の入力 (WP §6.2)', () => {
  it('**委任者のIDを受け取らない**。未知のキーは拒否する', () => {
    const base = {
      delegateId: USER,
      startsAt: '2026-11-15T00:00:00+09:00',
      endsAt: '2026-11-16T00:00:00+09:00',
    };
    expect(approvalDelegationCreateSchema.safeParse(base).success).toBe(true);
    for (const extra of [
      { delegatorId: USER },
      { organizationId: ORG },
      { state: 'active' },
      { createdBy: USER },
    ]) {
      const parsed = approvalDelegationCreateSchema.safeParse({ ...base, ...extra });
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('代理者・開始・終了は必須で、日時はタイムゾーン付きの ISO 8601 だけを受け付ける', () => {
    expect(
      approvalDelegationCreateSchema.safeParse({
        delegateId: 'not-a-uuid',
        startsAt: '2026-11-15T00:00:00Z',
        endsAt: '2026-11-16T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      approvalDelegationCreateSchema.safeParse({
        delegateId: USER,
        startsAt: '2026-11-15',
        endsAt: '2026-11-16T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      approvalDelegationCreateSchema.safeParse({
        delegateId: USER,
        startsAt: '2026-11-15T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('取消は理由が必須で、2000文字を超える理由と未知のキーを拒否する', () => {
    expect(approvalDelegationRevokeSchema.safeParse({ reason: '合成: 取消' }).success).toBe(true);
    expect(approvalDelegationRevokeSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(approvalDelegationRevokeSchema.safeParse({ reason: 'あ'.repeat(2001) }).success).toBe(
      false,
    );
    expect(
      approvalDelegationRevokeSchema.safeParse({ reason: '合成', revokedBy: USER }).success,
    ).toBe(false);
  });

  it('期間の上限は30日、開始の猶予は5分である(値を画面・API・DBで別々に持たない)', () => {
    expect(APPROVAL_DELEGATION_MAX_PERIOD_DAYS).toBe(30);
    expect(APPROVAL_DELEGATION_START_TOLERANCE_MINUTES).toBe(5);
    expect(DELEGATION_MAX_PERIOD_MS).toBe(30 * DAY);
  });
});

describe('期間の検証 (ADR-0025 §3)', () => {
  const base = { now: NOW, startToleranceMs: 5 * MINUTE };
  it('終了が開始以前・過去に終わる・30日超・開始が5分より前を拒否する', () => {
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() + MINUTE),
        endsAt: new Date(NOW.getTime()),
      }),
    ).toBe('ends_not_after_start');
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() - DAY),
        endsAt: new Date(NOW.getTime() - MINUTE),
      }),
    ).toBe('ends_not_future');
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() - MINUTE),
        endsAt: new Date(NOW.getTime() + 30 * DAY + MINUTE),
      }),
    ).toBe('period_too_long');
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() - 6 * MINUTE),
        endsAt: new Date(NOW.getTime() + MINUTE),
      }),
    ).toBe('starts_too_early');
  });

  it('境界: 30日ちょうど・開始が5分前ちょうど・終了が現在ちょうどは通る/通らないが一意に決まる', () => {
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() - 5 * MINUTE),
        endsAt: new Date(NOW.getTime() + 30 * DAY - 5 * MINUTE),
      }),
    ).toBeNull();
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() - MINUTE),
        endsAt: new Date(NOW.getTime() - MINUTE + 30 * DAY),
      }),
    ).toBeNull();
    // 終了が現在と同じなら「過去に終わる」扱い(期間は未来を含まない)。
    expect(
      checkDelegationPeriod({
        ...base,
        startsAt: new Date(NOW.getTime() - MINUTE),
        endsAt: new Date(NOW.getTime()),
      }),
    ).toBe('ends_not_future');
  });
});

describe('状態の導出 (WP §6.2)', () => {
  const period = {
    startsAt: new Date(NOW.getTime() - MINUTE),
    endsAt: new Date(NOW.getTime() + MINUTE),
    revokedAt: null,
    delegateEligible: true,
    now: NOW,
  };
  it('予定・有効・終了・取消済み・代理者が資格なしを返す', () => {
    expect(DELEGATION_STATES).toEqual([
      'scheduled',
      'active',
      'ended',
      'revoked',
      'delegate_ineligible',
      'unknown',
    ]);
    expect(delegationStateFor(period)).toBe('active');
    expect(delegationStateFor({ ...period, startsAt: new Date(NOW.getTime() + MINUTE) })).toBe(
      'scheduled',
    );
    expect(delegationStateFor({ ...period, endsAt: new Date(NOW.getTime()) })).toBe('ended');
    expect(delegationStateFor({ ...period, revokedAt: NOW })).toBe('revoked');
    expect(delegationStateFor({ ...period, delegateEligible: false })).toBe('delegate_ineligible');
  });

  it('**取消を最優先**し、値が読めない場合は使用不可(unknown)にする', () => {
    expect(
      delegationStateFor({
        ...period,
        revokedAt: NOW,
        endsAt: new Date(NOW.getTime() - MINUTE),
        delegateEligible: false,
      }),
    ).toBe('revoked');
    expect(delegationStateFor({ ...period, startsAt: null })).toBe('unknown');
    expect(delegationStateFor({ ...period, endsAt: '2026-11-16' })).toBe('unknown');
    expect(delegationStateFor({ ...period, revokedAt: '2026-11-15' })).toBe('unknown');
    expect(delegationStateFor({ ...period, startsAt: new Date('invalid') })).toBe('unknown');
  });
});

describe('SQL述語 (判定を書き写さない)', () => {
  it('有効性の述語は、取消・期間・委任者の権限根拠・代理者の資格の4つを必ず含む', () => {
    const sql = delegationValiditySql({
      alias: 'd',
      organizationId: '$1',
      delegatorId: '$2',
      delegateId: '$3',
      at: '$4',
      authorityType: '$5',
    });
    expect(sql).toContain('d.revoked_at IS NULL');
    expect(sql).toContain('d.starts_at <= $4');
    expect(sql).toContain('d.ends_at > $4');
    // 委任者(段の権限根拠に応じて approver ロール)と代理者(常に approver ロール)の2つの所属判定。
    expect(sql.match(/FROM role_binding rb/g)?.length).toBe(2);
    // 代理者の判定は段の種別によらないため、常に approver ロールを要求する。
    expect(sql.match(/r.code='approver'/g)?.length).toBe(2);
    expect(sql).toContain("'fixed' NOT IN ('fixed','legacy')");
  });

  it('代理者の資格は、段の種別によらず approver ロールを要求する', () => {
    const sql = delegationEligibilitySql({
      organizationId: '$1',
      userId: '$2',
      at: '$3',
      userStatus: 'u.status',
    });
    expect(sql).toContain("'fixed' NOT IN ('fixed','legacy')");
    expect(sql).toContain("r.code='approver'");
  });

  it('有効な委任の述語は EXISTS で包み、委任者・代理者を引数で受け取る', () => {
    const sql = effectiveDelegationSql({
      organizationId: 'q.organization_id',
      delegatorId: 'a.approver_id',
      delegateId: '$3',
      at: '$4',
      authorityType: 'a.authority_type',
    });
    expect(sql.trim().startsWith('EXISTS (')).toBe(true);
    expect(sql).toContain('d.delegator_id=a.approver_id');
    expect(sql).toContain('d.delegate_id=$3');
  });
});

describe('通知と監査の登録 (WP §6.5・§6.6)', () => {
  it('監査イベント型 `approval.delegated` / `approval.delegation_revoked` を持つ', () => {
    expect(AUDIT_EVENT_TYPES).toContain('approval.delegated');
    expect(AUDIT_EVENT_TYPES).toContain('approval.delegation_revoked');
  });

  it('委任の通知は Outbox のイベント型として登録され、承認の通知とは別に扱う', () => {
    expect([...DELEGATION_NOTICE_KINDS]).toEqual(['created', 'revoked']);
    for (const type of DELEGATION_NOTICE_EVENT_TYPES) {
      expect(OUTBOX_EVENT_TYPES).toContain(type);
      expect(isDelegationNoticeEventType(type)).toBe(true);
      // 承認の通知の分岐(宛先が承認者)に混ざらない。
      expect(isApprovalNoticeEventType(type)).toBe(false);
    }
    expect(isDelegationNoticeEventType('approval.notice.requested')).toBe(false);
  });
});
