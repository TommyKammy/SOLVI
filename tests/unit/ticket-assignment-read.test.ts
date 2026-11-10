import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import { TicketAssignmentReadService } from '../../services/api/src/modules/ticket/ticket-assignment-read.service.js';

const org = '00000000-0000-4000-8000-000000000001';
const one = '00000000-0000-4000-8000-00000000000a';
const two = '00000000-0000-4000-8000-00000000000b';
const ctx = (role: RoleCode = 'org_admin'): AuthzContext => ({
  organizationId: org,
  now: new Date('2026-10-05T00:00:00Z'),
  principal: {
    userId: one,
    status: 'active',
    bindings: [
      {
        roleCode: role,
        organizationId: role === 'platform_admin' ? null : org,
        validFrom: new Date(0),
        validUntil: null,
      },
    ],
  },
});
function setup(rows: unknown[] = []) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }));
  return { query, service: new TicketAssignmentReadService({ query } as unknown as pg.PoolClient) };
}

describe('Ticket-owned assignment counts', () => {
  it.each(['org_admin', 'platform_admin'] as const)(
    'allows %s and issues one bounded aggregate without changing target eligibility',
    async (role) => {
      const { query, service } = setup([{ assignee_id: one, open_tickets: 4 }]);
      const values = await service.countOpenByAssignees(ctx(role), [
        one,
        one.toUpperCase(),
        two,
        one,
      ]);
      expect([...values]).toEqual([
        [one, 4],
        [one.toUpperCase(), 4],
        [two, 0],
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0]!;
      expect(params).toEqual([org, [one, two]]);
      expect(sql).toContain('organization_id = $1 AND assignee_id = ANY($2::uuid[])');
      expect(sql).toContain("state NOT IN ('resolved', 'closed', 'cancelled', 'merged')");
      expect(sql).toContain('GROUP BY assignee_id');
      expect(sql).not.toMatch(/app_user|role_binding|BEGIN|COMMIT|ROLLBACK/);
    },
  );
  it('authorizes before returning an empty map and never queries for authorized empty input', async () => {
    const { query, service } = setup();
    expect(await service.countOpenByAssignees(ctx(), [])).toEqual(new Map());
    await expect(service.countOpenByAssignees(ctx('requester'), [])).rejects.toMatchObject({
      status: 403,
    });
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['requester', 'agent', 'approver', 'auditor', 'platform_auditor'] as const)(
    'denies %s before querying',
    async (role) => {
      const { query, service } = setup();
      await expect(service.countOpenByAssignees(ctx(role), [one])).rejects.toMatchObject({
        status: 403,
      });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each(['inactive', 'expired', 'future', 'foreign'] as const)(
    'denies an %s administrator context',
    async (condition) => {
      const context = ctx();
      if (condition === 'inactive') context.principal.status = 'deactivated';
      if (condition === 'expired') context.principal.bindings[0]!.validUntil = context.now!;
      if (condition === 'future') context.principal.bindings[0]!.validFrom = new Date('2099-01-01');
      if (condition === 'foreign') context.organizationId = two;
      const { query, service } = setup();
      await expect(service.countOpenByAssignees(context, [one])).rejects.toMatchObject({
        status: 403,
      });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{}],
    [{ assignee_id: two, open_tickets: 1 }],
    [{ assignee_id: one, open_tickets: -1 }],
    [{ assignee_id: one, open_tickets: 1.5 }],
    [{ assignee_id: one, open_tickets: '1' }],
    [{ assignee_id: one, open_tickets: Number.NaN }],
    [
      { assignee_id: one, open_tickets: 1 },
      { assignee_id: one, open_tickets: 2 },
    ],
  ])('rejects malformed aggregate rows instead of returning a false zero: %j', async (...rows) => {
    const { service } = setup(rows);
    await expect(service.countOpenByAssignees(ctx(), [one])).rejects.toMatchObject({ status: 500 });
  });
  it('preserves database failures', async () => {
    const { query, service } = setup();
    const failure = new Error('injected count failure');
    query.mockRejectedValueOnce(failure);
    await expect(service.countOpenByAssignees(ctx(), [one])).rejects.toBe(failure);
  });
});
