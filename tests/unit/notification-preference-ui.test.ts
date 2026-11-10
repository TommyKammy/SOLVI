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
import { formScope } from '../../apps/web/src/lib/form-scope';
import {
  parseNotificationPreference,
  preferenceFailure,
} from '../../apps/web/src/lib/notification-preference';
import { saveNotificationPreference } from '../../apps/web/src/app/settings/notifications/actions';
import Page from '../../apps/web/src/app/settings/notifications/page';
import { AppShell } from '../../apps/web/src/components/AppShell';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    me: vi.fn(),
    notificationPreference: vi.fn(),
    saveNotificationPreference: vi.fn(),
    myOrganizations: vi.fn(),
    notifications: vi.fn(),
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/notifications',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({
    prefetch: _prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', props),
}));
vi.mock('../../apps/web/src/components/DraftSessionBoundary', () => ({
  DraftSessionBoundary: () => null,
  LogoutForm: () => createElement('button', {}, 'ログアウト'),
}));
const { api: realApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '05700000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '05700000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};
const scope = formScope(session);
const previous = { message: '', attempt: 0 };
const form = (value = 'false') => {
  const result = new FormData();
  result.set('ticketEmailEnabled', value);
  return result;
};
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction')
    return resolveServer(
      await (element.type as (props: unknown) => Promise<ReactNode>)(element.props),
    );
  const children = await resolveServer(element.props.children);
  return React.cloneElement(element, {}, ...(Array.isArray(children) ? children : [children]));
}
const render = async () => renderToStaticMarkup(await resolveServer(Page()));
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.mocked(api.me).mockReset().mockResolvedValue({ ok: true, data: session });
  vi.mocked(api.notificationPreference)
    .mockReset()
    .mockResolvedValue({ ok: true, data: { ticketEmailEnabled: true } });
  vi.mocked(api.saveNotificationPreference)
    .mockReset()
    .mockImplementation(async (ticketEmailEnabled) => ({ ok: true, data: { ticketEmailEnabled } }));
  vi.mocked(api.myOrganizations)
    .mockReset()
    .mockResolvedValue({
      ok: true,
      data: { organizations: [{ id: org, code: 'synthetic', name: 'Synthetic' }], selected: org },
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('personal notification preference DTO and client', () => {
  it.each([true, false])('accepts exactly one boolean (%s)', (ticketEmailEnabled) => {
    expect(parseNotificationPreference({ ticketEmailEnabled })).toEqual({ ticketEmailEnabled });
  });
  it.each([
    null,
    [],
    {},
    { ticketEmailEnabled: 'false' },
    { ticketEmailEnabled: 0 },
    { ticketEmailEnabled: true, userId: 'other' },
  ])('rejects invalid/expanded DTO %j', (value) => {
    expect(parseNotificationPreference(value)).toBeNull();
  });
  it('PATCH sends only the boolean and required scope, never Origin or a target ID', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ticketEmailEnabled: false }));
    vi.stubGlobal('fetch', fetch);
    expect(await realApi.saveNotificationPreference(false, scope)).toEqual({
      ok: true,
      data: { ticketEmailEnabled: false },
    });
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/me/notification-preferences')).toBe(true);
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(String(options.body))).toEqual({ ticketEmailEnabled: false });
    const headers = new Headers(options.headers);
    expect(headers.get('x-solvi-form-scope')).toBe(scope);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('origin')).toBe(false);
    expect(options.cache).toBe('no-store');
  });
  it.each(['GET', 'PATCH'])('handles a partial body after 200 headers for %s', async (method) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private transport details'));
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const result =
      method === 'GET'
        ? await realApi.notificationPreference()
        : await realApi.saveNotificationPreference(false, scope);
    expect(result).toEqual({
      ok: false,
      problem: { status: 503, title: '通知設定を確認できませんでした' },
    });
  });
  it('rejects a successful but invalid DTO rather than inventing ON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
    expect(await realApi.notificationPreference()).toEqual({
      ok: false,
      problem: { status: 502, title: '通知設定を確認できませんでした' },
    });
  });
});

describe('scope-bound personal preference action', () => {
  it.each([true, false])(
    'saves the requested boolean (%s) for the authenticated rendered scope',
    async (enabled) => {
      expect(await saveNotificationPreference(scope, previous, form(String(enabled)))).toEqual({
        message: '',
        saved: enabled,
        attempt: 1,
      });
      expect(api.saveNotificationPreference).toHaveBeenCalledExactlyOnceWith(enabled, scope);
    },
  );
  it.each(['', '0', 'on', 'TRUE'])(
    'rejects malformed form boolean %s without a write',
    async (value) => {
      expect((await saveNotificationPreference(scope, previous, form(value))).message).toBe(
        preferenceFailure(400),
      );
      expect(api.saveNotificationPreference).not.toHaveBeenCalled();
    },
  );
  it('rejects missing and repeated fields', async () => {
    const duplicate = form();
    duplicate.append('ticketEmailEnabled', 'true');
    for (const input of [new FormData(), duplicate])
      expect((await saveNotificationPreference(scope, previous, input)).message).toBe(
        preferenceFailure(400),
      );
    expect(api.saveNotificationPreference).not.toHaveBeenCalled();
  });
  it.each(['userId', 'organizationId'])('rejects changed %s before the write', async (field) => {
    vi.mocked(api.me).mockResolvedValue({ ok: true, data: { ...session, [field]: 'changed' } });
    expect(await saveNotificationPreference(scope, previous, form())).toEqual({
      message: preferenceFailure(409),
      scopeChanged: true,
      attempt: 1,
    });
    expect(api.saveNotificationPreference).not.toHaveBeenCalled();
  });
  it('keeps the API scope check for a switch after the initial session read', async () => {
    vi.mocked(api.saveNotificationPreference).mockResolvedValue({
      ok: false,
      problem: { status: 409, title: 'private' },
    });
    expect(await saveNotificationPreference(scope, previous, form())).toEqual({
      message: preferenceFailure(409),
      scopeChanged: true,
      attempt: 1,
    });
  });
  it.each([401, 403, 503])('stops a failed initial session read (%s)', async (status) => {
    vi.mocked(api.me).mockResolvedValue({ ok: false, problem: { status, title: 'private' } });
    const result = await saveNotificationPreference(scope, previous, form());
    expect(result.message).toBe(preferenceFailure(status));
    expect(result.saved).toBeUndefined();
    expect(api.saveNotificationPreference).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 503])(
    'returns safe API failure without a success claim (%s)',
    async (status) => {
      vi.mocked(api.saveNotificationPreference).mockResolvedValue({
        ok: false,
        problem: { status, title: 'private detail' },
      });
      const result = await saveNotificationPreference(scope, previous, form());
      expect(result.message).toBe(preferenceFailure(status));
      expect(result.saved).toBeUndefined();
    },
  );
  it('does not claim success for a different value or a lost action response', async () => {
    vi.mocked(api.saveNotificationPreference).mockResolvedValue({
      ok: true,
      data: { ticketEmailEnabled: true },
    });
    expect((await saveNotificationPreference(scope, previous, form())).saved).toBeUndefined();
    vi.mocked(api.saveNotificationPreference).mockRejectedValue(new Error('private'));
    expect((await saveNotificationPreference(scope, previous, form())).message).toBe(
      preferenceFailure(503),
    );
  });
});

describe('personal preference page and navigation', () => {
  it('renders actual ON/OFF, affected scope and no target or recipient controls', async () => {
    const on = await render();
    expect(on).toContain('checked=""');
    expect(on).toContain('新しく作成される任意の通知');
    expect(on).toContain('必須の通知は停止しません');
    expect(on).toContain('再試行は取り消せません');
    expect(on).toContain('実際のメール配達は確認できません');
    expect(on).not.toContain('name="userId"');
    expect(on).not.toContain('name="organizationId"');
    vi.mocked(api.notificationPreference).mockResolvedValue({
      ok: true,
      data: { ticketEmailEnabled: false },
    });
    expect(await render()).not.toContain('checked=""');
  });
  it.each([401, 403, 502, 503])(
    'renders failed GET %s without an enabled default form',
    async (status) => {
      vi.mocked(api.notificationPreference).mockResolvedValue({
        ok: false,
        problem: { status, title: 'private' },
      });
      const html = await render();
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain('private');
      expect(html).toContain('通知設定を再読み込み');
    },
  );
  it('renders unselected-org guidance without querying settings', async () => {
    vi.mocked(api.me).mockResolvedValue({
      ok: false,
      problem: {
        status: 403,
        title: 'Forbidden',
        type: 'https://solvi.local/problems/organization-not-selected',
      },
    });
    expect(await render()).toContain('組織を選ぶ');
    expect(api.notificationPreference).not.toHaveBeenCalled();
  });
  it('keeps a failed session transport separate from a default-ON setting', async () => {
    vi.mocked(api.me).mockRejectedValue(new Error('private transport'));
    const html = await render();
    expect(html).toContain('通知設定を取得できませんでした');
    expect(html).not.toContain('type="checkbox"');
    expect(api.notificationPreference).not.toHaveBeenCalled();
  });
  it('shows the authenticated personal entry in the shared shell', async () => {
    const html = renderToStaticMarkup(await AppShell({ children: null }));
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('Synthetic');
  });
  it('has a loading fallback with no speculative checkbox', () => {
    const tree = Page();
    const children = (tree as ReactElement<{ children: ReactNode[] }>).props.children;
    const suspense = children.find(
      (child) => isValidElement(child) && child.type === React.Suspense,
    ) as ReactElement<{ fallback: ReactNode }>;
    const html = renderToStaticMarkup(suspense.props.fallback);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('checkbox');
  });
});
