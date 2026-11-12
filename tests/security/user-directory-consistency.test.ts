import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { newContext, runWithContext } from '@solvi/shared';
import { UserAdminController } from '../../services/api/src/modules/auth/user-admin.routes.js';
import { TicketAssignmentReadService } from '../../services/api/src/modules/ticket/ticket-assignment-read.service.js';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData, cleanOrgProfiles } from '../support/cleanup.js';

// This suite intentionally writes synthetic rows. Never run it against a shared development DB.
let pool: pg.Pool;
let admin: pg.Client;
let owned = false;
let org: string;
let otherOrg: string;
let manager: string;
let member: string;
let otherMember: string;
let foreign: string;
let stopped: string;
let auth: AuthenticatedRequest;
let userIds: string[] = [];
let orgIds: string[] = [];

const run = <T>(fn: () => Promise<T>) => runWithContext(newContext(), fn);
async function authenticated(id: string, organizationId = org): Promise<AuthenticatedRequest> {
  // Controller-level test: use the stored principal, without replacing the HTTP/session tests.
  const { rows } = await admin.query(
    `SELECT u.status,r.code,rb.organization_id,rb.valid_from,rb.valid_until
    FROM app_user u JOIN role_binding rb ON rb.user_id=u.id JOIN role r ON r.id=rb.role_id WHERE u.id=$1`,
    [id],
  );
  if (rows.length === 0) throw new Error('Synthetic principal is missing');
  return {
    userId: id,
    sessionId: randomUUID(),
    authz: {
      organizationId,
      principal: {
        userId: id,
        status: rows[0].status,
        bindings: rows.map((row) => ({
          roleCode: row.code as RoleCode,
          organizationId: row.organization_id,
          validFrom: row.valid_from as Date,
          validUntil: row.valid_until as Date | null,
        })),
      },
    },
  };
}
async function person(organizationId: string, roles: RoleCode[], status = 'active') {
  const id = randomUUID();
  userIds.push(id);
  await admin.query(
    `INSERT INTO app_user(id,display_name,primary_email,status,created_via,deactivated_at)
    VALUES($1,$2,$3,$4,'admin',CASE WHEN $4='deactivated' THEN now() ELSE NULL END)`,
    [id, `Synthetic ${id}`, `${id}@example.test`, status],
  );
  for (const role of roles)
    await admin.query(
      `INSERT INTO role_binding
    (id,user_id,role_id,role_scope,organization_id,source,valid_from)
    SELECT $1,$2,id,$5,$3,'manual',now()-interval '1 day' FROM role WHERE code=$4`,
      [
        randomUUID(),
        id,
        role.startsWith('platform_') ? null : organizationId,
        role,
        role.startsWith('platform_') ? 'platform' : 'org',
      ],
    );
  return id;
}
async function ticket(
  state: string,
  assignee: string | null = member,
  organizationId = org,
  mergedInto: string | null = null,
) {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO ticket
    (id,organization_id,number,kind,state,subject,body,requester_id,assignee_id,impact,urgency,priority,resolved_at,closed_at,merged_into_id)
    VALUES($1,$2,$3,'incident',$4,'Synthetic directory test','Synthetic test only',$5,$6,'low','low','low',
      CASE WHEN $4 IN ('resolved','closed') THEN now() ELSE NULL END,
      CASE WHEN $4='closed' THEN now() ELSE NULL END,$7)`,
    [
      id,
      organizationId,
      `WP045-${id}`,
      state,
      organizationId === org ? manager : foreign,
      assignee,
      mergedInto,
    ],
  );
  return id;
}
type Hook = (
  sql: string,
  params: unknown[] | undefined,
  phase: 'before' | 'after',
  real: pg.PoolClient,
) => Promise<void>;
function instrument(hook: Hook): pg.Pool {
  return {
    connect: async () => {
      const real = await pool.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          await hook(sql, params, 'before', real);
          const result = await real.query(sql, params);
          await hook(sql, params, 'after', real);
          return result;
        },
        release: () => real.release(),
      };
    },
  } as unknown as pg.Pool;
}

async function connectIsolatedDatabase() {
  const appUrl = process.env.DATABASE_URL,
    adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('Owned performance database is required');
  const appEndpoint = new URL(appUrl),
    adminEndpoint = new URL(adminUrl);
  if (
    !['postgres:', 'postgresql:'].includes(appEndpoint.protocol) ||
    !['postgres:', 'postgresql:'].includes(adminEndpoint.protocol) ||
    !['127.0.0.1', 'localhost'].includes(appEndpoint.hostname) ||
    appEndpoint.hostname !== adminEndpoint.hostname ||
    (appEndpoint.port || '5432') !== (adminEndpoint.port || '5432') ||
    appEndpoint.pathname !== adminEndpoint.pathname
  )
    throw new Error('Matching isolated database endpoints are required');
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const database = (await admin.query('SELECT current_database() AS name')).rows[0]?.name;
  // Existing .github/workflows/ci.yml creates this service database for test:security.
  const isolatedCi =
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.CI === 'true' &&
    database === 'solvi' &&
    appEndpoint.hostname === 'localhost' &&
    (appEndpoint.port || '5432') === '5432';
  if (
    typeof database !== 'string' ||
    (!/^solvi_perf041_\d+_[a-f0-9]{12}$/.test(database) && !isolatedCi)
  )
    throw new Error('Owned performance database is required');
  pool = new pg.Pool({ connectionString: appUrl, max: 4 });
  const proof = (
    await pool.query(`SELECT current_database() AS name, current_user AS role, current_setting('row_security') AS row_security,
    r.rolsuper, r.rolbypassrls, c.relowner = r.oid AS owns_ticket, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='ticket'::regclass`)
  ).rows[0];
  expect(proof).toMatchObject({
    name: database,
    role: 'solvi_app',
    row_security: 'on',
    rolsuper: false,
    rolbypassrls: false,
    owns_ticket: false,
    relrowsecurity: true,
    relforcerowsecurity: true,
  });
  owned = true;
}
beforeAll(async () => {
  try {
    await connectIsolatedDatabase();
  } catch {
    // URL parsing and connection failures can include endpoint details; keep setup output fixed.
    throw new Error('Isolated directory database setup failed');
  }
});
beforeEach(async () => {
  if (!owned) throw new Error('Owned performance database is required');
  userIds = [];
  orgIds = [randomUUID(), randomUUID()];
  [org, otherOrg] = orgIds as [string, string];
  for (const id of orgIds)
    await admin.query('INSERT INTO organization(id,code,name) VALUES($1,$2,$3)', [
      id,
      `wp045-${id}`,
      'Synthetic directory organization',
    ]);
  manager = await person(org, ['org_admin']);
  member = await person(org, ['agent', 'requester']);
  otherMember = await person(org, ['agent']);
  stopped = await person(org, ['agent'], 'deactivated');
  foreign = await person(otherOrg, ['agent']);
  auth = await authenticated(manager);
});
afterEach(async () => {
  if (!owned || orgIds.length === 0) return;
  // UUIDs are generated in this test, never caller-supplied identifiers.
  await cleanAuditData(admin, `organization_id IN (${orgIds.map((id) => `'${id}'`).join(',')})`);
  await admin.query('DELETE FROM ticket WHERE organization_id=ANY($1::uuid[])', [orgIds]);
  await admin.query('DELETE FROM session WHERE user_id=ANY($1::uuid[])', [userIds]);
  await cleanOrgProfiles(admin, { userIds, orgIds });
  await admin.query('DELETE FROM role_binding WHERE user_id=ANY($1::uuid[])', [userIds]);
  await admin.query('DELETE FROM app_user WHERE id=ANY($1::uuid[])', [userIds]);
  await admin.query('DELETE FROM organization WHERE id=ANY($1::uuid[])', [orgIds]);
  orgIds = [];
});
afterAll(async () => {
  const results = await Promise.allSettled([pool?.end(), admin?.end()]);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('Isolated directory database connection cleanup failed');
});

describe('directory counts on the real RLS transaction', () => {
  it('counts all nonterminal states, preserves stopped/multiple-role members and excludes foreign/unassigned work', async () => {
    await admin.query(
      `UPDATE role_binding SET valid_until=now()+interval '14 days'
      WHERE user_id=$1 AND role_id=(SELECT id FROM role WHERE code='requester')`,
      [member],
    );
    const first = await ticket('new');
    for (const state of ['assigned', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled'])
      await ticket(state);
    await ticket('merged', member, org, first);
    await ticket('new', null);
    await ticket('pending', stopped);
    await ticket('new', member, otherOrg);
    const result = await new UserAdminController({ pool }).list(auth);
    expect(result.body.items).toHaveLength(4);
    expect(result.body.items.find((m) => m.userId === member)).toMatchObject({
      openTicketCount: 4,
    });
    expect(result.body.items.find((m) => m.userId === member)?.roleCodes.sort()).toEqual([
      'agent',
      'requester',
    ]);
    expect(result.body.items.find((m) => m.userId === member)?.temporaryRoles).toEqual([
      expect.objectContaining({
        roleCode: 'requester',
        validUntil: expect.any(String),
        expiringSoon: true,
      }),
    ]);
    expect(result.body.items.find((m) => m.userId === stopped)).toMatchObject({
      status: 'deactivated',
      openTicketCount: 1,
    });
    expect(result.body.items.find((m) => m.userId === otherMember)?.openTicketCount).toBe(0);
    expect(result.body.items.some((m) => m.userId === foreign)).toBe(false);
  });

  it('keeps one snapshot through committed assignment/state/binding changes and refreshes on the next request', async () => {
    const reassigned = await ticket('assigned'),
      resolved = await ticket('pending');
    let changed = false;
    const isolatedPool = instrument(async (sql, _params, phase, real) => {
      if (phase !== 'after' || changed || !sql.includes('array_remove(array_agg')) return;
      const proof = (
        await real.query(`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS read_only, app_current_org() AS organization`)
      ).rows[0];
      expect(proof).toEqual({ isolation: 'repeatable read', read_only: 'on', organization: org });
      await admin.query('BEGIN');
      try {
        await admin.query('UPDATE ticket SET assignee_id=$1 WHERE id=$2', [
          otherMember,
          reassigned,
        ]);
        await admin.query("UPDATE ticket SET state='resolved',resolved_at=now() WHERE id=$1", [
          resolved,
        ]);
        await admin.query(
          `UPDATE role_binding SET valid_until=now() WHERE user_id=$1
          AND role_id=(SELECT id FROM role WHERE code='agent')`,
          [member],
        );
        await admin.query('COMMIT');
        changed = true;
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
    });
    const first = await new UserAdminController({ pool: isolatedPool }).list(auth);
    expect(changed).toBe(true);
    expect(first.body.items.find((m) => m.userId === member)).toMatchObject({ openTicketCount: 2 });
    expect(first.body.items.find((m) => m.userId === member)?.roleCodes.sort()).toEqual([
      'agent',
      'requester',
    ]);
    const next = await new UserAdminController({ pool }).list(auth);
    expect(next.body.items.find((m) => m.userId === member)).toMatchObject({
      openTicketCount: 0,
      roleCodes: ['requester'],
    });
    expect(next.body.items.find((m) => m.userId === otherMember)?.openTicketCount).toBe(1);
  });

  it('preserves expiration filtering without narrowing the stop count for an expired target', async () => {
    await ticket('pending');
    await admin.query(
      "UPDATE role_binding SET valid_until=now()-interval '1 hour' WHERE user_id=$1",
      [member],
    );
    const users = new UserAdminController({ pool });
    expect((await users.list(auth)).body.items.some((m) => m.userId === member)).toBe(false);
    const result = await run(() =>
      users.deactivate(auth, member, { reason: 'Synthetic stop test' }),
    );
    expect(result.body.openTicketCount).toBe(1);
    expect(
      (await admin.query('SELECT status FROM app_user WHERE id=$1', [member])).rows[0].status,
    ).toBe('deactivated');
  });

  it('uses both organization predicates and RLS for foreign target IDs and mismatched context', async () => {
    await ticket('pending');
    await ticket('new', foreign, otherOrg);
    const platform = await authenticated(await person(org, ['platform_admin']), otherOrg);
    const real = await pool.connect();
    try {
      await real.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await real.query('SELECT set_config($1,$2,true)', ['app.current_org', org]);
      const service = new TicketAssignmentReadService(real);
      expect(await service.countOpenByAssignees(auth.authz, [member, member, foreign])).toEqual(
        new Map([
          [member, 1],
          [foreign, 0],
        ]),
      );
      expect(await service.countOpenByAssignees(platform.authz, [foreign])).toEqual(
        new Map([[foreign, 0]]),
      );
    } finally {
      await real.query('ROLLBACK');
      real.release();
    }
  });

  it.each(['agent', 'requester', 'expired', 'deactivated'] as const)(
    'denies %s actors through the real controller',
    async (condition) => {
      const id =
        condition === 'agent'
          ? otherMember
          : await person(
              org,
              [condition === 'requester' ? 'requester' : 'org_admin'],
              condition === 'deactivated' ? 'deactivated' : 'active',
            );
      if (condition === 'expired')
        await admin.query(
          "UPDATE role_binding SET valid_until=now()-interval '1 hour' WHERE user_id=$1",
          [id],
        );
      const testAuth = await authenticated(id);
      await expect(new UserAdminController({ pool }).list(testAuth)).rejects.toMatchObject({
        status: 403,
      });
    },
  );

  it.each(['count', 'audit'] as const)(
    'rolls back account/session/audit state on a real DB %s failure',
    async (failure) => {
      await ticket('pending');
      const issued = await new SessionService(admin).issue({
        userId: member,
        authMethod: 'local',
        organizationId: org,
      });
      let injected = false,
        mutationsObserved = false;
      const brokenPool = instrument(async (sql, params, phase, real) => {
        if (phase !== 'before' || injected) return;
        const trigger =
          failure === 'count'
            ? sql.includes('GROUP BY assignee_id')
            : sql.includes('INSERT INTO audit_event') && params?.[9] === 'deactivate.reason';
        if (!trigger) return;
        injected = true;
        if (failure === 'audit') {
          const user = (await real.query('SELECT status FROM app_user WHERE id=$1', [member]))
            .rows[0];
          const session = (
            await real.query('SELECT revoked_at FROM session WHERE id=$1', [issued.session.id])
          ).rows[0];
          mutationsObserved = user?.status === 'deactivated' && Boolean(session?.revoked_at);
        }
        await real.query('SELECT 1 / 0');
      });
      await expect(
        run(() =>
          new UserAdminController({ pool: brokenPool }).deactivate(auth, member, {
            reason: 'Synthetic failure test',
          }),
        ),
      ).rejects.toThrow();
      expect(injected).toBe(true);
      if (failure === 'audit') expect(mutationsObserved).toBe(true);
      expect(
        (await admin.query('SELECT status,deactivated_at FROM app_user WHERE id=$1', [member]))
          .rows[0],
      ).toEqual({ status: 'active', deactivated_at: null });
      expect(
        (await admin.query('SELECT revoked_at FROM session WHERE id=$1', [issued.session.id]))
          .rows[0].revoked_at,
      ).toBeNull();
      expect(
        (
          await admin.query('SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1', [
            org,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await admin.query('SELECT count(*)::int AS n FROM ticket WHERE assignee_id=$1', [member]))
          .rows[0].n,
      ).toBe(1);
    },
  );
});
