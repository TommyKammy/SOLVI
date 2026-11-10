import { describe, expect, it } from 'vitest';
import {
  TICKET_QUEUE_PRESETS,
  parseTicketQueueQuery,
  removeTicketQueueCondition,
  ticketQueueConditions,
  ticketQueueHref,
  ticketQueuePreset,
} from '../../apps/web/src/lib/ticket-queue';

const params = (href: string) => new URL(href, 'https://solvi.test').searchParams;
const cursor = '2026-10-04 01:02:03.123456+00';

describe('ticket queue API query boundary', () => {
  it('keeps every existing filter and repeated values, but excludes UI and unlisted keys', () => {
    const query = parseTicketQueueQuery({
      state: ['new', 'pending'],
      kind: ['request', 'incident'],
      priority: ['critical', 'high'],
      keyword: ' VPN & 日本語 ',
      assignment: 'mine',
      group: 'ungrouped',
      sla: 'breached',
      sort: 'deadline',
      requester: 'requester-id',
      createdFrom: '2026-01-01',
      createdTo: '2026-10-04',
      cursorCreatedAt: cursor,
      cursorId: 'cursor-id',
      page: '2',
      returnTo: '//evil.test',
      limit: '100',
      organizationId: 'other-org',
      stateMachine: 'disabled',
    });
    expect([...query.keys()]).toEqual([
      'state',
      'state',
      'kind',
      'kind',
      'priority',
      'priority',
      'keyword',
      'assignment',
      'group',
      'sla',
      'sort',
      'requester',
      'createdFrom',
      'createdTo',
      'cursorCreatedAt',
      'cursorId',
    ]);
    expect(query.getAll('state')).toEqual(['new', 'pending']);
    expect(query.getAll('kind')).toEqual(['request', 'incident']);
    expect(query.getAll('priority')).toEqual(['critical', 'high']);
    expect(query.get('keyword')).toBe(' VPN & 日本語 ');
    expect(query.get('cursorCreatedAt')).toBe(cursor);
  });

  it('does not suppress invalid filter values that the API must reject', () => {
    const input = new URLSearchParams(
      'state=unknown&assignment=other&group=bad&sla=soon&sort=random&createdFrom=bad-date',
    );
    expect([...parseTicketQueueQuery(input)]).toEqual([...input]);
    expect(ticketQueuePreset(input)).toBe('custom');
    expect(ticketQueueConditions(input)).toHaveLength(6);
  });

  it('does not change inputs or parse API cursor timestamps into lossy dates', () => {
    const input = new URLSearchParams({
      keyword: 'A+B',
      cursorCreatedAt: cursor,
      cursorId: 'uuid',
    });
    const original = input.toString();
    const result = parseTicketQueueQuery(input);
    result.set('keyword', 'changed');
    expect(input.toString()).toBe(original);
    expect(params(ticketQueueHref(input)).get('cursorCreatedAt')).toBe(cursor);
  });

  it('preserves empty and duplicated scalar values for the API to interpret', () => {
    const input = new URLSearchParams(
      'assignment=&assignment=mine&state=&state=new&sort=&sort=deadline',
    );
    expect([...parseTicketQueueQuery(input)]).toEqual([...input]);
    expect(ticketQueueConditions(input)).toMatchObject([{ key: 'state', value: 'new' }]);
  });
});

describe('ticket queue preset identity', () => {
  it.each(TICKET_QUEUE_PRESETS)('recognizes the $id preset', ({ id, href }) => {
    expect(ticketQueuePreset(params(href))).toBe(id);
  });

  it('ignores page, cursor, empty defaults, default newest sort, and repeated state order', () => {
    const input = params(
      '/ops?state=pending&state=new&state=in_progress&state=assigned&state=new&state=&assignment=&keyword=%20%20&sort=newest&page=4',
    );
    input.set('cursorCreatedAt', cursor);
    input.set('cursorId', 'uuid');
    expect(ticketQueuePreset(input)).toBe('open');
    expect(ticketQueuePreset(new URLSearchParams('keyword=%20&assignment=&sort=newest'))).toBe(
      'all',
    );
  });

  it.each(['keyword=VPN', 'priority=critical', 'sort=deadline', 'group=mine', 'requester=uuid'])(
    'uses custom for added effective %s',
    (extra) => {
      const input = params(`${TICKET_QUEUE_PRESETS[1].href}&${extra}`);
      expect(ticketQueuePreset(input)).toBe('custom');
    },
  );
});

describe('ticket queue condition removal', () => {
  it('removes one state and all its duplicates while preserving other multiple values', () => {
    const input = params(
      '/ops?state=new&state=pending&state=new&kind=request&kind=incident&priority=high&priority=low&keyword=VPN&group=mine&page=3',
    );
    input.set('cursorCreatedAt', cursor);
    input.set('cursorId', 'uuid');
    const result = params(removeTicketQueueCondition(input, 'state', 'new'));
    expect(result.getAll('state')).toEqual(['pending']);
    expect(result.getAll('kind')).toEqual(['request', 'incident']);
    expect(result.getAll('priority')).toEqual(['high', 'low']);
    expect(result.get('keyword')).toBe('VPN');
    expect(result.get('group')).toBe('mine');
    for (const key of ['cursorCreatedAt', 'cursorId', 'page']) expect(result.has(key)).toBe(false);
    expect(input.getAll('state')).toEqual(['new', 'pending', 'new']);
  });

  it('clears the requester together with stale paging and retains all other filters', () => {
    const input = new URLSearchParams({
      requester: 'uuid',
      group: 'mine',
      keyword: 'VPN',
      createdFrom: '2026-01-01',
      createdTo: '2026-10-04',
      cursorCreatedAt: cursor,
      cursorId: 'uuid',
      page: '2',
    });
    expect([...params(removeTicketQueueCondition(input, 'requester'))]).toEqual([
      ['group', 'mine'],
      ['keyword', 'VPN'],
      ['createdFrom', '2026-01-01'],
      ['createdTo', '2026-10-04'],
    ]);
  });

  it('removes all duplicates of a scalar to prevent another value becoming an implicit filter', () => {
    const input = new URLSearchParams('assignment=mine&assignment=unassigned&state=new');
    expect([...params(removeTicketQueueCondition(input, 'assignment', 'mine'))]).toEqual([
      ['state', 'new'],
    ]);
  });

  it('removes every condition individually and never loses unrelated conditions', () => {
    const input = new URLSearchParams(
      'keyword=VPN&assignment=mine&sla=breached&state=new&kind=request&priority=high&group=mine&createdFrom=2026-01-01&createdTo=2026-10-04&requester=uuid&sort=deadline',
    );
    for (const condition of ticketQueueConditions(input)) {
      const result = params(condition.removeHref);
      expect(result.has(condition.key)).toBe(false);
      expect([...result]).toEqual([...input].filter(([key]) => key !== condition.key));
    }
  });

  it('has a fixed local route and drops unknown keys even if values resemble URLs', () => {
    const keyword = '//evil.test/?state=closed&redirect=https://evil.test#anchor';
    const input = new URLSearchParams({
      keyword,
      state: 'new',
      returnTo: 'https://evil.test',
      redirect: '//evil.test',
    });
    const output = new URL(removeTicketQueueCondition(input, 'state'), 'https://solvi.test');
    expect(output.origin).toBe('https://solvi.test');
    expect(output.pathname).toBe('/ops');
    expect(output.hash).toBe('');
    expect([...output.searchParams]).toEqual([['keyword', keyword]]);
  });

  it('preserves a valid retry page but excludes malformed page values and unlisted controls', () => {
    const input = new URLSearchParams({
      page: '2',
      cursorCreatedAt: cursor,
      cursorId: 'uuid',
      limit: '100',
    });
    expect(params(ticketQueueHref(input)).get('page')).toBe('2');
    expect(params(ticketQueueHref(input)).has('limit')).toBe(false);
    for (const page of ['0', '-1', '2x', '2.5', 'Infinity', '1e2', '9007199254740992']) {
      input.set('page', page);
      expect(params(ticketQueueHref(input)).has('page')).toBe(false);
    }
    expect(ticketQueueHref(new URLSearchParams())).toBe('/ops');
  });
});

describe('ticket queue condition labels', () => {
  it('ignores whitespace-only requester as the API does while preserving raw forwarding', () => {
    const input = new URLSearchParams({ requester: ' \t\n ', keyword: '  ' });
    expect(ticketQueueConditions(input)).toEqual([]);
    expect(ticketQueuePreset(input)).toBe('all');
    expect(parseTicketQueueQuery(input).get('requester')).toBe(' \t\n ');
    const requester = ' 00000000-0000-4000-8000-000000000001 ';
    input.set('requester', requester);
    expect(ticketQueueConditions(input)).toMatchObject([
      { key: 'requester', value: requester, label: '依頼者: 指定あり' },
    ]);
    expect(ticketQueuePreset(input)).toBe('custom');
    expect(parseTicketQueueQuery(input).get('requester')).toBe(requester);
    expect(params(ticketQueueHref(input)).get('requester')).toBe(requester);
    expect(params(removeTicketQueueCondition(input, 'requester')).has('requester')).toBe(false);
  });

  it('labels known groups and hides raw missing-group/requester identifiers', () => {
    const groupId = '00000000-0000-4000-8000-000000000001';
    const input = new URLSearchParams({ group: groupId, requester: 'requester-private-id' });
    expect(
      ticketQueueConditions(input, [{ id: groupId, name: '情報システム部' }]).map((c) => c.label),
    ).toEqual(['グループ: 情報システム部', '依頼者: 指定あり']);
    const missing = ticketQueueConditions(input);
    expect(missing[0]?.label).toBe('グループ: 選択済み（名称未取得）');
    expect(missing.map((c) => c.label).join(' ')).not.toContain(groupId);
    expect(missing.map((c) => c.label).join(' ')).not.toContain('requester-private-id');
    expect(params(missing[0]!.removeHref).get('requester')).toBe('requester-private-id');
  });

  it('shows each effective multivalue once, omits cursor/default sort, and keeps original search text in links', () => {
    const input = new URLSearchParams(
      'state=new&state=pending&state=new&kind=incident&priority=critical&keyword=%20VPN%20&sort=newest&page=3',
    );
    const conditions = ticketQueueConditions(input);
    expect(conditions.map((c) => c.label)).toEqual([
      '検索: VPN',
      '状況: 受付済み',
      '状況: 確認・対応待ち',
      '種別: 障害の報告',
      '優先度: 最優先',
    ]);
    expect(params(conditions[1]!.removeHref).get('keyword')).toBe(' VPN ');
  });
});
