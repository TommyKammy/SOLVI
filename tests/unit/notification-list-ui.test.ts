// NFR-UX-002, NFR-UX-003, NFR-UX-004: semantic UI, Japanese copy and recovery.
// Browser/axe evidence is separate; these units are not a full WCAG certification.
import React, {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type AnchorHTMLAttributes,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type SessionView } from '../../apps/web/src/lib/api';
import { navigationRoles } from '../../apps/web/src/lib/navigation';
import {
  NOTIFICATION_EVENTS,
  OUTBOX_STATUS_LABELS,
  notificationHref,
  parseNotificationList,
  parseNotificationQuery,
  type NotificationList,
  type NotificationItem,
} from '../../apps/web/src/lib/notification-list';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { me: vi.fn(), notifications: vi.fn(), myOrganizations: vi.fn() },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('../../apps/web/src/components/DraftSessionBoundary', () => ({
  DraftSessionBoundary: () => null,
  LogoutForm: () => createElement('button', {}, 'ログアウト'),
}));
vi.mock('next/link', () => ({
  default: ({
    prefetch: _prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', props),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/ops/notifications',
  useSearchParams: () => new URLSearchParams(),
}));
const { default: Page } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/ops/notifications/page');
const { AppNavigation, RouteContext } = await vi.importActual<{
  AppNavigation: (props: { roles: ReturnType<typeof navigationRoles> }) => ReactNode;
  RouteContext: () => ReactNode;
}>('../../apps/web/src/components/AppNavigation');
const { SiteHeader } = await vi.importActual<{
  SiteHeader: () => Promise<ReactNode>;
}>('../../apps/web/src/components/SiteHeader');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '05600000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '05600000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'org_admin', organizationId: org }],
};
const item = (patch: Partial<NotificationItem> = {}): NotificationItem => ({
  id: '05600000-0000-4000-8000-000000000003',
  eventType: 'ticket.created',
  channel: 'email',
  status: 'failed',
  createdAt: '2026-10-08T00:00:00.123456Z',
  sentAt: null,
  failedAt: '2026-10-08T00:01:00.123456Z',
  attempts: 2,
  outboxStatus: 'retry_waiting',
  nextAttemptAt: '2026-10-08T00:02:00.123456Z',
  manualRetry: 'unavailable',
  ...patch,
});
const data = (patch: Partial<NotificationList> = {}): NotificationList => ({
  items: [item()],
  counts: { all: 1, pending: 0, sent: 0, failed: 1 },
  total: 1,
  previousCursor: null,
  nextCursor: null,
  deliveryMode: 'recording',
  ...patch,
});
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    const resolved = await resolveServer(
      await (element.type as (props: unknown) => ReactNode | Promise<ReactNode>)(element.props),
    );
    return isValidElement(resolved) && element.key !== null
      ? React.cloneElement(resolved, { key: element.key })
      : resolved;
  }
  const children = await resolveServer(element.props.children);
  return React.cloneElement(element, {}, ...(Array.isArray(children) ? children : [children]));
}
const render = async (raw: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await resolveServer(await Page({ searchParams: Promise.resolve(raw) })));
beforeEach(() => {
  // Root Vitest uses classic JSX; production Next uses the automatic JSX runtime.
  vi.stubGlobal('React', React);
  vi.mocked(api.me).mockReset().mockResolvedValue({ ok: true, data: session });
  vi.mocked(api.notifications).mockReset().mockResolvedValue({ ok: true, data: data() });
  vi.mocked(api.myOrganizations)
    .mockReset()
    .mockResolvedValue({
      ok: true,
      data: { organizations: [{ id: org, code: 'synthetic', name: 'Synthetic' }], selected: org },
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('notification reader transport boundary', () => {
  it('returns fixed 503 when a 200 response body fails after headers arrive', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":'));
        controller.error(new Error('private upstream details'));
      },
    });
    const response = new Response(body, { status: 200 });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    expect(response.status).toBe(200);
    expect(await actualApi.notifications(parseNotificationQuery({}))).toEqual({
      ok: false,
      problem: { status: 503, title: '通知状況を確認できませんでした' },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('still validates a complete DTO and rejects extra response content', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(data()));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.notifications(parseNotificationQuery({}))).toEqual({
      ok: true,
      data: data(),
    });
    fetch.mockResolvedValueOnce(Response.json({ ...data(), content: 'private' }));
    expect(await actualApi.notifications(parseNotificationQuery({}))).toEqual({
      ok: false,
      problem: { status: 502, title: '通知状況を確認できませんでした' },
    });
  });
});

describe('header notification authorization confirmation', () => {
  const header = async () => renderToStaticMarkup(await SiteHeader());
  it('confirms a candidate binding with the protected reader before exposing the link', async () => {
    expect(await header()).toContain('href="/ops/notifications"');
    expect(api.notifications).toHaveBeenCalledExactlyOnceWith(parseNotificationQuery({}));
  });
  it.each(['future binding', 'expired binding', 'revoked binding'])(
    'hides a candidate %s when the API denies its current validity',
    async () => {
      // These states have identical auth/me role arrays; validity is enforced by the real reader.
      vi.mocked(api.notifications).mockResolvedValue({
        ok: false,
        problem: { status: 403, title: 'Forbidden' },
      });
      const html = await header();
      expect(api.notifications).toHaveBeenCalledOnce();
      expect(html).not.toContain('href="/ops/notifications"');
      expect(html).toContain('href="/ops/users"');
    },
  );
  it.each([401, 502, 503])(
    'hides the link when authorization cannot be confirmed (%s)',
    async (status) => {
      vi.mocked(api.notifications).mockResolvedValue({
        ok: false,
        problem: { status, title: 'Unavailable' },
      });
      expect(await header()).not.toContain('href="/ops/notifications"');
    },
  );
  it.each(['agent', 'platform_admin'])(
    'does not issue an extra reader request for %s',
    async (roleCode) => {
      vi.mocked(api.me).mockResolvedValue({
        ok: true,
        data: {
          ...session,
          roles: [{ roleCode, organizationId: roleCode === 'agent' ? org : null }],
        },
      });
      expect(await header()).not.toContain('href="/ops/notifications"');
      expect(api.notifications).not.toHaveBeenCalled();
    },
  );
});

describe('notification minimum DTO and URL', () => {
  it('keeps fixed filters and opaque cursors, omits arbitrary sort/org/content controls', () => {
    const query = parseNotificationQuery({
      status: 'failed',
      direction: 'previous',
      cursor: 'opaque_ABC',
      sort: 'private',
      organizationId: 'foreign',
    });
    expect(query).toEqual({
      status: 'failed',
      direction: 'previous',
      cursor: 'opaque_ABC',
      invalid: false,
    });
    expect(notificationHref(query)).toBe(
      '/ops/notifications?status=failed&direction=previous&cursor=opaque_ABC',
    );
    expect(notificationHref({ status: 'failed', direction: 'next' })).toBe(
      '/ops/notifications?status=failed',
    );
  });
  it.each([
    { status: 'private' },
    { status: ['all', 'failed'] },
    { direction: ['next'] },
    { direction: 'previous' },
    { cursor: '' },
    { cursor: 'x'.repeat(169) },
    { cursor: ['abc'] },
    { cursor: 'secret&value' },
  ])('rejects invalid query without reflecting the input %j', (raw) => {
    expect(parseNotificationQuery(raw).invalid).toBe(true);
  });
  it('accepts microseconds and fixed labels while preserving the safe DTO', () => {
    expect(parseNotificationList(data(), 'all')).toEqual(data());
    expect(parseNotificationList(data(), 'failed')).toEqual(data());
    expect(NOTIFICATION_EVENTS.other).toBe('その他');
    expect(OUTBOX_STATUS_LABELS.stopped).toBe('再試行なし');
  });
  it.each([
    { total: 0 },
    { total: '1' },
    { deliveryMode: 'delivered' },
    { subject: 'private' },
    { counts: { all: 2, pending: 0, sent: 0, failed: 1 } },
    { items: [item(), item()] },
    { items: [{ ...item(), last_error: 'private' }] },
    { items: [{ ...item(), eventType: 'private' }] },
    { items: [{ ...item(), channel: 'private' }] },
    { items: [{ ...item(), channel: ['email'] }] },
    { items: [{ ...item(), status: ['failed'] }] },
    { items: [{ ...item(), attempts: -1 }] },
    { items: [{ ...item(), createdAt: 'private' }] },
    { items: [{ ...item(), createdAt: '2026-02-30T00:00:00Z' }] },
    { items: [item({ status: 'sent' })] },
    { items: [item({ outboxStatus: 'processing' })] },
    { items: [item({ outboxStatus: 'stopped' })] },
    { items: [item({ outboxStatus: 'finished' })] },
    { items: [item({ outboxStatus: 'unknown' })] },
  ])('rejects invalid/extra metadata and impossible next-time display %j', (patch) => {
    expect(parseNotificationList({ ...data(), ...patch }, 'all')).toBeNull();
  });
  it('rejects a mismatched filter and more than 20 rows', () => {
    expect(parseNotificationList(data(), 'pending')).toBeNull();
    expect(parseNotificationList(data({ items: Array(21).fill(item()) }), 'all')).toBeNull();
  });
});

describe('org-admin notification view', () => {
  it('requires the selected org binding without broadening existing admin behavior', () => {
    for (const roles of [
      [{ roleCode: 'platform_admin', organizationId: null }],
      [{ roleCode: 'agent', organizationId: org }],
      [{ roleCode: 'org_admin', organizationId: null }],
      [{ roleCode: 'org_admin', organizationId: 'foreign' }],
    ]) {
      expect(navigationRoles({ ...session, roles }).notifications).toBe(false);
    }
    expect(
      navigationRoles({ ...session, roles: [{ roleCode: 'platform_admin', organizationId: null }] })
        .admin,
    ).toBe(true);
    expect(navigationRoles(session).notifications).toBe(true);
  });
  it('adds only the permitted notification nav and active context', () => {
    const allowed = renderToStaticMarkup(
      createElement(AppNavigation, { roles: navigationRoles(session) }),
    );
    const denied = renderToStaticMarkup(
      createElement(AppNavigation, {
        roles: navigationRoles({
          ...session,
          roles: [{ roleCode: 'platform_admin', organizationId: null }],
        }),
      }),
    );
    expect(allowed).toContain('href="/ops/notifications"');
    expect(allowed).toContain('href="/ops/notifications" aria-current="page"');
    expect(allowed).not.toContain('href="/ops" aria-current="page"');
    expect(denied).not.toContain('href="/ops/notifications"');
    expect(renderToStaticMarkup(createElement(RouteContext))).toContain('通知状況');
  });
  it('renders safe labels, separate status/processing and attempts, never an ID or content link', async () => {
    const html = await render();
    expect(html).toContain('実際のメール配達は確認できません');
    expect(html).toContain('失敗');
    expect(html).toContain('再試行待ち');
    expect(html).toContain('試行数');
    expect(html).toContain('次回処理予定');
    expect(html).not.toContain(item().id);
    expect(html).not.toContain('/tickets/');
    expect(html).not.toContain('配達済み');
    expect(html).not.toContain('上限到達');
    expect(api.notifications).toHaveBeenCalledWith(parseNotificationQuery({}));
  });
  it('preserves status and directions but always reloads the first page with a native anchor', async () => {
    vi.mocked(api.notifications).mockResolvedValue({
      ok: true,
      data: data({ previousCursor: 'prev', nextCursor: 'next' }),
    });
    const html = await render({ status: 'failed', cursor: 'current' });
    expect(html).toContain('href="/ops/notifications?status=failed"');
    expect(html).toContain('status=failed&amp;direction=previous&amp;cursor=prev');
    expect(html).toContain('status=failed&amp;direction=next&amp;cursor=next');
    expect(html).toContain('通知状況を再読み込み');
  });
  it.each([401, 403, 503])(
    'keeps denied/session/network error %s separate from a zero count',
    async (status) => {
      vi.mocked(api.notifications).mockResolvedValue({
        ok: false,
        problem: { status, title: 'private-free-text' },
      });
      const html = await render({ status: 'failed' });
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('private-free-text');
      expect(html).not.toContain('notification-counts');
      if (status === 401) expect(html).toContain('別のタブでログインする');
      if (status === 403) expect(html).toContain('通知状況を表示する権限がありません');
    },
  );
  it('never fetches data for an unauthorized direct URL or invalid condition', async () => {
    vi.mocked(api.me).mockResolvedValue({
      ok: true,
      data: { ...session, roles: [{ roleCode: 'platform_admin', organizationId: null }] },
    });
    expect(await render()).toContain('通知状況を表示する権限がありません');
    expect(api.notifications).not.toHaveBeenCalled();
    vi.mocked(api.me).mockResolvedValue({ ok: true, data: session });
    expect(await render({ status: 'private-string' })).not.toContain('private-string');
    expect(api.notifications).not.toHaveBeenCalled();
  });
  it.each([
    [
      {},
      data({ items: [], total: 0, counts: { all: 0, pending: 0, sent: 0, failed: 0 } }),
      '通知はまだ記録されていません',
    ],
    [
      { status: 'failed' },
      data({ items: [], total: 0, counts: { all: 1, pending: 1, sent: 0, failed: 0 } }),
      'この状態の通知はありません',
    ],
    [{ status: 'failed', cursor: 'last' }, data({ items: [] }), 'この取得位置に通知はありません'],
  ] as const)('distinguishes empty states %j', async (raw, response, heading) => {
    vi.mocked(api.notifications).mockResolvedValue({ ok: true, data: response });
    expect(await render(raw)).toContain(heading);
  });
  it('exposes a streaming loading fallback without inventing counts', async () => {
    const tree = await Page({ searchParams: Promise.resolve({}) });
    const findFallback = (node: ReactNode): ReactNode => {
      if (Array.isArray(node)) return node.map(findFallback);
      if (!isValidElement(node)) return null;
      const props = (node as ReactElement<{ fallback?: ReactNode; children?: ReactNode }>).props;
      return props.fallback ?? findFallback(props.children);
    };
    const html = renderToStaticMarkup(findFallback(tree));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('通知状況を読み込んでいます');
    expect(html).not.toContain('件');
    expect(api.notifications).not.toHaveBeenCalled();
  });
});
