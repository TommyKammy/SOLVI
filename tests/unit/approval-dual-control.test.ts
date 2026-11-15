import { describe, expect, it } from 'vitest';
import {
  checkHighRiskApprovals,
  checkHighRiskRoute,
  evaluateHighRiskDefinition,
  readHighRiskAttribute,
} from '../../services/api/src/modules/catalog/approval-high-risk.js';

/**
 * WP-P4-APR-021 段階A: 高リスク申請の条件の判定(純粋関数)。
 *
 * 判定は `approval-high-risk.ts` の1か所だけに置き、公開・ルール/設定の変更・申請・
 * 再割当・実行前検証がそれぞれ書き直さない。ここでは全分岐を総当りで固定する。
 */

const REQUESTER = '00000000-0000-4000-9000-000000000101';
const A = '00000000-0000-4000-9000-000000000102';
const B = '00000000-0000-4000-9000-000000000103';
const C = '00000000-0000-4000-9000-000000000104';
const D = '00000000-0000-4000-9000-000000000105';

const fixed = (approverId: string) => ({ type: 'fixed' as const, approverId });
const manager = () => ({ type: 'manager' as const, onUnresolved: 'reject' as const });

const route = (
  steps: Array<{ approverId: string; authorityType: string }>,
  ruleRef: { ruleId: string; revision: number } | null = null,
) => ({
  steps: steps.map((step, index) => ({
    stepNo: index + 1,
    approverId: step.approverId,
    authorityType: step.authorityType,
    resolvedFrom: step.authorityType,
  })),
  ruleRef,
});

describe('readHighRiskAttribute: 属性の読み方 (ADR-0024 §4)', () => {
  it('属性が無い場合は missing(高リスクではない)。旧版・過去の申請を補完しない', () => {
    expect(readHighRiskAttribute(undefined)).toBe('missing');
    expect(readHighRiskAttribute(null)).toBe('missing');
    expect(readHighRiskAttribute({})).toBe('missing');
    expect(readHighRiskAttribute({ ruleId: A })).toBe('missing');
  });

  it('真偽値のときだけ true / false', () => {
    expect(readHighRiskAttribute({ highRisk: true })).toBe('true');
    expect(readHighRiskAttribute({ highRisk: false })).toBe('false');
  });

  it('存在して真偽値でない値・オブジェクトでない値は invalid(fail closed)', () => {
    for (const value of ['true', 'false', 1, 0, null, {}, [], 'yes'])
      expect(readHighRiskAttribute({ highRisk: value })).toBe('invalid');
    for (const value of ['true', 1, [], 'x', true])
      expect(readHighRiskAttribute(value)).toBe('invalid');
  });
});

describe('evaluateHighRiskDefinition: 定義とルールの段 (公開・ルール/設定の変更)', () => {
  const evaluate = (input: {
    approval: unknown;
    ruleRoutingEnabled?: unknown;
    rule?: { active: unknown; steps: unknown } | null;
  }) =>
    evaluateHighRiskDefinition({
      approval: input.approval,
      ruleRoutingEnabled: 'ruleRoutingEnabled' in input ? input.ruleRoutingEnabled : true,
      rule: input.rule === undefined ? { active: true, steps: [fixed(A), fixed(B)] } : input.rule,
    });

  it('属性が無い・偽なら、ルールが無くても高リスクではない(判定しない)', () => {
    expect(evaluate({ approval: {}, rule: null, ruleRoutingEnabled: false })).toEqual({
      highRisk: false,
    });
    expect(evaluate({ approval: { highRisk: false }, rule: null })).toEqual({ highRisk: false });
  });

  it('属性が真偽値でない場合は attribute_invalid', () => {
    expect(evaluate({ approval: { highRisk: 'true', ruleId: A } })).toEqual({
      highRisk: true,
      ok: false,
      code: 'attribute_invalid',
    });
  });

  it('ルールの指定が無い定義は rule_missing(固定承認者・申請者選択も含む)', () => {
    expect(evaluate({ approval: { highRisk: true, approverId: A } })).toEqual({
      highRisk: true,
      ok: false,
      code: 'rule_missing',
    });
    expect(evaluate({ approval: { highRisk: true } })).toEqual({
      highRisk: true,
      ok: false,
      code: 'rule_missing',
    });
  });

  it('組織でルールの使用が無効なら rule_routing_disabled(未設定・偽も含む)', () => {
    expect(
      evaluate({ approval: { highRisk: true, ruleId: A }, ruleRoutingEnabled: false }),
    ).toEqual({ highRisk: true, ok: false, code: 'rule_routing_disabled' });
    expect(evaluate({ approval: { highRisk: true, ruleId: A }, ruleRoutingEnabled: undefined })).toEqual(
      { highRisk: true, ok: false, code: 'rule_routing_disabled' },
    );
  });

  it('ルールが無い・無効・内容不正なら rule_unavailable', () => {
    expect(evaluate({ approval: { highRisk: true, ruleId: A }, rule: null })).toEqual({
      highRisk: true,
      ok: false,
      code: 'rule_unavailable',
    });
    expect(
      evaluate({
        approval: { highRisk: true, ruleId: A },
        rule: { active: false, steps: [fixed(A), fixed(B)] },
      }),
    ).toEqual({ highRisk: true, ok: false, code: 'rule_unavailable' });
    for (const steps of [null, [], {}, [fixed(A), fixed(B), fixed(C), fixed(C)]])
      expect(
        evaluate({ approval: { highRisk: true, ruleId: A }, rule: { active: true, steps } }),
      ).toEqual({ highRisk: true, ok: false, code: 'rule_unavailable' });
  });

  it('fixed が1段だけ・0段(関係ベースだけ)なら fixed_approvers_insufficient', () => {
    for (const steps of [[manager()], [fixed(A)], [manager(), manager()], [manager(), fixed(A)]])
      expect(
        evaluate({ approval: { highRisk: true, ruleId: A }, rule: { active: true, steps } }),
      ).toEqual({ highRisk: true, ok: false, code: 'fixed_approvers_insufficient' });
    // 1段だけのルールは、内容としては正しいが fixed が2段未満である。
    expect(
      evaluate({ approval: { highRisk: true, ruleId: A }, rule: { active: true, steps: [fixed(A)] } }),
    ).toEqual({ highRisk: true, ok: false, code: 'fixed_approvers_insufficient' });
  });

  it('fixed の2段が同じ承認者なら fixed_approvers_duplicate', () => {
    expect(
      evaluate({
        approval: { highRisk: true, ruleId: A },
        rule: { active: true, steps: [fixed(A), fixed(A)] },
      }),
    ).toEqual({ highRisk: true, ok: false, code: 'fixed_approvers_duplicate' });
    expect(
      evaluate({
        approval: { highRisk: true, ruleId: A },
        rule: { active: true, steps: [fixed(A), manager(), fixed(A)] },
      }),
    ).toEqual({ highRisk: true, ok: false, code: 'fixed_approvers_duplicate' });
  });

  it('fixed が別人で2段以上あれば条件を満たす(関係ベースの段は数に入らない)', () => {
    expect(
      evaluate({
        approval: { highRisk: true, ruleId: A },
        rule: { active: true, steps: [fixed(A), fixed(B)] },
      }),
    ).toEqual({ highRisk: true, ok: true, fixedApproverIds: [A, B] });
    expect(
      evaluate({
        approval: { highRisk: true, ruleId: A },
        rule: { active: true, steps: [fixed(A), manager(), fixed(B)] },
      }),
    ).toEqual({ highRisk: true, ok: true, fixedApproverIds: [A, B] });
  });
});

describe('checkHighRiskRoute: 解決した経路 (申請・申請内容の変更・再割当)', () => {
  it('経路が無い・読めない場合は拒否する', () => {
    expect(checkHighRiskRoute({ route: null, requesterId: REQUESTER })).toEqual({
      ok: false,
      code: 'route_missing',
    });
    expect(checkHighRiskRoute({ route: undefined, requesterId: REQUESTER })).toEqual({
      ok: false,
      code: 'route_missing',
    });
    for (const value of [
      'route',
      {},
      { steps: [] },
      { steps: [null] },
      { steps: [{ stepNo: 2, approverId: A, authorityType: 'fixed' }] },
      { steps: [{ stepNo: 1, approverId: 'x', authorityType: 'fixed' }] },
      { steps: [{ stepNo: 1, approverId: A, authorityType: 'unknown' }] },
      {
        steps: [
          { stepNo: 1, approverId: A, authorityType: 'fixed' },
          { stepNo: 2, approverId: B, authorityType: 'fixed' },
          { stepNo: 3, approverId: C, authorityType: 'fixed' },
          { stepNo: 4, approverId: A, authorityType: 'fixed' },
        ],
      },
    ])
      expect(checkHighRiskRoute({ route: value, requesterId: REQUESTER })).toEqual({
        ok: false,
        code: 'route_invalid',
      });
    expect(
      checkHighRiskRoute({ route: route([{ approverId: A, authorityType: 'fixed' }]), requesterId: null }),
    ).toEqual({ ok: false, code: 'route_invalid' });
  });

  it('fixed が2段未満(関係ベースだけ・fixed 1段)は fixed_approvers_insufficient', () => {
    for (const steps of [
      [{ approverId: A, authorityType: 'manager' }],
      [{ approverId: A, authorityType: 'department_head' }],
      [{ approverId: A, authorityType: 'fixed' }],
      [
        { approverId: A, authorityType: 'fixed' },
        { approverId: B, authorityType: 'manager' },
      ],
      [
        { approverId: A, authorityType: 'manager' },
        { approverId: B, authorityType: 'department_head' },
      ],
    ])
      expect(checkHighRiskRoute({ route: route(steps), requesterId: REQUESTER })).toEqual({
        ok: false,
        code: 'fixed_approvers_insufficient',
      });
  });

  it('fixed の2段が同じ承認者なら fixed_approvers_duplicate', () => {
    expect(
      checkHighRiskRoute({
        route: route([
          { approverId: A, authorityType: 'fixed' },
          { approverId: A, authorityType: 'fixed' },
        ]),
        requesterId: REQUESTER,
      }),
    ).toEqual({ ok: false, code: 'fixed_approvers_duplicate' });
  });

  it('固定承認者に申請者が含まれる場合は requester_is_approver', () => {
    expect(
      checkHighRiskRoute({
        route: route([
          { approverId: REQUESTER, authorityType: 'fixed' },
          { approverId: B, authorityType: 'fixed' },
        ]),
        requesterId: REQUESTER,
      }),
    ).toEqual({ ok: false, code: 'requester_is_approver' });
  });

  it('fixed が別人で2段以上あり、申請者が含まれなければ通す', () => {
    expect(
      checkHighRiskRoute({
        route: route([
          { approverId: A, authorityType: 'fixed' },
          { approverId: B, authorityType: 'fixed' },
        ]),
        requesterId: REQUESTER,
      }),
    ).toEqual({ ok: true });
    expect(
      checkHighRiskRoute({
        route: route([
          { approverId: A, authorityType: 'fixed' },
          { approverId: B, authorityType: 'manager' },
          { approverId: C, authorityType: 'fixed' },
        ]),
        requesterId: REQUESTER,
      }),
    ).toEqual({ ok: true });
  });
});

describe('checkHighRiskApprovals: 承認済みのステップ (実行前検証)', () => {
  const highRiskRoute = route([
    { approverId: A, authorityType: 'fixed' },
    { approverId: B, authorityType: 'fixed' },
  ]);
  const approved = (approverId: string, decidedBy: string | null = null) => ({
    approverId,
    state: 'approved',
    decidedBy,
  });
  const check = (steps: unknown, value: unknown = highRiskRoute) =>
    checkHighRiskApprovals({ route: value, requesterId: REQUESTER, steps });

  it('経路・手順・決定者が読めない場合は unreadable(fail closed)', () => {
    expect(check([{ stepNo: 1, ...approved(A) }, { stepNo: 2, ...approved(B) }], null)).toEqual({
      ok: false,
      code: 'unreadable',
    });
    for (const steps of [
      null,
      {},
      'steps',
      [{ stepNo: 1, approverId: A, state: 'approved', decidedBy: 'x' }],
      [{ stepNo: 0, approverId: A, state: 'approved', decidedBy: null }],
      [{ stepNo: 1, approverId: 'x', state: 'approved', decidedBy: null }],
      [{ stepNo: 1, approverId: A, state: 1, decidedBy: null }],
      [
        { stepNo: 1, approverId: A, state: 'approved', decidedBy: null },
        { stepNo: 1, approverId: B, state: 'approved', decidedBy: null },
      ],
    ])
      expect(check(steps)).toEqual({ ok: false, code: 'unreadable' });
  });

  it('fixed の承認が2段未満・決定者が1人だけなら insufficient_approvers', () => {
    expect(
      check([
        { stepNo: 1, ...approved(A) },
        { stepNo: 2, approverId: B, state: 'pending', decidedBy: null },
      ]),
    ).toEqual({ ok: false, code: 'insufficient_approvers' });
    expect(check([{ stepNo: 1, ...approved(A) }])).toEqual({
      ok: false,
      code: 'insufficient_approvers',
    });
    // 経路の2段が同じ承認者(重複)の場合、決定者も1人になる。
    expect(
      check(
        [
          { stepNo: 1, ...approved(A) },
          { stepNo: 2, ...approved(A) },
        ],
        route([
          { approverId: A, authorityType: 'fixed' },
          { approverId: A, authorityType: 'fixed' },
        ]),
      ),
    ).toEqual({ ok: false, code: 'insufficient_approvers' });
  });

  it('代理による決定(decided_by が approver_id と異なる)が混ざれば delegated_decision', () => {
    expect(
      check([
        { stepNo: 1, ...approved(A) },
        { stepNo: 2, ...approved(B, C) },
      ]),
    ).toEqual({ ok: false, code: 'delegated_decision' });
    // 関係ベースの段の代理による決定も拒否する(ADR-0026 §1)。
    expect(
      check(
        [
          { stepNo: 1, ...approved(C, D) },
          { stepNo: 2, ...approved(A) },
          { stepNo: 3, ...approved(B) },
        ],
        route([
          { approverId: C, authorityType: 'manager' },
          { approverId: A, authorityType: 'fixed' },
          { approverId: B, authorityType: 'fixed' },
        ]),
      ),
    ).toEqual({ ok: false, code: 'delegated_decision' });
  });

  it('経路の承認者と承認行の承認者が食い違う記録は unreadable', () => {
    expect(
      check([
        { stepNo: 1, ...approved(A, A) },
        { stepNo: 2, ...approved(C, C) },
      ]),
    ).toEqual({ ok: false, code: 'unreadable' });
  });

  it('別人2名が本人として承認していれば通す', () => {
    expect(
      check([
        { stepNo: 1, decidedBy: null, ...approved(A) },
        { stepNo: 2, ...approved(B, B) },
      ]),
    ).toEqual({ ok: true });
    expect(
      check(
        [
          { stepNo: 1, ...approved(A) },
          { stepNo: 2, ...approved(B) },
          { stepNo: 3, approverId: C, state: 'approved', decidedBy: null },
        ],
        route([
          { approverId: A, authorityType: 'fixed' },
          { approverId: B, authorityType: 'manager' },
          { approverId: C, authorityType: 'fixed' },
        ]),
      ),
    ).toEqual({ ok: true });
  });
});
