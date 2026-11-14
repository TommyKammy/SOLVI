/**
 * WP-P4-APR-015 段階A・段階B: 経路解決・関係ベースの決定認可・可視性・滞留
 * (TL-02 / TL-04 / TL-06 / TL-16)。
 *
 * - ルールで決めた経路は版に固定し、`route_hash` とステップ行で検証できる。
 * - 解決不能な申請は拒否し、足りない設定を応答へ含める。現行互換へ黙って落とさない。
 * - 組織で無効なら `ruleId` があっても現行互換(固定承認者、無ければ申請者選択)の1段。
 * - ルールで決めた版では入力の `approverId` を承認者に使わない。
 * - `manager` / `department_head` は `approver` ロール無しで決定できる。
 *   `fixed` / `legacy` は従来どおり `approver` ロールを要求する。
 * - 承認待ち一覧・受信箱は「自分が現在の pending ステップの承認者」で判定する。
 * - 承認者不在は一覧に導出し、申請者の内容変更で新しい版が現在のデータから解決される。
 * - 上長が変わっても進行中の申請の経路は変わらない。経路を変えるのは変更(新しい版)だけ。
 * - 再割当は `local_request_revision` の UPDATE 権限が無いため、この段階では実装しない。
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
import { InboxController } from '../../services/api/src/modules/inbox/inbox.routes.js';
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

const decide = (
  person: Person,
  id: string,
  expectedVersion: number,
  decision: 'approve' | 'reject' | 'revoke' = 'approve',
  reason = '',
) => run(() => catalog.decide(person.auth, id, { decision, expectedVersion, reason }));

const listFor = (person: Person, params: Record<string, string> = {}) =>
  run(() => catalog.list(person.auth, new URLSearchParams(params)));

const detailFor = (person: Person, id: string) => run(() => catalog.detail(person.auth, id));

/** 指定した状態コードのいずれかで拒否されることを確かめる。 */
async function expectDenied(
  promise: Promise<unknown>,
  statuses: number[],
  messageParts: string[] = [],
): Promise<void> {
  let caught: (Error & { status?: number; errors?: unknown }) | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { status?: number; errors?: unknown };
  }
  expect(caught, '拒否されるべき操作が成功した').toBeDefined();
  expect(statuses, caught?.message).toContain(caught?.status);
  const text = `${caught?.message ?? ''} ${JSON.stringify(caught?.errors ?? [])}`;
  for (const part of messageParts) expect(text).toContain(part);
}

/** 経路と承認行を直接その利用者・種別へ差し替える(認可の検査を分離するため)。 */
async function forceStep(
  requestId: string,
  input: {
    approverId: string;
    authorityType: 'legacy' | 'fixed' | 'manager' | 'department_head';
    stepNo?: number;
  },
): Promise<void> {
  const revision = await revisionRow(requestId);
  const route = revision.route as ApprovalRoute;
  const stepNo = input.stepNo ?? 1;
  const nextRoute: ApprovalRoute = {
    ...route,
    steps: route.steps.map((step) =>
      step.stepNo === stepNo
        ? { ...step, approverId: input.approverId, authorityType: input.authorityType }
        : step,
    ),
  };
  await q('UPDATE local_request_revision SET route=$2,route_hash=$3 WHERE request_id=$1', [
    requestId,
    nextRoute,
    routeHash(nextRoute),
  ]);
  await q(
    `UPDATE local_request_approval
        SET approver_id=$2, authority_type=$3
      WHERE request_id=$1 AND step_no=$4`,
    [requestId, input.approverId, input.authorityType, stepNo],
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
  // 期限切れの role_binding を試すテストがあるため、毎回の基準状態へ戻す。
  await q(
    `UPDATE role_binding SET valid_until=NULL
      WHERE organization_id=$1 AND user_id = ANY($2::uuid[])`,
    [org, made.users],
  );
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

  it('**関係ベースの段は approver ロール無しで決定できる**(段階B)**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await run(() =>
      catalog.decide(fixed.auth, created.id, { decision: 'approve', expectedVersion: 1 }),
    );
    expect(manager.auth.authz.principal.bindings.map((b) => b.roleCode)).toEqual(['requester']);
    await expect(decide(manager, created.id, 2)).resolves.toMatchObject({
      state: 'approved',
      stepState: 'approved',
    });
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual([
      'approved',
      'approved',
    ]);
    expect((await requestRow(created.id)).state).toBe('approved');
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

describe('決定の認可: 関係ベースのステップ (WP §6-5 / ADR-0023 §2)', () => {
  it('**approver ロールを持たない上長が、自分宛ての manager ステップを承認・却下できる**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    expect(manager.auth.authz.principal.bindings.map((b) => b.roleCode)).toEqual(['requester']);

    const approved = await createRequest(requester, itemId);
    await expect(decide(manager, approved.id, 1)).resolves.toEqual({
      id: approved.id,
      state: 'approved',
      stepState: 'approved',
    });
    expect((await requestRow(approved.id)).state).toBe('approved');

    const rejected = await createRequest(requester, itemId);
    await expect(
      decide(manager, rejected.id, 1, 'reject', '合成: 上長による却下'),
    ).resolves.toEqual({ id: rejected.id, state: 'rejected', stepState: 'rejected' });
    expect((await requestRow(rejected.id)).state).toBe('rejected');
  }, 30_000);

  it('**approver ロールを持たない部署長が department_head ステップを承認できる**', async () => {
    const ruleId = await createRule([headStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    expect(head.auth.authz.principal.bindings.map((b) => b.roleCode)).toEqual(['requester']);
    await expect(decide(head, created.id, 1)).resolves.toMatchObject({ state: 'approved' });
  }, 30_000);

  it('**2段・3段で関係ベースと固定が混在しても、全段の承認後に実行できる**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixed.id), headStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await expect(decide(manager, created.id, 1)).resolves.toMatchObject({
      state: 'pending',
      stepState: 'approved',
    });
    await expect(decide(fixed, created.id, 2)).resolves.toMatchObject({
      state: 'pending',
      stepState: 'approved',
    });
    await expect(decide(head, created.id, 3)).resolves.toMatchObject({
      state: 'approved',
      stepState: 'approved',
    });
    const approved = await requestRow(created.id);
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual([
      'approved',
      'approved',
      'approved',
    ]);
    await expect(
      run(() => catalog.simulate(agent.auth, created.id, { expectedVersion: approved.version })),
    ).resolves.toMatchObject({ replayed: false });
    expect((await requestRow(created.id)).state).toBe('completed');
  }, 30_000);

  it('**他人宛てのステップは決定できない（approver ロールを持つ利用者も）**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await decide(fixed, created.id, 1);
    await expectDenied(decide(otherApprover, created.id, 2), [404, 403]);
    await expectDenied(decide(head, created.id, 2), [404, 403]);
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual(['approved', 'pending']);
  }, 30_000);

  it('**6項目-1: 決定者が現在のステップの approver_id と一致しなければ拒否する**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await decide(manager, created.id, 1);
    // 前の段の承認者(manager)は、現在の段(固定承認者)の決定者ではない。
    await expectProblem(decide(manager, created.id, 2), 403);
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual(['approved', 'pending']);
  }, 30_000);

  it('**6項目-2: 決定者が有効な所属でなければ拒否する（停止・role_binding 期限切れ）**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();

    const deactivated = await createRequest(requester, itemId);
    await q("UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1", [
      manager.id,
    ]);
    await expectProblem(decide(manager, deactivated.id, 1), 403);
    expect((await requestRow(deactivated.id)).state).toBe('pending');

    // 2件目は停止を戻してから作る(申請時の解決で承認者が有効である必要がある)。
    await q("UPDATE app_user SET status='active', deactivated_at=NULL WHERE id=$1", [manager.id]);
    const expired = await createRequest(requester, itemId);
    await q(
      `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
        WHERE organization_id=$1 AND user_id=$2`,
      [org, manager.id],
    );
    await expectProblem(decide(manager, expired.id, 1), 403);
    expect((await requestRow(expired.id)).state).toBe('pending');
  }, 30_000);

  it('**6項目-3: 申請者本人は決定できない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    // 経路と承認行を直接申請者へ差し替える(自己承認の検査だけを分離する)。
    await forceStep(created.id, { approverId: requester.id, authorityType: 'fixed' });
    await expectProblem(decide(requester, created.id, 1), 403, ['自己承認']);
    expect((await stepRows(created.id))[0]!.state).toBe('pending');
  }, 30_000);

  it('**6項目-4: pending・期限内・現在の経路世代でなければ拒否する**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();

    const expired = await createRequest(requester, itemId);
    await q(
      "UPDATE local_request_approval SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",
      [expired.id],
    );
    await expectProblem(decide(manager, expired.id, 1), 409);

    const decided = await createRequest(requester, itemId);
    await decide(manager, decided.id, 1);
    await expectProblem(decide(manager, decided.id, 2), 409);

    const oldGeneration = await createRequest(requester, itemId);
    await q('UPDATE local_request_revision SET route_generation=2 WHERE request_id=$1', [
      oldGeneration.id,
    ]);
    await expectDenied(decide(manager, oldGeneration.id, 1), [404, 409]);
  }, 30_000);

  it('**6項目-5: revision / snapshot_hash / route_hash が一致しなければ拒否する**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();

    const snapshotTampered = await createRequest(requester, itemId);
    await q("UPDATE local_request_approval SET snapshot_hash=repeat('0',64) WHERE request_id=$1", [
      snapshotTampered.id,
    ]);
    await expectProblem(decide(manager, snapshotTampered.id, 1), 409);

    const routeTampered = await createRequest(requester, itemId);
    await q("UPDATE local_request_revision SET route_hash=repeat('0',64) WHERE request_id=$1", [
      routeTampered.id,
    ]);
    await expectProblem(decide(manager, routeTampered.id, 1), 409);
  }, 30_000);

  it('**6項目-6: fixed / legacy は approver ロールを要求する（行を直接書き換えても拒否）**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const fixedRequest = await createRequest(requester, itemId);
    await forceStep(fixedRequest.id, { approverId: manager.id, authorityType: 'fixed' });
    // manager は有効な所属だが approver ロールを持たない。
    await expectProblem(decide(manager, fixedRequest.id, 1), 403);
    expect((await stepRows(fixedRequest.id))[0]!.state).toBe('pending');

    const legacyItem = await publishItem({ approverId: fixed.id });
    const legacyRequest = await createRequest(requester, legacyItem, { approverId: fixed.id });
    await forceStep(legacyRequest.id, { approverId: manager.id, authorityType: 'legacy' });
    await expectProblem(decide(manager, legacyRequest.id, 1), 403);
    expect((await stepRows(legacyRequest.id))[0]!.state).toBe('pending');
  }, 30_000);

  it('**上長が変わっても、新しい上長は進行中の申請を決定できず、元の上長は決定できる**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    const before = await revisionRow(created.id);
    await setManager(requester.id, head.id);
    // 経路は申請時に固定されている。
    expect((await revisionRow(created.id)).route).toEqual(before.route);
    await expectDenied(decide(head, created.id, 1), [404, 403]);
    await expect(decide(manager, created.id, 1)).resolves.toMatchObject({ state: 'approved' });
  }, 30_000);

  it('**承認者の role_binding が期限切れ・停止なら決定できず、一覧で承認者不在になり、自動で差し替わらない**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();

    const deactivated = await createRequest(requester, itemId);
    await q("UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1", [
      manager.id,
    ]);
    await expectProblem(decide(manager, deactivated.id, 1), 403);
    const ownList = await listFor(requester);
    expect(ownList.items.find((item) => item.id === deactivated.id)).toMatchObject({
      state: 'pending',
      approverUnavailable: true,
    });
    const adminList = await listFor(adminUser, { approverUnavailable: '1' });
    expect(adminList.items.map((item) => item.id)).toContain(deactivated.id);
    // 絞り込みは組織管理者だけ。
    await expectProblem(listFor(requester, { approverUnavailable: '1' }), 403);
    // 状態も承認者も変わらない。
    const unchanged = await requestRow(deactivated.id);
    expect(unchanged.state).toBe('pending');
    expect((await stepRows(deactivated.id))[0]).toMatchObject({
      state: 'pending',
      approver_id: manager.id,
    });

    // 2件目は停止を戻してから作り、role_binding の期限切れだけを試す。
    await q("UPDATE app_user SET status='active', deactivated_at=NULL WHERE id=$1", [manager.id]);
    const expired = await createRequest(requester, itemId);
    await q(
      `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
        WHERE organization_id=$1 AND user_id=$2`,
      [org, manager.id],
    );
    await expectProblem(decide(manager, expired.id, 1), 403);
    const expiredList = await listFor(adminUser, { approverUnavailable: '1' });
    expect(expiredList.items.map((item) => item.id)).toContain(expired.id);
  }, 30_000);
});

describe('滞留の扱い: 申請内容の変更で経路を解決し直す (WP §6.1)', () => {
  it('**承認者不在の申請は、申請者が内容を変更すると新しい版で現在のデータから解決し直される**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await q("UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1", [
      manager.id,
    ]);

    const unavailable = await listFor(requester);
    const item = unavailable.items.find((entry) => entry.id === created.id)!;
    expect(item).toMatchObject({ state: 'pending', approverUnavailable: true });
    expect(item.nextAction).toContain('内容を変更');
    // 一覧の案内は申請者・担当者にだけ出す(理由の詳細や役職は返さない)。
    expect(JSON.stringify(item)).not.toContain('deactivated');

    // 上長を有効な利用者へ変え、申請者が内容を変更する。
    await setManager(requester.id, head.id);
    await run(() =>
      catalog.edit(requester.auth, created.id, {
        expectedVersion: 1,
        reason: '合成: 承認者不在のため内容を変更',
        durationDays: 7,
      }),
    );
    const request = await requestRow(created.id);
    expect(request.revision).toBe(2);
    expect(request.state).toBe('pending');
    const nextRevision = await revisionRow(created.id, 2);
    expect((nextRevision.route as ApprovalRoute).steps).toEqual([
      { stepNo: 1, approverId: head.id, authorityType: 'manager', resolvedFrom: 'manager' },
    ]);
    expect((await stepRows(created.id, 1)).map((step) => step.state)).toEqual(['invalidated']);
    expect(
      (await stepRows(created.id, 2)).map((step) => [step.step_no, step.state, step.approver_id]),
    ).toEqual([[1, 'pending', head.id]]);

    const recovered = await listFor(requester);
    expect(recovered.items.find((entry) => entry.id === created.id)!.approverUnavailable).toBe(
      false,
    );
    await expect(decide(head, created.id, 2)).resolves.toMatchObject({ state: 'approved' });
  }, 30_000);
});

describe('承認待ち一覧の可視性 (WP §6-5 / ADR-0023 §5)', () => {
  it('**approver ロールの無い上長に自分宛てが出る。approver ロールがあっても自分宛てでない申請は出ない**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await decide(fixed, created.id, 1);

    const managerList = await listFor(manager, { view: 'approvals' });
    expect(managerList.items.map((item) => item.id)).toEqual([created.id]);
    expect(managerList.items[0]).toMatchObject({ assigned: true, own: false });

    // approver ロールを持つが、自分宛てではない。
    const otherList = await listFor(otherApprover, { view: 'approvals' });
    expect(otherList.items.map((item) => item.id)).not.toContain(created.id);
    // 申請者本人の承認待ちにも出ない。
    const requesterList = await listFor(requester, { view: 'approvals' });
    expect(requesterList.items.map((item) => item.id)).not.toContain(created.id);
  }, 30_000);

  it('**他人の申請IDを指定した決定・閲覧は404**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await expectProblem(detailFor(otherApprover, created.id), 404);
    await expectProblem(decide(otherApprover, created.id, 1), 404);
    await expect(detailFor(requester, created.id)).resolves.toMatchObject({
      request: { id: created.id },
    });
  }, 30_000);

  it('**受信箱の承認待ちも「自分が現在のステップの承認者」で判定する**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    const inbox = new InboxController(pool, true);
    const managerInbox = await run(() => inbox.list(manager.auth, { kind: 'approval' }));
    expect(managerInbox.items.map((item) => item.id)).toContain(created.id);
    // approver ロールを持っていても、自分宛てでなければ出ない。
    const otherInbox = await run(() => inbox.list(otherApprover.auth, { kind: 'approval' }));
    expect(otherInbox.items.map((item) => item.id)).not.toContain(created.id);
    // どのロールも持たず、承認者でもない利用者は受信箱を開けない。
    await expectProblem(
      run(() => inbox.list(requester.auth, { kind: 'approval' })),
      403,
    );
  }, 30_000);
});

describe('申請者自身の経路の確認 API (WP-P4-APR-016 §6.1)', () => {
  const routeFor = (person: Person, itemId: string) =>
    run(() => catalog.approvalRoute(person.auth, itemId));

  it('**本人を申請者として、段の順に種別と表示名だけを返す**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const route = await routeFor(requester, itemId);
    expect(route).toMatchObject({
      itemId,
      itemVersion: 1,
      resolved: true,
      mode: 'rule',
      ruleRoutingEnabled: true,
      rule: { id: ruleId, revision: 1 },
      steps: [
        { stepNo: 1, authorityType: 'manager', approverName: 'WP015 manager' },
        { stepNo: 2, authorityType: 'fixed', approverName: 'WP015 fixed' },
      ],
    });
    // 個人データ・内部IDを返さない。承認者は表示名だけ。
    const json = JSON.stringify(route);
    for (const key of ['approverId', 'requesterId', 'email', 'jobTitle', 'location', 'employeeId'])
      expect(json).not.toContain(`"${key}"`);
  });

  it('**申請者IDを送っても本人の経路のまま(他人の経路を調べられない)**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const own = await routeFor(requester, itemId);
    // 経路はリクエスト本文・クエリを受け取らない。余分な入力を渡しても同じ結果になる。
    const extra = await run(() =>
      (
        catalog.approvalRoute as unknown as (
          auth: AuthenticatedRequest,
          id: string,
          input?: unknown,
        ) => Promise<Record<string, unknown>>
      )(requester.auth, itemId, { requesterId: manager.id }),
    );
    expect(extra).toEqual(own);
    // 上長本人を申請者にすると、上長は未設定なので別の結果になる。
    const asManager = await routeFor(manager, itemId);
    expect(asManager.resolved).toBe(false);
    expect(asManager.reason).toMatchObject({ code: 'manager_unset', missing: 'manager' });
  });

  it('**公開条件外・他組織の項目は404**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await q('UPDATE local_catalog_item SET active=false WHERE id=$1', [itemId]);
    await expectProblem(routeFor(requester, itemId), 404);

    const otherOrg = randomUUID();
    const otherItem = randomUUID();
    made.orgs.push(otherOrg);
    try {
      await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
        otherOrg,
        `wp015-route-read-${SUFFIX}`,
        'WP015 経路確認 (合成)',
      ]);
      await q(
        `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,active)
         VALUES($1,$2,$3,1,'合成 他組織','合成',$4,true)`,
        [otherItem, otherOrg, `wp015-route-read-${SUFFIX}`, definition({})],
      );
      await expectProblem(routeFor(requester, otherItem), 404);
    } finally {
      await q('DELETE FROM local_catalog_item WHERE organization_id=$1', [otherOrg]);
      await cleanAuditData(admin, `organization_id = '${otherOrg}'`);
      await q('DELETE FROM organization WHERE id=$1', [otherOrg]);
      made.orgs = made.orgs.filter((id) => id !== otherOrg);
    }
  });

  it('**何も書き込まず、監査イベントも書かない**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const tables = [
      'local_catalog_item',
      'local_catalog_revision',
      'local_service_request',
      'local_request_revision',
      'local_request_approval',
      'audit_event',
    ] as const;
    const count = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            (await q(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`, [org]))
              .rows[0].n as number,
          ]),
        ),
      );
    const before = await count();
    await routeFor(requester, itemId);
    await routeFor(manager, itemId);
    await routeFor(agent, itemId);
    expect(await count()).toEqual(before);
  });

  it('**解決できない理由(足りない設定の種別と利用者向けの文)を返す**', async () => {
    const ruleId = await createRule([managerStep('reject')]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await setManager(requester.id, null);
    const route = await routeFor(requester, itemId);
    expect(route).toMatchObject({
      resolved: false,
      mode: 'rule',
      steps: [],
      rule: { id: ruleId, revision: 1 },
      reason: { code: 'manager_unset', missing: 'manager', stepNo: 1 },
    });
    expect(String(route.reason?.message)).toContain('上長');
  });

  it('**ルールを使わない項目は従来の方式を返し、候補を増やさない**', async () => {
    const fixedItem = await publishItem({ approverId: fixed.id });
    await expect(routeFor(requester, fixedItem)).resolves.toMatchObject({
      resolved: true,
      mode: 'fixed',
      ruleRoutingEnabled: false,
      rule: null,
      steps: [{ stepNo: 1, authorityType: 'fixed', approverName: 'WP015 fixed' }],
    });
    const selectedItem = uuidv7();
    const { approval: _approval, ...definitionWithoutApproval } = definition({});
    await q(
      `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,active)
       VALUES($1,$2,$3,1,'合成 直接投入','合成',$4,true)`,
      [selectedItem, org, `wp015-route-direct-${SUFFIX}-${++sequence}`, definitionWithoutApproval],
    );
    await expect(routeFor(requester, selectedItem)).resolves.toMatchObject({
      resolved: false,
      mode: 'requester_selected',
      rule: null,
      steps: [],
    });
  });

  it('**詳細は版に固定した全段(未作成を含む)を返す**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixed.id)]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    const details = await detailFor(requester, created.id);
    expect(details.route).toMatchObject({
      ruleRef: { ruleId, revision: 1 },
      steps: [
        { stepNo: 1, authorityType: 'manager', approverName: 'WP015 manager' },
        { stepNo: 2, authorityType: 'fixed', approverName: 'WP015 fixed' },
      ],
    });
    expect(details.steps).toHaveLength(1);
  });

  it('**承認者不在の詳細は、申請者本人にだけ approverUnavailable を返す**', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    const created = await createRequest(requester, itemId);
    await q("UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1", [
      manager.id,
    ]);
    const own = await detailFor(requester, created.id);
    expect(own.approverUnavailable).toBe(true);
    // 担当者(閲覧はできる)には、申請者向けの不在の案内を返さない。
    const staff = await detailFor(agent, created.id);
    expect(staff.approverUnavailable).toBe(false);
    await q("UPDATE app_user SET status='active', deactivated_at=NULL WHERE id=$1", [manager.id]);
  });

  it('**組織でルールを使っていない間は、ルール付きの項目でも従来の方式を返す**', async () => {
    const ruleId = await createRule([fixedStep(fixed.id), managerStep()]);
    const itemId = await publishItem({ ruleId, approverId: fixed.id });
    const route = await routeFor(requester, itemId);
    expect(route).toMatchObject({
      resolved: true,
      mode: 'fixed',
      ruleRoutingEnabled: false,
      rule: null,
      steps: [{ stepNo: 1, authorityType: 'fixed', approverName: 'WP015 fixed' }],
    });
  });
});

describe('申請者自身の経路の確認 API: 無効なルール (WP-P4-APR-016 §6.1)', () => {
  it('**組織で有効でも、ルールを無効化した項目は解決できない理由を返す**', async () => {
    const ruleId = await createRule([managerStep('reject')]);
    const itemId = await publishItem({ ruleId });
    await enableRouting();
    await run(() => rules.deactivate(adminUser.auth, ruleId));
    const route = await run(() => catalog.approvalRoute(requester.auth, itemId));
    expect(route).toMatchObject({
      resolved: false,
      mode: 'rule',
      ruleRoutingEnabled: true,
      rule: null,
      steps: [],
      reason: { code: 'rule_unavailable', missing: 'rule' },
    });
  });
});
