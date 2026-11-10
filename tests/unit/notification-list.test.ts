// FR-TKT-007, NFR-SEC-001, NFR-SEC-006: projection, role checks and scoped paging.
// Actual session/RLS proof is separate in tests/security/notification-list.test.ts.
import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import { NotificationListController } from '../../services/api/src/modules/notification/notification.routes.js';
import {
  buildNotificationPageQuery,
  encodeNotificationCursor,
  NOTIFICATION_CURSOR_MAX_LENGTH,
  NOTIFICATION_EVENT_TYPES,
  NotificationListService,
  parseNotificationListQuery,
  requireNotificationListAccess,
} from '../../services/api/src/modules/notification/notification-list.service.js';

const org = '05600000-0000-4000-8000-000000000001';
const actor = '05600000-0000-4000-8000-000000000002';
const other = '05600000-0000-4000-8000-000000000003';
const now = new Date('2026-10-08T00:00:00Z');
function context(role: RoleCode = 'org_admin'): AuthzContext {
  return {
    organizationId: org,
    now,
    principal: {
      userId: actor,
      status: 'active',
      bindings: [
        {
          roleCode: role,
          organizationId: role.startsWith('platform') ? null : org,
          validFrom: new Date('2026-10-01T00:00:00Z'),
          validUntil: null,
        },
      ],
    },
  };
}
function auth(ctx = context()): AuthenticatedRequest {
  return { authz: ctx, userId: ctx.principal.userId, sessionId: 'unit-session' };
}
const anchor = {
  createdAt: '2026-10-08T00:00:00.123456Z',
  id: '05600000-0000-4000-8000-000000000004',
};
const row = (id = anchor.id) => ({
  id,
  eventType: 'ticket.created',
  channel: 'email',
  status: 'pending',
  createdAt: anchor.createdAt,
  sentAt: null,
  failedAt: null,
  attempts: 0,
  outboxStatus: 'waiting',
  nextAttemptAt: '2026-10-08T00:10:00.000001Z',
  manualRetry: 'unavailable',
});
const opts = () => parseNotificationListQuery(new URLSearchParams(), context());
function clientWith(
  rows: unknown[] = [row()],
  counts = { all: '1', pending: '1', sent: '0', failed: '0' },
  neighbors = { previous: false, next: false },
) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    if (sql.startsWith('SELECT count(*)')) return { rows: [counts] };
    if (sql.startsWith('SELECT n.id')) return { rows };
    if (sql.startsWith('SELECT\n')) return { rows: [neighbors] };
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  const connect = vi.fn(async () => client);
  return { client, query, release, connect, pool: { connect } as unknown as pg.Pool };
}

describe('WP056 selected-organization administration boundary', () => {
  it('accepts a currently active selected-organization administrator', () => {
    expect(() => requireNotificationListAccess(context())).not.toThrow();
    const ctx = context('platform_admin');
    ctx.principal.bindings.push(context().principal.bindings[0]!);
    expect(() => requireNotificationListAccess(ctx)).not.toThrow();
  });
  it.each([
    'agent',
    'requester',
    'approver',
    'auditor',
    'platform_admin',
    'platform_auditor',
  ] as const)('rejects %s before opening a data transaction', async (role) => {
    const fake = clientWith();
    await expect(
      new NotificationListController({ pool: fake.pool }).list(
        auth(context(role)),
        new URLSearchParams(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.connect).not.toHaveBeenCalled();
  });
  it.each([
    'foreign',
    'global',
    'missing',
    'expired',
    'future',
    'deactivated',
    'organizationless',
    'bad-actor',
  ] as const)('rejects %s context', (reason) => {
    const ctx = context();
    const binding = ctx.principal.bindings[0]!;
    if (reason === 'foreign') binding.organizationId = other;
    if (reason === 'global') binding.organizationId = null;
    if (reason === 'missing') ctx.principal.bindings = [];
    if (reason === 'expired') binding.validUntil = now;
    if (reason === 'future') binding.validFrom = new Date(now.getTime() + 1);
    if (reason === 'deactivated') ctx.principal.status = 'deactivated';
    if (reason === 'organizationless') ctx.organizationId = '';
    if (reason === 'bad-actor') ctx.principal.userId = '';
    expect(() => requireNotificationListAccess(ctx)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
  it('records only the fixed denial policy and preserves rejection if the independent recorder fails', async () => {
    const fake = clientWith(),
      record = vi.fn(async () => {
        throw new Error('private unavailable');
      });
    await expect(
      new NotificationListController({ pool: fake.pool, denialRecorder: { record } }).list(
        auth(context('agent')),
        new URLSearchParams('cursor=PRIVATE'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(record).toHaveBeenCalledWith(
      org,
      expect.objectContaining({
        eventType: 'authz.access.denied',
        action: 'list',
        outcome: 'denied',
        policyDecision: { rule: 'notification_selected_org_admin' },
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE');
    expect(fake.connect).not.toHaveBeenCalled();
  });
  it('rejects an inconsistent authenticated actor before setting RLS context', async () => {
    const fake = clientWith();
    await expect(
      new NotificationListController({ pool: fake.pool }).list(
        { ...auth(), userId: other },
        new URLSearchParams(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe('bounded and condition-bound notification cursors', () => {
  it('keeps only the fixed public query contract', () => {
    expect(opts()).toEqual({ status: 'all', direction: 'next', cursor: null });
    for (const status of ['all', 'pending', 'sent', 'failed'])
      expect(parseNotificationListQuery(new URLSearchParams({ status }), context()).status).toBe(
        status,
      );
  });
  it.each([
    'status=',
    'status=unknown',
    'status=all&status=all',
    'direction=',
    'direction=previous',
    'direction=next&direction=next',
    'direction=asc',
    'cursor=',
    'cursor=x&cursor=x',
    'limit=20',
    'page=2',
    'organizationId=' + org,
    'q=PRIVATE',
    'sort=newest',
  ])('rejects malformed or unsupported query %s without echoing values', (query) => {
    expect(() => parseNotificationListQuery(new URLSearchParams(query), context())).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
  it.each(['next', 'previous'] as const)(
    'round-trips %s at actual encoded length, preserving six timestamp digits',
    (direction) => {
      const cursor = encodeNotificationCursor(context(), 'failed', anchor, direction);
      expect(cursor.length).toBeLessThanOrEqual(NOTIFICATION_CURSOR_MAX_LENGTH);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(
        parseNotificationListQuery(
          new URLSearchParams({ status: 'failed', direction, cursor }),
          context(),
        ),
      ).toEqual({ status: 'failed', direction, cursor: anchor });
      expect(cursor).not.toContain(actor);
    },
  );
  it.each(['actor', 'org', 'status', 'direction'] as const)(
    'rejects replay across %s',
    (change) => {
      const ctx = context();
      const query = new URLSearchParams({
        status: 'failed',
        direction: 'next',
        cursor: encodeNotificationCursor(ctx, 'failed', anchor, 'next'),
      });
      if (change === 'actor') ctx.principal.userId = other;
      if (change === 'org') ctx.organizationId = other;
      if (change === 'status') query.set('status', 'all');
      if (change === 'direction') query.set('direction', 'previous');
      expect(() => parseNotificationListQuery(query, ctx)).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    },
  );
  it.each([
    (v: unknown[]) => [2, ...v.slice(1)],
    (v: unknown[]) => [...v, 'extra'],
    (v: unknown[]) => [v[0], 'next', ...v.slice(2)],
    (v: unknown[]) => [v[0], v[1], '2026-02-29T00:00:00.123456Z', ...v.slice(3)],
    (v: unknown[]) => [v[0], v[1], '2026-10-08T00:00:00.123Z', ...v.slice(3)],
    (v: unknown[]) => [v[0], v[1], '2026-10-08T24:00:00.123456Z', ...v.slice(3)],
    (v: unknown[]) => [...v.slice(0, 3), 'not-uuid', v[4]],
  ])('rejects malformed tuple #%#', (alter) => {
    const raw = encodeNotificationCursor(context(), 'all', anchor, 'next');
    const changed = Buffer.from(
      JSON.stringify(alter(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))),
    ).toString('base64url');
    expect(() =>
      parseNotificationListQuery(new URLSearchParams({ cursor: changed }), context()),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('rejects padding, noncanonical JSON, oversized and invalid UTF-8 cursors', () => {
    const raw = encodeNotificationCursor(context(), 'all', anchor, 'next');
    const pretty = Buffer.from(
      JSON.stringify(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')), null, 1),
    ).toString('base64url');
    for (const cursor of [raw + '=', pretty, 'a'.repeat(169), '_w', 'null']) {
      expect(() => parseNotificationListQuery(new URLSearchParams({ cursor }), context())).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    }
  });
});

describe('notification projection and snapshot protocol', () => {
  it('binds both organization boundaries and limits selected fields without fetching private payloads', () => {
    const built = buildNotificationPageQuery(context(), opts());
    expect(built.params).toEqual([org, 'all', [...NOTIFICATION_EVENT_TYPES], 20]);
    expect(built.sql).toContain(
      'o.organization_id=n.organization_id AND o.organization_id=$1::uuid',
    );
    expect(built.sql).toContain('WHERE n.organization_id=$1::uuid');
    expect(built.sql).toContain('ORDER BY n.created_at DESC,n.id DESC LIMIT $4');
    expect(built.sql).not.toMatch(/payload|recipient|subject|link_path|last_error|SELECT\s+\*/);
    expect(built.sql).not.toContain(org);
    expect(built.sql).toContain("WHEN o.locked_until > CURRENT_TIMESTAMP THEN 'processing'");
    expect(built.sql.indexOf("THEN 'stopped'")).toBeLessThan(built.sql.indexOf("THEN 'finished'"));
    expect(built.sql.indexOf("THEN 'finished'")).toBeLessThan(
      built.sql.indexOf("THEN 'processing'"),
    );
    expect(built.sql).toContain("AND n.status IN ('pending','failed')");
  });
  it.each(['next', 'previous'] as const)(
    'uses strict timestamp/id keysets in the %s direction',
    (direction) => {
      const built = buildNotificationPageQuery(context(), { ...opts(), direction, cursor: anchor });
      expect(built.params.slice(0, 4)).toEqual([org, 'all', anchor.createdAt, anchor.id]);
      expect(built.sql).toContain(
        `(n.created_at,n.id) ${direction === 'next' ? '<' : '>'} ($3::timestamptz,$4::uuid)`,
      );
      expect(built.sql).toContain(
        `ORDER BY n.created_at ${direction === 'next' ? 'DESC' : 'ASC'},n.id ${direction === 'next' ? 'DESC' : 'ASC'} LIMIT $6`,
      );
      expect(built.sql).not.toMatch(/OFFSET/);
    },
  );
  it('keeps all-status counts separate from the selected total and strictly projects output keys', async () => {
    const privateRow = {
      ...row(),
      status: 'failed',
      failedAt: anchor.createdAt,
      attempts: 2,
      outboxStatus: 'retry_waiting',
      recipient_address: 'PRIVATE',
      subject: 'PRIVATE',
      last_error: 'PRIVATE',
      payload: { nested: 'PRIVATE' },
      outbox_event_id: other,
    };
    const fake = clientWith(
      [privateRow],
      { all: '9', pending: '5', sent: '1', failed: '3' },
      { previous: true, next: true },
    );
    const body = await new NotificationListService(fake.client).list(context(), {
      ...opts(),
      status: 'failed',
    });
    expect(body).toMatchObject({
      counts: { all: 9, pending: 5, sent: 1, failed: 3 },
      total: 3,
      deliveryMode: 'recording',
    });
    expect(Object.keys(body.items[0]!).sort()).toEqual(
      [
        'id',
        'eventType',
        'channel',
        'status',
        'createdAt',
        'sentAt',
        'failedAt',
        'attempts',
        'outboxStatus',
        'nextAttemptAt',
        'manualRetry',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    expect(
      parseNotificationListQuery(
        new URLSearchParams({
          status: 'failed',
          direction: 'previous',
          cursor: body.previousCursor!,
        }),
        context(),
      ).cursor,
    ).toEqual(anchor);
    expect(
      parseNotificationListQuery(
        new URLSearchParams({ status: 'failed', cursor: body.nextCursor! }),
        context(),
      ).cursor,
    ).toEqual(anchor);
  });
  it('reverses the closest previous page to the same DESC public ordering', async () => {
    const newer = { ...row(other), createdAt: '2026-10-08T00:00:00.123457Z' };
    const fake = clientWith([row(), newer], { all: '2', pending: '2', sent: '0', failed: '0' });
    const body = await new NotificationListService(fake.client).list(context(), {
      ...opts(),
      direction: 'previous',
      cursor: anchor,
    });
    expect(body.items.map((item) => item.id)).toEqual([other, anchor.id]);
    expect(fake.query.mock.calls[2]![1]).toEqual([
      org,
      'all',
      newer.createdAt,
      other,
      anchor.createdAt,
      anchor.id,
    ]);
  });
  it('reports an empty continuation without claiming zero total or inventing a page', async () => {
    const fake = clientWith([], { all: '5', pending: '5', sent: '0', failed: '0' });
    const body = await new NotificationListService(fake.client).list(context(), {
      ...opts(),
      cursor: anchor,
    });
    expect(body).toMatchObject({ total: 5, items: [], previousCursor: null, nextCursor: null });
    expect(fake.query).toHaveBeenCalledTimes(2);
  });
  it('uses one read-only repeatable snapshot and transaction-local actor/org; performs no business writes', async () => {
    const fake = clientWith();
    const result = await new NotificationListController({ pool: fake.pool }).list(
      auth(),
      new URLSearchParams(),
    );
    expect(result.status).toBe(200);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(
      fake.query.mock.calls.map(([sql]) => (sql.startsWith('SELECT') ? 'SELECT' : sql)),
    ).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SELECT',
      'SELECT',
      'SELECT',
      'SELECT',
      'COMMIT',
    ]);
    expect(fake.query.mock.calls[1]![1]).toEqual([org, actor]);
    expect(fake.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/,
    );
    expect(fake.release).toHaveBeenCalledOnce();
  });
  it('rejects malformed query before connecting', async () => {
    const fake = clientWith();
    await expect(
      new NotificationListController({ pool: fake.pool }).list(
        auth(),
        new URLSearchParams('limit=100'),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fake.connect).not.toHaveBeenCalled();
  });
  it.each(['counts', 'page', 'neighbors', 'commit'] as const)(
    'rolls back and releases after a %s failure',
    async (stage) => {
      const fake = clientWith();
      const original = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (sql: string) => {
        if (
          (stage === 'counts' && sql.startsWith('SELECT count')) ||
          (stage === 'page' && sql.startsWith('SELECT n.id')) ||
          (stage === 'neighbors' && sql.startsWith('SELECT\n')) ||
          (stage === 'commit' && sql === 'COMMIT')
        )
          throw new Error('simulated');
        return original(sql);
      });
      await expect(
        new NotificationListController({ pool: fake.pool }).list(auth(), new URLSearchParams()),
      ).rejects.toThrow('simulated');
      expect(fake.query).toHaveBeenLastCalledWith('ROLLBACK');
      expect(fake.release).toHaveBeenCalledOnce();
    },
  );
  it.each([
    'unsafe',
    'negative',
    'sum-mismatch',
    'invalid-row',
    'oversized-page',
    'unknown-status',
  ] as const)('fails closed on invalid database result: %s', async (kind) => {
    const counts = { all: '1', pending: '1', sent: '0', failed: '0' };
    let rows: unknown[] = [row()];
    if (kind === 'unsafe') counts.all = '9007199254740992';
    if (kind === 'negative') counts.all = '-1';
    if (kind === 'sum-mismatch') counts.pending = '0';
    if (kind === 'invalid-row') rows = [{ ...row(), createdAt: 'PRIVATE' }];
    if (kind === 'oversized-page') rows = Array.from({ length: 21 }, () => row());
    if (kind === 'unknown-status') rows = [{ ...row(), status: 'PRIVATE' }];
    const fake = clientWith(rows, counts);
    await expect(new NotificationListService(fake.client).list(context(), opts())).rejects.toThrow(
      'NOTIFICATION_LIST_RESULT_INVALID',
    );
  });
});
