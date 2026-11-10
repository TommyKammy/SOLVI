import { kindLabel, priorityLabel, stateLabel } from './labels';

/** Keep API validation authoritative: restrict keys, never rewrite filter values. */
const API_KEYS = new Set([
  'state',
  'kind',
  'priority',
  'assignment',
  'keyword',
  'group',
  'sla',
  'sort',
  'requester',
  'createdFrom',
  'createdTo',
  'cursorCreatedAt',
  'cursorId',
]);
const MULTIPLE_KEYS = new Set(['state', 'kind', 'priority']);
const CONDITION_KEYS = [
  'keyword',
  'assignment',
  'sla',
  'state',
  'kind',
  'priority',
  'group',
  'createdFrom',
  'createdTo',
  'requester',
  'sort',
] as const;

type QueryInput = Record<string, string | string[] | undefined> | URLSearchParams;
export type TicketQueuePreset = 'all' | 'open' | 'mine' | 'unassigned' | 'breached' | 'custom';
export type TicketQueueCondition = {
  key: string;
  value: string;
  label: string;
  removeHref: string;
};

export const TICKET_QUEUE_PRESETS = [
  { id: 'all', label: 'すべて', href: '/ops' },
  {
    id: 'open',
    label: '未完了',
    href: '/ops?state=new&state=assigned&state=in_progress&state=pending',
  },
  {
    id: 'mine',
    label: '自分の対応中',
    href: '/ops?assignment=mine&state=assigned&state=in_progress&state=pending',
  },
  { id: 'unassigned', label: '未割当', href: '/ops?assignment=unassigned&state=new' },
  {
    id: 'breached',
    label: '期限超過',
    href: '/ops?sla=breached&state=new&state=assigned&state=in_progress&state=pending',
  },
] as const;

export function parseTicketQueueQuery(raw: QueryInput): URLSearchParams {
  const query = new URLSearchParams();
  const entries = raw instanceof URLSearchParams ? [...raw] : Object.entries(raw);
  for (const [key, value] of entries) {
    if (!API_KEYS.has(key)) continue;
    for (const item of Array.isArray(value) ? value : value !== undefined ? [value] : []) {
      query.append(key, item);
    }
  }
  return query;
}

/** Only the local queue is a destination. Cursor timestamps remain opaque strings. */
export function ticketQueueHref(query: URLSearchParams): string {
  const safe = parseTicketQueueQuery(query);
  const page = query.get('page');
  if (page && /^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page))) safe.set('page', page);
  return `/ops${safe.size ? `?${safe}` : ''}`;
}

export function removeTicketQueueCondition(
  query: URLSearchParams,
  key: string,
  value?: string,
): string {
  const next = parseTicketQueueQuery(query);
  if (CONDITION_KEYS.some((name) => name === key)) {
    if (value !== undefined && MULTIPLE_KEYS.has(key)) {
      const retained = next.getAll(key).filter((item) => item !== value);
      next.delete(key);
      for (const item of retained) next.append(key, item);
    } else {
      next.delete(key);
    }
  }
  next.delete('cursorCreatedAt');
  next.delete('cursorId');
  return ticketQueueHref(next);
}

function effectiveConditions(query: URLSearchParams): Array<[string, string]> {
  return CONDITION_KEYS.flatMap((key) => {
    const values = MULTIPLE_KEYS.has(key) ? query.getAll(key) : [query.get(key) ?? ''];
    return [...new Set(values)].flatMap((value): Array<[string, string]> => {
      // Match the API's empty-value interpretation without changing the forwarded input.
      const effective = ['keyword', 'createdFrom', 'createdTo', 'requester'].includes(key)
        ? value.trim()
        : value;
      if (!effective || (key === 'sort' && effective === 'newest')) return [];
      return [[key, value]];
    });
  });
}

export function ticketQueuePreset(query: URLSearchParams): TicketQueuePreset {
  const signature = (input: URLSearchParams) =>
    JSON.stringify(
      effectiveConditions(input)
        .map(([key, value]) => [key, value])
        .sort(),
    );
  const current = signature(query);
  return (
    TICKET_QUEUE_PRESETS.find(
      (preset) => signature(new URL(preset.href, 'https://solvi.local').searchParams) === current,
    )?.id ?? 'custom'
  );
}

export function ticketQueueConditions(
  query: URLSearchParams,
  groups: ReadonlyArray<{ id: string; name: string }> = [],
): TicketQueueCondition[] {
  return effectiveConditions(query).map(([key, value]) => {
    let label: string;
    switch (key) {
      case 'keyword':
        label = `検索: ${value.trim()}`;
        break;
      case 'state':
        label = `状況: ${stateLabel(value)}`;
        break;
      case 'kind':
        label = `種別: ${kindLabel(value)}`;
        break;
      case 'priority':
        label = `優先度: ${priorityLabel(value)}`;
        break;
      case 'assignment':
        label =
          value === 'mine'
            ? '担当: 自分'
            : value === 'unassigned'
              ? '担当: 未割当'
              : '担当: 不明な条件';
        break;
      case 'sla':
        label = value === 'breached' ? '期限: 超過' : '期限: 不明な条件';
        break;
      case 'group':
        label = `グループ: ${value === 'mine' ? '自分のグループ' : value === 'ungrouped' ? '未割当' : (groups.find((group) => group.id === value)?.name ?? '選択済み（名称未取得）')}`;
        break;
      case 'createdFrom':
        label = `受付日: ${value.trim()}から`;
        break;
      case 'createdTo':
        label = `受付日: ${value.trim()}まで`;
        break;
      case 'requester':
        label = '依頼者: 指定あり';
        break;
      case 'sort':
        label = value === 'deadline' ? '並び順: 期限が近い順' : '並び順: 不明な条件';
        break;
      default:
        label = key;
    }
    return { key, value, label, removeHref: removeTicketQueueCondition(query, key, value) };
  });
}
