import { describe, expect, it } from 'vitest';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import {
  buildListQuery,
  type ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import { createOrderingVariants } from '../../tools/performance/list-query-analysis.mjs';

const organizationId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const groupId = '00000000-0000-4000-8000-000000000003';
function context(roleCode: RoleCode): AuthzContext {
  return {
    organizationId,
    principal: {
      userId,
      status: 'active',
      bindings: [{ roleCode, organizationId, validFrom: new Date(0), validUntil: null }],
    },
  };
}

function splitSelection(sql: string) {
  const start = sql.indexOf('FROM (');
  const end = sql.indexOf(') selected');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return { selection: sql.slice(start, end), display: sql.slice(end) };
}

describe('deadline display joins run after authorized ticket selection', () => {
  it.each(
    (['asc', 'desc'] as const).flatMap((direction) =>
      [1, 5, 50, 200].map((limit) => ({ direction, limit })),
    ),
  )('preserves both order levels for $direction and limit $limit', ({ direction, limit }) => {
    const query = buildListQuery(context('agent'), {
      sort: { column: 'deadline', direction },
      filter: { state: ['new', 'assigned', 'in_progress'] },
      limit,
    });
    const { selection, display } = splitSelection(query.sql);
    const order = direction.toUpperCase();
    expect(query.sql.trimStart().startsWith('SELECT ')).toBe(true);
    expect(selection).toContain('t.organization_id = $1 AND t.state = ANY($2::text[])');
    expect(selection).toContain(`ORDER BY remaining_seconds ${order} NULLS LAST, t.id ${order}`);
    expect(selection.trimEnd().endsWith('LIMIT $3')).toBe(true);
    expect(selection).not.toContain('JOIN app_user');
    expect(selection).not.toContain('JOIN assignment_group');
    expect(display).toContain('LEFT JOIN app_user assignee ON assignee.id=selected.assignee_id');
    expect(display).toContain('LEFT JOIN app_user requester ON requester.id=selected.requester_id');
    expect(display).toContain(
      'LEFT JOIN assignment_group assignee_group ON assignee_group.id=selected.assignee_group_id AND assignee_group.organization_id=selected.organization_id',
    );
    expect(display).toContain(
      `ORDER BY selected.remaining_seconds ${order} NULLS LAST, selected.id ${order}`,
    );
    expect(display).not.toContain('WHERE');
    expect(display).not.toContain('LIMIT');
    expect(query.params).toEqual([organizationId, ['new', 'assigned', 'in_progress'], limit]);
  });

  it.each(['agent', 'requester'] as const)(
    'keeps %s authorization and all filters before LIMIT and in COUNT',
    (role) => {
      const options: ListOptions = {
        sort: { column: 'deadline', direction: 'asc' },
        limit: 5,
        filter: {
          state: ['new', 'pending'],
          kind: ['incident'],
          priority: ['critical'],
          unassignedOnly: true,
          requesterId: userId,
          assigneeGroupIds: [groupId],
          slaBreachedOnly: true,
          createdFrom: new Date('2026-10-01T00:00:00Z'),
          createdTo: new Date('2026-10-04T23:59:59Z'),
          keyword: '100%_test',
        },
      };
      const query = buildListQuery(context(role), options);
      const previousOrder = buildListQuery(context(role), {
        ...options,
        sort: { column: 'created_at', direction: 'desc' },
      });
      const { selection } = splitSelection(query.sql);
      const where = selection.match(/WHERE ([\s\S]*?)\n\s*ORDER BY/)?.[1];
      expect(where).toBeTruthy();
      expect(query.countSql.endsWith(`WHERE ${where}`)).toBe(true);
      expect(query.countSql).toBe(previousOrder.countSql);
      expect(query.countParams).toEqual(previousOrder.countParams);
      expect(query.params).toEqual(previousOrder.params);
      expect(query.params.at(-2)).toBe('%100\\%\\_test%');
      expect(selection).toContain('t.organization_id = $1');
      if (role === 'requester') {
        expect(selection).toContain('t.organization_id = $1 AND t.requester_id = $2');
        expect(query.countParams.slice(0, 2)).toEqual([organizationId, userId]);
      }
      expect(selection).toContain('t.assignee_id IS NULL');
      expect(selection).toContain('t.assignee_group_id = ANY(');
      expect(selection).toContain('p.resolution_target_minutes IS NOT NULL');
      expect(selection).toContain('t.created_at >=');
      expect(selection).toContain('t.created_at <=');
    },
  );

  it('retains ungrouped scope before selection and keeps missing display values nullable', () => {
    const query = buildListQuery(context('agent'), {
      sort: { column: 'deadline', direction: 'asc' },
      filter: { ungroupedOnly: true },
    });
    const { selection, display } = splitSelection(query.sql);
    expect(selection).toContain('t.assignee_group_id IS NULL');
    expect(query.countSql).toContain('t.assignee_group_id IS NULL');
    expect(display.match(/LEFT JOIN/g)).toHaveLength(3);
    expect(display).not.toContain('INNER JOIN');
  });

  it('projects each existing field once while keeping the shared live SLA expression inside selection', () => {
    const query = buildListQuery(context('agent'), {
      sort: { column: 'deadline', direction: 'asc' },
    });
    const { selection } = splitSelection(query.sql);
    expect(query.sql).toContain('SELECT selected.*,');
    expect(selection).toContain('SELECT t.*, t.created_at::text AS cursor_created_at');
    for (const alias of [
      'cursor_created_at',
      'sla_elapsed_now',
      'remaining_seconds',
      'assignee_name',
      'requester_name',
      'assignee_group_name',
    ]) {
      expect(query.sql.match(new RegExp(`AS ${alias}\\b`, 'g'))).toHaveLength(1);
    }
    expect(selection).toContain('CASE WHEN p.resolution_target_minutes IS NULL THEN NULL');
    expect(selection).toContain('now() - t.sla_clock_started_at');
    expect(selection).toContain('p.response_target_minutes');
    expect(selection).toContain('p.resolution_target_minutes');
  });

  it.each(['asc', 'desc'] as const)(
    'continues to reject a created-at cursor in %s deadline order',
    (direction) => {
      expect(() =>
        buildListQuery(context('agent'), {
          sort: { column: 'deadline', direction },
          cursor: { createdAt: '2026-10-04 00:00:00.123456+00', id: userId },
        }),
      ).toThrow(expect.objectContaining({ status: 400 }));
    },
  );

  it.each(['asc', 'desc'] as const)(
    'accepts the exact %s projection as an unchanged ordering diagnostic control',
    (direction) => {
      const built = buildListQuery(context('requester'), {
        sort: { column: 'deadline', direction },
        filter: { state: ['new', 'pending'], assigneeGroupIds: [groupId], keyword: '100%_test' },
        limit: 5,
      });
      expect(createOrderingVariants(built)).toEqual({
        legacy: built,
        candidate: built,
        changed: false,
      });
    },
  );

  it.each([
    [
      'inner direction',
      (sql: string) => sql.replace('remaining_seconds ASC', 'remaining_seconds DESC'),
    ],
    ['inner tie direction', (sql: string) => sql.replace('t.id ASC', 't.id DESC')],
    [
      'outer direction',
      (sql: string) =>
        sql.replace('selected.remaining_seconds ASC', 'selected.remaining_seconds DESC'),
    ],
    ['outer tie direction', (sql: string) => sql.replace('selected.id ASC', 'selected.id DESC')],
    ['unknown sort', (sql: string) => sql.replaceAll('remaining_seconds', 'priority')],
    ['missing outer order', (sql: string) => sql.replace(/ORDER BY selected[\s\S]+$/, '')],
    [
      'outer filter',
      (sql: string) =>
        sql.replace(
          'ORDER BY selected',
          'WHERE selected.requester_id IS NOT NULL ORDER BY selected',
        ),
    ],
    [
      'changed group boundary',
      (sql: string) =>
        sql.replace(' AND assignee_group.organization_id=selected.organization_id', ''),
    ],
    [
      'changed display join',
      (sql: string) => sql.replace('LEFT JOIN app_user requester', 'JOIN app_user requester'),
    ],
    [
      'inner filter differs from count',
      (sql: string) =>
        sql.replace('WHERE t.organization_id = $1', 'WHERE false AND t.organization_id = $1'),
    ],
    ['wrong limit parameter', (sql: string) => sql.replace('LIMIT $2', 'LIMIT $99')],
    ['extra statement', (sql: string) => sql + '; SELECT 1'],
  ] as const)('rejects an unrecognized projected deadline control: %s', (_name, alter) => {
    const built = buildListQuery(context('agent'), {
      sort: { column: 'deadline', direction: 'asc' },
    });
    expect(() => createOrderingVariants({ ...built, sql: alter(built.sql) })).toThrow(
      'QUERY_VARIANT_REJECTED',
    );
  });
});
