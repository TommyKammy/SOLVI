// NFR-UX-002, NFR-UX-003, NFR-UX-004: real request page and dedicated GET recovery.
// RequestForms are display probes only; live authorization and all writes are separate gates.
import React, { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  api,
  requireSession,
  type ServiceRequestDetail,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { RequestForm, RequestActions } from '../../apps/web/src/components/RequestForms';

const jar = vi.hoisted(() => ({ values: [{ name: 'solvi_session', value: 'synthetic' }] }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { requestDetail: vi.fn(), serviceRequest: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ getAll: () => jar.values })) }));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
}));
vi.mock('../../apps/web/src/components/RequestForms', () => ({
  RequestForm: vi.fn(() => createElement('form', { 'data-edit-probe': 'true' })),
  RequestActions: vi.fn(
    ({
      canApprove,
      canRevoke,
      canSimulate,
    }: {
      canApprove: boolean;
      canRevoke: boolean;
      canSimulate: boolean;
    }) =>
      createElement('div', {
        'data-approve': String(canApprove),
        'data-revoke': String(canRevoke),
        'data-simulate': String(canSimulate),
      }),
  ),
}));
const { default: Page } = await vi.importActual<{
  default: (p: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/requests/[id]/page');
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '07300000-0000-4000-8000-000000000004';
const org = '07300000-0000-4000-8000-000000000001';
const owner = '07300000-0000-4000-8000-000000000002';
const approver = '07300000-0000-4000-8000-000000000003';
const definition: ServiceRequestDetail['request']['snapshot']['item']['definition'] = {
  mode: 'local_simulation',
  targetLabel: '合成対象',
  allowedDurations: [1, 7, 30],
  maxReasonLength: 2000,
  fields: [],
};
const detail: ServiceRequestDetail = {
  requesterName: '合成申請者',
  approverName: '合成承認者',
  request: {
    id,
    state: 'pending',
    version: 2,
    revision: 1,
    requesterId: owner,
    ticketId: '07300000-0000-4000-8000-000000000005',
    snapshotHash: 'synthetic-request-hash',
    snapshot: {
      requesterId: owner,
      item: { id, version: 3, title: '合成申請', definition },
      inputs: { reason: '合成理由', durationDays: 7, values: {} },
    },
  },
  approval: {
    id,
    state: 'pending',
    approver_id: approver,
    expires_at: '2100-01-01T00:00:00Z',
    reason: null,
  },
  approvers: [{ id: approver, name: '合成承認者' }],
  history: [
    {
      id,
      state: 'pending',
      revision: 1,
      approverId: approver,
      approverName: '合成承認者',
      item: { version: 3, definition },
      inputs: { reason: '合成理由', durationDays: 7 },
      reason: null,
      decidedAt: null,
      expiresAt: '2100-01-01T00:00:00Z',
    },
  ],
  receipt: null,
};
const session: SessionView = {
  userId: owner,
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};
const render = async (query: Record<string, string | string[] | undefined> = {}, target = id) =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id: target }), searchParams: Promise.resolve(query) }),
  );
const links = (html: string) =>
  [...html.matchAll(/href="([^"]+)"[^>]*>([^<]+)/g)].map((m) => ({
    href: m[1].replaceAll('&amp;', '&'),
    label: m[2],
  }));
const link = (html: string, label: string) => links(html).find((x) => x.label === label)?.href;
const fail = (status: number) =>
  vi.mocked(api.requestDetail).mockResolvedValue({
    ok: false,
    problem: {
      status,
      title: 'PRIVATE_TITLE',
      detail: 'PRIVATE_DETAIL',
      errors: [{ field: 'PRIVATE_FIELD', message: 'PRIVATE_MESSAGE' }],
    },
  });
const fixed = (status: number) =>
  status === 400
    ? '申請を指定する情報が正しくありません。申請一覧から選び直してください。'
    : status === 401
      ? 'ログイン状態を確認できませんでした。ログインし直してから、もう一度お試しください。'
      : status === 403
        ? 'この申請を表示する権限がありません。選択中の組織を確認するか、管理者にご相談ください。'
        : '一時的に申請を読み込めませんでした。時間をおいて、もう一度お試しください。';
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.requestDetail).mockResolvedValue(structuredClone({ ok: true, data: detail }));
  jar.values = [{ name: 'solvi_session', value: 'synthetic' }];
});
afterEach(() => vi.unstubAllGlobals());
describe('request detail page recovery and unchanged success', () => {
  it('requires session before read and performs no read after refusal', async () => {
    vi.mocked(requireSession).mockRejectedValueOnce(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.requestDetail).not.toHaveBeenCalled();
    expect(RequestForm).not.toHaveBeenCalled();
    expect(RequestActions).not.toHaveBeenCalled();
    await render();
    expect(vi.mocked(requireSession).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(api.requestDetail).mock.invocationCallOrder[0],
    );
    expect(api.serviceRequest).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 409, 429, 500, 502, 503])(
    'shows fixed %s guidance without internal data or writes',
    async (status) => {
      fail(status);
      const html = await render({ saved: '1' });
      expect(html).toContain('<h1>申請を読み込めませんでした</h1>');
      expect(html).toContain('<p role="alert">' + fixed(status));
      for (const text of [
        'PRIVATE_',
        id,
        '合成申請者',
        '合成理由',
        '<form',
        '<input',
        '<dl',
        '<details',
        '保存しました',
      ])
        expect(html.replaceAll('/requests/' + id, '')).not.toContain(text);
      expect(link(html, '再取得する')).toBe('/requests/' + id);
      expect(link(html, '申請一覧へ戻る')).toBe('/requests');
      expect(link(html, 'ポータルへ戻る')).toBe('/portal');
      expect(RequestForm).not.toHaveBeenCalled();
      expect(RequestActions).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
  it('keeps 404 as notFound', async () => {
    fail(404);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(redirect).not.toHaveBeenCalled();
  });
  it('keeps only normalized single returnTo on retry', async () => {
    fail(503);
    const from = '/requests?q=合成&state=pending&view=mine&page=2&saved=1';
    const html = await render({
      returnTo: from,
      saved: '1',
      created: '1',
      updated: '1',
      unknown: 'private',
    });
    const href = link(html, '再取得する')!;
    const url = new URL(href, 'https://solvi.local');
    expect(url.pathname).toBe('/requests/' + id);
    expect([...url.searchParams.keys()]).toEqual(['returnTo']);
    expect(url.searchParams.get('returnTo')).toBe(
      '/requests?q=%E5%90%88%E6%88%90&state=pending&view=mine&page=2',
    );
    expect(link(html, '元の画面へ戻る')).toBe(url.searchParams.get('returnTo'));
  });
  it.each([
    undefined,
    'https://evil.test',
    '//evil.test',
    '/login',
    '/requests\\evil',
    '/requests x',
    '/requests\n',
  ])('drops unsafe parent %j', async (returnTo) => {
    fail(503);
    const html = await render({ returnTo });
    expect(link(html, '再取得する')).toBe('/requests/' + id);
    expect(link(html, '申請一覧へ戻る')).toBe('/requests');
  });
  it('drops a repeated returnTo array', async () => {
    fail(503);
    const html = await render({ returnTo: ['/requests', '/inbox'] });
    expect(link(html, '再取得する')).toBe('/requests/' + id);
    expect(link(html, '申請一覧へ戻る')).toBe('/requests');
  });
  it('keeps safe parent but offers no retry for invalid UUID', async () => {
    fail(400);
    const html = await render({ returnTo: '/inbox' }, 'invalid');
    expect(link(html, '再取得する')).toBeUndefined();
    expect(link(html, '元の画面へ戻る')).toBe('/inbox');
  });
  it.each([
    ['owner', owner, 'requester', 'pending', false, true, false, false, false],
    ['approver', approver, 'approver', 'pending', false, false, true, false, false],
    ['agent', 'staff', 'agent', 'approved', false, false, false, false, true],
    ['admin', 'admin', 'org_admin', 'approved', false, false, false, true, true],
    ['expired-pending', approver, 'approver', 'pending', true, false, false, false, false],
    ['expired-approved', 'staff', 'agent', 'approved', true, false, false, false, false],
    ['completed', owner, 'requester', 'completed', false, false, false, false, false],
    ['cancelled', owner, 'requester', 'cancelled', false, false, false, false, false],
  ])(
    'preserves %s display conditions',
    async (_name, userId, roleCode, state, expired, edit, approve, revoke, simulate) => {
      const data = structuredClone(detail);
      data.request.state = state as string;
      if (expired) data.approval.expires_at = '2000-01-01T00:00:00Z';
      vi.mocked(api.requestDetail).mockResolvedValue({ ok: true, data });
      vi.mocked(requireSession).mockResolvedValue({
        ...session,
        userId: userId as string,
        roles: [{ roleCode: roleCode as string, organizationId: org }],
      });
      const html = await render({ saved: '1' });
      expect(html).toContain('<h1>合成申請</h1>');
      expect(html).toContain('合成理由');
      expect(html).toContain('カタログ定義版: 3');
      expect(html).toContain('申請の状態を保存しました。');
      expect(RequestForm).toHaveBeenCalledTimes(edit ? 1 : 0);
      expect(vi.mocked(RequestActions).mock.calls[0][0]).toMatchObject({
        request: data,
        canApprove: approve,
        canRevoke: revoke,
        canSimulate: simulate,
      });
      if (expired) expect(html).toContain('期限切れ。変更・再承認が必要です');
    },
  );
  it('preserves completed receipt and history while hiding edit', async () => {
    const data = structuredClone(detail);
    data.request.state = 'completed';
    data.receipt = {
      id,
      simulation: true,
      result: {
        status: 'completed',
        summary: '合成結果',
        targetLabel: '合成対象',
        durationDays: 7,
        externalChanges: 0,
      },
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      snapshotHash: 'synthetic-receipt-hash',
      idempotencyKey: 'synthetic-key',
    };
    vi.mocked(api.requestDetail).mockResolvedValue({ ok: true, data });
    const html = await render();
    for (const text of [
      '合成結果',
      '合成対象',
      'synthetic-receipt-hash',
      'synthetic-key',
      '承認の記録',
    ])
      expect(html).toContain(text);
    expect(RequestForm).not.toHaveBeenCalled();
  });
});
describe('request detail dedicated UUID GET transport', () => {
  it.each([
    '',
    'bad',
    '../requests',
    id + '?x=1',
    id + '#x',
    '{' + id + '}',
    id.replaceAll('-', ''),
    '/' + id,
  ])('rejects invalid UUID %s before cookies/fetch', async (value) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await reader.requestDetail(value);
    expect(result).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(fetch).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
  });
  it('rejects non-string ID before cookies/fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await reader.requestDetail(null as unknown as string)).toMatchObject({
      ok: false,
      problem: { status: 400 },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
  });
  it.each([id, id.toUpperCase(), 'ffffffff-ffff-ffff-ffff-ffffffffffff'])(
    'preserves backend UUID acceptance %s and fixed cookie GET',
    async (target) => {
      const fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'set-cookie': 'synthetic=1' },
        }),
      );
      vi.stubGlobal('fetch', fetch);
      expect(await reader.requestDetail(target)).toMatchObject({
        ok: true,
        data: detail,
        setCookie: 'synthetic=1',
      });
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(
        (process.env.API_BASE_URL ?? 'http://api:3001') +
          '/service-requests/' +
          encodeURIComponent(target),
      );
      expect(init.cache).toBe('no-store');
      expect(init.method).toBeUndefined();
      expect(init.headers.get('cookie')).toBe('solvi_session=synthetic');
      expect(init.signal.aborted).toBe(false);
    },
  );
  it('omits missing cookie', async () => {
    jar.values = [];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail)));
    vi.stubGlobal('fetch', fetch);
    await reader.requestDetail(id);
    expect(fetch.mock.calls[0][1].headers.has('cookie')).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 429, 500, 503])(
    'keeps HTTP %s without reading a contradictory/refused body',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('PRIVATE_BODY'));
      const json = vi.fn();
      const fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status, text, json, headers: new Headers() });
      vi.stubGlobal('fetch', fetch);
      expect(await reader.requestDetail(id)).toMatchObject({ ok: false, problem: { status } });
      expect(text).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    },
  );
  it.each(['network', 'cut'])('classifies %s as fixed 503', async (mode) => {
    const fetch =
      mode === 'network'
        ? vi.fn().mockRejectedValue(new Error('PRIVATE'))
        : vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: vi.fn().mockRejectedValue(new Error('PRIVATE')),
          });
    vi.stubGlobal('fetch', fetch);
    expect(await reader.requestDetail(id)).toMatchObject({
      ok: false,
      problem: { status: 503, title: '申請を取得できませんでした' },
    });
  });
  it('classifies invalid JSON as 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{private')));
    expect(await reader.requestDetail(id)).toMatchObject({ ok: false, problem: { status: 502 } });
  });
  it('preserves empty body object and 204 transport', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(
        new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic=1' } }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await reader.requestDetail(id)).toEqual({ ok: true, data: {} });
    expect(await reader.requestDetail(id)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=1',
    });
  });
  it.each([401, 403, 404])(
    'propagates truncated denied HTTP %s to page without reinterpretation',
    async (status) => {
      const fetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        headers: new Headers(),
        text: vi.fn().mockRejectedValue(new Error('CUT')),
      });
      vi.stubGlobal('fetch', fetch);
      vi.mocked(api.requestDetail).mockImplementation((target) => reader.requestDetail(target));
      if (status === 404) await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
      else {
        const html = await render();
        expect(html).toContain(fixed(status));
        expect(redirect).not.toHaveBeenCalled();
      }
    },
  );
});
