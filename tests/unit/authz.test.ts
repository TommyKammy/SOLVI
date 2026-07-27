/**
 * アプリケーション層の認可(NFR-SEC-006 / 脅威 T-02, T-05, T-20)。
 * RLS は安全網であり、こちらが主たる認可判定である。
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveRoles,
  hasRole,
  requireRole,
  canAccess,
  requireAccess,
  assertCanSwitchOrganization,
  type Principal,
  type AuthzContext,
} from '../../services/api/src/common/authz/authz.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const past = new Date('2026-01-01T00:00:00Z');
const future = new Date('2027-01-01T00:00:00Z');
const now = new Date('2026-07-01T00:00:00Z');

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: 'user-1',
  status: 'active',
  bindings: [],
  ...overrides,
});

const ctx = (p: Principal, organizationId = ORG_A): AuthzContext => ({
  principal: p,
  organizationId,
  now,
});

describe('effectiveRoles', () => {
  it('文脈の組織に属するロールだけを返す', () => {
    const p = principal({
      bindings: [
        { roleCode: 'agent', organizationId: ORG_A, validFrom: past, validUntil: null },
        { roleCode: 'org_admin', organizationId: ORG_B, validFrom: past, validUntil: null },
      ],
    });
    expect([...effectiveRoles(ctx(p, ORG_A))]).toEqual(['agent']);
    expect([...effectiveRoles(ctx(p, ORG_B))]).toEqual(['org_admin']);
  });

  it('platformスコープのロールはどの組織の文脈でも有効', () => {
    const p = principal({
      bindings: [
        { roleCode: 'platform_admin', organizationId: null, validFrom: past, validUntil: null },
      ],
    });
    expect(effectiveRoles(ctx(p, ORG_A)).has('platform_admin')).toBe(true);
    expect(effectiveRoles(ctx(p, ORG_B)).has('platform_admin')).toBe(true);
  });

  it('無効化されたユーザは一切のロールを失う (FR-IDM-007 / 脅威 T-05)', () => {
    const p = principal({
      status: 'deactivated',
      bindings: [
        { roleCode: 'platform_admin', organizationId: null, validFrom: past, validUntil: null },
        { roleCode: 'agent', organizationId: ORG_A, validFrom: past, validUntil: null },
      ],
    });
    expect(effectiveRoles(ctx(p)).size).toBe(0);
  });

  it('期限切れのbindingは無効 (FR-IDM-006 兼務・出向の期限)', () => {
    const p = principal({
      bindings: [
        {
          roleCode: 'agent',
          organizationId: ORG_A,
          validFrom: past,
          validUntil: new Date('2026-06-01T00:00:00Z'),
        },
      ],
    });
    expect(effectiveRoles(ctx(p)).size).toBe(0);
  });

  it('開始前のbindingは無効', () => {
    const p = principal({
      bindings: [{ roleCode: 'agent', organizationId: ORG_A, validFrom: future, validUntil: null }],
    });
    expect(effectiveRoles(ctx(p)).size).toBe(0);
  });

  it('兼務(複数組織)がそれぞれの文脈で正しく効く', () => {
    const p = principal({
      bindings: [
        { roleCode: 'agent', organizationId: ORG_A, validFrom: past, validUntil: null },
        { roleCode: 'requester', organizationId: ORG_B, validFrom: past, validUntil: future },
      ],
    });
    expect(hasRole(ctx(p, ORG_A), 'agent')).toBe(true);
    expect(hasRole(ctx(p, ORG_B), 'agent')).toBe(false);
    expect(hasRole(ctx(p, ORG_B), 'requester')).toBe(true);
  });
});

describe('requireRole', () => {
  it('権限がなければ403を投げる', () => {
    const p = principal({
      bindings: [
        { roleCode: 'requester', organizationId: ORG_A, validFrom: past, validUntil: null },
      ],
    });
    expect(() => requireRole(ctx(p), 'org_admin')).toThrow();
    expect(() => requireRole(ctx(p), 'requester')).not.toThrow();
  });
});

describe('オブジェクトレベル認可 (NFR-SEC-006)', () => {
  const agent = principal({
    bindings: [{ roleCode: 'agent', organizationId: ORG_A, validFrom: past, validUntil: null }],
  });
  const requester = principal({
    userId: 'user-req',
    bindings: [{ roleCode: 'requester', organizationId: ORG_A, validFrom: past, validUntil: null }],
  });
  const policy = { organizationWide: ['agent', 'org_admin'] as const, allowOwner: true };

  it('組織が違えばロールがあってもアクセス不可', () => {
    expect(
      canAccess(
        ctx(agent, ORG_A),
        { organizationId: ORG_B },
        { ...policy, organizationWide: [...policy.organizationWide] },
      ),
    ).toBe(false);
  });

  it('組織全体権限を持つロールは組織内の全件にアクセスできる', () => {
    expect(
      canAccess(
        ctx(agent, ORG_A),
        { organizationId: ORG_A, ownerUserId: 'someone-else' },
        { ...policy, organizationWide: [...policy.organizationWide] },
      ),
    ).toBe(true);
  });

  it('所有者本人は自分のリソースにアクセスできる', () => {
    expect(
      canAccess(
        ctx(requester, ORG_A),
        { organizationId: ORG_A, ownerUserId: 'user-req' },
        { ...policy, organizationWide: [...policy.organizationWide] },
      ),
    ).toBe(true);
  });

  it('他人のリソースにはアクセスできない(IDOR / 脅威 T-02)', () => {
    expect(
      canAccess(
        ctx(requester, ORG_A),
        { organizationId: ORG_A, ownerUserId: 'another-user' },
        { ...policy, organizationWide: [...policy.organizationWide] },
      ),
    ).toBe(false);
  });

  it('アクセス不可のとき404を投げる(存在を推測させない)', () => {
    try {
      requireAccess(
        ctx(requester, ORG_A),
        { organizationId: ORG_B },
        { ...policy, organizationWide: [...policy.organizationWide] },
        'チケット',
      );
      throw new Error('例外が投げられませんでした');
    } catch (error) {
      // 403ではなく404であることが重要
      expect((error as { status?: number }).status).toBe(404);
    }
  });
});

describe('組織の切替 (脅威 T-20)', () => {
  it('platformロールがなければ切替できない', () => {
    const p = principal({
      bindings: [
        { roleCode: 'org_admin', organizationId: ORG_A, validFrom: past, validUntil: null },
      ],
    });
    expect(() => assertCanSwitchOrganization(p, now)).toThrow();
  });

  it('platform_adminは切替できる', () => {
    const p = principal({
      bindings: [
        { roleCode: 'platform_admin', organizationId: null, validFrom: past, validUntil: null },
      ],
    });
    expect(() => assertCanSwitchOrganization(p, now)).not.toThrow();
  });

  it('無効化されたplatform_adminは切替できない', () => {
    const p = principal({
      status: 'deactivated',
      bindings: [
        { roleCode: 'platform_admin', organizationId: null, validFrom: past, validUntil: null },
      ],
    });
    expect(() => assertCanSwitchOrganization(p, now)).toThrow();
  });
});
