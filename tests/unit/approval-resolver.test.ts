import { describe, expect, it } from 'vitest';
import {
  isActiveMember,
  resolveApprovalRoute,
  type DepartmentFacts,
  type ProfileFacts,
  type ResolverSnapshot,
  type RuleForResolution,
  type UserFacts,
} from '../../services/api/src/modules/catalog/approval-resolver.js';
import {
  routeHash,
  type ApprovalRoute,
} from '../../services/api/src/modules/catalog/approval-state.js';

/**
 * WP-P4-APR-015 段階A: 承認者解決の純粋ロジック。
 *
 * DB・時計・乱数を読まない `resolveApprovalRoute` に、事実のスナップショットだけを渡す。
 * 全分岐・解決不能の理由・resolvedFrom の語彙・決定性をここで固定する。
 */

const ORG = '00000000-0000-4000-9000-000000000001';
const REQUESTER = '00000000-0000-4000-9000-000000000101';
const FIXED = '00000000-0000-4000-9000-000000000102';
const MANAGER = '00000000-0000-4000-9000-000000000103';
const HEAD = '00000000-0000-4000-9000-000000000104';
const ANCESTOR_HEAD = '00000000-0000-4000-9000-000000000105';
const SELECTED = '00000000-0000-4000-9000-000000000106';
const NOW = new Date('2026-11-13T00:00:00Z');

const active = (overrides: Partial<UserFacts> = {}): UserFacts => ({
  status: 'active',
  activeMembership: true,
  hasApproverRole: true,
  isOrgAdmin: false,
  ...overrides,
});

const deactivated = (): UserFacts => active({ status: 'deactivated' });
const noMembership = (): UserFacts => active({ activeMembership: false });
const noApproverRole = (): UserFacts => active({ hasApproverRole: false });
const orgAdmin = (): UserFacts => active({ isOrgAdmin: true });

type SnapshotInput = {
  users?: Record<string, UserFacts>;
  profiles?: Record<string, ProfileFacts>;
  departments?: Record<string, DepartmentFacts>;
  heads?: Record<string, string | null>;
};

function snapshot(input: SnapshotInput = {}): ResolverSnapshot {
  return {
    users: new Map(Object.entries(input.users ?? {})),
    profiles: new Map(Object.entries(input.profiles ?? {})),
    departments: new Map(Object.entries(input.departments ?? {})),
    departmentHeads: new Map(Object.entries(input.heads ?? {})),
  };
}

function baseUsers(overrides: Record<string, UserFacts | null> = {}): Record<string, UserFacts> {
  const users: Record<string, UserFacts> = {
    [REQUESTER]: active({ hasApproverRole: false }),
    [FIXED]: active(),
    [MANAGER]: active({ hasApproverRole: false }),
    [HEAD]: active({ hasApproverRole: false }),
    [ANCESTOR_HEAD]: active({ hasApproverRole: false }),
    [SELECTED]: active(),
  };
  for (const [id, facts] of Object.entries(overrides)) {
    if (facts === null) delete users[id];
    else users[id] = facts;
  }
  return users;
}

function baseProfiles(overrides: Record<string, ProfileFacts> = {}): Record<string, ProfileFacts> {
  return {
    [REQUESTER]: { managerUserId: MANAGER, primaryDepartmentId: 'dept-self' },
    ...overrides,
  };
}

function baseDepartments(
  overrides: Record<string, DepartmentFacts> = {},
): Record<string, DepartmentFacts> {
  return {
    'dept-self': { parentId: 'dept-parent', active: true },
    'dept-parent': { parentId: null, active: true },
    ...overrides,
  };
}

function baseHeads(overrides: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    'dept-self': HEAD,
    'dept-parent': ANCESTOR_HEAD,
    ...overrides,
  };
}

const fixedRule = (approverId = FIXED): RuleForResolution => ({
  ruleId: '00000000-0000-4000-9000-000000000201',
  code: 'fixed-rule',
  revision: 1,
  active: true,
  steps: [{ type: 'fixed', approverId }],
});

const managerRule = (onUnresolved: 'department_head' | 'reject' = 'reject'): RuleForResolution => ({
  ruleId: '00000000-0000-4000-9000-000000000202',
  code: 'manager-rule',
  revision: 1,
  active: true,
  steps: [{ type: 'manager', onUnresolved }],
});

const departmentHeadRule = (): RuleForResolution => ({
  ruleId: '00000000-0000-4000-9000-000000000203',
  code: 'head-rule',
  revision: 1,
  active: true,
  steps: [{ type: 'department_head', onUnresolved: 'reject' }],
});

function resolve(
  input: {
    definition?: { approval?: { approverId?: string; ruleId?: string } };
    rule?: RuleForResolution | null;
    ruleRoutingEnabled?: boolean;
    selectedApproverId?: string | null;
    snapshot?: ResolverSnapshot;
    requesterId?: string;
  } = {},
) {
  return resolveApprovalRoute({
    organizationId: ORG,
    requesterId: input.requesterId ?? REQUESTER,
    definition: input.definition ?? {},
    now: NOW,
    ruleRoutingEnabled: input.ruleRoutingEnabled ?? false,
    rule: input.rule ?? null,
    selectedApproverId: input.selectedApproverId ?? null,
    snapshot:
      input.snapshot ??
      snapshot({
        users: baseUsers(),
        profiles: baseProfiles(),
        departments: baseDepartments(),
        heads: baseHeads(),
      }),
  });
}

function routeOf(result: ReturnType<typeof resolve>): ApprovalRoute {
  if (!result.ok) throw new Error(`expected success: ${result.reason.code}`);
  return result.route;
}

function failureOf(result: ReturnType<typeof resolve>) {
  if (result.ok) throw new Error('expected failure');
  return result.reason;
}

describe('有効な所属の定義は1か所 (ADR-0023 §1)', () => {
  it.each([
    ['active + 有効な所属', active(), true],
    ['deactivated', deactivated(), false],
    ['role_binding なし', noMembership(), false],
    ['存在しない', undefined, false],
  ])('%s', (_label, facts, expected) => {
    expect(isActiveMember(facts)).toBe(expected);
  });
});

describe('現行互換: 固定承認者・申請者選択', () => {
  it('固定承認者1段を fixed / fixed で返す', () => {
    const result = resolve({ definition: { approval: { approverId: FIXED } } });
    expect(routeOf(result)).toEqual({
      steps: [{ stepNo: 1, approverId: FIXED, authorityType: 'fixed', resolvedFrom: 'fixed' }],
      ruleRef: null,
    });
    expect(result.ok && result.routeHash).toBe(routeHash(routeOf(result)));
  });

  it.each([
    ['他組織・存在しない', null],
    ['停止', deactivated()],
    ['有効な所属でない', noMembership()],
    ['approver ロールなし', noApproverRole()],
  ])('固定承認者が%sなら拒否', (_label, facts) => {
    const users = baseUsers({ [FIXED]: facts as UserFacts | null });
    const reason = failureOf(
      resolve({
        definition: { approval: { approverId: FIXED } },
        snapshot: snapshot({
          users,
          profiles: baseProfiles(),
          departments: baseDepartments(),
          heads: baseHeads(),
        }),
      }),
    );
    expect(reason.code).toBe('fixed_approver_invalid');
    expect(reason.missing).toBe('fixed_approver');
  });

  it('固定承認者が申請者本人なら拒否', () => {
    const reason = failureOf(resolve({ definition: { approval: { approverId: REQUESTER } } }));
    expect(reason.code).toBe('fixed_approver_self');
  });

  it('申請者選択は legacy / requester_selected で返す', () => {
    expect(routeOf(resolve({ selectedApproverId: SELECTED }))).toEqual({
      steps: [
        {
          stepNo: 1,
          approverId: SELECTED,
          authorityType: 'legacy',
          resolvedFrom: 'requester_selected',
        },
      ],
      ruleRef: null,
    });
  });

  it('申請者選択なしは不足として拒否', () => {
    expect(failureOf(resolve())).toMatchObject({
      code: 'requester_selected_missing',
      missing: 'selected_approver',
    });
  });

  it('申請者選択が本人・無効・ロールなしなら拒否', () => {
    expect(failureOf(resolve({ selectedApproverId: REQUESTER })).code).toBe(
      'requester_selected_self',
    );
    for (const facts of [deactivated(), noMembership(), noApproverRole(), null]) {
      const users = baseUsers({ [SELECTED]: facts as UserFacts | null });
      expect(
        failureOf(
          resolve({
            selectedApproverId: SELECTED,
            snapshot: snapshot({
              users,
              profiles: baseProfiles(),
              departments: baseDepartments(),
              heads: baseHeads(),
            }),
          }),
        ).code,
      ).toBe('requester_selected_invalid');
    }
  });

  it('組織で無効なら ruleId があっても固定承認者を使う', () => {
    const result = resolve({
      definition: { approval: { ruleId: fixedRule().ruleId, approverId: FIXED } },
      ruleRoutingEnabled: false,
      rule: fixedRule(),
    });
    expect(routeOf(result).ruleRef).toBeNull();
    expect(routeOf(result).steps[0]).toMatchObject({
      approverId: FIXED,
      authorityType: 'fixed',
      resolvedFrom: 'fixed',
    });
  });
});

describe('ルールの解決 (ADR-0023 §9)', () => {
  it('ルールが無効・他組織・不在なら現行互換へ落とさず拒否', () => {
    const reason = failureOf(
      resolve({
        definition: { approval: { ruleId: fixedRule().ruleId, approverId: FIXED } },
        ruleRoutingEnabled: true,
        rule: null,
      }),
    );
    expect(reason).toMatchObject({ code: 'rule_unavailable', missing: 'rule' });
  });

  it('固定・上長・部署長を順に解決し、ruleRef を保存する', () => {
    const rule: RuleForResolution = {
      ...fixedRule(),
      steps: [
        { type: 'fixed', approverId: FIXED },
        { type: 'manager', onUnresolved: 'reject' },
        { type: 'department_head', onUnresolved: 'reject' },
      ],
    };
    const result = resolve({
      definition: { approval: { ruleId: rule.ruleId } },
      ruleRoutingEnabled: true,
      rule,
    });
    expect(routeOf(result)).toEqual({
      steps: [
        { stepNo: 1, approverId: FIXED, authorityType: 'fixed', resolvedFrom: 'fixed' },
        { stepNo: 2, approverId: MANAGER, authorityType: 'manager', resolvedFrom: 'manager' },
        {
          stepNo: 3,
          approverId: HEAD,
          authorityType: 'department_head',
          resolvedFrom: 'department_head:self',
        },
      ],
      ruleRef: { ruleId: rule.ruleId, revision: 1 },
    });
  });

  it('上長が未設定で onUnresolved=reject なら拒否', () => {
    const reason = failureOf(
      resolve({
        definition: { approval: { ruleId: managerRule().ruleId } },
        ruleRoutingEnabled: true,
        rule: managerRule('reject'),
        snapshot: snapshot({
          users: baseUsers(),
          profiles: { [REQUESTER]: { managerUserId: null, primaryDepartmentId: 'dept-self' } },
          departments: baseDepartments(),
          heads: baseHeads(),
        }),
      }),
    );
    expect(reason).toMatchObject({ code: 'manager_unset', missing: 'manager', stepNo: 1 });
  });

  it('上長が未設定で onUnresolved=department_head なら部署長へ進む', () => {
    const result = resolve({
      definition: { approval: { ruleId: managerRule().ruleId } },
      ruleRoutingEnabled: true,
      rule: managerRule('department_head'),
      snapshot: snapshot({
        users: baseUsers(),
        profiles: { [REQUESTER]: { managerUserId: null, primaryDepartmentId: 'dept-self' } },
        departments: baseDepartments(),
        heads: baseHeads(),
      }),
    });
    expect(routeOf(result).steps[0]).toMatchObject({
      approverId: HEAD,
      authorityType: 'manager',
      resolvedFrom: 'manager>department_head',
    });
  });

  it('上長が停止・無効な所属なら onUnresolved に従う', () => {
    for (const facts of [deactivated(), noMembership()]) {
      const reason = failureOf(
        resolve({
          definition: { approval: { ruleId: managerRule().ruleId } },
          ruleRoutingEnabled: true,
          rule: managerRule('reject'),
          snapshot: snapshot({
            users: baseUsers({ [MANAGER]: facts }),
            profiles: baseProfiles(),
            departments: baseDepartments(),
            heads: baseHeads(),
          }),
        }),
      );
      expect(reason.code).toBe('manager_inactive');
    }
  });

  it('上長が申請者本人なら onUnresolved に従う', () => {
    const reason = failureOf(
      resolve({
        definition: { approval: { ruleId: managerRule().ruleId } },
        ruleRoutingEnabled: true,
        rule: managerRule('reject'),
        snapshot: snapshot({
          users: baseUsers(),
          profiles: { [REQUESTER]: { managerUserId: REQUESTER, primaryDepartmentId: 'dept-self' } },
          departments: baseDepartments(),
          heads: baseHeads(),
        }),
      }),
    );
    expect(reason.code).toBe('manager_self');
  });

  it('組織管理者の上長は設定されていても未設定として扱う', () => {
    const reason = failureOf(
      resolve({
        definition: { approval: { ruleId: managerRule().ruleId } },
        ruleRoutingEnabled: true,
        rule: managerRule('reject'),
        snapshot: snapshot({
          users: baseUsers({ [REQUESTER]: orgAdmin() }),
          profiles: { [REQUESTER]: { managerUserId: MANAGER, primaryDepartmentId: 'dept-self' } },
          departments: baseDepartments(),
          heads: baseHeads(),
        }),
      }),
    );
    expect(reason.code).toBe('manager_unset');
    expect(reason.message).toContain('組織管理者');

    const fallback = resolve({
      definition: { approval: { ruleId: managerRule().ruleId } },
      ruleRoutingEnabled: true,
      rule: managerRule('department_head'),
      snapshot: snapshot({
        users: baseUsers({ [REQUESTER]: orgAdmin() }),
        profiles: { [REQUESTER]: { managerUserId: MANAGER, primaryDepartmentId: 'dept-self' } },
        departments: baseDepartments(),
        heads: baseHeads(),
      }),
    });
    expect(routeOf(fallback).steps[0]!.resolvedFrom).toBe('manager>department_head');
  });

  it('部署長は自部署、なければ祖先を返す', () => {
    const own = resolve({
      definition: { approval: { ruleId: departmentHeadRule().ruleId } },
      ruleRoutingEnabled: true,
      rule: departmentHeadRule(),
    });
    expect(routeOf(own).steps[0]).toMatchObject({
      approverId: HEAD,
      resolvedFrom: 'department_head:self',
    });

    const ancestor = resolve({
      definition: { approval: { ruleId: departmentHeadRule().ruleId } },
      ruleRoutingEnabled: true,
      rule: departmentHeadRule(),
      snapshot: snapshot({
        users: baseUsers(),
        profiles: baseProfiles(),
        departments: baseDepartments(),
        heads: { 'dept-self': null, 'dept-parent': ANCESTOR_HEAD },
      }),
    });
    expect(routeOf(ancestor).steps[0]).toMatchObject({
      approverId: ANCESTOR_HEAD,
      resolvedFrom: 'department_head:ancestor',
    });
  });

  it('申請者本人が自部署の部署長なら飛ばして祖先へ進む', () => {
    const result = resolve({
      definition: { approval: { ruleId: departmentHeadRule().ruleId } },
      ruleRoutingEnabled: true,
      rule: departmentHeadRule(),
      snapshot: snapshot({
        users: baseUsers({ [REQUESTER]: active({ hasApproverRole: false }) }),
        profiles: baseProfiles(),
        departments: baseDepartments(),
        heads: { 'dept-self': REQUESTER, 'dept-parent': ANCESTOR_HEAD },
      }),
    });
    expect(routeOf(result).steps[0]).toMatchObject({
      approverId: ANCESTOR_HEAD,
      resolvedFrom: 'department_head:ancestor',
    });
  });

  it('期限切れ・無効な部署長は飛ばし、無効な部署も飛ばす', () => {
    const result = resolve({
      definition: { approval: { ruleId: departmentHeadRule().ruleId } },
      ruleRoutingEnabled: true,
      rule: departmentHeadRule(),
      snapshot: snapshot({
        users: baseUsers({ [HEAD]: deactivated() }),
        profiles: baseProfiles(),
        departments: baseDepartments({ 'dept-self': { parentId: 'dept-parent', active: false } }),
        heads: { 'dept-self': HEAD, 'dept-parent': ANCESTOR_HEAD },
      }),
    });
    expect(routeOf(result).steps[0]!.approverId).toBe(ANCESTOR_HEAD);
  });

  it('部署長が見つからなければ org_admin へフォールバックせず拒否', () => {
    const reason = failureOf(
      resolve({
        definition: { approval: { ruleId: departmentHeadRule().ruleId } },
        ruleRoutingEnabled: true,
        rule: departmentHeadRule(),
        snapshot: snapshot({
          users: baseUsers({ [REQUESTER]: orgAdmin() }),
          profiles: { [REQUESTER]: { managerUserId: null, primaryDepartmentId: 'dept-self' } },
          departments: baseDepartments(),
          heads: { 'dept-self': null, 'dept-parent': null },
        }),
      }),
    );
    expect(reason).toMatchObject({ code: 'department_head_missing', missing: 'department_head' });
  });

  it('経路内で同一人物が重複したら統合せず拒否', () => {
    const rule: RuleForResolution = {
      ...fixedRule(),
      steps: [
        { type: 'fixed', approverId: FIXED },
        { type: 'fixed', approverId: FIXED },
      ],
    };
    const reason = failureOf(
      resolve({
        definition: { approval: { ruleId: rule.ruleId } },
        ruleRoutingEnabled: true,
        rule,
      }),
    );
    expect(reason).toMatchObject({ code: 'duplicate_approver', stepNo: 2 });
  });

  it('0段・4段のルールは解決しない (DB/APIの検証とは別の二重防御)', () => {
    for (const steps of [
      [],
      Array.from({ length: 4 }, () => ({ type: 'fixed' as const, approverId: FIXED })),
    ]) {
      const reason = failureOf(
        resolve({
          definition: { approval: { ruleId: fixedRule().ruleId } },
          ruleRoutingEnabled: true,
          rule: { ...fixedRule(), steps: steps as RuleForResolution['steps'] },
        }),
      );
      expect(reason.code).toBe('rule_invalid');
    }
  });

  it('申請者が有効な所属でなければ拒否', () => {
    for (const facts of [deactivated(), noMembership(), null]) {
      const users = baseUsers({ [REQUESTER]: facts as UserFacts | null });
      const reason = failureOf(
        resolve({
          definition: { approval: { approverId: FIXED } },
          snapshot: snapshot({
            users,
            profiles: baseProfiles(),
            departments: baseDepartments(),
            heads: baseHeads(),
          }),
        }),
      );
      expect(reason.code).toBe('requester_not_active_member');
    }
  });

  it('同じ入力なら同じ routeHash、段の順序が違えば異なる', () => {
    const rule: RuleForResolution = {
      ...fixedRule(),
      steps: [
        { type: 'fixed', approverId: FIXED },
        { type: 'manager', onUnresolved: 'reject' },
      ],
    };
    const first = routeOf(
      resolve({
        definition: { approval: { ruleId: rule.ruleId } },
        ruleRoutingEnabled: true,
        rule,
      }),
    );
    const second = routeOf(
      resolve({
        definition: { approval: { ruleId: rule.ruleId } },
        ruleRoutingEnabled: true,
        rule,
      }),
    );
    expect(routeHash(first)).toBe(routeHash(second));

    const reversed = routeOf(
      resolve({
        definition: { approval: { ruleId: rule.ruleId } },
        ruleRoutingEnabled: true,
        rule: { ...rule, steps: [rule.steps[1]!, rule.steps[0]!] },
      }),
    );
    expect(routeHash(reversed)).not.toBe(routeHash(first));
  });
});
