/**
 * WP-P4-APR-014: 承認状態機械(TL-02)と経路の整合性検証。
 *
 * 03.5「多段での読み方」の表と `APPROVAL_TRANSITIONS` を 1:1 で固定する。
 * 表を変えるときはこのテストも同じ変更で直す。合成データのみ。
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TRANSITIONS,
  AUTHORITY_TYPES,
  REQUEST_STATES,
  STEP_STATES,
  checkRouteAgainstSteps,
  invalidateApprovalSteps,
  parseApprovalRoute,
  routeHash,
  transitionFor,
  type ApprovalRoute,
  type ApprovalTransition,
  type RequestState,
  type StepState,
  type TransitionPosition,
} from '../../services/api/src/modules/catalog/approval-state';

const approverA = '11111111-1111-4111-8111-111111111111';
const approverB = '22222222-2222-4222-8222-222222222222';

describe('03.5 の遷移表と1:1', () => {
  it('遷移表は 03.5「多段での読み方」の全行と一致する', () => {
    const expected: ApprovalTransition[] = [
      {
        trigger: 'approve',
        stepFrom: 'pending',
        requestFrom: 'pending',
        position: 'intermediate',
        stepTo: 'approved',
        requestTo: 'pending',
        createNextStep: true,
      },
      {
        trigger: 'approve',
        stepFrom: 'pending',
        requestFrom: 'pending',
        position: 'final',
        stepTo: 'approved',
        requestTo: 'approved',
        createNextStep: false,
      },
      {
        trigger: 'reject',
        stepFrom: 'pending',
        requestFrom: 'pending',
        position: 'any',
        stepTo: 'rejected',
        requestTo: 'rejected',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'pending',
        requestFrom: 'pending',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'approved',
        requestFrom: 'pending',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'approved',
        requestFrom: 'approved',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'rejected',
        requestFrom: 'rejected',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'approved',
        requestFrom: 'rejected',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'invalidated',
        requestFrom: 'invalidated',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'expired',
        requestFrom: 'pending',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'edit',
        stepFrom: 'expired',
        requestFrom: 'approved',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'pending',
        createNextStep: false,
      },
      {
        trigger: 'revoke',
        stepFrom: 'approved',
        requestFrom: 'approved',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'invalidated',
        createNextStep: false,
      },
      {
        trigger: 'expire',
        stepFrom: 'pending',
        requestFrom: 'pending',
        position: 'any',
        stepTo: 'expired',
        requestTo: 'unchanged',
        createNextStep: false,
      },
      {
        trigger: 'expire',
        stepFrom: 'pending',
        requestFrom: 'approved',
        position: 'any',
        stepTo: 'expired',
        requestTo: 'unchanged',
        createNextStep: false,
      },
      {
        trigger: 'reassign',
        stepFrom: 'pending',
        requestFrom: 'pending',
        position: 'any',
        stepTo: 'invalidated',
        requestTo: 'unchanged',
        createNextStep: false,
      },
    ];
    expect(APPROVAL_TRANSITIONS).toStrictEqual(expected);
  });

  it('全組み合わせで、表にある遷移だけが定義され、それ以外は未定義(null)になる', () => {
    const triggers = ['approve', 'reject', 'edit', 'revoke', 'expire', 'reassign'] as const;
    const positions: TransitionPosition[] = ['intermediate', 'final', 'any'];
    for (const trigger of triggers)
      for (const stepState of STEP_STATES)
        for (const requestState of REQUEST_STATES)
          for (const position of positions) {
            const expected =
              APPROVAL_TRANSITIONS.find(
                (row) =>
                  row.trigger === trigger &&
                  row.stepFrom === stepState &&
                  (row.requestFrom === 'any' || row.requestFrom === requestState) &&
                  (row.position === 'any' || row.position === position),
              ) ?? null;
            expect(
              transitionFor(trigger, { stepState, requestState, position }),
              `${trigger}/${stepState}/${requestState}/${position}`,
            ).toStrictEqual(expected);
          }
  });

  it.each([
    [
      '承認済みのステップを再度承認',
      { trigger: 'approve', stepState: 'approved', requestState: 'approved', position: 'final' },
    ],
    [
      '却下済みのステップの承認',
      { trigger: 'approve', stepState: 'rejected', requestState: 'rejected', position: 'final' },
    ],
    [
      '却下後の申請で承認',
      { trigger: 'approve', stepState: 'pending', requestState: 'rejected', position: 'final' },
    ],
    [
      '無効化済みのステップの承認',
      {
        trigger: 'approve',
        stepState: 'invalidated',
        requestState: 'invalidated',
        position: 'final',
      },
    ],
    [
      '期限切れのステップの承認',
      { trigger: 'approve', stepState: 'expired', requestState: 'pending', position: 'final' },
    ],
    [
      '承認待ちステップの取消',
      { trigger: 'revoke', stepState: 'pending', requestState: 'pending', position: 'any' },
    ],
    [
      '却下済みステップの取消',
      { trigger: 'revoke', stepState: 'rejected', requestState: 'rejected', position: 'any' },
    ],
    [
      '完了済み申請の変更',
      { trigger: 'edit', stepState: 'approved', requestState: 'completed', position: 'any' },
    ],
  ] as const)('未定義の遷移は null: %s', (_name, input) => {
    expect(transitionFor(input.trigger, input)).toBeNull();
  });

  it.each([
    ['pending', 'pending'],
    ['approved', 'pending'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
    ['approved', 'rejected'],
    ['invalidated', 'invalidated'],
  ] as const)(
    'edit はステップ %s / 申請 %s から新しい版の pending を作る(期限切れは導出なので step は pending のまま)',
    (stepState, requestState) => {
      const transition = transitionFor('edit', { stepState, requestState, position: 'any' });
      expect(transition).toMatchObject({ stepTo: 'invalidated', requestTo: 'pending' });
    },
  );

  it('承認取消済みの申請の変更は、ステップを invalidated のままにする(更新を重ねない)', () => {
    expect(
      transitionFor('edit', {
        stepState: 'invalidated',
        requestState: 'invalidated',
        position: 'any',
      }),
    ).toMatchObject({ stepTo: 'invalidated', requestTo: 'pending', createNextStep: false });
  });

  it('再割当は pending のステップだけを invalidated にし、申請の状態を変えない', () => {
    expect(
      transitionFor('reassign', { stepState: 'pending', requestState: 'pending', position: 'any' }),
    ).toMatchObject({
      stepFrom: 'pending',
      stepTo: 'invalidated',
      requestTo: 'unchanged',
      createNextStep: false,
    });
    for (const stepState of ['approved', 'rejected', 'invalidated', 'expired'] as const)
      expect(
        transitionFor('reassign', { stepState, requestState: 'pending', position: 'any' }),
      ).toBeNull();
    expect(
      transitionFor('reassign', {
        stepState: 'pending',
        requestState: 'approved',
        position: 'any',
      }),
    ).toBeNull();
  });

  it.each(['completed', 'cancelled'] as const)(
    '完了・取下げ済みの申請は変更できない(%s)',
    (requestState) => {
      expect(
        transitionFor('edit', { stepState: 'approved', requestState, position: 'any' }),
      ).toBeNull();
      expect(
        transitionFor('edit', { stepState: 'pending', requestState, position: 'any' }),
      ).toBeNull();
    },
  );
});

describe('経路の形(route / route_hash / route_generation)', () => {
  const route = (): ApprovalRoute => ({
    steps: [
      { stepNo: 1, approverId: approverA, authorityType: 'fixed', resolvedFrom: null },
      { stepNo: 2, approverId: approverB, authorityType: 'fixed', resolvedFrom: 'catalog.fixed' },
    ],
    ruleRef: null,
  });
  const step = (
    stepNo: number,
    approverId: string,
    authorityType = 'fixed',
    overrides: Partial<{ revision: number; route_generation: number; state: string }> = {},
  ) => ({
    id: String(stepNo).repeat(8) + '-1111-4111-8111-111111111111',
    revision: 1,
    route_generation: 1,
    step_no: stepNo,
    approver_id: approverId,
    authority_type: authorityType,
    state: 'approved',
    ...overrides,
  });

  it('2段の経路を受理し、route_hash を再計算できる', () => {
    const value = route();
    const parsed = parseApprovalRoute(value);
    expect(parsed).toStrictEqual(value);
    const hash = routeHash(value);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      checkRouteAgainstSteps({
        route: value,
        routeHash: hash,
        routeGeneration: 1,
        revision: 1,
        steps: [step(1, approverA), step(2, approverB)],
      }),
    ).toStrictEqual({ ok: true, route: value, stepCount: 2 });
  });

  it('route_hash の改ざん・段数不一致・承認者不一致・世代不一致を拒否する', () => {
    const value = route();
    const hash = routeHash(value);
    const base = {
      route: value,
      routeHash: hash,
      routeGeneration: 1,
      revision: 1,
      steps: [step(1, approverA), step(2, approverB)],
    };
    expect(checkRouteAgainstSteps({ ...base, routeHash: '0'.repeat(64) })).toStrictEqual({
      ok: false,
      reason: 'route_hash_mismatch',
    });
    expect(checkRouteAgainstSteps({ ...base, steps: [step(1, approverA)] })).toStrictEqual({
      ok: false,
      reason: 'route_step_count',
    });
    expect(
      checkRouteAgainstSteps({ ...base, steps: [step(1, approverA), step(2, approverA)] }),
    ).toStrictEqual({ ok: false, reason: 'route_step_mismatch' });
    expect(checkRouteAgainstSteps({ ...base, routeGeneration: 2 })).toStrictEqual({
      ok: false,
      reason: 'route_generation_mismatch',
    });
    expect(
      checkRouteAgainstSteps({
        ...base,
        steps: [step(1, approverA), step(2, approverB, 'fixed', { route_generation: 2 })],
      }),
    ).toStrictEqual({ ok: false, reason: 'route_generation_mismatch' });
  });

  it('route が NULL の版は legacy の1行だけを許す', () => {
    const legacy = step(1, approverA, 'legacy');
    expect(
      checkRouteAgainstSteps({
        route: null,
        routeHash: null,
        routeGeneration: 1,
        revision: 1,
        steps: [legacy],
      }),
    ).toStrictEqual({ ok: true, route: null, stepCount: 1 });

    expect(
      checkRouteAgainstSteps({
        route: null,
        routeHash: null,
        routeGeneration: 1,
        revision: 1,
        steps: [legacy, step(2, approverB)],
      }),
    ).toStrictEqual({ ok: false, reason: 'route_step_count' });
    expect(
      checkRouteAgainstSteps({
        route: null,
        routeHash: 'a'.repeat(64),
        routeGeneration: 1,
        revision: 1,
        steps: [legacy],
      }),
    ).toStrictEqual({ ok: false, reason: 'route_hash_mismatch' });
    expect(
      checkRouteAgainstSteps({
        route: null,
        routeHash: null,
        routeGeneration: 2,
        revision: 1,
        steps: [legacy],
      }),
    ).toStrictEqual({ ok: false, reason: 'route_generation_mismatch' });
    expect(
      checkRouteAgainstSteps({
        route: null,
        routeHash: null,
        routeGeneration: 1,
        revision: 1,
        steps: [step(1, approverA, 'fixed')],
      }),
    ).toStrictEqual({ ok: false, reason: 'route_step_mismatch' });
  });

  it.each([
    ['未知の権限種別', { ...route(), steps: [{ ...route().steps[0]!, authorityType: 'owner' }] }],
    ['stepNo の飛び', { ...route(), steps: [{ ...route().steps[0]!, stepNo: 2 }] }],
    [
      '重複した承認者',
      { ...route(), steps: [route().steps[0]!, { ...route().steps[1]!, approverId: approverA }] },
    ],
    ['未知のキー', { ...route(), extra: true }],
    ['空の段', { steps: [], ruleRef: null }],
  ])('不正な経路を拒否する: %s', (_name, value) => {
    expect(parseApprovalRoute(value)).toBeNull();
  });

  it('権限種別の許容値は legacy/fixed/manager/department_head', () => {
    expect(AUTHORITY_TYPES).toStrictEqual(['legacy', 'fixed', 'manager', 'department_head']);
  });

  it('申請状態の集合は local_service_request の CHECK と一致する', () => {
    expect(REQUEST_STATES).toStrictEqual([
      'pending',
      'approved',
      'rejected',
      'invalidated',
      'completed',
      'cancelled',
    ]);
    expect(STEP_STATES).toStrictEqual([
      'pending',
      'approved',
      'rejected',
      'invalidated',
      'cancelled',
      'expired',
    ]);
  });

  it('型の網羅性(実行時の値ではない)', () => {
    const stepState: StepState = 'pending';
    const requestState: RequestState = 'pending';
    expect([stepState, requestState]).toStrictEqual(['pending', 'pending']);
  });
});

describe('承認ステップの無効化は常に遷移表を通す (WP-P4-APR-018 段階B)', () => {
  type Step = Parameters<typeof invalidateApprovalSteps>[1]['steps'][number];
  type Input = Parameters<typeof invalidateApprovalSteps>[1];
  const request = (state: RequestState): Input['request'] => ({
    id: '11111111-1111-4111-8111-111111111111',
    organization_id: '22222222-2222-4222-8222-222222222222',
    revision: 1,
    version: 1,
    state,
    snapshot_hash: 'synthetic-hash',
  });
  const step = (state: string, id: string, stepNo = 1, routeGeneration = 1): Step => ({
    id,
    request_id: '11111111-1111-4111-8111-111111111111',
    organization_id: '22222222-2222-4222-8222-222222222222',
    revision: 1,
    route_generation: routeGeneration,
    step_no: stepNo,
    approver_id: approverA,
    authority_type: 'manager',
    state,
    snapshot_hash: 'synthetic-hash',
    reason: null,
    expires_at: new Date('2026-11-14T00:00:00Z'),
    decided_at: null,
    decided_by: null,
    resolved_from: 'manager',
  });
  /** 更新の SQL と値を記録するだけの偽クライアント。 */
  const fake = () => {
    const calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    return {
      calls,
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        return { rowCount: 1, rows: [{ id: 'updated', version: 2 }] };
      },
    };
  };
  const invalidate = (
    client: ReturnType<typeof fake>,
    input: Input,
  ): ReturnType<typeof invalidateApprovalSteps> =>
    invalidateApprovalSteps(
      client as unknown as Parameters<typeof invalidateApprovalSteps>[0],
      input,
    );

  it('全行が invalidated で申請が invalidated の edit は、従来どおり pending にする', async () => {
    const client = fake();
    const result = await invalidate(client, {
      request: request('invalidated'),
      steps: [step('invalidated', 'a')],
      trigger: 'edit',
      reason: '合成: 申請内容の変更',
    });
    expect(result).toEqual({ invalidated: [], requestState: 'pending' });
    // ステップの更新は行わず、申請の状態だけを更新する。
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.sql).toContain('UPDATE local_service_request');
    expect(client.calls[0]!.values?.[1]).toBe('pending');
  });

  it.each(['pending', 'approved', 'rejected'] as const)(
    '全行が invalidated の edit は、申請 %s では遷移表に行が無いため拒否する',
    async (requestState) => {
      const client = fake();
      await expect(
        invalidate(client, {
          request: request(requestState),
          steps: [step('invalidated', 'a')],
          trigger: 'edit',
          reason: '合成: 申請内容の変更',
        }),
      ).rejects.toMatchObject({ status: 409 });
      // 拒否したら何も書き込まない。
      expect(client.calls).toHaveLength(0);
    },
  );

  it('全行が invalidated の revoke は拒否する', async () => {
    const client = fake();
    await expect(
      invalidate(client, {
        request: request('invalidated'),
        steps: [step('invalidated', 'a')],
        trigger: 'revoke',
        reason: '合成: 取消',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.calls).toHaveLength(0);
  });

  it('一部だけが invalidated(再割当で置き換えられた旧世代)のときは、残りの行だけを無効化する', async () => {
    const client = fake();
    const old = step('invalidated', 'old', 2, 1);
    const current = step('pending', 'current', 2, 2);
    const result = await invalidate(client, {
      request: request('pending'),
      steps: [old, current],
      trigger: 'edit',
      reason: '合成: 申請内容の変更',
    });
    expect(result).toEqual({ invalidated: [current], requestState: 'pending' });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]!.sql).toContain('UPDATE local_request_approval');
    expect(client.calls[0]!.values?.[0]).toBe('current');
    expect(client.calls[1]!.sql).toContain('UPDATE local_service_request');
  });
});
