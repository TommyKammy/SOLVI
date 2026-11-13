/**
 * 上長・主部署・部署長の変更履歴API (WP-P4-APR-015 §6.1 / ADR-0023 §3 / TL-06)。
 *
 * - `org_admin` と `auditor` だけが期間指定で読める。それ以外は403。
 * - 監査イベントを読むだけで、新しい履歴テーブルは作らない。
 * - 他組織の変更は含まれない(RLS + APIの組織絞り込み)。
 * - 社員番号・役職・勤務地は応答に含まれない。
 *
 * 実行先は使い捨てDB(名前に `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { newContext, runWithContext } from '@solvi/shared';
import { UserAdminController } from '../../services/api/src/modules/auth/user-admin.routes.js';
import { DepartmentController } from '../../services/api/src/modules/auth/department.routes.js';
import { RelationshipChangeController } from '../../services/api/src/modules/auth/relationship-change.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData } from '../support/cleanup.js';

const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);
const TODAY = new Date().toISOString().slice(0, 10);

let pool: pg.Pool;
let admin: pg.Client;
let users: UserAdminController;
let departments: DepartmentController;
let changes: RelationshipChangeController;

let orgA: string;
let orgB: string;

interface Person {
  id: string;
  displayName: string;
  ctx: AuthenticatedRequest;
}

let adminA: Person;
let auditorA: Person;
let agentA: Person;
let requesterA: Person;
let employeeA: Person;
let managerA: Person;
let adminB: Person;
let employeeB: Person;
let managerB: Person;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

function ctxFor(userId: string, orgId: string, roles: RoleCode[]): AuthzContext {
  return {
    principal: {
      userId,
      status: 'active',
      bindings: roles.map((roleCode) => ({
        roleCode,
        organizationId: orgId,
        validFrom: PAST,
        validUntil: null,
      })),
    },
    organizationId: orgId,
  };
}

function authFor(userId: string, orgId: string, roles: RoleCode[]): AuthenticatedRequest {
  return {
    authz: ctxFor(userId, orgId, roles),
    sessionId: `wp015-rel-${userId.slice(0, 8)}`,
    userId,
  };
}

async function mkOrg(label: string): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)', [
    id,
    `wp015-rel-${label}-${SUFFIX}`,
    `WP015 関係履歴 ${label} (合成)`,
  ]);
  return id;
}

async function mkUser(label: string, orgId: string, roles: RoleCode[]): Promise<Person> {
  const id = randomUUID();
  const displayName = `WP015 rel ${label}`;
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `wp015-rel-${label}-${id.slice(0, 8)}@example.test`, displayName],
  );
  for (const role of roles) {
    await admin.query(
      `INSERT INTO role_binding
         (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = 'org'),
               'org', $4, 'manual', $5, NULL)`,
      [randomUUID(), id, role, orgId, PAST],
    );
  }
  await admin.query('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
    orgId,
    id,
  ]);
  return { id, displayName, ctx: authFor(id, orgId, roles) };
}

async function mkDepartment(person: Person, label: string): Promise<string> {
  const result = await run(() =>
    departments.create(person.ctx, {
      code: `wp015-rel-${label}-${SUFFIX}`,
      name: `WP015 部署 ${label} (合成)`,
    }),
  );
  return result.body.department.id as string;
}

async function expectProblem(
  promise: Promise<unknown>,
  status: number,
  messagePart?: string,
): Promise<void> {
  let caught: (Error & { status?: number }) | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { status?: number };
  }
  expect(caught, '拒否されるべき操作が成功した').toBeDefined();
  expect(caught?.status, caught?.message).toBe(status);
  if (messagePart) {
    const text = `${caught?.message ?? ''} ${JSON.stringify((caught as { errors?: unknown }).errors ?? [])}`;
    expect(text).toContain(messagePart);
  }
}

const list = (person: Person, params: Record<string, string> = { from: TODAY, to: TODAY }) =>
  run(() => changes.list(person.ctx, new URLSearchParams(params)));

const typesOf = (items: Array<{ changeType: string }>) => items.map((item) => item.changeType);

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 8 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const client of [pool, admin]) {
    const name = (await client.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は使い捨てDBではありません。中止します`);
    }
  }

  users = new UserAdminController({ pool });
  departments = new DepartmentController({ pool });
  changes = new RelationshipChangeController({ pool });

  orgA = await mkOrg('a');
  orgB = await mkOrg('b');
  adminA = await mkUser('admin-a', orgA, ['org_admin']);
  auditorA = await mkUser('auditor-a', orgA, ['auditor']);
  agentA = await mkUser('agent-a', orgA, ['agent']);
  requesterA = await mkUser('requester-a', orgA, ['requester']);
  employeeA = await mkUser('employee-a', orgA, ['requester']);
  managerA = await mkUser('manager-a', orgA, ['requester']);
  adminB = await mkUser('admin-b', orgB, ['org_admin']);
  employeeB = await mkUser('employee-b', orgB, ['requester']);
  managerB = await mkUser('manager-b', orgB, ['requester']);
}, 60_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanAuditData(admin, `organization_id IN ('${orgA}', '${orgB}')`);
      const orgs = [orgA, orgB];
      await admin.query('DELETE FROM department_head WHERE organization_id = ANY($1::uuid[])', [
        orgs,
      ]);
      await admin.query(
        `UPDATE org_member_profile
            SET manager_user_id=NULL, primary_department_id=NULL,
                job_title=NULL, location=NULL, employee_id=NULL
          WHERE organization_id = ANY($1::uuid[])`,
        [orgs],
      );
      await admin.query('DELETE FROM org_member_profile WHERE organization_id = ANY($1::uuid[])', [
        orgs,
      ]);
      await admin.query(
        'UPDATE department SET parent_id=NULL WHERE organization_id = ANY($1::uuid[])',
        [orgs],
      );
      await admin.query('DELETE FROM department WHERE organization_id = ANY($1::uuid[])', [orgs]);
      const userIds = [
        adminA,
        auditorA,
        agentA,
        requesterA,
        employeeA,
        managerA,
        adminB,
        employeeB,
        managerB,
      ].map((person) => person.id);
      await admin.query('DELETE FROM role_binding WHERE organization_id = ANY($1::uuid[])', [orgs]);
      await admin.query('DELETE FROM role_binding WHERE user_id = ANY($1::uuid[])', [userIds]);
      await admin.query('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [userIds]);
      await admin.query('DELETE FROM organization WHERE id = ANY($1::uuid[])', [orgs]);
    } finally {
      await admin.end();
    }
  }
  await pool?.end();
});

beforeEach(async () => {
  if (!admin) return;
  await cleanAuditData(admin, `organization_id IN ('${orgA}', '${orgB}')`);
  const orgs = [orgA, orgB];
  await admin.query('DELETE FROM department_head WHERE organization_id = ANY($1::uuid[])', [orgs]);
  await admin.query(
    `UPDATE org_member_profile
        SET manager_user_id=NULL, primary_department_id=NULL,
            job_title=NULL, location=NULL, employee_id=NULL
      WHERE organization_id = ANY($1::uuid[])`,
    [orgs],
  );
  await admin.query(
    'UPDATE department SET parent_id=NULL WHERE organization_id = ANY($1::uuid[])',
    [orgs],
  );
  await admin.query('DELETE FROM department WHERE organization_id = ANY($1::uuid[])', [orgs]);
});

describe('役割×エンドポイント (TL-06)', () => {
  it.each([
    ['agent', () => agentA],
    ['requester', () => requesterA],
    ['manager', () => managerA],
  ])('**%s は変更履歴を読めない(403)**', async (_label, personOf) => {
    await expectProblem(list(personOf()), 403);
  });

  it('**org_admin と auditor は読める**', async () => {
    for (const person of [adminA, auditorA]) {
      const result = await list(person);
      expect(result.status).toBe(200);
      expect(result.body.page).toBe(1);
      expect(result.body.pageSize).toBe(50);
    }
  });

  it('**期間を指定しなくても、権限の無い利用者には403(入力の検証より認可が先)**', async () => {
    for (const person of [agentA, requesterA, managerA]) {
      await expectProblem(
        run(() => changes.list(person.ctx, new URLSearchParams())),
        403,
      );
      await expectProblem(
        run(() => changes.list(person.ctx, new URLSearchParams({ unexpected: '1' }))),
        403,
      );
    }
    // 権限のある利用者では、従来どおり期間の検証が 400 を返す。
    await expectProblem(
      run(() => changes.list(adminA.ctx, new URLSearchParams())),
      400,
    );
  });
});

describe('上長・主部署・部署長の変更 (ADR-0023 §3)', () => {
  async function seedChanges(): Promise<{ deptId: string; deptName: string }> {
    const deptId = await mkDepartment(adminA, 'changes');
    const deptName = `WP015 部署 changes (合成)`;
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptId,
        managerUserId: managerA.id,
        jobTitle: '合成役職A',
        location: '合成勤務地A',
        employeeId: 'SYNTH-EMP-A-0001',
      }),
    );
    await run(() => departments.assignHead(adminA.ctx, deptId, { userId: managerA.id }));
    await run(() => departments.endHead(adminA.ctx, deptId, { validUntil: null }));
    // 上長だけの変更。
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: agentA.id }));
    return { deptId, deptName };
  }

  it('**上長・主部署・部署長の設定・終了を新しい順に返す**', async () => {
    const { deptId, deptName } = await seedChanges();
    const result = await list(adminA);
    expect(result.status).toBe(200);
    expect(typesOf(result.body.items)).toEqual(
      expect.arrayContaining([
        'manager_and_primary_department',
        'manager',
        'department_head_assigned',
        'department_head_removed',
      ]),
    );
    // 新しい順。
    const times = result.body.items.map((item: { occurredAt: string }) =>
      Date.parse(item.occurredAt),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const profileWithDepartment = result.body.items.find(
      (item: { changeType: string }) => item.changeType === 'manager_and_primary_department',
    );
    expect(profileWithDepartment.subject).toEqual({
      userId: employeeA.id,
      displayName: employeeA.displayName,
    });
    expect(profileWithDepartment.actor).toEqual({
      userId: adminA.id,
      displayName: adminA.displayName,
    });
    expect(profileWithDepartment.after).toMatchObject({
      managerUserId: managerA.id,
      managerDisplayName: managerA.displayName,
      primaryDepartmentId: deptId,
      primaryDepartmentName: deptName,
    });
    expect(profileWithDepartment.before).toMatchObject({
      managerUserId: null,
      managerDisplayName: null,
      primaryDepartmentId: null,
      primaryDepartmentName: null,
    });

    const assigned = result.body.items.find(
      (item: { changeType: string }) => item.changeType === 'department_head_assigned',
    );
    expect(assigned.before).toBeNull();
    expect(assigned.after).toMatchObject({
      departmentId: deptId,
      departmentName: deptName,
      headUserId: managerA.id,
      headDisplayName: managerA.displayName,
    });
    const removed = result.body.items.find(
      (item: { changeType: string }) => item.changeType === 'department_head_removed',
    );
    expect(removed.before).toMatchObject({ headUserId: managerA.id });
    expect(removed.after).toMatchObject({ headUserId: managerA.id });
    expect(removed.after.validUntil).not.toBeNull();
  }, 30_000);

  it('**上長・主部署が変わらないプロフィール更新は返さない**', async () => {
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { jobTitle: '役職だけの変更' }));
    const result = await list(adminA);
    expect(result.body.items).toHaveLength(0);
  }, 30_000);

  it('**社員番号・役職・勤務地を応答に含めない**', async () => {
    await seedChanges();
    const result = await list(adminA);
    const text = JSON.stringify(result.body);
    expect(text).not.toContain('SYNTH-EMP-A-0001');
    expect(text).not.toContain('合成役職A');
    expect(text).not.toContain('合成勤務地A');
    expect(text).not.toContain('employeeId');
    expect(text).not.toContain('jobTitle');
    expect(text).not.toContain('location');
  }, 30_000);

  it('**他組織の変更を含めない**', async () => {
    const deptA = await mkDepartment(adminA, 'org-a');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptA,
        managerUserId: managerA.id,
      }),
    );
    const deptB = await mkDepartment(adminB, 'org-b');
    await run(() =>
      users.updateProfile(adminB.ctx, employeeB.id, {
        primaryDepartmentId: deptB,
        managerUserId: managerB.id,
      }),
    );
    await run(() => departments.assignHead(adminB.ctx, deptB, { userId: managerB.id }));

    const resultA = await list(adminA);
    expect(resultA.body.items.length).toBeGreaterThan(0);
    const text = JSON.stringify(resultA.body);
    expect(text).not.toContain(employeeB.id);
    expect(text).not.toContain(managerB.id);
    expect(text).not.toContain(deptB);

    const resultB = await list(adminB);
    expect(JSON.stringify(resultB.body)).not.toContain(employeeA.id);
  }, 30_000);

  it('**期間を指定でき、期間外の変更は返さない。不正な期間は400**', async () => {
    await seedChanges();
    expect((await list(adminA)).body.items.length).toBeGreaterThan(0);
    const outside = await list(adminA, { from: '2020-01-01', to: '2020-01-02' });
    expect(outside.body.items).toHaveLength(0);
    await expectProblem(list(adminA, { from: '2020-02-02', to: '2020-02-01' }), 400);
    await expectProblem(list(adminA, { from: '2020-02-30', to: '2020-03-01' }), 400);
    await expectProblem(list(adminA, { from: '2019-01-01', to: '2020-12-31' }), 400, ['366日']);
  }, 30_000);

  it('**ページングと件数の上限を持つ。未知の項目は400**', async () => {
    await seedChanges();
    const first = await list(adminA);
    expect(first.body).toMatchObject({ page: 1, pageSize: 50, hasMore: false });
    const second = await list(adminA, { from: TODAY, to: TODAY, page: '2' });
    expect(second.body.items).toHaveLength(0);
    await expectProblem(list(adminA, { from: TODAY, to: TODAY, organization_id: orgB }), 400);
  }, 30_000);
});
