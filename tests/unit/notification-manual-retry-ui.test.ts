// WP058: fixed public DTO, bound Server Action and fail-closed recovery.
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type SessionView } from '../../apps/web/src/lib/api';
import { notificationRetryAction } from '../../apps/web/src/app/ops/notifications/actions';
import {
  NotificationRetryForm,
  NotificationRetryListRefresh,
} from '../../apps/web/src/components/NotificationRetryForm';
import {
  parseNotificationRetry,
  RETRY_REASONS,
  RETRY_STATES,
  type NotificationRetryStatus,
} from '../../apps/web/src/lib/notification-retry';
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { me: vi.fn(), notificationRetry: vi.fn(), reserveNotificationRetry: vi.fn() },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const org = '05800000-0000-4000-8000-000000000001';
const user = '05800000-0000-4000-8000-000000000002';
const target = '05800000-0000-4000-8000-000000000003';
const scope = `${org}:${user}`;
const version = 'a'.repeat(43);
const session: SessionView = {
  userId: user,
  organizationId: org,
  roles: [{ roleCode: 'org_admin', organizationId: org }],
};
const dto = (patch: Partial<NotificationRetryStatus> = {}): NotificationRetryStatus => ({
  eligible: true,
  reason: null,
  version,
  state: 'not_requested',
  requestedAt: null,
  expiresAt: null,
  completedAt: null,
  deliveryMode: 'recording',
  ...patch,
});
const queued = dto({
  eligible: false,
  version: null,
  state: 'queued',
  requestedAt: '2026-10-08T01:00:00.123456Z',
  expiresAt: '2026-10-08T01:15:00.123456Z',
});
function form(intent = 'check', token = version) {
  const value = new FormData();
  value.set('intent', intent);
  if (intent === 'reserve') value.set('version', token);
  return value;
}
const action = (value = form()) =>
  notificationRetryAction(target, scope, { message: '', attempt: 0 }, value);
const problem = (status: number) => ({
  ok: false as const,
  problem: { status, title: 'PRIVATE_DETAILS', detail: 'PRIVATE_CONTENT' },
});
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.mocked(api.me).mockReset().mockResolvedValue({ ok: true, data: session });
  vi.mocked(api.notificationRetry).mockReset().mockResolvedValue({ ok: true, data: dto() });
  vi.mocked(api.reserveNotificationRetry).mockReset().mockResolvedValue({ ok: true, data: queued });
});
afterEach(() => vi.unstubAllGlobals());
describe('manual retry DTO', () => {
  it('accepts only fixed safe states, reasons and native microsecond dates', () => {
    expect(parseNotificationRetry(dto())).toEqual(dto());
    for (const state of Object.keys(RETRY_STATES) as NotificationRetryStatus['state'][]) {
      const terminal = ['succeeded', 'failed', 'rejected'].includes(state);
      const reason =
        state === 'failed'
          ? 'sender_failed'
          : state === 'rejected'
            ? 'target_changed'
            : state === 'expired'
              ? 'approval_expired'
              : state === 'unknown'
                ? 'result_unknown'
                : state === 'not_requested'
                  ? 'unsupported'
                  : null;
      expect(
        parseNotificationRetry({
          ...queued,
          state,
          reason,
          requestedAt: state === 'not_requested' ? null : queued.requestedAt,
          expiresAt: state === 'not_requested' ? null : queued.expiresAt,
          completedAt: terminal ? '2026-10-08T01:01:00Z' : null,
        }),
      ).not.toBeNull();
    }
    for (const reason of Object.keys(RETRY_REASONS) as NonNullable<
      NotificationRetryStatus['reason']
    >[])
      expect(
        parseNotificationRetry(dto({ eligible: false, version: null, reason })),
      ).not.toBeNull();
    expect(parseNotificationRetry(queued)).toEqual(queued);
  });
  it.each([
    { eligible: 'true' },
    { version: 'a'.repeat(42) },
    { version: 'a'.repeat(44) },
    { version: null },
    { eligible: false },
    { reason: 'raw upstream' },
    { reason: 'sender_failed' },
    { state: 'queued' },
    { state: 'delivered' },
    { deliveryMode: 'email' },
    { subject: 'private' },
    { requestedAt: '2026-02-30T00:00:00Z' },
    { completedAt: 'not a date' },
  ])('rejects ambiguous or extra response content %j', (patch) =>
    expect(parseNotificationRetry({ ...dto(), ...patch })).toBeNull(),
  );
});
describe('bound row action', () => {
  it('checks eligibility with real GET and never creates a reservation', async () => {
    expect((await action()).data).toEqual(dto());
    expect(api.notificationRetry).toHaveBeenCalledExactlyOnceWith(target);
    expect(api.reserveNotificationRetry).not.toHaveBeenCalled();
  });
  it('uses only the bound target/scope and the checked version', async () => {
    const input = form('reserve');
    input.set('notificationId', 'foreign');
    input.set('organizationId', 'foreign');
    input.set('recipient', 'private');
    expect((await action(input)).data).toEqual(queued);
    expect(api.reserveNotificationRetry).toHaveBeenCalledExactlyOnceWith(target, version, scope);
  });
  it.each(['private', '', 'a'.repeat(44)])(
    'rejects invalid version %s before API access',
    async (token) => {
      expect((await action(form('reserve', token))).mustCheck).toBe(true);
      expect(api.reserveNotificationRetry).not.toHaveBeenCalled();
      expect(api.me).not.toHaveBeenCalled();
    },
  );
  it('rejects duplicate intent/version and invalid bound targets', async () => {
    const input = form('reserve');
    input.append('version', version);
    expect((await action(input)).mustCheck).toBe(true);
    const duplicate = form();
    duplicate.append('intent', 'reserve');
    expect((await action(duplicate)).mustCheck).toBe(true);
    expect(
      (await notificationRetryAction('../private', scope, { message: '', attempt: 0 }, form()))
        .mustCheck,
    ).toBe(true);
    expect(api.me).not.toHaveBeenCalled();
  });
  it.each(['agent', 'platform_admin'])(
    'refuses %s without current selected org administrator',
    async (roleCode) => {
      vi.mocked(api.me).mockResolvedValue({
        ok: true,
        data: {
          ...session,
          roles: [{ roleCode, organizationId: roleCode === 'agent' ? org : null }],
        },
      });
      expect((await action(form('reserve'))).message).toContain('権限');
      expect(api.reserveNotificationRetry).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...session, userId: target },
    { ...session, organizationId: target },
  ])('rejects changed scope before write', async (data) => {
    vi.mocked(api.me).mockResolvedValue({ ok: true, data });
    expect((await action(form('reserve'))).scopeChanged).toBe(true);
    expect(api.reserveNotificationRetry).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])(
    'does not expose raw errors or blindly resubmit after %s',
    async (status) => {
      vi.mocked(api.reserveNotificationRetry).mockResolvedValue(problem(status));
      const result = await action(form('reserve'));
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(result.mustCheck).toBe(true);
      expect(api.reserveNotificationRetry).toHaveBeenCalledOnce();
      expect(api.notificationRetry).not.toHaveBeenCalled();
    },
  );
  it.each([409, 502, 503])(
    'reads existing reservation after ambiguous/conflicting response %s',
    async (status) => {
      vi.mocked(api.reserveNotificationRetry).mockResolvedValue(problem(status));
      vi.mocked(api.notificationRetry).mockResolvedValue({ ok: true, data: queued });
      expect((await action(form('reserve'))).data).toEqual(queued);
      expect(api.reserveNotificationRetry).toHaveBeenCalledOnce();
      expect(api.notificationRetry).toHaveBeenCalledExactlyOnceWith(target);
    },
  );
  it('requires a fresh human check when the ambiguous POST still reads not requested', async () => {
    vi.mocked(api.reserveNotificationRetry).mockResolvedValue(problem(503));
    const result = await action(form('reserve'));
    expect(result.mustCheck).toBe(true);
    expect(result.data?.eligible).toBe(true);
    expect(result.message).not.toBe('');
  });
  it('does not read another organization after a scope change during POST', async () => {
    vi.mocked(api.reserveNotificationRetry).mockResolvedValue(problem(503));
    vi.mocked(api.me)
      .mockResolvedValueOnce({ ok: true, data: session })
      .mockResolvedValueOnce({ ok: true, data: { ...session, organizationId: target } });
    expect((await action(form('reserve'))).scopeChanged).toBe(true);
    expect(api.notificationRetry).not.toHaveBeenCalled();
  });
  it('keeps lost reads and unexpected exceptions closed', async () => {
    vi.mocked(api.reserveNotificationRetry).mockResolvedValue(problem(503));
    vi.mocked(api.notificationRetry).mockResolvedValue(problem(503));
    expect((await action(form('reserve'))).data).toBeUndefined();
    vi.mocked(api.me).mockRejectedValue(new Error('PRIVATE'));
    expect(JSON.stringify(await action())).not.toContain('PRIVATE');
  });
});
describe('retry transport', () => {
  it('sends exact JSON and scope without a browser Origin or extra target fields', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(queued));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.reserveNotificationRetry(target, version, scope)).toEqual({
      ok: true,
      data: queued,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toMatch(new RegExp('/notifications/' + target + '/manual-retry$'));
    expect(init.method).toBe('POST');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(init.body)).toEqual({ version });
    expect(init.headers.get('x-solvi-form-scope')).toBe(scope);
    expect(init.headers.has('origin')).toBe(false);
  });
  it.each(['read', 'reserve'])(
    'turns cut response bodies into fixed 503 for %s',
    async (operation) => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('PRIVATE'));
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      const result =
        operation === 'read'
          ? await actualApi.notificationRetry(target)
          : await actualApi.reserveNotificationRetry(target, version, scope);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.status).toBe(503);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );
  it('rejects invalid DTO and never sends an invalid ID', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...dto(), recipient: 'private' }));
    vi.stubGlobal('fetch', fetch);
    const result = await actualApi.notificationRetry(target);
    expect(!result.ok && result.problem.status).toBe(502);
    await actualApi.notificationRetry('../private');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not interpret a not-requested response as a successful reservation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(dto())));
    const result = await actualApi.reserveNotificationRetry(target, version, scope);
    expect(!result.ok && result.problem.status).toBe(502);
  });
});
describe('row entry semantics', () => {
  it('reloads only the same finite status at its first page with a native anchor', () => {
    for (const status of ['all', 'pending', 'sent', 'failed']) {
      const firstHref = '/ops/notifications?status=' + status;
      const html = renderToStaticMarkup(createElement(NotificationRetryListRefresh, { firstHref }));
      expect(html).toContain('通知の状態と試行数は、一覧を更新すると反映されます。');
      expect(html).toContain(`<a href="${firstHref}">一覧を最新にする</a>`);
    }
  });
  it('never follows a free URL or preserves a stale cursor as the refresh target', () => {
    for (const firstHref of [
      'https://outside.invalid',
      '//outside.invalid',
      '/ops/notifications?status=all&cursor=stale',
      '/ops/notifications?status=private',
    ]) {
      expect(renderToStaticMarkup(createElement(NotificationRetryListRefresh, { firstHref }))).toBe(
        '',
      );
    }
  });
  it.each(['check_required', 'reserved', 'unavailable'] as const)(
    'renders fixed %s without pre-approving or disclosing identifiers',
    (summary) => {
      const html = renderToStaticMarkup(
        createElement(NotificationRetryForm, {
          summary,
          description: '合成通知・試行数1',
          action: vi.fn(),
          firstHref: '/ops/notifications?status=failed',
          children: createElement('td', {}, '問い合わせの受付'),
        }),
      );
      expect(html).toContain(
        summary === 'check_required'
          ? '再試行を確認'
          : summary === 'reserved'
            ? '予約状態を確認'
            : '手動再試行の対象外',
      );
      expect(html).not.toContain('再試行を予約');
      expect(html).not.toContain(target);
      expect(html).not.toContain(version);
    },
  );
});
