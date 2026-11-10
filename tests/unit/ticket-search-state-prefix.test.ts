import { TICKET_STATES, type TicketState } from '@solvi/shared';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import {
  buildListQuery,
  type ListOptions,
  type TicketFilter,
} from '../../services/api/src/modules/ticket/ticket-query.js';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';

const organizationId = '04900000-0000-4000-8000-000000000001';
const actorId = '04900000-0000-4000-8000-000000000002';
const otherId = '04900000-0000-4000-8000-000000000003';
const ticketId = '04900000-0000-4000-8000-000000000004';
const now = new Date('2026-10-05T00:00:00Z');
const createdFrom = new Date('2026-10-01T00:00:00Z');
const cursorCreatedAt = '2026-10-04 23:59:59.123456+00';
const stateEquality = 't.state = ($2::text[])[1]';
const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();

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
          validFrom: createdFrom,
          validUntil: null,
        },
      ],
    },
  };
}

// These checks cover the SQL contract; actual branch execution, RLS, NULL rows
// and physical scan bounds belong to the isolated PostgreSQL comparison.
function cte(sql: string, name: string): string {
  const marker = new RegExp(`\\b${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(`, 'i').exec(sql);
  if (!marker) throw new Error(`Missing test CTE: ${name}`);
  const start = marker.index + marker[0].length;
  let depth = 1;
  for (let index = start; index < sql.length; index += 1) {
    if (sql[index] === '(') depth += 1;
    if (sql[index] === ')') depth -= 1;
    if (depth === 0) return compact(sql.slice(start, index));
  }
  throw new Error(`Unclosed test CTE: ${name}`);
}

function query(options: ListOptions = {}, ctx = context()) {
  const built = buildListQuery(ctx, {
    ...options,
    filter: { keyword: '合', state: ['new'], ...options.filter },
  });
  if (!built.combinedSql) throw new Error('Expected the combined search query');
  return { ...built, combinedSql: built.combinedSql };
}

describe('single-state ordered prefix eligibility', () => {
  it.each(TICKET_STATES)('uses the existing array binding for state %s', (state) => {
    const built = query({ filter: { state: [state] } });
    expect(cte(built.combinedSql, 'probe_keys')).toBe(
      `SELECT t.id, t.created_at FROM ticket t WHERE t.organization_id = $1 AND ${stateEquality} ORDER BY t.created_at DESC, t.id DESC LIMIT $4`,
    );
    expect(built.countParams).toEqual([organizationId, [state], '%合%']);
    expect(built.params).toEqual([...built.countParams, 50]);
    expect(built.countSql).toContain('t.state = ANY($2::text[])');
    expect(built.countSql).not.toContain(stateEquality);
  });

  it.each(['agent', 'auditor', 'org_admin', 'platform_admin', 'platform_auditor'] as const)(
    'allows an effective organization-wide %s role',
    (role) => {
      expect(cte(query({}, context(role)).combinedSql, 'probe_keys')).toContain(stateEquality);
    },
  );

  it.each(['requester', 'approver'] as const)(
    'retains the authorized own prefix for %s',
    (role) => {
      const built = query({}, context(role));
      expect(cte(built.combinedSql, 'probe_keys')).toBe(
        'SELECT t.id, t.created_at FROM ticket t WHERE t.organization_id = $1 AND t.requester_id = $2 ORDER BY t.created_at DESC, t.id DESC LIMIT $5',
      );
      expect(built.countParams).toEqual([organizationId, actorId, ['new'], '%合%']);
      expect(cte(built.combinedSql, 'probe_evaluation')).toContain('t.state = ANY($3::text[])');
    },
  );

  it.each(['expired', 'future', 'other-organization', 'deactivated', 'unbound'])(
    'does not enable the state prefix for an ineffective staff binding: %s',
    (reason) => {
      const ctx = context();
      const binding = ctx.principal.bindings[0]!;
      if (reason === 'expired') binding.validUntil = now;
      if (reason === 'future') binding.validFrom = new Date(now.getTime() + 1);
      if (reason === 'other-organization') binding.organizationId = otherId;
      if (reason === 'deactivated') ctx.principal.status = 'deactivated';
      if (reason === 'unbound') ctx.principal.bindings = [];
      const prefix = cte(query({}, ctx).combinedSql, 'probe_keys');
      expect(prefix).toContain('WHERE t.organization_id = $1 AND t.requester_id = $2');
      expect(prefix).not.toContain('t.state');
    },
  );

  it.each<{ name: string; state: TicketState[] | undefined }>([
    { name: 'absent', state: undefined },
    { name: 'empty', state: [] },
    { name: 'multiple', state: ['new', 'pending'] },
    { name: 'duplicate single value', state: ['new', 'new'] },
  ])('keeps the previous prefix for $name state input', ({ state }) => {
    const built = query({ filter: { state } });
    expect(cte(built.combinedSql, 'probe_keys')).toBe(
      `SELECT t.id, t.created_at FROM ticket t WHERE t.organization_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT $${built.params.length}`,
    );
    if (state?.length) expect(built.countParams[1]).toEqual(state);
  });
});

describe('single-state prefix leaves all other selection semantics intact', () => {
  const filters: Array<{ name: string; filter: TicketFilter; clause: string }> = [
    {
      name: 'priority',
      filter: { priority: ['critical'] },
      clause: 't.priority = ANY($3::text[])',
    },
    { name: 'kind', filter: { kind: ['incident'] }, clause: 't.kind = ANY($3::text[])' },
    { name: 'assignee', filter: { assigneeId: actorId }, clause: 't.assignee_id = $3' },
    { name: 'unassigned', filter: { unassignedOnly: true }, clause: 't.assignee_id IS NULL' },
    { name: 'null assignee', filter: { assigneeId: null }, clause: 't.assignee_id IS NULL' },
    { name: 'requester', filter: { requesterId: otherId }, clause: 't.requester_id = $3' },
    {
      name: 'group',
      filter: { assigneeGroupIds: [otherId] },
      clause: 't.assignee_group_id = ANY($3)',
    },
    { name: 'ungrouped', filter: { ungroupedOnly: true }, clause: 't.assignee_group_id IS NULL' },
    { name: 'from date', filter: { createdFrom }, clause: 't.created_at >= $3' },
    { name: 'to date', filter: { createdTo: now }, clause: 't.created_at <= $3' },
    {
      name: 'SLA breach',
      filter: { slaBreachedOnly: true },
      clause: 'p.resolution_target_minutes IS NOT NULL',
    },
  ];

  it.each(filters)('evaluates $name after the ordered state prefix limit', ({ filter, clause }) => {
    const built = query({ filter });
    const prefix = cte(built.combinedSql, 'probe_keys');
    expect(prefix).toBe(
      `SELECT t.id, t.created_at FROM ticket t WHERE t.organization_id = $1 AND ${stateEquality} ORDER BY t.created_at DESC, t.id DESC LIMIT $${built.params.length}`,
    );
    const predicate = compact(built.countSql.slice(built.countSql.indexOf('WHERE ') + 6));
    expect(predicate).toContain(clause);
    expect(predicate).toContain('t.state = ANY($2::text[])');
    expect(predicate).toContain('t.search_text ILIKE');
    expect(cte(built.combinedSql, 'probe_evaluation')).toContain(
      `(${predicate}) IS TRUE AS matches`,
    );
    expect(cte(built.combinedSql, 'matched')).toContain(`WHERE ${predicate}`);
    expect(cte(built.combinedSql, 'counted')).toContain(`WHERE ${predicate}`);
    expect(prefix).not.toContain('JOIN');
  });

  it.each(['asc', 'desc'] as const)(
    'preserves %s cursor precision, total and final order',
    (direction) => {
      const filter: TicketFilter = {
        state: ['pending'],
        priority: ['critical'],
        kind: ['incident'],
        assigneeId: actorId,
        requesterId: otherId,
        assigneeGroupIds: [otherId],
        createdFrom,
        createdTo: now,
        slaBreachedOnly: true,
        keyword: '  100%_\\literal  ',
      };
      const first = query({ filter, sort: { column: 'created_at', direction } });
      const next = query({
        filter,
        sort: { column: 'created_at', direction },
        cursor: { createdAt: cursorCreatedAt, id: ticketId },
      });
      expect(next.countParams).toEqual([
        organizationId,
        ['pending'],
        ['critical'],
        ['incident'],
        actorId,
        otherId,
        [otherId],
        createdFrom,
        now,
        '%100\\%\\_\\\\literal%',
      ]);
      expect(next.params).toEqual([...next.countParams, cursorCreatedAt, ticketId, 50]);
      expect(next.countSql).toBe(first.countSql);
      expect(next.countParams).toEqual(first.countParams);
      const tuple = `(t.created_at, t.id) ${direction === 'asc' ? '>' : '<'} ($11::timestamptz, $12::uuid)`;
      expect(cte(next.combinedSql, 'probe_keys')).toBe(
        `SELECT t.id, t.created_at FROM ticket t WHERE t.organization_id = $1 AND ${stateEquality} AND ${tuple} ORDER BY t.created_at ${direction.toUpperCase()}, t.id ${direction.toUpperCase()} LIMIT $13`,
      );
      expect(cte(next.combinedSql, 'selected_keys')).toContain(tuple);
      for (const name of ['probe_evaluation', 'matched', 'counted']) {
        expect(cte(next.combinedSql, name)).not.toContain('$11::timestamptz');
      }
      expect(compact(next.combinedSql)).toMatch(
        new RegExp(
          `ORDER BY combined\\.created_at ${direction.toUpperCase()}, combined\\.id ${direction.toUpperCase()}$`,
        ),
      );
    },
  );

  it.each([
    [undefined, 50],
    [0, 1],
    [1, 1],
    [50, 50],
    [200, 200],
    [201, 200],
  ])('keeps the request-derived prefix and fallback bound %s -> %s', (limit, expected) => {
    const built = query({ limit });
    expect(built.limit).toBe(expected);
    expect(built.params.at(-1)).toBe(expected);
    for (const name of ['probe_keys', 'selected_keys']) {
      expect(cte(built.combinedSql, name)).toContain(`LIMIT $${built.params.length}`);
    }
    expect(cte(built.combinedSql, 'counted')).not.toContain('LIMIT');
  });

  it('retains true-row completeness, empty-prefix counting and mutually exclusive fallback', () => {
    const built = query();
    expect(cte(built.combinedSql, 'probe_status')).toBe(
      'SELECT count(*) = count(*) FILTER (WHERE matches IS TRUE) AS usable FROM probe_evaluation',
    );
    expect(cte(built.combinedSql, 'probe_evaluation')).toContain(') IS TRUE AS matches');
    expect(cte(built.combinedSql, 'matched')).toContain(
      'AND NOT (SELECT usable FROM probe_status)',
    );
    expect(cte(built.combinedSql, 'counted')).toContain(
      'SELECT CASE WHEN usable THEN ( SELECT count(*)::int',
    );
    expect(cte(built.combinedSql, 'counted')).toContain(
      'ELSE (SELECT count(*)::int FROM matched) END AS __solvi_total',
    );
    expect(cte(built.combinedSql, 'selected_keys')).toContain(
      'WHERE NOT (SELECT usable FROM probe_status)',
    );
    expect(compact(built.combinedSql)).toContain('FROM counted LEFT JOIN page ON TRUE');
  });

  it('changes only the prefix predicate compared with an equivalent duplicate-state request', () => {
    const single = query();
    const duplicate = query({ filter: { state: ['new', 'new'] } });
    expect(single.sql).toBe(duplicate.sql);
    expect(single.countSql).toBe(duplicate.countSql);
    expect(single.combinedSql.replace(` AND ${stateEquality}`, '')).toBe(duplicate.combinedSql);
    expect(single.params).toEqual(
      duplicate.params.map((value, index) => (index === 1 ? ['new'] : value)),
    );
    expect(single.countParams).toEqual(
      duplicate.countParams.map((value, index) => (index === 1 ? ['new'] : value)),
    );
    expect(cte(single.combinedSql, 'page')).toContain(
      'JOIN LATERAL ( SELECT t.* FROM ticket t WHERE t.id = selected.id AND t.organization_id = $1 LIMIT 1 ) t ON TRUE',
    );
    expect(cte(single.combinedSql, 'page')).toMatch(
      /^SELECT t\.\*, t\.created_at::text AS cursor_created_at,/,
    );
  });

  it.each(['合', '問い合わせ', 'Ａ', 'a'.repeat(100), ' %_\\ '])(
    'does not choose a branch from literal keyword %j',
    (keyword) => {
      const built = query({ filter: { keyword } });
      expect(built.combinedSql).toBe(query().combinedSql);
      expect(built.countParams.at(-1)).toBe(`%${keyword.trim().replace(/([%_\\])/g, '\\$1')}%`);
    },
  );

  it.each<ListOptions>([
    { filter: { keyword: undefined } },
    { filter: { keyword: '' } },
    { filter: { keyword: ' \u3000\n' } },
    ...(['updated_at', 'priority', 'number', 'deadline'] as const).map((column) => ({
      filter: { keyword: '合' },
      sort: { column, direction: 'asc' as const },
    })),
  ])('leaves the non-combined path unchanged for %j', (options) => {
    const single = buildListQuery(context(), {
      ...options,
      filter: { ...options.filter, state: ['new'] },
    });
    const duplicate = buildListQuery(context(), {
      ...options,
      filter: { ...options.filter, state: ['new', 'new'] },
    });
    expect(single).not.toHaveProperty('combinedSql');
    expect(single.sql).toBe(duplicate.sql);
    expect(single.countSql).toBe(duplicate.countSql);
    expect(single.params).toEqual(
      duplicate.params.map((value, index) => (index === 1 ? ['new'] : value)),
    );
  });
});

function row(total: unknown = 1): Record<string, unknown> {
  return {
    id: ticketId,
    organization_id: organizationId,
    number: 'SYNTHETIC-049',
    kind: 'incident',
    state: 'new',
    pending_reason: null,
    subject: '合成問い合わせ',
    body: '単体テスト',
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
    sla_elapsed_seconds: 0,
    sla_elapsed_now: 0,
    remaining_seconds: null,
    response_target_minutes: null,
    resolution_target_minutes: null,
    cursor_created_at: cursorCreatedAt,
    assignee_name: null,
    assignee_group_name: null,
    requester_name: '合成利用者',
    __solvi_total: total,
  };
}

function connection(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }));
  return { query, client: { query } as unknown as pg.Client };
}

describe('state-prefix requests preserve strict native result decoding', () => {
  const options: ListOptions = { filter: { keyword: '合', state: ['new'] }, limit: 1 };

  it('executes one query and retains native dates and the precise cursor without private metadata', async () => {
    const source = row(8);
    const { client, query } = connection([source]);
    const built = buildListQuery(context(), options);
    const result = await new TicketService(client).list(context(), options);
    expect(query).toHaveBeenCalledExactlyOnceWith(built.combinedSql, built.params);
    expect(result).toMatchObject({
      total: 8,
      scope: 'organization',
      nextCursor: { createdAt: cursorCreatedAt, id: ticketId },
    });
    expect(result.items[0]!.createdAt).toBe(source.created_at);
    expect(result.items[0]).not.toHaveProperty('__solvi_total');
    expect(result.items[0]).not.toHaveProperty('cursor_created_at');
  });

  it.each([0, 8])('retains total %s on an empty or terminal page', async (total) => {
    const sentinel = {
      ...Object.fromEntries(Object.keys(row()).map((key) => [key, null])),
      __solvi_total: total,
    };
    const { client, query } = connection([sentinel]);
    await expect(
      new TicketService(client).list(context(), {
        ...options,
        cursor: { createdAt: cursorCreatedAt, id: ticketId },
      }),
    ).resolves.toEqual({ items: [], total, nextCursor: null, scope: 'organization' });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'does not relax invalid-total rejection on a state-prefix request (%s)',
    async (total) => {
      const { client, query } = connection([{ ...row(), __solvi_total: total }]);
      await expect(new TicketService(client).list(context(), options)).rejects.toMatchObject({
        status: 500,
      });
      expect(query).toHaveBeenCalledOnce();
    },
  );
});
