// NFR-UX-002, NFR-UX-003, NFR-UX-004: real change page and dedicated GET recovery.
// Command/plan forms are render probes here; real forms/axe use the separate Next harness.
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  api,
  requireSession,
  type ChangeDetail,
  type SessionView,
} from '../../apps/web/src/lib/api';
import { ChangeCommandForm, ChangePlanForm } from '../../apps/web/src/components/ChangeForms';
import { notFound, redirect } from 'next/navigation';
const jar = vi.hoisted(() => ({ calls: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    jar.calls++;
    return { getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] };
  },
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    changeDetail: vi.fn(),
    change: vi.fn(),
    changeOptions: vi.fn(),
    changeFormOptions: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('../../apps/web/src/components/ChangeForms', () => ({
  ChangeCommandForm: vi.fn(({ kind }: { kind: string }) =>
    createElement('form', { 'data-command-probe': kind }),
  ),
  ChangePlanForm: vi.fn(() => createElement('form', { 'data-plan-probe': true })),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  usePathname: () => '/changes/07400000-0000-4000-8000-000000000004',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': true }),
}));
type Query = Record<string, string | string[] | undefined>;
const { default: Page } = await vi.importActual<{
  default: (p: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Query>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/changes/[id]/page');
const { default: EditPage } = await vi.importActual<{
  default: (p: { params: Promise<{ id: string }> }) => Promise<ReactNode>;
}>('../../apps/web/src/app/changes/[id]/edit/page');
const { api: reader } = await vi.importActual<typeof import('../../apps/web/src/lib/api')>(
  '../../apps/web/src/lib/api',
);
const id = '07400000-0000-4000-8000-000000000004';
const org = '07400000-0000-4000-8000-000000000001';
const user = '07400000-0000-4000-8000-000000000002';
const session: SessionView = {
  userId: user,
  organizationId: org,
  roles: [{ roleCode: 'agent', organizationId: org }],
};
const plan: ChangeDetail['change']['snapshot'] = {
  type: 'normal',
  title: '合成の変更計画',
  purpose: '合成の目的',
  impact: '合成の影響',
  risk: 'low',
  implementationPlan: '合成の実施計画',
  testPlan: '合成のテスト計画',
  backoutPlan: '合成の切戻し計画',
  plannedStart: '2100-10-10T00:00:00Z',
  plannedEnd: '2100-10-10T01:00:00Z',
  ticket: {
    id: '07400000-0000-4000-8000-000000000010',
    number: 'TKT-074',
    subject: '合成の元チケット',
  },
  assets: [
    {
      id: '07400000-0000-4000-8000-000000000020',
      assetTag: 'AST-074',
      name: '合成の対象資産',
      kind: 'pc',
      state: 'in_use',
      version: 3,
    },
  ],
  owner: { id: user, name: '合成担当者' },
  approver: { id: '07400000-0000-4000-8000-000000000003', name: '合成承認者' },
};
const detail: ChangeDetail = {
  change: {
    id,
    number: 'CHG-074',
    title: plan.title,
    type: 'normal',
    state: 'draft',
    version: 7,
    revision: 2,
    plannedStart: plan.plannedStart,
    plannedEnd: plan.plannedEnd,
    ownerName: plan.owner.name,
    ticket: plan.ticket,
    assets: plan.assets,
    updatedAt: '2026-10-10T00:00:00Z',
    snapshot: plan,
    snapshotHash: 'a'.repeat(64),
    currentApprovalId: null,
    createdBy: user,
    startedAt: null,
  },
  canManage: true,
  availableActions: ['edit', 'submit', 'cancel'],
  readiness: { issues: [], withinWindow: false, now: '2026-10-10T00:00:00Z' },
  ticketCanOpen: true,
  assetAccess: [{ id: plan.assets[0].id, canOpen: true }],
  result: null,
  pir: null,
  conflicts: [],
  approvals: [],
  revisions: [
    {
      revision: 2,
      snapshot: plan,
      snapshotHash: 'a'.repeat(64),
      reason: '合成の版理由',
      createdAt: '2026-10-10T00:00:00Z',
      actorName: '合成担当者',
    },
  ],
  history: [
    {
      version: 7,
      revision: 2,
      action: 'edit',
      beforeState: 'draft',
      afterState: 'draft',
      reason: '合成の操作理由',
      createdAt: '2026-10-10T00:00:00Z',
      actorName: '合成担当者',
    },
  ],
};
const render = async (query: Query = {}, target = id) =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id: target }), searchParams: Promise.resolve(query) }),
  );
const links = (html: string) =>
  [...html.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: m[2].replaceAll('&amp;', '&'),
    label: m[4],
    native: !`${m[1]}${m[3]}`.includes('data-next-link'),
  }));
const fail = (status: number) =>
  vi.mocked(api.changeDetail).mockResolvedValue({
    ok: false,
    problem: { status, title: 'PRIVATE_PROBLEM', detail: 'PRIVATE_DETAIL' },
  });
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  jar.calls = 0;
  vi.mocked(requireSession).mockResolvedValue(session);
  vi.mocked(api.changeDetail).mockResolvedValue({ ok: true, data: detail });
  vi.mocked(api.change).mockResolvedValue({ ok: true, data: detail });
  vi.mocked(api.changeOptions).mockResolvedValue({
    ok: true,
    data: { owners: [], approvers: [], assets: [], tickets: [] },
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('change detail page recovery and preserved success', () => {
  it('requires a session before GET and never reads after session refusal', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Error('SESSION_DENIED'));
    await expect(render()).rejects.toThrow('SESSION_DENIED');
    expect(api.changeDetail).not.toHaveBeenCalled();
  });
  it.each([403, 404])('conceals HTTP %i through the original notFound', async (status) => {
    fail(status);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
    expect(redirect).not.toHaveBeenCalled();
  });
  it.each([400, 401, 500, 502, 503])(
    'uses fixed recovery text for HTTP %i without redirect',
    async (status) => {
      fail(status);
      const html = await render({ saved: '1', created: '1', unknown: 'PRIVATE_QUERY' });
      expect(html).toContain('変更を読み込めませんでした');
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        status === 400
          ? '一覧から選び直してください'
          : status === 401
            ? 'ログイン状態を確認できませんでした'
            : '時間をおいて、もう一度お試しください',
      );
      for (const value of [
        'PRIVATE',
        'CHG-074',
        '合成の目的',
        '<form',
        '<input',
        '変更と履歴を保存しました',
      ])
        expect(html).not.toContain(value);
      expect(redirect).not.toHaveBeenCalled();
      expect(notFound).not.toHaveBeenCalled();
      expect(api.change).not.toHaveBeenCalled();
      expect(ChangeCommandForm).not.toHaveBeenCalled();
      expect(links(html).find((l) => l.label === '再取得する')).toEqual({
        href: '/changes/' + id,
        label: '再取得する',
        native: true,
      });
    },
  );
  it('normalizes only single safe returnTo and drops top-level flash and unknown query', async () => {
    fail(503);
    const html = await render({
      returnTo: '/changes?state=review&page=2&saved=1#list',
      saved: '1',
      created: '1',
      updated: '1',
      unknown: 'PRIVATE',
    });
    const retry = new URL(
      links(html).find((l) => l.label === '再取得する')!.href,
      'https://solvi.local',
    );
    expect([...retry.searchParams.keys()]).toEqual(['returnTo']);
    expect(retry.searchParams.get('returnTo')).toBe('/changes?state=review&page=2#list');
    expect(links(html).find((l) => l.label === '元の画面へ戻る')?.href).toBe(
      retry.searchParams.get('returnTo'),
    );
  });
  it.each(['https://evil.invalid', '//evil.invalid', '/admin', ['/changes', '/portal']])(
    'rejects unsafe/multiple returnTo %j',
    async (from) => {
      fail(503);
      const html = await render({ returnTo: from });
      expect(links(html).find((l) => l.label === '再取得する')?.href).toBe('/changes/' + id);
      expect(links(html).find((l) => l.label === '変更一覧へ戻る')?.href).toBe('/changes');
      expect(links(html).find((l) => l.label === 'ポータルへ戻る')?.href).toBe('/portal');
    },
  );
  it.each([
    '/portal',
    '/inbox?kind=change',
    '/ops',
    '/requests',
    '/assets?kind=pc',
    '/knowledge',
    '/tickets/' + plan.ticket.id,
  ])('keeps allowed return destination %s', async (from) => {
    fail(503);
    const html = await render({ returnTo: from });
    expect(links(html).find((l) => l.label === '元の画面へ戻る')?.href).toBe(from);
  });
  it.each(['', '.', '..', 'bad', id.replaceAll('-', ''), '{' + id + '}', '\ud800'])(
    'offers no retry for invalid UUID %j',
    async (target) => {
      fail(400);
      const html = await render({}, target);
      expect(links(html).some((l) => l.label === '再取得する')).toBe(false);
      expect(html).toContain('変更一覧へ戻る');
    },
  );
  it.each(['draft', 'review', 'readonly', 'scheduled', 'completed'])(
    'preserves successful %s state and command props',
    async (view) => {
      const d = structuredClone(detail);
      d.availableActions =
        view === 'draft'
          ? ['edit', 'submit', 'cancel']
          : view === 'review'
            ? ['approve', 'reject']
            : view === 'scheduled'
              ? ['edit', 'cancel']
              : [];
      d.change.state = view === 'readonly' ? 'review' : view;
      d.change.currentApprovalId = view === 'draft' ? null : '07400000-0000-4000-8000-000000000030';
      d.canManage = ['draft', 'scheduled'].includes(view);
      d.ticketCanOpen = view !== 'review';
      d.assetAccess[0].canOpen = view !== 'review';
      if (view === 'review')
        vi.mocked(requireSession).mockResolvedValue({
          ...session,
          roles: [{ roleCode: 'approver', organizationId: org }],
        });
      if (view === 'readonly')
        vi.mocked(requireSession).mockResolvedValue({
          ...session,
          roles: [{ roleCode: 'auditor', organizationId: org }],
        });
      if (view === 'completed') {
        d.result = {
          id: 'result',
          revision: 2,
          approvalId: 'approval',
          snapshotHash: d.change.snapshotHash,
          outcome: 'completed',
          summary: '合成の実施結果',
          testResults: '合成のテスト結果',
          backoutPerformed: false,
          backoutReason: '合成の切戻し判断',
          simulation: true,
          externalChanges: 0,
          startedAt: '2026-10-10T01:00:00Z',
          finishedAt: '2026-10-10T02:00:00Z',
          actorName: '合成担当者',
        };
        d.pir = {
          id: 'pir',
          rootCause: '合成の振り返り',
          lessons: '合成の教訓',
          prevention: '合成の再発防止',
          createdAt: '2026-10-10T03:00:00Z',
          actorName: '合成担当者',
        };
      }
      vi.mocked(api.changeDetail).mockResolvedValue({ ok: true, data: d });
      const html = await render({ saved: '1' });
      for (const text of [
        'CHG-074',
        '合成の目的',
        '承認の履歴',
        '操作の履歴',
        '変更と履歴を保存しました',
      ])
        expect(html).toContain(text);
      expect(html).not.toContain('変更を読み込めませんでした');
      expect(api.change).not.toHaveBeenCalled();
      expect(vi.mocked(requireSession).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(api.changeDetail).mock.invocationCallOrder[0],
      );
      const commands = vi.mocked(ChangeCommandForm).mock.calls.map(([p]) => p);
      expect(commands.map((p) => p.kind)).toEqual(d.availableActions.filter((a) => a !== 'edit'));
      for (const p of commands) {
        expect(p.detail).toEqual(d);
        expect(z.string().uuid().safeParse(p.commandKey).success).toBe(true);
      }
      if (view === 'review') {
        expect(html).toContain('あなたが指名された承認者');
        expect(html).not.toContain('href="/tickets/');
        expect(html).not.toContain('href="/assets/');
      }
      if (view === 'scheduled') expect(html).toContain('予定期間になると開始を記録できます');
      if (view === 'completed') {
        expect(html).toContain('保存した実施結果');
        expect(html).toContain('実施後レビュー（PIR）');
        expect(html).toContain('合成の教訓');
      }
    },
  );
  it('adopts the existing readers on edit and passes plan props unchanged', async () => {
    const options = { owners: [], approvers: [], assets: [], tickets: [] };
    vi.mocked(api.changeFormOptions).mockResolvedValue({ ok: true, data: options });
    const html = renderToStaticMarkup(
      await EditPage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({}),
      } as { params: Promise<{ id: string }> }),
    );
    expect(html).toContain('計画を見直す');
    expect(api.changeDetail).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.changeFormOptions).toHaveBeenCalledExactlyOnceWith(
      new URLSearchParams({
        ticketId: detail.change.ticket.id,
        assetIds: detail.change.assets.map((a) => a.id).join(','),
      }).toString(),
    );
    expect(api.change).not.toHaveBeenCalled();
    expect(api.changeOptions).not.toHaveBeenCalled();
    expect(ChangePlanForm).toHaveBeenCalled();
    const props = vi.mocked(ChangePlanForm).mock.calls[0][0];
    expect(props.current).toBe(detail.change);
    expect(props.options).toBe(options);
    expect(props.userId).toBe(session.userId);
    for (const key of ['creationKey', 'commandKey'] as const)
      expect(props[key]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
describe('change dedicated GET and backend-compatible UUID boundary', () => {
  it.each([
    '',
    '.',
    '..',
    'bad',
    id.replaceAll('-', ''),
    '{' + id + '}',
    '\ud800',
    null,
    undefined,
  ])('rejects invalid %j without cookies/fetch', async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(z.string().uuid().safeParse(input).success).toBe(false);
    expect(await reader.changeDetail(input as string)).toMatchObject({
      ok: false,
      problem: { status: 400 },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(jar.calls).toBe(0);
  });
  it.each([
    id,
    id.toUpperCase(),
    'abcdefab-cdef-0000-0000-abcdefabcdef',
    '07400000-0000-ffff-ffff-000000000004',
  ])('keeps backend accepted UUID %s and fixed GET', async (input) => {
    expect(z.string().uuid().safeParse(input).success).toBe(true);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(detail), { headers: { 'set-cookie': 'synthetic=renewed' } }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await reader.changeDetail(input)).toEqual({
      ok: true,
      data: detail,
      setCookie: 'synthetic=renewed',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/changes/' + encodeURIComponent(input));
    expect(init.cache).toBe('no-store');
    expect(init.headers.get('cookie')).toBe('solvi_session=synthetic-session');
    expect(init.signal.aborted).toBe(false);
  });
  it.each([400, 401, 403, 404, 500, 503])(
    'retains HTTP %i with unread conflicting/refused body and synchronous abort',
    async (status) => {
      const text = vi.fn().mockRejectedValue(new Error('BODY_CUT'));
      const cancel = vi.fn(() => new Promise(() => {}));
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          signal = init.signal;
          return { ok: false, status, text, body: { cancel }, headers: new Headers() };
        }),
      );
      expect(await reader.changeDetail(id)).toMatchObject({ ok: false, problem: { status } });
      expect(text).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(true);
    },
  );
  it.each(['network', 'body-cut'])('maps %s to fixed 503', async (mode) => {
    vi.stubGlobal(
      'fetch',
      mode === 'network'
        ? vi.fn().mockRejectedValue(new Error('PRIVATE'))
        : vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: vi.fn().mockRejectedValue(new Error('PRIVATE')),
          }),
    );
    expect(await reader.changeDetail(id)).toMatchObject({ ok: false, problem: { status: 503 } });
  });
  it('maps invalid successful JSON to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{')));
    expect(await reader.changeDetail(id)).toMatchObject({ ok: false, problem: { status: 502 } });
  });
  it('preserves 204 without consuming a body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 204, headers: { 'set-cookie': 'synthetic=renewed' } }),
        ),
    );
    expect(await reader.changeDetail(id)).toEqual({
      ok: true,
      data: undefined,
      setCookie: 'synthetic=renewed',
    });
  });
});
