/**
 * WP-P4-APR-015 段階A: 承認ルール・組織の有効化設定・保存時検証 (TL-06 / TL-16)。
 *
 * ここで固定するもの:
 *   1. ルール管理と有効化設定は `org_admin` だけ(ロール×エンドポイント総当り)
 *   2. ルールの版は append-only(UPDATE/DELETE をトリガとGRANTで拒否)
 *   3. 段数は1〜3。0段・4段はAPIとDBの両方で拒否
 *   4. `highRisk` は保存できない(判定基準は WP-P4-APR-017)
 *   5. 他組織のルールは参照・指定できない(RLS + API + 複合FK)
 *   6. 監査は業務と同一トランザクション。失敗したら業務も巻き戻る
 *   7. カタログ定義の `ruleId` は同じ組織の有効なルールだけを指せる
 *
 * 実行先は使い捨てDB(名前に `wp015` と `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { newContext, runWithContext } from '@solvi/shared';
import type { ApprovalRuleStep } from '@solvi/shared/catalog';
import { ApprovalRuleController } from '../../services/api/src/modules/catalog/approval-rule.routes.js';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData } from '../support/cleanup.js';

const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);

let pool: pg.Pool;
let admin: pg.Client;
let rules: ApprovalRuleController;
let catalog: CatalogAdminController;
let orgA: string;
let orgB: string;

type Person = { id: string; auth: AuthenticatedRequest };

let adminA: Person;
let adminB: Person;
let approverA: Person;
let approverB: Person;
let requesterA: Person;
let agentA: Person;
let auditorA: Person;
let editorA: Person;
let platformAdmin: Person;
let managerA: Person;
let headA: Person;

let deptId: string;
const made = {
  items: [] as string[],
  users: [] as string[],
  orgs: [] as string[],
};

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

function authFor(userId: string, organizationId: string, roles: RoleCode[]): AuthenticatedRequest {
  return {
    userId,
    sessionId: `wp015-${userId.slice(0, 8)}`,
    authz: {
      organizationId,
      principal: {
        userId,
        status: 'active',
        bindings: roles.map((roleCode) => ({
          roleCode,
          organizationId,
          validFrom: PAST,
          validUntil: null,
        })),
      },
    },
  };
}

async function makeOrg(label: string): Promise<string> {
  const id = randomUUID();
  await q('INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)', [
    id,
    `wp015-${label}-${SUFFIX}`,
    `WP015 ${label} (合成)`,
  ]);
  made.orgs.push(id);
  return id;
}

async function makeUser(label: string, organizationId: string, roles: RoleCode[]): Promise<Person> {
  const id = randomUUID();
  await q(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `wp015-${label}-${id.slice(0, 8)}@example.test`, `WP015 ${label}`],
  );
  made.users.push(id);
  for (const role of roles) {
    await q(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = $4), $4, $5, 'manual', $6, NULL)`,
      [
        randomUUID(),
        id,
        role,
        role.startsWith('platform_') ? 'platform' : 'org',
        role.startsWith('platform_') ? null : organizationId,
        PAST,
      ],
    );
  }
  await q('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
    organizationId,
    id,
  ]);
  return { id, auth: authFor(id, organizationId, roles) };
}

async function makeDepartment(organizationId: string, label: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO department (id, organization_id, code, name) VALUES ($1, $2, $3, $4)`, [
    id,
    organizationId,
    `wp015-${label}-${SUFFIX}`,
    `WP015 ${label} (合成)`,
  ]);
  return id;
}

async function setProfile(
  organizationId: string,
  userId: string,
  fields: {
    managerUserId?: string;
    primaryDepartmentId?: string;
    jobTitle?: string;
    location?: string;
    employeeId?: string;
  },
): Promise<void> {
  await q(
    `UPDATE org_member_profile
        SET manager_user_id = COALESCE($3, manager_user_id),
            primary_department_id = COALESCE($4, primary_department_id),
            job_title = COALESCE($5, job_title),
            location = COALESCE($6, location),
            employee_id = COALESCE($7, employee_id)
      WHERE organization_id = $1 AND user_id = $2`,
    [
      organizationId,
      userId,
      fields.managerUserId ?? null,
      fields.primaryDepartmentId ?? null,
      fields.jobTitle ?? null,
      fields.location ?? null,
      fields.employeeId ?? null,
    ],
  );
}

async function assignHead(
  organizationId: string,
  departmentId: string,
  userId: string,
): Promise<void> {
  await q(
    `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
     VALUES ($1, $2, $3, $4, $5, $4)`,
    [randomUUID(), departmentId, organizationId, userId, PAST],
  );
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
    const text = `${caught?.message ?? ''} ${JSON.stringify((caught as { errors?: unknown })?.errors ?? [])}`;
    expect(text).toContain(messagePart);
  }
}

let sequence = 0;
const nextCode = () => `rule-${SUFFIX}-${++sequence}`;

const fixedStepFor = (approverId: string) => ({ type: 'fixed' as const, approverId });
const fixedStep = () => fixedStepFor(approverA.id);
const managerStep = (onUnresolved: 'department_head' | 'reject' = 'reject') => ({
  type: 'manager' as const,
  onUnresolved,
});
const headStep = () => ({ type: 'department_head' as const, onUnresolved: 'reject' as const });

async function createRule(
  actor: Person,
  steps: ApprovalRuleStep[] = [fixedStep(), managerStep()],
  code = nextCode(),
) {
  return run(() => rules.create(actor.auth, { code, name: `合成 ${code}`, steps }));
}

/**
 * 使い捨てDB上のテスト後片付けだけが版のトリガを外す。
 * 製品コードに削除経路は無い(版は append-only)。
 */
async function cleanRules(): Promise<void> {
  let disabled = false;
  await admin.query('BEGIN');
  try {
    await admin.query('SET CONSTRAINTS approval_rule_current_revision_fk DEFERRED');
    await admin.query(
      'ALTER TABLE approval_rule_revision DISABLE TRIGGER approval_rule_revision_immutable',
    );
    disabled = true;
    await admin.query(
      'DELETE FROM approval_rule_revision WHERE organization_id = ANY($1::uuid[])',
      [[orgA, orgB]],
    );
    await admin.query('DELETE FROM approval_rule WHERE organization_id = ANY($1::uuid[])', [
      [orgA, orgB],
    ]);
    await admin.query('DELETE FROM org_approval_setting WHERE organization_id = ANY($1::uuid[])', [
      [orgA, orgB],
    ]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (disabled)
      await admin
        .query('ALTER TABLE approval_rule_revision ENABLE TRIGGER approval_rule_revision_immutable')
        .catch(() => undefined);
  }
}

async function withFailingAudit(eventType: string, fn: () => Promise<void>): Promise<void> {
  await admin.query(
    `CREATE OR REPLACE FUNCTION wp015_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN
       IF NEW.event_type = '${eventType}' THEN
         RAISE EXCEPTION 'wp015_forced_audit_failure';
       END IF;
       RETURN NEW;
     END $f$`,
  );
  await admin.query(
    `CREATE TRIGGER wp015_fail_audit BEFORE INSERT ON audit_event
       FOR EACH ROW EXECUTE FUNCTION wp015_fail_audit()`,
  );
  try {
    await fn();
  } finally {
    await admin.query('DROP TRIGGER wp015_fail_audit ON audit_event');
    await admin.query('DROP FUNCTION wp015_fail_audit()');
  }
}

const definition = (ruleId: string, approverId?: string) => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  approval: { ruleId, ...(approverId ? { approverId } : {}) },
});

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 6 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // **開発用DBへ書かない。** wp015 の使い捨てDBでなければここで止める。
  for (const client of [pool, admin]) {
    const name = (await client.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!name.includes('wp015') || !name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は wp015 の使い捨てDBではありません。中止します`);
    }
  }
  rules = new ApprovalRuleController(pool, true);
  catalog = new CatalogAdminController(pool, true);

  orgA = await makeOrg('a');
  orgB = await makeOrg('b');
  adminA = await makeUser('admin-a', orgA, ['org_admin']);
  adminB = await makeUser('admin-b', orgB, ['org_admin']);
  approverA = await makeUser('approver-a', orgA, ['approver']);
  approverB = await makeUser('approver-b', orgB, ['approver']);
  requesterA = await makeUser('requester-a', orgA, ['requester']);
  agentA = await makeUser('agent-a', orgA, ['agent']);
  auditorA = await makeUser('auditor-a', orgA, ['auditor']);
  editorA = await makeUser('editor-a', orgA, ['catalog_editor']);
  platformAdmin = await makeUser('platform-admin', orgA, ['platform_admin', 'requester']);
  managerA = await makeUser('manager-a', orgA, ['requester']);
  headA = await makeUser('head-a', orgA, ['requester']);
  deptId = await makeDepartment(orgA, 'dept');
  await setProfile(orgA, requesterA.id, {
    primaryDepartmentId: deptId,
    jobTitle: '合成役職',
    location: '合成勤務地',
    employeeId: 'SYNTH-EMP-WP015',
  });
  await setProfile(orgA, managerA.id, { primaryDepartmentId: deptId });
  await setProfile(orgA, headA.id, { primaryDepartmentId: deptId });
  await assignHead(orgA, deptId, headA.id);
}, 60_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanAuditData(admin, `organization_id IN ('${orgA}', '${orgB}')`);
      await cleanRules();
      if (made.items.length) {
        await admin.query(
          'ALTER TABLE local_catalog_revision DISABLE TRIGGER local_catalog_revision_immutable',
        );
        await admin.query('DELETE FROM local_catalog_revision WHERE item_id = ANY($1::uuid[])', [
          made.items,
        ]);
        await admin.query(
          'ALTER TABLE local_catalog_revision ENABLE TRIGGER local_catalog_revision_immutable',
        );
        await admin.query('DELETE FROM local_catalog_item WHERE id = ANY($1::uuid[])', [
          made.items,
        ]);
      }
      await admin.query(
        'UPDATE org_member_profile SET manager_user_id = NULL, primary_department_id = NULL WHERE organization_id = ANY($1::uuid[])',
        [[orgA, orgB]],
      );
      await admin.query('DELETE FROM department_head WHERE organization_id = ANY($1::uuid[])', [
        [orgA, orgB],
      ]);
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
      await admin.query('DELETE FROM role_binding WHERE user_id = ANY($1::uuid[])', [made.users]);
      await admin.query('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [made.users]);
      await admin.query('DELETE FROM organization WHERE id = ANY($1::uuid[])', [made.orgs]);
    } finally {
      await admin.end();
    }
  }
  await pool?.end();
});

beforeEach(async () => {
  if (!admin) return;
  await cleanAuditData(admin, `organization_id IN ('${orgA}', '${orgB}')`);
  await cleanRules();
  // プロフィールはテストごとに基準状態へ戻す(前のテストの上長設定を引き継がない)。
  await admin.query(
    `UPDATE org_member_profile
        SET manager_user_id = NULL, primary_department_id = NULL,
            job_title = NULL, location = NULL, employee_id = NULL
      WHERE organization_id = ANY($1::uuid[])`,
    [[orgA, orgB]],
  );
  await setProfile(orgA, requesterA.id, {
    primaryDepartmentId: deptId,
    jobTitle: '合成役職',
    location: '合成勤務地',
    employeeId: 'SYNTH-EMP-WP015',
  });
  await setProfile(orgA, managerA.id, { primaryDepartmentId: deptId });
  await setProfile(orgA, headA.id, { primaryDepartmentId: deptId });
});

describe('役割×エンドポイントの総当り (TL-06)', () => {
  it.each([
    ['requester', () => requesterA],
    ['approver', () => approverA],
    ['agent', () => agentA],
    ['auditor', () => auditorA],
    ['catalog_editor', () => editorA],
    ['platform_admin', () => platformAdmin],
  ])('**%s はルール・設定・プレビュー・一覧のどれも操作できない**', async (_label, personOf) => {
    const actor = personOf();
    const ruleId = '00000000-0000-4000-9000-00000000ffff';
    for (const call of [
      () => rules.list(actor.auth),
      () => rules.create(actor.auth, { code: nextCode(), name: '拒否', steps: [fixedStep()] }),
      () => rules.revise(actor.auth, ruleId, { expectedRevision: 1, steps: [fixedStep()] }),
      () => rules.deactivate(actor.auth, ruleId),
      () => rules.history(actor.auth, ruleId),
      () => rules.settings(actor.auth),
      () => rules.updateSettings(actor.auth, { enabled: true }),
      () =>
        rules.preview(actor.auth, {
          requesterId: requesterA.id,
          ruleId,
        }),
      () => rules.unresolved(actor.auth, ruleId),
    ] as Array<() => Promise<unknown>>)
      await expectProblem(run(call), 403);
    expect(
      (await q('SELECT count(*)::int AS n FROM approval_rule WHERE organization_id=$1', [orgA]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await q('SELECT count(*)::int AS n FROM org_approval_setting WHERE organization_id=$1', [
          orgA,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
});

describe('ルールの作成・一覧・履歴 (WP-P4-APR-015 §6-7)', () => {
  it('**作成・一覧・履歴が動き、コードの重複は409**', async () => {
    const code = nextCode();
    const created = await createRule(adminA, [fixedStep(), managerStep()], code);
    expect(created.status).toBe(201);
    expect(created.body.rule).toMatchObject({ revision: 1 });
    const list = await run(() => rules.list(adminA.auth));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      code,
      active: true,
      currentRevision: 1,
      steps: [fixedStep(), managerStep()],
      stepsValid: true,
    });
    const history = await run(() => rules.history(adminA.auth, created.body.rule.id));
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].revision).toBe(1);
    expect(history.body.items[0].steps).toEqual([fixedStep(), managerStep()]);

    await expectProblem(
      run(() => rules.create(adminA.auth, { code, name: '重複', steps: [fixedStep()] })),
      409,
      '同じコード',
    );
    await expectProblem(
      run(() => rules.history(adminA.auth, 'not-a-uuid')),
      400,
    );
    await expectProblem(
      run(() => rules.preview(adminA.auth, { requesterId: requesterA.id, ruleId: 'not-a-uuid' })),
      400,
    );
  });

  it('**固定承認者は保存時点で有効な所属かつ approver ロールが必要**', async () => {
    for (const approverId of [requesterA.id, approverB.id, randomUUID()]) {
      await expectProblem(
        run(() =>
          rules.create(adminA.auth, {
            code: nextCode(),
            name: '無効な固定承認者',
            steps: [{ type: 'fixed', approverId }],
          }),
        ),
        400,
      );
    }
    expect(
      (await q('SELECT count(*)::int AS n FROM approval_rule WHERE organization_id=$1', [orgA]))
        .rows[0].n,
    ).toBe(0);
  });

  it('**改版は新しい版の追加で、既存版を書き換えない。古い expectedRevision は409**', async () => {
    const created = await createRule(adminA, [fixedStep(), managerStep()]);
    const revised = await run(() =>
      rules.revise(adminA.auth, created.body.rule.id, {
        expectedRevision: 1,
        steps: [fixedStep(), headStep()],
      }),
    );
    expect(revised.status).toBe(200);
    expect(revised.body.rule.revision).toBe(2);
    const history = await run(() => rules.history(adminA.auth, created.body.rule.id));
    expect(history.body.items.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);
    expect(history.body.items[0].steps).toEqual([fixedStep(), headStep()]);
    expect(history.body.items[1].steps).toEqual([fixedStep(), managerStep()]);
    await expectProblem(
      run(() =>
        rules.revise(adminA.auth, created.body.rule.id, {
          expectedRevision: 1,
          steps: [fixedStep()],
        }),
      ),
      409,
    );
  });

  it('**無効化後は改版できない。他組織のルールは404**', async () => {
    const created = await createRule(adminA, [fixedStep()]);
    await run(() => rules.deactivate(adminA.auth, created.body.rule.id));
    await expectProblem(
      run(() =>
        rules.revise(adminA.auth, created.body.rule.id, {
          expectedRevision: 1,
          steps: [fixedStep()],
        }),
      ),
      409,
    );
    await expectProblem(
      run(() => rules.history(adminB.auth, created.body.rule.id)),
      404,
    );
    await expectProblem(
      run(() => rules.deactivate(adminB.auth, created.body.rule.id)),
      404,
    );
    await expectProblem(
      run(() =>
        rules.revise(adminB.auth, created.body.rule.id, {
          expectedRevision: 1,
          steps: [fixedStep()],
        }),
      ),
      404,
    );
  });
});

describe('段数と highRisk の拒否 (WP §6.1)', () => {
  it('**0段・4段のルールはAPIで400**', async () => {
    for (const steps of [
      [],
      [fixedStep(), fixedStep(), fixedStep(), headStep()],
    ] as ApprovalRuleStep[][]) {
      await expectProblem(
        run(() =>
          rules.create(adminA.auth, {
            code: nextCode(),
            name: '段数',
            steps,
          }),
        ),
        400,
      );
    }
  });

  it('**highRisk・未知のキー・未知の段の項目は400**', async () => {
    const body = { code: nextCode(), name: '高リスク', steps: [fixedStep()], highRisk: true };
    await expectProblem(
      run(() => rules.create(adminA.auth, body)),
      400,
      '高リスク',
    );
    await expectProblem(
      run(() =>
        rules.create(adminA.auth, {
          code: nextCode(),
          name: '未知',
          steps: [fixedStep()],
          organization_id: orgB,
        }),
      ),
      400,
    );
    await expectProblem(
      run(() =>
        rules.create(adminA.auth, {
          code: nextCode(),
          name: '未知の段',
          steps: [{ ...fixedStep(), highRisk: true }],
        }),
      ),
      400,
    );
    await expectProblem(
      run(() =>
        rules.revise(adminA.auth, randomUUID(), {
          expectedRevision: 1,
          steps: [fixedStep()],
          highRisk: true,
        }),
      ),
      400,
      '高リスク',
    );
  });

  it('**DBのCHECKでも0段・4段を拒否する**(APIを迂回できない)', async () => {
    const ruleId = randomUUID();
    await admin.query('BEGIN');
    try {
      await admin.query('SET CONSTRAINTS approval_rule_current_revision_fk DEFERRED');
      await q(
        `INSERT INTO approval_rule(id, organization_id, code, name, active, current_revision, created_by)
         VALUES($1,$2,$3,'直接投入',true,1,$4)`,
        [ruleId, orgA, nextCode(), adminA.id],
      );
      await q(
        `INSERT INTO approval_rule_revision(rule_id, organization_id, revision, steps, created_by)
         VALUES($1,$2,1,$3::jsonb,$4)`,
        [ruleId, orgA, JSON.stringify([fixedStep()]), adminA.id],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    for (const steps of [[], [fixedStep(), fixedStep(), fixedStep(), headStep()]]) {
      await expect(
        q(
          `INSERT INTO approval_rule_revision(rule_id, organization_id, revision, steps, created_by)
           VALUES($1,$2,2,$3::jsonb,$4)`,
          [ruleId, orgA, JSON.stringify(steps), adminA.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});

describe('版の append-only (WP-P4-APR-015 §6-7)', () => {
  it('**管理者でも版を UPDATE / DELETE できない**', async () => {
    const created = await createRule(adminA, [fixedStep()]);
    const revision = (
      await q(
        'SELECT revision FROM approval_rule_revision WHERE rule_id=$1 AND organization_id=$2',
        [created.body.rule.id, orgA],
      )
    ).rows[0].revision;
    await expect(
      q(
        'UPDATE approval_rule_revision SET steps=$3::jsonb WHERE rule_id=$1 AND organization_id=$2',
        [created.body.rule.id, orgA, JSON.stringify([fixedStep()])],
      ),
    ).rejects.toThrow(/asset history is immutable/);
    await expect(
      q('DELETE FROM approval_rule_revision WHERE rule_id=$1 AND organization_id=$2', [
        created.body.rule.id,
        orgA,
      ]),
    ).rejects.toThrow(/asset history is immutable/);
    expect(revision).toBe(1);
  });

  it('**アプリロールは版を UPDATE / DELETE できない**(GRANTなし)', async () => {
    const created = await createRule(adminA, [fixedStep()]);
    for (const [sql, params] of [
      [
        'UPDATE approval_rule_revision SET steps=$2::jsonb WHERE rule_id=$1',
        [created.body.rule.id, JSON.stringify([fixedStep()])],
      ],
      ['DELETE FROM approval_rule_revision WHERE rule_id=$1', [created.body.rule.id]],
      ['DELETE FROM approval_rule WHERE id=$1', [created.body.rule.id]],
    ] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org',$1,true)", [orgA]);
        await expect(client.query(sql, [...params])).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  });

  it('**ルール行の識別列は変更できず、current_revision は後退できない。無効化は一方向**', async () => {
    const created = await createRule(adminA, [fixedStep()]);
    await expect(
      q('UPDATE approval_rule SET code=$2 WHERE id=$1', [created.body.rule.id, 'changed-code']),
    ).rejects.toThrow(/approval_rule_immutable/);
    await expect(
      q('UPDATE approval_rule SET current_revision=0 WHERE id=$1', [created.body.rule.id]),
    ).rejects.toThrow(/approval_rule_revision_regression/);
    await run(() => rules.deactivate(adminA.auth, created.body.rule.id));
    await expect(
      q('UPDATE approval_rule SET active=true WHERE id=$1', [created.body.rule.id]),
    ).rejects.toThrow(/approval_rule_reactivation/);
  });
});

describe('組織単位の有効化設定 (WP §6.1)', () => {
  it('**行が無ければ無効。org_admin だけが切り替えられ、監査に残る**', async () => {
    const before = await run(() => rules.settings(adminA.auth));
    expect(before.body.setting).toEqual({ enabled: false, updatedAt: null, updatedBy: null });
    const enabled = await run(() => rules.updateSettings(adminA.auth, { enabled: true }));
    expect(enabled.body.setting).toEqual({ enabled: true, changed: true });
    // 同じ値の再送は監査を重ねない
    const repeated = await run(() => rules.updateSettings(adminA.auth, { enabled: true }));
    expect(repeated.body.setting).toEqual({ enabled: true, changed: false });
    const disabled = await run(() => rules.updateSettings(adminA.auth, { enabled: false }));
    expect(disabled.body.setting).toEqual({ enabled: false, changed: true });

    const events = (
      await q(
        `SELECT event_type, after_state FROM audit_event
          WHERE organization_id=$1 AND event_type LIKE 'approval.routing.%'
          ORDER BY occurred_at, event_id`,
        [orgA],
      )
    ).rows;
    expect(events.map((row) => row.event_type)).toEqual([
      'approval.routing.enabled',
      'approval.routing.disabled',
    ]);
    expect(events[0].after_state).toEqual({ enabled: true });
    expect(events[1].after_state).toEqual({ enabled: false });
    // 他組織には影響しない
    expect((await run(() => rules.settings(adminB.auth))).body.setting.enabled).toBe(false);
  });
});

describe('監査 (02.17 §2.2 / ADR-0009)', () => {
  it('**作成・改版・無効化の監査に版・段の種別が残り、個人データを含まない**', async () => {
    const created = await createRule(adminA, [fixedStep(), managerStep()]);
    await run(() =>
      rules.revise(adminA.auth, created.body.rule.id, {
        expectedRevision: 1,
        steps: [fixedStep(), headStep()],
      }),
    );
    await run(() => rules.deactivate(adminA.auth, created.body.rule.id));
    const events = (
      await q(
        `SELECT event_type, target_id, after_state FROM audit_event
          WHERE organization_id=$1 AND event_type LIKE 'approval.rule.%'
          ORDER BY occurred_at, event_id`,
        [orgA],
      )
    ).rows;
    expect(events.map((row) => row.event_type)).toEqual([
      'approval.rule.created',
      'approval.rule.revised',
      'approval.rule.deactivated',
    ]);
    for (const event of events) expect(event.target_id).toBe(created.body.rule.id);
    expect(events[0].after_state).toMatchObject({
      revision: 1,
      stepCount: 2,
      stepTypes: 'fixed,manager',
      fixedApproverIds: approverA.id,
    });
    expect(events[1].after_state).toMatchObject({
      revision: 2,
      stepCount: 2,
      stepTypes: 'fixed,department_head',
    });
    expect(events[2].after_state).toMatchObject({ active: false, revision: 2 });
    expect(JSON.stringify(events)).not.toContain('SYNTH-EMP-WP015');
    expect(JSON.stringify(events)).not.toContain('合成役職');
    expect(JSON.stringify(events)).not.toContain('合成勤務地');
  });

  it('**監査の書込みに失敗するとルール作成も巻き戻る**', async () => {
    await withFailingAudit('approval.rule.created', async () => {
      await expect(
        run(() =>
          rules.create(adminA.auth, {
            code: nextCode(),
            name: '巻き戻し',
            steps: [fixedStep()],
          }),
        ),
      ).rejects.toThrow(/監査イベントの記録に失敗/);
    });
    expect(
      (await q('SELECT count(*)::int AS n FROM approval_rule WHERE organization_id=$1', [orgA]))
        .rows[0].n,
    ).toBe(0);
  });
});

describe('他組織の参照 (TL-06 / WP-P4-APR-015 §9)', () => {
  it('**RLS: 組織Aの文脈から組織Bのルールは見えず、書き込めない**', async () => {
    const ruleB = await run(() =>
      rules.create(adminB.auth, {
        code: nextCode(),
        name: '組織B',
        steps: [fixedStepFor(approverB.id)],
      }),
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [orgA]);
      expect(
        (await client.query('SELECT 1 FROM approval_rule WHERE id=$1', [ruleB.body.rule.id]))
          .rowCount,
      ).toBe(0);
      await expect(
        client.query(
          `INSERT INTO approval_rule(id, organization_id, code, name, active, current_revision, created_by)
           VALUES($1,$2,$3,'越境',true,1,$4)`,
          [randomUUID(), orgB, nextCode(), adminA.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('**API: 組織BのルールIDを指定したプレビュー・解決不能一覧は404**', async () => {
    const ruleB = await run(() =>
      rules.create(adminB.auth, {
        code: nextCode(),
        name: '組織B',
        steps: [fixedStepFor(approverB.id)],
      }),
    );
    await expectProblem(
      run(() =>
        rules.preview(adminA.auth, { requesterId: requesterA.id, ruleId: ruleB.body.rule.id }),
      ),
      404,
    );
    await expectProblem(
      run(() => rules.unresolved(adminA.auth, ruleB.body.rule.id)),
      404,
    );

    // 他組織の利用者IDをプレビューに渡しても、表示名を返さない(越境の個人データ漏えい防止)。
    const ruleA = await createRule(adminA, [fixedStep()]);
    const preview = await run(() =>
      rules.preview(adminA.auth, {
        requesterId: approverB.id,
        ruleId: ruleA.body.rule.id,
      }),
    );
    expect(preview.body).toMatchObject({
      resolved: false,
      requesterName: null,
      reason: { code: 'requester_not_active_member' },
    });
  });
});

describe('カタログ定義の ruleId 保存時検証 (WP §6.1)', () => {
  it('**同じ組織の有効なルールだけを定義へ保存できる**', async () => {
    const rule = await createRule(adminA, [fixedStep()]);
    const item = await run(() =>
      catalog.create(adminA.auth, {
        code: `wp015-item-${SUFFIX}-${++sequence}`,
        title: '合成カタログ',
        description: '合成',
        definition: definition(rule.body.rule.id),
        creationKey: randomUUID(),
      }),
    );
    made.items.push(item.id as string);
    expect(item).toMatchObject({ id: expect.any(String) });

    // 他組織のルール
    const ruleB = await run(() =>
      rules.create(adminB.auth, {
        code: nextCode(),
        name: '組織B',
        steps: [fixedStepFor(approverB.id)],
      }),
    );
    await expectProblem(
      run(() =>
        catalog.create(adminA.auth, {
          code: `wp015-item-${SUFFIX}-${++sequence}`,
          title: '合成カタログ',
          description: '合成',
          definition: definition(ruleB.body.rule.id),
          creationKey: randomUUID(),
        }),
      ),
      400,
      '承認ルール',
    );

    // 無効化されたルール
    await run(() => rules.deactivate(adminA.auth, rule.body.rule.id));
    await expectProblem(
      run(() =>
        catalog.create(adminA.auth, {
          code: `wp015-item-${SUFFIX}-${++sequence}`,
          title: '合成カタログ',
          description: '合成',
          definition: definition(rule.body.rule.id),
          creationKey: randomUUID(),
        }),
      ),
      400,
      '承認ルール',
    );
  });
});

describe('経路プレビュー (WP-P4-APR-015 §6-7)', () => {
  async function publishedItem(ruleId: string, approverId?: string): Promise<string> {
    const item = await run(() =>
      catalog.create(adminA.auth, {
        code: `wp015-preview-${SUFFIX}-${++sequence}`,
        title: '合成プレビュー',
        description: '合成',
        definition: definition(ruleId, approverId),
        creationKey: randomUUID(),
      }),
    );
    const id = item.id as string;
    made.items.push(id);
    await run(() =>
      catalog.publication(adminA.auth, id, { expectedVersion: 1, state: 'published' }),
    );
    return id;
  }

  it('**有効な組織ではルールの3段と名前を返す**', async () => {
    const rule = await createRule(adminA, [fixedStep(), managerStep(), headStep()]);
    const itemId = await publishedItem(rule.body.rule.id, approverA.id);
    await setProfile(orgA, requesterA.id, { managerUserId: managerA.id });
    await run(() => rules.updateSettings(adminA.auth, { enabled: true }));
    const preview = await run(() =>
      rules.preview(adminA.auth, {
        requesterId: requesterA.id,
        itemId,
        // ルールで決まる版では入力の approverId を使わない
        approverId: editorA.id,
      }),
    );
    expect(preview.body).toMatchObject({
      resolved: true,
      requesterId: requesterA.id,
      requesterName: 'WP015 requester-a',
      ruleRoutingEnabled: true,
      rule: { id: rule.body.rule.id, revision: 1, active: true },
    });
    const steps = preview.body.steps as Array<Record<string, unknown>>;
    expect(
      steps.map((step) => [step.stepNo, step.approverId, step.authorityType, step.resolvedFrom]),
    ).toEqual([
      [1, approverA.id, 'fixed', 'fixed'],
      [2, managerA.id, 'manager', 'manager'],
      [3, headA.id, 'department_head', 'department_head:self'],
    ]);
    expect(steps.map((step) => step.approverName)).toEqual([
      'WP015 approver-a',
      'WP015 manager-a',
      'WP015 head-a',
    ]);
  });

  it('**無効な組織では現行互換の1段を返す**', async () => {
    const rule = await createRule(adminA, [fixedStep(), managerStep()]);
    const itemId = await publishedItem(rule.body.rule.id, approverA.id);
    const preview = await run(() =>
      rules.preview(adminA.auth, { requesterId: requesterA.id, itemId, approverId: approverA.id }),
    );
    expect(preview.body).toMatchObject({ resolved: true, ruleRoutingEnabled: false, rule: null });
    expect(preview.body.steps).toEqual([
      {
        stepNo: 1,
        approverId: approverA.id,
        approverName: 'WP015 approver-a',
        authorityType: 'fixed',
        resolvedFrom: 'fixed',
      },
    ]);
  });

  it('**ルールIDを指定したプレビューは有効化設定に関係なくルールを使う**', async () => {
    const rule = await createRule(adminA, [managerStep()]);
    await setProfile(orgA, requesterA.id, { managerUserId: managerA.id });
    const preview = await run(() =>
      rules.preview(adminA.auth, { requesterId: requesterA.id, ruleId: rule.body.rule.id }),
    );
    expect(preview.body).toMatchObject({
      resolved: true,
      ruleRoutingEnabled: false,
      rule: { id: rule.body.rule.id, revision: 1 },
    });
    expect(preview.body.steps).toEqual([
      {
        stepNo: 1,
        approverId: managerA.id,
        approverName: 'WP015 manager-a',
        authorityType: 'manager',
        resolvedFrom: 'manager',
      },
    ]);
  });

  it('**解決できない場合は理由を返し、org_admin へフォールバックしない**', async () => {
    const rule = await createRule(adminA, [managerStep('reject')]);
    const preview = await run(() =>
      rules.preview(adminA.auth, { requesterId: requesterA.id, ruleId: rule.body.rule.id }),
    );
    expect(preview.body).toMatchObject({
      resolved: false,
      reason: { code: 'manager_unset', missing: 'manager' },
    });
    expect(JSON.stringify(preview.body)).not.toContain(adminA.id);
  });
});

describe('解決できない人の一覧 (WP-P4-APR-015 §6-7)', () => {
  it('**上長未設定の人だけを理由付きで返し、個人データを含めない**', async () => {
    const rule = await createRule(adminA, [managerStep('reject')]);
    await setProfile(orgA, managerA.id, { managerUserId: headA.id });
    const result = await run(() => rules.unresolved(adminA.auth, rule.body.rule.id));
    const items = result.body.items as Array<{
      userId: string;
      displayName: string;
      reason: { code: string };
    }>;
    expect(items.map((item) => item.userId)).toContain(requesterA.id);
    expect(items.map((item) => item.userId)).not.toContain(managerA.id);
    const requester = items.find((item) => item.userId === requesterA.id)!;
    expect(requester.displayName).toBe('WP015 requester-a');
    expect(requester.reason.code).toBe('manager_unset');
    expect(JSON.stringify(result.body)).not.toContain('SYNTH-EMP-WP015');
    expect(JSON.stringify(result.body)).not.toContain('合成役職');
    expect(JSON.stringify(result.body)).not.toContain('合成勤務地');
  });

  it('**固定承認者だけのルールでは固定承認者本人の自己承認だけが解決不能**', async () => {
    const rule = await createRule(adminA, [fixedStep()]);
    const result = await run(() => rules.unresolved(adminA.auth, rule.body.rule.id));
    const items = result.body.items as Array<{ userId: string; reason: { code: string } }>;
    expect(items.map((item) => item.userId)).toEqual([approverA.id]);
    expect(items[0]!.reason.code).toBe('fixed_approver_self');
    expect(result.body.scanned).toBeGreaterThan(0);
  });
});
