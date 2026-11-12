/**
 * 部署・部署長・組織プロフィールのAPI (WP-P4-IDM-013 / ADR-0023 §1・§3・§12 / TL-03・TL-06)。
 *
 * ここで固定するもの:
 *
 *   1. **変更できるのは `org_admin` だけ** — 役割×エンドポイントの総当り
 *   2. **本人は自分の上長・主部署を変えられない**(`org_admin` 本人を含む)
 *   3. **組織管理者の上長は常に未設定** — 設定要求も、上長付きへの `org_admin` 付与も拒否
 *   4. **閲覧範囲** — 全項目は管理者・本人・上長。`agent` は表示名と主部署名だけ
 *   5. **監査** — 変更ごとに1件。社員番号の値を載せない。監査失敗で変更も巻き戻る
 *   6. **越境は404** — 他組織の部署・プロフィール・上長候補を指定できない
 *
 * 実行先は使い捨てDB(名前に `test` を含む)に限る。開発用DBを触らないためのガードを
 * 最初に置く(`department-profile.test.ts` と同じ方式)。合成データだけを使う。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithContext, newContext } from '@solvi/shared';
import { DepartmentController } from '../../services/api/src/modules/auth/department.routes.js';
import { UserAdminController } from '../../services/api/src/modules/auth/user-admin.routes.js';
import { parseMemberFilters } from '../../services/api/src/modules/auth/user-admin.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData } from '../support/cleanup.js';

const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);

let pool: pg.Pool;
let admin: pg.Client;
let departments: DepartmentController;
let users: UserAdminController;

let orgA: string;
let orgB: string;

interface Person {
  id: string;
  ctx: AuthenticatedRequest;
}

let adminA: Person;
let adminA2: Person;
let agentA: Person;
let managerA: Person;
let approverA: Person;
let requesterA: Person;
let editorA: Person;
let auditorA: Person;
let employeeA: Person;
let expiredAdminA: Person;
let adminB: Person;
let agentB: Person;

/** 各テストの前後で役割束縛を作り直すための基準状態。 */
let baselineBindings: Array<{ userId: string; orgId: string; bindings: Binding[] }> = [];

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
    sessionId: `wp013-session-${userId.slice(0, 8)}`,
    userId,
  };
}

async function mkOrg(label: string): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)', [
    id,
    `wp013-${label}-${SUFFIX}`,
    `WP-P4-IDM-013 ${label} (合成)`,
  ]);
  return id;
}

type Binding = { role: string; from?: string; until?: string | null };

async function insertBinding(userId: string, orgId: string, binding: Binding): Promise<void> {
  await admin.query(
    `INSERT INTO role_binding
       (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
     VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = 'org'),
             'org', $4, 'manual', COALESCE($5::timestamptz, $6::timestamptz),
             $7::timestamptz)`,
    [
      randomUUID(),
      userId,
      binding.role,
      orgId,
      binding.from ?? null,
      PAST.toISOString(),
      binding.until ?? null,
    ],
  );
}

async function mkUser(label: string, orgId: string, bindings: Binding[]): Promise<string> {
  const id = randomUUID();
  const email = `wp013-${label}-${id.slice(0, 8)}@example.test`;
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, email, `WP013 ${label}`],
  );
  for (const binding of bindings) await insertBinding(id, orgId, binding);
  // 有効な所属には必ずプロフィール行がある(0037 のバックフィルと同じ状態)。
  await admin.query('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
    orgId,
    id,
  ]);
  return id;
}

function person(id: string, orgId: string, roles: RoleCode[]): Person {
  return { id, ctx: authFor(id, orgId, roles) };
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
  if (messagePart) expect(caught?.message).toContain(messagePart);
}

async function profileOf(userId: string): Promise<{
  primary_department_id: string | null;
  manager_user_id: string | null;
  job_title: string | null;
  location: string | null;
  employee_id: string | null;
}> {
  const { rows } = await admin.query(
    `SELECT primary_department_id, manager_user_id, job_title, location, employee_id
       FROM org_member_profile WHERE organization_id = $1 AND user_id = $2`,
    [orgA, userId],
  );
  return rows[0];
}

async function mkDepartment(label: string, parentId: string | null = null): Promise<string> {
  const created = await run(() =>
    departments.create(adminA.ctx, {
      code: `${label}-${SUFFIX}`,
      name: `部署 ${label} (合成)`,
      parentId,
    }),
  );
  return created.body.department.id as string;
}

/** 監査の書込みだけを失敗させる(使い捨てDB上でのみ実行する)。 */
async function withFailingAudit(eventType: string, fn: () => Promise<void>): Promise<void> {
  await admin.query(
    `CREATE OR REPLACE FUNCTION wp013_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN
       IF NEW.event_type = '${eventType}' THEN
         RAISE EXCEPTION 'wp013_forced_audit_failure';
       END IF;
       RETURN NEW;
     END $f$`,
  );
  await admin.query(
    `CREATE TRIGGER wp013_fail_audit BEFORE INSERT ON audit_event
       FOR EACH ROW EXECUTE FUNCTION wp013_fail_audit()`,
  );
  try {
    await fn();
  } finally {
    await admin.query('DROP TRIGGER wp013_fail_audit ON audit_event');
    await admin.query('DROP FUNCTION wp013_fail_audit()');
  }
}

beforeAll(async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl || !appUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // **開発用DBへ書かない。** 名前に test を含む使い捨てDBでなければここで止める。
  const appName = (await pool.query('SELECT current_database() AS n')).rows[0].n as string;
  const adminName = (await admin.query('SELECT current_database() AS n')).rows[0].n as string;
  for (const name of [appName, adminName]) {
    if (!name.includes('test')) {
      await pool.end();
      await admin.end();
      throw new Error(`接続先 ${name} は使い捨てDB(名前に test を含む)ではありません。中止します`);
    }
  }

  departments = new DepartmentController({ pool });
  users = new UserAdminController({ pool });

  orgA = await mkOrg('a');
  orgB = await mkOrg('b');

  adminA = person(await mkUser('admin-a', orgA, [{ role: 'org_admin' }]), orgA, ['org_admin']);
  adminA2 = person(await mkUser('admin-a2', orgA, [{ role: 'org_admin' }]), orgA, ['org_admin']);
  agentA = person(await mkUser('agent-a', orgA, [{ role: 'agent' }]), orgA, ['agent']);
  managerA = person(await mkUser('manager-a', orgA, [{ role: 'agent' }]), orgA, ['agent']);
  approverA = person(await mkUser('approver-a', orgA, [{ role: 'approver' }]), orgA, ['approver']);
  requesterA = person(await mkUser('requester-a', orgA, [{ role: 'requester' }]), orgA, [
    'requester',
  ]);
  editorA = person(await mkUser('editor-a', orgA, [{ role: 'catalog_editor' }]), orgA, [
    'catalog_editor',
  ]);
  auditorA = person(await mkUser('auditor-a', orgA, [{ role: 'auditor' }]), orgA, ['auditor']);
  employeeA = person(await mkUser('employee-a', orgA, [{ role: 'requester' }]), orgA, [
    'requester',
  ]);
  // **期限切れの org_admin しか持たない利用者**。上長を設定できることを固定する。
  expiredAdminA = person(
    await mkUser('expired-admin-a', orgA, [
      { role: 'org_admin', from: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z' },
    ]),
    orgA,
    [],
  );
  adminB = person(await mkUser('admin-b', orgB, [{ role: 'org_admin' }]), orgB, ['org_admin']);
  agentB = person(await mkUser('agent-b', orgB, [{ role: 'agent' }]), orgB, ['agent']);

  baselineBindings = [
    { userId: adminA.id, orgId: orgA, bindings: [{ role: 'org_admin' }] },
    { userId: adminA2.id, orgId: orgA, bindings: [{ role: 'org_admin' }] },
    { userId: agentA.id, orgId: orgA, bindings: [{ role: 'agent' }] },
    { userId: managerA.id, orgId: orgA, bindings: [{ role: 'agent' }] },
    { userId: approverA.id, orgId: orgA, bindings: [{ role: 'approver' }] },
    { userId: requesterA.id, orgId: orgA, bindings: [{ role: 'requester' }] },
    { userId: editorA.id, orgId: orgA, bindings: [{ role: 'catalog_editor' }] },
    { userId: auditorA.id, orgId: orgA, bindings: [{ role: 'auditor' }] },
    { userId: employeeA.id, orgId: orgA, bindings: [{ role: 'requester' }] },
    {
      userId: expiredAdminA.id,
      orgId: orgA,
      bindings: [
        { role: 'org_admin', from: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z' },
      ],
    },
    { userId: adminB.id, orgId: orgB, bindings: [{ role: 'org_admin' }] },
    { userId: agentB.id, orgId: orgB, bindings: [{ role: 'agent' }] },
  ];
});

afterAll(async () => {
  if (admin) {
    try {
      await cleanAuditData(
        admin,
        `organization_id IN ('${orgA ?? '00000000-0000-0000-0000-000000000000'}', '${orgB ?? '00000000-0000-0000-0000-000000000000'}')`,
      );
      await admin.query('DELETE FROM department_head WHERE organization_id = ANY($1::uuid[])', [
        [orgA, orgB],
      ]);
      await admin.query(
        'UPDATE org_member_profile SET manager_user_id = NULL, primary_department_id = NULL WHERE organization_id = ANY($1::uuid[])',
        [[orgA, orgB]],
      );
      await admin.query('DELETE FROM org_member_profile WHERE organization_id = ANY($1::uuid[])', [
        [orgA, orgB],
      ]);
      await admin.query(
        'UPDATE department SET parent_id = NULL WHERE organization_id = ANY($1::uuid[])',
        [[orgA, orgB]],
      );
      await admin.query('DELETE FROM department WHERE organization_id = ANY($1::uuid[])', [
        [orgA, orgB],
      ]);
      await admin.query('DELETE FROM role_binding WHERE organization_id = ANY($1::uuid[])', [
        [orgA, orgB],
      ]);
      const userIds = [
        adminA,
        adminA2,
        agentA,
        managerA,
        approverA,
        requesterA,
        editorA,
        auditorA,
        employeeA,
        expiredAdminA,
        adminB,
        agentB,
      ].map((p) => p.id);
      await admin.query('DELETE FROM role_binding WHERE user_id = ANY($1::uuid[])', [userIds]);
      await admin.query('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [userIds]);
      await admin.query('DELETE FROM organization WHERE id = ANY($1::uuid[])', [[orgA, orgB]]);
    } finally {
      await admin.end();
    }
  }
  await pool?.end();
});

beforeEach(async () => {
  if (!admin) return;
  await cleanAuditData(admin, `organization_id IN ('${orgA}', '${orgB}')`);
  // 役割の付与を検査するテストがあるため、**毎回の基準状態へ戻す**。
  // 前のテストで付いた org_admin が次のテストの「組織管理者の上長」判定を汚さないようにする。
  const userIds = baselineBindings.map((entry) => entry.userId);
  await admin.query('DELETE FROM role_binding WHERE user_id = ANY($1::uuid[])', [userIds]);
  for (const entry of baselineBindings) {
    for (const binding of entry.bindings) {
      await insertBinding(entry.userId, entry.orgId, binding);
    }
  }
  await admin.query('DELETE FROM department_head WHERE organization_id = ANY($1::uuid[])', [
    [orgA, orgB],
  ]);
  await admin.query(
    `UPDATE org_member_profile
        SET primary_department_id = NULL, manager_user_id = NULL,
            job_title = NULL, location = NULL, employee_id = NULL
      WHERE organization_id = ANY($1::uuid[])`,
    [[orgA, orgB]],
  );
  await admin.query(
    'UPDATE department SET parent_id = NULL WHERE organization_id = ANY($1::uuid[])',
    [[orgA, orgB]],
  );
  await admin.query('DELETE FROM department WHERE organization_id = ANY($1::uuid[])', [
    [orgA, orgB],
  ]);
});

describe('役割×エンドポイントの総当り (TL-06)', () => {
  it.each([
    ['agent', () => agentA],
    ['approver', () => approverA],
    ['requester', () => requesterA],
    ['catalog_editor', () => editorA],
    ['auditor', () => auditorA],
  ])('**%s は部署・部署長・プロフィールを変更できない**', async (_label, personOf) => {
    const actor = personOf();
    const deptId = await mkDepartment(`deny-${_label}`);

    for (const call of [
      () => departments.create(actor.ctx, { code: `x-${SUFFIX}`, name: '拒否' }),
      () => departments.edit(actor.ctx, deptId, { name: '拒否' }),
      () => departments.deactivate(actor.ctx, deptId),
      () => departments.assignHead(actor.ctx, deptId, { userId: managerA.id }),
      () => departments.endHead(actor.ctx, deptId, {}),
      () => departments.head(actor.ctx, deptId),
      () => users.updateProfile(actor.ctx, employeeA.id, { jobTitle: '拒否' }),
    ] as Array<() => Promise<unknown>>) {
      await expectProblem(run(call), 403);
    }

    // 一覧・ツリーも管理操作である。変更と同じく組織管理者だけに返す。
    await expectProblem(
      run(() => departments.tree(actor.ctx)),
      403,
    );
    await expectProblem(
      run(() => departments.members(actor.ctx, deptId)),
      403,
    );

    // 何も変わっていない
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM department WHERE organization_id = $1 AND code = $2',
      [orgA, `x-${SUFFIX}`],
    );
    expect(rows[0].n).toBe(0);
    expect((await profileOf(employeeA.id)).job_title).toBeNull();
  });
});

describe('本人による自分の上長・主部署の変更禁止 (ADR-0023 §3)', () => {
  it('**org_admin 本人でも自分の上長・主部署は変えられない**', async () => {
    const deptId = await mkDepartment('self');
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, adminA.id, { primaryDepartmentId: deptId })),
      403,
    );
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, adminA.id, { managerUserId: managerA.id })),
      403,
    );
    const own = await profileOf(adminA.id);
    expect(own.primary_department_id).toBeNull();
    expect(own.manager_user_id).toBeNull();
  });

  it('**他人の上長・主部署は変更できる**。主部署は別の org_admin が設定できる', async () => {
    const deptId = await mkDepartment('other');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptId,
        managerUserId: managerA.id,
      }),
    );
    const employee = await profileOf(employeeA.id);
    expect(employee.primary_department_id).toBe(deptId);
    expect(employee.manager_user_id).toBe(managerA.id);

    // 組織管理者の主部署は本人ではなく別の組織管理者が設定する
    await run(() => users.updateProfile(adminA2.ctx, adminA.id, { primaryDepartmentId: deptId }));
    expect((await profileOf(adminA.id)).primary_department_id).toBe(deptId);
  });

  it('自分の役職・勤務地は本人でも更新できる(上長・主部署だけが特権操作)', async () => {
    await run(() =>
      users.updateProfile(adminA.ctx, adminA.id, { jobTitle: '合成役職', location: '合成勤務地' }),
    );
    const own = await profileOf(adminA.id);
    expect(own.job_title).toBe('合成役職');
    expect(own.location).toBe('合成勤務地');
  });
});

describe('組織管理者の上長は常に未設定 (ADR-0023 §3)', () => {
  it('**有効な org_admin への上長設定は、別の org_admin からでも409**', async () => {
    await expectProblem(
      run(() => users.updateProfile(adminA2.ctx, adminA.id, { managerUserId: managerA.id })),
      409,
    );
    expect((await profileOf(adminA.id)).manager_user_id).toBeNull();
  });

  it('**期限切れの org_admin しか持たない利用者には上長を設定できる**', async () => {
    await run(() =>
      users.updateProfile(adminA.ctx, expiredAdminA.id, { managerUserId: managerA.id }),
    );
    expect((await profileOf(expiredAdminA.id)).manager_user_id).toBe(managerA.id);
  });

  it('**上長が設定済みの利用者への org_admin 付与は拒否され、ロールもプロフィールも変わらない**', async () => {
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: managerA.id }));
    await expectProblem(
      run(() =>
        users.grantRole(adminA.ctx, employeeA.id, {
          roleCode: 'org_admin',
          reason: '上長付きへの付与',
        }),
      ),
      409,
    );
    const { rows } = await admin.query(
      `SELECT 1 FROM role_binding rb JOIN role r ON r.id = rb.role_id
        WHERE rb.user_id = $1 AND rb.organization_id = $2 AND r.code = 'org_admin'`,
      [employeeA.id, orgA],
    );
    expect(rows).toHaveLength(0);
    expect((await profileOf(employeeA.id)).manager_user_id).toBe(managerA.id);
  });

  it('上長を外した後は org_admin を付与できる(自動では外さない)', async () => {
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: managerA.id }));
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: null }));
    await run(() =>
      users.grantRole(adminA.ctx, employeeA.id, {
        roleCode: 'org_admin',
        reason: '上長を外した後の付与',
      }),
    );
    const { rows } = await admin.query(
      `SELECT 1 FROM role_binding rb JOIN role r ON r.id = rb.role_id
        WHERE rb.user_id = $1 AND rb.organization_id = $2 AND r.code = 'org_admin'`,
      [employeeA.id, orgA],
    );
    expect(rows).toHaveLength(1);
  });

  it('**org_admin を上長候補にすることは妨げない**', async () => {
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: adminA2.id }));
    expect((await profileOf(employeeA.id)).manager_user_id).toBe(adminA2.id);
  });
});

describe('上長候補と部署の再検証', () => {
  it('**他組織の利用者・無効な所属・本人は上長にできない**', async () => {
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: agentB.id })),
      404,
    );
    // 期限切れの org_admin しか持たない = 有効な所属ではない
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: expiredAdminA.id })),
      404,
    );
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: employeeA.id })),
      400,
    );
    expect((await profileOf(employeeA.id)).manager_user_id).toBeNull();
  });

  it('**循環になる上長候補は409で拒否し、内部のエラー文を返さない**', async () => {
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { managerUserId: managerA.id }));
    let caught: (Error & { status?: number }) | undefined;
    try {
      await run(() =>
        users.updateProfile(adminA.ctx, managerA.id, { managerUserId: employeeA.id }),
      );
    } catch (error) {
      caught = error as Error & { status?: number };
    }
    expect(caught?.status).toBe(409);
    expect(caught?.message).toContain('循環');
    expect(caught?.message).not.toContain('manager_cycle');
    expect(caught?.message).not.toContain('org_member_profile');
    expect((await profileOf(managerA.id)).manager_user_id).toBeNull();
  });

  it('**他組織・無効な部署は主部署にできない**', async () => {
    const deptB = await run(() =>
      departments.create(adminB.ctx, { code: `b-${SUFFIX}`, name: '組織Bの部署' }),
    );
    await expectProblem(
      run(() =>
        users.updateProfile(adminA.ctx, employeeA.id, {
          primaryDepartmentId: deptB.body.department.id as string,
        }),
      ),
      404,
    );

    const deptA = await mkDepartment('inactive');
    await run(() => departments.deactivate(adminA.ctx, deptA));
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, employeeA.id, { primaryDepartmentId: deptA })),
      409,
    );
  });

  it('**部署の親の循環・深さ超過は409で拒否し、内部のエラー文を返さない**', async () => {
    const a = await mkDepartment('cyc-a');
    const b = await mkDepartment('cyc-b', a);
    let caught: (Error & { status?: number }) | undefined;
    try {
      await run(() => departments.edit(adminA.ctx, a, { parentId: b }));
    } catch (error) {
      caught = error as Error & { status?: number };
    }
    expect(caught?.status).toBe(409);
    expect(caught?.message).toContain('循環');
    expect(caught?.message).not.toContain('department_cycle');

    let parent: string | null = null;
    for (let level = 1; level <= 10; level += 1) {
      parent = await mkDepartment(`depth-${level}`, parent);
    }
    await expectProblem(
      run(() =>
        departments.create(adminA.ctx, {
          code: `deep-${SUFFIX}`,
          name: '深すぎる',
          parentId: parent,
        }),
      ),
      409,
    );
  });
});

describe('越境 (TL-06 / NFR-SEC-006)', () => {
  it('**組織Aのセッションでは組織Bの部署を編集・無効化・参照できない(404)**', async () => {
    const deptB = await run(() =>
      departments.create(adminB.ctx, { code: `b2-${SUFFIX}`, name: '組織Bの部署' }),
    );
    const deptBId = deptB.body.department.id as string;
    await expectProblem(
      run(() => departments.edit(adminA.ctx, deptBId, { name: '越境' })),
      404,
    );
    await expectProblem(
      run(() => departments.deactivate(adminA.ctx, deptBId)),
      404,
    );
    await expectProblem(
      run(() => departments.members(adminA.ctx, deptBId)),
      404,
    );
    await expectProblem(
      run(() => departments.assignHead(adminA.ctx, deptBId, { userId: managerA.id })),
      404,
    );
    await expectProblem(
      run(() =>
        departments.create(adminA.ctx, { code: `cross-${SUFFIX}`, name: 'x', parentId: deptBId }),
      ),
      404,
    );
  });

  it('**組織Aのセッションでは組織Bのプロフィールを取得・変更できない(404)**', async () => {
    await expectProblem(
      run(() => users.getProfile(adminA.ctx, adminB.id)),
      404,
    );
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, adminB.id, { jobTitle: '越境' })),
      404,
    );
    const { rows } = await admin.query(
      'SELECT job_title FROM org_member_profile WHERE organization_id = $1 AND user_id = $2',
      [orgB, adminB.id],
    );
    expect(rows[0].job_title).toBeNull();
  });
});

describe('閲覧範囲 (FR-IDM-014 / ADR-0023 §12)', () => {
  let deptId: string;

  beforeEach(async () => {
    deptId = await mkDepartment('scope');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptId,
        managerUserId: managerA.id,
        jobTitle: '合成役職',
        location: '合成勤務地',
        employeeId: 'SYNTH-EMP-0001',
      }),
    );
  });

  it('**agent が取得できるのは表示名と主部署名だけ**', async () => {
    const result = await run(() => users.getProfile(agentA.ctx, employeeA.id));
    const profile = result.body.profile;
    expect(profile.visibility).toBe('limited');
    expect(profile.displayName).toBe('WP013 employee-a');
    expect(profile.primaryDepartmentName).toBe('部署 scope (合成)');
    expect(Object.keys(profile).sort()).toEqual([
      'displayName',
      'primaryDepartmentName',
      'userId',
      'visibility',
    ]);
    expect(profile).not.toHaveProperty('jobTitle');
    expect(profile).not.toHaveProperty('location');
    expect(profile).not.toHaveProperty('employeeId');
    expect(profile).not.toHaveProperty('managerUserId');
    expect(profile).not.toHaveProperty('primaryDepartmentId');
  });

  it('**本人・上長・org_admin は全項目を取得できる**', async () => {
    for (const actor of [employeeA, managerA, adminA]) {
      const result = await run(() => users.getProfile(actor.ctx, employeeA.id));
      expect(result.body.profile.visibility).toBe('full');
      expect(result.body.profile.jobTitle).toBe('合成役職');
      expect(result.body.profile.location).toBe('合成勤務地');
      expect(result.body.profile.employeeId).toBe('SYNTH-EMP-0001');
      expect(result.body.profile.managerUserId).toBe(managerA.id);
      expect(result.body.profile.primaryDepartmentId).toBe(deptId);
    }
  });

  it('agent が自分自身を取得すると全項目(本人は常に全項目)', async () => {
    const result = await run(() => users.getProfile(agentA.ctx, agentA.id));
    expect(result.body.profile.visibility).toBe('full');
  });

  it('**requester・無関係な approver は他人のプロフィールを取得できない(404)**', async () => {
    await expectProblem(
      run(() => users.getProfile(requesterA.ctx, employeeA.id)),
      404,
    );
    await expectProblem(
      run(() => users.getProfile(approverA.ctx, employeeA.id)),
      404,
    );
    await expectProblem(
      run(() => users.getProfile(editorA.ctx, employeeA.id)),
      404,
    );
  });
});

describe('監査 (02.17 §2.2 / ADR-0009)', () => {
  it('**プロフィール更新は before/after 付きで1件。社員番号の値は含まない**', async () => {
    const deptId = await mkDepartment('audit');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptId,
        managerUserId: managerA.id,
        jobTitle: '監査対象',
        employeeId: 'SECRET-EMP-9999',
      }),
    );

    const { rows } = await admin.query(
      `SELECT event_type, action, before_state, after_state, actor_id
         FROM audit_event
        WHERE organization_id = $1 AND subject_user_id = $2
        ORDER BY event_id`,
      [orgA, employeeA.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('org.member.profile.updated');
    expect(rows[0].action).toBe('update');
    expect(rows[0].actor_id).toBe(adminA.id);
    expect(rows[0].after_state.jobTitle).toBe('監査対象');
    expect(rows[0].before_state.jobTitle).toBeNull();
    expect(rows[0].after_state.employeeIdChanged).toBe(true);
    expect(JSON.stringify(rows[0].before_state)).not.toContain('SECRET-EMP-9999');
    expect(JSON.stringify(rows[0].after_state)).not.toContain('SECRET-EMP-9999');
    expect(rows[0].after_state).not.toHaveProperty('employeeId');
    expect(rows[0].before_state).not.toHaveProperty('employeeId');
  });

  it('**部署の作成・編集・無効化が1件ずつ記録される**', async () => {
    const created = await run(() =>
      departments.create(adminA.ctx, { code: `aud-${SUFFIX}`, name: '監査部署' }),
    );
    const deptId = created.body.department.id as string;
    await run(() => departments.edit(adminA.ctx, deptId, { name: '監査部署(改名)' }));
    await run(() => departments.deactivate(adminA.ctx, deptId));

    const { rows } = await admin.query(
      `SELECT event_type, action, before_state, after_state
         FROM audit_event
        WHERE organization_id = $1 AND target_type = 'department' AND target_id = $2
        ORDER BY event_id`,
      [orgA, deptId],
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'org.department.created',
      'org.department.updated',
      'org.department.deactivated',
    ]);
    expect(rows[0].after_state.name).toBe('監査部署');
    expect(rows[1].before_state.name).toBe('監査部署');
    expect(rows[1].after_state.name).toBe('監査部署(改名)');
    expect(rows[2].after_state.active).toBe(false);
  });

  it('**部署長の設定・終了が1件ずつ記録される**', async () => {
    const deptId = await mkDepartment('head-audit');
    const assigned = await run(() =>
      departments.assignHead(adminA.ctx, deptId, { userId: managerA.id }),
    );
    await run(() => departments.endHead(adminA.ctx, deptId, { validUntil: null }));

    const { rows } = await admin.query(
      `SELECT event_type, action, subject_user_id, before_state, after_state
         FROM audit_event
        WHERE organization_id = $1 AND target_type = 'department_head'
        ORDER BY event_id`,
      [orgA],
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'org.department.head.assigned',
      'org.department.head.removed',
    ]);
    expect(rows[0].subject_user_id).toBe(managerA.id);
    expect(rows[0].after_state.userId).toBe(managerA.id);
    expect(rows[1].before_state.userId).toBe(managerA.id);
    expect(rows[1].after_state.validUntil).not.toBeNull();
    void assigned;
  });

  it('**監査の書込みに失敗するとプロフィール更新も巻き戻る**', async () => {
    await withFailingAudit('org.member.profile.updated', async () => {
      await expect(
        run(() => users.updateProfile(adminA.ctx, employeeA.id, { jobTitle: '巻き戻し対象' })),
      ).rejects.toThrow(/監査イベントの記録に失敗/);
    });
    expect((await profileOf(employeeA.id)).job_title).toBeNull();
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE organization_id = $1 AND event_type = 'org.member.profile.updated'`,
      [orgA],
    );
    expect(rows[0].n).toBe(0);
  });

  it('**監査の書込みに失敗すると部署の作成も巻き戻る**', async () => {
    await withFailingAudit('org.department.created', async () => {
      await expect(
        run(() => departments.create(adminA.ctx, { code: `rollback-${SUFFIX}`, name: '巻き戻し' })),
      ).rejects.toThrow(/監査イベントの記録に失敗/);
    });
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM department WHERE organization_id = $1 AND code = $2',
      [orgA, `rollback-${SUFFIX}`],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('部署長の重複と終了日 (FR-IDM-012)', () => {
  it('**有効な部署長がいる部署に別の部署長を設定すると409**', async () => {
    const deptId = await mkDepartment('head-dup');
    await run(() => departments.assignHead(adminA.ctx, deptId, { userId: managerA.id }));
    await expectProblem(
      run(() => departments.assignHead(adminA.ctx, deptId, { userId: adminA2.id })),
      409,
      '有効な部署長',
    );
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM department_head WHERE department_id = $1',
      [deptId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('**現在の部署長を読み取れ、終了後は未設定になる**', async () => {
    const deptId = await mkDepartment('head-read');
    expect((await run(() => departments.head(adminA.ctx, deptId))).body.head).toBeNull();
    await run(() => departments.assignHead(adminA.ctx, deptId, { userId: managerA.id }));
    const current = await run(() => departments.head(adminA.ctx, deptId));
    expect(current.status).toBe(200);
    expect(current.body.head).toMatchObject({
      departmentId: deptId,
      userId: managerA.id,
      displayName: expect.any(String),
      validUntil: null,
    });
    await run(() => departments.endHead(adminA.ctx, deptId, { validUntil: null }));
    expect((await run(() => departments.head(adminA.ctx, deptId))).body.head).toBeNull();
  });

  it('**終了日は延長できない**(履歴を書き換えない)', async () => {
    const deptId = await mkDepartment('head-extend');
    await run(() => departments.assignHead(adminA.ctx, deptId, { userId: managerA.id }));
    await run(() => departments.endHead(adminA.ctx, deptId, { validUntil: '2030-01-01' }));
    await expectProblem(
      run(() => departments.endHead(adminA.ctx, deptId, { validUntil: '2030-02-01' })),
      409,
    );
    const { rows } = await admin.query(
      'SELECT valid_until FROM department_head WHERE department_id = $1',
      [deptId],
    );
    expect((rows[0].valid_until as Date).toISOString()).toBe('2030-01-01T23:59:59.999Z');
  });
});

describe('部署のコードの一意性', () => {
  it('**同じコードの部署は作れない(409)**', async () => {
    const created = await run(() =>
      departments.create(adminA.ctx, { code: `unique-${SUFFIX}`, name: '一意' }),
    );
    expect(created.status).toBe(201);
    await expectProblem(
      run(() => departments.create(adminA.ctx, { code: `unique-${SUFFIX}`, name: '重複' })),
      409,
    );
  });
});

describe('部署の無効化', () => {
  it('**子部署・有効なメンバー・有効な部署長が残る部署は409で拒否される**', async () => {
    // 子部署
    const parent = await mkDepartment('deact-parent');
    const child = await mkDepartment('deact-child', parent);
    await expectProblem(
      run(() => departments.deactivate(adminA.ctx, parent)),
      409,
      '子部署',
    );
    await run(() => departments.deactivate(adminA.ctx, child));

    // 有効なメンバー
    const withMember = await mkDepartment('deact-member');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, { primaryDepartmentId: withMember }),
    );
    await expectProblem(
      run(() => departments.deactivate(adminA.ctx, withMember)),
      409,
      'メンバー',
    );
    await run(() => users.updateProfile(adminA.ctx, employeeA.id, { primaryDepartmentId: null }));
    await run(() => departments.deactivate(adminA.ctx, withMember));

    // 有効な部署長
    const withHead = await mkDepartment('deact-head');
    await run(() => departments.assignHead(adminA.ctx, withHead, { userId: managerA.id }));
    await expectProblem(
      run(() => departments.deactivate(adminA.ctx, withHead)),
      409,
      '部署長',
    );
    await run(() => departments.endHead(adminA.ctx, withHead, {}));
    await run(() => departments.deactivate(adminA.ctx, withHead));
  });

  it('無効化した部署は編集できず、新しい主部署・親部署・部署長にも指定できない', async () => {
    const dead = await mkDepartment('dead');
    await run(() => departments.deactivate(adminA.ctx, dead));
    await expectProblem(
      run(() => departments.edit(adminA.ctx, dead, { name: '改名' })),
      409,
    );
    await expectProblem(
      run(() => users.updateProfile(adminA.ctx, employeeA.id, { primaryDepartmentId: dead })),
      409,
    );
    await expectProblem(
      run(() =>
        departments.create(adminA.ctx, { code: `under-dead-${SUFFIX}`, name: 'x', parentId: dead }),
      ),
      409,
    );
    await expectProblem(
      run(() => departments.assignHead(adminA.ctx, dead, { userId: managerA.id })),
      409,
    );
  });
});

describe('利用者一覧の部署・上長・役職と充足率 (WP §6)', () => {
  it('**部署・上長・役職で絞り込め、項目が返る**', async () => {
    const deptId = await mkDepartment('filter');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptId,
        managerUserId: managerA.id,
        jobTitle: '絞り込み対象',
      }),
    );
    await run(() => users.updateProfile(adminA.ctx, managerA.id, { jobTitle: '別の役職' }));

    const byDepartment = await run(() => users.list(adminA.ctx, { departmentId: deptId }));
    expect(byDepartment.body.items.map((item) => item.userId)).toEqual([employeeA.id]);
    expect(byDepartment.body.items[0]!.primaryDepartmentName).toBe('部署 filter (合成)');
    expect(byDepartment.body.items[0]!.managerDisplayName).toBe('WP013 manager-a');
    expect(byDepartment.body.items[0]!.jobTitle).toBe('絞り込み対象');

    const byManager = await run(() => users.list(adminA.ctx, { managerUserId: managerA.id }));
    expect(byManager.body.items.map((item) => item.userId)).toEqual([employeeA.id]);

    const byJobTitle = await run(() => users.list(adminA.ctx, { jobTitle: '絞り込み' }));
    expect(byJobTitle.body.items.map((item) => item.userId)).toEqual([employeeA.id]);

    const noMatch = await run(() => users.list(adminA.ctx, { jobTitle: '該当しない役職' }));
    expect(noMatch.body.items).toHaveLength(0);
  });

  it('**上長未設定・部署未設定・部署長不在の件数を返す**', async () => {
    const before = (await run(() => users.list(adminA.ctx))).body.profileCompleteness;
    expect(before.totalMembers).toBeGreaterThan(0);
    expect(before.missingManager).toBe(before.totalMembers);
    expect(before.missingDepartment).toBe(before.totalMembers);

    const deptId = await mkDepartment('completeness');
    await run(() =>
      users.updateProfile(adminA.ctx, employeeA.id, {
        primaryDepartmentId: deptId,
        managerUserId: managerA.id,
      }),
    );
    const after = (await run(() => users.list(adminA.ctx))).body.profileCompleteness;
    expect(after.missingManager).toBe(before.missingManager - 1);
    expect(after.missingDepartment).toBe(before.missingDepartment - 1);
    expect(after.totalDepartments).toBe(before.totalDepartments + 1);
    expect(after.missingDepartmentHead).toBe(before.missingDepartmentHead + 1);

    await run(() => departments.assignHead(adminA.ctx, deptId, { userId: managerA.id }));
    const withHead = (await run(() => users.list(adminA.ctx))).body.profileCompleteness;
    expect(withHead.missingDepartmentHead).toBe(after.missingDepartmentHead - 1);
  });

  it('**一覧の条件に組織IDなどを混ぜると400**(サーバーは常にセッションの組織を使う)', async () => {
    expect(() => parseMemberFilters({ organization_id: orgB })).toThrow();
    await expectProblem(
      run(() => users.list(adminA.ctx, { organization_id: orgB })),
      400,
    );
    await expectProblem(
      run(() => users.list(adminA.ctx, { departmentId: 'not-a-uuid' })),
      400,
    );
  });

  it('**agent は一覧を見られない**(名簿になる)', async () => {
    await expectProblem(
      run(() => users.list(agentA.ctx)),
      403,
    );
  });
});

describe('入力のホワイトリスト (TL-03 / 脅威 T-03)', () => {
  it('**本文に organization_id や未知の項目を混ぜると400**', async () => {
    await expectProblem(
      run(() =>
        departments.create(adminA.ctx, {
          code: `mass-${SUFFIX}`,
          name: 'x',
          organization_id: orgB,
        }),
      ),
      400,
    );
    await expectProblem(
      run(() =>
        departments.create(adminA.ctx, {
          code: `mass2-${SUFFIX}`,
          name: 'x',
          approverId: managerA.id,
        }),
      ),
      400,
    );
    await expectProblem(
      run(() =>
        users.updateProfile(adminA.ctx, employeeA.id, {
          jobTitle: 'x',
          organization_id: orgB,
        }),
      ),
      400,
    );
    expect((await profileOf(employeeA.id)).job_title).toBeNull();
  });

  it('**社員番号が長すぎる場合、値そのものをエラー応答に含めない**', async () => {
    const tooLong = 'X'.repeat(65);
    let caught: (Error & { errors?: Array<{ message: string }> }) | undefined;
    try {
      await run(() => users.updateProfile(adminA.ctx, employeeA.id, { employeeId: tooLong }));
    } catch (error) {
      caught = error as Error & { errors?: Array<{ message: string }> };
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain(tooLong);
    expect(JSON.stringify(caught?.errors ?? [])).not.toContain(tooLong);
  });
});
