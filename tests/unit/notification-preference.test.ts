import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import {
  NotificationPreferenceController,
  validateNotificationPreferenceWrite,
} from '../../services/api/src/modules/notification/notification-preference.routes.js';
import {
  allowTicketEmailPreparation,
  OPTIONAL_TICKET_EMAIL_EVENTS,
  NotificationPreferenceService,
  requireNotificationPreferenceAccess,
} from '../../services/api/src/modules/notification/notification-preference.service.js';
import {
  NotificationService,
  type NotificationSender,
} from '../../services/api/src/modules/notification/notification.service.js';

const org = '05700000-0000-4000-8000-000000000001';
const user = '05700000-0000-4000-8000-000000000002';
const other = '05700000-0000-4000-8000-000000000003';
const event = '05700000-0000-4000-8000-000000000004';
const now = new Date('2026-10-08T00:00:00Z');
function context(role: RoleCode = 'requester'): AuthzContext {
  return {
    organizationId: org,
    now,
    principal: {
      userId: user,
      status: 'active',
      bindings: [
        {
          roleCode: role,
          organizationId: role.startsWith('platform_') ? null : org,
          validFrom: new Date('2026-10-01T00:00:00Z'),
          validUntil: null,
        },
      ],
    },
  };
}
function auth(ctx = context()): AuthenticatedRequest {
  return { authz: ctx, userId: ctx.principal.userId, sessionId: 'synthetic-unit-session' };
}
const headers = () => ({
  'content-type': 'application/json',
  'x-solvi-form-scope': `${org}:${user}`,
});
const emptyQuery = () => new URLSearchParams();

/** Observes transaction commands and the real audit writer. Real RLS/locking use the isolated DB suite. */
function fixture(initial?: boolean) {
  const state = {
    enabled: initial,
    membership: true,
    failAudit: false,
    failRead: false,
    failRollback: false,
  };
  let before = initial;
  const query = vi.fn(async (raw: string, values: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN') before = state.enabled;
    if (sql === 'ROLLBACK') {
      if (state.failRollback) throw new Error('synthetic rollback failure');
      state.enabled = before;
    }
    if (sql.startsWith('SELECT EXISTS'))
      return { rows: [{ allowed: state.membership }], rowCount: 1 };
    if (sql.startsWith('SELECT ticket_email_enabled')) {
      if (state.failRead) throw new Error('synthetic read failure');
      return {
        rows: state.enabled === undefined ? [] : [{ ticket_email_enabled: state.enabled }],
        rowCount: state.enabled === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith('INSERT INTO notification_preference')) {
      state.enabled = values[2] as boolean;
      return { rows: [{ ticket_email_enabled: state.enabled }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO audit_event') && state.failAudit)
      throw new Error('synthetic audit failure');
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as pg.Pool;
  const controller = new NotificationPreferenceController({ pool });
  return { state, query, release, client, connect, pool, controller };
}

describe('WP057 self membership and strict write input', () => {
  it.each(['requester', 'agent', 'approver', 'auditor', 'org_admin'] as const)(
    'allows current %s membership without extending business privileges',
    (role) => {
      expect(() => requireNotificationPreferenceAccess(context(role))).not.toThrow();
    },
  );
  it.each(['platform_admin', 'platform_auditor'] as const)('rejects standalone %s', (role) => {
    expect(() => requireNotificationPreferenceAccess(context(role))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
  it.each([
    'inactive',
    'foreign',
    'global',
    'missing',
    'expired',
    'future',
    'no-org',
    'bad-user',
  ] as const)('rejects %s context before acquiring a connection', async (kind) => {
    const ctx = context(),
      binding = ctx.principal.bindings[0]!;
    if (kind === 'inactive') ctx.principal.status = 'deactivated';
    if (kind === 'foreign') binding.organizationId = other;
    if (kind === 'global') binding.organizationId = null;
    if (kind === 'missing') ctx.principal.bindings = [];
    if (kind === 'expired') binding.validUntil = now;
    if (kind === 'future') binding.validFrom = new Date(now.getTime() + 1);
    if (kind === 'no-org') ctx.organizationId = '';
    if (kind === 'bad-user') ctx.principal.userId = '';
    const f = fixture();
    await expect(f.controller.get(auth(ctx), emptyQuery())).rejects.toMatchObject({ status: 403 });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'accepts a strict boolean %s and JSON media type',
    (ticketEmailEnabled) => {
      expect(validateNotificationPreferenceWrite(auth(), headers(), { ticketEmailEnabled })).toBe(
        ticketEmailEnabled,
      );
      expect(
        validateNotificationPreferenceWrite(
          auth(),
          { ...headers(), 'content-type': 'application/json; charset=utf-8' },
          { ticketEmailEnabled },
        ),
      ).toBe(ticketEmailEnabled);
    },
  );
  it.each([
    null,
    [],
    {},
    true,
    { ticketEmailEnabled: 'false' },
    { ticketEmailEnabled: 0 },
    { ticketEmailEnabled: null },
    { ticketEmailEnabled: false, userId: other },
    { ticketEmailEnabled: false, organizationId: other },
    { ticketEmailEnabled: false, address: 'PRIVATE' },
  ])('rejects invalid input #%# without reflecting private content', async (body) => {
    const f = fixture();
    await expect(f.controller.update(auth(), headers(), body, emptyQuery())).rejects.toMatchObject({
      status: 400,
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'application/json, text/plain',
    'application/json; charset=shift_jis',
    '',
  ])('rejects unsupported content type %s', (type) => {
    expect(() =>
      validateNotificationPreferenceWrite(
        auth(),
        { ...headers(), 'content-type': type },
        { ticketEmailEnabled: false },
      ),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('rejects missing or repeated Content-Type, including case aliases', () => {
    const scope = { 'x-solvi-form-scope': `${org}:${user}` };
    for (const input of [
      scope,
      { ...scope, 'content-type': ['application/json'] },
      { ...headers(), 'Content-Type': 'application/json' },
    ]) {
      expect(() =>
        validateNotificationPreferenceWrite(auth(), input, { ticketEmailEnabled: false }),
      ).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
  it.each(['https://solvi.local', 'null', '', ['https://solvi.local']])(
    'rejects every present Origin #%#',
    (origin) => {
      expect(() =>
        validateNotificationPreferenceWrite(
          auth(),
          { ...headers(), Origin: origin },
          { ticketEmailEnabled: false },
        ),
      ).toThrow(expect.objectContaining({ status: 403 }));
    },
  );
  it.each([undefined, '', `${other}:${user}`, `${org}:${other}`, [`${org}:${user}`]])(
    'rejects missing, changed or repeated form scope #%#',
    (scope) => {
      expect(() =>
        validateNotificationPreferenceWrite(
          auth(),
          { ...headers(), 'x-solvi-form-scope': scope },
          { ticketEmailEnabled: false },
        ),
      ).toThrow(expect.objectContaining({ status: 409 }));
    },
  );
  it('rejects scope header case aliases and inconsistent authenticated actor', async () => {
    const f = fixture();
    await expect(
      f.controller.update(
        auth(),
        { ...headers(), 'X-Solvi-Form-Scope': `${org}:${user}` },
        { ticketEmailEnabled: false },
        emptyQuery(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.controller.get({ ...auth(), userId: other }, emptyQuery()),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    'userId=' + other,
    'organizationId=' + other,
    'ticketEmailEnabled=false',
    'unknown=PRIVATE',
  ])('rejects arbitrary GET/PATCH targeting query %s', async (raw) => {
    const f = fixture(),
      query = new URLSearchParams(raw);
    await expect(f.controller.get(auth(), query)).rejects.toMatchObject({ status: 400 });
    await expect(
      f.controller.update(auth(), headers(), { ticketEmailEnabled: false }, query),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe('preference persistence protocol and audit boundary', () => {
  it('reads missing settings as ON without inserting a default row', async () => {
    const f = fixture();
    expect(await f.controller.get(auth(), emptyQuery())).toEqual({
      status: 200,
      body: { ticketEmailEnabled: true },
    });
    expect(f.query.mock.calls[0]![0]).toBe('BEGIN READ ONLY');
    expect(f.query.mock.calls[1]![1]).toEqual([org, user]);
    expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    expect(f.state.enabled).toBeUndefined();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([undefined, true, false])(
    'does not write or audit a semantic no-op from %s',
    async (initial) => {
      const f = fixture(initial);
      const desired = initial ?? true;
      expect(
        (
          await f.controller.update(
            auth(),
            headers(),
            { ticketEmailEnabled: desired },
            emptyQuery(),
          )
        ).body,
      ).toEqual({ ticketEmailEnabled: desired });
      expect(f.state.enabled).toBe(initial);
      expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    },
  );
  it('persists OFF then ON, audits exact boolean before/after and never writes business notification rows', async () => {
    const f = fixture();
    await f.controller.update(auth(), headers(), { ticketEmailEnabled: false }, emptyQuery());
    expect((await f.controller.get(auth(), emptyQuery())).body).toEqual({
      ticketEmailEnabled: false,
    });
    await f.controller.update(auth(), headers(), { ticketEmailEnabled: true }, emptyQuery());
    const audits = f.query.mock.calls
      .filter(([sql]) => sql.includes('INSERT INTO audit_event'))
      .map(([, args]) => args!);
    expect(audits).toHaveLength(2);
    expect(audits[0]!.slice(1, 13)).toEqual([
      'config.changed',
      org,
      'user',
      user,
      null,
      user,
      'notification_preference',
      user,
      'notification.preference.update',
      'success',
      { ticketEmailEnabled: true },
      { ticketEmailEnabled: false },
    ]);
    expect(audits[1]!.slice(11, 13)).toEqual([
      { ticketEmailEnabled: false },
      { ticketEmailEnabled: true },
    ]);
    expect(f.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /(?:UPDATE|INSERT INTO) (?:notification\b|outbox_event\b)/,
    );
  });
  it('takes a transaction-scoped lock before rechecking live membership and reading the previous value', async () => {
    const f = fixture();
    await f.controller.update(auth(), headers(), { ticketEmailEnabled: false }, emptyQuery());
    const sql = f.query.mock.calls.map(([q]) => q);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[2]).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))');
    expect(f.query.mock.calls[2]![1]).toEqual([`notification-preference:${org}:${user}`]);
    expect(sql[3]).toContain('rb.valid_until > statement_timestamp()');
    expect(sql[3]).toContain("u.status='active'");
    expect(sql[3]).toContain("r.scope='org'");
    expect(sql[4]).toContain('SELECT ticket_email_enabled');
    expect(sql.at(-1)).toBe('COMMIT');
  });
  it('rejects a formerly valid principal when membership changes while awaiting the lock', async () => {
    const f = fixture();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => {
      if (sql.includes('pg_advisory_xact_lock')) f.state.membership = false;
      return original(sql, params);
    });
    await expect(
      f.controller.update(auth(), headers(), { ticketEmailEnabled: false }, emptyQuery()),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.state.enabled).toBeUndefined();
    expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
  it('does not convert preference read failure into a default ON response', async () => {
    const f = fixture(false);
    f.state.failRead = true;
    await expect(f.controller.get(auth(), emptyQuery())).rejects.toThrow('synthetic read failure');
    expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('rolls back a setting change when the real audit writer fails', async () => {
    const f = fixture();
    f.state.failAudit = true;
    await expect(
      f.controller.update(auth(), headers(), { ticketEmailEnabled: false }, emptyQuery()),
    ).rejects.toMatchObject({ name: 'AuditWriteError' });
    expect(f.state.enabled).toBeUndefined();
    expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(f.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });
  it('releases the data connection before opening independent denial audit and destroys it on rollback failure', async () => {
    const f = fixture();
    f.state.membership = false;
    f.state.failRollback = true;
    const record = vi.fn(async () => {
      expect(f.release).toHaveBeenCalledWith(true);
    });
    await expect(
      new NotificationPreferenceController({ pool: f.pool, denialRecorder: { record } }).get(
        auth(),
        emptyQuery(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(record).toHaveBeenCalledWith(
      org,
      expect.objectContaining({ eventType: 'authz.access.denied', outcome: 'denied' }),
    );
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('rejects malformed database booleans instead of guessing defaults', async () => {
    const f = fixture();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('SELECT ticket_email_enabled'))
        return { rows: [{ ticket_email_enabled: null }], rowCount: 1 } as never;
      return original(sql, params);
    });
    await expect(new NotificationPreferenceService(f.client).get(context())).rejects.toThrow(
      'NOTIFICATION_PREFERENCE_RESULT_INVALID',
    );
  });
});

describe('new optional ticket Email gate (real SQL semantics are covered by the isolated DB suite)', () => {
  const ticketEvent = (eventType = 'ticket.created', payload = {}) => ({
    id: event,
    organizationId: org,
    eventType,
    payload: { ticketId: other, ticketNumber: 'TKT-SYNTHETIC', ...payload },
  });
  function delivery(enabled: boolean) {
    const query = vi.fn(async (sql: string, _values: unknown[] = []) => {
      if (sql.includes('SELECT DISTINCT u.id'))
        return { rows: [{ user_id: user, email: 'synthetic@example.invalid' }], rowCount: 1 };
      if (sql.includes('END AS enabled')) return { rows: [{ enabled }], rowCount: 1 };
      if (sql.includes('INSERT INTO notification')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const sender: NotificationSender = { channel: 'email', send: vi.fn(async () => undefined) };
    return {
      query,
      sender,
      service: new NotificationService(
        { query } as unknown as pg.PoolClient,
        new Map([['email', sender]]),
      ),
    };
  }
  it('limits optional events to the five registered ticket handlers, excluding mandatory role expiry and unregistered merge', () => {
    expect([...OPTIONAL_TICKET_EMAIL_EVENTS]).toEqual([
      'ticket.created',
      'ticket.transitioned',
      'ticket.assigned',
      'ticket.comment.added',
      'ticket.reassessed',
    ]);
    expect(OPTIONAL_TICKET_EMAIL_EVENTS.has('ticket.merged')).toBe(false);
    expect(OPTIONAL_TICKET_EMAIL_EVENTS.has('role.binding.expiring')).toBe(false);
  });
  it.each([...OPTIONAL_TICKET_EMAIL_EVENTS])(
    'skips new %s without a notification row, sender or notification audit',
    async (eventType) => {
      const d = delivery(false);
      expect(await d.service.deliverForEvent(ticketEvent(eventType))).toEqual({
        sent: 0,
        skipped: 1,
      });
      expect(d.sender.send).not.toHaveBeenCalled();
      expect(d.query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
    },
  );
  it('retains default/ON creation and does not apply preference to role expiry', async () => {
    const on = delivery(true);
    expect(await on.service.deliverForEvent(ticketEvent())).toEqual({ sent: 1, skipped: 0 });
    expect(on.sender.send).toHaveBeenCalledOnce();
    const mandatory = delivery(false);
    expect(
      await mandatory.service.deliverForEvent({
        id: event,
        organizationId: org,
        eventType: 'role.binding.expiring',
        payload: { userId: user, validUntil: '2030-01-01T00:00:00Z' },
      }),
    ).toEqual({ sent: 1, skipped: 0 });
    expect(mandatory.sender.send).toHaveBeenCalledOnce();
    expect(
      mandatory.query.mock.calls.some(([sql]) => sql.includes('notification_preference')),
    ).toBe(false);
  });
  it('still rejects internal notes before querying preferences or sending', async () => {
    const d = delivery(true);
    expect(
      await d.service.deliverForEvent(
        ticketEvent('ticket.comment.added', { visibility: 'internal' }),
      ),
    ).toEqual({ sent: 0, skipped: 1 });
    expect(d.query).not.toHaveBeenCalled();
    expect(d.sender.send).not.toHaveBeenCalled();
  });
  it('preserves existing-row bypass and organization/user/event/address boundaries in parameterized SQL', async () => {
    const query = vi.fn(async () => ({ rows: [{ enabled: true }] }));
    expect(
      await allowTicketEmailPreparation(
        { query } as unknown as pg.PoolClient,
        org,
        user,
        event,
        'synthetic@example.invalid',
      ),
    ).toBe(true);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([org, user, event, 'synthetic@example.invalid']);
    expect(sql).toContain(
      'organization_id=$1::uuid AND outbox_event_id=$3::uuid AND recipient_address=$4',
    );
    expect(sql).toContain('THEN true ELSE COALESCE');
    expect(sql).toContain('organization_id=$1::uuid AND user_id=$2::uuid');
    expect(sql).not.toContain('app.current_actor');
    expect(sql).not.toContain('synthetic@example.invalid');
  });
  it.each([
    { rows: [] },
    { rows: [{ enabled: null }] },
    { rows: [{ enabled: true }, { enabled: false }] },
  ])('fails closed on malformed delivery decision #%#', async ({ rows }) => {
    const query = vi.fn(async () => ({ rows }));
    await expect(
      allowTicketEmailPreparation(
        { query } as unknown as pg.PoolClient,
        org,
        user,
        event,
        'synthetic@example.invalid',
      ),
    ).rejects.toThrow('NOTIFICATION_PREFERENCE_RESULT_INVALID');
  });
});
