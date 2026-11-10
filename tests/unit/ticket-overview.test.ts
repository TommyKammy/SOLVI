import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import {
  buildTicketOverviewQuery,
  TICKET_OVERVIEW_METRICS,
} from '../../services/api/src/modules/ticket/overview-query.js';
import { TicketOverviewService } from '../../services/api/src/modules/ticket/overview.service.js';
import {
  parseOverviewQuery,
  TicketOverviewController,
} from '../../services/api/src/modules/ticket/overview.routes.js';
import {
  buildListQuery,
  SLA_BREACHED_SQL,
  SLA_JOIN_SQL,
} from '../../services/api/src/modules/ticket/ticket-query.js';

const organizationId = '04300000-0000-4000-8000-000000000001';
const actorId = '04300000-0000-4000-8000-000000000002';
const groupId = '04300000-0000-4000-8000-000000000003';
const now = new Date('2026-10-04T00:00:00Z');
const context = (role: RoleCode = 'agent'): AuthzContext => ({
  organizationId,
  now,
  principal: {
    userId: actorId,
    status: 'active',
    bindings: [
      {
        roleCode: role,
        organizationId: role.startsWith('platform_') ? null : organizationId,
        validFrom: new Date('2026-10-03T00:00:00Z'),
        validUntil: null,
      },
    ],
  },
});
const auth = (ctx = context()): AuthenticatedRequest => ({
  authz: ctx,
  sessionId: 'owned-unit-session',
  userId: ctx.principal.userId,
});
const counts = { open: 27, unassigned: 4, mine: 8, pending: 5, breached: 2, critical: 3 };

describe('overview scope validation and staff authorization', () => {
  it.each(['', 'mine', 'ungrouped', groupId])(
    'accepts only the existing group scope %s',
    (group) => {
      expect(parseOverviewQuery(new URLSearchParams({ group }))).toEqual(group ? { group } : {});
      expect(() => buildTicketOverviewQuery(context(), { group })).not.toThrow();
    },
  );
  it('treats an omitted group as all of the authenticated organization', () => {
    expect(parseOverviewQuery(new URLSearchParams())).toEqual({});
    expect(buildTicketOverviewQuery(context()).params).toEqual([
      organizationId,
      actorId,
      ['new', 'assigned', 'in_progress', 'pending'],
    ]);
  });
  it.each([
    'group=mine&group=mine',
    'group=&group=',
    'group=unknown',
    'group=00000000-0000-0000-0000000000000000',
    'group=%20mine',
    'group=mine&state=closed',
    'organizationId=other',
    'requester=me',
    'limit=0',
    'assignment=mine',
    'sla=breached',
    'sort=deadline',
  ])('rejects malformed, duplicate or arbitrary metric-altering parameters: %s', (query) => {
    expect(() => parseOverviewQuery(new URLSearchParams(query))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
  it('does not interpolate UUID parameters or accept injected group values in the builder', () => {
    const query = buildTicketOverviewQuery(context(), { group: groupId });
    expect(query.sql).not.toContain(groupId);
    expect(query.sql).toContain('t.assignee_group_id = $4::uuid');
    expect(query.params[3]).toBe(groupId);
    expect(() => buildTicketOverviewQuery(context(), { group: "' OR true --" })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
  it.each(['agent', 'org_admin', 'platform_admin'] as const)(
    'uses the existing active staff rule for %s',
    (role) => {
      expect(() => buildTicketOverviewQuery(context(role))).not.toThrow();
    },
  );
  it.each(['requester', 'approver', 'auditor', 'platform_auditor'] as const)(
    'denies non-staff role %s rather than counting own tickets',
    (role) => {
      expect(() => buildTicketOverviewQuery(context(role))).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    },
  );
  it.each(['deactivated', 'expired', 'future', 'other-organization', 'unbound'])(
    'retains the existing principal/binding restriction: %s',
    (reason) => {
      const ctx = context();
      if (reason === 'deactivated') ctx.principal.status = 'deactivated';
      if (reason === 'expired') ctx.principal.bindings[0]!.validUntil = now;
      if (reason === 'future') ctx.principal.bindings[0]!.validFrom = new Date(now.getTime() + 1);
      if (reason === 'other-organization') ctx.principal.bindings[0]!.organizationId = groupId;
      if (reason === 'unbound') ctx.principal.bindings = [];
      expect(() => buildTicketOverviewQuery(ctx)).toThrow(expect.objectContaining({ status: 403 }));
    },
  );
});

describe('one aggregate preserves the six metric definitions', () => {
  it('has one explicit organization/open-state population and exactly the existing six counts', () => {
    const query = buildTicketOverviewQuery(context());
    expect(query.sql).toContain('WHERE t.organization_id = $1 AND t.state = ANY($3::text[])');
    expect(query.sql).toContain('t.assignee_id IS NULL');
    expect(query.sql).toContain('t.assignee_id=$2');
    expect(query.sql).toContain("t.state='pending'");
    expect(query.sql).toContain("t.priority='critical'");
    expect(TICKET_OVERVIEW_METRICS).toEqual([
      'open',
      'unassigned',
      'mine',
      'pending',
      'breached',
      'critical',
    ]);
    expect(query.sql).not.toMatch(
      /app_user|ORDER BY|LIMIT|response_sla_breached|resolution_sla_breached/,
    );
  });
  it('uses the identical live resolution-SLA predicate as the existing ticket-list count', () => {
    const query = buildTicketOverviewQuery(context());
    const list = buildListQuery(context(), { filter: { slaBreachedOnly: true } });
    expect(query.sql).toContain(SLA_JOIN_SQL);
    expect(query.sql).toContain(SLA_BREACHED_SQL);
    expect(list.countSql).toContain(SLA_BREACHED_SQL);
    expect(SLA_BREACHED_SQL).toContain('p.resolution_target_minutes IS NOT NULL');
    expect(SLA_BREACHED_SQL).toContain(' > p.resolution_target_minutes * 60');
    expect(SLA_BREACHED_SQL).toContain('sla_clock_started_at IS NOT NULL');
    expect(SLA_BREACHED_SQL).toContain(
      'GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.sla_clock_started_at))))',
    );
  });
  it('keeps mine membership inside the aggregate with active/current-org constraints, even if no membership exists', () => {
    const query = buildTicketOverviewQuery(context(), { group: 'mine' });
    expect(query.sql).toContain('t.assignee_group_id IN (');
    expect(query.sql).toContain('m.organization_id=g.organization_id');
    expect(query.sql).toContain(
      'g.organization_id=$1 AND m.organization_id=$1 AND m.user_id=$2 AND g.active',
    );
    expect(query.params).toHaveLength(3);
    expect(query.sql).not.toContain(' OR ');
  });
  it('distinguishes an unassigned group from an unassigned person', () => {
    const query = buildTicketOverviewQuery(context(), { group: 'ungrouped' });
    expect(query.sql).toContain('AND t.assignee_group_id IS NULL');
    expect(query.sql).toContain('FILTER (WHERE t.assignee_id IS NULL)');
  });
});

function connection(rows: unknown[] = [counts]) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.startsWith('SELECT count(*)') ? rows : [],
  }));
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  return {
    query,
    release,
    connect,
    client: client as unknown as pg.PoolClient,
    pool: { connect } as unknown as pg.Pool,
  };
}

describe('overview service and transaction failure behavior', () => {
  it('returns exact counts using one aggregate query and drops unrequested driver fields', async () => {
    const { client, query } = connection([{ ...counts, privateDetail: 'not returned' }]);
    await expect(new TicketOverviewService(client).read(context())).resolves.toEqual({
      scope: 'organization',
      counts,
    });
    expect(query).toHaveBeenCalledOnce();
  });
  it('preserves a real all-zero result', async () => {
    const zero = { open: 0, unassigned: 0, mine: 0, pending: 0, breached: 0, critical: 0 };
    await expect(
      new TicketOverviewService(connection([zero]).client).read(context()),
    ).resolves.toEqual({ scope: 'organization', counts: zero });
  });
  it.each([
    { rows: [] },
    { rows: [counts, counts] },
    { rows: [{ ...counts, breached: null }] },
    { rows: [{ ...counts, open: '27' }] },
    { rows: [{ ...counts, pending: -1 }] },
    { rows: [{ ...counts, critical: 0.5 }] },
    { rows: [{}] },
  ])('fails a malformed aggregate instead of substituting zero: $rows', async ({ rows }) => {
    await expect(
      new TicketOverviewService(connection(rows).client).read(context()),
    ).rejects.toMatchObject({ status: 500 });
  });
  it('sets transaction-local org/actor and commits the single aggregate before releasing', async () => {
    const { pool, query, release } = connection();
    const result = await new TicketOverviewController({ pool }).read(
      auth(),
      new URLSearchParams({ group: 'mine' }),
    );
    expect(result).toEqual({ status: 200, body: { scope: 'organization', counts } });
    expect(query.mock.calls[0]![0]).toBe('BEGIN READ ONLY');
    expect(query.mock.calls[1]).toEqual([
      "SELECT set_config('app.current_org',$1,true), set_config('app.current_actor',$2,true)",
      [organizationId, actorId],
    ]);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT count(*)'))).toHaveLength(1);
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
  it('does not acquire a DB connection for forbidden principals or invalid query scope', async () => {
    const { pool, connect } = connection();
    const controller = new TicketOverviewController({ pool });
    await expect(
      controller.read(auth(context('requester')), new URLSearchParams()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.read(auth(), new URLSearchParams('group=mine&group=ungrouped')),
    ).rejects.toMatchObject({ status: 400 });
    expect(connect).not.toHaveBeenCalled();
  });
  it('rolls back and releases on aggregate failure without turning it into a successful empty read', async () => {
    const { pool, query, release } = connection();
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT count(*)')) throw new Error('AGGREGATE_FAILED');
      return { rows: [] };
    });
    await expect(
      new TicketOverviewController({ pool }).read(auth(), new URLSearchParams()),
    ).rejects.toThrow('AGGREGATE_FAILED');
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
