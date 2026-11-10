import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATIONS_METRICS,
  operationsDeadlineQuery,
  operationsHref,
  operationsMetricQuery,
  operationsQueueHref,
  operationsScopeLabel,
  operationsSlaText,
  parseOperationsGroup,
  parseOperationsOverview,
} from '../../apps/web/src/lib/operations-overview';
import { safeReturnTo, withReturnTo } from '../../apps/web/src/lib/navigation';
import { api } from '../../apps/web/src/lib/api';

vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const groupId = '04000000-0000-4000-8000-000000000001';
const openStates = ['new', 'assigned', 'in_progress', 'pending'];

const aggregate = () => ({
  scope: 'organization',
  counts: { open: 21, unassigned: 7, mine: 5, pending: 3, breached: 2, critical: 1 },
});

describe('運営状況の一括応答', () => {
  it('6件数と組織scopeを検証し、既知フィールドだけを取り出す', () => {
    const input = {
      ...aggregate(),
      extra: 'discard',
      counts: { ...aggregate().counts, unrelated: 99 },
    };
    const parsed = parseOperationsOverview(input);
    expect(parsed).toEqual(aggregate());
    input.counts.open = 999;
    expect(parsed?.counts.open).toBe(21);
  });
  it('正当なゼロ件の一括応答を受け付ける', () => {
    const counts = Object.fromEntries(OPERATIONS_METRICS.map(({ id }) => [id, 0]));
    expect(parseOperationsOverview({ scope: 'organization', counts })?.counts).toEqual(counts);
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { scope: 'own', counts: aggregate().counts },
    { scope: 'organization', counts: null },
    { scope: 'organization', counts: [] },
  ])('形状またはscopeが不正な応答を受け付けない: %j', (value) => {
    expect(parseOperationsOverview(value)).toBeNull();
  });
  it.each([-1, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '1項目でも不正なら集計全体を無効にする: %s',
    (value) => {
      for (const { id } of OPERATIONS_METRICS)
        expect(
          parseOperationsOverview({
            ...aggregate(),
            counts: { ...aggregate().counts, [id]: value },
          }),
        ).toBeNull();
    },
  );
  it('欠落フィールドや継承フィールドをゼロ補完しない', () => {
    const missing: Partial<ReturnType<typeof aggregate>['counts']> = { ...aggregate().counts };
    delete missing.mine;
    expect(parseOperationsOverview({ ...aggregate(), counts: missing })).toBeNull();
    expect(
      parseOperationsOverview({ ...aggregate(), counts: Object.create(aggregate().counts) }),
    ).toBeNull();
  });
  it('一括APIを1回呼び、group以外の条件を生成しない', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(aggregate()));
    vi.stubGlobal('fetch', fetchMock);
    const result = await api.ticketOverview(groupId);
    expect(result).toMatchObject({ ok: true, data: aggregate() });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/tickets/overview');
    expect([...url.searchParams]).toEqual([['group', groupId]]);
  });
  it.each([400, 403, 503])('HTTP %iは失敗として維持する', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status, title: 'fixture failure' }, { status })),
    );
    expect(await api.ticketOverview()).toMatchObject({ ok: false, problem: { status } });
  });
  it('HTTP200でも不正DTOは502の失敗になり、数値を返さない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ...aggregate(), counts: { ...aggregate().counts, critical: -1 } }),
      ),
    );
    const result = await api.ticketOverview();
    expect(result).toMatchObject({ ok: false, problem: { status: 502 } });
    expect(result).not.toHaveProperty('data');
  });
  it('応答本文の読取失敗も独立したAPI失敗へ変換し、画面全体へthrowしない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('private-stream-error'));
              },
            }),
          ),
      ),
    );
    const result = await api.ticketOverview();
    expect(result).toMatchObject({ ok: false, problem: { status: 503 } });
    expect(JSON.stringify(result)).not.toContain('private-stream-error');
  });
});

describe('運営状況の母集団と一覧条件', () => {
  it('未完了は4状態に限定し、解決済みと終端を含めない', () => {
    const query = operationsMetricQuery('open', '');
    expect([...query]).toEqual(openStates.map((state) => ['state', state]));
  });

  it.each([
    ['unassigned', 'assignment', 'unassigned'],
    ['mine', 'assignment', 'mine'],
    ['breached', 'sla', 'breached'],
    ['critical', 'priority', 'critical'],
  ] as const)('%sは未完了と既存API条件を組み合わせる', (id, key, value) => {
    const query = operationsMetricQuery(id, groupId);
    expect(query.getAll('state')).toEqual(openStates);
    expect(query.get('group')).toBe(groupId);
    expect(query.get(key)).toBe(value);
    expect([...query].filter(([name]) => name !== 'state' && name !== 'group')).toEqual([
      [key, value],
    ]);
  });

  it('確認待ちはpendingだけで、応答期限の別条件を混ぜない', () => {
    expect([...operationsMetricQuery('pending', 'ungrouped')]).toEqual([
      ['group', 'ungrouped'],
      ['state', 'pending'],
    ]);
  });

  it('期限確認は停止中を除く3状態、期限順でcursor/期間条件がない', () => {
    expect([...operationsDeadlineQuery('mine')]).toEqual([
      ['group', 'mine'],
      ['state', 'new'],
      ['state', 'assigned'],
      ['state', 'in_progress'],
      ['sort', 'deadline'],
    ]);
  });

  it('API用の全条件を一覧リンクへ保持し、条件生成間で変更が漏れない', () => {
    for (const group of ['', 'mine', 'ungrouped', groupId]) {
      for (const metric of OPERATIONS_METRICS) {
        const query = operationsMetricQuery(metric.id, group);
        const url = new URL(operationsQueueHref(query), 'https://solvi.local');
        expect(url.pathname).toBe('/ops');
        expect([...url.searchParams]).toEqual([...query]);
        query.set('group', 'changed');
        expect(operationsMetricQuery(metric.id, group).get('group')).toBe(group || null);
      }
    }
  });

  it('一覧リンクに本人/組織/カーソル/任意戻り先を追加しない', () => {
    const query = operationsDeadlineQuery(groupId);
    for (const key of [
      'requester',
      'organizationId',
      'cursorId',
      'cursorCreatedAt',
      'returnTo',
      'limit',
      'page',
    ])
      query.set(key, 'untrusted');
    const target = new URL(operationsQueueHref(query), 'https://solvi.local');
    expect([...target.searchParams]).toEqual([...operationsDeadlineQuery(groupId)]);
  });
});

describe('運営状況の範囲保持', () => {
  it.each(['', 'mine', 'ungrouped', groupId])('サポートする範囲%sを保持する', (group) => {
    expect(parseOperationsGroup({ group })).toEqual({ group, error: null });
  });

  it('未知キーのqueryや本人指定を採用しない', () => {
    expect(
      parseOperationsGroup({ requester: 'other', organizationId: 'other', state: 'closed' }),
    ).toEqual({ group: '', error: null });
  });

  it.each(['unknown', ' mine ', 'https://other.invalid', 'a'.repeat(36)])(
    '不正範囲%sを解除せずエラーにする',
    (group) => {
      const parsed = parseOperationsGroup({ group });
      expect(parsed.group).toBe(group);
      expect(parsed.error).toContain('選び直し');
    },
  );

  it('複数値を1つとして黙って採用せず、修正用に最初の値を保持する', () => {
    const parsed = parseOperationsGroup({ group: [groupId, 'mine'] });
    expect(parsed.group).toBe(groupId);
    expect(parsed.error).toContain('1つ');
  });

  it('候補の欠落や未取得を組織全体という名称で表示しない', () => {
    expect(operationsScopeLabel(groupId, [])).toBe('選択済みのグループ（名称未取得）');
    expect(operationsScopeLabel(groupId, [{ id: groupId, name: '端末サポート' }])).toBe(
      '端末サポート',
    );
    expect(operationsScopeLabel('', [])).toBe('組織全体');
    expect(operationsScopeLabel('mine', [])).toBe('自分のグループ');
    expect(operationsScopeLabel('ungrouped', [])).toBe('グループ未割当');
  });

  it('詳細の戻り先は選択した範囲のローカル画面を保持する', () => {
    const href = operationsHref(groupId);
    const detail = new URL(withReturnTo('/ops/tickets/ticket-id', href), 'https://solvi.local');
    expect(safeReturnTo(detail.searchParams.get('returnTo'))).toBe(href);
    expect(new URL(href, 'https://solvi.local').searchParams.get('group')).toBe(groupId);
    expect(operationsHref('')).toBe('/ops/overview');
  });
});

describe('解決SLAの未設定と期限境界', () => {
  it('目標が存在しない場合を残り0秒にしない', () => {
    expect(operationsSlaText()).toBe('目標未設定');
    expect(operationsSlaText({ remainingSeconds: null, breached: false })).toBe('目標未設定');
  });
  it('残り0秒をあと1分にしない', () => {
    expect(operationsSlaText({ remainingSeconds: 0, breached: false })).toBe('期限到達');
  });
  it('超過と残時間を既存の時間表現で区別する', () => {
    expect(operationsSlaText({ remainingSeconds: -3600, breached: true })).toBe('1時間超過');
    expect(operationsSlaText({ remainingSeconds: 7200, breached: false })).toBe('あと2時間');
  });
});
