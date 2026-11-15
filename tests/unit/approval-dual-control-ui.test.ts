// WP-P4-APR-021 段階B: 高リスク申請の二重承認(画面)。
//
// ここで固定するのは表示と純関数、サーバーアクションの入力・失敗の扱いだけである。
// 認可・状態の判定・書込みはAPIのテスト(tests/security/approval-dual-control.test.ts)が担う。
// ブラウザ/axe はハーネス(evidence/WP-P4-APR-021)で確認し、このテストでは扱わない。
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import {
  HIGH_RISK_APPROVAL_NOTICE,
  REASSIGN_REASON_TEXT,
  highRiskConstraint,
  highRiskConstraintErrorText,
  highRiskUnresolvedMessage,
  reassignmentFailureText,
} from '../../apps/web/src/lib/approval-route';
import {
  api,
  requireSession,
  type CatalogAdminDetail,
  type CatalogAdminSummary,
  type CatalogItem,
  type ServiceRequestDetail,
  type SessionView,
} from '../../apps/web/src/lib/api';
import type { FormFeedback } from '../../apps/web/src/lib/form-state';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    catalogManagementRead: vi.fn(),
    catalogManagementDetail: vi.fn(),
    catalogRequestOptions: vi.fn(),
    catalogApprovalRoute: vi.fn(),
    requestDetail: vi.fn(),
    approvalRules: vi.fn(),
    approvalRouting: vi.fn(),
    listMembers: vi.fn(),
    catalogAdmin: vi.fn(),
    serviceRequests: vi.fn(),
    saveCatalogItem: vi.fn(),
    submitRequest: vi.fn(),
    editRequest: vi.fn(),
    reviseApprovalRule: vi.fn(),
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
  usePathname: () => '/catalog/manage',
  useSearchParams: () => navigation.params,
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../apps/web/src/app/catalog/manage/actions', () => ({
  saveCatalog: vi.fn(),
  publishCatalog: vi.fn(),
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
  ReturnToField: () => null,
}));

const { CatalogManagement, CatalogPublicationForm } = await vi.importActual<
  typeof import('../../apps/web/src/components/CatalogAdminForm')
>('../../apps/web/src/components/CatalogAdminForm');
const { saveCatalog } = await vi.importActual<
  typeof import('../../apps/web/src/app/catalog/manage/actions')
>('../../apps/web/src/app/catalog/manage/actions');
const { saveServiceRequest } = await vi.importActual<
  typeof import('../../apps/web/src/app/requests/actions')
>('../../apps/web/src/app/requests/actions');
const { reviseApprovalRuleAction } = await vi.importActual<
  typeof import('../../apps/web/src/app/ops/approvals/actions')
>('../../apps/web/src/app/ops/approvals/actions');
const { default: CatalogItemPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ itemId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/catalog/[itemId]/page');
const { default: ManagePage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/catalog/manage/page');
const { default: CatalogEditPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ saved?: string; returnTo?: string | string[] }>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/catalog/manage/[id]/page');
const { default: RequestPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/requests/[id]/page');
const { default: ApprovalsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/ops/approvals/page');

const org = '08210000-0000-4000-8000-000000000001';
const adminId = '08210000-0000-4000-8000-000000000002';
const editorId = '08210000-0000-4000-8000-000000000003';
const requesterId = '08210000-0000-4000-8000-000000000004';
const itemId = '08210000-0000-4000-8000-000000000005';
const requestId = '08210000-0000-4000-8000-000000000006';
const approverA = '08210000-0000-4000-8000-000000000007';
const approverB = '08210000-0000-4000-8000-000000000008';
const ruleId = '08210000-0000-4000-8000-000000000009';

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

const definition = (
  highRisk: boolean | undefined,
  extra: Record<string, unknown> = {},
): CatalogItem['definition'] => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  fields: [],
  approval: {
    mode: 'fixed',
    approverId: approverA,
    ruleId,
    ...(highRisk !== undefined ? { highRisk } : {}),
  },
  ...extra,
});

const adminItem = (overrides: Partial<CatalogAdminDetail> = {}): CatalogAdminDetail => ({
  id: itemId,
  code: 'svc-high-risk',
  editVersion: 3,
  active: true,
  publishedRevision: 2,
  viewerId: adminId,
  owners: [],
  groups: [],
  questionSets: [],
  rules: [{ id: ruleId, code: 'two-step', name: '2段承認', currentRevision: 1 }],
  approvers: [
    { id: approverA, name: '合成 承認者A' },
    { id: approverB, name: '合成 承認者B' },
  ],
  draft: {
    revision: 3,
    title: '合成 高リスク申請',
    description: '高リスクの合成申請です。',
    definition: definition(true),
  },
  published: {
    revision: 2,
    title: '合成 高リスク申請',
    description: '高リスクの合成申請です。',
    definition: definition(true),
  },
  history: [{ revision: 2, title: '合成 高リスク申請', createdAt: '2026-11-10T00:00:00Z' }],
  canEdit: true,
  canCreate: true,
  canPublish: true,
  canManageQuestionSets: true,
  highRisk: true,
  publishedHighRisk: true,
  ...overrides,
});

const delegatedItem = (overrides: Partial<CatalogAdminDetail> = {}): CatalogAdminDetail =>
  adminItem({
    canPublish: false,
    canManageQuestionSets: false,
    viewerId: editorId,
    ...overrides,
  });

const renderManagement = (item: CatalogAdminDetail) =>
  renderToStaticMarkup(createElement(CatalogManagement, { item }));

const requestDetail = (overrides: Partial<ServiceRequestDetail> = {}): ServiceRequestDetail => ({
  requesterName: '合成 申請者',
  approverName: '合成 承認者A',
  highRisk: true,
  request: {
    id: requestId,
    state: 'pending',
    version: 2,
    revision: 1,
    requesterId,
    ticketId: '08210000-0000-4000-8000-00000000000a',
    snapshotHash: 'synthetic-request-hash',
    snapshot: {
      requesterId,
      item: { id: itemId, version: 2, title: '合成 高リスク申請', definition: definition(true) },
      inputs: { reason: '合成理由', durationDays: 7, values: {} },
    },
  },
  approval: {
    id: '08210000-0000-4000-8000-00000000000b',
    state: 'pending',
    approver_id: approverA,
    expires_at: '2100-01-01T00:00:00Z',
    reason: null,
  },
  steps: [
    {
      id: '08210000-0000-4000-8000-00000000000c',
      stepNo: 1,
      state: 'pending',
      approverId: approverA,
      approverName: '合成 承認者A',
      authorityType: 'fixed',
      resolvedFrom: 'fixed',
      reason: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: '2100-01-01T00:00:00Z',
      routeGeneration: 1,
    },
    {
      id: '08210000-0000-4000-8000-00000000000d',
      stepNo: 2,
      state: 'pending',
      approverId: approverB,
      approverName: '合成 承認者B',
      authorityType: 'fixed',
      resolvedFrom: 'fixed',
      reason: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: '2100-01-01T00:00:00Z',
      routeGeneration: 1,
    },
  ],
  approvers: [
    { id: approverA, name: '合成 承認者A' },
    { id: approverB, name: '合成 承認者B' },
  ],
  history: [],
  receipt: null,
  ...overrides,
});

const renderRequestDetail = async (overrides: Partial<ServiceRequestDetail> = {}) => {
  vi.mocked(api.requestDetail).mockResolvedValue({ ok: true, data: requestDetail(overrides) });
  return renderToStaticMarkup(
    await RequestPage({
      params: Promise.resolve({ id: requestId }),
      searchParams: Promise.resolve({}),
    }),
  );
};

const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  navigation.params = new URLSearchParams();
  vi.mocked(requireSession).mockResolvedValue(adminSession);
  vi.mocked(api.me).mockResolvedValue({ ok: true, data: adminSession } as never);
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
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      appliedFilter: { q: '', state: 'all', view: 'all', page: 1 },
    },
  } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe('カタログ項目の管理画面: 高リスクの指定 (WP-P4-APR-021 §6.8)', () => {
  it('**組織管理者には、2名の承認が必要な指定のチェックと説明を出す**', () => {
    const html = renderManagement(adminItem());
    expect(html).toMatch(
      /<input[^>]*type="checkbox"[^>]*id="catalog-high-risk"[^>]*name="highRisk"/,
    );
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(html).toContain('高リスク（2名の承認が必要）');
    expect(html).toContain(
      '高リスクの項目は、承認ルールが必要です。ルールには、別人の固定承認者を2段以上含めてください。代理による承認はできません。',
    );
    expect(html).toContain('name="highRiskEditable"');
    expect(html).not.toContain('高リスクの指定は組織管理者だけが変更できます。');
  });

  it('**委任された編集者には、チェックを出さず現在の値だけを見せる**', () => {
    const html = renderManagement(delegatedItem());
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*id="catalog-high-risk"/);
    expect(html).not.toContain('name="highRiskEditable"');
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="highRisk"[^>]*value="true"/);
    expect(html).toContain('高リスク（2名の承認が必要）:');
    expect(html).toContain('指定されています');
    expect(html).toContain('高リスクの指定は組織管理者だけが変更できます。');
  });

  it('**委任された編集者に、高リスクでない項目は「指定されていません」と出す**', () => {
    const item = delegatedItem({
      draft: { ...delegatedItem().draft, definition: definition(false) },
      published: { ...delegatedItem().published!, definition: definition(false) },
      highRisk: false,
      publishedHighRisk: false,
    });
    const html = renderManagement(item);
    expect(html).toContain('指定されていません');
    expect(html).not.toMatch(/<input[^>]*type="hidden"[^>]*name="highRisk"/);
  });

  it('**公開の 400 の各文を、高リスクの指定の項目に結び付けて出す**', () => {
    const messages = [
      '高リスクの項目には承認ルールを設定してください',
      '組織で承認ルールの使用が有効になっていません。有効にしてから公開してください',
      '高リスクの項目に設定した承認ルールが有効ではありません',
      '高リスクの項目には、別人の固定承認者を2段以上設定した承認ルールが必要です',
      '高リスクの項目では、固定承認者を段ごとに別人にしてください',
      '高リスクの指定を確認してください',
    ];
    for (const message of messages) {
      const html = renderToStaticMarkup(
        createElement(CatalogPublicationForm, {
          item: adminItem(),
          feedback: {
            message,
            errors: [{ field: 'definition.approval.highRisk', message }],
            attempt: 1,
          } satisfies FormFeedback,
          action: () => undefined,
          pending: false,
          blocked: () => false,
        }),
      );
      expect(html).toContain(message);
      expect(html).toContain('href="#catalog-approval-settings"');
      expect(html).toContain('高リスクの指定を確認してください。');
    }
  });

  it('**保存の 403 は、高リスクの指定の項目の失敗として表示する**', async () => {
    vi.mocked(api.saveCatalogItem).mockResolvedValue({
      ok: false,
      problem: {
        status: 403,
        title: '権限がありません',
        detail: '高リスクの指定を変更できるのは組織管理者だけです',
      },
    } as never);
    const result = await saveCatalog(
      itemId,
      { message: '', attempt: 1 },
      form({
        title: '合成',
        description: '合成',
        targetLabel: '合成',
        allowedDurations: '7',
        maxReasonLength: '2000',
        approverId: approverA,
        ruleId,
        expectedVersion: '3',
        fields: '[]',
        sections: '[]',
        checklist: '[]',
        highRiskEditable: '1',
      }),
    );
    expect(result.message).toBe('高リスクの指定を変更できるのは組織管理者だけです。');
    expect(result.errors).toEqual([
      {
        field: 'definition.approval.highRisk',
        message: '高リスクの指定を変更できるのは組織管理者だけです。',
      },
    ]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('**管理者がチェックを外したときは明示的な偽を送る**', async () => {
    vi.mocked(api.saveCatalogItem).mockResolvedValue({ ok: true, data: { id: itemId } } as never);
    await saveCatalog(
      itemId,
      { message: '', attempt: 1 },
      form({
        title: '合成',
        description: '合成',
        targetLabel: '合成',
        allowedDurations: '7',
        maxReasonLength: '2000',
        approverId: approverA,
        ruleId,
        expectedVersion: '3',
        fields: '[]',
        sections: '[]',
        checklist: '[]',
        highRiskEditable: '1',
      }),
    );
    const body = vi.mocked(api.saveCatalogItem).mock.calls[0]![1] as {
      definition: { approval: { highRisk?: boolean } };
    };
    expect(body.definition.approval.highRisk).toBe(false);
  });

  it('**委任された編集者は現在の真をそのまま送る(値を変えない)**', async () => {
    vi.mocked(api.saveCatalogItem).mockResolvedValue({ ok: true, data: { id: itemId } } as never);
    await saveCatalog(
      itemId,
      { message: '', attempt: 1 },
      form({
        title: '合成',
        description: '合成',
        targetLabel: '合成',
        allowedDurations: '7',
        maxReasonLength: '2000',
        approverId: approverA,
        ruleId,
        expectedVersion: '3',
        fields: '[]',
        sections: '[]',
        checklist: '[]',
        highRisk: 'true',
      }),
    );
    const body = vi.mocked(api.saveCatalogItem).mock.calls[0]![1] as {
      definition: { approval: { highRisk?: boolean } };
    };
    expect(body.definition.approval.highRisk).toBe(true);
  });

  it('**一覧と項目の詳細に、高リスクであることの目印をテキストで出す**', async () => {
    const items: CatalogAdminSummary[] = [
      {
        id: itemId,
        code: 'svc-high-risk',
        editVersion: 3,
        draftRevision: 3,
        publishedRevision: 2,
        active: true,
        title: '合成 高リスク申請',
        description: '合成',
        highRisk: true,
        publishedHighRisk: true,
      },
      {
        id: '08210000-0000-4000-8000-00000000000e',
        code: 'svc-draft-high-risk',
        editVersion: 1,
        draftRevision: 1,
        publishedRevision: null,
        active: false,
        title: '合成 下書き高リスク',
        description: '合成',
        highRisk: true,
        publishedHighRisk: false,
      },
      {
        id: '08210000-0000-4000-8000-00000000000f',
        code: 'svc-normal',
        editVersion: 1,
        draftRevision: 1,
        publishedRevision: 1,
        active: true,
        title: '合成 通常',
        description: '合成',
        highRisk: false,
        publishedHighRisk: false,
      },
    ];
    vi.mocked(api.catalogManagementRead).mockResolvedValue({
      ok: true,
      data: {
        items,
        approvers: [],
        viewerId: adminId,
        owners: [],
        groups: [],
        questionSets: [],
        canCreate: true,
        canPublish: true,
        canManageQuestionSets: true,
      },
    } as never);
    const list = renderToStaticMarkup(await ManagePage({ searchParams: Promise.resolve({}) }));
    expect(list).toContain('高リスク（2名の承認が必要）');
    expect(list).toContain('公開中の版で指定されています');
    expect(list).toContain('下書きで指定されています（公開すると適用されます）');

    vi.mocked(api.catalogManagementDetail).mockResolvedValue({
      ok: true,
      data: adminItem(),
    } as never);
    const detail = renderToStaticMarkup(
      await CatalogEditPage({
        params: Promise.resolve({ id: itemId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(detail).toContain('高リスク（2名の承認が必要）');
    expect(detail).toContain('公開中の版で指定されています');
  });
});

describe('申請画面と申請の詳細: 2名の承認が必要 (WP-P4-APR-021 §6.8)', () => {
  const item = (highRisk: boolean | undefined): CatalogItem => ({
    id: itemId,
    version: 2,
    title: '合成 高リスク申請',
    description: '合成',
    highRisk: highRisk === true,
    definition: definition(highRisk),
  });

  const renderCatalogItem = async (highRisk: boolean | undefined) => {
    const current = item(highRisk);
    vi.mocked(api.catalogRequestOptions).mockResolvedValue({
      ok: true,
      data: {
        items: [current],
        approvers: [
          { id: approverA, name: '合成 承認者A' },
          { id: approverB, name: '合成 承認者B' },
        ],
        canManage: false,
      },
    } as never);
    vi.mocked(api.catalogApprovalRoute).mockResolvedValue({
      ok: false,
      problem: { status: 404, title: '経路を確認できません' },
    } as never);
    return renderToStaticMarkup(
      await CatalogItemPage({
        params: Promise.resolve({ itemId }),
        searchParams: Promise.resolve({}),
      }),
    );
  };

  it('**公開中の定義が高リスクの申請画面に、2名の承認が必要であることを出す**', async () => {
    const html = await renderCatalogItem(true);
    expect(html).toContain(HIGH_RISK_APPROVAL_NOTICE);
    expect(html).toContain('この申請は2名の承認が必要です。代理による承認はできません。');
  });

  it('**高リスクでない申請画面の表示は変えない**', async () => {
    const normalHtml = await renderCatalogItem(undefined);
    expect(normalHtml).not.toContain(HIGH_RISK_APPROVAL_NOTICE);
    expect(normalHtml).toContain('承認の経路');
    expect(normalHtml).toContain('申請する（模擬）');
  });

  it('**申請の詳細に、snapshot が高リスクのときだけ2名の承認が必要であることを出す**', async () => {
    const html = await renderRequestDetail();
    expect(html).toContain(HIGH_RISK_APPROVAL_NOTICE);
    const normal = await renderRequestDetail({ highRisk: false });
    expect(normal).not.toContain(HIGH_RISK_APPROVAL_NOTICE);
  });

  it('**申請の 409 は detail の文を既存の失敗の表示に出し、理由のコードを出さない**', async () => {
    vi.mocked(api.me).mockResolvedValue({ ok: true, data: requesterSession } as never);
    vi.mocked(api.submitRequest).mockResolvedValue({
      ok: false,
      problem: {
        status: 409,
        type: 'https://solvi.internal/problems/approval-high-risk-unresolved',
        title: '高リスクの申請の承認条件を満たしていません',
        detail: '高リスクの申請には、別人の固定承認者が2段以上必要です',
        errors: [{ field: 'approval', message: 'high_risk_route_invalid' }],
      },
    } as never);
    const result = await saveServiceRequest(
      null,
      { message: '', attempt: 1 },
      form({
        itemId,
        itemVersion: '2',
        idempotencyKey: '08210000-0000-4000-8000-000000000010',
        formScope: `${org}:${requesterId}`,
        reason: '合成理由',
        durationDays: '7',
      }),
    );
    expect(result.message).toBe('高リスクの申請には、別人の固定承認者が2段以上必要です');
    expect(result.errors).toBeUndefined();
    expect(result.message).not.toContain('high_risk_route_invalid');
  });
});

describe('承認ルールの管理画面: 条件を崩す変更の拒否 (WP-P4-APR-021 §6.8)', () => {
  it('**409 を、影響する項目の一覧(code: title)つきで表示し、理由コードを出さない**', async () => {
    const html = renderToStaticMarkup(
      await ApprovalsPage({
        searchParams: Promise.resolve({
          error:
            '公開中の高リスクの項目が条件を満たさなくなるため、変更できません。\nsvc-high-risk: 合成 高リスク申請\nsvc-access: 合成 権限申請',
        }),
      }),
    );
    expect(html).toContain('公開中の高リスクの項目が条件を満たさなくなるため、変更できません。');
    expect(html).toContain('svc-high-risk: 合成 高リスク申請');
    expect(html).toContain('svc-access: 合成 権限申請');
    expect(html).toContain('aria-label="影響するカタログ項目"');
    expect(html).not.toContain('high_risk_definition_blocked');
  });

  it('**サーバーアクションは、影響する項目を利用者向けの文にして返す**', async () => {
    vi.mocked(api.reviseApprovalRule).mockResolvedValue({
      ok: false,
      problem: {
        status: 409,
        type: 'https://solvi.internal/problems/high-risk-approval-constraint',
        title: '高リスクの申請の承認条件が崩れるため変更できません',
        detail: '公開中の高リスクのカタログ項目が条件を満たさなくなります',
        errors: [
          { field: 'approval', message: 'high_risk_definition_blocked' },
          { field: 'affectedItems', message: 'svc-high-risk: 合成 高リスク申請' },
          { field: 'affectedItems', message: 'svc-access: 合成 権限申請' },
        ],
      },
    } as never);
    await reviseApprovalRuleAction(
      { userId: adminId, organizationId: org },
      { rule: ruleId, confirm: null, unresolved: false },
      ruleId,
      form({
        expectedRevision: '1',
        'steps.0.type': 'fixed',
        'steps.0.approverId': approverA,
        'steps.1.type': 'fixed',
        'steps.1.approverId': approverB,
        'steps.2.type': '',
      }),
    );
    const urls = vi.mocked(redirect).mock.calls.map(([url]) => String(url));
    const errorUrl = urls.find((url) => url.includes('error='));
    expect(errorUrl, 'エラー付きの遷移が無い').toBeDefined();
    const error = new URL(errorUrl!, 'https://solvi.local').searchParams.get('error') ?? '';
    expect(error).toContain('公開中の高リスクの項目が条件を満たさなくなるため、変更できません。');
    expect(error).toContain('svc-high-risk: 合成 高リスク申請');
    expect(error).toContain('svc-access: 合成 権限申請');
    expect(error).not.toContain('high_risk_definition_blocked');
  });

  it('**高リスクの条件を崩す 409 の判定は、型と項目だけで行う**', () => {
    const constraint = {
      status: 409,
      type: 'https://solvi.internal/problems/high-risk-approval-constraint',
      errors: [
        { field: 'approval', message: 'high_risk_definition_blocked' },
        { field: 'affectedItems', message: 'svc-a: 合成A' },
      ],
    };
    expect(highRiskConstraint(constraint)).toEqual({
      message: '公開中の高リスクの項目が条件を満たさなくなるため、変更できません。',
      items: ['svc-a: 合成A'],
    });
    expect(highRiskConstraintErrorText(constraint)).toBe(
      '公開中の高リスクの項目が条件を満たさなくなるため、変更できません。\nsvc-a: 合成A',
    );
    expect(highRiskConstraint({ status: 409, type: 'x/approval-unresolved' })).toBeNull();
    expect(highRiskConstraint({ status: 400, type: 'x/high-risk-approval-constraint' })).toBeNull();
  });
});

describe('再割当の理由の文言 (WP-P4-APR-021 §6.8)', () => {
  it('**high_risk_route_invalid の理由の文があり、コードを出さない**', () => {
    expect(REASSIGN_REASON_TEXT.high_risk_route_invalid).toBe(
      '高リスクの申請の承認条件（別人の固定承認者2名）を満たさない経路になるため、再割当できません。組織の管理者に承認ルールの固定承認者を確認してもらってください。',
    );
    const text = reassignmentFailureText({
      status: 409,
      errors: [{ field: 'approval', message: 'high_risk_route_invalid' }],
    });
    expect(text).toBe(REASSIGN_REASON_TEXT.high_risk_route_invalid);
    expect(text).not.toContain('high_risk_route_invalid');
    expect(text).not.toContain('API');
  });

  it('**高リスクの申請の拒否でなければ、detailed 文を出さない**', () => {
    expect(highRiskUnresolvedMessage({ status: 409 })).toBeNull();
    expect(highRiskUnresolvedMessage({ status: 400, detail: '合成' })).toBeNull();
    expect(
      highRiskUnresolvedMessage({
        status: 409,
        type: 'https://solvi.internal/problems/approval-high-risk-unresolved',
        detail: '合成の理由',
        errors: [{ field: 'approval', message: 'high_risk_route_invalid' }],
      }),
    ).toBe('合成の理由');
    expect(
      highRiskUnresolvedMessage({
        status: 409,
        type: 'https://solvi.internal/problems/approval-high-risk-unresolved',
      }),
    ).not.toContain('high_risk_route_invalid');
  });
});
