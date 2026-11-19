import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditEventsController,
  parseAuditEventsQuery,
} from '../../services/api/src/modules/audit/audit-events.routes';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes';
import type { RoleCode } from '../../services/api/src/common/authz/authz';

const write = vi.hoisted(() => vi.fn());
vi.mock('../../services/api/src/common/audit/audit.js', () => ({ recordAuditEvent: write }));
const id = '05100000-0000-4000-8000-000000000001';
const org = '05100000-0000-4000-8000-000000000010';
const anotherOrg = '05100000-0000-4000-8000-000000000020';
const query = 'from=2026-11-01&to=2026-11-19';

function actor(roleCode: RoleCode, organizationId = org): AuthenticatedRequest {
  return {
    authz: {
      organizationId: org,
      principal: {
        userId: id,
        status: 'active',
        bindings: [{ roleCode, organizationId, validFrom: new Date(0), validUntil: null }],
      },
    },
  } as AuthenticatedRequest;
}

function stack(fields: Record<string, unknown> = {}) {
  const sql = vi
    .fn()
    .mockResolvedValue({ rows: [] })
    .mockImplementation(async (statement: string) =>
      statement.includes('FROM audit_event')
        ? {
            rows: [
              {
                event_id: id,
                event_type: 'role.binding.created',
                occurred_at: new Date('2026-11-19T06:00:00Z'),
                actor_type: 'user',
                actor_id: id,
                subject_user_id: id,
                target_id: id,
                before_role: 'synthetic-unapproved-value',
                after_role: 'agent',
                step_no: null,
                before_state: { syntheticPrivateMarker: 'do not return' },
                ...fields,
              },
            ],
          }
        : { rows: [] },
    );
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: sql, release }));
  return {
    controller: new AuditEventsController({ pool: { connect } as unknown as pg.Pool }),
    sql,
    release,
    connect,
  };
}

beforeEach(() => write.mockReset().mockResolvedValue(undefined));

describe('audit view', () => {
  it.each([
    'from=2026-02-30&to=2026-03-01',
    'from=2026-11-19&to=2026-11-18',
    'from=2026-10-01&to=2026-11-01',
    query + '&category=role&category=approval',
    query + '&category=unsupported',
    query + '&event=unknown',
    query + '&page=201',
    query + '&organization=' + anotherOrg,
  ])('rejects invalid selection %s', (value) => {
    expect(() => parseAuditEventsQuery(new URLSearchParams(value))).toThrow();
  });

  it('checks organization authorization before obtaining a connection', async () => {
    const { controller, connect } = stack();
    await expect(controller.read(actor('org_admin'), new URLSearchParams(query))).rejects.toThrow();
    await expect(
      controller.read(actor('auditor', anotherOrg), new URLSearchParams(query)),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it('filters with the selected organization and appends a sanitized read event', async () => {
    const { controller, sql, release } = stack();
    const result = await controller.read(
      actor('auditor'),
      new URLSearchParams(query + '&category=role&event=' + id),
    );
    expect(result.items[0]).toMatchObject({ id, roleBefore: null, roleAfter: 'agent' });
    expect(result.items[0]).not.toHaveProperty('before_state');
    const [statement, values] = sql.mock.calls.find(([text]) => text.includes('FROM audit_event'))!;
    expect(statement).toContain('organization_id = $1::uuid');
    expect(values[0]).toBe(org);
    expect(values[5]).toBe(id);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'audit.viewed',
        organizationId: org,
        afterState: expect.objectContaining({ category: 'role', eventCount: 1, detail: true }),
      }),
    );
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(sql.mock.invocationCallOrder.at(-1)!);
    expect(sql).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and withholds the result when viewing cannot be recorded', async () => {
    const { controller, sql, release } = stack();
    write.mockImplementationOnce(() => {
      throw new Error('audit write failed');
    });
    await expect(controller.read(actor('auditor'), new URLSearchParams(query))).rejects.toThrow(
      'audit write failed',
    );
    expect(sql).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('allows the linked ticket and receipt only for relevant event types', async () => {
    const fields = { ticket_id: id, receipt_ref: id };
    const simulation = stack({ ...fields, event_type: 'request.simulated' });
    const params = new URLSearchParams(query + '&category=automation');
    expect(parseAuditEventsQuery(params).types).toEqual(['request.simulated']);
    const run = await simulation.controller.read(actor('auditor'), params);
    expect(run.items[0]).toMatchObject({ ticketId: id, receiptId: id });
    const suggestion = stack({ ...fields, event_type: 'ai.suggestion.accepted' });
    const decision = await suggestion.controller.read(
      actor('auditor'),
      new URLSearchParams(query + '&category=assistance'),
    );
    expect(decision.items[0]).toMatchObject({ ticketId: id });
    expect(decision.items[0]).not.toHaveProperty('receiptId');
    const role = await stack(fields).controller.read(actor('auditor'), new URLSearchParams(query));
    expect(role.items[0]).not.toHaveProperty('ticketId');
    expect(role.items[0]).not.toHaveProperty('receiptId');
  });
});
