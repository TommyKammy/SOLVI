/**
 * WP-P4-APR-018 段階A: 承認者不在の申請の再割当(TL-02 / TL-04 / TL-06 / TL-16)。
 *
 * - 再割当は org_admin だけ。申請者本人は org_admin でも拒否する。
 * - 現在の pending ステップの承認者が承認者不在のときだけ実行できる。
 * - 経路は追記専用の世代に保存し、版の行は1バイトも変えない。
 * - 承認済みステップは保持し、新しい承認者は現時点の組織データから解決する。
 * - 実行前検証は段ごとの有効な世代を見て、世代の欠落・改ざんを fail closed で拒否する。
 *
 * 実行先は使い捨てDB(名前に `wp018` と `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLogger, newContext, runWithContext } from '@solvi/shared';
import { HttpServer } from '../../services/api/src/common/http/server.js';
import { AuthController } from '../../services/api/src/modules/auth/auth.routes.js';
import type { ApprovalRuleStep } from '@solvi/shared/catalog';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import {
  routeHash,
  type ApprovalRoute,
  type ApprovalStepRow,
} from '../../services/api/src/modules/catalog/approval-state.js';
import { checkApprovalComplete } from '../../services/api/src/modules/catalog/approval-assertion.js';
import { hash } from '../../services/api/src/modules/catalog/snapshot-hash.js';
import { ApprovalRuleController } from '../../services/api/src/modules/catalog/approval-rule.routes.js';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData } from '../support/cleanup.js';

const ROOT = join(__dirname, '../..');
const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);

let pool: pg.Pool;
let admin: pg.Client;
let rules: ApprovalRuleController;
let catalogAdmin: CatalogAdminController;
let catalog: CatalogController;

let org: string;
let otherOrg: string;
let deptRoot: string;
let deptPrimary: string;

type Person = { id: string; auth: AuthenticatedRequest };
let adminUser: Person;
let adminRequester: Person;
let requester: Person;
let manager: Person;
let manager2: Person;
let manager3: Person;
let head: Person;
let fixedA: Person;
let fixedB: Person;
let agent: Person;
let auditor: Person;
let editor: Person;
let platform: Person;

let otherUser: string;
let otherItemId: string;
let otherRequestId: string;
let otherApprovalId: string;

const made = { users: [] as string[], orgs: [] as string[] };
let sequence = 0;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

function authFor(userId: string, roles: RoleCode[]): AuthenticatedRequest {
  return {
    userId,
    sessionId: `wp018-reassign-${userId.slice(0, 8)}`,
    authz: {
      organizationId: org,
      principal: {
        userId,
        status: 'active',
        bindings: roles.map((roleCode) => ({
          roleCode,
          organizationId: roleCode === 'platform_admin' ? null : org,
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
    [id, `wp018-reassign-${label}-${id.slice(0, 8)}@example.test`, `WP018 ${label}`],
  );
  made.users.push(id);
  for (const role of roles)
    await q(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = $4), $4, $5, 'manual', $6, NULL)`,
      [
        randomUUID(),
        id,
        role,
        role === 'platform_admin' ? 'platform' : 'org',
        role === 'platform_admin' ? null : org,
        PAST,
      ],
    );
  await q('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [org, id]);
  return { id, auth: authFor(id, roles) };
}

async function makeDepartment(label: string, parentId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1,$2,$3,$4,$5)`,
    [id, org, `wp018-reassign-${label}-${SUFFIX}`, `WP018 ${label} (合成)`, parentId],
  );
  return id;
}

async function setManager(userId: string, managerUserId: string | null): Promise<void> {
  await q(
    'UPDATE org_member_profile SET manager_user_id=$3 WHERE organization_id=$1 AND user_id=$2',
    [org, userId, managerUserId],
  );
}

/**
 * DBは「自分自身を上長にする」更新を CHECK 制約とトリガで拒否する。
 * 解決器の自己承認拒否を検査するため、テストDBの管理者接続で制約とトリガを
 * 一時的に外し、検査後に元へ戻す。本番でこの経路は存在しない。
 */
async function setSelfManagerForTest(): Promise<() => Promise<void>> {
  await admin.query(
    'ALTER TABLE org_member_profile DROP CONSTRAINT org_member_profile_no_self_manager',
  );
  await admin.query(
    'ALTER TABLE org_member_profile DISABLE TRIGGER org_member_profile_check_manager',
  );
  try {
    await setManager(requester.id, requester.id);
  } catch (error) {
    await admin
      .query('ALTER TABLE org_member_profile ENABLE TRIGGER org_member_profile_check_manager')
      .catch(() => undefined);
    await admin
      .query(
        `ALTER TABLE org_member_profile ADD CONSTRAINT org_member_profile_no_self_manager
         CHECK (manager_user_id IS NULL OR manager_user_id <> user_id)`,
      )
      .catch(() => undefined);
    throw error;
  }
  return async () => {
    await setManager(requester.id, null).catch(() => undefined);
    await admin.query(
      'ALTER TABLE org_member_profile ENABLE TRIGGER org_member_profile_check_manager',
    );
    await admin.query(
      `ALTER TABLE org_member_profile ADD CONSTRAINT org_member_profile_no_self_manager
       CHECK (manager_user_id IS NULL OR manager_user_id <> user_id)`,
    );
  };
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
): Promise<Error & { status?: number; errors?: unknown }> {
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
  return caught!;
}

const nextCode = () => `reassign-${SUFFIX}-${++sequence}`;

const fixedStep = (approverId: string) => ({ type: 'fixed' as const, approverId });
const managerStep = (onUnresolved: 'department_head' | 'reject' = 'reject') => ({
  type: 'manager' as const,
  onUnresolved,
});

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
      code: `wp018-reassign-item-${SUFFIX}-${++sequence}`,
      title: '合成 再割当',
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

async function enableRouting(enabled = true): Promise<void> {
  await run(() => rules.updateSettings(adminUser.auth, { enabled }));
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
      reason: '合成: 再割当',
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

const reassign = (person: Person, id: string, reason = '合成: 承認者不在の再割当') =>
  run(() => catalog.reassign(person.auth, id, { reason }));

const detailFor = (person: Person, id: string) => run(() => catalog.detail(person.auth, id));

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
      `SELECT * FROM local_request_approval
        WHERE request_id=$1 AND revision=$2
        ORDER BY route_generation,step_no,id`,
      [id, revision],
    )
  ).rows as ApprovalStepRow[];
const generationRows = async (id: string, revision = 1) =>
  (
    await q(
      `SELECT * FROM local_request_route_generation
        WHERE request_id=$1 AND revision=$2 ORDER BY route_generation`,
      [id, revision],
    )
  ).rows;

async function expireBinding(userId: string): Promise<void> {
  await q(
    `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
      WHERE organization_id=$1 AND user_id=$2 AND valid_until IS NULL`,
    [org, userId],
  );
}

async function countsFor(requestId: string) {
  return {
    steps: (
      await q('SELECT count(*)::int AS n FROM local_request_approval WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0].n as number,
    generations: (
      await q('SELECT count(*)::int AS n FROM local_request_route_generation WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0].n as number,
    audits: (await q('SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1', [requestId]))
      .rows[0].n as number,
  };
}

async function checkComplete(requestId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
    const result = await checkApprovalComplete(client, { organizationId: org, requestId });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function withFailingAudit(eventType: string, fn: () => Promise<void>): Promise<void> {
  await admin.query(
    `CREATE OR REPLACE FUNCTION wp018_reassign_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN
       IF NEW.event_type = '${eventType}' THEN
         RAISE EXCEPTION 'wp018_reassign_forced_audit_failure';
       END IF;
       RETURN NEW;
     END $f$`,
  );
  await admin.query(
    `CREATE TRIGGER wp018_reassign_fail_audit BEFORE INSERT ON audit_event
       FOR EACH ROW EXECUTE FUNCTION wp018_reassign_fail_audit()`,
  );
  try {
    await fn();
  } finally {
    await admin.query('DROP TRIGGER wp018_reassign_fail_audit ON audit_event');
    await admin.query('DROP FUNCTION wp018_reassign_fail_audit()');
  }
}

/**
 * 追記専用トリガを検査のためだけに外して、世代の行を直接改変する。
 * 本番でこの経路は存在しない。テストDBの管理者接続だけを使う。
 */
async function tamperGenerations(
  requestId: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await admin.query(
    'ALTER TABLE local_request_route_generation DISABLE TRIGGER local_request_route_generation_immutable',
  );
  try {
    await q(sql, params);
  } finally {
    await admin.query(
      'ALTER TABLE local_request_route_generation ENABLE TRIGGER local_request_route_generation_immutable',
    );
  }
}

/** 2段(固定→上長)の経路で、1段目を承認済みにし、2段目の上長を不在にする。 */
async function reassignableRequest(options: { managerPerson?: Person } = {}) {
  const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
  const itemId = await publishItem({ ruleId });
  const created = await createRequest(requester, itemId);
  await decide(fixedA, created.id, 1, 'approve');
  const firstManager = options.managerPerson ?? manager;
  if (firstManager !== manager) await setManager(requester.id, firstManager.id);
  await expireBinding(firstManager.id);
  return { requestId: created.id, ruleId, itemId };
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
  // 世代 → 承認行 → 版 → 申請の順。世代のトリガは検査のために一時的に外す。
  await admin.query(
    'ALTER TABLE local_request_route_generation DISABLE TRIGGER local_request_route_generation_immutable',
  );
  try {
    await q('DELETE FROM local_request_route_generation WHERE organization_id=$1', [org]);
  } finally {
    await admin.query(
      'ALTER TABLE local_request_route_generation ENABLE TRIGGER local_request_route_generation_immutable',
    );
  }
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
  await q(
    `UPDATE role_binding SET valid_until=NULL
      WHERE organization_id=$1 AND user_id = ANY($2::uuid[])`,
    [org, made.users],
  );
  for (const person of [
    requester,
    manager,
    manager2,
    manager3,
    head,
    fixedA,
    fixedB,
    agent,
    adminRequester,
  ])
    await setDepartment(person.id, deptPrimary);
  await setManager(requester.id, manager.id);
  await setManager(manager.id, head.id);
  await setManager(adminRequester.id, manager.id);
}

function migrate(...args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync('node', ['tools/migrate.mjs', ...args], {
      cwd: ROOT,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

async function clearAllGenerations(): Promise<void> {
  await admin.query(
    'ALTER TABLE local_request_route_generation DISABLE TRIGGER local_request_route_generation_immutable',
  );
  try {
    await admin.query('DELETE FROM local_request_route_generation');
  } finally {
    await admin.query(
      'ALTER TABLE local_request_route_generation ENABLE TRIGGER local_request_route_generation_immutable',
    );
  }
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
    if (!name.includes('wp018') || !name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は wp018 の使い捨てDBではありません。中止します`);
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
    `wp018-reassign-${SUFFIX}`,
    'WP018 再割当 (合成)',
  ]);
  deptRoot = await makeDepartment('root', null);
  deptPrimary = await makeDepartment('primary', deptRoot);

  adminUser = await makeUser('admin', ['org_admin']);
  adminRequester = await makeUser('admin-requester', ['org_admin', 'requester']);
  requester = await makeUser('requester', ['requester']);
  manager = await makeUser('manager', ['requester']);
  manager2 = await makeUser('manager2', ['requester']);
  manager3 = await makeUser('manager3', ['requester']);
  head = await makeUser('head', ['requester']);
  fixedA = await makeUser('fixed-a', ['approver']);
  fixedB = await makeUser('fixed-b', ['approver']);
  agent = await makeUser('agent', ['agent']);
  auditor = await makeUser('auditor', ['auditor']);
  editor = await makeUser('editor', ['catalog_editor']);
  platform = await makeUser('platform', ['platform_admin']);
  await assignHead(deptPrimary, head.id);
  await resetProfiles();

  // 他組織の申請(404 と RLS の検査用)。合成データだけを使う。
  otherOrg = randomUUID();
  made.orgs.push(otherOrg);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    otherOrg,
    `wp018-other-${SUFFIX}`,
    'WP018 他組織 (合成)',
  ]);
  otherUser = randomUUID();
  made.users.push(otherUser);
  await q(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1,$2,$3,'active','admin')`,
    [otherUser, `wp018-other-${otherUser.slice(0, 8)}@example.test`, 'WP018 他組織利用者'],
  );
  await q(
    `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source,valid_from,valid_until)
     VALUES($1,$2,(SELECT id FROM role WHERE code='requester' AND scope='org'),'org',$3,'manual',$4,NULL)`,
    [randomUUID(), otherUser, otherOrg, PAST],
  );
  await q('INSERT INTO org_member_profile(organization_id,user_id) VALUES($1,$2)', [
    otherOrg,
    otherUser,
  ]);
  otherItemId = uuidv7();
  const otherSnapshot = {
    item: {
      id: otherItemId,
      version: 1,
      title: '他組織の合成申請',
      definition: definition({ approverId: otherUser }),
    },
    inputs: { reason: '合成', durationDays: 7 },
    requesterId: otherUser,
  };
  const otherSnapshotHash = hash(otherSnapshot);
  await q(
    `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,active)
     VALUES($1,$2,$3,1,'他組織の合成申請','合成',$4,true)`,
    [otherItemId, otherOrg, `wp018-other-item-${SUFFIX}`, definition({ approverId: otherUser })],
  );
  const otherTicketId = uuidv7();
  await q(
    `INSERT INTO ticket(id,organization_id,number,kind,state,subject,body,requester_id,impact,urgency,priority)
     VALUES($1,$2,$3,'request','new','他組織の合成申請','合成',$4,'low','low','low')`,
    [
      otherTicketId,
      otherOrg,
      `REQ-2026-9${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
      otherUser,
    ],
  );
  otherRequestId = uuidv7();
  otherApprovalId = uuidv7();
  await admin.query('BEGIN');
  try {
    await q(
      `INSERT INTO local_service_request(id,organization_id,item_id,requester_id,ticket_id,idempotency_key,version,revision,state,snapshot,snapshot_hash,current_approval_id)
       VALUES($1,$2,$3,$4,$5,$6,1,1,'pending',$7,$8,$9)`,
      [
        otherRequestId,
        otherOrg,
        otherItemId,
        otherUser,
        otherTicketId,
        uuidv7(),
        otherSnapshot,
        otherSnapshotHash,
        otherApprovalId,
      ],
    );
    await q(
      `INSERT INTO local_request_revision(request_id,organization_id,revision,snapshot,snapshot_hash,changed_by)
       VALUES($1,$2,1,$3,$4,$5)`,
      [otherRequestId, otherOrg, otherSnapshot, otherSnapshotHash, otherUser],
    );
    await q(
      `INSERT INTO local_request_approval(id,organization_id,request_id,revision,snapshot_hash,approver_id,state,expires_at)
       VALUES($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '72 hours')`,
      [otherApprovalId, otherOrg, otherRequestId, otherSnapshotHash, otherUser],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanOrgData();
      await clearAllGenerations();
      await admin.query('BEGIN');
      try {
        await q('DELETE FROM local_request_approval WHERE organization_id=$1', [otherOrg]);
        await q('DELETE FROM local_request_revision WHERE organization_id=$1', [otherOrg]);
        await q('DELETE FROM local_service_request WHERE organization_id=$1', [otherOrg]);
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      await q('DELETE FROM local_catalog_item WHERE organization_id=$1', [otherOrg]);
      await q('DELETE FROM ticket WHERE organization_id=$1', [otherOrg]);
      await q('DELETE FROM department_head WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
      await q('DELETE FROM org_member_profile WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
      await q('DELETE FROM org_member_profile WHERE user_id=ANY($1::uuid[])', [made.users]);
      await q('DELETE FROM role_binding WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
      await q('DELETE FROM role_binding WHERE user_id=ANY($1::uuid[])', [made.users]);
      await q('DELETE FROM app_user WHERE id=ANY($1::uuid[])', [made.users]);
      for (const id of made.orgs) await cleanAuditData(admin, `organization_id = '${id}'`);
      await q('UPDATE department SET parent_id=NULL WHERE organization_id=$1', [org]);
      await q('DELETE FROM department WHERE organization_id=$1', [org]);
      await q('DELETE FROM organization WHERE id=ANY($1::uuid[])', [made.orgs]);
    } finally {
      await admin.end();
    }
  }
  await pool?.end();
});

beforeEach(async () => {
  if (!admin) return;
  await cleanOrgData();
  await clearAllGenerations();
  await resetProfiles();
  await enableRouting(true);
});

describe('Migration 0040: 経路世代の表 (TL-04)', () => {
  it('行が無ければ down → up の往復ができる(最後のMigrationであることを仮定しない)', async () => {
    expect(
      (await q('SELECT count(*)::int AS n FROM local_request_route_generation')).rows[0].n,
    ).toBe(0);
    const down = migrate('down', '--to', '0039');
    expect(down.ok, down.output).toBe(true);
    expect(down.output).toContain('0040_local_request_route_generation.sql');
    const tableGone = (
      await q(
        `SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname='public' AND tablename='local_request_route_generation'`,
      )
    ).rows[0].n;
    expect(tableGone).toBe(0);
    const up = migrate('up');
    expect(up.ok, up.output).toBe(true);
  }, 120_000);

  it('行が1件でもあれば down を拒否する(前進修復)', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    await reassign(adminUser, requestId);
    const down = migrate('down', '--to', '0039');
    expect(down.ok).toBe(false);
    expect(down.output).toContain('0040 rollback refused');
    expect((await q(`SELECT 1 FROM schema_migration WHERE version='0040'`)).rowCount).toBe(1);
    expect(await generationRows(requestId)).toHaveLength(1);
  }, 120_000);
});

describe('再割当の成功 (WP §7: 承認済みステップの保持・新しい承認者の決定)', () => {
  it('**2段の経路で1段目承認済み・2段目承認者不在 → 再割当 → 新しい承認者が承認 → assertApprovalComplete が成功する**', async () => {
    const { requestId } = await reassignableRequest();
    const revisionBefore = await revisionRow(requestId);
    const stepsBefore = await stepRows(requestId);
    expect(stepsBefore.map((step) => [step.route_generation, step.step_no, step.state])).toEqual([
      [1, 1, 'approved'],
      [1, 2, 'pending'],
    ]);
    const approvedStepBefore = stepsBefore.find((step) => step.step_no === 1)!;

    // 申請後に上長を変えても、経路は変わらない(再割当以外に経路を変える経路が無い)。
    await setManager(requester.id, manager2.id);
    expect((await revisionRow(requestId)).route).toEqual(revisionBefore.route);
    expect(await generationRows(requestId)).toHaveLength(0);

    const response = await reassign(adminUser, requestId, '合成: 上長の異動で承認者が不在');
    expect(response).toMatchObject({
      id: requestId,
      routeGeneration: 2,
      fromStepNo: 2,
      stepNo: 2,
      approverId: manager2.id,
      invalidatedApprovalId: stepsBefore.find((step) => step.step_no === 2)!.id,
    });

    // 版の行は全列同じ。
    expect(await revisionRow(requestId)).toEqual(revisionBefore);
    // 承認済みステップの行も全列同じ(複製もしない)。
    const approvedStepAfter = (await stepRows(requestId)).find((step) => step.step_no === 1)!;
    expect(approvedStepAfter).toEqual(approvedStepBefore);

    const stepsAfter = await stepRows(requestId);
    expect(stepsAfter.map((step) => [step.route_generation, step.step_no, step.state])).toEqual([
      [1, 1, 'approved'],
      [1, 2, 'invalidated'],
      [2, 2, 'pending'],
    ]);
    const newStep = stepsAfter.find((step) => step.route_generation === 2)!;
    expect(newStep.approver_id).toBe(manager2.id);
    expect(newStep.authority_type).toBe('manager');
    expect(newStep.expires_at.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);

    const generation = (await generationRows(requestId))[0]!;
    expect(generation).toMatchObject({
      route_generation: 2,
      from_step_no: 2,
      reason: '合成: 上長の異動で承認者が不在',
      created_by: adminUser.id,
    });
    const route = generation.route as ApprovalRoute;
    expect(route.ruleRef).toEqual({
      ruleId: (await revisionRow(requestId)).route.ruleRef?.ruleId,
      revision: 1,
    });
    expect(route.steps.map((step) => [step.stepNo, step.approverId])).toEqual([
      [1, fixedA.id],
      [2, manager2.id],
    ]);
    expect(generation.route_hash).toBe(routeHash(route));

    const events = (
      await q(
        `SELECT event_type, after_state FROM audit_event
          WHERE target_id=$1 AND event_type IN
            ('approval.reassigned','approval.invalidated','approval.requested')
          ORDER BY occurred_at, event_id`,
        [requestId],
      )
    ).rows;
    const reassignEvents = events.filter(
      (event) =>
        event.event_type === 'approval.reassigned' ||
        event.after_state?.cause === 'reassigned' ||
        (event.event_type === 'approval.requested' && event.after_state?.routeGeneration === 2),
    );
    expect(reassignEvents.map((event) => event.event_type)).toEqual([
      'approval.invalidated',
      'approval.reassigned',
      'approval.requested',
    ]);
    const reassigned = reassignEvents.find((event) => event.event_type === 'approval.reassigned')!;
    expect(reassigned.after_state).toMatchObject({
      revision: 1,
      fromRouteGeneration: 1,
      toRouteGeneration: 2,
      fromStepNo: 2,
      invalidatedApprovalId: stepsBefore.find((step) => step.step_no === 2)!.id,
      invalidatedApproverId: manager.id,
      newApproverId: manager2.id,
      reason: '合成: 上長の異動で承認者が不在',
    });
    expect(JSON.stringify(reassigned.after_state)).not.toContain('合成: 再割当');

    // 旧世代の承認者では決定できない。
    await expectProblem(decide(manager, requestId, 3, 'approve'), 403);
    // 新しい承認者は決定できる。
    const decided = await decide(manager2, requestId, 3, 'approve');
    expect(decided).toEqual({ id: requestId, state: 'approved', stepState: 'approved' });
    expect(await checkComplete(requestId)).toMatchObject({ ok: true });
    const complete = await checkComplete(requestId);
    expect(complete.ok && complete.steps.map((step) => step.approverId)).toEqual([
      fixedA.id,
      manager2.id,
    ]);
    expect((await requestRow(requestId)).state).toBe('approved');

    // 詳細には世代と再割当の記録が加算される(既存キーの意味は変えない)。
    const detail = await detailFor(requester, requestId);
    expect(detail.currentRouteGeneration).toBe(2);
    expect(
      detail.routeGenerations.map((item: { routeGeneration: number }) => item.routeGeneration),
    ).toEqual([1, 2]);
    expect(detail.routeGenerations[1]).toMatchObject({
      routeGeneration: 2,
      fromStepNo: 2,
      reason: '合成: 上長の異動で承認者が不在',
      createdBy: adminUser.id,
      createdByName: 'WP018 admin',
      // 画面が「無効になったステップ」と「新しい承認者」を出せること(加算的な項目)。
      invalidatedStepNo: 2,
      invalidatedApproverName: 'WP018 manager',
      newApproverName: 'WP018 manager2',
    });
    // 承認の経過は段ごとの有効な世代: 段1は旧世代の承認済み、段2は新しい世代。
    expect(
      detail.effectiveSteps.map((step: { stepNo: number; state: string; approverId: string }) => [
        step.stepNo,
        step.state,
        step.approverId,
      ]),
    ).toEqual([
      [1, 'approved', fixedA.id],
      [2, 'approved', manager2.id],
    ]);
    expect(
      detail.history.find(
        (row: { stepNo: number; routeGeneration: number }) =>
          row.stepNo === 1 && row.routeGeneration === 1,
      ),
    ).toMatchObject({ stepNo: 1, routeGeneration: 1, invalidatedByReassign: false });
    expect(
      detail.history.find(
        (row: { stepNo: number; routeGeneration: number }) =>
          row.stepNo === 2 && row.routeGeneration === 1,
      ),
    ).toMatchObject({ stepNo: 2, routeGeneration: 1, invalidatedByReassign: true });
    expect(detail.history.map((row: { routeGeneration: number }) => row.routeGeneration)).toEqual([
      1, 1, 2,
    ]);
  });

  it('**再割当をまたいで承認済みの申請を取り消せる(全世代のステップが無効になる)**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    await reassign(adminUser, requestId);
    await decide(manager2, requestId, 3, 'approve');
    expect((await requestRow(requestId)).state).toBe('approved');
    expect(await decide(adminUser, requestId, 4, 'revoke', '合成: 取消')).toEqual({
      id: requestId,
    });
    expect((await stepRows(requestId)).every((step) => step.state === 'invalidated')).toBe(true);
    expect((await requestRow(requestId)).state).toBe('invalidated');
    // 世代の行は監査・履歴として残る(版も書き換えない)。
    expect(await generationRows(requestId)).toHaveLength(1);
  });

  it('**1段目が承認者不在の再割当(from_step_no=1)と、続けて2回目の再割当(世代3)**', async () => {
    const ruleId = await createRule([managerStep(), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await expireBinding(manager.id);
    // 再割当は現時点のデータで解決する。1回目は manager2 に解決させる。
    await setManager(requester.id, manager2.id);

    const first = await reassign(adminUser, created.id);
    expect(first).toMatchObject({ routeGeneration: 2, fromStepNo: 1, approverId: manager2.id });
    // 2回目の前に上長を manager3 に変え、manager2 を不在にする。
    await setManager(requester.id, manager3.id);
    await expireBinding(manager2.id);
    const second = await reassign(adminUser, created.id);
    expect(second).toMatchObject({ routeGeneration: 3, fromStepNo: 1, approverId: manager3.id });

    const generations = await generationRows(created.id);
    expect(generations.map((row) => [row.route_generation, row.from_step_no])).toEqual([
      [2, 1],
      [3, 1],
    ]);
    const steps = await stepRows(created.id);
    expect(
      steps.map((step) => [step.route_generation, step.step_no, step.state, step.approver_id]),
    ).toEqual([
      [1, 1, 'invalidated', manager.id],
      [2, 1, 'invalidated', manager2.id],
      [3, 1, 'pending', manager3.id],
    ]);
    expect((await requestRow(created.id)).state).toBe('pending');
    expect(await checkComplete(created.id)).toMatchObject({ ok: false });

    // 1段目を manager3 が承認すると、次の段(固定B)は同じ世代3で作られる。
    expect(await decide(manager3, created.id, 3, 'approve')).toEqual({
      id: created.id,
      state: 'pending',
      stepState: 'approved',
    });
    const next = (await stepRows(created.id)).find(
      (step) => step.route_generation === 3 && step.step_no === 2,
    )!;
    expect(next).toMatchObject({ state: 'pending', approver_id: fixedB.id });
    expect(
      (
        await q(
          `SELECT after_state FROM audit_event
            WHERE target_id=$1 AND event_type='approval.requested'
            ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
          [created.id],
        )
      ).rows[0].after_state,
    ).toMatchObject({ routeGeneration: 3, stepNo: 2 });

    expect(await decide(fixedB, created.id, 4, 'approve')).toMatchObject({ state: 'approved' });
    expect(await checkComplete(created.id)).toMatchObject({ ok: true });

    // 詳細の再割当の記録は、世代ごとの無効になったステップと新しい承認者を返す。
    const detail = await detailFor(requester, created.id);
    expect(
      detail.routeGenerations.map(
        (item: {
          routeGeneration: number;
          invalidatedApproverName: string | null;
          newApproverName: string | null;
        }) => [item.routeGeneration, item.invalidatedApproverName, item.newApproverName],
      ),
    ).toEqual([
      [1, null, null],
      [2, 'WP018 manager', 'WP018 manager2'],
      [3, 'WP018 manager2', 'WP018 manager3'],
    ]);
  });
});

describe('再割当の条件外は 409 で、何も変えない (WP §7)', () => {
  it('**現在の承認者が有効なら 409**', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    const before = await countsFor(created.id);
    await expectProblem(reassign(adminUser, created.id), 409, ['有効', 'approver_available']);
    expect(await countsFor(created.id)).toEqual(before);
  });

  it('**期限切れは 409**', async () => {
    const { requestId } = await reassignableRequest();
    await q(
      `UPDATE local_request_approval SET expires_at=clock_timestamp()-interval '1 second'
        WHERE request_id=$1 AND state='pending'`,
      [requestId],
    );
    const before = await countsFor(requestId);
    await expectProblem(reassign(adminUser, requestId), 409, ['期限', 'expired']);
    expect(await countsFor(requestId)).toEqual(before);
  });

  it('**完了済みは 409**', async () => {
    const { requestId } = await reassignableRequest();
    await q("UPDATE local_service_request SET state='completed' WHERE id=$1", [requestId]);
    const before = await countsFor(requestId);
    await expectProblem(reassign(adminUser, requestId), 409, ['承認待ち', 'not_pending']);
    expect(await countsFor(requestId)).toEqual(before);
  });

  it('**却下済みは 409**', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    await decide(fixedB, created.id, 2, 'reject', '合成: 却下');
    const before = await countsFor(created.id);
    await expectProblem(reassign(adminUser, created.id), 409, ['承認待ち', 'not_pending']);
    expect(await countsFor(created.id)).toEqual(before);
  });

  it('**取消済みは 409**', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    await decide(adminUser, created.id, 2, 'revoke', '合成: 取消');
    const before = await countsFor(created.id);
    await expectProblem(reassign(adminUser, created.id), 409, ['承認待ち', 'not_pending']);
    expect(await countsFor(created.id)).toEqual(before);
  });

  it('**ルールを使わない経路(固定承認者)は 409**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const before = await countsFor(created.id);
    await expectProblem(reassign(adminUser, created.id), 409, [
      '承認ルールを使わない',
      'legacy_route',
    ]);
    expect(await countsFor(created.id)).toEqual(before);
  });
});

describe('認可: org_admin だけ (TL-06 / TL-16)', () => {
  it('**org_admin 以外のすべてのロールは 403。申請者本人の org_admin も 403**', async () => {
    const { requestId } = await reassignableRequest();
    const before = await countsFor(requestId);
    const denied: Array<[string, Person]> = [
      ['requester', requester],
      ['approver', fixedA],
      ['agent', agent],
      ['auditor', auditor],
      ['catalog_editor', editor],
      ['platform_admin', platform],
    ];
    for (const [label, person] of denied) {
      const caught = await expectProblem(reassign(person, requestId), 403);
      expect(caught.status, label).toBe(403);
    }
    // 申請者本人が org_admin でも拒否する。
    // 組織管理者の上長は常に未設定のため、固定2段のルールで申請を作る。
    const ownRule = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const ownItem = await publishItem({ ruleId: ownRule });
    const own = await createRequest(adminRequester, ownItem);
    const ownBefore = await countsFor(own.id);
    await expectProblem(reassign(adminRequester, own.id), 403, ['自分の申請']);
    expect(await countsFor(own.id)).toEqual(ownBefore);
    expect(await countsFor(requestId)).toEqual(before);
  });

  it('**他組織の申請IDと存在しないIDは 404(存在を漏らさない)**', async () => {
    await expectProblem(reassign(adminUser, otherRequestId), 404);
    await expectProblem(reassign(adminUser, randomUUID()), 404);
  });
});

describe('再解決の失敗は 409 で、何も変えない (WP §7)', () => {
  it.each([
    ['新しい上長が未設定', async () => setManager(requester.id, null), 'manager_unset'],
    [
      '承認済みの段の承認者と重複',
      async () => setManager(requester.id, fixedA.id),
      'duplicate_approver',
    ],
    [
      '新しい上長が無効な所属',
      async () => {
        await setManager(requester.id, manager3.id);
        await expireBinding(manager3.id);
      },
      'manager_inactive',
    ],
  ])('%s → 409 と理由コード', async (_name, mutate, code) => {
    const { requestId } = await reassignableRequest();
    await mutate();
    const before = await countsFor(requestId);
    const caught = await expectProblem(reassign(adminUser, requestId), 409, [code]);
    expect(JSON.stringify(caught.errors)).toContain(code);
    expect(await countsFor(requestId)).toEqual(before);
    expect((await stepRows(requestId)).filter((step) => step.route_generation === 2)).toHaveLength(
      0,
    );
    expect(await generationRows(requestId)).toHaveLength(0);
  });

  it('新しい上長が申請者本人 → 409 と理由コード(DB制約を検査用に外した状態)', async () => {
    const { requestId } = await reassignableRequest();
    const restore = await setSelfManagerForTest();
    try {
      const before = await countsFor(requestId);
      const caught = await expectProblem(reassign(adminUser, requestId), 409, ['manager_self']);
      expect(JSON.stringify(caught.errors)).toContain('manager_self');
      expect(await countsFor(requestId)).toEqual(before);
      expect(await generationRows(requestId)).toHaveLength(0);
    } finally {
      await restore();
    }
  });
});

describe('入力: 理由だけを受け取り、未知のキーを拒否する', () => {
  it.each([
    ['理由が空', { reason: '' }],
    ['理由が空白だけ', { reason: '   ' }],
    ['理由が長すぎる', { reason: 'a'.repeat(2001) }],
    ['理由が無い', {}],
    [
      '承認者IDを受け取らない',
      { reason: '合成', approverId: '99999999-9999-4999-8999-999999999999' },
    ],
    ['段番号を受け取らない', { reason: '合成', stepNo: 1 }],
    ['経路を受け取らない', { reason: '合成', route: [] }],
  ])('%s → 400', async (_name, body) => {
    const { requestId } = await reassignableRequest();
    await expectProblem(
      run(() => catalog.reassign(adminUser.auth, requestId, body)),
      400,
    );
  });
});

describe('実行前検証: 世代の欠落・改ざんを fail closed で拒否する (WP §7)', () => {
  async function completedAcrossGenerations() {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    await reassign(adminUser, requestId);
    await decide(manager2, requestId, 3, 'approve');
    expect(await checkComplete(requestId)).toMatchObject({ ok: true });
    return requestId;
  }

  it('**世代の行を欠落させると失敗する**', async () => {
    const requestId = await completedAcrossGenerations();
    await tamperGenerations(
      requestId,
      'DELETE FROM local_request_route_generation WHERE request_id=$1',
      [requestId],
    );
    expect(await checkComplete(requestId)).toMatchObject({ ok: false });
    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, requestId, {
          requestRevision: 1,
          expectedVersion: 4,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
  });

  it('**from_step_no より前の段を直前の世代と違う内容にすると失敗する**', async () => {
    const requestId = await completedAcrossGenerations();
    const generation = (await generationRows(requestId))[0]!;
    const tampered = {
      ...(generation.route as ApprovalRoute),
      steps: [
        {
          stepNo: 1,
          approverId: fixedB.id,
          authorityType: 'fixed' as const,
          resolvedFrom: 'fixed',
        },
        (generation.route as ApprovalRoute).steps[1]!,
      ],
    };
    await tamperGenerations(
      requestId,
      'UPDATE local_request_route_generation SET route=$2, route_hash=$3 WHERE request_id=$1',
      [requestId, tampered, routeHash(tampered)],
    );
    expect(await checkComplete(requestId)).toMatchObject({
      ok: false,
      reason: 'route_generation_prefix_mismatch',
    });
  });

  it('**route_hash を合わなくすると失敗する**', async () => {
    const requestId = await completedAcrossGenerations();
    await tamperGenerations(
      requestId,
      'UPDATE local_request_route_generation SET route_hash=$2 WHERE request_id=$1',
      [requestId, '0'.repeat(64)],
    );
    expect(await checkComplete(requestId)).toMatchObject({
      ok: false,
      reason: 'route_hash_mismatch',
    });
  });

  it('**世代の番号を飛ばすと失敗する**', async () => {
    const requestId = await completedAcrossGenerations();
    await tamperGenerations(
      requestId,
      'UPDATE local_request_route_generation SET route_generation=3 WHERE request_id=$1',
      [requestId],
    );
    expect(await checkComplete(requestId)).toMatchObject({
      ok: false,
      reason: 'route_generation_sequence',
    });
  });
});

describe('同時実行: 世代とステップを二重に作らない', () => {
  it('**再割当×再割当**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    const results = await Promise.allSettled([
      reassign(adminUser, requestId, '合成: 同時1'),
      reassign(adminUser, requestId, '合成: 同時2'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409 });
    expect(await generationRows(requestId)).toHaveLength(1);
    const steps = await stepRows(requestId);
    expect(steps.map((step) => [step.route_generation, step.step_no, step.state])).toEqual([
      [1, 1, 'approved'],
      [1, 2, 'invalidated'],
      [2, 2, 'pending'],
    ]);
    // 新しい承認者は1人だけ。決定も1回だけ通る。
    await expectProblem(decide(manager, requestId, 3, 'approve'), 403);
    expect(await decide(manager2, requestId, 3, 'approve')).toMatchObject({ state: 'approved' });
  });

  it('**再割当×決定**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    const results = await Promise.allSettled([
      reassign(adminUser, requestId, '合成: 再割当と決定'),
      decide(manager, requestId, 2, 'approve'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await generationRows(requestId)).toHaveLength(1);
    const steps = await stepRows(requestId);
    expect(steps.filter((step) => step.state === 'pending')).toHaveLength(1);
    expect(steps.filter((step) => step.state === 'approved')).toHaveLength(1);
  });
});

describe('版・世代の保護 (WP §7)', () => {
  it('**版のテーブルの行は再割当の前後で全列同じ**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    const before = (
      await q('SELECT row_to_json(v) AS row FROM local_request_revision v WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0].row;
    await reassign(adminUser, requestId);
    const after = (
      await q('SELECT row_to_json(v) AS row FROM local_request_revision v WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0].row;
    expect(after).toEqual(before);
  });

  it('**アプリケーションロールから世代の行の UPDATE / DELETE が拒否される**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    await reassign(adminUser, requestId);
    for (const statement of [
      'UPDATE local_request_route_generation SET reason=$2 WHERE request_id=$1',
      'DELETE FROM local_request_route_generation WHERE request_id=$1',
    ]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
        await expect(
          client.query(
            statement,
            statement.startsWith('UPDATE') ? [requestId, '改ざん'] : [requestId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    expect(await generationRows(requestId)).toHaveLength(1);
  });

  it('**他組織の世代の行は読めず、他組織の世代は作れない(RLS)**', async () => {
    const otherRoute: ApprovalRoute = {
      steps: [{ stepNo: 1, approverId: otherUser, authorityType: 'legacy', resolvedFrom: null }],
      ruleRef: null,
    };
    await q(
      `INSERT INTO local_request_route_generation(
         request_id,organization_id,revision,route_generation,from_step_no,route,route_hash,reason,created_by)
       VALUES($1,$2,1,2,1,$3,$4,'合成: 他組織',$5)`,
      [otherRequestId, otherOrg, otherRoute, routeHash(otherRoute), otherUser],
    );
    const otherGeneration = (
      await q('SELECT route_generation FROM local_request_route_generation WHERE request_id=$1', [
        otherRequestId,
      ])
    ).rows[0];
    expect(otherGeneration).toBeDefined();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
      const visible = await client.query(
        'SELECT count(*)::int AS n FROM local_request_route_generation WHERE request_id=$1',
        [otherRequestId],
      );
      expect(visible.rows[0].n).toBe(0);
      await expect(
        client.query(
          `INSERT INTO local_request_route_generation(
             request_id,organization_id,revision,route_generation,from_step_no,route,route_hash,reason,created_by)
           VALUES($1,$2,1,3,1,$3,$4,'合成: 越境',$5)`,
          [otherRequestId, otherOrg, otherRoute, routeHash(otherRoute), otherUser],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
});

describe('経路は再割当以外で変わらない (WP §7)', () => {
  it('**上長をプロフィールで変えただけでは、経路・ステップ・世代が変わらない**', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    const revisionBefore = await revisionRow(created.id);
    const stepsBefore = await stepRows(created.id);
    await setManager(requester.id, manager2.id);
    expect(await revisionRow(created.id)).toEqual(revisionBefore);
    expect(await stepRows(created.id)).toEqual(stepsBefore);
    expect(await generationRows(created.id)).toHaveLength(0);
    // 元の上長はそのまま決定できる。
    expect(await decide(manager, created.id, 2, 'approve')).toMatchObject({ state: 'approved' });
  });

  it('**申請内容の変更(新しい版)で、再割当済みの版の全ステップが無効になり、新しい版は世代1から始まる**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    await reassign(adminUser, requestId);
    expect(await generationRows(requestId)).toHaveLength(1);
    const edited = await run(() =>
      catalog.edit(requester.auth, requestId, {
        expectedVersion: 3,
        reason: '合成: 内容の変更',
        durationDays: 7,
      }),
    );
    expect(edited).toEqual({ id: requestId, version: 4 });
    const oldSteps = await stepRows(requestId, 1);
    expect(oldSteps.every((step) => step.state === 'invalidated')).toBe(true);
    expect(await generationRows(requestId, 1)).toHaveLength(1);
    const newSteps = await stepRows(requestId, 2);
    expect(newSteps).toHaveLength(1);
    expect(newSteps[0]).toMatchObject({
      route_generation: 1,
      step_no: 1,
      state: 'pending',
      approver_id: fixedA.id,
    });
    expect(await generationRows(requestId, 2)).toHaveLength(0);
    // 新しい版の経路は現在の組織データから解決し直す(ルールの版は現在の current_revision)。
    const revision = await revisionRow(requestId, 2);
    expect((revision.route as ApprovalRoute).steps.map((step) => step.approverId)).toEqual([
      fixedA.id,
      manager2.id,
    ]);
    const invalidatedEvents = (
      await q(
        `SELECT after_state FROM audit_event
          WHERE target_id=$1 AND event_type='approval.invalidated'
            AND after_state->>'cause'='request_changed'`,
        [requestId],
      )
    ).rows;
    expect(invalidatedEvents).toHaveLength(2);
  });
});

describe('監査の失敗は再割当全体を失敗させる', () => {
  it('**approval.reassigned の監査に失敗したら、世代・ステップ・申請を巻き戻す**', async () => {
    const { requestId } = await reassignableRequest();
    await setManager(requester.id, manager2.id);
    const before = await countsFor(requestId);
    const requestBefore = await requestRow(requestId);
    await withFailingAudit('approval.reassigned', async () => {
      await expect(reassign(adminUser, requestId)).rejects.toThrow(/監査イベントの記録に失敗/);
    });
    expect(await countsFor(requestId)).toEqual(before);
    expect(await requestRow(requestId)).toEqual(requestBefore);
    expect(await generationRows(requestId)).toHaveLength(0);
    expect((await stepRows(requestId)).every((step) => step.route_generation === 1)).toBe(true);
  });
});

describe('HTTP 経路の登録 (WP-P4-APR-018 段階B)', () => {
  /**
   * security テストには実サーバーを起動する流儀が無いため、ここでは
   * (1) `main.ts` が再割当の POST 経路を、決定APIと同じ形(認証→本文の読み取り)で
   *     登録していること、をソースで確かめ、
   * (2) 同じ形のハンドラを最小の HTTP サーバーに載せ、認証なしの呼び出しが
   *     401 になることを実際の HTTP で確かめる。
   * `main.ts` は読み込むと起動処理が走るため、テストから直接 import できない。
   */
  it('**main.ts に POST /service-requests/:id/reassignments が登録されている**', () => {
    const source = readFileSync(join(ROOT, 'services/api/src/main.ts'), 'utf8');
    const at = source.indexOf(".post('/service-requests/:id/reassignments'");
    expect(at, '再割当の POST 経路が main.ts に無い').toBeGreaterThanOrEqual(0);
    const handler = source.slice(at, at + 400);
    expect(handler).toContain('catalog.reassign(');
    expect(handler).toContain('auth.authenticate(req.headers)');
    expect(handler).toContain('readJsonBody(req)');
  });

  it('**認証なしの POST は 401 になる(認証が本文の読み取りより先)**', async () => {
    const auth = new AuthController(pool, {
      localAuthEnabled: true,
      cookieSecure: false,
      localAuth: { maxFailedAttempts: 5, lockoutSeconds: 60 },
    });
    const app = new HttpServer(
      createLogger({ service: 'wp018-http', level: 'error', env: 'test' }),
    );
    app.post('/service-requests/:id/reassignments', async (req, _res, params) =>
      catalog.reassign(await auth.authenticate(req.headers), params.id ?? '', {}),
    );
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/service-requests/${randomUUID()}/reassignments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: '合成: 再割当' }),
        },
      );
      expect(response.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
