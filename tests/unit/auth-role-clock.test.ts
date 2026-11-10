import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { SESSION_COOKIE_NAME } from '@solvi/shared';
import { AuthController } from '../../services/api/src/modules/auth/auth.routes';
import {
  SessionService,
  type SessionValidation,
} from '../../services/api/src/modules/auth/session.service';
import { hasRole, type Principal } from '../../services/api/src/common/authz/authz';

const organizationId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const origin = Date.parse('2026-11-10T15:00:00Z');
const headers = { cookie: `${SESSION_COOKIE_NAME}=clock-unit-fixture` };
function fixture(databaseNow: Date | undefined, validFrom: Date, validUntil: Date | null) {
  const principal: Principal = {
    userId,
    status: 'active',
    bindings: [{ roleCode: 'catalog_editor', organizationId, validFrom, validUntil }],
  };
  const validation: SessionValidation = {
    valid: true,
    principal,
    session: {
      id: userId,
      userId,
      organizationId,
      authMethod: 'local',
      issuedAt: new Date(origin - 1000),
      absoluteExpiresAt: new Date(origin + 3600000),
      idleExpiresAt: new Date(origin + 300000),
    },
  };
  const validate = vi.spyOn(SessionService.prototype, 'validate').mockResolvedValue(validation);
  const query = vi.fn(async (sql: string) => ({
    rows:
      sql.includes('authorization_now') && databaseNow !== undefined
        ? [{ authorization_now: databaseNow }]
        : [],
    rowCount: 1,
  }));
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as pg.Pool;
  const controller = new AuthController(pool, {
    localAuthEnabled: true,
    cookieSecure: false,
    localAuth: { maxFailedAttempts: 5, lockoutSeconds: 900 },
  });
  return { controller, validate, validation, query, release };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FR-IDM-006 PostgreSQL clock for role binding validity', () => {
  it('refuses a binding already expired in PostgreSQL even when the host is behind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(origin - 60000));
    const runtime = fixture(new Date(origin), new Date(origin - 120000), new Date(origin - 1));
    const authenticated = await runtime.controller.authenticate(headers);
    expect(authenticated.authz.now?.getTime()).toBe(origin);
    expect(hasRole(authenticated.authz, 'catalog_editor')).toBe(false);
  });
  it('permits a currently valid database binding even when the host is ahead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(origin + 60000));
    const runtime = fixture(new Date(origin), new Date(origin - 1000), new Date(origin + 1000));
    expect(hasRole((await runtime.controller.authenticate(headers)).authz, 'catalog_editor')).toBe(
      true,
    );
  });
  it('does not activate a future database binding just because the host clock is ahead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(origin + 60000));
    const runtime = fixture(new Date(origin), new Date(origin + 1000), null);
    expect(hasRole((await runtime.controller.authenticate(headers)).authz, 'catalog_editor')).toBe(
      false,
    );
  });
  it('uses an exclusive expiry boundary for immediate revocation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(origin - 60000));
    const runtime = fixture(new Date(origin), new Date(origin - 1000), new Date(origin));
    expect(hasRole((await runtime.controller.authenticate(headers)).authz, 'catalog_editor')).toBe(
      false,
    );
  });
  it('reloads validation for each request and does not cache a previously granted role', async () => {
    const runtime = fixture(new Date(origin), new Date(origin - 1000), null);
    expect(hasRole((await runtime.controller.authenticate(headers)).authz, 'catalog_editor')).toBe(
      true,
    );
    runtime.validate.mockResolvedValue({
      ...runtime.validation,
      valid: true,
      principal: { userId, status: 'active', bindings: [] },
    } as SessionValidation);
    expect(hasRole((await runtime.controller.authenticate(headers)).authz, 'catalog_editor')).toBe(
      false,
    );
    expect(runtime.validate).toHaveBeenCalledTimes(2);
    expect(runtime.release).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, new Date(NaN)])(
    'fails closed when the database authorization clock is unavailable: %j',
    async (databaseNow) => {
      const runtime = fixture(databaseNow, new Date(origin - 1000), null);
      await expect(runtime.controller.authenticate(headers)).rejects.toMatchObject({ status: 500 });
      expect(runtime.release).toHaveBeenCalledOnce();
    },
  );
});
