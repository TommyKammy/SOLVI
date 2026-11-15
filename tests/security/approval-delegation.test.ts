/**
 * WP-P4-APR-020 段階A: 代理承認(委任・代理者による決定・実行前検証・可視性・通知)(TL-02 / TL-04 / TL-06 / TL-16)。
 *
 * - 委任を作れるのは本人だけ。`org_admin` でも他人の委任は作れない。
 * - 代理者は有効な所属かつ `approver` ロールを持つ人だけ。資格の無い相手は同じ応答で拒否する。
 * - 委任の期間は最長30日、開始は現在より5分前まで。同じ委任者の期間は重ならない。
 * - 決定はステップの `approver_id` 本人か、ADR-0025 §3 の6項目を満たす代理者だけ。
 * - 代理で決定したステップは `decided_by`(代理者)・`approver_id`(委任者)・委任のIDを残す。
 * - 実行前検証は委任のID・委任者・代理者・期間・取消を fail closed で検証する。
 *
 * 実行先は使い捨てDB(名前に `wp020` と `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createLogger, newContext, runWithContext } from '@solvi/shared';
import type { ApprovalRuleStep } from '@solvi/shared/catalog';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { ApprovalRuleController } from '../../services/api/src/modules/catalog/approval-rule.routes.js';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import { ApprovalDelegationController } from '../../services/api/src/modules/catalog/approval-delegation.routes.js';
import { InboxController } from '../../services/api/src/modules/inbox/inbox.routes.js';
import { checkApprovalComplete } from '../../services/api/src/modules/catalog/approval-assertion.js';
import { delegationStateFor } from '../../services/api/src/modules/catalog/approval-delegation.js';
import { NotificationService } from '../../services/api/src/modules/notification/notification.service.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import { cleanApprovalNoticeData, cleanAuditData } from '../support/cleanup.js';

const ROOT = join(__dirname, '../..');
const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let pool: pg.Pool;
let admin: pg.Client;
let rules: ApprovalRuleController;
let catalogAdmin: CatalogAdminController;
let catalog: CatalogController;
let delegations: ApprovalDelegationController;
let inbox: InboxController;

let org: string;
let otherOrg: string;
let deptRoot: string;
let deptPrimary: string;

type Person = { id: string; auth: AuthenticatedRequest };
let adminUser: Person;
let requester: Person;
let fixedA: Person;
let fixedB: Person;
let delegateX: Person;
let delegateY: Person;
let delegateZ: Person;
let managerUser: Person;
let headUser: Person;
let noRole: Person;
let agent: Person;
let auditorUser: Person;
let editorUser: Person;
let platformUser: Person;
let outsider: Person;
let outsiderAuth: AuthenticatedRequest;

const made = { users: [] as string[], orgs: [] as string[] };
let sequence = 0;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

function authFor(userId: string, roles: RoleCode[], organizationId = org): AuthenticatedRequest {
  return {
    userId,
    sessionId: `wp020-delegation-${userId.slice(0, 8)}`,
    authz: {
      organizationId,
      principal: {
        userId,
        status: 'active',
        bindings: roles.map((roleCode) => ({
          roleCode,
          organizationId: roleCode === 'platform_admin' ? null : organizationId,
          validFrom: PAST,
          validUntil: null,
        })),
      },
    },
  };
}

async function makeUser(label: string, roles: RoleCode[], organizationId = org): Promise<Person> {
  const id = randomUUID();
  await q(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `wp020-delegation-${label}-${id.slice(0, 8)}@example.test`, `WP020 ${label}`],
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
        role === 'platform_admin' ? null : organizationId,
        PAST,
      ],
    );
  await q('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
    organizationId,
    id,
  ]);
  return { id, auth: authFor(id, roles, organizationId) };
}

async function makeDepartment(label: string, parentId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1,$2,$3,$4,$5)`,
    [id, org, `wp020-delegation-${label}-${SUFFIX}`, `WP020 ${label} (合成)`, parentId],
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

const nextCode = () => `wp020-${SUFFIX}-${++sequence}`;

const fixedStep = (approverId: string): ApprovalRuleStep => ({ type: 'fixed', approverId });
const managerStep = (onUnresolved: 'department_head' | 'reject' = 'reject'): ApprovalRuleStep => ({
  type: 'manager',
  onUnresolved,
});
const headStep = (): ApprovalRuleStep => ({ type: 'department_head', onUnresolved: 'reject' });

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
      code: `wp020-delegation-item-${SUFFIX}-${++sequence}`,
      title: '合成 代理承認',
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
      reason: '合成: 代理承認',
      durationDays: 7,
      ...extra,
    }),
  );
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const startOf = (offsetMs: number) => iso(offsetMs);

const createDelegation = (
  person: Person,
  delegateId: string,
  period: { startsAt?: string; endsAt?: string } = {},
) =>
  run(() =>
    delegations.create(person.auth, {
      delegateId,
      startsAt: period.startsAt ?? startOf(-MINUTE),
      endsAt: period.endsAt ?? iso(HOUR),
    }),
  );

const revokeDelegation = (person: Person, id: string, reason = '合成: 取消') =>
  run(() => delegations.revoke(person.auth, id, { reason }));

const decide = (
  person: Person,
  id: string,
  expectedVersion: number,
  decision: 'approve' | 'reject' | 'revoke' = 'approve',
  reason = '',
) => run(() => catalog.decide(person.auth, id, { decision, expectedVersion, reason }));

const detailFor = (person: Person, id: string) => run(() => catalog.detail(person.auth, id));

const listFor = (person: Person) =>
  run(() => catalog.list(person.auth, new URLSearchParams({ view: 'approvals' })));

const requestRow = async (id: string) =>
  (await q('SELECT * FROM local_service_request WHERE id=$1', [id])).rows[0];
const currentVersion = async (id: string) => (await requestRow(id)).version as number;
const stepRows = async (id: string, revision = 1) =>
  (
    await q(
      `SELECT * FROM local_request_approval
        WHERE request_id=$1 AND revision=$2
        ORDER BY route_generation,step_no,id`,
      [id, revision],
    )
  ).rows;
const delegationRows = async () =>
  (await q('SELECT * FROM approval_delegation WHERE organization_id=$1 ORDER BY created_at', [org]))
    .rows;

async function countsFor(requestId: string) {
  return {
    steps: (
      await q('SELECT count(*)::int AS n FROM local_request_approval WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0].n as number,
    audits: (await q('SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1', [requestId]))
      .rows[0].n as number,
    outbox: (
      await q(`SELECT count(*)::int AS n FROM outbox_event WHERE payload->>'requestId'=$1`, [
        requestId,
      ])
    ).rows[0].n as number,
    notices: (
      await q(
        `SELECT count(*)::int AS n FROM local_request_approval_notice
          WHERE approval_id IN (SELECT id FROM local_request_approval WHERE request_id=$1)`,
        [requestId],
      )
    ).rows[0].n as number,
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

async function expireBinding(userId: string, roleCode?: RoleCode): Promise<void> {
  await q(
    `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
      WHERE organization_id=$1 AND user_id=$2 AND valid_until IS NULL
        AND ($3::text IS NULL OR role_id=(SELECT id FROM role WHERE code=$3))`,
    [org, userId, roleCode ?? null],
  );
}

async function deactivateUser(userId: string): Promise<void> {
  await q(
    `UPDATE app_user SET status='deactivated', deactivated_at=clock_timestamp() WHERE id=$1`,
    [userId],
  );
}

/** 追記専用トリガを検査のためだけに外す(本番でこの経路は存在しない)。 */
async function tamperDelegation(sql: string, params: unknown[] = []): Promise<void> {
  await admin.query(
    'ALTER TABLE approval_delegation DISABLE TRIGGER approval_delegation_guard_update',
  );
  try {
    await q(sql, params);
  } finally {
    await admin.query(
      'ALTER TABLE approval_delegation ENABLE TRIGGER approval_delegation_guard_update',
    );
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

/** 委任は DELETE を拒否するため、検査のためにトリガを外して消す。 */
async function cleanDelegations(organizationId?: string): Promise<void> {
  await admin.query(
    'ALTER TABLE approval_delegation DISABLE TRIGGER approval_delegation_guard_delete',
  );
  try {
    if (organizationId)
      await q('DELETE FROM approval_delegation WHERE organization_id=$1', [organizationId]);
    else await q('DELETE FROM approval_delegation');
  } finally {
    await admin.query(
      'ALTER TABLE approval_delegation ENABLE TRIGGER approval_delegation_guard_delete',
    );
  }
}

async function cleanOrgData(): Promise<void> {
  await cleanApprovalNoticeData(admin, 'organization_id = $1', [org]);
  await cleanAuditData(admin, `organization_id = '${org}'`);
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
  // 委任は承認行を参照するため、承認行を消した後に消す。
  await cleanDelegations(org);
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
    fixedA,
    fixedB,
    delegateX,
    delegateY,
    delegateZ,
    managerUser,
    headUser,
    noRole,
    agent,
    auditorUser,
    editorUser,
    platformUser,
  ])
    await setDepartment(person.id, deptPrimary);
  await setManager(requester.id, managerUser.id);
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

type OutboxRow = {
  id: string;
  event_type: string;
  organization_id: string;
  payload: Record<string, string>;
};

const outboxByType = async (eventType: string) =>
  (
    await q(
      `SELECT id,event_type,organization_id,payload FROM outbox_event
        WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at,id`,
      [org, eventType],
    )
  ).rows as OutboxRow[];

/** 1つの Outbox イベントを、その組織の文脈で配送する(ディスパッチャと同じ形)。 */
async function deliver(event: OutboxRow): Promise<{
  sender: RecordingEmailSender;
  sent: number;
  skipped: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [event.organization_id]);
    const sender = new RecordingEmailSender();
    const service = new NotificationService(client, new Map([['email', sender]]));
    const result = await service.deliverForEvent({
      id: event.id,
      organizationId: event.organization_id,
      eventType: event.event_type,
      payload: event.payload,
    });
    await client.query('COMMIT');
    return { sender, ...result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const emailOf = async (userId: string) =>
  (await q('SELECT primary_email::text AS email FROM app_user WHERE id=$1', [userId])).rows[0]
    .email as string;

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 8 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const client of [pool, admin]) {
    const name = (await client.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!name.includes('wp020') || !name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は wp020 の使い捨てDBではありません。中止します`);
    }
  }
  rules = new ApprovalRuleController(pool, true);
  catalogAdmin = new CatalogAdminController(pool, true);
  catalog = new CatalogController(
    pool,
    {} as ConstructorParameters<typeof CatalogController>[1],
    true,
    createLogger({ service: 'wp020-delegation', level: 'error', env: 'test' }),
  );
  delegations = new ApprovalDelegationController(pool, true);
  inbox = new InboxController(pool, true);

  org = randomUUID();
  made.orgs.push(org);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    org,
    `wp020-delegation-${SUFFIX}`,
    'WP020 代理承認 (合成)',
  ]);
  deptRoot = await makeDepartment('root', null);
  deptPrimary = await makeDepartment('primary', deptRoot);

  adminUser = await makeUser('admin', ['org_admin']);
  requester = await makeUser('requester', ['requester']);
  fixedA = await makeUser('fixed-a', ['approver']);
  fixedB = await makeUser('fixed-b', ['approver']);
  delegateX = await makeUser('delegate-x', ['approver']);
  delegateY = await makeUser('delegate-y', ['approver']);
  delegateZ = await makeUser('delegate-z', ['approver']);
  managerUser = await makeUser('manager', ['requester']);
  headUser = await makeUser('head', ['requester']);
  noRole = await makeUser('no-role', ['requester']);
  agent = await makeUser('agent', ['agent']);
  auditorUser = await makeUser('auditor', ['auditor']);
  editorUser = await makeUser('editor', ['catalog_editor']);
  platformUser = await makeUser('platform', ['platform_admin']);
  await assignHead(deptPrimary, headUser.id);
  await resetProfiles();

  // 他組織(404 と RLS の検査用)。合成データだけを使う。
  otherOrg = randomUUID();
  made.orgs.push(otherOrg);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    otherOrg,
    `wp020-other-${SUFFIX}`,
    'WP020 他組織 (合成)',
  ]);
  outsider = await makeUser('outsider', ['approver'], otherOrg);
  outsiderAuth = authFor(outsider.id, ['approver'], otherOrg);
}, 120_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanOrgData();
      await cleanDelegations();
      await q('DELETE FROM department_head WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
      await q('DELETE FROM org_member_profile WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
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
  await resetProfiles();
  await enableRouting(true);
});

describe('Migration 0042: 委任の表と、ステップの委任のID (TL-04)', () => {
  it('行が無ければ down → up の往復ができる。分離ポリシーは1件だけ増える', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public'`))
      .rows[0].n as number;
    const down = migrate('down', '--to', '0041');
    expect(down.ok, down.output).toBe(true);
    expect(down.output).toContain('0042_approval_delegation.sql');
    const withoutTable = (
      await q(
        `SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname='public' AND tablename='approval_delegation'`,
      )
    ).rows[0].n as number;
    expect(withoutTable).toBe(0);
    const policiesWithout = (
      await q(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public'`)
    ).rows[0].n as number;
    expect(before - policiesWithout).toBe(1);
    const up = migrate('up');
    expect(up.ok, up.output).toBe(true);
    const policies = (
      await q(
        `SELECT policyname FROM pg_policies
          WHERE schemaname='public' AND tablename='approval_delegation'`,
      )
    ).rows as Array<{ policyname: string }>;
    expect(policies.map((row) => row.policyname)).toEqual(['approval_delegation_isolation']);
  }, 120_000);

  it('委任の行が1件でもあれば down を拒否する(前進修復)', async () => {
    await createDelegation(fixedA, delegateX.id);
    const down = migrate('down', '--to', '0041');
    expect(down.ok).toBe(false);
    expect(down.output).toContain('0042 rollback refused');
    expect((await delegationRows()).length).toBe(1);
  }, 120_000);

  it('委任のIDを持つステップが1件でもあれば down を拒否する', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const delegation = await createDelegation(fixedA, delegateX.id);
    await decide(delegateX, created.id, await currentVersion(created.id));
    // 委任の行だけを消して、ステップの delegation_id を残す。
    // 複合外部キーは検査のために一時的に外し、拒否を確かめた後に戻す。
    await admin.query(
      'ALTER TABLE local_request_approval DROP CONSTRAINT local_request_approval_delegation_fk',
    );
    try {
      await cleanDelegations(org);
      const down = migrate('down', '--to', '0041');
      expect(down.ok).toBe(false);
      expect(down.output).toContain('0042 rollback refused');
      await q('UPDATE local_request_approval SET delegation_id=NULL WHERE request_id=$1', [
        created.id,
      ]);
    } finally {
      const stillThere = (
        await q(
          `SELECT count(*)::int AS n FROM pg_constraint
            WHERE conname='local_request_approval_delegation_fk'`,
        )
      ).rows[0].n as number;
      if (stillThere === 0)
        await admin.query(
          `ALTER TABLE local_request_approval
             ADD CONSTRAINT local_request_approval_delegation_fk
             FOREIGN KEY (delegation_id, organization_id)
             REFERENCES approval_delegation (id, organization_id) ON DELETE RESTRICT`,
        );
    }
    expect(delegation.id).toBeDefined();
  }, 120_000);
});

describe('委任の作成 (WP §7-1〜§7-3 / ADR-0025 §1・§2・§3)', () => {
  it('本人が作ると、委任者は常に認証済みの本人になる', async () => {
    const created = await createDelegation(fixedA, delegateX.id);
    expect(created.delegatorId).toBe(fixedA.id);
    expect(created.delegateId).toBe(delegateX.id);
    expect(created.state).toBe('active');
    const rows = await delegationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].delegator_id).toBe(fixedA.id);
    expect(rows[0].created_by).toBe(fixedA.id);
  });

  it('**本文で委任者を指定できない**(未知のキーは 400)', async () => {
    await expectProblem(
      run(() =>
        delegations.create(fixedA.auth, {
          delegateId: delegateX.id,
          startsAt: startOf(-MINUTE),
          endsAt: iso(HOUR),
          delegatorId: fixedB.id,
        }),
      ),
      400,
    );
    expect(await delegationRows()).toHaveLength(0);
  });

  it('**org_admin でも他人の委任を作れない**。作った委任の委任者は org_admin 自身になる', async () => {
    const created = await createDelegation(adminUser, delegateX.id);
    expect(created.delegatorId).toBe(adminUser.id);
    const rows = await delegationRows();
    expect(rows[0].delegator_id).toBe(adminUser.id);
    await expectProblem(
      run(() =>
        delegations.create(adminUser.auth, {
          delegateId: delegateX.id,
          delegateFor: fixedA.id,
          startsAt: startOf(-MINUTE),
          endsAt: iso(HOUR),
        }),
      ),
      400,
    );
  });

  it('他組織からは作成できない(有効な所属が無い)', async () => {
    await expectProblem(
      run(() =>
        delegations.create(outsiderAuth, {
          delegateId: delegateX.id,
          startsAt: startOf(-MINUTE),
          endsAt: iso(HOUR),
        }),
      ),
      403,
    );
    expect(await delegationRows()).toHaveLength(0);
  });

  it('**資格の無い代理者は、同じ 403 と同じ文言で拒否する**(存在を漏らさない)', async () => {
    await deactivateUser(noRole.id);
    const attempts = [
      noRole.id,
      fixedA.id, // 委任者自身
      outsider.id, // 他組織
      randomUUID(), // 存在しない
    ];
    const messages: string[] = [];
    for (const candidate of attempts) {
      const error = await expectProblem(
        run(() =>
          delegations.create(fixedA.auth, {
            delegateId: candidate,
            startsAt: startOf(-MINUTE),
            endsAt: iso(HOUR),
          }),
        ),
        403,
      );
      messages.push(error.message);
    }
    // approver ロールが無い(停止・所属切れ)ケース。
    await q(`UPDATE app_user SET status='active', deactivated_at=NULL WHERE id=$1`, [noRole.id]);
    messages.push(
      (
        await expectProblem(
          run(() =>
            delegations.create(fixedA.auth, {
              delegateId: noRole.id,
              startsAt: startOf(-MINUTE),
              endsAt: iso(HOUR),
            }),
          ),
          403,
        )
      ).message,
    );
    expect(new Set(messages).size, messages.join(' / ')).toBe(1);
    expect(await delegationRows()).toHaveLength(0);
  });

  it('期間: 終了が開始以前・過去に終わる・30日超・開始が5分より前は 400、5分前ちょうどは通る', async () => {
    const cases: Array<{ startsAt: string; endsAt: string }> = [
      { startsAt: iso(HOUR), endsAt: iso(MINUTE) },
      { startsAt: iso(-2 * HOUR), endsAt: iso(-HOUR) },
      { startsAt: startOf(-MINUTE), endsAt: iso(31 * DAY) },
      { startsAt: iso(-6 * MINUTE), endsAt: iso(HOUR) },
    ];
    for (const period of cases)
      await expectProblem(
        run(() => delegations.create(fixedA.auth, { delegateId: delegateX.id, ...period })),
        400,
      );
    expect(await delegationRows()).toHaveLength(0);
    // 5分前より後(4分前)は許す。
    const ok = await run(() =>
      delegations.create(fixedA.auth, {
        delegateId: delegateX.id,
        startsAt: iso(-4 * MINUTE),
        endsAt: iso(29 * DAY),
      }),
    );
    expect(ok.state).toBe('active');
  });

  it('同じ委任者の期間が重なる委任は 409。端点が接する期間は通る', async () => {
    const first = await createDelegation(fixedA, delegateX.id, {
      startsAt: iso(-MINUTE),
      endsAt: iso(HOUR),
    });
    await expectProblem(
      run(() =>
        delegations.create(fixedA.auth, {
          delegateId: delegateY.id,
          startsAt: iso(HOUR - MINUTE),
          endsAt: iso(2 * HOUR),
        }),
      ),
      409,
    );
    const adjacent = await createDelegation(fixedA, delegateY.id, {
      startsAt: iso(HOUR),
      endsAt: iso(2 * HOUR),
    });
    expect(adjacent.state).toBe('scheduled');
    expect((await delegationRows()).length).toBe(2);
    // 別の委任者の期間は重なってよい(代理者は同時に1人、は委任者ごと)。
    const other = await createDelegation(fixedB, delegateX.id, {
      startsAt: iso(-MINUTE),
      endsAt: iso(HOUR),
    });
    expect(other.state).toBe('active');
    expect(first.id).not.toBe(other.id);
  });

  it('**同時に作っても、重なる委任は1件しか成立しない**', async () => {
    const results = await Promise.allSettled([
      createDelegation(fixedA, delegateX.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) }),
      createDelegation(fixedA, delegateY.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await delegationRows()).length).toBe(1);
  });

  it('委任の作成は `approval.delegated` を記録し、通知を1件積む', async () => {
    const created = await createDelegation(fixedA, delegateX.id);
    const audits = (
      await q(
        `SELECT after_state FROM audit_event
          WHERE event_type='approval.delegated' AND target_id=$1`,
        [created.id],
      )
    ).rows as Array<{ after_state: Record<string, unknown> }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after_state).toMatchObject({
      delegationId: created.id,
      delegatorId: fixedA.id,
      delegateId: delegateX.id,
    });
    const events = await outboxByType('approval.delegation.created');
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.payload)).toEqual(['delegationId']);
  });

  it('代理者の候補は表示名とIDだけで、自分と資格の無い人を含まない', async () => {
    const result = await run(() => delegations.candidates(fixedA.auth));
    const ids = result.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(delegateX.id);
    expect(ids).not.toContain(fixedA.id);
    expect(ids).not.toContain(noRole.id);
    expect(ids).not.toContain(outsider.id);
    for (const item of result.items)
      expect(Object.keys(item).sort()).toEqual(['displayName', 'id']);
  });
});

describe('委任の取消と一覧 (WP §7-12 / ADR-0025 §1・§5)', () => {
  it('委任者・代理者・org_admin だけが取り消せる', async () => {
    const byDelegator = await createDelegation(fixedA, delegateX.id);
    await revokeDelegation(fixedA, byDelegator.id);
    const revoked = (await delegationRows())[0]!;
    expect(revoked.revoked_at).toBeInstanceOf(Date);
    expect(revoked.revoked_by).toBe(fixedA.id);
    expect(revoked.revoke_reason).toBe('合成: 取消');
    const audits = (
      await q(
        `SELECT after_state FROM audit_event
          WHERE event_type='approval.delegation_revoked' AND target_id=$1`,
        [byDelegator.id],
      )
    ).rows as Array<{ after_state: Record<string, unknown> }>;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after_state).toMatchObject({
      delegationId: byDelegator.id,
      delegatorId: fixedA.id,
      delegateId: delegateX.id,
      revokeReason: '合成: 取消',
    });
    expect((await outboxByType('approval.delegation.revoked')).length).toBe(1);

    const byDelegate = await createDelegation(fixedA, delegateX.id, {
      startsAt: iso(HOUR),
      endsAt: iso(2 * HOUR),
    });
    await revokeDelegation(delegateX, byDelegate.id);

    const byAdmin = await createDelegation(fixedA, delegateY.id, {
      startsAt: iso(2 * HOUR),
      endsAt: iso(3 * HOUR),
    });
    await revokeDelegation(adminUser, byAdmin.id);

    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM approval_delegation WHERE organization_id=$1 AND revoked_at IS NOT NULL',
          [org],
        )
      ).rows[0].n,
    ).toBe(3);
  });

  it('ロール×エンドポイントの総当たり: 一覧は全員、作成は有効な所属の本人、取消は委任者・代理者・組織管理者だけ', async () => {
    const actors: Array<{
      person: Person;
      label: string;
      canCreate: boolean;
      canRevokeOther: boolean;
    }> = [
      { person: requester, label: 'requester', canCreate: true, canRevokeOther: false },
      { person: fixedA, label: 'approver', canCreate: true, canRevokeOther: false },
      { person: agent, label: 'agent', canCreate: true, canRevokeOther: false },
      { person: auditorUser, label: 'auditor', canCreate: true, canRevokeOther: false },
      { person: editorUser, label: 'catalog_editor', canCreate: true, canRevokeOther: false },
      { person: adminUser, label: 'org_admin', canCreate: true, canRevokeOther: true },
      // platform_admin は組織の所属を持たないため、委任の作成はできない(所属が無い)。
      { person: platformUser, label: 'platform_admin', canCreate: false, canRevokeOther: true },
    ];
    for (const [index, actor] of actors.entries()) {
      // 一覧は全員が自分向けに読める(0件でもよい)。
      const list = await run(() => delegations.list(actor.person.auth));
      expect(list.items, actor.label).toBeDefined();
      // 作成。
      const created = await run(() =>
        delegations.create(actor.person.auth, {
          delegateId: delegateX.id,
          startsAt: startOf(-MINUTE),
          endsAt: iso(HOUR),
        }),
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (actor.canCreate) {
        expect(created.ok, actor.label).toBe(true);
      } else {
        expect(created.ok, actor.label).toBe(false);
        expect((created as { error: { status?: number } }).error.status, actor.label).toBe(403);
      }
      // 他人(fixedB)の委任の取消。取消できるのは org_admin / platform_admin だけ。
      const target = await createDelegation(fixedB, delegateY.id, {
        startsAt: iso(index * 2 * HOUR + HOUR),
        endsAt: iso(index * 2 * HOUR + 2 * HOUR),
      });
      const revoked = await run(() =>
        delegations.revoke(actor.person.auth, target.id, { reason: '合成' }),
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (actor.canRevokeOther) expect(revoked.ok, actor.label).toBe(true);
      else {
        expect(revoked.ok, actor.label).toBe(false);
        expect((revoked as { error: { status?: number } }).error.status, actor.label).toBe(403);
      }
      if (!revoked.ok) await revokeDelegation(fixedB, target.id);
    }
  });

  it('委任者・代理者・org_admin 以外は 403、他組織の委任は 404、期間外・取消済みは 409', async () => {
    const active = await createDelegation(fixedA, delegateX.id);
    await expectProblem(revokeDelegation(noRole, active.id), 403);
    await expectProblem(revokeDelegation(agent, active.id), 403);
    await expectProblem(
      run(() => delegations.revoke(outsiderAuth, active.id, { reason: '合成' })),
      404,
    );
    await expectProblem(
      run(() => delegations.revoke(fixedA.auth, randomUUID(), { reason: '合成' })),
      404,
    );
    await expectProblem(
      run(() => delegations.revoke(fixedA.auth, active.id, {})),
      400,
    );

    await revokeDelegation(fixedA, active.id);
    await expectProblem(revokeDelegation(fixedA, active.id), 409);

    // 期間の終わった委任は取り消せない(状態は ended)。
    const ended = await createDelegation(fixedA, delegateY.id, {
      startsAt: iso(-2 * HOUR),
      endsAt: iso(-HOUR),
    }).catch(() => null);
    // 作成時に「終了が現在より後」を要求するため、期間終了はDBで直接作る。
    expect(ended).toBeNull();
    const rowId = uuidv7();
    await q(
      `INSERT INTO approval_delegation(id,organization_id,delegator_id,delegate_id,starts_at,ends_at,created_by)
       VALUES($1,$2,$3,$4,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$3)`,
      [rowId, org, fixedA.id, delegateY.id],
    );
    await expectProblem(revokeDelegation(fixedA, rowId), 409);
  });

  it('一覧: 委任者・代理者は自分の分だけ、org_admin は組織のすべて、他組織は見えない', async () => {
    await createDelegation(fixedA, delegateX.id);
    await createDelegation(fixedB, delegateY.id);
    const forDelegator = await run(() => delegations.list(fixedA.auth));
    expect(forDelegator.items.map((item: { delegateId: string }) => item.delegateId)).toEqual([
      delegateX.id,
    ]);
    const forDelegate = await run(() => delegations.list(delegateY.auth));
    expect(forDelegate.items.map((item: { delegatorId: string }) => item.delegatorId)).toEqual([
      fixedB.id,
    ]);
    const forUnrelated = await run(() => delegations.list(noRole.auth));
    expect(forUnrelated.items).toHaveLength(0);
    const forAdmin = await run(() => delegations.list(adminUser.auth));
    expect(forAdmin.items).toHaveLength(2);
    const forOutsider = await run(() => delegations.list(outsider.auth));
    expect(forOutsider.items).toHaveLength(0);
  });

  it('状態は予定・有効・終了・取消済み・代理者が資格なしを導出する', async () => {
    const scheduled = await createDelegation(fixedA, delegateX.id, {
      startsAt: iso(2 * HOUR),
      endsAt: iso(3 * HOUR),
    });
    expect(scheduled.state).toBe('scheduled');
    const revoked = await createDelegation(fixedA, delegateY.id, {
      startsAt: iso(3 * HOUR),
      endsAt: iso(4 * HOUR),
    });
    await revokeDelegation(fixedA, revoked.id);
    const endedId = uuidv7();
    await q(
      `INSERT INTO approval_delegation(id,organization_id,delegator_id,delegate_id,starts_at,ends_at,created_by)
       VALUES($1,$2,$3,$4,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$3)`,
      [endedId, org, fixedA.id, delegateZ.id],
    );
    // 代理者が approver ロールを失った有効な委任。
    await expireBinding(delegateX.id, 'approver');
    const list = await run(() => delegations.list(fixedA.auth));
    const states = new Map(
      list.items.map((item: { id: string; state: string }) => [item.id, item.state]),
    );
    expect(states.get(endedId)).toBe('ended');
    expect(states.get(revoked.id)).toBe('revoked');
    // 予定の委任は、期間前なので代理者の資格を問わず scheduled。
    expect(states.get(scheduled.id)).toBe('scheduled');
    const active = await createDelegation(fixedA, delegateY.id, {
      startsAt: iso(-MINUTE),
      endsAt: iso(HOUR),
    });
    const list2 = await run(() => delegations.list(fixedA.auth));
    const states2 = new Map(
      list2.items.map((item: { id: string; state: string }) => [item.id, item.state]),
    );
    expect(states2.get(active.id)).toBe('active');
  });
});

describe('代理者による決定 (WP §7-4 / ADR-0025 §2・§3)', () => {
  it('fixed・manager・department_head の各段を代理で決定でき、記録と監査が残る', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep(), headStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const revisionBefore = (
      await q('SELECT * FROM local_request_revision WHERE request_id=$1', [created.id])
    ).rows[0];

    const delegationA = await createDelegation(fixedA, delegateX.id);
    const delegationManager = await createDelegation(managerUser, delegateY.id);
    const delegationHead = await createDelegation(headUser, delegateZ.id);

    await decide(delegateX, created.id, await currentVersion(created.id));
    await decide(delegateY, created.id, await currentVersion(created.id));
    const result = await decide(delegateZ, created.id, await currentVersion(created.id));
    expect(result.state).toBe('approved');

    const steps = await stepRows(created.id);
    expect(steps).toHaveLength(3);
    const expected = [
      { approver: fixedA.id, decidedBy: delegateX.id, delegationId: delegationA.id, type: 'fixed' },
      {
        approver: managerUser.id,
        decidedBy: delegateY.id,
        delegationId: delegationManager.id,
        type: 'manager',
      },
      {
        approver: headUser.id,
        decidedBy: delegateZ.id,
        delegationId: delegationHead.id,
        type: 'department_head',
      },
    ];
    for (const [index, step] of steps.entries()) {
      expect(step.state).toBe('approved');
      expect(step.approver_id).toBe(expected[index]!.approver);
      expect(step.decided_by).toBe(expected[index]!.decidedBy);
      expect(step.delegation_id).toBe(expected[index]!.delegationId);
      expect(step.authority_type).toBe(expected[index]!.type);
    }

    for (const [index, delegation] of [delegationA, delegationManager, delegationHead].entries()) {
      const audits = (
        await q(
          `SELECT after_state FROM audit_event
            WHERE event_type='approval.approved' AND approval_ref=$1`,
          [steps[index]!.id],
        )
      ).rows as Array<{ after_state: Record<string, unknown> }>;
      expect(audits, `step ${index + 1}`).toHaveLength(1);
      expect(audits[0]!.after_state).toMatchObject({
        delegated: true,
        delegatorId: expected[index]!.approver,
        delegateId: expected[index]!.decidedBy,
        delegationId: delegation.id,
      });
    }

    // 経路・route_hash・世代は変わらない(代理は経路を書き換えない)。
    const revisionAfter = (
      await q('SELECT * FROM local_request_revision WHERE request_id=$1', [created.id])
    ).rows[0];
    expect(revisionAfter.route).toEqual(revisionBefore.route);
    expect(revisionAfter.route_hash).toBe(revisionBefore.route_hash);
    expect(revisionAfter.route_generation).toBe(revisionBefore.route_generation);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM local_request_route_generation WHERE request_id=$1',
          [created.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await requestRow(created.id)).state).toBe('approved');

    // 実行前検証と模擬実行が通る。
    const check = await checkComplete(created.id);
    expect(check.ok, JSON.stringify(check)).toBe(true);
    const expectedVersion = await currentVersion(created.id);
    const simulated = await run(() =>
      catalog.simulate(agent.auth, created.id, { expectedVersion }),
    );
    expect(simulated.replayed).toBe(false);
  });

  it('却下も代理でできる(ステップに委任のIDが残る)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const delegation = await createDelegation(fixedA, delegateX.id);
    const result = await decide(
      delegateX,
      created.id,
      await currentVersion(created.id),
      'reject',
      '合成: 代理で却下',
    );
    expect(result.state).toBe('rejected');
    const step = (await stepRows(created.id))[0]!;
    expect(step.decided_by).toBe(delegateX.id);
    expect(step.approver_id).toBe(fixedA.id);
    expect(step.delegation_id).toBe(delegation.id);
  });

  it('委任者本人の決定は従来どおりで、委任のIDを残さない', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegateX.id);
    await decide(fixedA, created.id, await currentVersion(created.id));
    const step = (await stepRows(created.id))[0]!;
    expect(step.decided_by).toBe(fixedA.id);
    expect(step.delegation_id).toBeNull();
    expect((await checkComplete(created.id)).ok).toBe(true);
  });

  it('決定の本文に委任のIDを送っても、サーバは委任を本文から選ばない', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegateX.id);
    // 決定者は本人。本文の delegationId は無視され、委任のIDは残らない。
    const result = await run(() =>
      catalog.decide(fixedA.auth, created.id, {
        decision: 'approve',
        expectedVersion: 1,
        reason: '',
        delegationId: randomUUID(),
      }),
    );
    expect(result.state).toBe('approved');
    expect((await stepRows(created.id))[0]!.delegation_id).toBeNull();
  });

  it('代理者が、ほかの段の approver_id でもある場合は代理で決定できない(ADR-0025 §3-6)', async () => {
    // 1段目 fixedA、2段目 fixedB。fixedB が fixedA の代理者になっている。
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, fixedB.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) });
    const before = await countsFor(created.id);
    await expectProblem(decide(fixedB, created.id, await currentVersion(created.id)), 404);
    expect(await countsFor(created.id)).toEqual(before);
    // 本人として1段目を承認した後、2段目を本人として決定できる。
    await decide(fixedA, created.id, await currentVersion(created.id));
    await decide(fixedB, created.id, await currentVersion(created.id));
    const steps = await stepRows(created.id);
    expect(steps.map((step) => step.decided_by)).toEqual([fixedA.id, fixedB.id]);
    expect(steps.every((step) => step.delegation_id === null)).toBe(true);
  });

  it('代理として1段目を決定した人は、同じ申請の2段目を代理で決定できない(decided_by の非重複)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    // delegateX は fixedA の代理者でもあり、fixedB の代理者でもある(別の委任)。
    await createDelegation(fixedA, delegateX.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) });
    await createDelegation(fixedB, delegateX.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) });
    await decide(delegateX, created.id, await currentVersion(created.id));
    const before = await countsFor(created.id);
    await expectProblem(decide(delegateX, created.id, await currentVersion(created.id)), 404);
    expect(await countsFor(created.id)).toEqual(before);
  });
});

describe('決定の6項目 (ADR-0025 §3) — 1項目ずつ欠かす', () => {
  async function singleStepRequest() {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    return created.id as string;
  }

  async function expectDeniedWithoutChanges(requestId: string, actor: Person) {
    const before = await countsFor(requestId);
    await expectProblem(decide(actor, requestId, await currentVersion(requestId)), 404);
    expect(await countsFor(requestId)).toEqual(before);
  }

  it('1. 委任の委任者がステップの approver_id と一致しない', async () => {
    const requestId = await singleStepRequest();
    await createDelegation(fixedB, delegateX.id);
    await expectDeniedWithoutChanges(requestId, delegateX);
  });

  it('2. 期間前・期間後・取消後は決定できない', async () => {
    const requestId = await singleStepRequest();
    const scheduled = await createDelegation(fixedA, delegateX.id, {
      startsAt: iso(HOUR),
      endsAt: iso(2 * HOUR),
    });
    await expectDeniedWithoutChanges(requestId, delegateX);
    await revokeDelegation(fixedA, scheduled.id);

    // 期間後(終了済み)は、作成の検証を通らないためDBで直接作る。
    await q(
      `INSERT INTO approval_delegation(id,organization_id,delegator_id,delegate_id,starts_at,ends_at,created_by)
       VALUES($1,$2,$3,$4,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$3)`,
      [uuidv7(), org, fixedA.id, delegateY.id],
    );
    await expectDeniedWithoutChanges(requestId, delegateY);

    // 取消済み。
    await q(
      `INSERT INTO approval_delegation(id,organization_id,delegator_id,delegate_id,starts_at,ends_at,created_by)
       VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour',$3)`,
      [uuidv7(), org, fixedA.id, delegateZ.id],
    );
    const revocable = (
      await q('SELECT id FROM approval_delegation WHERE delegate_id=$1', [delegateZ.id])
    ).rows[0].id;
    await revokeDelegation(fixedA, revocable);
    await expectDeniedWithoutChanges(requestId, delegateZ);
  });

  it('3. 委任者が無効(所属切れ)なら、委任は効かない', async () => {
    const requestId = await singleStepRequest();
    await createDelegation(fixedA, delegateX.id);
    await expireBinding(fixedA.id);
    await expectDeniedWithoutChanges(requestId, delegateX);
    await expectProblem(detailFor(delegateX, requestId), 404);
  });

  it('4. 代理者が approver ロールを失えば、決定できない', async () => {
    const requestId = await singleStepRequest();
    await createDelegation(fixedA, delegateX.id);
    await expireBinding(delegateX.id, 'approver');
    await expectDeniedWithoutChanges(requestId, delegateX);
  });

  it('5. 代理者が申請者本人なら決定できない(403・状態は変わらない)', async () => {
    // 代理者 delegateX が自分の申請を作り、fixedA がその申請を delegateX へ委任する。
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const requestId = (await createRequest(delegateX, itemId)).id as string;
    await createDelegation(fixedA, delegateX.id);
    const before = await countsFor(requestId);
    await expectProblem(decide(delegateX, requestId, await currentVersion(requestId)), 403);
    expect(await countsFor(requestId)).toEqual(before);
  });

  it('6. 代理者が同じ申請のほかの段を決定していれば、決定できない', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegateX.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) });
    await createDelegation(fixedB, delegateX.id, { startsAt: iso(-MINUTE), endsAt: iso(HOUR) });
    await decide(delegateX, created.id, await currentVersion(created.id));
    await expectDeniedWithoutChanges(created.id, delegateX);
  });
});

describe('再割当との組み合わせ (WP-P4-APR-018 / §7-8)', () => {
  it('委任者が無効になった申請は承認者不在として扱われ、再割当後の新しい承認者に旧委任は効かない', async () => {
    const ruleId = await createRule([managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(managerUser, delegateX.id);

    // 委任者(現在の承認者)が所属切れになる。委任があっても「承認者不在」である。
    await expireBinding(managerUser.id);
    const unavailable = await run(() =>
      catalog.list(adminUser.auth, new URLSearchParams({ approverUnavailable: '1' })),
    );
    expect(unavailable.items.some((item: { id: string }) => item.id === created.id)).toBe(true);

    // 新しい上長へ再割当する。
    await setManager(requester.id, fixedB.id);
    const reassigned = await run(() =>
      catalog.reassign(adminUser.auth, created.id, { reason: '合成: 承認者不在' }),
    );
    expect(reassigned.approverId).toBe(fixedB.id);
    const steps = await stepRows(created.id);
    const current = steps.find((step) => step.state === 'pending')!;
    expect(current.approver_id).toBe(fixedB.id);
    expect(current.decided_by).toBeNull();

    // 旧承認者の委任(delegateX)は、新しい承認者には効かない。
    await expectProblem(decide(delegateX, created.id, await currentVersion(created.id)), 404);
    // 新しい承認者は本人として決定できる(委任の無い決定で、委任のIDも残らない)。
    await decide(fixedB, created.id, await currentVersion(created.id));
    const approved = (await stepRows(created.id)).find((step) => step.state === 'approved')!;
    expect(approved.approver_id).toBe(fixedB.id);
    expect(approved.delegation_id).toBeNull();
    expect((await checkComplete(created.id)).ok).toBe(true);
  });
});

describe('可視性 (WP §7-10 / ADR-0025 §5)', () => {
  it('代理者には委任者宛ての承認待ちだけが見える。ほかの承認待ち・詳細は 404 のまま', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegateX.id);
    // 別の承認者宛ての申請(委任の無い他人)。
    const other = await createRequest(requester, await publishItem({ approverId: fixedB.id }), {
      approverId: fixedB.id,
    });

    const list = await listFor(delegateX);
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([created.id]);
    expect(list.items[0].delegated).toBe(true);
    const detail = await detailFor(delegateX, created.id);
    expect(detail.currentDelegation).toMatchObject({ delegatorId: fixedA.id });
    await expectProblem(detailFor(delegateX, other.id), 404);
  });

  it('委任者が申請者である申請・委任者が承認済みの過去の申請は見えない', async () => {
    // 委任者 fixedA が申請者。
    const ownItem = await publishItem({ approverId: fixedB.id });
    const ownRequest = await createRequest(fixedA, ownItem, { approverId: fixedB.id });
    const firstDelegation = await createDelegation(fixedA, delegateX.id);
    await expectProblem(detailFor(delegateX, ownRequest.id), 404);
    // 同じ委任者の期間は重ならないため、次の委任の前に取り消す。
    await revokeDelegation(fixedA, firstDelegation.id);

    // 委任者が既に承認した申請(現在の承認待ちは次の段の承認者)。
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const delegation = await createDelegation(fixedA, delegateX.id);
    await decide(fixedA, created.id, await currentVersion(created.id));
    await expectProblem(detailFor(delegateX, created.id), 404);
    expect((await delegationRows()).find((row) => row.id === delegation.id)).toBeDefined();
  });

  it('委任が無効になると見えなくなる(取消・代理者の資格喪失)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const delegation = await createDelegation(fixedA, delegateX.id);
    expect((await detailFor(delegateX, created.id)).request.id).toBe(created.id);
    await revokeDelegation(fixedA, delegation.id);
    await expectProblem(detailFor(delegateX, created.id), 404);

    const second = await createDelegation(fixedA, delegateY.id, {
      startsAt: iso(-MINUTE),
      endsAt: iso(HOUR),
    });
    expect(second.state).toBe('active');
    expect((await detailFor(delegateY, created.id)).request.id).toBe(created.id);
    await expireBinding(delegateY.id, 'approver');
    await expectProblem(detailFor(delegateY, created.id), 404);
  });

  it('代理者に、委任者宛ての承認依頼が受信箱に出る(自分の代理であることが分かる)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegateX.id);
    const inboxResult = await run(() =>
      inbox.list(delegateX.auth, {
        kind: 'all',
        q: '',
        unread: '0',
        unassigned: '0',
        page: '1',
      }),
    );
    const item = inboxResult.items.find((entry) => entry.id === created.id);
    expect(item).toBeDefined();
    expect(item?.delegated).toBe(true);
    expect(item?.scopeLabel).toContain('代理');
  });
});

describe('同時実行: 取消と代理者の決定 (WP §7-11)', () => {
  it('取消と決定が同時に起きても、取消後の決定は成立しない(直列化される)', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ruleId = await createRule([fixedStep(fixedA.id)]);
      const itemId = await publishItem({ ruleId });
      const created = await createRequest(requester, itemId);
      const delegation = await createDelegation(fixedA, delegateX.id);
      const results = await Promise.allSettled([
        decide(delegateX, created.id, await currentVersion(created.id)),
        revokeDelegation(fixedA, delegation.id),
      ]);
      const decision = results[0]!;
      const revoke = results[1]!;
      // 取消は必ず成立する(決定と同時でも、決定の後に取り消せる)。
      expect(revoke.status).toBe('fulfilled');
      const step = (await stepRows(created.id))[0]!;
      const revocation = (await delegationRows()).find((row) => row.id === delegation.id)!;
      expect(revocation.revoked_at).toBeInstanceOf(Date);
      if (decision.status === 'fulfilled') {
        // 決定が先に成立した場合は、決定の時刻が取消より前で、承認済みのまま有効である。
        expect(step.state).toBe('approved');
        expect(step.decided_by).toBe(delegateX.id);
        expect(step.decided_at.getTime()).toBeLessThanOrEqual(revocation.revoked_at.getTime());
        expect((await checkComplete(created.id)).ok).toBe(true);
      } else {
        // 取消が先に成立した場合は、決定は成立せず、ステップは pending のままである。
        const status = (decision.reason as { status?: number }).status;
        expect([403, 404]).toContain(status);
        expect(step.state).toBe('pending');
        expect(step.decided_by).toBeNull();
        expect(step.delegation_id).toBeNull();
      }
      await cleanOrgData();
      await enableRouting(true);
    }
  }, 60_000);
});

describe('承認の通知の宛先 (WP §7-13 / ADR-0025 §5)', () => {
  it('依頼の通知が、配送の時点で有効な委任の代理者へも届く', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    await createDelegation(fixedA, delegateX.id);
    const created = await createRequest(requester, itemId);
    const [event] = await outboxByType('approval.notice.requested');
    const delivered = await deliver(event!);
    const recipients = delivered.sender.sent.map((mail) => mail.to).sort();
    expect(recipients).toEqual(
      [
        (await emailOf(fixedA.id)).toLowerCase(),
        (await emailOf(delegateX.id)).toLowerCase(),
      ].sort(),
    );
    expect(delivered.sender.sent.every((mail) => mail.linkPath === `/requests/${created.id}`)).toBe(
      true,
    );
    // 件名・リンクに申請の入力値・理由・個人データを載せない。
    for (const mail of delivered.sender.sent) {
      expect(mail.subject).not.toContain('合成: 代理承認');
      expect(mail.subject).not.toContain('WP020');
      expect(mail.linkPath).not.toContain('reason');
    }
  });

  it('資格を失った代理者へは届かない(期間前・取消済みも届かない)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const delegation = await createDelegation(fixedA, delegateY.id);
    const created = await createRequest(requester, itemId);
    const [event] = await outboxByType('approval.notice.requested');
    await revokeDelegation(fixedA, delegation.id);
    const delivered = await deliver(event!);
    expect(delivered.sender.sent.map((mail) => mail.to)).toEqual([
      (await emailOf(fixedA.id)).toLowerCase(),
    ]);

    // 取消しない委任で、代理者が approver ロールを失った場合。
    const secondItem = await publishItem({ ruleId });
    await createDelegation(fixedA, delegateZ.id);
    const second = await createRequest(requester, secondItem);
    const events = await outboxByType('approval.notice.requested');
    const secondEvent = events.find((row) => row.payload.requestId === second.id)!;
    await expireBinding(delegateZ.id, 'approver');
    const delivered2 = await deliver(secondEvent);
    expect(delivered2.sender.sent.map((mail) => mail.to)).toEqual([
      (await emailOf(fixedA.id)).toLowerCase(),
    ]);
    expect(created.id).not.toBe(second.id);
  });

  it('委任の作成・取消の通知は、委任者と代理者に届き、件名・リンク・payload に入力値を載せない', async () => {
    const created = await createDelegation(fixedA, delegateX.id);
    const [createdEvent] = await outboxByType('approval.delegation.created');
    const deliveredCreated = await deliver(createdEvent!);
    const tos = deliveredCreated.sender.sent.map((mail) => mail.to).sort();
    expect(tos).toEqual(
      [
        (await emailOf(fixedA.id)).toLowerCase(),
        (await emailOf(delegateX.id)).toLowerCase(),
      ].sort(),
    );
    for (const mail of deliveredCreated.sender.sent) {
      expect(mail.subject).toBe('[SOLVI] 代理承認の委任を作成しました');
      expect(mail.linkPath).toBe('/approvals/delegations');
      expect(mail.subject).not.toContain('WP020');
      expect(mail.subject).not.toContain('合成');
    }
    expect(Object.keys(createdEvent!.payload)).toEqual(['delegationId']);
    expect(createdEvent!.payload.delegationId).toBe(created.id);

    await revokeDelegation(fixedA, created.id, '合成: 取消の理由は通知に載せない');
    const [revokedEvent] = await outboxByType('approval.delegation.revoked');
    const deliveredRevoked = await deliver(revokedEvent!);
    for (const mail of deliveredRevoked.sender.sent) {
      expect(mail.subject).toBe('[SOLVI] 代理承認の委任を取り消しました');
      expect(mail.subject).not.toContain('取消の理由');
      expect(mail.linkPath).toBe('/approvals/delegations');
    }
    expect(Object.keys(revokedEvent!.payload)).toEqual(['delegationId']);
  });
});

describe('追記専用とRLS (WP §7-12): アプリケーションロール', () => {
  const asApp = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  it('委任の行は DELETE できず、取消の3列以外の UPDATE と取消の書き換えも拒否される', async () => {
    const created = await createDelegation(fixedA, delegateX.id);
    let deleteError: unknown;
    try {
      await asApp((client) =>
        client.query('DELETE FROM approval_delegation WHERE id=$1', [created.id]),
      );
    } catch (error) {
      deleteError = error;
    }
    expect(deleteError).toBeDefined();
    // アプリケーションロールには DELETE の権限を与えない(42501)。
    expect((deleteError as { code?: string }).code).toBe('42501');
    // 所有者(トリガは有効なまま)の DELETE もトリガで拒否する。
    let ownerDeleteError: unknown;
    try {
      await q('DELETE FROM approval_delegation WHERE id=$1', [created.id]);
    } catch (error) {
      ownerDeleteError = error;
    }
    expect(ownerDeleteError).toBeDefined();
    expect((ownerDeleteError as { code?: string }).code).toBe('23514');

    let updateError: unknown;
    try {
      await asApp((client) =>
        client.query('UPDATE approval_delegation SET delegate_id=$2 WHERE id=$1', [
          created.id,
          delegateY.id,
        ]),
      );
    } catch (error) {
      updateError = error;
    }
    expect(updateError).toBeDefined();
    expect((updateError as { code?: string }).code).toBe('23514');

    await revokeDelegation(fixedA, created.id);
    let rewriteError: unknown;
    try {
      await asApp((client) =>
        client.query('UPDATE approval_delegation SET revoke_reason=$2 WHERE id=$1', [
          created.id,
          '書き換え',
        ]),
      );
    } catch (error) {
      rewriteError = error;
    }
    expect(rewriteError).toBeDefined();
    expect((rewriteError as { code?: string }).code).toBe('23514');
  });

  it('他組織の委任はアプリケーションロールから読めない。新しい RLS の例外は無い', async () => {
    const created = await createDelegation(fixedA, delegateX.id);
    const own = await asApp((client) =>
      client.query('SELECT id FROM approval_delegation WHERE id=$1', [created.id]),
    );
    expect(own.rowCount).toBe(1);
    const foreign = await asApp((client) =>
      client.query('SELECT id FROM approval_delegation WHERE organization_id=$1', [otherOrg]),
    );
    expect(foreign.rowCount).toBe(0);
    const policies = (
      await q(
        `SELECT policyname FROM pg_policies
          WHERE schemaname='public' AND tablename='approval_delegation'`,
      )
    ).rows as Array<{ policyname: string }>;
    expect(policies).toHaveLength(1);
    const sweep = (
      await q(
        `SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname='public' AND policyname='organization_approval_sweep_lookup'`,
      )
    ).rows[0].n;
    expect(sweep).toBe(1);
  });

  it('委任のIDは、決定者が承認者と同じステップには入らない(CHECK)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const delegation = await createDelegation(fixedA, delegateX.id);
    await expect(
      q(`UPDATE local_request_approval SET decided_by=$2, delegation_id=$3 WHERE request_id=$1`, [
        created.id,
        fixedA.id,
        delegation.id,
      ]),
    ).rejects.toBeDefined();
  });
});

describe('実行前検証 (WP §7-9 / ADR-0025 §4)', () => {
  async function approvedDelegatedRequest() {
    const ruleId = await createRule([fixedStep(fixedA.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    const delegation = await createDelegation(fixedA, delegateX.id);
    await decide(delegateX, created.id, await currentVersion(created.id));
    const step = (await stepRows(created.id))[0]!;
    return { requestId: created.id as string, delegation, step };
  }

  it('代理で承認されたステップは、委任の取消・期間の終了・資格の喪失のあとも有効である', async () => {
    const { requestId, delegation } = await approvedDelegatedRequest();
    expect((await checkComplete(requestId)).ok).toBe(true);
    await revokeDelegation(fixedA, delegation.id);
    expect((await checkComplete(requestId)).ok).toBe(true);
    await deactivateUser(delegateX.id);
    await expireBinding(fixedA.id);
    const result = await checkComplete(requestId);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('委任のIDの欠落・委任者や代理者の不一致・期間外・取消より後の決定で失敗する', async () => {
    const { requestId, delegation, step } = await approvedDelegatedRequest();
    const failWith = async (expected: string) => {
      const result = await checkComplete(requestId);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe(expected);
    };

    // 委任のIDの欠落。
    await q('UPDATE local_request_approval SET delegation_id=NULL WHERE id=$1', [step.id]);
    await failWith('delegation_missing');
    await q('UPDATE local_request_approval SET delegation_id=$2 WHERE id=$1', [
      step.id,
      delegation.id,
    ]);

    // 委任者の不一致。
    await tamperDelegation('UPDATE approval_delegation SET delegator_id=$2 WHERE id=$1', [
      delegation.id,
      fixedB.id,
    ]);
    await failWith('delegation_mismatch');
    await tamperDelegation('UPDATE approval_delegation SET delegator_id=$2 WHERE id=$1', [
      delegation.id,
      fixedA.id,
    ]);

    // 代理者の不一致。
    await tamperDelegation('UPDATE approval_delegation SET delegate_id=$2 WHERE id=$1', [
      delegation.id,
      delegateY.id,
    ]);
    await failWith('delegation_mismatch');
    await tamperDelegation('UPDATE approval_delegation SET delegate_id=$2 WHERE id=$1', [
      delegation.id,
      delegateX.id,
    ]);

    // 期間外(決定が開始より前)。
    const original = (await delegationRows())[0]!;
    await q('UPDATE local_request_approval SET decided_at=$2 WHERE id=$1', [
      step.id,
      new Date(original.starts_at.getTime() - HOUR),
    ]);
    await failWith('delegation_out_of_period');

    // 期間外(決定が終了以後)。
    await q('UPDATE local_request_approval SET decided_at=$2 WHERE id=$1', [
      step.id,
      new Date(original.ends_at.getTime() + MINUTE),
    ]);
    await failWith('delegation_out_of_period');

    // 取消より後の決定。
    await q('UPDATE local_request_approval SET decided_at=clock_timestamp() WHERE id=$1', [
      step.id,
    ]);
    await revokeDelegation(fixedA, delegation.id);
    // 取消より後の決定時刻にする(取消の記録は書き換えられないため、決定時刻を後ろへ動かす)。
    await q('UPDATE local_request_approval SET decided_at=clock_timestamp() WHERE id=$1', [
      step.id,
    ]);
    await failWith('delegation_revoked');
  });

  it('決定者が申請者本人・別の段と同じ人である記録は失敗する', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, await currentVersion(created.id));
    await decide(fixedB, created.id, await currentVersion(created.id));
    const steps = await stepRows(created.id);
    expect((await checkComplete(created.id)).ok).toBe(true);

    await q('UPDATE local_request_approval SET decided_by=$2 WHERE id=$1', [
      steps[0]!.id,
      requester.id,
    ]);
    const self = await checkComplete(created.id);
    expect(!self.ok && self.reason).toBe('decided_by_self_approval');

    await q('UPDATE local_request_approval SET decided_by=$2 WHERE id=$1', [
      steps[0]!.id,
      fixedA.id,
    ]);
    await q('UPDATE local_request_approval SET decided_by=$2 WHERE id=$1', [
      steps[1]!.id,
      fixedA.id,
    ]);
    const duplicate = await checkComplete(created.id);
    expect(!duplicate.ok && duplicate.reason).toBe('decided_by_duplicate');
  });
});

describe('委任の状態の導出(純粋関数の境界)', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  it('取消を最優先し、値が読めない場合は unknown にする', () => {
    expect(
      delegationStateFor({
        startsAt: new Date('2026-11-14T00:00:00Z'),
        endsAt: new Date('2026-11-16T00:00:00Z'),
        revokedAt: now,
        delegateEligible: false,
        now,
      }),
    ).toBe('revoked');
    expect(
      delegationStateFor({
        startsAt: '2026-11-14',
        endsAt: new Date('2026-11-16T00:00:00Z'),
        revokedAt: null,
        delegateEligible: true,
        now,
      }),
    ).toBe('unknown');
    expect(
      delegationStateFor({
        startsAt: new Date('2026-11-14T00:00:00Z'),
        endsAt: new Date('2026-11-16T00:00:00Z'),
        revokedAt: null,
        delegateEligible: false,
        now,
      }),
    ).toBe('delegate_ineligible');
  });
});
