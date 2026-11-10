import type { TicketSlaView } from './api';
import { formatRemaining } from './labels';

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
