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

describe('keyword display joins follow authorized created-at page selection', () => {
  it.each(
    (['asc', 'desc'] as const).flatMap((direction) =>
      [1, 50, 200].map((limit) => ({ direction, limit })),
    ),
  )('keeps both order levels for $direction and limit $limit', ({ direction, limit }) => {
    const query = buildListQuery(context('agent'), {
      sort: { column: 'created_at', direction },
      filter: { keyword: '  問い合わせ 1  ' },
      limit,
    });
    const { selection, display } = splitSelection(query.sql);
    const order = direction.toUpperCase();
    expect(selection).toContain('t.organization_id = $1 AND t.search_text ILIKE $2');
    expect(selection).toContain(`ORDER BY t.created_at ${order}, t.id ${order}`);
    expect(selection.trimEnd().endsWith('LIMIT $3')).toBe(true);
    expect(selection).not.toContain('JOIN app_user');
    expect(selection).not.toContain('JOIN assignment_group');
    expect(display).toContain('LEFT JOIN app_user assignee ON assignee.id=selected.assignee_id');
    expect(display).toContain('LEFT JOIN app_user requester ON requester.id=selected.requester_id');
    expect(display).toContain(
      'LEFT JOIN assignment_group assignee_group ON assignee_group.id=selected.assignee_group_id AND assignee_group.organization_id=selected.organization_id',
    );
    expect(display).toContain(`ORDER BY selected.created_at ${order}, selected.id ${order}`);
    expect(display).not.toContain('NULLS LAST');
    expect(display).not.toContain('WHERE');
    expect(display).not.toContain('LIMIT');
    expect(query.params).toEqual([organizationId, '%問い合わせ 1%', limit]);
  });

  it.each(['asc', 'desc'] as const)(
    'applies exact timestamp/id %s cursor before LIMIT and excludes it from total',
    (direction) => {
      const options: ListOptions = {
        sort: { column: 'created_at', direction },
        filter: { keyword: '問' },
        limit: 50,
      };
      const first = buildListQuery(context('requester'), options);
      const cursor = { createdAt: '2026-10-04 00:00:00.123456+00', id: groupId };
      const next = buildListQuery(context('requester'), { ...options, cursor });
      const { selection, display } = splitSelection(next.sql);
      expect(selection).toContain(
        `(t.created_at, t.id) ${direction === 'desc' ? '<' : '>'} ($4::timestamptz, $5::uuid)`,
      );
      expect(selection).toContain('t.organization_id = $1 AND t.requester_id = $2');
      expect(display).not.toContain('::timestamptz');
      expect(next.params).toEqual([
        organizationId,
        userId,
        '%問%',
        cursor.createdAt,
        cursor.id,
        50,
      ]);
      expect(next.countSql).toBe(first.countSql);
      expect(next.countParams).toEqual(first.countParams);
      expect(next.countParams).toEqual([organizationId, userId, '%問%']);
    },
  );

  it.each(['agent', 'requester'] as const)(
    'keeps %s scope and compound filters in selection and total',
    (role) => {
      const options: ListOptions = {
        filter: {
          keyword: '100%_test\\literal',
          state: ['new', 'pending'],
          priority: ['critical'],
          kind: ['incident'],
          unassignedOnly: true,
          requesterId: userId,
          assigneeGroupIds: [groupId],
          slaBreachedOnly: true,
          createdFrom: new Date('2026-10-01T00:00:00Z'),
          createdTo: new Date('2026-10-04T23:59:59Z'),
        },
      };
      const query = buildListQuery(context(role), options);
      const { selection } = splitSelection(query.sql);
      const where = selection.match(/WHERE ([\s\S]*?)\n\s*ORDER BY/)?.[1];
      expect(where).toBeTruthy();
      expect(query.countSql.endsWith(`WHERE ${where}`)).toBe(true);
      expect(query.params.at(-2)).toBe('%100\\%\\_test\\\\literal%');
      expect(selection).toContain('t.assignee_id IS NULL');
      expect(selection).toContain('t.assignee_group_id = ANY(');
      expect(selection).toContain('p.resolution_target_minutes IS NOT NULL');
      expect(selection).toContain('t.created_at >=');
      expect(selection).toContain('t.created_at <=');
      const otherSort = buildListQuery(context(role), {
        ...options,
        sort: { column: 'updated_at', direction: 'desc' },
      });
      expect(query.countSql).toBe(otherSort.countSql);
      expect(query.countParams).toEqual(otherSort.countParams);
      expect(query.params).toEqual(otherSort.params);
    },
  );

  it.each([undefined, '', ' ', '\t\n', '\u3000'])(
    'leaves unfiltered index-driven query unchanged for keyword %j',
    (keyword) => {
      const plain = buildListQuery(context('agent'));
      expect(buildListQuery(context('agent'), { filter: { keyword } })).toEqual(plain);
      expect(plain.sql).not.toContain(') selected');
    },
  );

  it.each(['updated_at', 'priority', 'number'] as const)(
    'keeps %s search on its existing display path',
    (column) => {
      const query = buildListQuery(context('agent'), {
        sort: { column, direction: 'desc' },
        filter: { keyword: '問い合わせ' },
      });
      expect(query.sql).not.toContain(') selected');
      expect(query.sql).toContain('assignee.id=t.assignee_id');
      expect(query.sql).toContain('t.search_text ILIKE $2');
    },
  );

  it('continues rejecting a non-allowlisted sort even with keyword selection', () => {
    expect(() =>
      buildListQuery(context('agent'), {
        sort: { column: 'state' as 'created_at', direction: 'desc' },
        filter: { keyword: '問い合わせ' },
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('retains nullable display joins and SLA fields without duplicate projections', () => {
    const query = buildListQuery(context('agent'), {
      filter: { keyword: '%', ungroupedOnly: true },
      limit: 201,
    });
    const { selection, display } = splitSelection(query.sql);
    expect(selection).toContain('t.assignee_group_id IS NULL');
    expect(selection).toContain('t.created_at::text AS cursor_created_at');
    expect(selection).toContain('now() - t.sla_clock_started_at');
    expect(selection).toContain('p.response_target_minutes');
    expect(selection).toContain('p.resolution_target_minutes');
    expect(display.match(/LEFT JOIN/g)).toHaveLength(3);
    expect(query.limit).toBe(200);
    expect(query.params.at(-1)).toBe(200);
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
  });
});

describe('WP042 ordering diagnostics accept only the exact WP046 projection', () => {
  it.each(
    (['asc', 'desc'] as const).flatMap((direction) =>
      [false, true].map((cursor) => ({ direction, cursor })),
    ),
  )('varies only inner NULL order for $direction with cursor=$cursor', ({ direction, cursor }) => {
    const built = buildListQuery(context('requester'), {
      filter: { keyword: 'NULLS LAST %_literal', unassignedOnly: true },
      sort: { column: 'created_at', direction },
      ...(cursor ? { cursor: { createdAt: '2026-10-04 00:00:00.123456+00', id: groupId } } : {}),
    });
    const variants = createOrderingVariants(built);
    const order = direction.toUpperCase();
    expect(variants.changed).toBe(true);
    expect(variants.candidate).toEqual(built);
    expect(variants.legacy).toEqual({
      ...built,
      sql: built.sql.replace(
        `ORDER BY t.created_at ${order}, t.id ${order}`,
        `ORDER BY t.created_at ${order} NULLS LAST, t.id ${order}`,
      ),
    });
    expect(variants.legacy.sql).toContain(
      `ORDER BY selected.created_at ${order}, selected.id ${order}`,
    );
    expect(createOrderingVariants(variants.legacy)).toEqual(variants);
  });
  it.each([
    [
      'outer direction',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace(
          'ORDER BY selected.created_at DESC, selected.id DESC',
          'ORDER BY selected.created_at ASC, selected.id ASC',
        ),
      }),
    ],
    [
      'inner tie direction',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace(
          'ORDER BY t.created_at DESC, t.id DESC',
          'ORDER BY t.created_at DESC, t.id ASC',
        ),
      }),
    ],
    [
      'outer filter',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace(
          'ORDER BY selected.created_at',
          "WHERE selected.state='new' ORDER BY selected.created_at",
        ),
      }),
    ],
    [
      'group boundary',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace(' AND assignee_group.organization_id=selected.organization_id', ''),
      }),
    ],
    [
      'count filter',
      (q: ReturnType<typeof buildListQuery>) => ({ ...q, countSql: q.countSql + ' AND false' }),
    ],
    [
      'count parameter',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        countParams: ['different-organization', ...q.countParams.slice(1)],
      }),
    ],
    [
      'missing parameter',
      (q: ReturnType<typeof buildListQuery>) => ({ ...q, params: q.params.slice(0, -1) }),
    ],
    [
      'wrong limit parameter',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace(/LIMIT \$\d+/, 'LIMIT $999'),
      }),
    ],
    [
      'cursor operator',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace('(t.created_at, t.id) <', '(t.created_at, t.id) >'),
      }),
    ],
    [
      'extra statement',
      (q: ReturnType<typeof buildListQuery>) => ({ ...q, sql: q.sql + '; SELECT 1' }),
    ],
    [
      'unknown shell',
      (q: ReturnType<typeof buildListQuery>) => ({
        ...q,
        sql: q.sql.replace('SELECT selected.*,', 'SELECT selected.id,'),
      }),
    ],
  ])('refuses malformed %s', (_name, mutate) => {
    const built = buildListQuery(context('agent'), {
      filter: { keyword: '問い合わせ' },
      cursor: { createdAt: '2026-10-04 00:00:00.123456+00', id: groupId },
    });
    expect(() => createOrderingVariants(mutate(built))).toThrow('QUERY_VARIANT_REJECTED');
  });
});
