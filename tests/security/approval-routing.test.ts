/**
 * WP-P4-APR-015 段階A: 申請・変更での経路解決と保存 (TL-02 / TL-04 / TL-16)。
 *
 * - ルールで決めた経路は版に固定し、`route_hash` とステップ行で検証できる。
 * - 解決不能な申請は拒否し、足りない設定を応答へ含める。現行互換へ黙って落とさない。
 * - 組織で無効なら `ruleId` があっても現行互換(固定承認者、無ければ申請者選択)の1段。
 * - ルールで決めた版では入力の `approverId` を承認者に使わない。
 * - 2段・3段の経路は1段目だけでは実行できない。段階Aでは `decide` の
 *   `approver` ロール要求を緩めない(段階Bで変更する)。
 * - 上長が変わっても進行中の申請の経路は変わらない。経路を変えるのは変更(新しい版)だけ。
 *
 * 実行先は使い捨てDB(名前に `wp015` と `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { newContext, runWithContext } from '@solvi/shared';
import type { ApprovalRuleStep } from '@solvi/shared/catalog';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import {
  routeHash,
  type ApprovalRoute,
  type ApprovalStepRow,
} from '../../services/api/src/modules/catalog/approval-state.js';
import { ApprovalRuleController } from '../../services/api/src/modules/catalog/approval-rule.routes.js';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData } from '../support/cleanup.js';

const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);

let pool: pg.Pool;
let admin: pg.Client;
let rules: ApprovalRuleController;
let catalogAdmin: CatalogAdminController;
let catalog: CatalogController;

let org: string;
let deptRoot: string;
let deptPrimary: string;
let deptNoHead: string;

type Person = { id: string; auth: AuthenticatedRequest };
let adminUser: Person;
let requester: Person;
let manager: Person;
let head: Person;
let ancestorHead: Person;
let fixed: Person;
let fixedInactive: Person;
let otherApprover: Person;
let agent: Person;
let noManager: Person;
let orgAdminRequester: Person;

const made = { users: [] as string[], orgs: [] as string[] };
let sequence = 0;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

function authFor(userId: string, roles: RoleCode[]): AuthenticatedRequest {
  return {
    userId,
    sessionId: `wp015-route-${userId.slice(0, 8)}`,
    authz: {
      organizationId: org,
      principal: {
        userId,
        status: 'active',
        bindings: roles.map((roleCode) => ({
          roleCode,
          organizationId: org,
          validFrom: PAST,
          validUntil: null,
        })),
      },
    },
  };
}

async function makeUser(label: string, roles: RoleCode[]): Promise<Person> {
  const id = randomUUID();
  await q(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `wp015-route-${label}-${id.slice(0, 8)}@example.test`, `WP015 ${label}`],
  );
  made.users.push(id);
  for (const role of roles)
    await q(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = 'org'), 'org', $4, 'manual', $5, NULL)`,
      [randomUUID(), id, role, org, PAST],
    );
  await q('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [org, id]);
  return { id, auth: authFor(id, roles) };
}

async function makeDepartment(label: string, parentId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1,$2,$3,$4,$5)`,
    [id, org, `wp015-route-${label}-${SUFFIX}`, `WP015 ${label} (合成)`, parentId],
  );
  return id;
}

async function setManager(userId: string, managerUserId: string | null): Promise<void> {
  await q(
    'UPDATE org_member_profile SET manager_user_id=$3 WHERE organization_id=$1 AND user_id=$2',
    [org, userId, managerUserId],
  );
}

async function setDepartment(userId: string, departmentId: string): Promise<void> {
  await q(
    'UPDATE org_member_profile SET primary_department_id=$3 WHERE organization_id=$1 AND user_id=$2',
    [org, userId, departmentId],
  );
}

async function assignHead(departmentId: string, userId: string): Promise<void> {
  await q(
    `INSERT INTO department_head (id, department_id, organization_id, user_id, valid_from, created_by)
     VALUES ($1,$2,$3,$4,$5,$4)`,
    [randomUUID(), departmentId, org, userId, PAST],
  );
}

async function expectProblem(
  promise: Promise<unknown>,
  status: number,
  messageParts: string[] = [],
): Promise<void> {
  let caught: (Error & { status?: number; errors?: unknown }) | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { status?: number; errors?: unknown };
  }
  expect(caught, '拒否されるべき操作が成功した').toBeDefined();
  expect(caught?.status, caught?.message).toBe(status);
  const text = `${caught?.message ?? ''} ${JSON.stringify(caught?.errors ?? [])}`;
  for (const part of messageParts) expect(text).toContain(part);
}

const nextCode = () => `route-${SUFFIX}-${++sequence}`;

const fixedStep = (approverId: string) => ({ type: 'fixed' as const, approverId });
const managerStep = (onUnresolved: 'department_head' | 'reject' = 'reject') => ({
  type: 'manager' as const,
  onUnresolved,
});
const headStep = () => ({ type: 'department_head' as const, onUnresolved: 'reject' as const });

async function createRule(steps: ApprovalRuleStep[], code = nextCode()): Promise<string> {
  const created = await run(() =>
    rules.create(adminUser.auth, { code, name: `合成 ${code}`, steps }),
  );
  return created.body.rule.id as string;
}

function definition(approval: { ruleId?: string; approverId?: string }) {
  return {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成対象',
    allowedDurations: [7],
    maxReasonLength: 2000,
    approval,
  };
}

async function publishItem(approval: { ruleId?: string; approverId?: string }): Promise<string> {
  const created = await run(() =>
    catalogAdmin.create(adminUser.auth, {
      code: `wp015-route-item-${SUFFIX}-${++sequence}`,
      title: '合成ルーティング',
      description: '合成',
      definition: definition(approval),
      creationKey: randomUUID(),
    }),
  );
  const id = created.id as string;
  await run(() =>
    catalogAdmin.publication(adminUser.auth, id, { expectedVersion: 1, state: 'published' }),
  );
  return id;
}

/** 製品コードを迂回して、他組織・存在しないルールIDを持つ項目を用意する。 */
async function publishItemDirect(approval: {
  ruleId?: string;
  approverId?: string;
}): Promise<string> {
  const id = uuidv7();
  const d = definition(approval);
  await q(
    `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,active)
     VALUES($1,$2,$3,1,'合成 直接投入','合成',$4,true)`,
    [id, org, `wp015-route-direct-${SUFFIX}-${++sequence}`, d],
  );
  return id;
}

async function createRequest(
  requesterPerson: Person,
  itemId: string,
  extra: Record<string, unknown> = {},
) {
  return run(() =>
    catalog.create(requesterPerson.auth, {
      itemId,
      itemVersion: 1,
      idempotencyKey: uuidv7(),
      reason: '合成: 経路解決',
      durationDays: 7,
      ...extra,
    }),
  );
}

const requestRow = async (id: string) =>
  (await q('SELECT * FROM local_service_request WHERE id=$1', [id])).rows[0];
const revisionRow = async (id: string, revision = 1) =>
  (
    await q('SELECT * FROM local_request_revision WHERE request_id=$1 AND revision=$2', [
      id,
      revision,
    ])
  ).rows[0];
const stepRows = async (id: string, revision = 1) =>
  (
    await q(
      'SELECT * FROM local_request_approval WHERE request_id=$1 AND revision=$2 ORDER BY route_generation,step_no',
      [id, revision],
    )
  ).rows as ApprovalStepRow[];

async function enableRouting(enabled = true): Promise<void> {
  await run(() => rules.updateSettings(adminUser.auth, { enabled }));
}

async function withFailingAudit(eventType: string, fn: () => Promise<void>): Promise<void> {
  await admin.query(
    `CREATE OR REPLACE FUNCTION wp015_route_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN
       IF NEW.event_type = '${eventType}' THEN
         RAISE EXCEPTION 'wp015_route_forced_audit_failure';
       END IF;
       RETURN NEW;
     END $f$`,
  );
  await admin.query(
    `CREATE TRIGGER wp015_route_fail_audit BEFORE INSERT ON audit_event
       FOR EACH ROW EXECUTE FUNCTION wp015_route_fail_audit()`,
  );
  try {
    await fn();
  } finally {
    await admin.query('DROP TRIGGER wp015_route_fail_audit ON audit_event');
    await admin.query('DROP FUNCTION wp015_route_fail_audit()');
  }
}

async function cleanRulesFor(organizationId: string): Promise<void> {
  let disabled = false;
  await admin.query('BEGIN');
  try {
    await admin.query('SET CONSTRAINTS approval_rule_current_revision_fk DEFERRED');
    await admin.query(
      'ALTER TABLE approval_rule_revision DISABLE TRIGGER approval_rule_revision_immutable',
    );
    disabled = true;
    await q('DELETE FROM approval_rule_revision WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM approval_rule WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM org_approval_setting WHERE organization_id=$1', [organizationId]);
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

async function cleanOrgData(): Promise<void> {
  await cleanAuditData(admin, `organization_id = '${org}'`);
  // local_service_request.current_approval_id は DEFERRABLE なので、
  // 承認行→版→申請の削除を1トランザクションで行う(途中コミットで FK を見ない)。
  await admin.query('BEGIN');
  try {
    await q('DELETE FROM local_simulation_receipt WHERE organization_id=$1', [org]);
    await q('DELETE FROM local_request_checklist_progress WHERE organization_id=$1', [org]);
    await q('DELETE FROM local_request_approval WHERE organization_id=$1', [org]);
    await q('DELETE FROM local_request_revision WHERE organization_id=$1', [org]);
    await q('DELETE FROM local_service_request WHERE organization_id=$1', [org]);
    await q('DELETE FROM notification WHERE organization_id=$1', [org]);
    await q('DELETE FROM outbox_event WHERE organization_id=$1', [org]);
    await q(
      'DELETE FROM ticket_comment WHERE ticket_id IN (SELECT id FROM ticket WHERE organization_id=$1)',
      [org],
    );
    await q(
      'DELETE FROM ticket_assignment WHERE ticket_id IN (SELECT id FROM ticket WHERE organization_id=$1)',
      [org],
    );
    await q(
      'DELETE FROM ticket_attachment WHERE ticket_id IN (SELECT id FROM ticket WHERE organization_id=$1)',
      [org],
    );
    await q('DELETE FROM ticket_relation WHERE organization_id=$1', [org]);
    await q('DELETE FROM ticket WHERE organization_id=$1', [org]);
    await q('DELETE FROM ticket_number_counter WHERE organization_id=$1', [org]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  await admin.query(
    'ALTER TABLE local_catalog_revision DISABLE TRIGGER local_catalog_revision_immutable',
  );
  try {
    await q('DELETE FROM local_catalog_revision WHERE organization_id=$1', [org]);
  } finally {
    await admin.query(
      'ALTER TABLE local_catalog_revision ENABLE TRIGGER local_catalog_revision_immutable',
    );
  }
  await q('DELETE FROM local_catalog_item WHERE organization_id=$1', [org]);
  await cleanRulesFor(org);
}

async function resetProfiles(): Promise<void> {
  await q(
    `UPDATE org_member_profile
        SET manager_user_id = NULL, primary_department_id = NULL
      WHERE organization_id=$1`,
    [org],
  );
  await q(`UPDATE app_user SET status='active', deactivated_at=NULL WHERE id = ANY($1::uuid[])`, [
    made.users,
  ]);
  await setDepartment(requester.id, deptPrimary);
  await setManager(requester.id, manager.id);
  await setDepartment(manager.id, deptPrimary);
  await setDepartment(head.id, deptPrimary);
  await setDepartment(ancestorHead.id, deptRoot);
  await setDepartment(noManager.id, deptNoHead);
  await setDepartment(fixed.id, deptPrimary);
  await setDepartment(otherApprover.id, deptPrimary);
  await setDepartment(orgAdminRequester.id, deptPrimary);
  await setManager(orgAdminRequester.id, manager.id);
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 8 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const client of [pool, admin]) {
    const name = (await client.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!name.includes('wp015') || !name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は wp015 の使い捨てDBではありません。中止します`);
    }
  }
  rules = new ApprovalRuleController(pool, true);
  catalogAdmin = new CatalogAdminController(pool, true);
  catalog = new CatalogController(
    pool,
    {} as ConstructorParameters<typeof CatalogController>[1],
    true,
  );

  org = randomUUID();
  made.orgs.push(org);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    org,
    `wp015-route-${SUFFIX}`,
    'WP015 ルーティング (合成)',
  ]);
  deptRoot = await makeDepartment('root', null);
  deptPrimary = await makeDepartment('primary', deptRoot);
  // 祖先にも部署長がいない根部署(解決不能の理由を確かめる)。
  deptNoHead = await makeDepartment('no-head', null);

  adminUser = await makeUser('admin', ['org_admin']);
  requester = await makeUser('requester', ['requester']);
  manager = await makeUser('manager', ['requester']);
  head = await makeUser('head', ['requester']);
  ancestorHead = await makeUser('ancestor-head', ['requester']);
  fixed = await makeUser('fixed', ['approver']);
  fixedInactive = await makeUser('fixed-inactive', ['approver']);
  otherApprover = await makeUser('other-approver', ['approver']);
  agent = await makeUser('agent', ['agent']);
  noManager = await makeUser('no-manager', ['requester']);
  orgAdminRequester = await makeUser('org-admin-requester', ['org_admin', 'requester']);
  await assignHead(deptPrimary, head.id);
  await assignHead(deptRoot, ancestorHead.id);
  await resetProfiles();
}, 60_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanOrgData();
      await q('DELETE FROM department_head WHERE organization_id=$1', [org]);
      await q(
        'UPDATE org_member_profile SET manager_user_id=NULL, primary_department_id=NULL WHERE organization_id=$1',
        [org],
      );
      await q('DELETE FROM org_member_profile WHERE organization_id=$1', [org]);
      await q('UPDATE department SET parent_id=NULL WHERE organization_id=$1', [org]);
      await q('DELETE FROM department WHERE organization_id=$1', [org]);
      await q('DELETE FROM role_binding WHERE organization_id=$1', [org]);
      await q('DELETE FROM role_binding WHERE user_id = ANY($1::uuid[])', [made.users]);
      await q('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [made.users]);
      for (const id of made.orgs) await cleanAuditData(admin, `organization_id = '${id}'`);
      await q('DELETE FROM organization WHERE id = ANY($1::uuid[])', [made.orgs]);
    } finally {
      await admin.end();
    }
  }
  await pool?.end();
});

beforeEach(async () => {
  if (!admin) return;
  await cleanOrgData();
  await resetProfiles();
});

describe('ルールによる経路解決と保存 (WP §6-4)', () => {
  it('**3段の経路を版に固定し、入力の approverId を承認者に使わない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep(), headStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId, {
      // ルールで決まる版では無視される。存在しない利用者IDでも経路に影響しない。
      approverId: randomUUID(),
    });
    const revision = await revisionRow(created.id);
    const route = revision.route as ApprovalRoute;
    expect(route.ruleRef).toEqual({ ruleId, revision: 1 });
    expect(route.steps).toEqual([
      { stepNo: 1, approverId: fixed.id, authorityType: 'fixed', resolvedFrom: 'fixed' },
      { stepNo: 2, approverId: manager.id, authorityType: 'manager', resolvedFrom: 'manager' },
      {
        stepNo: 3,
        approverId: head.id,
        authorityType: 'department_head',
        resolvedFrom: 'department_head:self',
      },
    ]);
    expect(revision.route_hash).toBe(routeHash(route));
    expect(revision.route_generation).toBe(1);
    const steps = await stepRows(created.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      step_no: 1,
      approver_id: fixed.id,
      authority_type: 'fixed',
      resolved_from: 'fixed',
      state: 'pending',
    });
    expect(steps[0]!.approver_id).not.toBe(randomUUID());

    const event = (
      await q(
        `SELECT after_state FROM audit_event
          WHERE target_id=$1 AND event_type='approval.route.resolved'`,
        [created.id],
      )
    ).rows[0];
    expect(event.after_state).toMatchObject({
      revision: 1,
      routeGeneration: 1,
      ruleRoutingEnabled: true,
      ruleId,
      ruleRevision: 1,
      stepCount: 3,
      stepTypes: 'fixed,manager,department_head',
      resolvedFrom: 'fixed,manager,department_head:self',
      approverIds: `${fixed.id},${manager.id},${head.id}`,
    });
    expect(event.after_state.routeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event.after_state)).not.toContain('合成: 経路解決');
  });

  it('**route.resolved の監査に失敗したら、申請・チケット・経路を巻き戻す**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await withFailingAudit('approval.route.resolved', async () => {
      await expect(run(() => createRequest(requester, itemId))).rejects.toThrow(
        /監査イベントの記録に失敗/,
      );
    });
    for (const table of [
      'local_service_request',
      'local_request_revision',
      'local_request_approval',
      'ticket',
    ]) {
      expect(
        (await q(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`, [org])).rows[0]
          .n,
        `${table} が巻き戻っていない`,
      ).toBe(0);
    }
  });

  it('**2段・3段の経路は1段目だけでは実行できない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), fixedStep(otherApprover.id), headStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await run(() =>
      catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
    );
    const request = await requestRow(created.id);
    expect(request.state).toBe('pending');
    const steps = await stepRows(created.id);
    expect(steps.map((step) => [step.step_no, step.state])).toEqual([
      [1, 'approved'],
      [2, 'pending'],
    ]);
    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, created.id, {
          requestRevision: 1,
          expectedVersion: request.version,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
    await expectProblem(
      run(() => catalog.simulate(agent.auth, created.id, { expectedVersion: request.version })),
      409,
    );
  });

  it('**段階Aでは上長ステップの決定にも approver ロールが必要**(段階Bで変更する)**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await run(() =>
      catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
    );
    // manager は自分宛てのステップの承認者なので可視(404ではない)だが、
    // 段階Aでは approver ロール要求を残すため 403。
    await expectProblem(
      run(() =>
        catalog.decide(manager.auth, created.id, { decision: 'approve', expectedVersion: 2 }),
      ),
      403,
    );
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual(['approved', 'pending']);
  });
});

describe('解決不能の拒否と理由 (WP-P4-APR-015 §6-3)', () => {
  it('**上長未設定で onUnresolved=reject なら拒否し、理由を返す**', async () => {
    const ruleId = await createRule([managerStep('reject')]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await expectProblem(
      run(() => createRequest(noManager, itemId)),
      409,
      ['上長', '未設定'],
    );
    expect(
      (
        await q('SELECT count(*)::int AS n FROM local_service_request WHERE organization_id=$1', [
          org,
        ])
      ).rows[0].n,
    ).toBe(0);
    // 02.17 §2.2: 解決不能は denied として残り、足りない設定の種別を持つ。
    const denied = (
      await q(
        `SELECT outcome, policy_decision FROM audit_event
          WHERE organization_id=$1 AND event_type='approval.route.resolved'
          ORDER BY occurred_at DESC LIMIT 1`,
        [org],
      )
    ).rows[0];
    expect(denied).toMatchObject({
      outcome: 'denied',
      policy_decision: { reason: 'manager_unset', missing: 'manager', stepNo: 1 },
    });
  });

  it('**上長未設定で部署長も不在なら、両方を理由に含めて拒否する**(org_admin へ落とさない)**', async () => {
    const ruleId = await createRule([managerStep('department_head')]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await expectProblem(
      run(() => createRequest(noManager, itemId)),
      409,
      ['上長', '部署長'],
    );
  });

  it('**上長未設定でも部署長がいるなら部署長へ進む**', async () => {
    const ruleId = await createRule([managerStep('department_head')]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await setManager(requester.id, null);
    const created = await createRequest(requester, itemId);
    const route = (await revisionRow(created.id)).route as ApprovalRoute;
    expect(route.steps).toEqual([
      {
        stepNo: 1,
        approverId: head.id,
        authorityType: 'manager',
        resolvedFrom: 'manager>department_head',
      },
    ]);
  });

  it('**組織管理者の申請は、上長データがあっても上長未設定として扱う**', async () => {
    const ruleId = await createRule([managerStep('reject')]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await expectProblem(
      run(() => createRequest(orgAdminRequester, itemId)),
      409,
      ['組織管理者'],
    );
  });

  it('**固定承認者が無効になったら拒否し、申請者選択で代用しない**', async () => {
    const ruleId = await createRule([fixedStep(fixedInactive.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await q("UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1", [
      fixedInactive.id,
    ]);
    await expectProblem(
      run(() => createRequest(requester, itemId, { approverId: fixed.id })),
      403,
      ['固定承認者'],
    );
  });

  it('**ルールが無効・存在しないなら拒否する**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await run(() => rules.deactivate(adminUser.auth, ruleId));
    await expectProblem(
      run(() => createRequest(requester, itemId)),
      409,
      ['承認ルール'],
    );

    const missingItem = await publishItemDirect({ ruleId: randomUUID() });
    await expectProblem(
      run(() => createRequest(requester, missingItem)),
      409,
      ['承認ルール'],
    );
  });

  it('**他組織のルールIDは、定義の保存時と申請時の両方で拒否する**', async () => {
    const otherOrg = randomUUID();
    const otherAdmin = randomUUID();
    const otherApprover = randomUUID();
    made.orgs.push(otherOrg);
    made.users.push(otherAdmin, otherApprover);
    try {
      await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
        otherOrg,
        `wp015-route-other-${SUFFIX}`,
        'WP015 他組織 (合成)',
      ]);
      for (const [id, role] of [
        [otherAdmin, 'org_admin'],
        [otherApprover, 'approver'],
      ] as const) {
        await q(
          `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
           VALUES ($1,$2,$3,'active','admin')`,
          [id, `wp015-route-other-${role}-${id.slice(0, 8)}@example.test`, `WP015 ${role}`],
        );
        await q(
          `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source,valid_from)
           VALUES ($1,$2,(SELECT id FROM role WHERE code=$3 AND scope='org'),'org',$4,'manual',$5)`,
          [randomUUID(), id, role, otherOrg, PAST],
        );
        await q('INSERT INTO org_member_profile (organization_id,user_id) VALUES ($1,$2)', [
          otherOrg,
          id,
        ]);
      }
      const otherAuth: AuthenticatedRequest = {
        userId: otherAdmin,
        sessionId: 'wp015-route-other',
        authz: {
          organizationId: otherOrg,
          principal: {
            userId: otherAdmin,
            status: 'active',
            bindings: [
              {
                roleCode: 'org_admin',
                organizationId: otherOrg,
                validFrom: PAST,
                validUntil: null,
              },
            ],
          },
        },
      };
      const ruleB = await run(() =>
        rules.create(otherAuth, {
          code: nextCode(),
          name: '他組織ルール',
          steps: [fixedStep(otherApprover)],
        }),
      );
      const item = await publishItemDirect({ ruleId: ruleB.body.rule.id });
      await enableRouting();
      await expectProblem(
        run(() => createRequest(requester, item)),
        409,
        ['承認ルール'],
      );
      await expectProblem(
        run(() =>
          catalogAdmin.create(adminUser.auth, {
            code: `wp015-route-cross-${SUFFIX}-${++sequence}`,
            title: '合成 越境',
            description: '合成',
            definition: definition({ ruleId: ruleB.body.rule.id }),
            creationKey: randomUUID(),
          }),
        ),
        400,
        ['承認ルール'],
      );
    } finally {
      await cleanAuditData(admin, `organization_id = '${otherOrg}'`);
      await cleanRulesFor(otherOrg);
      await q('DELETE FROM org_member_profile WHERE organization_id=$1', [otherOrg]);
      await q('DELETE FROM role_binding WHERE organization_id=$1', [otherOrg]);
      await q('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [[otherAdmin, otherApprover]]);
      await q('DELETE FROM organization WHERE id=$1', [otherOrg]);
      made.orgs = made.orgs.filter((id) => id !== otherOrg);
      made.users = made.users.filter((id) => id !== otherAdmin && id !== otherApprover);
    }
  });
});

describe('組織で無効なときの現行互換 (WP §6.1)', () => {
  it('**ruleId があっても固定承認者の1段になり、ruleRef は null**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId, approverId: fixed.id });
    const created = await createRequest(requester, itemId, { approverId: fixed.id });
    const route = (await revisionRow(created.id)).route as ApprovalRoute;
    expect(route.ruleRef).toBeNull();
    expect(route.steps).toEqual([
      { stepNo: 1, approverId: fixed.id, authorityType: 'fixed', resolvedFrom: 'fixed' },
    ]);
    const event = (
      await q(
        `SELECT after_state FROM audit_event WHERE target_id=$1 AND event_type='approval.route.resolved'`,
        [created.id],
      )
    ).rows[0];
    expect(event.after_state).toMatchObject({
      ruleRoutingEnabled: false,
      ruleId: null,
      ruleRevision: null,
      stepTypes: 'fixed',
    });
  });

  it('**固定承認者が無ければ申請者が選んだ承認者の1段になり、未指定は400**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await expectProblem(
      run(() => createRequest(requester, itemId)),
      400,
      ['承認者'],
    );
    const created = await createRequest(requester, itemId, { approverId: otherApprover.id });
    const route = (await revisionRow(created.id)).route as ApprovalRoute;
    expect(route.ruleRef).toBeNull();
    expect(route.steps).toEqual([
      {
        stepNo: 1,
        approverId: otherApprover.id,
        authorityType: 'legacy',
        resolvedFrom: 'requester_selected',
      },
    ]);
  });
});

describe('変更時の再解決と経路の固定 (WP-P4-APR-015 §6-4)', () => {
  it('**変更は現在のルール版で新しい版を解決し、旧版の経路を書き換えない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    const before = await revisionRow(created.id);
    // 1段目だけ承認した状態から変更する(承認済み・未決定の両方を無効化する)。
    await run(() =>
      catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
    );
    await run(() =>
      rules.revise(adminUser.auth, ruleId, {
        expectedRevision: 1,
        steps: [fixedStep(fixed.id), headStep()],
      }),
    );
    await run(() =>
      catalog.edit(requester.auth, created.id, {
        expectedVersion: 2,
        reason: '合成: 変更後の再承認',
        durationDays: 7,
      }),
    );
    const oldRevision = await revisionRow(created.id, 1);
    const newRevision = await revisionRow(created.id, 2);
    expect(oldRevision.route_hash).toBe(before.route_hash);
    expect((oldRevision.route as ApprovalRoute).ruleRef).toEqual({ ruleId, revision: 1 });
    expect((newRevision.route as ApprovalRoute).ruleRef).toEqual({ ruleId, revision: 2 });
    expect((newRevision.route as ApprovalRoute).steps.map((step) => step.approverId)).toEqual([
      fixed.id,
      head.id,
    ]);
    expect((await requestRow(created.id)).revision).toBe(2);
    // 旧版のステップは invalidated、新しい版の最初のステップは pending
    expect((await stepRows(created.id, 1)).map((step) => step.state)).toEqual([
      'invalidated',
      'invalidated',
    ]);
    expect((await stepRows(created.id, 2)).map((step) => step.state)).toEqual(['pending']);
    const resolved = (
      await q(
        `SELECT after_state FROM audit_event
          WHERE target_id=$1 AND event_type='approval.route.resolved'
          ORDER BY occurred_at, event_id`,
        [created.id],
      )
    ).rows;
    expect(resolved).toHaveLength(2);
    expect(resolved[1].after_state).toMatchObject({ revision: 2, ruleRevision: 2 });
  });

  it('**上長が変わっても進行中の申請の経路は変わらない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    const before = await revisionRow(created.id);
    await setManager(requester.id, head.id);
    expect((await revisionRow(created.id)).route).toEqual(before.route);
    expect((await stepRows(created.id))[0]!.state).toBe('pending');
    await run(() =>
      catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
    );
    // 次のステップは保存済みの経路(旧上長)から作られる
    expect((await stepRows(created.id)).map((step) => [step.step_no, step.approver_id])).toEqual([
      [1, fixed.id],
      [2, manager.id],
    ]);
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM audit_event
            WHERE target_id=$1 AND event_type='approval.route.resolved'`,
          [created.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('**有効化を後から無効にしても、進行中の多段申請は全ステップを要求し続ける**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await enableRouting(false);
    await run(() =>
      catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
    );
    const request = await requestRow(created.id);
    expect(request.state).toBe('pending');
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual(['approved', 'pending']);
    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, created.id, {
          requestRevision: 1,
          expectedVersion: request.version,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
    await expectProblem(
      run(() => catalog.simulate(agent.auth, created.id, { expectedVersion: request.version })),
      409,
    );
  });
});

describe('冪等リプレイ (WP-P4-APR-015 §6-4)', () => {
  it('**ルールで決めた版は、入力の approverId の違いを相違とみなさない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const key = uuidv7();
    const body = {
      itemId,
      itemVersion: 1,
      idempotencyKey: key,
      reason: '合成: リプレイ',
      durationDays: 7,
    };
    const created = await createRequest(requester, itemId, body);
    await expect(
      run(() => catalog.create(requester.auth, { ...body, approverId: otherApprover.id })),
    ).resolves.toEqual({ id: created.id, ticketId: created.ticketId, replayed: true });
    await expectProblem(
      run(() => catalog.create(requester.auth, { ...body, reason: '合成: 変更' })),
      409,
    );
    expect(
      (
        await q('SELECT count(*)::int AS n FROM local_service_request WHERE idempotency_key=$1', [
          key,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('**ルールを使わない版は、従来どおり approverId の違いを相違とみなす**', async () => {
    const itemId = await publishItem({ approverId: fixed.id });
    const key = uuidv7();
    const body = {
      itemId,
      itemVersion: 1,
      idempotencyKey: key,
      approverId: fixed.id,
      reason: '合成: リプレイ互換',
      durationDays: 7,
    };
    const created = await createRequest(requester, itemId, body);
    await expectProblem(
      run(() => catalog.create(requester.auth, { ...body, approverId: otherApprover.id })),
      409,
    );
    await expect(run(() => catalog.create(requester.auth, body))).resolves.toMatchObject({
      id: created.id,
      replayed: true,
    });
  });
});

describe('経路の改ざん検知 (TL-16)', () => {
  it('**route_hash を改ざんした版では決定も実行も拒否される**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), headStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await q("UPDATE local_request_revision SET route_hash=repeat('0',64) WHERE request_id=$1", [
      created.id,
    ]);
    await expectProblem(
      run(() =>
        catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
      ),
      409,
    );
    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, created.id, {
          requestRevision: 1,
          expectedVersion: 1,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
  });
});
