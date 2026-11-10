// NFR-SEC-001, NFR-SEC-004, NFR-SEC-006: execution-time authority, not an idle refresh.
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { OperationSessionService } from '../../services/api/src/modules/auth/operation-session.service.js';

const now = new Date('2026-10-08T00:00:00Z');
const input = {
  sessionId: '05800000-0000-4000-8000-000000000001',
  userId: '05800000-0000-4000-8000-000000000002',
  organizationId: '05800000-0000-4000-8000-000000000003',
};
function fixture(overrides: Record<string, unknown> = {}, missing = false) {
  const row = {
    organization_id: input.organizationId,
    issued_at: new Date(now.getTime() - 60_000),
    absolute_expires_at: new Date(now.getTime() + 600_000),
    idle_expires_at: new Date(now.getTime() + 300_000),
    revoked_at: null,
    user_status: 'active',
    allowed: true,
    ...overrides,
  };
  const query = vi.fn(async () => ({ rows: missing ? [] : [row] }));
  const service = new OperationSessionService({ query } as unknown as pg.PoolClient, () => now);
  return { query, service };
}
describe('WP058 read-only execution session validation', () => {
  it('uses only the authenticated IDs and never reads a token or extends idle expiry', async () => {
    const { service, query } = fixture();
    expect(await service.validate(input)).toEqual({ valid: true });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql.trim()).toMatch(/^SELECT/);
    expect(sql).not.toMatch(/token_hash|UPDATE|INSERT|DELETE|set_config/i);
    expect(values).toEqual([input.sessionId, input.userId, input.organizationId, now]);
  });
  it.each(['sessionId', 'userId', 'organizationId'] as const)(
    'rejects invalid %s before querying',
    async (key) => {
      const { service, query } = fixture();
      expect(await service.validate({ ...input, [key]: 'untrusted' })).toEqual({
        valid: false,
        reason: 'session_invalid',
      });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('rejects a missing session', async () => {
    expect(await fixture({}, true).service.validate(input)).toEqual({
      valid: false,
      reason: 'session_invalid',
    });
  });
  it.each([
    { revoked_at: now },
    { issued_at: new Date(now.getTime() + 1) },
    { absolute_expires_at: now },
    { idle_expires_at: now },
    { idle_expires_at: new Date(now.getTime() + 700_000) },
    { issued_at: new Date(NaN) },
    { idle_expires_at: '2026-10-08' },
  ])('fails closed for invalid session state %j', async (overrides) => {
    expect(await fixture(overrides).service.validate(input)).toEqual({
      valid: false,
      reason: 'session_invalid',
    });
  });
  it.each([
    [{ organization_id: null }, 'organization_changed'],
    [{ organization_id: input.userId }, 'organization_changed'],
    [{ user_status: 'deactivated' }, 'user_inactive'],
    [{ allowed: false }, 'role_invalid'],
    [{ allowed: 'true' }, 'role_invalid'],
  ] as const)('requires current org/user/role %j', async (overrides, reason) => {
    expect(await fixture(overrides).service.validate(input)).toEqual({ valid: false, reason });
  });
  it('evaluates role/session expiry after authority row-lock waits', async () => {
    const initial = fixture();
    const firstRow = (await initial.query()).rows[0];
    let clock = now;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM session')) return { rows: [firstRow] };
      clock = new Date(now.getTime() + 400_000);
      return {
        rows: [{ valid_from: new Date(now.getTime() - 1), valid_until: null }],
      };
    });
    const service = new OperationSessionService({ query } as unknown as pg.PoolClient, () => clock);
    expect(await service.validate(input, { lock: true })).toEqual({
      valid: false,
      reason: 'session_invalid',
    });
    expect(query.mock.calls[0]![0]).toContain('FOR SHARE OF s,u');
    expect(query.mock.calls[1]![0]).toContain('FOR SHARE OF rb');
  });
  it('does not rely on the pre-lock role snapshot after revocation', async () => {
    const initial = fixture();
    const firstRow = (await initial.query()).rows[0];
    const query = vi.fn(async (sql: string) =>
      sql.includes('FROM session')
        ? { rows: [firstRow] }
        : { rows: [{ valid_from: new Date(now.getTime() - 1), valid_until: now }] },
    );
    const service = new OperationSessionService({ query } as unknown as pg.PoolClient, () => now);
    expect(await service.validate(input, { lock: true })).toEqual({
      valid: false,
      reason: 'role_invalid',
    });
  });
});
