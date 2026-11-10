// NFR-UX-001, NFR-UX-002, NFR-UX-003: preserve support navigation and personal work.
// Focus visibility and real route navigation are checked by ui_support_portal_check.mjs.
import React, { createElement, type AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { format } from 'node:url';
import type { LinkProps } from 'next/link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type SessionView } from '../../apps/web/src/lib/api';
import { navigationRoles } from '../../apps/web/src/lib/navigation';
import { buildNavigationGroups } from '../../apps/web/src/lib/navigation-groups';
import { AppFrame } from '../../apps/web/src/components/AppFrame';
import PortalHome from '../../apps/web/src/app/portal/page';

const route = vi.hoisted(() => ({ pathname: '/portal' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch: _prefetch,
    ...props
  }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & LinkProps) =>
    createElement('a', { ...props, href: typeof href === 'string' ? href : format(href) }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { listTickets: vi.fn(), serviceRequests: vi.fn(), catalog: vi.fn() },
  requireSession: vi.fn(),
}));

const organizationId = '03800000-0000-4000-8000-000000000001';
const otherOrganizationId = '03800000-0000-4000-8000-000000000002';
const userId = '03800000-0000-4000-8000-000000000003';
const session = (codes: string[], organization: string | null = organizationId): SessionView => ({
  userId,
  organizationId,
  roles: codes.map((roleCode) => ({ roleCode, organizationId: organization })),
});
const frame = (actor: SessionView, pathname = '/portal') => {
  route.pathname = pathname;
  const roles = navigationRoles(actor);
  const landing = roles.staff ? '/ops/overview' : roles.auditor ? '/changes' : '/portal';
  return renderToStaticMarkup(
    createElement(AppFrame, {
      groups: buildNavigationGroups(roles, landing),
      staff: roles.staff,
      organizationName: '合成組織',
      canSwitchOrganization: false,
      children: createElement('main', { id: 'main' }, '合成コンテンツ'),
    }),
  );
};
const menu = (html: string) => {
  const match = html.match(/<nav class="fs-support-menu-panel"[^>]*>([\s\S]*?)<\/nav>/);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
};
const destinations = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const workDestinations = (html: string) =>
  destinations(menu(html)).filter((href) => ['/assets', '/inbox', '/changes'].includes(href));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  vi.mocked(api.listTickets).mockResolvedValue({
    ok: true,
    data: { items: [], total: 0, nextCursor: null, scope: 'own', appliedFilter: {} },
  });
  vi.mocked(api.serviceRequests).mockResolvedValue({
    ok: true,
    data: {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      appliedFilter: { q: '', state: 'all', view: 'mine', page: 1 },
    },
  });
  vi.mocked(api.catalog).mockResolvedValue({
    ok: true,
    data: { items: [], approvers: [], canManage: false },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('support shell preserves existing role-scoped work destinations', () => {
  it.each([
    ['requester', ['/assets']],
    ['approver', ['/inbox', '/assets', '/changes']],
    ['auditor', ['/assets', '/changes']],
    ['agent', ['/inbox', '/assets', '/changes']],
    ['org_admin', ['/inbox', '/assets', '/changes']],
    ['platform_admin', ['/inbox', '/assets', '/changes']],
  ] as const)('%s retains its work destinations on the support home', (code, expected) => {
    expect(workDestinations(frame(session([code])))).toEqual([...expected]);
  });

  it.each(['requester', 'approver', 'auditor'])(
    '%s keeps support links after opening knowledge',
    (code) => {
      const actor = session([code]);
      const html = frame(actor, '/knowledge');
      expect(html).not.toContain('class="fs-rail"');
      expect(workDestinations(html)).toEqual(workDestinations(frame(actor)));
    },
  );

  it('does not promote auditors to staff to restore navigation', () => {
    const actor = session(['auditor']);
    expect(navigationRoles(actor).staff).toBe(false);
    const html = menu(frame(actor, '/catalog'));
    expect(destinations(html)).toContain('/changes');
    expect(destinations(html)).not.toContain('/inbox');
    expect(destinations(html)).not.toContain('/ops');
  });

  it('does not add work links from another organization role', () => {
    const actor = session(['requester']);
    actor.roles.push({ roleCode: 'org_admin', organizationId: otherOrganizationId });
    expect(workDestinations(frame(actor))).toEqual(['/assets']);
  });

  it('supports a global administrator and combined roles without duplicate menu links', () => {
    expect(workDestinations(frame(session(['platform_admin'], null)))).toEqual([
      '/inbox',
      '/assets',
      '/changes',
    ]);
    const links = workDestinations(frame(session(['requester', 'approver', 'agent'])));
    expect(new Set(links).size).toBe(links.length);
  });

  it.each(['agent', 'org_admin', 'platform_admin'])(
    '%s retains the staff rail outside the portal',
    (code) => {
      expect(frame(session([code]), '/knowledge')).toContain('class="fs-rail"');
    },
  );
});

describe('portal action card opens available personal work', () => {
  it.each([
    ['requester', '/requests?view=mine', '申請状況を確認する'],
    ['auditor', '/requests?view=mine', '申請状況を確認する'],
    ['approver', '/inbox', '担当業務を確認する'],
    ['agent', '/inbox', '担当業務を確認する'],
    ['org_admin', '/inbox', '担当業務を確認する'],
  ])('%s reaches the correct personal workflow', async (code, href, label) => {
    vi.mocked(requireSession).mockResolvedValue(session([code]));
    const html = renderToStaticMarkup(await PortalHome({ searchParams: Promise.resolve({}) }));
    const card = html.match(
      /<a class="support-card support-card--approval"[^>]*>([\s\S]*?)<\/a>/,
    )?.[0];
    expect(card).toContain(`href="${href}"`);
    expect(card).toContain(label);
    if (code === 'requester' || code === 'auditor') expect(card).not.toContain('承認');
  });

  it('keeps the requester filter tied to the authenticated user', async () => {
    vi.mocked(requireSession).mockResolvedValue(session(['approver']));
    await PortalHome({
      searchParams: Promise.resolve({ requester: 'foreign-user', role: 'org_admin' }),
    });
    const filter = vi.mocked(api.listTickets).mock.calls[0]?.[1];
    expect(filter?.get('requester')).toBe(userId);
    expect(filter?.has('role')).toBe(false);
  });
});
