import { describe, expect, it } from 'vitest';
import {
  auditHref,
  auditParams,
  parseReportQuery,
  reportHref,
  reportTicketsQuery,
} from '../../apps/web/src/lib/ops-insights';
import {
  ticketBackLabel,
  ticketListOrigin,
  ticketReturnTo,
} from '../../apps/web/src/lib/navigation';

const now = new Date('2026-11-19T10:00:00Z');
const id = '05100000-0000-4000-8000-000000000001';

describe('report criteria and drilldown', () => {
  it('opens the group summary by default and clears only the drilldown on return', () => {
    const filter = { from: '2026-11-14', to: '2026-11-18', group: id };
    const summary = parseReportQuery(filter, now);
    expect(summary.invalid).toBe(false);
    expect(summary.metric).toBeNull();
    expect(reportHref(summary)).toBe('/ops/reports?from=2026-11-14&to=2026-11-18&group=' + id);

    const cursorCreatedAt = '2026-11-17T09:58:23.123456Z';
    const selected = parseReportQuery(
      { ...filter, metric: 'received', cursorCreatedAt, cursorId: id },
      now,
    );
    expect(selected.invalid).toBe(false);
    expect(reportHref(selected, null, selected.cursor)).toBe(reportHref(summary));
    expect(parseReportQuery({ ...filter, cursorCreatedAt, cursorId: id }, now).invalid).toBe(true);
  });

  it('uses UTC date and the same filter for total and the selected ticket page', () => {
    const scope = parseReportQuery(
      {
        group: id,
        metric: 'breached',
        cursorCreatedAt: '2026-11-17T09:58:23.123456Z',
        cursorId: id,
      },
      now,
    );
    expect(scope.invalid).toBe(false);
    const count = reportTicketsQuery(scope, 'breached');
    const list = reportTicketsQuery(scope, 'breached', true);
    expect(count.get('createdFrom')).toBe('2026-11-13');
    expect(count.get('createdTo')).toBe('2026-11-19');
    expect(count.getAll('state')).toEqual(['new', 'assigned', 'in_progress']);
    expect(count.get('sla')).toBe('breached');
    list.delete('cursorCreatedAt');
    list.delete('cursorId');
    expect(list.toString()).toBe(count.toString());
    const returned = ticketReturnTo(reportHref(scope), id);
    expect(returned).toBe(
      '/ops/reports?from=2026-11-13&to=2026-11-19&metric=breached&group=' +
        id +
        '#ticket-entry-' +
        id,
    );
    expect(ticketBackLabel(ticketListOrigin(returned), true)).toBe('レポートに戻る');
  });

  it.each([
    { to: '2026-02-30' },
    { from: '2026-11-20' },
    { group: ['mine', 'ungrouped'] },
    { metric: 'invalid' },
    { cursorId: id },
  ])('rejects invalid report filters: %j', (query) => {
    expect(parseReportQuery(query, now).invalid).toBe(true);
  });

  it('opens an audit record from the same date, category and page', () => {
    const params = auditParams({ category: 'role', page: '2' }, now);
    const view = auditHref(params, { event: id });
    expect(view).toBe('/ops/audit?from=2026-11-13&to=2026-11-19&category=role&page=2&event=' + id);
  });
});
