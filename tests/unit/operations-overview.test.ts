import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATIONS_METRICS,
  approvalQueueHref,
  groupHomeWork,
  homeDueBucket,
  homeDueContext,
  homeWorkQuery,
  homeWorkQueueHref,
  inboxDeadlineText,
  inboxItemHref,
  isApprovalInboxItem,
  isWorkClockPaused,
  operationsDeadlineQuery,
  operationsHref,
  operationsMetricQuery,
  operationsQueueHref,
  operationsScopeLabel,
  operationsSlaText,
  parseOperationsGroup,
  parseOperationsOverview,
} from '../../apps/web/src/lib/operations-overview';
import type { TicketView } from '../../apps/web/src/lib/api';
import { safeReturnTo, withReturnTo } from '../../apps/web/src/lib/navigation';
import { api } from '../../apps/web/src/lib/api';

vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const groupId = '04000000-0000-4000-8000-000000000001';
const openStates = ['new', 'assigned', 'in_progress', 'pending'];
const stylesheet = readFileSync(join(process.cwd(), 'apps/web/src/app/freshservice.css'), 'utf8');

function blockAfter(source: string, start: number): string | null {
  const open = source.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

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

const homeTicket = (
  id: string,
  remainingSeconds: number | null | undefined,
  state: string = 'new',
): TicketView => ({
  id,
  number: `#${id}`,
  kind: 'incident',
  state,
  subject: `合成チケット ${id}`,
  body: '合成データ',
  impact: 'medium',
  urgency: 'medium',
  priority: 'medium',
  createdAt: '2026-11-18T00:00:00.000Z',
  resolvedAt: null,
  assigned: true,
  assigneeName: '合成 担当者',
  assigneeGroupName: '合成グループ',
  ...(remainingSeconds === undefined
    ? {}
    : { sla: { remainingSeconds, breached: (remainingSeconds ?? 0) < 0 } }),
});

// 2026-11-18(水) 14:00 JST。週は 11/15(日) 0:00〜11/22(日) 0:00 JST。
const wednesday = new Date('2026-11-18T05:00:00.000Z');

describe('UI v2ホームの自分の担当条件', () => {
  it('未完了・自分の担当・期限順だけを組み立て、グループで絞らない', () => {
    const query = homeWorkQuery();
    expect([...query]).toEqual([
      ['state', 'new'],
      ['state', 'assigned'],
      ['state', 'in_progress'],
      ['state', 'pending'],
      ['assignment', 'mine'],
      ['sort', 'deadline'],
    ]);
    expect(query.get('group')).toBeNull();
    expect(query.get('requester')).toBeNull();
    expect(homeWorkQueueHref()).toBe(`/ops?${query.toString()}`);
  });
});

describe('UI v2ホームの日本時間の期限境界', () => {
  it('日付と週の境界を日本時間で求める', () => {
    expect(homeDueContext(wednesday)).toEqual({
      today: '2026-11-18',
      todayStartMs: Date.parse('2026-11-17T15:00:00.000Z'),
      tomorrowStartMs: Date.parse('2026-11-18T15:00:00.000Z'),
      weekStartMs: Date.parse('2026-11-14T15:00:00.000Z'),
      weekEndMs: Date.parse('2026-11-21T15:00:00.000Z'),
    });
  });

  it('日付をまたぐ境界では翌日を今日にしない', () => {
    const beforeMidnight = new Date('2026-11-18T14:59:59.000Z'); // 水 23:59:59 JST
    const midnight = new Date('2026-11-18T15:00:00.000Z'); // 木 0:00 JST
    expect(homeDueBucket(beforeMidnight, beforeMidnight)).toBe('today');
    expect(homeDueBucket(midnight, beforeMidnight)).toBe('week');
  });

  it('今週は土曜24:00までで、日曜0:00は翌週にする', () => {
    const lastSecond = new Date('2026-11-21T14:59:59.000Z'); // 土 23:59:59 JST
    const sunday = new Date('2026-11-21T15:00:00.000Z'); // 日 0:00 JST
    expect(homeDueBucket(lastSecond, wednesday)).toBe('week');
    expect(homeDueBucket(sunday, wednesday)).toBe('later');
  });

  it('土曜の翌日は同じ週に含めない', () => {
    const saturday = new Date('2026-11-21T14:00:00.000Z'); // 土 23:00 JST
    const sunday = new Date('2026-11-21T15:00:00.000Z');
    expect(homeDueBucket(sunday, saturday)).toBe('later');
  });

  it('日曜0:00の週は翌週土曜24:00までを今週とする', () => {
    const sunday = new Date('2026-11-21T15:00:00.000Z'); // 日 0:00 JST
    expect(homeDueBucket(new Date('2026-11-22T03:00:00.000Z'), sunday)).toBe('today');
    expect(homeDueBucket(new Date('2026-11-22T15:00:00.000Z'), sunday)).toBe('week');
    expect(homeDueBucket(new Date('2026-11-28T15:00:00.000Z'), sunday)).toBe('later');
  });

  it('期限を過ぎたものは今日でも超過にする', () => {
    expect(homeDueBucket(new Date('2026-11-18T04:59:59.000Z'), wednesday)).toBe('overdue');
    expect(homeDueBucket(wednesday, wednesday)).toBe('today');
  });
});

describe('UI v2ホームの期限別の並べ方', () => {
  it('APIの期限順を保ち、超過・今日・今週・今週より後・未設定に分ける', () => {
    const grouped = groupHomeWork(
      [
        homeTicket('overdue', -7200),
        homeTicket('today', 0),
        homeTicket('week', 25 * 3600),
        homeTicket('later', 6 * 24 * 3600),
        homeTicket('unplanned', null),
        homeTicket('missing', undefined),
      ],
      wednesday,
    );
    expect(grouped.overdue.map((item) => item.ticket.id)).toEqual(['overdue']);
    expect(grouped.today.map((item) => item.ticket.id)).toEqual(['today']);
    expect(grouped.week.map((item) => item.ticket.id)).toEqual(['week']);
    expect(grouped.later.map((item) => item.ticket.id)).toEqual(['later']);
    expect(grouped.unplanned.map((item) => item.ticket.id)).toEqual(['unplanned', 'missing']);
  });

  it('残り時間を日本時間の期限表示へ戻し、超過を文字でも示す', () => {
    const grouped = groupHomeWork(
      [homeTicket('overdue', -7200), homeTicket('today', 3 * 3600), homeTicket('week', 25 * 3600)],
      wednesday,
    );
    expect(grouped.overdue[0]?.dueAt?.toISOString()).toBe('2026-11-18T03:00:00.000Z');
    expect(grouped.overdue[0]?.dueLabel).toContain('2時間超過');
    expect(grouped.today[0]?.dueLabel).toBe('今日 17:00');
    expect(grouped.week[0]?.dueLabel).toBe('11月19日(木)');
  });

  it('残り0秒を前日にせず、今日として扱う', () => {
    const grouped = groupHomeWork([homeTicket('now', 0)], wednesday);
    expect(grouped.overdue).toHaveLength(0);
    expect(grouped.today.map((item) => item.ticket.id)).toEqual(['now']);
  });

  it('日付をまたぐ1秒を翌日側へ置く', () => {
    const beforeMidnight = new Date('2026-11-18T14:59:59.000Z');
    const grouped = groupHomeWork([homeTicket('next-day', 1)], beforeMidnight);
    expect(grouped.today).toHaveLength(0);
    expect(grouped.week.map((item) => item.ticket.id)).toEqual(['next-day']);
  });
});

describe('UI v2ホームのSLA計測停止', () => {
  it('pendingは期限を作らず、超過・今日・今週に含めない', () => {
    const grouped = groupHomeWork(
      [homeTicket('active', 3 * 3600), homeTicket('paused', 3 * 3600, 'pending')],
      wednesday,
    );
    expect(grouped.overdue).toHaveLength(0);
    expect(grouped.today.map((item) => item.ticket.id)).toEqual(['active']);
    expect(grouped.week).toHaveLength(0);
    expect(grouped.paused.map((item) => item.ticket.id)).toEqual(['paused']);
    expect(grouped.paused[0]).toMatchObject({ dueAt: null, dueLabel: 'SLA停止' });
  });

  it('/ops の「SLA停止」と同じく pending だけを停止中として扱う', () => {
    expect(isWorkClockPaused({ state: 'pending' })).toBe(true);
    for (const state of ['new', 'assigned', 'in_progress', 'resolved', 'closed'])
      expect(isWorkClockPaused({ state })).toBe(false);
  });
});

describe('UI v2ホームの承認待ちと通知', () => {
  it('承認待ちはAPIと同じ分類だけを選ぶ', () => {
    expect(
      isApprovalInboxItem({ kind: 'request_approval', state: 'pending', waiting: false }),
    ).toBe(true);
    expect(isApprovalInboxItem({ kind: 'change', state: 'review', waiting: false })).toBe(true);
    expect(isApprovalInboxItem({ kind: 'change', state: 'review', waiting: true })).toBe(false);
    expect(isApprovalInboxItem({ kind: 'change', state: 'scheduled', waiting: false })).toBe(false);
    expect(isApprovalInboxItem({ kind: 'ticket', state: 'new', waiting: false })).toBe(false);
  });

  it('承認画面と変更画面だけをリンク先にし、それ以外は受信箱へ戻す', () => {
    const request = '/requests/01900000-0000-4000-8000-000000000001';
    const change = '/changes/01900000-0000-4000-8000-000000000002';
    const ticket = '/ops/01900000-0000-4000-8000-000000000003';
    expect(inboxItemHref(request)).toBe(request);
    expect(inboxItemHref(change)).toBe(change);
    expect(inboxItemHref(ticket)).toBe(ticket);
    for (const href of ['/ops/1', 'https://example.invalid/', 'javascript:alert(1)', '//evil'])
      expect(inboxItemHref(href)).toBe('/inbox');
  });

  it('全件の承認待ちを確認する先は既存の kind=approval の絞り込みにする', () => {
    expect(approvalQueueHref()).toBe('/inbox?kind=approval');
  });

  it('承認期限の未設定・計測停止・超過を区別する', () => {
    expect(
      inboxDeadlineText({ label: '承認期限', status: 'none', at: null, remainingSeconds: null }),
    ).toBeNull();
    expect(
      inboxDeadlineText({ label: '承認期限', status: 'paused', at: null, remainingSeconds: 60 }),
    ).toBe('計測停止');
    expect(
      inboxDeadlineText({
        label: '承認期限',
        status: 'overdue',
        at: '2026-11-18T05:00:00.000Z',
        remainingSeconds: -3600,
      }),
    ).toContain('1時間超過');
    expect(
      inboxDeadlineText({
        label: '承認期限',
        status: 'upcoming',
        at: null,
        remainingSeconds: 7200,
      }),
    ).toBe('あと2時間');
  });
});

describe('UI v2ホームの一覧行の折り返し', () => {
  it('一覧パネルの幅で行を縦に積み、ビューポート幅では切り替えない', () => {
    const panel = [...stylesheet.matchAll(/\.home-panel--work\s*\{([^}]*)\}/g)]
      .map((match) => match[1] ?? '')
      .find((body) => body.includes('container-type'));
    expect(panel).toMatch(/container-type:\s*inline-size/);

    const containers = [...stylesheet.matchAll(/@container\s*\(([^)]*)\)\s*\{/g)]
      .map((match) => ({
        condition: match[1] ?? '',
        body: blockAfter(stylesheet, match.index ?? 0) ?? '',
      }))
      .filter(({ body }) => body.includes('.home-work-row'));
    expect(containers).toHaveLength(1);
    const [container] = containers;
    expect(container!.condition).toBe('max-inline-size: 34rem');
    expect(container!.body).toMatch(
      /\.home-work-row\s*\{[^}]*grid-template-columns:\s*1.625rem\s+minmax\(0,\s*1fr\)\s+0.875rem/,
    );
    expect(container!.body).toMatch(
      /\.home-work-due\s*\{[^}]*grid-column:\s*2[^}]*text-align:\s*start/,
    );

    for (const media of stylesheet.matchAll(/@media[^{]+\{/g))
      expect(blockAfter(stylesheet, media.index ?? 0) ?? '').not.toContain('.home-work-row');
  });
});
