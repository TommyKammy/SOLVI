// WP-P4-APR-018 段階B: 承認者不在の申請の再割当(画面)。
// ここで固定するのは表示と純関数だけである。認可・状態の判定・書込みはAPIのテスト
// (tests/security/approval-reassign.test.ts)が担う。ブラウザ/axe は未実施。
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import { formatDateTime } from '../../apps/web/src/lib/labels';
import {
  REASSIGN_REASON_TEXT,
  reassignmentFailureText,
  reassignmentRecords,
  reassignmentSuccessText,
} from '../../apps/web/src/lib/approval-route';
import {
  api,
  requireSession,
  type ServiceRequestDetail,
  type ServiceRequestSummary,
  type SessionView,
} from '../../apps/web/src/lib/api';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    approvalRules: vi.fn(),
    approvalRouting: vi.fn(),
    listMembers: vi.fn(),
    catalogAdmin: vi.fn(),
    serviceRequests: vi.fn(),
    requestDetail: vi.fn(),
    reassignRequest: vi.fn(),
    me: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] }),
}));
const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => '/ops/approvals',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('../../apps/web/src/components/RequestForms', () => ({
  RequestForm: () => null,
  RequestActions: () => null,
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
  ReturnToField: () => null,
}));

const { default: ApprovalsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/ops/approvals/page');
const { default: RequestPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/requests/[id]/page');
const { reassignApprovalAction } = await vi.importActual<
  typeof import('../../apps/web/src/app/ops/approvals/actions')
>('../../apps/web/src/app/ops/approvals/actions');

const org = '08100000-0000-4000-8000-000000000001';
const adminId = '08100000-0000-4000-8000-000000000002';
const requesterId = '08100000-0000-4000-8000-000000000003';
const requestId = '08100000-0000-4000-8000-000000000004';
const approverA = '08100000-0000-4000-8000-000000000006';
const approverB = '08100000-0000-4000-8000-000000000007';
const approverC = '08100000-0000-4000-8000-000000000008';

const adminSession: SessionView = {
  userId: adminId,
  organizationId: org,
  roles: [{ roleCode: 'org_admin', organizationId: org }],
};
const requesterSession: SessionView = {
  userId: requesterId,
  organizationId: org,
  roles: [{ roleCode: 'requester', organizationId: org }],
};

const definition: ServiceRequestDetail['request']['snapshot']['item']['definition'] = {
  mode: 'local_simulation',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  fields: [],
};

const summary = (overrides: Partial<ServiceRequestSummary> = {}): ServiceRequestSummary => ({
  id: requestId,
  number: 'REQ-081',
  title: '合成の申請',
  state: 'pending',
  version: 2,
  requesterName: '合成申請者',
  approverName: '合成承認者',
  createdAt: '2026-11-10T00:00:00Z',
  updatedAt: '2026-11-10T01:00:00Z',
  expiresAt: '2026-11-13T00:00:00Z',
  decisionReason: null,
  own: false,
  assigned: false,
  expired: false,
  nextAction: '承認者が不在です。',
  ticketId: '08100000-0000-4000-8000-000000000009',
  approvalState: 'pending',
  approverUnavailable: true,
  ...overrides,
});

const detail = (overrides: Partial<ServiceRequestDetail> = {}): ServiceRequestDetail => ({
  requesterName: '合成申請者',
  approverName: '合成 上長3',
  request: {
    id: requestId,
    state: 'pending',
    version: 4,
    revision: 1,
    requesterId,
    ticketId: '08100000-0000-4000-8000-000000000009',
    snapshotHash: 'synthetic-request-hash',
    snapshot: {
      requesterId,
      item: { id: requestId, version: 1, title: '合成の申請', definition },
      inputs: { reason: '合成理由', durationDays: 7, values: {} },
    },
  },
  approval: {
    id: '08100000-0000-4000-8000-00000000000a',
    state: 'pending',
    approver_id: approverC,
    expires_at: '2100-01-01T00:00:00Z',
    reason: null,
  },
  approvers: [],
  receipt: null,
  // 現在の世代(3)の行だけ。段1は旧世代にあるため、有効な世代を使わないと欠ける。
  steps: [
    {
      id: '08100000-0000-4000-8000-00000000000b',
      stepNo: 2,
      state: 'pending',
      approverId: approverC,
      approverName: '合成 上長3',
      authorityType: 'manager',
      resolvedFrom: 'manager',
      reason: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: '2100-01-01T00:00:00Z',
      routeGeneration: 3,
    },
  ],
  effectiveSteps: [
    {
      id: '08100000-0000-4000-8000-00000000000c',
      stepNo: 1,
      state: 'approved',
      approverId: approverB,
      approverName: '合成 上長2',
      authorityType: 'fixed',
      resolvedFrom: 'fixed',
      reason: null,
      decidedAt: '2026-11-10T03:00:00Z',
      decidedBy: approverB,
      expiresAt: '2026-11-13T00:00:00Z',
      routeGeneration: 2,
    },
    {
      id: '08100000-0000-4000-8000-00000000000b',
      stepNo: 2,
      state: 'pending',
      approverId: approverC,
      approverName: '合成 上長3',
      authorityType: 'manager',
      resolvedFrom: 'manager',
      reason: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: '2100-01-01T00:00:00Z',
      routeGeneration: 3,
    },
  ],
  route: {
    steps: [
      {
        stepNo: 1,
        approverId: approverB,
        approverName: '合成 上長2',
        authorityType: 'fixed',
        resolvedFrom: 'fixed',
      },
      {
        stepNo: 2,
        approverId: approverC,
        approverName: '合成 上長3',
        authorityType: 'manager',
        resolvedFrom: 'manager',
      },
    ],
    ruleRef: { ruleId: 'rule-synthetic', revision: 1 },
  },
  currentRouteGeneration: 3,
  // わざと世代の順と時刻の順をずらし、画面が時刻で並べることを確かめる。
  routeGenerations: [
    {
      routeGeneration: 3,
      fromStepNo: 2,
      routeHash: 'hash-3',
      reason: '合成: 2回目の再割当 <script>alert("x")</script>',
      createdBy: adminId,
      createdByName: '合成 管理者',
      createdAt: '2026-11-11T02:00:00Z',
      newApproverName: '合成 上長3',
      invalidatedStepNo: 2,
      invalidatedApproverName: '合成 上長2',
    },
    {
      routeGeneration: 1,
      fromStepNo: 1,
      routeHash: 'hash-1',
      reason: null,
      createdBy: null,
      createdByName: null,
      createdAt: '2026-11-01T00:00:00Z',
      newApproverName: null,
      invalidatedStepNo: null,
      invalidatedApproverName: null,
    },
    {
      routeGeneration: 2,
      fromStepNo: 1,
      routeHash: 'hash-2',
      reason: '合成: 1回目の再割当',
      createdBy: adminId,
      createdByName: '合成 管理者',
      createdAt: '2026-11-10T01:00:00Z',
      newApproverName: '合成 上長2',
      invalidatedStepNo: 1,
      invalidatedApproverName: '合成 固定A',
    },
  ],
  history: [
    {
      id: '08100000-0000-4000-8000-00000000000d',
      state: 'invalidated',
      revision: 1,
      stepNo: 1,
      routeGeneration: 1,
      invalidatedByReassign: true,
      approverId: approverA,
      approverName: '合成 固定A',
      item: { version: 1, definition },
      inputs: { reason: '合成理由', durationDays: 7 },
      reason: '合成: 1回目の再割当',
      decidedAt: null,
      expiresAt: '2026-11-13T00:00:00Z',
    },
    {
      id: '08100000-0000-4000-8000-00000000000c',
      state: 'approved',
      revision: 1,
      stepNo: 1,
      routeGeneration: 2,
      invalidatedByReassign: false,
      approverId: approverB,
      approverName: '合成 上長2',
      item: { version: 1, definition },
      inputs: { reason: '合成理由', durationDays: 7 },
      reason: null,
      decidedAt: '2026-11-10T03:00:00Z',
      expiresAt: '2026-11-13T00:00:00Z',
    },
    {
      id: '08100000-0000-4000-8000-00000000000e',
      state: 'invalidated',
      revision: 1,
      stepNo: 2,
      routeGeneration: 1,
      invalidatedByReassign: true,
      approverId: approverB,
      approverName: '合成 上長2',
      item: { version: 1, definition },
      inputs: { reason: '合成理由', durationDays: 7 },
      reason: '合成: 2回目の再割当 <script>alert("x")</script>',
      decidedAt: null,
      expiresAt: '2026-11-13T00:00:00Z',
    },
    {
      id: '08100000-0000-4000-8000-00000000000b',
      state: 'pending',
      revision: 1,
      stepNo: 2,
      routeGeneration: 3,
      invalidatedByReassign: false,
      approverId: approverC,
      approverName: '合成 上長3',
      item: { version: 1, definition },
      inputs: { reason: '合成理由', durationDays: 7 },
      reason: null,
      decidedAt: null,
      expiresAt: '2100-01-01T00:00:00Z',
    },
  ],
  ...overrides,
});

const renderApprovals = async () =>
  renderToStaticMarkup(await ApprovalsPage({ searchParams: Promise.resolve({}) }));
const renderDetail = async () =>
  renderToStaticMarkup(
    await RequestPage({
      params: Promise.resolve({ id: requestId }),
      searchParams: Promise.resolve({}),
    }),
  );

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  navigation.params = new URLSearchParams();
  vi.mocked(requireSession).mockResolvedValue(adminSession);
  vi.mocked(api.approvalRules).mockResolvedValue({ ok: true, data: { items: [] } } as never);
  vi.mocked(api.approvalRouting).mockResolvedValue({
    ok: true,
    data: { setting: { enabled: true, updatedAt: null, updatedBy: null } },
  } as never);
  vi.mocked(api.listMembers).mockResolvedValue({ ok: true, data: { items: [] } } as never);
  vi.mocked(api.catalogAdmin).mockResolvedValue({ ok: true, data: { items: [] } } as never);
  vi.mocked(api.serviceRequests).mockResolvedValue({
    ok: true,
    data: {
      items: [
        summary({ id: '08100000-0000-4000-8000-000000000010', number: 'REQ-OWN', own: true }),
        summary({ number: 'REQ-OTHER', own: false, approverName: '合成 上長' }),
      ],
      total: 2,
      page: 1,
      pageSize: 25,
      appliedFilter: { q: '', state: 'all', view: 'all', page: 1 },
    },
  } as never);
  vi.mocked(api.requestDetail).mockResolvedValue({ ok: true, data: detail() });
});
afterEach(() => vi.unstubAllGlobals());

describe('承認者不在の一覧の再割当 (WP-P4-APR-018 §6-6)', () => {
  it('**理由の入力と確認を伴う再割当のフォームが出る**', async () => {
    const html = await renderApprovals();
    expect(html).toContain('>再割当の理由</label>');
    expect(html).toContain('name="reason"');
    expect(html).toMatch(/maxlength="2000"/i);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('今の組織の設定（上長・部署長）から承認者を決め直すことを確認しました');
    expect(html).toContain('>再割当を実行する</button>');
    expect(html).toContain('2000文字以内');
    // ラベルと入力が関連付いている(htmlFor と id が一致する)。
    const label = /<label for="([^"]+)">再割当の理由<\/label>/.exec(html);
    expect(label, '理由のラベルが無い').not.toBeNull();
    expect(html).toContain(`id="${label![1]}"`);
  });

  it('**欄は操作の列に押し込まず、申請の行の直後に全列をまたいで出す**', async () => {
    const html = await renderApprovals();
    // 列幅を配分し直す必要はない(汎用の配分のまま)。
    expect(html).not.toContain('<colgroup>');
    const rows = html.split('<tr').slice(1);
    const requestRow = rows.find((row) => row.includes('REQ-OTHER'));
    expect(requestRow, '申請の行が無い').toBeDefined();
    // 操作の列には詳細のリンクだけを置く。
    const operationCell = /<td data-label="操作">([\s\S]*?)<\/td>/.exec(requestRow!);
    expect(operationCell, '操作のセルが無い').not.toBeNull();
    expect(operationCell![1]).toContain('詳細');
    expect(operationCell![1]).not.toContain('<details');
    expect(operationCell![1]).not.toContain('<textarea');
    // 直後の行が全列をまたぎ、申請番号を含む開閉の操作とフォームを持つ。
    const panelRow = rows[rows.indexOf(requestRow!) + 1];
    expect(panelRow, '全幅の欄の行が無い').toBeDefined();
    expect(panelRow!).toMatch(/<td colspan="6"/i);
    expect(panelRow!).toContain('<details');
    expect(panelRow!).toContain('aria-label="申請番号 REQ-OTHER の再割当"');
    expect(panelRow!).toContain('<summary>再割当（申請番号 REQ-OTHER）</summary>');
    expect(panelRow!).toContain('<textarea');
  });

  it('**申請者が自分自身の行には操作を出さず、全幅の案内を出す**', async () => {
    const html = await renderApprovals();
    const rows = html.split('<tr').slice(1);
    const ownRow = rows.find((row) => row.includes('REQ-OWN'));
    const otherRow = rows.find((row) => row.includes('REQ-OTHER'));
    expect(ownRow).toBeDefined();
    expect(otherRow).toBeDefined();
    expect(ownRow).not.toContain('<textarea');
    expect(otherRow).not.toContain('<textarea');
    const ownPanel = rows[rows.indexOf(ownRow!) + 1];
    const otherPanel = rows[rows.indexOf(otherRow!) + 1];
    expect(ownPanel).toContain(
      '自分の申請は再割当できません。ほかの組織管理者に依頼するか、申請内容を変更してください。',
    );
    expect(ownPanel).toContain('data-reassign-self="true"');
    expect(ownPanel).not.toContain('<textarea');
    expect(otherPanel).toContain('<textarea');
    expect(otherPanel).not.toContain('自分の申請は再割当できません');
    // 再割当の操作は1行(申請者以外)だけに出る。
    expect(html.match(/<textarea/g) ?? []).toHaveLength(1);
    expect(html.match(/<summary>/g) ?? []).toHaveLength(1);
  });

  it('**旧い案内(申請者が内容を変更すると…／再割当の操作はこの画面にはありません)を出さない**', async () => {
    const html = await renderApprovals();
    expect(html).not.toContain('再割当の操作はこの画面にはありません');
    expect(html).toContain('承認者を手で選べません');
    expect(html).toContain('固定承認者の段は再割当では変わりません');
  });

  it('**再割当の記録があるときは、最新の記録の段・新しい承認者・日時で表示する**', async () => {
    const html = renderToStaticMarkup(
      await ApprovalsPage({ searchParams: Promise.resolve({ reassigned: requestId }) }),
    );
    // 記録は世代3(2026-11-11 02:00 UTC)が最新。世代2の内容や「しました」は出さない。
    expect(html).toContain('段2の承認者は「合成 上長3」に再割当されました(2026年11月11日 11:00)。');
    expect(html).not.toContain('再割当しました');
    expect(html).not.toContain('合成 上長2');
    expect(html).toContain('role="status"');
  });

  it('**再割当の記録が無い申請のIDでは、成功の表示を出さない**', async () => {
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: true,
      data: detail({
        currentRouteGeneration: 1,
        routeGenerations: [
          {
            routeGeneration: 1,
            fromStepNo: 1,
            routeHash: 'hash-1',
            reason: null,
            createdBy: null,
            createdByName: null,
            createdAt: '2026-11-01T00:00:00Z',
            newApproverName: null,
            invalidatedStepNo: null,
            invalidatedApproverName: null,
          },
        ],
      }),
    } as never);
    const html = renderToStaticMarkup(
      await ApprovalsPage({ searchParams: Promise.resolve({ reassigned: requestId }) }),
    );
    expect(api.requestDetail).toHaveBeenCalledWith(requestId);
    expect(html).not.toContain('再割当されました');
  });

  it('**不正な申請IDでは詳細を読まず、何も表示しない**', async () => {
    const html = renderToStaticMarkup(
      await ApprovalsPage({ searchParams: Promise.resolve({ reassigned: 'not-a-uuid' }) }),
    );
    expect(api.requestDetail).not.toHaveBeenCalled();
    expect(html).not.toContain('再割当されました');
  });

  it('**詳細を取得できないときは、成功の表示もエラーも出さない**', async () => {
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: false,
      problem: { status: 404, title: '申請を取得できませんでした' },
    } as never);
    const html = renderToStaticMarkup(
      await ApprovalsPage({ searchParams: Promise.resolve({ reassigned: requestId }) }),
    );
    expect(html).not.toContain('再割当されました');
    expect(html).not.toContain('申請を取得できませんでした');
  });
});

describe('再割当の失敗の文 (理由コードから組み立てる)', () => {
  it.each(Object.keys(REASSIGN_REASON_TEXT))(
    '**%s の文があり、コードと実装の用語を出さない**',
    (code) => {
      const text = reassignmentFailureText({
        status: 409,
        errors: [{ field: 'approval', message: code }],
      });
      expect(text).toBe(REASSIGN_REASON_TEXT[code]);
      expect(text).not.toContain('API');
      expect(text).not.toContain(code);
      expect(text.length).toBeGreaterThan(10);
    },
  );

  it('**段がある失敗は「段N: 」を付ける**', () => {
    expect(
      reassignmentFailureText({
        status: 409,
        errors: [{ field: 'approval.steps.1', message: 'manager_unset' }],
      }),
    ).toBe(`段1: ${REASSIGN_REASON_TEXT.manager_unset}`);
  });

  it('**未知のコードは一般的な文にし、コードを出さない**', () => {
    const text = reassignmentFailureText({
      status: 409,
      errors: [{ field: 'approval', message: 'synthetic_unknown_reason' }],
    });
    expect(text).not.toContain('synthetic_unknown_reason');
    expect(text).not.toContain('API');
    expect(text).toBe(
      '再割当できませんでした。申請の状態と承認者の設定を確認してから、もう一度実行してください。',
    );
  });

  it('**理由コードが無い 401/403/404/500 も利用者向けの文にする**', () => {
    for (const status of [401, 403, 404, 500]) {
      const text = reassignmentFailureText({ status });
      expect(text).not.toContain('API');
      expect(text.length).toBeGreaterThan(10);
    }
  });

  it('**成功の文は、記録の段・新しい承認者・日時だけから事実として作る**', () => {
    const records = reassignmentRecords(detail().routeGenerations);
    const latest = records[records.length - 1]!;
    expect(reassignmentSuccessText(latest)).toBe(
      '段2の承認者は「合成 上長3」に再割当されました(2026年11月11日 11:00)。',
    );
    expect(reassignmentSuccessText({ ...latest, newApproverName: null })).toBe(
      '段2の承認者は新しい承認者に再割当されました(2026年11月11日 11:00)。',
    );
  });
});

describe('再割当の記録の組み立て(純関数)', () => {
  it('**世代1と読めない項目を除き、時刻の順に並べる**', () => {
    const records = reassignmentRecords(detail().routeGenerations);
    expect(records.map((record) => record.routeGeneration)).toEqual([2, 3]);
    expect(records.map((record) => record.reason)).toEqual([
      '合成: 1回目の再割当',
      '合成: 2回目の再割当 <script>alert("x")</script>',
    ]);
  });

  it('**配列でない・形が壊れた入力では記録を推測しない**', () => {
    expect(reassignmentRecords(undefined)).toEqual([]);
    expect(reassignmentRecords([{ routeGeneration: 2 }])).toEqual([]);
  });
});

describe('申請の詳細の再割当の表示 (WP-P4-APR-018 §6-6)', () => {
  it('**2回の再割当が時刻の順に、日時・実行者・理由・無効になった段・新しい承認者つきで出る**', async () => {
    vi.mocked(requireSession).mockResolvedValue(requesterSession);
    const html = await renderDetail();
    const section = /<ol class="attachments" aria-label="再割当の記録">([\s\S]*?)<\/ol>/.exec(html);
    expect(section, '再割当の記録が出ていない').not.toBeNull();
    const records = section![1]!;
    const first = records.indexOf('合成: 1回目の再割当');
    const second = records.indexOf('合成: 2回目の再割当');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(records).toContain(formatDateTime('2026-11-10T01:00:00Z'));
    expect(records).toContain(formatDateTime('2026-11-11T02:00:00Z'));
    expect(records).toContain('実行者: 合成 管理者');
    expect(records).toContain('無効になったステップ: 段2（合成 上長2）');
    expect(records).toContain('新しい承認者: 合成 上長3');
    expect(records).toContain('無効になったステップ: 段1（合成 固定A）');
  });

  it('**現在の経過は段ごとの有効な世代を出し、置き換えられたステップを現在の段にしない**', async () => {
    vi.mocked(requireSession).mockResolvedValue(requesterSession);
    const html = await renderDetail();
    const timeline = /<ol class="attachments" aria-label="承認の経過">([\s\S]*?)<\/ol>/.exec(html);
    expect(timeline, '承認の経過が出ていない').not.toBeNull();
    const steps = timeline![1]!;
    expect(steps).toContain('段1（固定承認者）');
    expect(steps).toContain('承認 · 承認者: 合成 上長2');
    expect(steps).toContain('段2（上長）');
    expect(steps).toContain('承認待ち · 承認者: 合成 上長3');
    // 再割当で置き換えられた旧い承認者を、現在の段として出さない。
    expect(steps).not.toContain('合成 固定A');
  });

  it('**承認の記録で、再割当により無効になったステップが分かる**', async () => {
    vi.mocked(requireSession).mockResolvedValue(requesterSession);
    const html = await renderDetail();
    expect(html).toContain('承認の記録');
    expect(html.match(/（再割当により無効）/g) ?? []).toHaveLength(2);
  });

  it('**理由の自由文は文字として表示し、HTMLとして解釈しない**', async () => {
    vi.mocked(requireSession).mockResolvedValue(requesterSession);
    const html = await renderDetail();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});

describe('再割当のサーバーアクション (入力の検査と結果)', () => {
  const scope = { userId: adminId, organizationId: org };
  const form = (values: Record<string, string>): FormData => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };
  const invoke = (values: Record<string, string>) =>
    reassignApprovalAction(scope, requestId, { message: '', attempt: 2 }, form(values));

  beforeEach(() => {
    vi.mocked(api.me).mockResolvedValue({ ok: true, data: adminSession } as never);
    vi.mocked(api.reassignRequest).mockResolvedValue({
      ok: true,
      data: {
        id: requestId,
        version: 5,
        routeGeneration: 3,
        fromStepNo: 2,
        invalidatedApprovalId: '08100000-0000-4000-8000-00000000000e',
        approvalId: '08100000-0000-4000-8000-00000000000b',
        stepNo: 2,
        approverId: approverC,
      },
    } as never);
  });

  it('**理由が空・空白だけなら送らずに知らせる**', async () => {
    for (const reason of ['', '   ']) {
      const result = await invoke({ reason, confirm: '1' });
      expect(result.message).toBe('再割当の理由を入力してください。');
      expect(result.success).toBeUndefined();
      expect(api.reassignRequest).not.toHaveBeenCalled();
    }
  });

  it('**2000文字を超える理由と、確認の欠落は送らない**', async () => {
    const tooLong = await invoke({ reason: 'あ'.repeat(2001), confirm: '1' });
    expect(tooLong.message).toBe('再割当の理由は2000文字以内で入力してください。');
    const unconfirmed = await invoke({ reason: '合成: 承認者不在', confirm: '' });
    expect(unconfirmed.message).toBe('再割当を実行するには、確認の欄にチェックを入れてください。');
    expect(api.reassignRequest).not.toHaveBeenCalled();
  });

  it('**成功すると、申請IDをURLに残して同じ画面へ戻る**', async () => {
    await invoke({ reason: '  合成: 承認者不在  ', confirm: '1' });
    expect(api.reassignRequest).toHaveBeenCalledWith(requestId, {
      reason: '合成: 承認者不在',
    });
    // 成功すると一覧の行は消えるため、成功の文はURLの申請IDから同じ画面で読み直す。
    expect(redirect).toHaveBeenCalledWith(
      `/ops/approvals?reassigned=${requestId}#approval-unavailable`,
    );
    expect(revalidatePath).not.toHaveBeenCalledWith(`/requests/${requestId}`);
  });

  it('**失敗は理由コードから利用者向けの文にし、コードと実装の用語を出さない**', async () => {
    vi.mocked(api.reassignRequest).mockResolvedValue({
      ok: false,
      problem: {
        status: 409,
        title: '再割当できません',
        detail: 'private detail',
        errors: [{ field: 'approval.steps.1', message: 'manager_unset' }],
      },
    } as never);
    const result = await invoke({ reason: '合成: 承認者不在', confirm: '1' });
    expect(result.message).toBe(`段1: ${REASSIGN_REASON_TEXT.manager_unset}`);
    expect(result.message).not.toContain('API');
    expect(result.message).not.toContain('manager_unset');
    expect(result.message).not.toContain('private detail');
    expect(result.success).toBeUndefined();
  });

  it('**権限が無ければ送らない**', async () => {
    vi.mocked(api.me).mockResolvedValue({
      ok: true,
      data: { ...adminSession, roles: [{ roleCode: 'requester', organizationId: org }] },
    } as never);
    const result = await invoke({ reason: '合成: 承認者不在', confirm: '1' });
    expect(result.message).toBe('この操作を行う権限がありません。組織の管理者へご連絡ください。');
    expect(api.reassignRequest).not.toHaveBeenCalled();
  });
});
