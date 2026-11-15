// WP-P4-APR-020 段階B: 承認の委任の画面と、代理の表示。
// ここで固定するのは表示と純関数だけである。認可・期間・重なりの判定はAPIのテスト
// (tests/security/approval-delegation.test.ts)が担う。ブラウザ/axe はハーネスで別に行う。
import React, { createElement, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import {
  api,
  requireSession,
  type ApprovalDelegationItem,
  type InboxView,
  type ServiceRequestDetail,
  type ServiceRequestSummary,
  type SessionView,
} from '../../apps/web/src/lib/api';
import {
  DELEGATION_STATE_LABELS,
  delegationCreatedText,
  delegationCreateFailure,
  delegationRevocable,
  delegationRevokedText,
  delegationRevokeFailure,
  delegationStateLabel,
  jstDateTimeInput,
  jstInputToIso,
} from '../../apps/web/src/lib/approval-delegation';
import { NOTIFICATION_EVENTS } from '../../apps/web/src/lib/notification-list';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    approvalDelegations: vi.fn(),
    approvalDelegationCandidates: vi.fn(),
    createApprovalDelegation: vi.fn(),
    revokeApprovalDelegation: vi.fn(),
    serviceRequests: vi.fn(),
    requestDetail: vi.fn(),
    inbox: vi.fn(),
    me: vi.fn(),
  },
  requireSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [{ name: 'solvi_session', value: 'synthetic-session' }] }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  usePathname: () => '/settings/delegations',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    createElement('a', { ...props, 'data-next-link': 'true' }),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
// RequestActions はクライアント部品である。ここでは「APIの値がそのまま渡るか」だけを見る。
vi.mock('../../apps/web/src/components/RequestForms', () => ({
  RequestForm: () => null,
  // 実際の RequestActions は、どの操作も出せないときは何も描画しない。
  RequestActions: (props: { canApprove: boolean; canRevoke: boolean; canSimulate: boolean }) =>
    props.canApprove || props.canRevoke || props.canSimulate
      ? createElement('div', {
          'data-can-approve': String(props.canApprove),
          'data-actions': 'true',
        })
      : null,
}));
vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ContextLink: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
  ReturnToField: () => null,
}));

const { default: DelegationsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/settings/delegations/page');
const { default: RequestsPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/requests/page');
const { default: RequestPage } = await vi.importActual<{
  default: (props: {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/requests/[id]/page');
const { default: InboxPage } = await vi.importActual<{
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
}>('../../apps/web/src/app/inbox/page');
const { createDelegationAction, revokeDelegationAction } = await vi.importActual<
  typeof import('../../apps/web/src/app/settings/delegations/actions')
>('../../apps/web/src/app/settings/delegations/actions');

const org = '08200000-0000-4000-8000-000000000001';
const meId = '08200000-0000-4000-8000-000000000002';
const otherId = '08200000-0000-4000-8000-000000000003';
const requestId = '08200000-0000-4000-8000-000000000004';
const delegationId = '08200000-0000-4000-8000-000000000005';
const revokedId = '08200000-0000-4000-8000-000000000006';
const declinedId = '08200000-0000-4000-8000-000000000007';

const session = (roles: string[]): SessionView => ({
  userId: meId,
  organizationId: org,
  roles: roles.map((roleCode) => ({ roleCode, organizationId: org })),
});
const requesterSession = session(['requester']);
const adminSession = session(['org_admin']);

const delegation = (patch: Partial<ApprovalDelegationItem> = {}): ApprovalDelegationItem => ({
  id: delegationId,
  delegatorId: meId,
  delegatorName: '合成 委任者',
  delegateId: otherId,
  delegateName: '合成 代理者',
  startsAt: '2026-11-15T00:00:00.000Z',
  endsAt: '2026-11-20T00:00:00.000Z',
  state: 'active',
  revokedAt: null,
  revokeReason: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  relation: 'delegator',
  ...patch,
});

const definition: ServiceRequestDetail['request']['snapshot']['item']['definition'] = {
  mode: 'local_simulation',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  fields: [],
};

const summary = (patch: Partial<ServiceRequestSummary> = {}): ServiceRequestSummary => ({
  id: requestId,
  number: 'REQ-082',
  title: '合成の申請',
  state: 'pending',
  version: 2,
  requesterName: '合成 申請者',
  approverName: '合成 委任者',
  createdAt: '2026-11-10T00:00:00Z',
  updatedAt: '2026-11-10T01:00:00Z',
  expiresAt: '2100-01-01T00:00:00Z',
  decisionReason: null,
  own: false,
  assigned: false,
  expired: false,
  nextAction: '内容を確認して承認・却下を判断する',
  ticketId: '08200000-0000-4000-8000-000000000009',
  approvalState: 'pending',
  delegated: true,
  ...patch,
});

const detail = (patch: Partial<ServiceRequestDetail> = {}): ServiceRequestDetail => ({
  requesterName: '合成 申請者',
  approverName: '合成 委任者',
  request: {
    id: requestId,
    state: 'pending',
    version: 2,
    revision: 1,
    requesterId: otherId,
    ticketId: '08200000-0000-4000-8000-000000000009',
    snapshotHash: 'synthetic-request-hash',
    snapshot: {
      requesterId: otherId,
      item: { id: requestId, version: 1, title: '合成の申請', definition },
      inputs: { reason: '合成理由', durationDays: 7, values: {} },
    },
  },
  approval: {
    id: '08200000-0000-4000-8000-00000000000a',
    state: 'pending',
    approver_id: meId,
    expires_at: '2100-01-01T00:00:00Z',
    reason: null,
  },
  currentDelegation: null,
  approvers: [],
  receipt: null,
  steps: [
    {
      id: '08200000-0000-4000-8000-00000000000b',
      stepNo: 1,
      state: 'pending',
      approverId: meId,
      approverName: '合成 委任者',
      authorityType: 'fixed',
      resolvedFrom: 'fixed',
      reason: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: '2100-01-01T00:00:00Z',
      routeGeneration: 1,
      delegated: false,
      decidedByName: null,
    },
  ],
  effectiveSteps: [
    {
      id: '08200000-0000-4000-8000-00000000000b',
      stepNo: 1,
      state: 'pending',
      approverId: meId,
      approverName: '合成 委任者',
      authorityType: 'fixed',
      resolvedFrom: 'fixed',
      reason: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: '2100-01-01T00:00:00Z',
      routeGeneration: 1,
      delegated: false,
      decidedByName: null,
    },
  ],
  route: {
    steps: [
      {
        stepNo: 1,
        approverId: meId,
        approverName: '合成 委任者',
        authorityType: 'fixed',
        resolvedFrom: 'fixed',
      },
    ],
    ruleRef: { ruleId: 'rule-synthetic', revision: 1 },
  },
  currentRouteGeneration: 1,
  routeGenerations: [],
  history: [],
  ...patch,
});

const inboxItem = {
  kind: 'request_approval' as const,
  id: requestId,
  number: 'REQ-082',
  title: '合成の申請',
  state: 'pending',
  stateLabel: '代理での承認依頼',
  scopeLabel: '合成 委任者さんの代理',
  nextAction: '申請を確認して承認・却下する',
  href: `/requests/${requestId}`,
  waiting: false,
  eventKey: 'approval:1',
  updatedAt: '2026-11-10T01:00:00Z',
  unread: true,
  delegated: true,
  delegatorName: '合成 委任者',
  deadline: {
    label: '承認期限',
    status: 'within' as const,
    at: '2100-01-01T00:00:00Z',
    remainingSeconds: 3600,
  },
};

const inbox = (items: (typeof inboxItem)[] = [inboxItem]): InboxView => ({
  items,
  total: items.length,
  unread: 1,
  page: 1,
  pageSize: 20,
  asOf: '2026-11-15T00:00:00Z',
  canIncludeUnassigned: false,
  counts: { ticket: 0, approval: items.length, change: 0 },
  appliedFilter: { kind: 'all', q: '', unread: '0', unassigned: '0', page: 1 },
});

const renderDelegations = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await DelegationsPage({ searchParams: Promise.resolve(params) }));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  vi.mocked(requireSession).mockResolvedValue(requesterSession);
  vi.mocked(api.approvalDelegations).mockResolvedValue({
    ok: true,
    data: { items: [delegation()], asOf: '2026-11-15T00:00:00Z' },
  } as never);
  vi.mocked(api.approvalDelegationCandidates).mockResolvedValue({
    ok: true,
    data: { items: [{ id: otherId, displayName: '合成 代理者' }], asOf: '2026-11-15T00:00:00Z' },
  } as never);
  vi.mocked(api.serviceRequests).mockResolvedValue({
    ok: true,
    data: {
      items: [summary()],
      total: 1,
      page: 1,
      pageSize: 25,
      appliedFilter: { q: '', state: 'all', view: 'approvals', page: 1 },
    },
  } as never);
  vi.mocked(api.requestDetail).mockResolvedValue({ ok: true, data: detail() } as never);
  vi.mocked(api.inbox).mockResolvedValue({ ok: true, data: inbox() } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe('委任の画面: 3つの見え方 (WP §6.7)', () => {
  it('**委任者として見る**: 自分の委任の一覧と作成のフォームが出る', async () => {
    const html = await renderDelegations();
    expect(html).toContain('自分が任せている委任');
    expect(html).toContain('合成 代理者');
    expect(html).toContain('委任を作成');
    expect(html).toContain('name="delegateId"');
    expect(html).toContain('name="startsAt"');
    expect(html).toContain('name="endsAt"');
    // 承認者でない利用者にも画面を開ける(ロールでの拒否をしない)。
    expect(html).not.toContain('この画面を表示する権限がありません');
  });

  it('**代理者として見る**: 自分が任されている委任と辞退の欄が出る', async () => {
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: true,
      data: {
        items: [
          delegation({
            relation: 'delegate',
            delegatorName: '合成 委任者A',
            delegateName: '合成 代理者B',
          }),
        ],
        asOf: '2026-11-15T00:00:00Z',
      },
    } as never);
    const html = await renderDelegations();
    const received = /<section[^>]*id="delegation-received"[\s\S]*?<\/section>/.exec(html);
    expect(received, '任されている委任の節が無い').not.toBeNull();
    expect(received![0]).toContain('合成 委任者A');
    expect(received![0]).toContain('委任を辞退する');
    expect(received![0]).toContain('辞退の理由');
    expect(received![0]).toContain('type="checkbox"');
    // 委任者としての一覧は空。
    expect(html).toContain('まだ委任していません');
  });

  it('**組織管理者として見る**: 組織のすべての委任と、他人の分の取消が出る。作成は自分の分だけ', async () => {
    vi.mocked(requireSession).mockResolvedValue(adminSession);
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: true,
      data: {
        items: [
          delegation(),
          delegation({
            id: '08200000-0000-4000-8000-00000000001a',
            delegatorId: otherId,
            delegatorName: '合成 他人の委任者',
            delegateId: '08200000-0000-4000-8000-00000000001b',
            delegateName: '合成 他人の代理者',
            relation: 'admin',
          }),
        ],
        asOf: '2026-11-15T00:00:00Z',
      },
    } as never);
    const html = await renderDelegations();
    const organization = /<section[^>]*id="delegation-organization"[\s\S]*?<\/section>/.exec(html);
    expect(organization, '組織の委任の節が無い').not.toBeNull();
    expect(organization![0]).toContain('合成 他人の委任者');
    expect(organization![0]).toContain('合成 他人の代理者');
    // 他人の委任の取消の欄が出る(委任者→代理者の組で特定する)。
    expect(organization![0]).toContain('委任を取り消す（合成 他人の委任者 → 合成 他人の代理者）');
    // 作成のフォームは1つだけで、委任者を選ぶ入力は無い(管理者も自分の分しか作れない)。
    expect(html.match(/name="delegateId"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('name="delegatorId"');
    expect(html).not.toContain('委任者を選ぶ');
    // 作成の確認の文は「自分宛て」である。
    expect(html).toContain('この人が自分宛ての承認を判断できることを確認しました');
  });

  it('**代理者の候補が0人**なら、理由を出して作成のフォームを出さない', async () => {
    vi.mocked(api.approvalDelegationCandidates).mockResolvedValue({
      ok: true,
      data: { items: [], asOf: '2026-11-15T00:00:00Z' },
    } as never);
    const html = await renderDelegations();
    expect(html).toContain(
      '代理者にできるのは、承認者の役割を持つ有効な利用者だけです。該当する人がいません。',
    );
    expect(html).not.toContain('name="delegateId"');
  });

  it('候補を読み込めないときも、作成のフォームを出さない', async () => {
    vi.mocked(api.approvalDelegationCandidates).mockResolvedValue({
      ok: false,
      problem: { status: 503, title: '接続できませんでした' },
    } as never);
    const html = await renderDelegations();
    expect(html).toContain('代理者の候補を読み込めませんでした');
    expect(html).not.toContain('name="delegateId"');
  });

  it('一覧を読み込めないときは、操作を出さずに再取得を案内する', async () => {
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: false,
      problem: { status: 503, title: '接続できませんでした' },
    } as never);
    const html = await renderDelegations();
    expect(html).toContain('承認の委任を読み込めませんでした');
    expect(html).not.toContain('name="delegateId"');
    expect(html).not.toContain('委任を取り消す');
  });

  it('説明文: 範囲・30日・自分でも承認できる・取消後の扱い・代理者は1人を出す', async () => {
    const html = await renderDelegations();
    expect(html).toContain('委任の範囲は、自分宛ての承認のすべてです');
    expect(html).toContain('期間は最長30日です');
    expect(html).toContain('委任の期間中も、自分で承認・却下できます');
    expect(html).toContain('代理で承認済みのステップは有効のままです');
    expect(html).toContain('代理者になれるのは同時に1人です');
  });
});

describe('委任の状態の表示 (6種類)', () => {
  it.each([
    ['scheduled', '開始前'],
    ['active', '有効'],
    ['ended', '期間終了'],
    ['revoked', '取消済み'],
    ['delegate_ineligible', '代理者が資格なし'],
    ['unknown', '状態を確認できません'],
  ])('**%s は「%s」**と表示する(内部の値を出さない)', (state, label) => {
    expect(delegationStateLabel(state)).toBe(label);
    expect(DELEGATION_STATE_LABELS[state]).toBe(label);
    expect(label).not.toBe(state);
  });

  it('**状態を確認できません(unknown)** は有効と扱わず、取消の操作も出さない', async () => {
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: true,
      data: {
        items: [delegation({ state: 'unknown' }), delegation({ id: revokedId, state: 'revoked' })],
        asOf: '2026-11-15T00:00:00Z',
      },
    } as never);
    const html = await renderDelegations();
    expect(html).toContain('状態を確認できません');
    expect(html).toContain('有効とは扱いません');
    expect(html).not.toContain('>有効<');
    // 取り消せるのは unknown ではない(取消済みも出さない)。
    expect(html).not.toContain('委任を取り消す（合成 代理者）');
    expect(delegationRevocable('unknown')).toBe(false);
    expect(delegationRevocable('ended')).toBe(false);
    expect(delegationRevocable('revoked')).toBe(false);
    expect(delegationRevocable('active')).toBe(true);
    expect(delegationRevocable('scheduled')).toBe(true);
    expect(delegationRevocable('delegate_ineligible')).toBe(true);
  });
});

describe('成功の表示は、記録のあるときだけ (WP-P4-APR-018 の教訓)', () => {
  it('**作成の記録があるとき**、代理者と期間から文を作る', async () => {
    const html = await renderDelegations({ created: delegationId });
    expect(html).toContain('id="delegation-notice"');
    expect(html).toContain('「合成 代理者」さんへの委任を作成しました');
    expect(html).toContain('role="status"');
  });

  it('**一覧に無いIDでは、成功を表示しない**(URLの値だけでは出さない)', async () => {
    const html = await renderDelegations({ created: '08200000-0000-4000-8000-0000000000ff' });
    expect(html).not.toContain('委任を作成しました');
    expect(html).not.toContain('id="delegation-notice"');
  });

  it('**取消の記録が無い**(取り消されていない)場合は、取消の成功を出さない', async () => {
    const html = await renderDelegations({ revoked: delegationId });
    expect(html).not.toContain('委任を取り消しました');
  });

  it('**取消の記録があるとき**、取消の日時から文を作る', async () => {
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: true,
      data: {
        items: [
          delegation({
            id: revokedId,
            state: 'revoked',
            revokedAt: '2026-11-15T02:00:00.000Z',
            revokeReason: '合成: 取消',
          }),
        ],
        asOf: '2026-11-15T00:00:00Z',
      },
    } as never);
    const html = await renderDelegations({ revoked: revokedId });
    expect(html).toContain('「合成 代理者」さんへの委任を取り消しました');
  });

  it('**辞退の記録があるとき**、委任者名で辞退の文を作る', async () => {
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: true,
      data: {
        items: [
          delegation({
            id: declinedId,
            relation: 'delegate',
            state: 'revoked',
            revokedAt: '2026-11-15T02:00:00.000Z',
            revokeReason: '合成: 辞退',
          }),
        ],
        asOf: '2026-11-15T00:00:00Z',
      },
    } as never);
    const html = await renderDelegations({ declined: declinedId });
    expect(html).toContain('「合成 委任者」さんからの委任を辞退しました');
  });

  it('成功の文は、記録の形が読めないときは作らない', () => {
    expect(delegationCreatedText({ ...delegation(), startsAt: 'not-a-date' })).toBeNull();
    expect(
      delegationCreatedText({ ...delegation(), revokedAt: '2026-11-15T00:00:00Z' }),
    ).toBeNull();
    expect(delegationRevokedText({ ...delegation(), revokedAt: null }, 'revoked')).toBeNull();
  });
});

describe('作成の失敗の表示 (各理由。コードを画面に出さない)', () => {
  it.each([
    [
      '400 開始の形式',
      { status: 400, errors: [{ field: 'startsAt', message: '開始の日時を確認してください' }] },
      'startsAt',
      '開始',
    ],
    [
      '400 終了の順序',
      { status: 400, errors: [{ field: 'endsAt', message: '終了は開始より後にしてください' }] },
      'endsAt',
      '終了',
    ],
    [
      '400 30日超',
      { status: 400, errors: [{ field: 'endsAt', message: '期間は30日以内にしてください' }] },
      'endsAt',
      '終了',
    ],
    [
      '400 開始が過去',
      {
        status: 400,
        errors: [{ field: 'startsAt', message: '開始は現在より5分前までにしてください' }],
      },
      'startsAt',
      '開始',
    ],
    [
      '400 代理者',
      { status: 400, errors: [{ field: 'delegateId', message: '代理者を選んでください' }] },
      'delegateId',
      '代理者',
    ],
  ])('**%s** を、項目に結び付けて表示する', (_label, problem, field, label) => {
    const feedback = delegationCreateFailure(problem);
    expect(feedback.errors?.[0]).toMatchObject({ field, label });
    expect(feedback.errors?.[0]?.message).toBe(problem.errors![0]!.message);
    expect(feedback.message).toBe('入力内容を確認してください。');
  });

  it('**期間の重なり(409)** を、平易な文にする', () => {
    const feedback = delegationCreateFailure({
      status: 409,
      detail: '期間が重なる委任があります',
    });
    expect(feedback.message).toContain('重なる委任が既にあります');
    expect(feedback.message).toContain('同時に1人');
    expect(feedback.message).not.toContain('期間が重なる委任があります');
  });

  it('**プロフィール未設定(409)** を、依頼先つきで表示する', () => {
    const feedback = delegationCreateFailure({
      status: 409,
      detail: '組織プロフィールが未設定のため、委任を作成できません',
    });
    expect(feedback.message).toContain('組織プロフィールが未設定');
    expect(feedback.message).toContain('組織の管理者');
  });

  it.each([401, 403, 404, 500])('**%s** も利用者向けの文にして、内部の文言を出さない', (status) => {
    const feedback = delegationCreateFailure({
      status,
      title: 'internal title',
      detail: 'SQLSTATE 23503 approval_delegation',
    });
    expect(feedback.message).not.toContain('SQLSTATE');
    expect(feedback.message).not.toContain('approval_delegation');
    expect(feedback.message).not.toContain('internal title');
    expect(feedback.message.length).toBeGreaterThan(10);
  });

  it('**403 の理由**(委任者の所属・代理者の資格)を、APIの利用者向けの文言で示す', () => {
    expect(
      delegationCreateFailure({
        status: 403,
        detail: '委任できるのは現在有効な所属の本人だけです',
      }).message,
    ).toBe('委任できるのは現在有効な所属の本人だけです。');
    expect(
      delegationCreateFailure({
        status: 403,
        detail: '現在有効な所属の承認者を代理者に選んでください',
      }).message,
    ).toBe('現在有効な所属の承認者を代理者に選んでください。');
  });

  it('取消の失敗も、状態に応じた文にする(コードを出さない)', () => {
    expect(
      delegationRevokeFailure({ status: 409, detail: '取り消し済みの委任です' }).message,
    ).toContain('既に取り消されています');
    expect(
      delegationRevokeFailure({ status: 409, detail: '期間の終わった委任は取り消せません' })
        .message,
    ).toContain('取り消せません');
    expect(delegationRevokeFailure({ status: 404 }).message).toContain('見つかりません');
    expect(delegationRevokeFailure({ status: 403 }).message).toContain('権限がありません');
  });
});

describe('日時の入力 (既存の流儀に合わせる)', () => {
  it('`datetime-local` の値を日本時間としてISOにする', () => {
    expect(jstInputToIso('2026-11-15T09:00')).toBe('2026-11-15T00:00:00.000Z');
    expect(jstInputToIso('')).toBeNull();
    expect(jstInputToIso('not-a-date')).toBeNull();
  });

  it('開始の既定は日本時間の現在、終了の既定は置かない', async () => {
    expect(jstDateTimeInput(new Date('2026-11-15T00:00:00Z'))).toBe('2026-11-15T09:00');
    expect(jstDateTimeInput(new Date('not-a-date'))).toBe('');
    const html = await renderDelegations();
    const starts = /<input[^>]*name="startsAt"[^>]*>/.exec(html);
    const ends = /<input[^>]*name="endsAt"[^>]*>/.exec(html);
    expect(starts, '開始の入力が無い').not.toBeNull();
    expect(ends, '終了の入力が無い').not.toBeNull();
    expect(starts![0]).toMatch(/value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
    expect(ends![0]).not.toMatch(/value="/);
    expect(html).toContain('（日本時間・JST）');
  });

  it('30日を超える・終了が開始以前の判定はAPIに任せ、画面で規則を書き直さない', async () => {
    const html = await renderDelegations();
    // 画面が独自の上限を持つと、APIと食い違う。入力の上限(max)を置かない。
    const ends = /<input[^>]*name="endsAt"[^>]*>/.exec(html)![0];
    expect(ends).not.toContain(' max=');
  });
});

describe('代理の表示 (一覧・受信箱・詳細)', () => {
  it('**承認待ちの一覧**に「◯◯さんの代理」を出す。委任の無い行は変えない', async () => {
    vi.mocked(api.serviceRequests).mockResolvedValue({
      ok: true,
      data: {
        items: [
          summary(),
          summary({
            id: '08200000-0000-4000-8000-00000000001c',
            number: 'REQ-083',
            delegated: false,
          }),
        ],
        total: 2,
        page: 1,
        pageSize: 25,
        appliedFilter: { q: '', state: 'all', view: 'approvals', page: 1 },
      },
    } as never);
    const html = renderToStaticMarkup(
      await RequestsPage({ searchParams: Promise.resolve({ view: 'approvals' }) }),
    );
    expect(html).toContain('合成 委任者さんの代理で判断できます（委任された承認です）。');
    expect((html.match(/さんの代理で判断できます/g) ?? []).length).toBe(1);
    expect(html).toContain('代理承認の委任を管理する');
  });

  it('**受信箱**はAPIが返す「◯◯さんの代理」をそのまま表示する(画面で組み立てない)', async () => {
    const html = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('合成 委任者さんの代理');
    expect(html).toContain('代理での承認依頼');
  });

  it('**申請の詳細**で代理の通知と、代理者にも承認・却下の操作を出す(APIの値で判定)', async () => {
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: true,
      data: detail({
        currentDelegation: { id: delegationId, delegatorId: meId, delegatorName: '合成 委任者' },
      }),
    } as never);
    const html = renderToStaticMarkup(
      await RequestPage({
        params: Promise.resolve({ id: requestId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('合成 委任者');
    expect(html).toContain('さんの代理で承認・却下できます');
    expect(html).toContain('data-delegated-to-me="true"');
    expect(html).toContain('data-can-approve="true"');
  });

  it('**代理の値が無い**申請では、代理の通知も承認の操作も出さない(既存の表示を変えない)', async () => {
    // 閲覧者は申請者でも、その段の承認者でも、委任の代理者でもない。
    const notMine = '08200000-0000-4000-8000-00000000001d';
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: true,
      data: detail({
        approval: { ...detail().approval, approver_id: notMine },
        steps: detail().steps?.map((step) => ({ ...step, approverId: notMine })),
        effectiveSteps: detail().effectiveSteps?.map((step) => ({
          ...step,
          approverId: notMine,
          approverName: '合成 別の承認者',
        })),
      }),
    } as never);
    const html = renderToStaticMarkup(
      await RequestPage({
        params: Promise.resolve({ id: requestId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).not.toContain('さんの代理で承認・却下できます');
    expect(html).not.toContain('data-delegated-to-me');
    // 承認者本人でも委任の代理者でもないため、操作は出ない。
    expect(html).not.toContain('data-actions="true"');
  });

  it('**承認の経過**に「承認者: ◯◯（代理: △△）」を出す', async () => {
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: true,
      data: detail({
        effectiveSteps: [
          {
            id: '08200000-0000-4000-8000-00000000000b',
            stepNo: 1,
            state: 'approved',
            approverId: meId,
            approverName: '合成 委任者',
            authorityType: 'fixed',
            resolvedFrom: 'fixed',
            reason: null,
            decidedAt: '2026-11-10T03:00:00Z',
            decidedBy: otherId,
            expiresAt: '2100-01-01T00:00:00Z',
            routeGeneration: 1,
            delegated: true,
            decidedByName: '合成 代理者',
          },
        ],
      }),
    } as never);
    const html = renderToStaticMarkup(
      await RequestPage({
        params: Promise.resolve({ id: requestId }),
        searchParams: Promise.resolve({}),
      }),
    );
    const timeline = /<ol class="attachments" aria-label="承認の経過">([\s\S]*?)<\/ol>/.exec(html);
    expect(timeline, '承認の経過が無い').not.toBeNull();
    expect(timeline![1]).toContain('承認者: 合成 委任者（代理: 合成 代理者）');
  });

  it('**承認の記録**にも「承認者: ◯◯（代理: △△）」を出す', async () => {
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: true,
      data: detail({
        request: { ...detail().request, revision: 2 },
        history: [
          {
            id: '08200000-0000-4000-8000-00000000000d',
            state: 'approved',
            revision: 1,
            stepNo: 1,
            routeGeneration: 1,
            invalidatedByReassign: false,
            delegated: true,
            decidedBy: otherId,
            decidedByName: '合成 代理者',
            approverId: meId,
            approverName: '合成 委任者',
            item: { version: 1, definition },
            inputs: { reason: '合成理由', durationDays: 7 },
            reason: null,
            decidedAt: '2026-11-10T03:00:00Z',
            expiresAt: '2100-01-01T00:00:00Z',
          },
        ],
      }),
    } as never);
    const html = renderToStaticMarkup(
      await RequestPage({
        params: Promise.resolve({ id: requestId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('承認の記録');
    expect(html).toContain('承認者: 合成 委任者（代理: 合成 代理者）');
  });

  it('**委任の無い申請では「（代理:」を出さない**', async () => {
    vi.mocked(api.requestDetail).mockResolvedValue({
      ok: true,
      data: detail({
        effectiveSteps: [
          {
            id: '08200000-0000-4000-8000-00000000000b',
            stepNo: 1,
            state: 'approved',
            approverId: meId,
            approverName: '合成 委任者',
            authorityType: 'fixed',
            resolvedFrom: 'fixed',
            reason: null,
            decidedAt: '2026-11-10T03:00:00Z',
            decidedBy: meId,
            expiresAt: '2100-01-01T00:00:00Z',
            routeGeneration: 1,
            delegated: false,
            decidedByName: null,
          },
        ],
      }),
    } as never);
    const html = renderToStaticMarkup(
      await RequestPage({
        params: Promise.resolve({ id: requestId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).not.toContain('（代理:');
    expect(html).toContain('承認者: 合成 委任者');
  });
});

describe('メールアドレス・社員番号を描画しない', () => {
  it('一覧の行に余分な連絡先が入っていても、表示名だけを出す', async () => {
    const withPrivate = {
      ...delegation(),
      email: 'wp020-ui-private@example.test',
      employeeId: 'WP020-EMP-0001',
    } as ApprovalDelegationItem;
    vi.mocked(api.approvalDelegations).mockResolvedValue({
      ok: true,
      data: {
        items: [withPrivate],
        asOf: '2026-11-15T00:00:00Z',
      },
    } as never);
    const html = await renderDelegations();
    expect(html).toContain('合成 代理者');
    expect(html).not.toContain('wp020-ui-private@example.test');
    expect(html).not.toContain('WP020-EMP-0001');
    expect(html).not.toContain('@');
  });
});

describe('通知の一覧の表示名 (WP-P4-APR-020 §6.5)', () => {
  it('委任の作成・取消のイベント型に、内部の型ではない日本語の表示名がある', () => {
    expect(NOTIFICATION_EVENTS['approval.delegation.created']).toBe('代理承認の委任の作成');
    expect(NOTIFICATION_EVENTS['approval.delegation.revoked']).toBe('代理承認の委任の取消');
    for (const label of [
      NOTIFICATION_EVENTS['approval.delegation.created'],
      NOTIFICATION_EVENTS['approval.delegation.revoked'],
    ])
      expect(label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});

describe('委任のサーバーアクション (入力の検査と結果)', () => {
  const scope = { userId: meId, organizationId: org };
  const form = (values: Record<string, string>): FormData => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  };
  const create = (values: Record<string, string>) =>
    createDelegationAction(scope, { message: '', attempt: 1 }, form(values));
  const revoke = (kind: 'revoked' | 'declined', values: Record<string, string>) =>
    revokeDelegationAction(scope, delegationId, kind, { message: '', attempt: 1 }, form(values));

  beforeEach(() => {
    vi.mocked(api.me).mockResolvedValue({ ok: true, data: requesterSession } as never);
    vi.mocked(api.createApprovalDelegation).mockResolvedValue({
      ok: true,
      data: {
        id: delegationId,
        delegatorId: meId,
        delegateId: otherId,
        startsAt: '2026-11-15T00:00:00.000Z',
        endsAt: '2026-11-20T00:00:00.000Z',
        createdAt: '2026-11-14T00:00:00.000Z',
        state: 'active',
      },
    } as never);
    vi.mocked(api.revokeApprovalDelegation).mockResolvedValue({
      ok: true,
      data: { id: delegationId, revokedAt: '2026-11-15T02:00:00.000Z' },
    } as never);
  });

  it('**作成**: 本文は代理者・開始・終了だけを日本時間からISOにして送る', async () => {
    await create({
      delegateId: otherId,
      startsAt: '2026-11-15T09:00',
      endsAt: '2026-11-20T09:00',
      confirm: '1',
    });
    expect(api.createApprovalDelegation).toHaveBeenCalledWith({
      delegateId: otherId,
      startsAt: '2026-11-15T00:00:00.000Z',
      endsAt: '2026-11-20T00:00:00.000Z',
    });
    const payload = vi.mocked(api.createApprovalDelegation).mock.calls[0]![0];
    expect(Object.keys(payload).sort()).toEqual(['delegateId', 'endsAt', 'startsAt']);
    expect(redirect).toHaveBeenCalledWith(
      `/settings/delegations?created=${delegationId}#delegation-mine`,
    );
  });

  it('**作成**: 代理者・日時・確認が欠ければ送らない', async () => {
    const noDelegate = await create({
      startsAt: '2026-11-15T09:00',
      endsAt: '2026-11-20T09:00',
      confirm: '1',
    });
    expect(noDelegate.message).toBe('代理者を候補から選んでください。');
    const noStart = await create({ delegateId: otherId, endsAt: '2026-11-20T09:00', confirm: '1' });
    expect(noStart.message).toBe('開始の日時を入力してください。');
    const noEnd = await create({ delegateId: otherId, startsAt: '2026-11-15T09:00', confirm: '1' });
    expect(noEnd.message).toBe('終了の日時を入力してください。');
    const noConfirm = await create({
      delegateId: otherId,
      startsAt: '2026-11-15T09:00',
      endsAt: '2026-11-20T09:00',
    });
    expect(noConfirm.message).toContain('確認の欄にチェック');
    expect(api.createApprovalDelegation).not.toHaveBeenCalled();
  });

  it('**作成**: APIの400は項目のエラーとして返し、コードを出さない', async () => {
    vi.mocked(api.createApprovalDelegation).mockResolvedValue({
      ok: false,
      problem: {
        status: 400,
        title: 'validation_failed',
        errors: [{ field: 'endsAt', message: '期間は30日以内にしてください' }],
      },
    } as never);
    const result = await create({
      delegateId: otherId,
      startsAt: '2026-11-15T09:00',
      endsAt: '2026-12-30T09:00',
      confirm: '1',
    });
    expect(result.message).toBe('入力内容を確認してください。');
    expect(result.errors).toEqual([
      { field: 'endsAt', label: '終了', message: '期間は30日以内にしてください' },
    ]);
    expect(result.errors?.[0]?.message).not.toContain('ENDS_AT');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('**作成**: 期間の重なり(409)は、コードではなく平易な文にする', async () => {
    vi.mocked(api.createApprovalDelegation).mockResolvedValue({
      ok: false,
      problem: { status: 409, detail: '期間が重なる委任があります' },
    } as never);
    const result = await create({
      delegateId: otherId,
      startsAt: '2026-11-15T09:00',
      endsAt: '2026-11-20T09:00',
      confirm: '1',
    });
    expect(result.message).toContain('重なる委任が既にあります');
    expect(result.message).not.toContain('期間が重なる委任があります');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('**作成**: ログイン・組織が変わっていれば送らない', async () => {
    vi.mocked(api.me).mockResolvedValue({
      ok: true,
      data: { ...requesterSession, userId: otherId },
    } as never);
    const result = await create({
      delegateId: otherId,
      startsAt: '2026-11-15T09:00',
      endsAt: '2026-11-20T09:00',
      confirm: '1',
    });
    expect(result.message).toBe(
      '操作中のアカウントまたは組織が変わりました。画面を開き直してください。',
    );
    expect(api.createApprovalDelegation).not.toHaveBeenCalled();
  });

  it('**取消・辞退**: 理由と確認を検査し、同じAPIへ理由だけを送る', async () => {
    const noReason = await revoke('revoked', { reason: '   ', confirm: '1' });
    expect(noReason.message).toBe('取消の理由を入力してください。');
    const longReason = await revoke('declined', { reason: 'あ'.repeat(2001), confirm: '1' });
    expect(longReason.message).toBe('理由は2000文字以内で入力してください。');
    const noConfirm = await revoke('declined', { reason: '合成: 辞退', confirm: '' });
    expect(noConfirm.message).toContain('確認の欄にチェック');
    expect(api.revokeApprovalDelegation).not.toHaveBeenCalled();

    await revoke('declined', { reason: '  合成: 辞退  ', confirm: '1' });
    expect(api.revokeApprovalDelegation).toHaveBeenCalledWith(delegationId, {
      reason: '合成: 辞退',
    });
    expect(redirect).toHaveBeenCalledWith(
      `/settings/delegations?declined=${delegationId}#delegation-received`,
    );
  });

  it('**取消**: 成功すると取消の記録を読み直す画面へ戻る', async () => {
    await revoke('revoked', { reason: '合成: 取消', confirm: '1' });
    expect(redirect).toHaveBeenCalledWith(
      `/settings/delegations?revoked=${delegationId}#delegation-mine`,
    );
  });

  it('**取消**: 取り消し済み(409)は、サーバの再読込を促す', async () => {
    vi.mocked(api.revokeApprovalDelegation).mockResolvedValue({
      ok: false,
      problem: { status: 409, detail: '取り消し済みの委任です' },
    } as never);
    const result = await revoke('revoked', { reason: '合成: 取消', confirm: '1' });
    expect(result.message).toContain('既に取り消されています');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('対象のIDが不正なら、APIを呼ばない', async () => {
    const result = await revokeDelegationAction(
      scope,
      'not-a-uuid',
      'revoked',
      { message: '', attempt: 1 },
      form({ reason: '合成: 取消', confirm: '1' }),
    );
    expect(result.message).toBe('対象の委任を一覧から選び直してください。');
    expect(api.revokeApprovalDelegation).not.toHaveBeenCalled();
  });
});
