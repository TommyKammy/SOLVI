// WP-P4-APR-016 stage A: approval-rule entry points and unchanged existing conditions.
import { describe, expect, it } from 'vitest';
import type { SessionView } from '../../apps/web/src/lib/api';
import { buildNavigationGroups } from '../../apps/web/src/lib/navigation-groups';
import { isOrgAdmin, navigationRoles } from '../../apps/web/src/lib/navigation';

const org = '01900000-0000-4000-8000-000000000001';

function session(roles: Array<{ roleCode: string; organizationId: string | null }>): SessionView {
  return { userId: '01900000-0000-4000-8000-000000000002', organizationId: org, roles };
}

function groups(roles: Array<{ roleCode: string; organizationId: string | null }>) {
  const value = session(roles);
  return buildNavigationGroups(navigationRoles(value), '/ops/overview');
}

const items = (roleList: Array<{ roleCode: string; organizationId: string | null }>, id: string) =>
  groups(roleList)
    .find((group) => group.id === id)
    ?.items.map((item) => item.href);

const allItems = (roleList: Array<{ roleCode: string; organizationId: string | null }>) =>
  groups(roleList).flatMap((group) => group.items.map((item) => item.href));

describe('approval rule navigation', () => {
  it('adds the approval-rule item only for a selected-org org_admin, preserving existing order', () => {
    const roleList = [{ roleCode: 'org_admin', organizationId: org }];
    expect(isOrgAdmin(session(roleList))).toBe(true);
    expect(items(roleList, 'admin')).toEqual([
      '/ops/admin',
      '/ops/users',
      '/ops/departments',
      '/ops/groups',
      '/ops/notifications',
      '/ops/access-review',
      '/ops/approvals',
    ]);
  });

  it('does not show the approval-rule item to platform_admin or a global org_admin', () => {
    const platform = [{ roleCode: 'platform_admin', organizationId: null }];
    expect(allItems(platform)).not.toContain('/ops/approvals');
    expect(items(platform, 'admin')).toEqual([
      '/ops/admin',
      '/ops/users',
      '/ops/groups',
      '/ops/access-review',
    ]);

    const globalOrgAdmin = [{ roleCode: 'org_admin', organizationId: null }];
    expect(isOrgAdmin(session(globalOrgAdmin))).toBe(false);
    expect(allItems(globalOrgAdmin)).not.toContain('/ops/approvals');
  });

  it('does not show any approval entry to an agent', () => {
    const agent = [{ roleCode: 'agent', organizationId: org }];
    expect(allItems(agent).filter((href) => href.startsWith('/ops/approvals'))).toEqual([]);
    expect(groups(agent).some((group) => group.id === 'admin')).toBe(false);
  });

  it('gives auditors only the relationship change history entry', () => {
    const auditor = [{ roleCode: 'auditor', organizationId: org }];
    expect(allItems(auditor)).toContain('/ops/approvals/changes');
    expect(allItems(auditor)).not.toContain('/ops/approvals');
    expect(items(auditor, 'audit')).toEqual(['/ops/approvals/changes']);
    expect(groups(auditor).some((group) => group.id === 'admin')).toBe(false);
  });

  it('keeps the existing admin menu and audit entry stable for roles without approvals', () => {
    const agent = [{ roleCode: 'agent', organizationId: org }];
    expect(items(agent, 'catalog')).toEqual(['/catalog', '/requests']);
    expect(groups(agent).map((group) => group.id)).toEqual([
      'dashboard',
      'tickets',
      'knowledge',
      'catalog',
      'assets',
      'changes',
      'portal',
    ]);
  });
});
