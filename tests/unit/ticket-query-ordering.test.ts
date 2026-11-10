import { describe, expect, it } from 'vitest';
import type { AuthzContext } from '../../services/api/src/common/authz/authz.js';
import { buildListQuery } from '../../services/api/src/modules/ticket/ticket-query.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const context: AuthzContext = {
  organizationId,
  principal: {
    userId,
    status: 'active',
    bindings: [{ roleCode: 'agent', organizationId, validFrom: new Date(0), validUntil: null }],
  },
};

describe('ticket ordering uses the existing keyset index without changing authorization or SLA', () => {
  it.each(['asc', 'desc'] as const)(
    'retains %s keyset comparison, tie breaker and exact cursor precision',
    (direction) => {
      const timestamp = '2026-10-04 00:00:00.123456+00';
      const query = buildListQuery(context, {
        sort: { column: 'created_at', direction },
        cursor: { createdAt: timestamp, id: userId },
        limit: 50,
      });
      const order = direction.toUpperCase();
      expect(query.sql).toContain(`ORDER BY t.created_at ${order}, t.id ${order}`);
      expect(query.sql).not.toContain('NULLS LAST');
      expect(query.sql).toContain(
        `(t.created_at, t.id) ${direction === 'desc' ? '<' : '>'} ($2::timestamptz, $3::uuid)`,
      );
      expect(query.params).toEqual([organizationId, timestamp, userId, 50]);
      expect(query.countParams).toEqual([organizationId]);
      expect(query.countSql).not.toContain('t.id)');
    },
  );

  it('keeps deadline nulls last, computes current SLA and rejects a created-at cursor for deadline order', () => {
    const query = buildListQuery(context, { sort: { column: 'deadline', direction: 'asc' } });
    expect(query.sql).toContain('ORDER BY remaining_seconds ASC NULLS LAST, t.id ASC');
    expect(query.sql).toContain('CASE WHEN p.resolution_target_minutes IS NULL THEN NULL');
    expect(query.sql).toContain('now() - t.sla_clock_started_at');
    expect(() =>
      buildListQuery(context, {
        sort: { column: 'deadline', direction: 'asc' },
        cursor: { createdAt: '2026-10-04 00:00:00.123456+00', id: userId },
      }),
    ).toThrow();
  });

  it('retains requester own scope and identical filter/count parameters with default order', () => {
    const requester: AuthzContext = {
      ...context,
      principal: {
        ...context.principal,
        bindings: [{ ...context.principal.bindings[0]!, roleCode: 'requester' }],
      },
    };
    const query = buildListQuery(requester, {
      filter: { state: ['new', 'pending'], unassignedOnly: true, keyword: '100%_test' },
    });
    for (const sql of [query.sql, query.countSql]) {
      expect(sql).toContain('t.organization_id = $1 AND t.requester_id = $2');
      expect(sql).toContain('t.assignee_id IS NULL');
      expect(sql).toContain('t.state = ANY($3::text[])');
      expect(sql).toContain('t.search_text ILIKE $4');
    }
    expect(query.countParams).toEqual([
      organizationId,
      userId,
      ['new', 'pending'],
      '%100\\%\\_test%',
    ]);
    expect(query.params).toEqual([...query.countParams, 50]);
    expect(query.sql).toContain('ORDER BY t.created_at DESC, t.id DESC');
  });

  it.each(['updated_at', 'priority', 'number'] as const)(
    'leaves non-created-at %s ordering unchanged',
    (column) => {
      expect(buildListQuery(context, { sort: { column, direction: 'desc' } }).sql).toContain(
        `ORDER BY t.${column} DESC NULLS LAST, t.id DESC`,
      );
    },
  );
});
