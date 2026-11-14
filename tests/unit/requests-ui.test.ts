// NFR-UX-002, NFR-UX-003, NFR-UX-004: bounded request-list recovery and state rendering.
// Browser/axe, actual identity, authorization and database evidence are separate.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  requireSession,
  type ServiceRequestSummary,
  type SessionView,
} from '../../apps/web/src/lib/api';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    serviceRequests: vi.fn(),
    submitRequest: vi.fn(),
    editRequest: vi.fn(),
    decideRequest: vi.fn(),
    simulateRequest: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  usePathname: () => '/requests',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
// Use the actual page and ContextLink; the web workspace checks TSX separately.
const { RequestForm } = await vi.importActual<
  typeof import('../../apps/web/src/components/RequestForms')
>('../../apps/web/src/components/RequestForms');
const { default: RequestsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/requests/page');
const { api: actualApi } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
type RequestList = Extract<Awaited<ReturnType<typeof api.serviceRequests>>, { ok: true }>['data'];
const org = '06100000-0000-4000-8000-000000000001';
const session: SessionView = {
  userId: '06100000-0000-4000-8000-000000000002',
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};
const item = (overrides: Partial<ServiceRequestSummary> = {}): ServiceRequestSummary => ({
  id: '06100000-0000-4000-8000-000000000003',
  number: 'REQ-061',
  title: '合成のサービス申請',
  state: 'pending',
  version: 1,
  requesterName: '合成申請者',
  approverName: '合成承認者',
  createdAt: '2026-10-08T01:00:00Z',
  updatedAt: '2026-10-08T02:00:00Z',
  expiresAt: '2026-10-11T01:00:00Z',
  decisionReason: null,
  own: true,
  assigned: false,
  expired: false,
  nextAction: '指名された承認者の判断を待ってください。',
  ticketId: '06100000-0000-4000-8000-000000000004',
  approvalState: 'pending',
  ...overrides,
});
const data = (overrides: Partial<RequestList> = {}): RequestList => ({
  items: [item()],
  total: 1,
  page: 1,
  pageSize: 25,
  appliedFilter: { q: '', state: 'all', view: 'all', page: 1 },
  ...overrides,
});
const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve(searchParams) }));
const link = (html: string, label: string) => {
  const match = [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].find(
    (entry) => entry[4] === label,
  );
  if (!match) throw new Error(`missing link: ${label}`);
  return {
    url: new URL((match[2] ?? '').replaceAll('&amp;', '&'), 'https://solvi.test'),
    native: !`${match[1]}${match[3]}`.includes('data-next-link'),
  };
};
const noWrites = () => {
  for (const action of [api.submitRequest, api.editRequest, api.decideRequest, api.simulateRequest])
    expect(action).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  navigation.params = new URLSearchParams();
  vi.mocked(requireSession).mockReset().mockResolvedValue(session);
  vi.mocked(api.serviceRequests).mockReset().mockResolvedValue({ ok: true, data: data() });
  for (const action of [api.submitRequest, api.editRequest, api.decideRequest, api.simulateRequest])
    vi.mocked(action).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('requester route display and submit gating (stage B)', () => {
  const routeItem = {
    id: '06100000-0000-4000-8000-000000000010',
    version: 1,
    title: 'UI016B 合成ルール項目',
    description: '',
    definition: {
      mode: 'local_simulation',
      targetLabel: '合成対象',
      allowedDurations: [1],
      maxReasonLength: 100,
      approval: { ruleId: '06100000-0000-4000-8000-000000000011' },
    },
  };
  const unresolved = {
    itemId: routeItem.id,
    itemVersion: 1,
    resolved: false,
    mode: 'rule',
    ruleRoutingEnabled: true,
    rule: { id: '06100000-0000-4000-8000-000000000011', code: 'ui016b-syn-test', revision: 2 },
    steps: [],
    reason: {
      code: 'manager_unset',
      message: '申請者の上長が未設定です。承認ルールの設定により申請を拒否しました',
      missing: 'manager',
      stepNo: 1,
      authorityType: 'manager',
    },
  };
  it('blocks submission with the API reason and no approver field for a rule item', () => {
    const html = renderToStaticMarkup(
      createElement(RequestForm, {
        item: routeItem as never,
        approvers: [],
        scope: 'org:user',
        route: unresolved as never,
      }),
    );
    expect(html).toContain('id="request-route-blocked"');
    expect(html).toContain('段1: 上長が設定されていないため、このままでは申請できません。');
    expect(html).not.toContain('承認ルールの設定により申請を拒否しました');
    expect(html).toContain('組織の管理者へ設定を依頼してください');
    expect(html).toContain('aria-describedby="request-route-blocked"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(html).not.toContain('name="approverId"');
    expect(html).not.toContain('id="request-approver"');
  });

  it('shows the resolved two steps and still sends no approverId', () => {
    const html = renderToStaticMarkup(
      createElement(RequestForm, {
        item: routeItem as never,
        approvers: [],
        scope: 'org:user',
        route: {
          ...unresolved,
          resolved: true,
          steps: [
            { stepNo: 1, authorityType: 'manager', approverName: '合成 上長' },
            { stepNo: 2, authorityType: 'fixed', approverName: '合成 承認者' },
          ],
          reason: undefined,
        } as never,
      }),
    );
    expect(html).toContain('段1（上長）');
    expect(html).toContain('合成 上長');
    expect(html).toContain('段2（固定承認者）');
    expect(html).toContain(
      '表示は申請前の見込みです。申請を送信した時点の設定で、承認者が確定します。承認の期限は各段72時間です。',
    );
    expect(html).not.toContain('API');
    expect(html).not.toContain('name="approverId"');
    expect(html).not.toContain('id="request-approver"');
    expect(html).not.toContain('aria-describedby="request-route-blocked"');
  });
});

describe('requests same-query GET and session boundary', () => {
  const selected = { q: 'VPN & 日本語', state: 'pending', view: 'mine', page: '3' };
  it.each([true, false])(
    'keeps allowed query values in fresh GET links (success=%s)',
    async (ok) => {
      if (!ok)
        vi.mocked(api.serviceRequests).mockResolvedValue({
          ok: false,
          problem: { status: 503, title: 'private' },
        });
      const html = await render({
        ...selected,
        organizationId: 'foreign',
        returnTo: 'https://outside.invalid',
        cursor: 'untrusted',
      });
      const refresh = link(html, ok ? '申請の状況を更新する' : '同じ条件で再取得する');
      expect(refresh.native).toBe(true);
      expect(refresh.url.pathname).toBe('/requests');
      expect([...refresh.url.searchParams]).toEqual(Object.entries(selected));
      expect(api.serviceRequests).toHaveBeenCalledExactlyOnceWith(
        new URLSearchParams(selected).toString(),
      );
      expect(html).not.toContain('outside.invalid');
      expect(html).not.toContain('foreign');
      noWrites();
    },
  );

  it('ignores multiple, empty and undefined values instead of accepting their first value', async () => {
    vi.mocked(api.serviceRequests).mockResolvedValue({
      ok: false,
      problem: { status: 503, title: 'private' },
    });
    const html = await render({
      q: ['first', 'second'],
      state: '',
      view: undefined,
      page: ['2', '3'],
    });
    expect(api.serviceRequests).toHaveBeenCalledExactlyOnceWith('');
    expect(link(html, '同じ条件で再取得する').url.pathname).toBe('/requests');
    expect(link(html, '同じ条件で再取得する').url.search).toBe('');
  });

  it('keeps rejected single-value conditions in retry and offers an explicit reset', async () => {
    vi.mocked(api.serviceRequests).mockResolvedValue({
      ok: false,
      problem: { status: 400, title: 'private' },
    });
    const selected = { state: 'unsupported', page: 'bad-page' };
    const html = await render(selected);
    expect([...link(html, '同じ条件で再取得する').url.searchParams]).toEqual(
      Object.entries(selected),
    );
    expect(link(html, '条件を解除する').url.pathname).toBe('/requests');
    expect(link(html, '条件を解除する').url.search).toBe('');
  });

  it('does not request data or write when requireSession redirects', async () => {
    const redirect = new Error('synthetic session redirect');
    vi.mocked(requireSession).mockRejectedValue(redirect);
    await expect(render()).rejects.toBe(redirect);
    expect(api.serviceRequests).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('requests fixed failure guidance', () => {
  it.each([
    [401, 'ログインの有効期限が切れた可能性があります。'],
    [403, 'この組織の申請一覧を表示する権限がありません。'],
    [404, '対象や機能が現在利用できない可能性があります。'],
    [400, '申請一覧の検索条件を確認できませんでした。'],
    [500, '申請一覧を取得できませんでした。'],
    [502, '申請一覧を取得できませんでした。'],
    [503, '申請一覧を取得できませんでした。'],
  ])(
    'shows fixed status %s guidance without rows, counts, raw problems or actions',
    async (status, message) => {
      const refused = {
        ok: false as const,
        problem: {
          status: Number(status),
          title: 'PRIVATE_TITLE',
          detail: 'PRIVATE_DETAIL',
          errors: [{ field: 'PRIVATE_FIELD', message: 'PRIVATE_ERROR' }],
        },
        data: data(),
      };
      vi.mocked(api.serviceRequests).mockResolvedValue(refused);
      const html = await render({ q: 'VPN', page: '2' });
      expect(html).toContain('<p role="alert">');
      expect(html).toContain(message);
      expect(link(html, 'ポータルへ戻る').url.pathname).toBe('/portal');
      expect(link(html, '同じ条件で再取得する').native).toBe(true);
      expect(html).not.toMatch(
        /PRIVATE_|表示対象|合成申請者|合成のサービス申請|<form|<button|<select|<ul|申請はありません/,
      );
      noWrites();
    },
  );
});

describe('requests applied filters, empty states and existing display', () => {
  it.each(['q', 'state', 'view'] as const)(
    'uses the applied %s condition for filtered-zero guidance',
    async (key) => {
      const appliedFilter = {
        ...data().appliedFilter,
        [key]: key === 'q' ? 'VPN' : key === 'state' ? 'pending' : 'mine',
      };
      vi.mocked(api.serviceRequests).mockResolvedValue({
        ok: true,
        data: data({ items: [], total: 0, appliedFilter }),
      });
      const html = await render();
      expect(html).toContain('絞り込み中 · 表示対象 0件');
      expect(html).toContain('条件に合う申請はありません。');
      expect(html).not.toContain('表示できる申請はまだありません。');
      if (key === 'q') expect(html).toContain('value="VPN"');
      else expect(html).toContain(`value="${appliedFilter[key]}" selected=""`);
    },
  );

  it('uses a normal zero state when raw URL filters were not applied by the API', async () => {
    vi.mocked(api.serviceRequests).mockResolvedValue({
      ok: true,
      data: data({ items: [], total: 0 }),
    });
    const html = await render({ q: 'ignored', state: 'pending', view: 'mine' });
    expect(html).toContain('表示できる申請はまだありません。カタログから申請できます。');
    expect(html).not.toContain('絞り込み中');
    expect(html).not.toContain('value="ignored"');
    expect(html).not.toContain('条件に合う申請はありません。');
  });

  it.each([1, 3])(
    'keeps a positive total separate from an empty current page %s and links to the first page',
    async (page) => {
      const appliedFilter = { q: 'VPN', state: 'pending', view: 'mine', page };
      vi.mocked(api.serviceRequests).mockResolvedValue({
        ok: true,
        data: data({ items: [], total: 26, page, appliedFilter }),
      });
      const html = await render({ ...appliedFilter, page: String(page) });
      expect(html).toContain('表示対象 26件');
      expect(html).toContain('このページに申請はありません。最初のページへ戻ってください。');
      expect([...link(html, '最初のページへ').url.searchParams]).toEqual([
        ['q', 'VPN'],
        ['state', 'pending'],
        ['view', 'mine'],
        ['page', '1'],
      ]);
      expect(html).not.toContain('条件に合う申請はありません。');
    },
  );

  it.each(['requester', 'approver', 'agent', 'org_admin', 'auditor'])(
    'shows the approvals view for %s without relying on the approver role',
    async (roleCode) => {
      vi.mocked(requireSession).mockResolvedValue({
        ...session,
        roles: [{ roleCode, organizationId: org }],
      });
      const html = await render();
      expect(html).toContain('<option value="approvals">自分が判断する承認待ち</option>');
      expect(html).toContain('<option value="mine">自分の申請</option>');
    },
  );

  it.each([
    ['pending', '承認待ち'],
    ['approved', '承認済み・模擬実行待ち'],
    ['rejected', '却下'],
    ['invalidated', '承認取消・再申請待ち'],
    ['completed', '模擬実行完了'],
    ['cancelled', '取消'],
  ])('preserves %s state, next action and simulation distinction', async (state, label) => {
    const request = item({
      state,
      decisionReason: '合成の判断理由',
      nextAction: 'APIが返した次の対応',
    });
    vi.mocked(api.serviceRequests).mockResolvedValue({
      ok: true,
      data: data({ items: [request] }),
    });
    const html = await render();
    expect(html).toContain(`<strong>${label}</strong>`);
    expect(html).toContain('APIが返した次の対応');
    expect(html).toContain('実際の権限・外部サービスは変更しません。');
    expect(html.includes('承認期限:')).toBe(['pending', 'approved'].includes(state));
    expect(html.includes('判断理由: 合成の判断理由')).toBe(
      ['rejected', 'invalidated'].includes(state),
    );
    noWrites();
  });

  it('preserves expired approval priority, requester ownership, order and actual ContextLink return state', async () => {
    const expired = item({ expired: true });
    const second = item({
      id: '06100000-0000-4000-8000-000000000005',
      title: '合成の次の申請',
      own: false,
    });
    const query = { q: 'VPN', state: 'pending', view: 'mine', page: '2' };
    navigation.params = new URLSearchParams(query);
    vi.mocked(api.serviceRequests).mockResolvedValue({
      ok: true,
      data: data({
        items: [expired, second],
        total: 51,
        page: 2,
        appliedFilter: { ...query, page: 2 },
      }),
    });
    const html = await render(query);
    expect(html).toContain('<strong>承認期限切れ・再承認が必要</strong>');
    expect(html).toContain('合成申請者（自分）');
    expect(html.indexOf(expired.title)).toBeLessThan(html.indexOf(second.title));
    const detail = link(html, expired.number + ' · ' + expired.title).url;
    expect(detail.pathname).toBe('/requests/' + expired.id);
    expect(detail.searchParams.get('returnTo')).toBe(
      '/requests?' + new URLSearchParams(query).toString(),
    );
    for (const [label, page] of [
      ['最初のページへ', '1'],
      ['前のページ', '1'],
      ['次のページ', '3'],
    ]) {
      expect([...link(html, label).url.searchParams]).toEqual(Object.entries({ ...query, page }));
    }
  });
});

describe('serviceRequests dedicated GET transport', () => {
  it('preserves GET, cookie, content type, no-store and successful data/set-cookie without aborting', async () => {
    const payload = data();
    const fetch = vi.fn().mockResolvedValue(
      Response.json(payload, {
        headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.serviceRequests('q=VPN&state=pending&view=mine&page=2')).toEqual({
      ok: true,
      data: payload,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname + new URL(url).search).toBe(
      '/service-requests?q=VPN&state=pending&view=mine&page=2',
    );
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('cookie')).toBe('solvi_session=synthetic-session');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([200, 401, 403, 404, 400, 500])(
    'preserves a received HTTP denial on body cut (%s)',
    async (status) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":'));
          controller.error(new Error('PRIVATE_BODY_SOURCE'));
        },
      });
      const response = new Response(body, { status });
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      expect(await actualApi.serviceRequests()).toEqual({
        ok: false,
        problem: { status: status === 200 ? 503 : status, title: '申請一覧を取得できませんでした' },
      });
      expect(read).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      const [, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal?.aborted).toBe(status !== 200);
    },
  );

  it.each([
    [401, 503],
    [403, 200],
    [404, 401],
    [400, 500],
    [503, 403],
  ])('uses HTTP %s instead of conflicting problem status %s', async (status, bodyStatus) => {
    const response = Response.json(
      {
        status: bodyStatus,
        title: 'PRIVATE_TITLE',
        detail: 'PRIVATE_DETAIL',
        errors: [{ message: 'PRIVATE_ERROR' }],
      },
      { status },
    );
    const read = vi.spyOn(response, 'text');
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.serviceRequests()).toEqual({
      ok: false,
      problem: { status, title: '申請一覧を取得できませんでした' },
    });
    expect(read).not.toHaveBeenCalled();
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it.each(['never-settles', 'rejects'] as const)(
    'aborts the GET without waiting for unread body cancellation (%s)',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'rejects'
          ? Promise.reject(new Error('PRIVATE_CANCEL_SOURCE'))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
      const read = vi.spyOn(response, 'text');
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          actualApi.serviceRequests(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('request list waited for unread body')),
              100,
            );
          }),
        ]);
        expect(result).toEqual({
          ok: false,
          problem: { status: 403, title: '申請一覧を取得できませんでした' },
        });
        const [, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(init.signal?.aborted).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  it('returns fixed network and invalid-JSON failures', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK_SOURCE'))
      .mockResolvedValueOnce(new Response('{invalid', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await actualApi.serviceRequests()).toEqual({
      ok: false,
      problem: { status: 503, title: '申請一覧を取得できませんでした' },
    });
    expect(await actualApi.serviceRequests()).toEqual({
      ok: false,
      problem: { status: 502, title: '応答を読み取れませんでした' },
    });
  });

  it('keeps successful 204/set-cookie compatibility', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'synthetic_refresh=updated; HttpOnly' },
        }),
      ),
    );
    expect(await actualApi.serviceRequests()).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic_refresh=updated; HttpOnly',
    });
  });
});
