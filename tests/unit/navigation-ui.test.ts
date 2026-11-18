// WP-P4-APR-016 stage A: approval-rule entry points and unchanged existing conditions.
// WP-P2-UIX-044: the same role filter feeds the text sidebar and its counts.
import { describe, expect, it } from 'vitest';
import type { SessionView } from '../../apps/web/src/lib/api';
import { buildNavigationGroups, navigationCounts } from '../../apps/web/src/lib/navigation-groups';
import { isOrgAdmin, navigationRoles } from '../../apps/web/src/lib/navigation';

const org = '01900000-0000-4000-8000-000000000001';

function session(roles: Array<{ roleCode: string; organizationId: string | null }>): SessionView {
  return { userId: '01900000-0000-4000-8000-000000000002', organizationId: org, roles };
}

function groups(roles: Array<{ roleCode: string; organizationId: string | null }>) {
  const value = session(roles);
  return buildNavigationGroups(navigationRoles(value), '/ops/overview');
}

function groupsWithCounts(
  roles: Array<{ roleCode: string; organizationId: string | null }>,
  counts: Parameters<typeof buildNavigationGroups>[2],
) {
  return buildNavigationGroups(navigationRoles(session(roles)), '/ops/overview', counts);
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

describe('UI v2 sidebar counts', () => {
  const agent = [{ roleCode: 'agent', organizationId: org }];
  const requester = [{ roleCode: 'requester', organizationId: org }];
  const mine = '/ops?assignment=mine&state=assigned&state=in_progress&state=pending';
  const breached = '/ops?sla=breached&state=new&state=assigned&state=in_progress&state=pending';

  it('keeps the role filter: requester gets no admin or staff ticket entries', () => {
    const all = allItems(requester);
    expect(all).not.toContain('/ops');
    expect(all).not.toContain(mine);
    expect(all).not.toContain(breached);
    expect(all).not.toContain('/ops/admin');
    expect(all).not.toContain('/ops/users');
  });

  it('offers the inbox, own work and breached entries to staff only', () => {
    expect(items(agent, 'tickets')).toEqual(['/inbox', '/ops', mine, breached, '/tickets/new']);
  });

  it('adds counts from the two allowed sources in the mock-up order', () => {
    const counts = navigationCounts(
      { counts: { ticket: 2, approval: 1, change: 3 } },
      { counts: { open: 10, unassigned: 4, mine: 7, pending: 2, breached: 1, critical: 0 } },
    );
    expect(counts).toEqual({ inbox: 6, mine: 7, breached: 1 });
    const ticketItems = groupsWithCounts(agent, counts).find(
      (group) => group.id === 'tickets',
    )?.items;
    expect(ticketItems?.find((item) => item.href === '/inbox')?.count).toEqual({
      value: 6,
      tone: 'brand',
    });
    expect(ticketItems?.find((item) => item.href === mine)?.count).toEqual({ value: 7 });
    expect(ticketItems?.find((item) => item.href === breached)?.count).toEqual({
      value: 1,
      tone: 'danger',
    });
    // 担当グループ別の件数は出さない(§14)。
    expect(
      groupsWithCounts(agent, counts).flatMap((group) => group.items.filter((item) => item.count)),
    ).toHaveLength(3);
  });

  it('omits every count when both readers fail (never an error or a zero)', () => {
    expect(navigationCounts(undefined, undefined)).toBeUndefined();
    const ticketItems = groupsWithCounts(agent, undefined).find(
      (group) => group.id === 'tickets',
    )?.items;
    expect(ticketItems?.some((item) => item.count)).toBe(false);
  });

  it('does not paint a zero count as an alert', () => {
    const zero = navigationCounts(
      { counts: { ticket: 0, approval: 0, change: 0 } },
      { counts: { open: 0, unassigned: 0, mine: 0, pending: 0, breached: 0, critical: 0 } },
    );
    const ticketItems = groupsWithCounts(agent, zero).find(
      (group) => group.id === 'tickets',
    )?.items;
    expect(ticketItems?.find((item) => item.href === '/inbox')?.count).toEqual({ value: 0 });
    expect(ticketItems?.find((item) => item.href === breached)?.count).toEqual({ value: 0 });
  });

  it('keeps the counts that were readable when only one reader fails', () => {
    const inboxOnly = navigationCounts(
      { counts: { ticket: 1, approval: 0, change: 2 } },
      undefined,
    );
    expect(inboxOnly).toEqual({ inbox: 3, mine: null, breached: null });
    const ticketItems = groupsWithCounts(agent, inboxOnly).find(
      (group) => group.id === 'tickets',
    )?.items;
    expect(ticketItems?.find((item) => item.href === '/inbox')?.count).toEqual({
      value: 3,
      tone: 'brand',
    });
    expect(ticketItems?.find((item) => item.href === mine)?.count).toBeUndefined();
    expect(ticketItems?.find((item) => item.href === breached)?.count).toBeUndefined();
  });
});
