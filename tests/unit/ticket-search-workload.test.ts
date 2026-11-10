import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import {
  buildListQuery,
  type BuiltQuery,
  type ListOptions,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';

const organizationId = '04700000-0000-4000-8000-000000000001';
const actorId = '04700000-0000-4000-8000-000000000002';
const groupId = '04700000-0000-4000-8000-000000000003';
const ticketId = '04700000-0000-4000-8000-000000000004';
const secondTicketId = '04700000-0000-4000-8000-000000000005';
const now = new Date('2026-10-05T00:00:00Z');
const cursorCreatedAt = '2026-10-04 23:59:59.123456+00';
const search: ListOptions = { filter: { keyword: '問い合わせ' } };
const roles: RoleCode[] = [
  'requester',
  'approver',
  'agent',
  'auditor',
  'org_admin',
  'platform_admin',
  'platform_auditor',
];
const staffRoles = new Set<RoleCode>([
  'agent',
  'auditor',
  'org_admin',
  'platform_admin',
  'platform_auditor',
]);

function context(role: RoleCode = 'agent'): AuthzContext {
  return {
    organizationId,
    now,
    principal: {
      userId: actorId,
      status: 'active',
      bindings: [
        {
          roleCode: role,
          organizationId: role.startsWith('platform_') ? null : organizationId,
          validFrom: new Date('2026-10-04T00:00:00Z'),
          validUntil: null,
        },
      ],
    },
  };
}

function combined(query: BuiltQuery): string {
  expect(typeof query.combinedSql).toBe('string');
  if (typeof query.combinedSql !== 'string') throw new Error('Combined search query is missing');
  return query.combinedSql;
}

// Inspect the fallback matching set, not the separately bounded authorized prefix.
function materializedSelection(sql: string) {
  const marker = /\b(matched)\s+AS\s+MATERIALIZED\s*\(/i.exec(sql);
  expect(marker).not.toBeNull();
  if (!marker) throw new Error('Materialized search set is missing');
  const start = marker.index + marker[0].length;
  let depth = 1;
  for (let index = start; index < sql.length; index += 1) {
    if (sql[index] === '(') depth += 1;
    if (sql[index] === ')') depth -= 1;
    if (depth === 0)
      return { name: marker[1]!, selection: sql.slice(start, index), rest: sql.slice(index + 1) };
  }
  throw new Error('Materialized search set is not closed');
}

const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('one authorized search population supplies exact total and page', () => {
  it.each(roles)('retains the existing %s visibility before counting', (role) => {
    const built = buildListQuery(context(role), search);
    const { selection } = materializedSelection(combined(built));
    expect(selection).toContain('t.organization_id = $1');
    expect(built.params[0]).toBe(organizationId);
    if (staffRoles.has(role)) {
      expect(selection).not.toContain('t.requester_id =');
      expect(built.countParams).toEqual([organizationId, '%問い合わせ%']);
    } else {
      expect(selection).toContain('t.requester_id = $2');
      expect(built.countParams).toEqual([organizationId, actorId, '%問い合わせ%']);
    }
  });

  it.each(['expired', 'future', 'other-organization', 'deactivated', 'unbound'])(
    'does not let an ineffective staff binding widen search scope: %s',
    (reason) => {
      const ctx = context();
      if (reason === 'expired') ctx.principal.bindings[0]!.validUntil = now;
      if (reason === 'future') ctx.principal.bindings[0]!.validFrom = new Date(now.getTime() + 1);
      if (reason === 'other-organization') ctx.principal.bindings[0]!.organizationId = groupId;
      if (reason === 'deactivated') ctx.principal.status = 'deactivated';
      if (reason === 'unbound') ctx.principal.bindings = [];
      const { selection } = materializedSelection(combined(buildListQuery(ctx, search)));
      // Authentication rejects stopped users at HTTP; the builder must still never widen scope.
      expect(selection).toContain('t.organization_id = $1 AND t.requester_id = $2');
    },
  );

  it.each(['asc', 'desc'] as const)(
    'keeps every filter before materialization and the %s cursor after it',
    (direction) => {
      const options: ListOptions = {
        sort: { column: 'created_at', direction },
        filter: {
          state: ['new', 'pending'],
          priority: ['critical'],
          kind: ['incident'],
          assigneeId: actorId,
          requesterId: actorId,
          assigneeGroupIds: [groupId],
          slaBreachedOnly: true,
          createdFrom: new Date('2026-10-01T00:00:00Z'),
          createdTo: new Date('2026-10-05T00:00:00Z'),
          keyword: '  100%_\\literal  ',
        },
        limit: 50,
      };
      const first = buildListQuery(context(), options);
      const next = buildListQuery(context(), {
        ...options,
        cursor: { createdAt: cursorCreatedAt, id: ticketId },
      });
      const sql = combined(next);
      const { selection, rest } = materializedSelection(sql);
      const fields = compact(selection).split(/ FROM /i)[0];
      expect(fields).toMatch(/^SELECT t\.id\s*,\s*t\.created_at$/i);
      expect(selection).not.toMatch(/\bLIMIT\b|\bORDER BY\b|JOIN app_user|JOIN assignment_group/i);
      const where = first.countSql.slice(first.countSql.indexOf('WHERE ') + 6);
      expect(compact(selection)).toContain(`WHERE ${compact(where)}`);
      expect(selection).toContain('LEFT JOIN sla_policy');
      expect(selection).toContain('p.resolution_target_minutes IS NOT NULL');
      expect(sql).not.toContain('100%');
      expect(next.countParams.at(-1)).toBe('%100\\%\\_\\\\literal%');
      expect(next.countSql).toBe(first.countSql);
      expect(next.countParams).toEqual(first.countParams);
      expect(next.params).toEqual([...first.countParams, cursorCreatedAt, ticketId, 50]);
      const firstCursorParameter = `$${first.countParams.length + 1}::timestamptz`;
      expect(selection).not.toContain(firstCursorParameter);
      expect(rest).toContain(firstCursorParameter);
      expect(rest).toMatch(direction === 'asc' ? /\) > \(/ : /\) < \(/);
      expect(selection.match(/\bILIKE\b/g)).toHaveLength(1);
      expect(sql).toContain('__solvi_total');
      const finalOrder = sql.slice(sql.lastIndexOf('ORDER BY'));
      const order = direction.toUpperCase();
      expect(compact(finalOrder)).toMatch(
        new RegExp(`^ORDER BY [a-z_]+\\.created_at ${order}, [a-z_]+\\.id ${order}(?:\\s|$)`),
      );
    },
  );

  it('keeps unassigned and ungrouped filters in the counted population', () => {
    const built = buildListQuery(context(), {
      filter: { keyword: '問', unassignedOnly: true, ungroupedOnly: true },
    });
    const { selection } = materializedSelection(combined(built));
    expect(selection).toContain('t.assignee_id IS NULL');
    expect(selection).toContain('t.assignee_group_id IS NULL');
  });

  it.each([undefined, '', ' ', '\t\n', '\u3000'])(
    'does not create a combined path for inactive keyword %j',
    (keyword) => {
      expect(buildListQuery(context(), { filter: { keyword } })).not.toHaveProperty('combinedSql');
    },
  );

  it.each(['updated_at', 'priority', 'number', 'deadline'] as const)(
    'keeps keyword with %s on the existing two-query contract',
    (column) => {
      expect(
        buildListQuery(context(), { ...search, sort: { column, direction: 'desc' } }),
      ).not.toHaveProperty('combinedSql');
    },
  );
});

function row(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ticketId,
    organization_id: organizationId,
    number: 'SYNTHETIC-047',
    kind: 'incident',
    state: 'pending',
    pending_reason: 'wait_requester',
    subject: '合成問い合わせ',
    body: '単体テストの合成本文',
    requester_id: actorId,
    assignee_id: null,
    assignee_group_id: null,
    impact: 'low',
    urgency: 'medium',
    priority: 'medium',
    created_at: new Date(cursorCreatedAt),
    updated_at: now,
    resolved_at: null,
    closed_at: null,
    first_responded_at: null,
    sla_clock_started_at: null,
    sla_elapsed_seconds: 15,
    sla_elapsed_now: 15,
    remaining_seconds: null,
    response_target_minutes: null,
    resolution_target_minutes: null,
    cursor_created_at: cursorCreatedAt,
    assignee_name: null,
    assignee_group_name: null,
    requester_name: '合成利用者',
    __solvi_total: 1,
    ...changes,
  };
}

function sentinel(total: unknown): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.keys(row()).map((key) => [key, null])),
    __solvi_total: total,
  };
}

function connection(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }));
  return { query, client: { query } as unknown as pg.Client };
}

describe('combined search result decoding', () => {
  it('uses exactly one query and retains native values without returning aggregate metadata', async () => {
    const source = row();
    const { query, client } = connection([source]);
    const result = await new TicketService(client).list(context(), search);
    const built = buildListQuery(context(), search);
    expect(query).toHaveBeenCalledExactlyOnceWith(combined(built), built.params);
    expect(result).toMatchObject({ total: 1, nextCursor: null, scope: 'organization' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: ticketId,
      createdAt: source.created_at,
      version: now.toISOString(),
      assigneeName: null,
      requesterName: '合成利用者',
      sla: { elapsedSeconds: 15, remainingSeconds: null, breached: false },
    });
    expect(result.items[0]!.createdAt).toBeInstanceOf(Date);
    expect(result.items[0]).not.toHaveProperty('__solvi_total');
    expect(result.items[0]).not.toHaveProperty('cursor_created_at');
  });

  it('preserves the exact raw timestamp cursor when a page fills its limit', async () => {
    const { client } = connection([row({ __solvi_total: 8 })]);
    const result = await new TicketService(client).list(context('requester'), {
      ...search,
      limit: 1,
    });
    expect(result).toMatchObject({
      total: 8,
      scope: 'own',
      nextCursor: { createdAt: cursorCreatedAt, id: ticketId },
    });
  });

  it('still returns a cursor for an exactly full final page', async () => {
    const { client } = connection([row()]);
    const result = await new TicketService(client).list(context(), { ...search, limit: 1 });
    expect(result.nextCursor).toEqual({ createdAt: cursorCreatedAt, id: ticketId });
  });

  it.each([0, 41, Number.MAX_SAFE_INTEGER])(
    'decodes a lone all-null page sentinel with exact total %s',
    async (total) => {
      const { query, client } = connection([sentinel(total)]);
      const options: ListOptions = {
        ...search,
        cursor: { createdAt: cursorCreatedAt, id: ticketId },
      };
      await expect(new TicketService(client).list(context(), options)).resolves.toEqual({
        items: [],
        total,
        nextCursor: null,
        scope: 'organization',
      });
      expect(query).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: 'missing', value: undefined },
    { name: 'null', value: null },
    { name: 'string', value: '1' },
    { name: 'negative', value: -1 },
    { name: 'fractional', value: 0.5 },
    { name: 'unsafe', value: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'NaN', value: Number.NaN },
    { name: 'infinite', value: Number.POSITIVE_INFINITY },
    { name: 'bigint', value: 1n },
  ])('rejects a $name total instead of coercing it or returning zero', async ({ value }) => {
    const { query, client } = connection([row({ __solvi_total: value })]);
    await expect(new TicketService(client).list(context(), search)).rejects.toMatchObject({
      status: 500,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'no result or sentinel', rows: [] },
    { name: 'two sentinels', rows: [sentinel(0), sentinel(0)] },
    { name: 'sentinel followed by ticket', rows: [sentinel(1), row()] },
    { name: 'ticket followed by sentinel', rows: [row(), sentinel(1)] },
    { name: 'sentinel carrying ticket data', rows: [{ ...sentinel(0), subject: 'unexpected' }] },
    { name: 'sentinel carrying a timestamp', rows: [{ ...sentinel(0), created_at: now }] },
    {
      name: 'sentinel carrying a raw cursor',
      rows: [{ ...sentinel(0), cursor_created_at: cursorCreatedAt }],
    },
    { name: 'ticket with zero total', rows: [row({ __solvi_total: 0 })] },
    { name: 'too few total for returned rows', rows: [row(), row({ id: secondTicketId })] },
    {
      name: 'inconsistent per-row totals',
      rows: [row({ __solvi_total: 2 }), row({ id: secondTicketId, __solvi_total: 3 })],
    },
    {
      name: 'missing second-row total',
      rows: [row({ __solvi_total: 2 }), row({ id: secondTicketId, __solvi_total: undefined })],
    },
    { name: 'sentinel with invalid total', rows: [sentinel('0')] },
  ])('fails closed on $name', async ({ rows }) => {
    const { query, client } = connection(rows);
    await expect(new TicketService(client).list(context(), search)).rejects.toMatchObject({
      status: 500,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('does not hide a database failure with an empty successful response', async () => {
    const { query, client } = connection([]);
    const failure = new Error('synthetic database failure');
    query.mockRejectedValueOnce(failure);
    await expect(new TicketService(client).list(context(), search)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledOnce();
  });

  it.each<ListOptions>([
    {},
    { filter: { keyword: ' ' } },
    { ...search, sort: { column: 'deadline', direction: 'asc' } },
  ])('keeps the legacy two-query service path for %j', async (options) => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.startsWith('SELECT count(*)::int AS total') ? [{ total: 1 }] : [row()],
    }));
    const client = { query } as unknown as pg.Client;
    const built = buildListQuery(context(), options);
    const result = await new TicketService(client).list(context(), options);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, built.sql, built.params);
    expect(query).toHaveBeenNthCalledWith(2, built.countSql, built.countParams);
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});
