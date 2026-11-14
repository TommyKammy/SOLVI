/**
 * WP-P4-APR-018 段階A: 経路世代の導出と再割当の部分解決(純粋関数)。
 *
 * 合成データだけを使う。DBを読まない。実PostgreSQLでの検証は
 * tests/security/approval-reassign.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_TYPES } from '../../services/api/src/common/audit/audit.js';
import {
  deriveRouteState,
  effectiveGenerationForStep,
  type RouteGenerationRow,
} from '../../services/api/src/modules/catalog/approval-route-state.js';
import {
  resolveRuleRemainder,
  type ResolverSnapshot,
  type RuleForResolution,
  type UserFacts,
} from '../../services/api/src/modules/catalog/approval-resolver.js';
import {
  routeHash,
  type ApprovalRoute,
  type ApprovalRouteStep,
} from '../../services/api/src/modules/catalog/approval-state.js';

const requester = '11111111-1111-4111-8111-111111111111';
const approverA = '22222222-2222-4222-8222-222222222222';
const approverB = '33333333-3333-4333-8333-333333333333';
const approverC = '44444444-4444-4444-8444-444444444444';
const approverD = '88888888-8888-4888-8888-888888888888';
const managerUser = '55555555-5555-4555-8555-555555555555';
const creator = '66666666-6666-4666-8666-666666666666';
const ruleId = '77777777-7777-4777-8777-777777777777';

const step = (
  stepNo: number,
  approverId: string,
  authorityType: ApprovalRouteStep['authorityType'] = 'fixed',
): ApprovalRouteStep => ({ stepNo, approverId, authorityType, resolvedFrom: 'fixed' });

const route = (steps: ApprovalRouteStep[]): ApprovalRoute => ({
  steps,
  ruleRef: { ruleId, revision: 1 },
});

const generationRow = (
  routeGeneration: number,
  fromStepNo: number,
  value: ApprovalRoute,
  overrides: Partial<RouteGenerationRow> = {},
): RouteGenerationRow => ({
  route_generation: routeGeneration,
  from_step_no: fromStepNo,
  route: value,
  route_hash: routeHash(value),
  reason: '合成: 再割当',
  created_by: creator,
  created_at: new Date('2026-11-14T00:00:00Z'),
  ...overrides,
});

describe('現在の経路の導出 (ADR-0024 §1・§2)', () => {
  const base = route([step(1, approverA), step(2, approverB), step(3, approverC)]);

  it('世代の行が無い版は、版の列を現在の経路として全段の世代1を返す', () => {
    const result = deriveRouteState({
      revision: 1,
      base: { route: base, route_hash: routeHash(base), route_generation: 1 },
      generations: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.currentRoute).toEqual(base);
    expect(result.state.currentGeneration).toBe(1);
    expect([...result.state.effectiveByStep.entries()]).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  });

  it('段ごとに from_step_no <= k の最大の世代を使う(承認済みの段は旧世代のまま)', () => {
    const second = route([step(1, approverA), step(2, approverB), step(3, approverC)]);
    const third = route([step(1, approverA), step(2, approverB), step(3, approverD)]);
    const result = deriveRouteState({
      revision: 2,
      base: { route: base, route_hash: routeHash(base), route_generation: 1 },
      generations: [
        generationRow(2, 2, second),
        // 3段目から再割当。2段目までは直前の世代と同じ。
        generationRow(3, 3, third),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.currentRoute).toEqual(third);
    expect(result.state.currentGeneration).toBe(3);
    expect([...result.state.effectiveByStep.entries()]).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(effectiveGenerationForStep(result.state, 2)).toBe(2);
    expect(effectiveGenerationForStep(result.state, 4)).toBeNull();
  });

  it('移行前(route NULL)の版に世代の行があれば失敗する', () => {
    const result = deriveRouteState({
      revision: 1,
      base: { route: null, route_hash: null, route_generation: 1 },
      generations: [generationRow(2, 1, route([step(1, approverA)]))],
    });
    expect(result).toEqual({ ok: false, reason: 'route_generation_mismatch' });
  });

  it.each([
    [
      '世代の番号が飛ぶ',
      [generationRow(3, 2, route([step(1, approverA), step(2, approverB)]))],
      'route_generation_sequence',
    ],
    [
      'route_hash が合わない',
      [
        generationRow(2, 2, route([step(1, approverA), step(2, approverB)]), {
          route_hash: '0'.repeat(64),
        }),
      ],
      'route_hash_mismatch',
    ],
    [
      'from_step_no より前の段が直前の世代と違う',
      [generationRow(2, 3, route([step(1, approverC), step(2, approverB), step(3, approverA)]))],
      'route_generation_prefix_mismatch',
    ],
    [
      '段数が版と違う',
      [generationRow(2, 2, route([step(1, approverA), step(2, approverB)]))],
      'route_generation_step_count',
    ],
    [
      'ルール参照が版と違う',
      [
        generationRow(2, 2, {
          steps: [step(1, approverA), step(2, approverB), step(3, approverC)],
          ruleRef: { ruleId, revision: 2 },
        }),
      ],
      'route_generation_rule_mismatch',
    ],
    [
      '行の形が想定と違う',
      [{ ...generationRow(2, 2, base), from_step_no: '2' }],
      'route_generation_shape',
    ],
    [
      '作成日時が読めない',
      [{ ...generationRow(2, 2, base), created_at: null }],
      'route_generation_shape',
    ],
  ])('整合性が取れない世代は失敗する: %s', (_name, generations, reason) => {
    const result = deriveRouteState({
      revision: 1,
      base: { route: base, route_hash: routeHash(base), route_generation: 1 },
      generations,
    });
    expect(result).toEqual({ ok: false, reason });
  });

  it('版の列の route_hash が合わなければ失敗する', () => {
    expect(
      deriveRouteState({
        revision: 1,
        base: { route: base, route_hash: 'f'.repeat(64), route_generation: 1 },
        generations: [],
      }),
    ).toEqual({ ok: false, reason: 'route_hash_mismatch' });
  });
});

describe('再割当の部分解決 (ADR-0024 §3)', () => {
  const rule: RuleForResolution = {
    ruleId,
    code: 'wp018-unit',
    revision: 2,
    active: true,
    steps: [
      { type: 'fixed', approverId: approverA },
      { type: 'manager', onUnresolved: 'reject' },
      { type: 'fixed', approverId: approverC },
    ],
  };
  const user = (
    status: UserFacts['status'] = 'active',
    activeMembership = true,
    hasApproverRole = false,
  ): UserFacts => ({ status, activeMembership, hasApproverRole, isOrgAdmin: false });
  const snapshot = (
    users: Record<string, UserFacts>,
    managerUserId: string | null = managerUser,
  ): ResolverSnapshot => ({
    users: new Map(Object.entries(users)),
    profiles: new Map([[requester, { managerUserId, primaryDepartmentId: null }]]),
    departments: new Map(),
    departmentHeads: new Map(),
  });
  const prefix: ApprovalRouteStep[] = [step(1, approverA)];

  it('prefix を保持し、from_step_no 以降だけを固定したルールの版で解決する', () => {
    const result = resolveRuleRemainder({
      rule,
      requesterId: requester,
      fromStepNo: 2,
      prefix,
      snapshot: snapshot({
        [requester]: user('active', true, false),
        [managerUser]: user('active', true, false),
        [approverC]: user('active', true, true),
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.steps).toEqual([
      step(1, approverA),
      { stepNo: 2, approverId: managerUser, authorityType: 'manager', resolvedFrom: 'manager' },
      step(3, approverC),
    ]);
    // 申請時に固定した版の参照を変えない。
    expect(result.route.ruleRef).toEqual({ ruleId, revision: 2 });
    expect(result.routeHash).toBe(routeHash(result.route));
  });

  it('新しい上長が未設定なら manager_unset で失敗する', () => {
    const result = resolveRuleRemainder({
      rule,
      requesterId: requester,
      fromStepNo: 2,
      prefix,
      snapshot: snapshot(
        {
          [requester]: user(),
          [approverC]: user('active', true, true),
        },
        null,
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe('manager_unset');
  });

  it('新しい上長が申請者本人なら manager_self で失敗する', () => {
    const result = resolveRuleRemainder({
      rule,
      requesterId: requester,
      fromStepNo: 2,
      prefix,
      snapshot: snapshot(
        {
          [requester]: user(),
          [approverC]: user('active', true, true),
        },
        requester,
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe('manager_self');
  });

  it('承認済みの段の承認者と重複するなら duplicate_approver で失敗する', () => {
    const duplicateRule: RuleForResolution = {
      ...rule,
      steps: [rule.steps[0]!, { type: 'fixed', approverId: approverA }],
    };
    const result = resolveRuleRemainder({
      rule: duplicateRule,
      requesterId: requester,
      fromStepNo: 2,
      prefix,
      snapshot: snapshot({
        [requester]: user(),
        [approverA]: user('active', true, true),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe('duplicate_approver');
  });

  it('prefix の長さ・from_step_no が経路と合わなければ失敗する', () => {
    expect(
      resolveRuleRemainder({
        rule,
        requesterId: requester,
        fromStepNo: 3,
        prefix,
        snapshot: snapshot({ [requester]: user() }),
      }),
    ).toMatchObject({ ok: false, reason: { code: 'rule_invalid' } });
    expect(
      resolveRuleRemainder({
        rule,
        requesterId: requester,
        fromStepNo: 0,
        prefix: [],
        snapshot: snapshot({ [requester]: user() }),
      }),
    ).toMatchObject({ ok: false, reason: { code: 'rule_invalid' } });
  });

  it('申請者が現在有効な所属でなければ失敗する', () => {
    expect(
      resolveRuleRemainder({
        rule,
        requesterId: requester,
        fromStepNo: 2,
        prefix,
        snapshot: snapshot({ [requester]: user('deactivated', false) }),
      }),
    ).toMatchObject({ ok: false, reason: { code: 'requester_not_active_member' } });
  });
});

describe('監査イベントのカタログ (02.17)', () => {
  it('approval.reassigned が登録されている', () => {
    expect(AUDIT_EVENT_TYPES).toContain('approval.reassigned');
  });
});
