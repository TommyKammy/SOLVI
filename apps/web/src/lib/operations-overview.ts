import type { InboxItem, TicketSlaView, TicketView } from './api';
import { formatDateTime, formatRemaining } from './labels';

type QueryInput = Record<string, string | string[] | undefined>;
const OPEN_STATES = ['new', 'assigned', 'in_progress', 'pending'] as const;
const ACTIVE_STATES = ['new', 'assigned', 'in_progress'] as const;
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OPERATIONS_METRICS = [
  { id: 'open', label: '未完了', description: '受付済み・担当決定・対応中・確認待ち' },
  { id: 'unassigned', label: '担当者未割当', description: '未完了のうち、担当者が未定' },
  { id: 'mine', label: '自分の担当', description: '未完了のうち、自分に割当済み' },
  { id: 'pending', label: '確認・対応待ち', description: '返答待ち・外部待ち・待ち先不明' },
  { id: 'breached', label: '解決期限超過', description: '未完了のうち、解決目標を超過' },
  { id: 'critical', label: '最優先', description: '未完了のうち、最優先の問い合わせ' },
] as const;

export type OperationsMetricId = (typeof OPERATIONS_METRICS)[number]['id'];

export interface OperationsOverviewCounts {
  scope: 'organization';
  counts: Record<OperationsMetricId, number>;
}

/** A malformed aggregate is unavailable, never a collection of zero counts. */
export function parseOperationsOverview(value: unknown): OperationsOverviewCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.scope !== 'organization') return null;
  if (!candidate.counts || typeof candidate.counts !== 'object' || Array.isArray(candidate.counts))
    return null;
  const counts = candidate.counts as Record<string, unknown>;
  if (
    !OPERATIONS_METRICS.every(
      ({ id }) =>
        Object.hasOwn(counts, id) &&
        Number.isSafeInteger(counts[id]) &&
        (counts[id] as number) >= 0,
    )
  )
    return null;
  return {
    scope: 'organization',
    counts: {
      open: counts.open as number,
      unassigned: counts.unassigned as number,
      mine: counts.mine as number,
      pending: counts.pending as number,
      breached: counts.breached as number,
      critical: counts.critical as number,
    },
  };
}

/** Keep an invalid selection available for correction instead of widening its scope. */
export function parseOperationsGroup(raw: QueryInput): { group: string; error: string | null } {
  const value = raw.group;
  const group = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  if (Array.isArray(value))
    return { group, error: '担当グループは1つ選択してください。複数の指定が含まれています。' };
  if (group && group !== 'mine' && group !== 'ungrouped' && !GROUP_ID.test(group))
    return { group, error: '担当グループの指定を確認し、候補から選び直してください。' };
  return { group, error: null };
}

function scopedStates(group: string, states: readonly string[]): URLSearchParams {
  const query = new URLSearchParams();
  if (group) query.set('group', group);
  states.forEach((state) => query.append('state', state));
  return query;
}

/** These exact filters feed both API totals and the corresponding queue links. */
export function operationsMetricQuery(id: OperationsMetricId, group: string): URLSearchParams {
  const query = scopedStates(group, id === 'pending' ? ['pending'] : OPEN_STATES);
  if (id === 'unassigned') query.set('assignment', 'unassigned');
  if (id === 'mine') query.set('assignment', 'mine');
  if (id === 'breached') query.set('sla', 'breached');
  if (id === 'critical') query.set('priority', 'critical');
  return query;
}

/** Pending clocks are excluded; deadline sorting does not support cursor pagination. */
export function operationsDeadlineQuery(group: string): URLSearchParams {
  const query = scopedStates(group, ACTIVE_STATES);
  query.set('sort', 'deadline');
  return query;
}

export function operationsHref(group: string): string {
  const query = new URLSearchParams();
  if (group) query.set('group', group);
  return `/ops/overview${query.size ? `?${query}` : ''}`;
}

export function operationsQueueHref(query: URLSearchParams): string {
  const safe = new URLSearchParams();
  for (const [key, value] of query)
    if (['group', 'state', 'assignment', 'sla', 'priority', 'sort'].includes(key))
      safe.append(key, value);
  return `/ops${safe.size ? `?${safe}` : ''}`;
}

export function operationsScopeLabel(
  group: string,
  groups: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (!group) return '組織全体';
  if (group === 'mine') return '自分のグループ';
  if (group === 'ungrouped') return 'グループ未割当';
  return groups.find((item) => item.id === group)?.name ?? '選択済みのグループ（名称未取得）';
}

/** A missing target is unknown, never a zero-second remaining target. */
export function operationsSlaText(sla?: TicketSlaView): string {
  if (sla?.remainingSeconds === undefined || sla.remainingSeconds === null) return '目標未設定';
  if (sla.remainingSeconds === 0) return '期限到達';
  return formatRemaining(sla.remainingSeconds);
}

/* ------------------------------------------------------------------------- */
/* UI v2 ホーム (WP-P2-UIX-045)                                              */
/* ------------------------------------------------------------------------- */

/**
 * ホームに出す自分の担当は、既存の一覧APIの条件をそのまま使う。
 * **担当グループの絞り込みは付けない。** ホームの「今日の対応」は
 * 選択中のグループではなく、常に自分の担当を表す。
 */
export function homeWorkQuery(): URLSearchParams {
  const query = new URLSearchParams();
  for (const state of OPEN_STATES) query.append('state', state);
  query.set('assignment', 'mine');
  query.set('sort', 'deadline');
  return query;
}

/** 期限順の一覧へ移るときも、APIに渡した条件を落とさない。 */
export function homeWorkQueueHref(): string {
  return operationsQueueHref(homeWorkQuery());
}

export const HOME_WORK_LIMIT = 50;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type HomeDueBucket = 'overdue' | 'today' | 'week';
export type HomeDuePlacement = HomeDueBucket | 'later';

export interface HomeDueContext {
  /** 日本時間の今日(YYYY-MM-DD)。 */
  today: string;
  /** 日本時間の今日0:00。 */
  todayStartMs: number;
  /** 日本時間の明日0:00。 */
  tomorrowStartMs: number;
  /** 日本時間の今週の日曜0:00。 */
  weekStartMs: number;
  /** 日本時間の翌週の日曜0:00(今週の終わり)。 */
  weekEndMs: number;
}

function jstParts(date: Date): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    weekday: WEEKDAYS.indexOf(value('weekday') as (typeof WEEKDAYS)[number]),
  };
}

/**
 * 日本時間の日付境界。**サーバのタイムゾーンに依存させない。**
 * 週は日曜0:00〜土曜24:00(11.3 / WP §14)。
 */
export function homeDueContext(now: Date): HomeDueContext {
  const parts = jstParts(now);
  const todayStartMs = Date.UTC(parts.year, parts.month - 1, parts.day) - JST_OFFSET_MS;
  const tomorrowStartMs = todayStartMs + DAY_MS;
  const weekStartMs = todayStartMs - parts.weekday * DAY_MS;
  return {
    today: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    todayStartMs,
    tomorrowStartMs,
    weekStartMs,
    weekEndMs: weekStartMs + 7 * DAY_MS,
  };
}

/**
 * 期限の位置。**「今週」は今日より後で、今週の土曜24:00まで。**
 * 日曜0:00ちょうどは翌週なので含めない。
 */
export function homeDueBucket(
  dueAt: Date,
  now: Date,
  context: HomeDueContext = homeDueContext(now),
): HomeDuePlacement {
  if (dueAt.getTime() < now.getTime()) return 'overdue';
  if (dueAt.getTime() < context.tomorrowStartMs) return 'today';
  if (dueAt.getTime() < context.weekEndMs) return 'week';
  return 'later';
}

export function formatJstMonthDay(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatJstMonthDayWeekday(date: Date): string {
  const weekday = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    weekday: 'short',
  }).format(date);
  return `${formatJstMonthDay(date)}(${weekday})`;
}

export function formatJstTime(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export interface HomeWorkTicket {
  ticket: TicketView;
  dueAt: Date;
  dueLabel: string;
}

export interface HomeWorkGroups {
  overdue: HomeWorkTicket[];
  today: HomeWorkTicket[];
  week: HomeWorkTicket[];
  /** 今週より後。一覧には出さないが、見出しの件数との差を説明する。 */
  later: HomeWorkTicket[];
  /** 解決期限が未設定。並べ替えの対象外なので一覧に出さない。 */
  unplanned: HomeWorkTicket[];
}

function homeDueLabel(bucket: HomeDueBucket, dueAt: Date, remainingSeconds: number): string {
  // 超過は「どれだけ遅れているか」を先に読ませる。日付は今日/今週の行で示す。
  if (bucket === 'overdue') return formatRemaining(remainingSeconds);
  if (bucket === 'today') return `今日 ${formatJstTime(dueAt)}`;
  return formatJstMonthDayWeekday(dueAt);
}

/**
 * 一覧APIの並び(期限の早い順)を保ったまま、日本時間の期限で分ける。
 * `remainingSeconds` はAPIが返した時点の残りなので、同じ `now` を基準に
 * 期限時刻へ戻す。秒未満のずれは表示の境界に影響しない。
 */
export function groupHomeWork(tickets: readonly TicketView[], now: Date): HomeWorkGroups {
  const context = homeDueContext(now);
  const groups: HomeWorkGroups = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    unplanned: [],
  };
  for (const ticket of tickets) {
    const remaining = ticket.sla?.remainingSeconds;
    if (remaining === undefined || remaining === null) {
      groups.unplanned.push({ ticket, dueAt: now, dueLabel: '期限未設定' });
      continue;
    }
    const dueAt = new Date(now.getTime() + remaining * 1000);
    const bucket: HomeDuePlacement = remaining < 0 ? 'overdue' : homeDueBucket(dueAt, now, context);
    const entry = {
      ticket,
      dueAt,
      dueLabel: bucket === 'later' ? '' : homeDueLabel(bucket, dueAt, remaining),
    };
    if (bucket === 'later') groups.later.push(entry);
    else groups[bucket].push(entry);
  }
  return groups;
}

/** `api.inbox` の項目が「自分の承認待ち」か。APIの分類と同じ条件を使う。 */
export function isApprovalInboxItem(item: Pick<InboxItem, 'kind' | 'state' | 'waiting'>): boolean {
  return (
    item.kind === 'request_approval' ||
    (item.kind === 'change' && item.state === 'review' && !item.waiting)
  );
}

/** 対象画面だけをリンク先にする。APIの文字列をそのままhrefにしない。 */
export function inboxItemHref(href: string): string {
  return /^\/(?:ops|requests|changes)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    href,
  )
    ? href
    : '/inbox';
}

/** 承認期限の表示。計測停止と未設定を区別する。 */
export function inboxDeadlineText(deadline: InboxItem['deadline']): string | null {
  if (deadline.status === 'none') return null;
  if (deadline.status === 'paused') return '計測停止';
  if (!deadline.at) {
    return deadline.remainingSeconds === null ? null : formatRemaining(deadline.remainingSeconds);
  }
  return deadline.remainingSeconds === null
    ? formatDateTime(deadline.at)
    : `${formatDateTime(deadline.at)}(${formatRemaining(deadline.remainingSeconds)})`;
}
