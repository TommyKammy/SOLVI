import { describe, expect, it } from 'vitest';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import {
  buildListQuery,
  type ListOptions,
  type TicketFilter,
} from '../../services/api/src/modules/ticket/ticket-query.js';

const organizationId = '04800000-0000-4000-8000-000000000001';
const actorId = '04800000-0000-4000-8000-000000000002';
const otherUserId = '04800000-0000-4000-8000-000000000003';
const groupId = '04800000-0000-4000-8000-000000000004';
const ticketId = '04800000-0000-4000-8000-000000000005';
const cursorCreatedAt = '2026-10-05 00:00:00.123456+00';
const createdFrom = new Date('2026-10-01T00:00:00Z');
const createdTo = new Date('2026-10-05T00:00:00Z');

function context(role: RoleCode = 'agent'): AuthzContext {
  return {
    organizationId,
    now: createdTo,
    principal: {
      userId: actorId,
      status: 'active',
      bindings: [{ roleCode: role, organizationId, validFrom: createdFrom, validUntil: null }],
    },
  };
}

const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// These unit checks establish the SQL boundary, not PostgreSQL branch execution.
// Actual rows, NULL truth values and inactive-plan loops are checked by the isolated analysis.
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

function query(options: ListOptions = {}, role: RoleCode = 'agent') {
  const built = buildListQuery(context(role), {
    ...options,
    filter: { keyword: '合', ...options.filter },
  });
  if (!built.combinedSql) throw new Error('Expected the combined search query');
  return { ...built, combinedSql: built.combinedSql };
}

function countWhere(sql: string): string {
  return compact(sql.slice(sql.indexOf('WHERE ') + 6));
}

describe('authorized ordered prefix search contract', () => {
  it.each([
    ['agent', 'asc'],
    ['agent', 'desc'],
    ['requester', 'asc'],
    ['requester', 'desc'],
  ] as const)(
    'limits the %s prefix after authorization, an eligible state and the %s cursor',
    (role, direction) => {
      const built = query(
        {
          filter: { state: ['pending'], assigneeGroupIds: [groupId], slaBreachedOnly: true },
          sort: { column: 'created_at', direction },
          cursor: { createdAt: cursorCreatedAt, id: ticketId },
        },
        role,
      );
      const seed = cte(built.combinedSql, 'probe_keys');
      const auth =
        role === 'requester'
          ? 't.organization_id = $1 AND t.requester_id = $2'
          : 't.organization_id = $1';
      const cursor = `(t.created_at, t.id) ${direction === 'asc' ? '>' : '<'} ($${built.countParams.length + 1}::timestamptz, $${built.countParams.length + 2}::uuid)`;
      const state = role === 'requester' ? '' : ' AND t.state = ($2::text[])[1]';
      expect(seed).toBe(
        `SELECT t.id, t.created_at FROM ticket t WHERE ${auth}${state} AND ${cursor} ORDER BY t.created_at ${direction.toUpperCase()}, t.id ${direction.toUpperCase()} LIMIT $${built.params.length}`,
      );
      expect(built.combinedSql).toMatch(/probe_keys\s+AS\s+MATERIALIZED\s*\(/);
      expect(cte(built.combinedSql, 'probe_evaluation')).toContain(`WHERE ${auth}`);
      expect(cte(built.combinedSql, 'page')).toContain(`WHERE ${auth}`);
      expect(built.params).toEqual([...built.countParams, cursorCreatedAt, ticketId, 50]);
    },
  );

  const filters: Array<{ name: string; filter: TicketFilter; clause: string }> = [
    { name: 'state', filter: { state: ['new', 'pending'] }, clause: 't.state = ANY($2::text[])' },
    {
      name: 'priority',
      filter: { priority: ['critical'] },
      clause: 't.priority = ANY($2::text[])',
    },
    { name: 'kind', filter: { kind: ['incident'] }, clause: 't.kind = ANY($2::text[])' },
    { name: 'assignee', filter: { assigneeId: actorId }, clause: 't.assignee_id = $2' },
    { name: 'null assignee', filter: { assigneeId: null }, clause: 't.assignee_id IS NULL' },
    { name: 'unassigned', filter: { unassignedOnly: true }, clause: 't.assignee_id IS NULL' },
    { name: 'requester', filter: { requesterId: otherUserId }, clause: 't.requester_id = $2' },
    {
      name: 'group',
      filter: { assigneeGroupIds: [groupId] },
      clause: 't.assignee_group_id = ANY($2)',
    },
    { name: 'ungrouped', filter: { ungroupedOnly: true }, clause: 't.assignee_group_id IS NULL' },
    {
      name: 'SLA breach',
      filter: { slaBreachedOnly: true },
      clause: 'p.resolution_target_minutes IS NOT NULL',
    },
    { name: 'created from', filter: { createdFrom }, clause: 't.created_at >= $2' },
    { name: 'created to', filter: { createdTo }, clause: 't.created_at <= $2' },
  ];

  it.each(filters)(
    'evaluates the entire $name condition only after the prefix limit',
    ({ filter, clause }) => {
      const built = query({ filter });
      const predicate = countWhere(built.countSql);
      const evaluated = cte(built.combinedSql, 'probe_evaluation');
      expect(cte(built.combinedSql, 'probe_keys')).not.toContain(clause);
      expect(evaluated).toContain(`(${predicate}) IS TRUE AS matches`);
      expect(predicate).toContain(clause);
      expect(evaluated).toContain('FROM probe_keys selected JOIN ticket t ON t.id = selected.id');
      expect(cte(built.combinedSql, 'matched')).toContain(`WHERE ${predicate}`);
      expect(cte(built.combinedSql, 'counted')).toContain(`WHERE ${predicate}`);
      if (filter.slaBreachedOnly) {
        expect(evaluated).toContain('LEFT JOIN sla_policy p');
        expect(evaluated).toContain('> p.resolution_target_minutes * 60');
        expect(evaluated).not.toContain('COALESCE');
      }
    },
  );

  it('uses true-row cardinality to reject false or NULL matches and accept an empty prefix', () => {
    const sql = query().combinedSql;
    expect(cte(sql, 'probe_evaluation')).toContain(') IS TRUE AS matches');
    expect(cte(sql, 'probe_status')).toBe(
      'SELECT count(*) = count(*) FILTER (WHERE matches IS TRUE) AS usable FROM probe_evaluation',
    );
    expect(sql).not.toMatch(/\bbool_and\b|\bbool_or\b/i);
  });

  it('keeps both exact totals before the cursor, with mutually exclusive selected-page branches', () => {
    const first = query({ limit: 1 });
    const next = query({ limit: 1, cursor: { createdAt: cursorCreatedAt, id: ticketId } });
    expect(next.countSql).toBe(first.countSql);
    expect(next.countParams).toEqual(first.countParams);
    const counted = cte(next.combinedSql, 'counted');
    expect(counted).toMatch(
      /^SELECT CASE WHEN usable THEN \( SELECT count\(\*\)::int FROM ticket t /,
    );
    expect(counted).toContain('ELSE (SELECT count(*)::int FROM matched) END AS __solvi_total');
    for (const name of ['matched', 'counted', 'probe_evaluation']) {
      expect(cte(next.combinedSql, name)).not.toContain(
        `$${next.countParams.length + 1}::timestamptz`,
      );
    }
    expect(cte(next.combinedSql, 'matched')).toContain('AND NOT (SELECT usable FROM probe_status)');
    const selected = cte(next.combinedSql, 'selected_keys');
    expect(selected).toContain(
      'FROM probe_evaluation WHERE (SELECT usable FROM probe_status) UNION ALL',
    );
    expect(selected).toContain('WHERE NOT (SELECT usable FROM probe_status)');
    expect(selected).toContain(
      `(t.created_at, t.id) < ($${next.countParams.length + 1}::timestamptz`,
    );
    // The count survives when either branch supplies no page, including a terminal cursor.
    expect(compact(next.combinedSql)).toContain('FROM counted LEFT JOIN page ON TRUE');
  });

  it.each([
    [undefined, 50],
    [0, 1],
    [1, 1],
    [50, 50],
    [200, 200],
    [201, 200],
  ])('uses only the existing clamped request limit %s -> %s', (limit, expected) => {
    const built = query({ limit });
    expect(built.limit).toBe(expected);
    expect(built.params.at(-1)).toBe(expected);
    expect(cte(built.combinedSql, 'probe_keys')).toContain(`LIMIT $${built.params.length}`);
    expect(cte(built.combinedSql, 'selected_keys')).toContain(`LIMIT $${built.params.length}`);
  });

  it.each(['agent', 'requester'] as const)(
    'bounds each %s native page refetch by its unique ID before SLA and display joins',
    (role) => {
      const built = query({ limit: 200 }, role);
      const page = cte(built.combinedSql, 'page');
      const auth =
        role === 'requester'
          ? 't.organization_id = $1 AND t.requester_id = $2'
          : 't.organization_id = $1';
      const lookup = `FROM selected_keys selected JOIN LATERAL ( SELECT t.* FROM ticket t WHERE t.id = selected.id AND ${auth} LIMIT 1 ) t ON TRUE`;
      expect(page).toContain(lookup);
      expect(page.indexOf('LEFT JOIN sla_policy')).toBeGreaterThan(page.indexOf(lookup));
      expect(page.indexOf('LEFT JOIN app_user')).toBeGreaterThan(page.indexOf(lookup));
      expect(page.endsWith(`WHERE ${auth}`)).toBe(true);
      // The unique-key refetch bound does not replace the requested page size or limit the total.
      expect(built.limit).toBe(200);
      expect(built.params.at(-1)).toBe(200);
      expect(cte(built.combinedSql, 'counted')).not.toContain('LIMIT');
    },
  );

  it.each(['合', '問い合わせ', 'Ａ', 'a'.repeat(100), ' %_\\ '])(
    'uses the identical prefix plan for literal keyword %j without a word-length threshold',
    (keyword) => {
      const built = query({ filter: { keyword } });
      expect(built.combinedSql).toBe(query().combinedSql);
      expect(built.countParams.at(-1)).toBe(`%${keyword.trim().replace(/([%_\\])/g, '\\$1')}%`);
      expect(built.params).toEqual([...built.countParams, 50]);
    },
  );

  it('fetches native page columns and exposes only the existing private total envelope', () => {
    const built = query();
    const page = cte(built.combinedSql, 'page');
    expect(page).toMatch(/^SELECT t\.\*, t\.created_at::text AS cursor_created_at,/);
    expect(page).not.toMatch(/\bmatches\b|\busable\b|\bjson[b]?_/i);
    expect(compact(built.combinedSql)).toContain('SELECT page.*, counted.__solvi_total');
    expect(compact(built.combinedSql)).toMatch(
      /ORDER BY combined\.created_at DESC, combined\.id DESC$/,
    );
  });
});
