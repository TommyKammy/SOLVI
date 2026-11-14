// WP-P4-APR-016 stage A: pure helpers for approval-rule admin screens.
import { describe, expect, it } from 'vitest';
import {
  approvalHref,
  approvalNoticeText,
  formatRelationshipChangeSide,
  parseApprovalRuleSteps,
  parseApprovalsQuery,
  parseRelationshipHistoryQuery,
  PRE_SUBMIT_REASON_TEXT,
  relationshipChangeLabel,
  relationshipHistoryHref,
  requestApprovalTimeline,
  requestHistoryVersions,
  requestRouteDecision,
  resolverPreviewText,
  resolverReasonText,
  stepLabel,
  stepStateLabel,
  summarizeApprovalSteps,
} from '../../apps/web/src/lib/approval-route';
import type { ApprovalRuleStep } from '@solvi/shared/catalog';

const approverA = '01900000-0000-4000-8000-00000000000a';
const approverB = '01900000-0000-4000-8000-00000000000b';
const ruleId = '01900000-0000-4000-8000-000000000010';
const itemId = '01900000-0000-4000-8000-000000000020';
const requesterId = '01900000-0000-4000-8000-000000000030';

describe('approval step labels', () => {
  it('summarizes fixed, manager and department head steps in order', () => {
    const steps: ApprovalRuleStep[] = [
      { type: 'manager', onUnresolved: 'department_head' },
      { type: 'fixed', approverId: approverA },
    ];
    expect(steps.map(stepLabel)).toEqual(['上長（未解決時は部署長へ）', '固定承認者']);
    expect(summarizeApprovalSteps(steps)).toBe('上長（未解決時は部署長へ） → 固定承認者');
    expect(summarizeApprovalSteps([{ type: 'manager', onUnresolved: 'reject' }])).toBe(
      '上長（未解決時は拒否）',
    );
    expect(summarizeApprovalSteps([{ type: 'department_head', onUnresolved: 'reject' }])).toBe(
      '部署長',
    );
  });

  it('does not guess at broken stored steps', () => {
    expect(summarizeApprovalSteps([], true)).toBe('段がありません');
    expect(summarizeApprovalSteps([], false)).toBe('内容を確認できません');
  });
});

describe('approval rule form parsing', () => {
  it('builds the shared step schema from three ordered rows', () => {
    const result = parseApprovalRuleSteps([
      { type: 'manager', onUnresolved: 'department_head' },
      { type: 'fixed', approverId: approverA },
      { type: 'department_head', onUnresolved: 'reject' },
    ]);
    expect(result).toEqual({
      ok: true,
      steps: [
        { type: 'manager', onUnresolved: 'department_head' },
        { type: 'fixed', approverId: approverA },
        { type: 'department_head', onUnresolved: 'reject' },
      ],
    });
  });

  it('allows blank trailing rows and forces department head to reject unresolved', () => {
    const result = parseApprovalRuleSteps([
      { type: 'department_head' },
      { type: '' },
      { type: '' },
    ]);
    expect(result).toEqual({
      ok: true,
      steps: [{ type: 'department_head', onUnresolved: 'reject' }],
    });
  });

  it('rejects gaps, unknown types, missing approvers and empty rules', () => {
    expect(
      parseApprovalRuleSteps([
        { type: 'manager' },
        { type: '' },
        { type: 'fixed', approverId: approverA },
      ]),
    ).toMatchObject({ ok: false, message: expect.stringContaining('前の段から順に') });
    expect(parseApprovalRuleSteps([{ type: 'group' }])).toMatchObject({
      ok: false,
      message: expect.stringContaining('種別'),
    });
    expect(parseApprovalRuleSteps([{ type: 'fixed' }])).toMatchObject({
      ok: false,
      message: expect.stringContaining('固定承認者'),
    });
    expect(parseApprovalRuleSteps([{ type: 'fixed', approverId: 'free-text' }])).toMatchObject({
      ok: false,
      message: expect.stringContaining('固定承認者'),
    });
    expect(parseApprovalRuleSteps([{ type: 'manager', onUnresolved: 'manager' }])).toMatchObject({
      ok: false,
      message: expect.stringContaining('扱い'),
    });
    expect(parseApprovalRuleSteps([{ type: '' }, { type: '' }, { type: '' }])).toMatchObject({
      ok: false,
      message: expect.stringContaining('1段以上'),
    });
  });

  it('rejects more than three rows', () => {
    expect(
      parseApprovalRuleSteps([
        { type: 'manager' },
        { type: 'manager' },
        { type: 'manager' },
        { type: 'manager' },
      ]),
    ).toMatchObject({ ok: false, message: expect.stringContaining('3段以内') });
  });
});

describe('resolver reason text', () => {
  it('keeps the API Japanese message and adds step and missing setting', () => {
    expect(
      resolverReasonText({
        code: 'manager_unset',
        message: '申請者の上長が未設定です',
        missing: 'manager',
        stepNo: 1,
      }),
    ).toBe('段1: 申請者の上長が未設定です（足りない設定: 上長）');
  });

  it('never shows an internal exception shape when the reason is missing', () => {
    expect(resolverReasonText(null)).toBe('経路を解決できませんでした。');
    expect(resolverReasonText({})).toBe('経路を解決できませんでした。');
    expect(resolverReasonText({ message: '  ' })).toBe('経路を解決できませんでした。');
  });
});

describe('pre-submission resolver reason text', () => {
  const expected: Record<string, string> = {
    requester_not_active_member: '申請者の所属が確認できないため、このままでは申請できません。',
    rule_unavailable: '承認ルールが現在使えないため、このままでは申請できません。',
    rule_invalid: '承認ルールの内容を確認できないため、このままでは申請できません。',
    fixed_approver_invalid:
      '固定承認者が現在有効な承認者ではないため、このままでは申請できません。',
    fixed_approver_self: '固定承認者が申請者本人のため、このままでは申請できません。',
    manager_unset: '上長が設定されていないため、このままでは申請できません。',
    manager_inactive: '上長が現在有効な所属ではないため、このままでは申請できません。',
    manager_self: '上長が申請者本人のため、このままでは申請できません。',
    department_head_missing: '部署長が設定されていないため、このままでは申請できません。',
    duplicate_approver: '同じ承認者が複数の段に指定されているため、このままでは申請できません。',
    requester_selected_missing: '承認者が選ばれていないため、このままでは申請できません。',
    requester_selected_invalid:
      '承認者が現在有効な承認者ではないため、このままでは申請できません。',
    requester_selected_self: '承認者が申請者本人のため、このままでは申請できません。',
  };

  it('covers every resolver failure code without using the API rejection message', () => {
    expect(Object.keys(PRE_SUBMIT_REASON_TEXT).sort()).toEqual(Object.keys(expected).sort());
    for (const [code, text] of Object.entries(expected)) {
      expect(resolverPreviewText({ code, missing: 'manager', message: 'PRIVATE_MESSAGE' })).toBe(
        text,
      );
    }
  });

  it('adds the step number and never repeats the past-tense rejection wording', () => {
    const text = resolverPreviewText({
      code: 'manager_unset',
      message: '申請者の上長が未設定です。承認ルールの設定により申請を拒否しました',
      missing: 'manager',
      stepNo: 1,
    });
    expect(text).toBe('段1: 上長が設定されていないため、このままでは申請できません。');
    expect(text).not.toContain('拒否しました');
    expect(text).not.toContain('PRIVATE_MESSAGE');
  });

  it('uses one general sentence for unknown or missing codes', () => {
    expect(resolverPreviewText({ code: 'unexpected', stepNo: 2 })).toBe(
      '段2: 承認の経路を決められないため、このままでは申請できません。',
    );
    expect(resolverPreviewText({})).toBe(
      '承認の経路を決められないため、このままでは申請できません。',
    );
    expect(resolverPreviewText(null)).toBe(
      '承認の経路を決められないため、このままでは申請できません。',
    );
    expect(resolverPreviewText({ code: 'manager_unset', stepNo: 0 })).toBe(
      '上長が設定されていないため、このままでは申請できません。',
    );
  });
});

describe('approval admin query and links', () => {
  it('accepts only known confirm values and UUID selections', () => {
    expect(
      parseApprovalsQuery({
        rule: ruleId.toUpperCase(),
        confirm: 'deactivate',
        unresolved: '1',
        previewKind: 'item',
        previewItemId: itemId,
        previewRequesterId: requesterId,
      }),
    ).toEqual({
      query: { rule: ruleId, confirm: 'deactivate', unresolved: true },
      preview: { kind: 'item', ruleId: '', itemId, requesterId },
    });
    expect(
      parseApprovalsQuery({
        rule: 'not-a-uuid',
        confirm: 'drop-table',
        unresolved: 'yes',
        previewKind: 'other',
      }),
    ).toEqual({
      query: { rule: '', confirm: null, unresolved: false },
      preview: { kind: '', ruleId: '', itemId: '', requesterId: '' },
    });
  });

  it('builds fixed internal links, clears confirmation when the rule changes and caps error text', () => {
    const query = { rule: ruleId, confirm: 'deactivate' as const, unresolved: false };
    expect(approvalHref(query, { notice: 'deactivated' })).toBe(
      `/ops/approvals?rule=${ruleId}&confirm=deactivate&notice=deactivated`,
    );
    expect(approvalHref(query, { rule: approverB })).toBe(`/ops/approvals?rule=${approverB}`);
    expect(approvalHref(query, { rule: null })).toBe('/ops/approvals');
    expect(approvalHref(query, { error: 'x'.repeat(600) })).toContain('error=' + 'x'.repeat(500));
    expect(approvalHref(query, { notice: 'not-a-notice' as never })).toBe(
      `/ops/approvals?rule=${ruleId}&confirm=deactivate`,
    );
  });

  it('uses fixed Japanese notices only', () => {
    expect(approvalNoticeText('revised')).toContain('新しい版');
    expect(approvalNoticeText('unknown')).toBeNull();
    expect(approvalNoticeText(undefined)).toBeNull();
  });

  it('shows rule enablement without accepting arbitrary text', () => {
    expect(
      approvalHref(
        { rule: '', confirm: null, unresolved: false },
        {
          confirm: 'enable-routing',
        },
      ),
    ).toBe('/ops/approvals?confirm=enable-routing');
    expect(
      approvalHref(
        { rule: '', confirm: null, unresolved: false },
        {
          confirm: 'disable-routing',
        },
      ),
    ).toBe('/ops/approvals?confirm=disable-routing');
  });
});

describe('relationship change display', () => {
  it('labels every change type and does not echo unknown values', () => {
    expect(relationshipChangeLabel('manager')).toBe('上長');
    expect(relationshipChangeLabel('department_head_assigned')).toBe('部署長の設定');
    expect(relationshipChangeLabel('unexpected')).toBe('種類を確認できません');
  });

  it('formats profile and department-head states from API fields only', () => {
    expect(
      formatRelationshipChangeSide('manager', {
        managerDisplayName: '合成 上長',
        primaryDepartmentName: null,
      }),
    ).toEqual(['上長: 合成 上長', '主部署: 未設定']);
    expect(
      formatRelationshipChangeSide('department_head_assigned', {
        departmentName: '合成部署',
        headDisplayName: '合成 部署長',
        validFrom: '2026-11-01T00:00:00.000Z',
        validUntil: null,
      }),
    ).toEqual(['部署: 合成部署', '部署長: 合成 部署長', '開始: 2026-11-01']);
    expect(formatRelationshipChangeSide('department_head_removed', null)).toEqual(['なし']);
  });
});

describe('relationship history query', () => {
  it('defaults to the last 30 days and a valid page', () => {
    expect(parseRelationshipHistoryQuery({}, '2026-11-14')).toEqual({
      from: '2026-10-16',
      to: '2026-11-14',
      page: 1,
    });
    expect(
      parseRelationshipHistoryQuery(
        { from: '2026-02-30', to: 'not-a-date', page: '-2' },
        '2026-11-14',
      ),
    ).toEqual({ from: '2026-10-16', to: '2026-11-14', page: 1 });
  });

  it('keeps explicit valid values and builds an internal link', () => {
    const query = parseRelationshipHistoryQuery(
      { from: '2026-01-01', to: '2026-02-01', page: '3' },
      '2026-11-14',
    );
    expect(query).toEqual({ from: '2026-01-01', to: '2026-02-01', page: 3 });
    expect(relationshipHistoryHref(query, { page: 2 })).toBe(
      '/ops/approvals/changes?from=2026-01-01&to=2026-02-01&page=2',
    );
    expect(relationshipHistoryHref(query, { page: 1 })).toBe(
      '/ops/approvals/changes?from=2026-01-01&to=2026-02-01',
    );
  });
});

describe('requester route display and submit gating (stage B)', () => {
  const ruleRoute = {
    itemVersion: 3,
    resolved: true,
    mode: 'rule',
    ruleRoutingEnabled: true,
    rule: { id: ruleId },
    steps: [
      { stepNo: 1, authorityType: 'manager', approverName: '合成 上長' },
      { stepNo: 2, authorityType: 'fixed', approverName: '合成 承認者' },
    ],
  };

  it('keeps the current behaviour for items without a rule', () => {
    expect(requestRouteDecision({ ruleId: null, itemVersion: 3, route: null })).toEqual({
      usesRule: false,
      showSteps: false,
      blocked: false,
      reason: null,
    });
    expect(
      requestRouteDecision({
        ruleId: null,
        itemVersion: 3,
        route: { ...ruleRoute, ruleRoutingEnabled: false, mode: 'fixed' },
      }),
    ).toEqual({ usesRule: false, showSteps: false, blocked: false, reason: null });
  });

  it('blocks a rule item when the route cannot be read (fail closed)', () => {
    const decision = requestRouteDecision({ ruleId, itemVersion: 3, route: null });
    expect(decision).toMatchObject({ usesRule: true, showSteps: false, blocked: true });
    expect(decision.reason).toContain('承認経路を確認できませんでした');
  });

  it('uses the compatible display when the organisation has rules disabled', () => {
    expect(
      requestRouteDecision({
        ruleId,
        itemVersion: 3,
        route: { ...ruleRoute, ruleRoutingEnabled: false, mode: 'fixed' },
      }),
    ).toEqual({ usesRule: false, showSteps: false, blocked: false, reason: null });
  });

  it('shows resolved steps and blocks unresolved rules with the API reason', () => {
    expect(requestRouteDecision({ ruleId, itemVersion: 3, route: ruleRoute })).toEqual({
      usesRule: true,
      showSteps: true,
      blocked: false,
      reason: null,
    });
    const unresolved = requestRouteDecision({
      ruleId,
      itemVersion: 3,
      route: {
        ...ruleRoute,
        resolved: false,
        steps: [],
        reason: {
          code: 'manager_unset',
          message: '申請者の上長が未設定です',
          missing: 'manager',
          stepNo: 1,
        },
      },
    });
    expect(unresolved).toMatchObject({ usesRule: true, showSteps: false, blocked: true });
    expect(unresolved.reason).toBe('段1: 上長が設定されていないため、このままでは申請できません。');
  });

  it('blocks a rule item when the rule is unavailable even without rule info', () => {
    const decision = requestRouteDecision({
      ruleId,
      itemVersion: 3,
      route: {
        ...ruleRoute,
        resolved: false,
        rule: null,
        steps: [],
        reason: {
          code: 'rule_unavailable',
          message: '承認ルールが無効か、存在しません。承認ルールの設定を確認してください',
          missing: 'rule',
        },
      },
    });
    expect(decision).toMatchObject({ usesRule: true, showSteps: false, blocked: true });
    expect(decision.reason).toContain('承認ルール');
  });

  it('does not guess at a route for a different item version', () => {
    expect(requestRouteDecision({ ruleId, itemVersion: 2, route: ruleRoute })).toEqual({
      usesRule: true,
      showSteps: false,
      blocked: false,
      reason: null,
    });
    expect(
      requestRouteDecision({
        ruleId,
        itemVersion: 3,
        route: { ...ruleRoute, rule: { id: approverA } },
      }),
    ).toEqual({ usesRule: true, showSteps: false, blocked: false, reason: null });
  });
});

describe('request approval timeline (stage B)', () => {
  it('lists created and not-yet-created steps in route order', () => {
    const timeline = requestApprovalTimeline({
      route: {
        steps: [
          { stepNo: 1, authorityType: 'manager', approverName: '合成 上長' },
          { stepNo: 2, authorityType: 'fixed', approverName: '合成 承認者' },
          { stepNo: 3, authorityType: 'department_head', approverName: '合成 部署長' },
        ],
      },
      steps: [
        {
          stepNo: 1,
          state: 'approved',
          approverName: '合成 上長',
          authorityType: 'manager',
          reason: null,
          decidedAt: '2026-11-14T01:00:00Z',
          expiresAt: '2026-11-17T01:00:00Z',
        },
        {
          stepNo: 2,
          state: 'pending',
          approverName: '合成 承認者',
          authorityType: 'fixed',
          reason: null,
          decidedAt: null,
          expiresAt: '2026-11-17T02:00:00Z',
        },
      ],
    });
    expect(timeline.map((step) => [step.stepNo, step.state, step.pendingCreation])).toEqual([
      [1, 'approved', false],
      [2, 'pending', false],
      [3, null, true],
    ]);
    expect(timeline[2]!.approverName).toBe('合成 部署長');
    expect(timeline[1]!.expiresAt).toBe('2026-11-17T02:00:00Z');
  });

  it('keeps legacy route-less requests as their created steps', () => {
    const timeline = requestApprovalTimeline({
      route: null,
      steps: [
        {
          stepNo: 1,
          state: 'rejected',
          approverName: '合成 承認者',
          authorityType: 'legacy',
          reason: '合成の却下理由',
          decidedAt: '2026-11-14T01:00:00Z',
          expiresAt: '2026-11-17T01:00:00Z',
        },
      ],
    });
    expect(timeline).toEqual([
      {
        stepNo: 1,
        authorityType: 'legacy',
        approverName: '合成 承認者',
        state: 'rejected',
        decidedAt: '2026-11-14T01:00:00Z',
        reason: '合成の却下理由',
        expiresAt: '2026-11-17T01:00:00Z',
        pendingCreation: false,
      },
    ]);
    expect(requestApprovalTimeline({ route: null, steps: null })).toEqual([]);
  });

  it('labels every step state and never echoes unknown values', () => {
    expect(stepStateLabel('pending')).toBe('承認待ち');
    expect(stepStateLabel('approved')).toBe('承認');
    expect(stepStateLabel('rejected')).toBe('却下');
    expect(stepStateLabel('invalidated')).toBe('無効');
    expect(stepStateLabel('expired')).toBe('期限切れ');
    expect(stepStateLabel(null)).toBe('状態を確認できません');
    expect(stepStateLabel('unexpected')).toBe('状態を確認できません');
  });
});

describe('request history versions (stage C)', () => {
  const row = (
    id: string,
    revision: number,
    state: string,
    decidedAt: string | null,
    approverName = '合成 承認者',
  ) => ({
    id,
    revision,
    state,
    decidedAt,
    approverName,
    reason: null,
    inputs: {},
    item: { version: 1, definition: {} },
  });

  it('collapses two approval rows of the same revision into one version', () => {
    const versions = requestHistoryVersions(
      [
        row('a', 1, 'approved', '2026-11-14T01:00:00Z', '合成 上長'),
        row('b', 1, 'approved', '2026-11-14T02:00:00Z'),
      ],
      1,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      revision: 1,
      state: 'approved',
      decidedAt: '2026-11-14T02:00:00Z',
      current: true,
    });
    expect(versions[0]!.rows.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('keeps a pending second step as the version result and marks past versions', () => {
    const versions = requestHistoryVersions(
      [
        row('old', 1, 'invalidated', '2026-11-10T01:00:00Z'),
        row('new1', 2, 'approved', '2026-11-11T01:00:00Z'),
        row('new2', 2, 'pending', null),
      ],
      2,
    );
    expect(versions.map((version) => [version.revision, version.state, version.current])).toEqual([
      [1, 'invalidated', false],
      [2, 'pending', true],
    ]);
    expect(versions[1]!.decidedAt).toBe('2026-11-11T01:00:00Z');
  });

  it('keeps one-step and legacy history as a single version with its decision time', () => {
    const versions = requestHistoryVersions(
      [row('legacy', 1, 'rejected', '2026-11-14T01:00:00Z', '合成 承認者')],
      1,
    );
    expect(versions).toEqual([
      {
        revision: 1,
        state: 'rejected',
        decidedAt: '2026-11-14T01:00:00Z',
        current: true,
        rows: [row('legacy', 1, 'rejected', '2026-11-14T01:00:00Z', '合成 承認者')],
      },
    ]);
    expect(requestHistoryVersions([], 1)).toEqual([]);
  });
});
