type RawQuery = Record<string, string | string[] | undefined>;
const day = /^\d{4}-\d{2}-\d{2}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function currentInsightPeriod(now = new Date()) {
  return {
    from: new Date(now.getTime() - 6 * 86_400_000).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

function validDate(value: string) {
  if (!day.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const reportMetrics = {
  received: '受付件数',
  resolved: '解決済み',
  open: '未完了',
  breached: '解決期限超過',
} as const;
export type ReportMetric = keyof typeof reportMetrics;

export function parseReportQuery(query: RawQuery, now?: Date) {
  const period = currentInsightPeriod(now);
  const from = typeof query.from === 'string' ? query.from : period.from;
  const to = typeof query.to === 'string' ? query.to : period.to;
  const group = typeof query.group === 'string' ? query.group.toLowerCase() : '';
  const metric =
    typeof query.metric === 'string' && Object.hasOwn(reportMetrics, query.metric)
      ? (query.metric as ReportMetric)
      : 'received';
  const datesValid =
    validDate(from) &&
    validDate(to) &&
    from <= to &&
    (Date.parse(to) - Date.parse(from)) / 86_400_000 < 366;
  const groupValid = group === '' || group === 'mine' || group === 'ungrouped' || uuid.test(group);
  const cursorDate = query.cursorCreatedAt;
  const cursorId = query.cursorId;
  const cursor =
    typeof cursorDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(cursorDate) &&
    Number.isFinite(Date.parse(cursorDate)) &&
    typeof cursorId === 'string' &&
    uuid.test(cursorId)
      ? { createdAt: cursorDate, id: cursorId }
      : null;
  const invalid =
    !datesValid ||
    !groupValid ||
    [query.from, query.to, query.group, query.metric].some(Array.isArray) ||
    (query.metric !== undefined && query.metric !== metric) ||
    ((cursorDate !== undefined || cursorId !== undefined) && !cursor);
  return { from, to, group, metric, cursor, invalid };
}

type ReportQuery = ReturnType<typeof parseReportQuery>;

export function reportTicketsQuery(scope: ReportQuery, metric: ReportMetric, page = false) {
  const params = new URLSearchParams({ createdFrom: scope.from, createdTo: scope.to });
  if (scope.group) params.set('group', scope.group);
  const active = ['new', 'assigned', 'in_progress'];
  const states = {
    received: [],
    resolved: ['resolved', 'closed'],
    open: [...active, 'pending'],
    breached: active,
  };
  for (const state of states[metric]) params.append('state', state);
  if (metric === 'breached') params.set('sla', 'breached');
  if (page && scope.cursor) {
    params.set('cursorCreatedAt', scope.cursor.createdAt);
    params.set('cursorId', scope.cursor.id);
  }
  return params;
}

export function reportHref(
  scope: ReportQuery,
  metric: ReportMetric = scope.metric,
  cursor: ReportQuery['cursor'] = null,
) {
  const params = new URLSearchParams({ from: scope.from, to: scope.to, metric });
  if (scope.group) params.set('group', scope.group);
  if (cursor) {
    params.set('cursorCreatedAt', cursor.createdAt);
    params.set('cursorId', cursor.id);
  }
  return '/ops/reports?' + params;
}

export const auditCategories = {
  all: 'すべて',
  approval: '承認',
  role: '権限変更',
  review: 'アクセスレビュー',
} as const;

export function auditParams(query: RawQuery, now?: Date) {
  const defaults = { ...currentInsightPeriod(now), category: 'all' };
  const params = new URLSearchParams(defaults);
  for (const key of ['from', 'to', 'category', 'target', 'event', 'page'] as const) {
    const value = query[key];
    if (typeof value === 'string') params.set(key, value.slice(0, 200));
    else if (Array.isArray(value)) {
      for (const entry of value.slice(0, 2)) params.append(key, entry.slice(0, 200));
    }
  }
  return params;
}

export function auditHref(params: URLSearchParams, changes: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return '/ops/audit?' + next;
}

export interface AuditEventSummary {
  id: string;
  type: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  subjectId: string | null;
  targetId: string | null;
  roleBefore: string | null;
  roleAfter: string | null;
  step: number | null;
}
