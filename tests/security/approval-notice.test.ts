/**
 * WP-P4-APR-019 段階A/B: 承認の通知・期限切れ・承認者不在の検知(TL-02 / TL-04 / TL-06 / TL-16)。
 *
 * - 依頼の通知は、段が pending になる4つの契機でステップごとに1回だけ積む。
 * - 期限前・期限切れ・承認者不在の通知は、組織1つ分の定期処理で1回だけ積む。
 * - 期限切れの行は遷移表の `expire` を通し、`approval.expired` を1回だけ記録する。
 * - 行が pending のまま期限を過ぎた状態と expired になった状態で、既存の応答を同じにする。
 * - 通知の件名・リンク・Outbox の payload に申請の入力値・個人データを載せない。
 * - 組織の一覧だけを、登録した読み取り専用の例外(`app.approval_sweep`)で読む。
 *   業務テーブルは越境させず、組織を1つずつ処理する(02.18 §3.6 / DL-063)。
 * - 候補の抽出は、通知済みのステップを除く(上限で未通知を押し出さない)。
 *
 * 実行先は使い捨てDB(名前に `wp019` と `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, newContext, runWithContext, type Logger } from '@solvi/shared';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { type ApprovalStepRow } from '../../services/api/src/modules/catalog/approval-state.js';
import {
  checkApprovalComplete,
  assertApprovalComplete,
} from '../../services/api/src/modules/catalog/approval-assertion.js';
import { hash } from '../../services/api/src/modules/catalog/snapshot-hash.js';
import { ApprovalRuleController } from '../../services/api/src/modules/catalog/approval-rule.routes.js';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import { InboxController } from '../../services/api/src/modules/inbox/inbox.routes.js';
import { NotificationService } from '../../services/api/src/modules/notification/notification.service.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import { ApprovalNoticeSweeper } from '../../services/api/src/modules/catalog/approval-notice-sweep.js';
import { recordApprovalNotice } from '../../services/api/src/modules/catalog/approval-notice.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import type { ApprovalRuleStep } from '@solvi/shared/catalog';
import { cleanAuditData } from '../support/cleanup.js';

const ROOT = join(__dirname, '../..');
const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);
const HOUR = 3_600_000;
const silent: Logger = createLogger({
  service: 'wp019-notice',
  level: 'error',
  env: 'test',
  sink: () => undefined,
});

let pool: pg.Pool;
let admin: pg.Client;
let rules: ApprovalRuleController;
let catalogAdmin: CatalogAdminController;
let catalog: CatalogController;
let inbox: InboxController;

let org: string;
let otherOrg: string;
let deptPrimary: string;

type Person = { id: string; auth: AuthenticatedRequest; email: string };
let adminUser: Person;
let secondAdmin: Person;
let stoppedAdmin: Person;
let expiredAdmin: Person;
let requester: Person;
let manager: Person;
let manager2: Person;
let fixedA: Person;
let fixedB: Person;
let agent: Person;
let otherUser: Person;
let otherAdmin: Person;
let otherRequester: Person;
let otherApprover: Person;
let otherApprover2: Person;

const made = { users: [] as string[], orgs: [] as string[] };
let sequence = 0;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

function authFor(userId: string, roles: RoleCode[], organizationId = org): AuthenticatedRequest {
  return {
    userId,
    sessionId: `wp019-notice-${userId.slice(0, 8)}`,
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

async function makeUser(
  label: string,
  roles: RoleCode[],
  options: {
    status?: 'active' | 'deactivated';
    expired?: boolean;
    organizationId?: string;
  } = {},
): Promise<Person> {
  const organizationId = options.organizationId ?? org;
  const id = randomUUID();
  const email = `wp019-notice-${label}-${id.slice(0, 8)}@example.test`;
  await q(
    `INSERT INTO app_user (id, primary_email, display_name, status, deactivated_at, created_via)
     VALUES ($1, $2, $3, $4, $5, 'admin')`,
    [
      id,
      email,
      `WP019 ${label}`,
      options.status ?? 'active',
      options.status === 'deactivated' ? new Date() : null,
    ],
  );
  made.users.push(id);
  for (const role of roles)
    await q(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = $4), $4, $5, 'manual', $6, $7)`,
      [
        randomUUID(),
        id,
        role,
        role === 'platform_admin' ? 'platform' : 'org',
        role === 'platform_admin' ? null : organizationId,
        PAST,
        options.expired ? new Date(Date.now() - HOUR) : null,
      ],
    );
  await q('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
    organizationId,
    id,
  ]);
  return { id, auth: authFor(id, roles, organizationId), email };
}

async function makeDepartment(label: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1,$2,$3,$4,NULL)`,
    [id, org, `wp019-notice-${label}-${SUFFIX}`, `WP019 ${label} (合成)`],
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

async function expectProblem(
  promise: Promise<unknown>,
  status: number,
  messageParts: string[] = [],
): Promise<Error & { status?: number; type?: string; errors?: unknown }> {
  let caught: (Error & { status?: number; type?: string; errors?: unknown }) | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { status?: number; type?: string; errors?: unknown };
  }
  expect(caught, '拒否されるべき操作が成功した').toBeDefined();
  expect(caught?.status, caught?.message).toBe(status);
  const text = `${caught?.message ?? ''} ${JSON.stringify(caught?.errors ?? [])}`;
  for (const part of messageParts) expect(text).toContain(part);
  return caught!;
}

const nextCode = () => `wp019-notice-${SUFFIX}-${++sequence}`;

const fixedStep = (approverId: string) => ({ type: 'fixed' as const, approverId });
const managerStep = (onUnresolved: 'department_head' | 'reject' = 'reject') => ({
  type: 'manager' as const,
  onUnresolved,
});

async function createRule(
  steps: ApprovalRuleStep[],
  code = nextCode(),
  person: Person = adminUser,
): Promise<string> {
  const created = await run(() => rules.create(person.auth, { code, name: `合成 ${code}`, steps }));
  return created.body.rule.id as string;
}

function definition(approval: { ruleId?: string; approverId?: string }) {
  return {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成対象',
    allowedDurations: [7],
    maxReasonLength: 2000,
    fields: [
      { key: 'employee_no', label: '社員番号', required: false, type: 'text', maxLength: 100 },
      { key: 'job_title', label: '役職', required: false, type: 'text', maxLength: 100 },
      { key: 'workplace', label: '勤務地', required: false, type: 'text', maxLength: 100 },
    ],
    approval,
  };
}

async function publishItem(
  approval: {
    ruleId?: string;
    approverId?: string;
  },
  person: Person = adminUser,
): Promise<string> {
  const created = await run(() =>
    catalogAdmin.create(person.auth, {
      code: `wp019-notice-item-${SUFFIX}-${++sequence}`,
      title: '合成 通知',
      description: '合成',
      definition: definition(approval),
      creationKey: randomUUID(),
    }),
  );
  const id = created.id as string;
  await run(() =>
    catalogAdmin.publication(person.auth, id, { expectedVersion: 1, state: 'published' }),
  );
  return id;
}

async function enableRouting(enabled = true, person: Person = adminUser): Promise<void> {
  await run(() => rules.updateSettings(person.auth, { enabled }));
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
      reason: '合成: WP019 の通知',
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

const newSweeper = (batchLimit?: number) =>
  new ApprovalNoticeSweeper(pool, silent, batchLimit === undefined ? {} : { batchLimit });

const sweep = (organizationId: string, now: Date, batchLimit?: number) =>
  run(() => newSweeper(batchLimit).runOnce({ organizationId, now }));

const sweepAll = (now: Date, batchLimit?: number) =>
  run(() => newSweeper(batchLimit).sweepAllOnce(now));

const requestRow = async (id: string) =>
  (await q('SELECT * FROM local_service_request WHERE id=$1', [id])).rows[0];
const revisionRow = async (id: string, revision = 1) =>
  (
    await q('SELECT * FROM local_request_revision WHERE request_id=$1 AND revision=$2', [
      id,
      revision,
    ])
  ).rows[0];
const stepRows = async (id: string, revision?: number) =>
  (
    await q(
      `SELECT * FROM local_request_approval
        WHERE request_id=$1${revision === undefined ? '' : ' AND revision=$2'}
        ORDER BY revision, route_generation, step_no, id`,
      revision === undefined ? [id] : [id, revision],
    )
  ).rows as ApprovalStepRow[];
const noticeRows = async (organizationId: string, approvalId?: string) =>
  (
    await q(
      `SELECT * FROM local_request_approval_notice
        WHERE organization_id=$1${approvalId === undefined ? '' : ' AND approval_id=$2'}
        ORDER BY created_at, approval_id, kind`,
      approvalId === undefined ? [organizationId] : [organizationId, approvalId],
    )
  ).rows as Array<{ approval_id: string; kind: string; organization_id: string }>;
const outboxForRequest = async (requestId: string) =>
  (
    await q(
      `SELECT id, event_type, organization_id, payload FROM outbox_event
        WHERE payload->>'requestId'=$1 ORDER BY event_type`,
      [requestId],
    )
  ).rows as Array<{
    id: string;
    event_type: string;
    organization_id: string;
    payload: Record<string, string>;
  }>;
const auditFor = async (requestId: string, eventType?: string) =>
  (
    await q(
      `SELECT event_type, actor_type, actor_display, action, before_state, after_state,
              target_id, approval_ref
         FROM audit_event
        WHERE target_id=$1${eventType ? ' AND event_type=$2' : ''}
        ORDER BY occurred_at, event_id`,
      eventType ? [requestId, eventType] : [requestId],
    )
  ).rows;

const setExpiry = async (approvalId: string, at: Date): Promise<void> => {
  await q('UPDATE local_request_approval SET expires_at=$2 WHERE id=$1', [approvalId, at]);
};

const currentStep = async (requestId: string) => {
  const request = await requestRow(requestId);
  return (await stepRows(requestId)).find((step) => step.id === request.current_approval_id)!;
};

async function expireBinding(userId: string, organizationId = org): Promise<void> {
  await q(
    `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
      WHERE organization_id=$1 AND user_id=$2 AND valid_until IS NULL`,
    [organizationId, userId],
  );
}

async function restoreBinding(userId: string, organizationId = org): Promise<void> {
  await q(
    `UPDATE role_binding SET valid_until=NULL
      WHERE organization_id=$1 AND user_id=$2`,
    [organizationId, userId],
  );
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

type Delivered = { sender: RecordingEmailSender; sent: number; skipped: number };

/** 1つの Outbox イベントを、その組織の文脈で配送する(ディスパッチャと同じ形)。 */
async function deliver(event: {
  id: string;
  event_type: string;
  organization_id: string;
  payload: Record<string, string>;
}): Promise<Delivered> {
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

async function policyNames(): Promise<string[]> {
  return (
    await q(`SELECT policyname FROM pg_policies WHERE schemaname='public' ORDER BY policyname`)
  ).rows.map((row) => row.policyname as string);
}

async function clearNotices(): Promise<void> {
  await admin.query(
    'ALTER TABLE local_request_approval_notice DISABLE TRIGGER local_request_approval_notice_immutable',
  );
  try {
    await admin.query('DELETE FROM local_request_approval_notice');
  } finally {
    await admin.query(
      'ALTER TABLE local_request_approval_notice ENABLE TRIGGER local_request_approval_notice_immutable',
    );
  }
}

async function cleanRulesFor(organizationId: string): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query('SET CONSTRAINTS approval_rule_current_revision_fk DEFERRED');
    await admin.query(
      'ALTER TABLE approval_rule_revision DISABLE TRIGGER approval_rule_revision_immutable',
    );
    await q('DELETE FROM approval_rule_revision WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM approval_rule WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM org_approval_setting WHERE organization_id=$1', [organizationId]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await admin.query(
      'ALTER TABLE approval_rule_revision ENABLE TRIGGER approval_rule_revision_immutable',
    );
  }
}

async function cleanOrgData(organizationId = org): Promise<void> {
  await clearNotices();
  await cleanAuditData(admin, `organization_id = '${organizationId}'`);
  await admin.query('BEGIN');
  try {
    await q('DELETE FROM notification WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM outbox_event WHERE organization_id=$1', [organizationId]);
    await admin.query(
      'ALTER TABLE local_request_route_generation DISABLE TRIGGER local_request_route_generation_immutable',
    );
    try {
      await q('DELETE FROM local_request_route_generation WHERE organization_id=$1', [
        organizationId,
      ]);
    } finally {
      await admin.query(
        'ALTER TABLE local_request_route_generation ENABLE TRIGGER local_request_route_generation_immutable',
      );
    }
    await q('DELETE FROM local_simulation_receipt WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM local_request_checklist_progress WHERE organization_id=$1', [
      organizationId,
    ]);
    await q('DELETE FROM local_request_approval WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM local_request_revision WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM local_service_request WHERE organization_id=$1', [organizationId]);
    await q(
      'DELETE FROM ticket_comment WHERE ticket_id IN (SELECT id FROM ticket WHERE organization_id=$1)',
      [organizationId],
    );
    await q(
      'DELETE FROM ticket_assignment WHERE ticket_id IN (SELECT id FROM ticket WHERE organization_id=$1)',
      [organizationId],
    );
    await q(
      'DELETE FROM ticket_attachment WHERE ticket_id IN (SELECT id FROM ticket WHERE organization_id=$1)',
      [organizationId],
    );
    await q('DELETE FROM ticket_relation WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM ticket WHERE organization_id=$1', [organizationId]);
    await q('DELETE FROM ticket_number_counter WHERE organization_id=$1', [organizationId]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  await admin.query(
    'ALTER TABLE local_catalog_revision DISABLE TRIGGER local_catalog_revision_immutable',
  );
  try {
    await q('DELETE FROM local_catalog_revision WHERE organization_id=$1', [organizationId]);
  } finally {
    await admin.query(
      'ALTER TABLE local_catalog_revision ENABLE TRIGGER local_catalog_revision_immutable',
    );
  }
  await q('DELETE FROM local_catalog_item WHERE organization_id=$1', [organizationId]);
  await cleanRulesFor(organizationId);
}

async function resetProfiles(): Promise<void> {
  await q(
    `UPDATE org_member_profile SET manager_user_id=NULL, primary_department_id=NULL
      WHERE organization_id=$1`,
    [org],
  );
  await q(`UPDATE app_user SET status='active', deactivated_at=NULL WHERE id=ANY($1::uuid[])`, [
    made.users,
  ]);
  await q(
    `UPDATE role_binding SET valid_until=NULL
      WHERE organization_id=$1 AND user_id=ANY($2::uuid[])`,
    [org, made.users],
  );
  // 組織Bの束縛も検査の前提に戻す(2組織の巡回の検査で期限を切る)。
  if (otherOrg)
    await q(
      `UPDATE role_binding SET valid_until=NULL
        WHERE organization_id=$1 AND user_id=ANY($2::uuid[])`,
      [otherOrg, made.users],
    );
  for (const person of [requester, manager, manager2, fixedA, fixedB, agent])
    await setDepartment(person.id, deptPrimary);
  await setManager(requester.id, manager.id);
  await setManager(manager.id, null);
  // 「停止された管理者」「期限の切れた管理者」は、この検査の前提なので毎回戻す。
  await q(`UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1`, [
    stoppedAdmin.id,
  ]);
  await q(
    `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
      WHERE organization_id=$1 AND user_id=$2`,
    [org, expiredAdmin.id],
  );
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const client of [pool, admin]) {
    const name = (await client.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!name.includes('wp019') || !name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は wp019 の使い捨てDBではありません。中止します`);
    }
  }
  rules = new ApprovalRuleController(pool, true);
  catalogAdmin = new CatalogAdminController(pool, true);
  catalog = new CatalogController(
    pool,
    {} as ConstructorParameters<typeof CatalogController>[1],
    true,
  );
  inbox = new InboxController(pool, true);

  org = randomUUID();
  made.orgs.push(org);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    org,
    `wp019-notice-${SUFFIX}`,
    'WP019 通知 (合成)',
  ]);
  deptPrimary = await makeDepartment('primary');

  adminUser = await makeUser('admin', ['org_admin']);
  secondAdmin = await makeUser('admin2', ['org_admin']);
  stoppedAdmin = await makeUser('stopped-admin', ['org_admin'], { status: 'deactivated' });
  expiredAdmin = await makeUser('expired-admin', ['org_admin'], { expired: true });
  requester = await makeUser('requester', ['requester']);
  manager = await makeUser('manager', ['requester']);
  manager2 = await makeUser('manager2', ['requester']);
  fixedA = await makeUser('fixed-a', ['approver']);
  fixedB = await makeUser('fixed-b', ['approver']);
  agent = await makeUser('agent', ['agent']);
  await resetProfiles();

  // 他組織(組織境界の検査用)。
  otherOrg = randomUUID();
  made.orgs.push(otherOrg);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    otherOrg,
    `wp019-notice-other-${SUFFIX}`,
    'WP019 他組織 (合成)',
  ]);
  otherUser = await makeUser('other', ['requester']);
  await q('UPDATE role_binding SET organization_id=$2 WHERE user_id=$1 AND role_scope=$3', [
    otherUser.id,
    otherOrg,
    'org',
  ]);
  await q('DELETE FROM org_member_profile WHERE user_id=$1', [otherUser.id]);
  await q('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1,$2)', [
    otherOrg,
    otherUser.id,
  ]);
  // 2組織を1周で処理する検査用(組織B)。
  otherAdmin = await makeUser('other-admin', ['org_admin'], { organizationId: otherOrg });
  otherRequester = await makeUser('other-requester', ['requester'], {
    organizationId: otherOrg,
  });
  otherApprover = await makeUser('other-approver', ['approver'], { organizationId: otherOrg });
  otherApprover2 = await makeUser('other-approver-2', ['approver'], { organizationId: otherOrg });
}, 120_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanOrgData();
      await cleanOrgData(otherOrg);
      await q('DELETE FROM org_member_profile WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
      await q('DELETE FROM org_member_profile WHERE user_id=ANY($1::uuid[])', [made.users]);
      await q('DELETE FROM role_binding WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
      await q('DELETE FROM role_binding WHERE user_id=ANY($1::uuid[])', [made.users]);
      await q('DELETE FROM app_user WHERE id=ANY($1::uuid[])', [made.users]);
      for (const id of made.orgs) await cleanAuditData(admin, `organization_id = '${id}'`);
      await q('DELETE FROM department WHERE organization_id=ANY($1::uuid[])', [made.orgs]);
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
  await cleanOrgData(otherOrg);
  await resetProfiles();
  await enableRouting(true);
});

describe('Migration 0041: 通知の記録の表 (TL-04)', () => {
  it('**行が無ければ down → up の往復ができる。0040 から増えるポリシーはちょうど3件(0041 と 0042)**', async () => {
    const before = await policyNames();
    expect(before).toContain('local_request_approval_notice_isolation');
    expect(before).toContain('organization_approval_sweep_lookup');
    const down = migrate('down', '--to', '0040');
    expect(down.ok, down.output).toBe(true);
    expect(down.output).toContain('0041_local_request_approval_notice.sql');
    // 0042(代理承認)が後続に加わったため、0040 まで戻すとその分離ポリシーも外れる。
    expect(down.output).toContain('0042_approval_delegation.sql');
    const afterDown = await policyNames();
    // 0041 が足すのは、新しいテーブルの分離ポリシーと、組織一覧の例外の**2件**。
    // 0042 が足すのは、委任の表の分離ポリシーの**1件**。
    expect(before.filter((name) => !afterDown.includes(name)).sort()).toEqual([
      'approval_delegation_isolation',
      'local_request_approval_notice_isolation',
      'organization_approval_sweep_lookup',
    ]);
    expect(before.length).toBe(afterDown.length + 3);
    const tableGone = (
      await q(
        `SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname='public' AND tablename='local_request_approval_notice'`,
      )
    ).rows[0].n;
    expect(tableGone).toBe(0);
    const up = migrate('up');
    expect(up.ok, up.output).toBe(true);
    expect(await policyNames()).toEqual(before);
    const sweepPolicy = (
      await q(
        `SELECT cmd, qual FROM pg_policies
          WHERE schemaname='public' AND tablename='organization'
            AND policyname='organization_approval_sweep_lookup'`,
      )
    ).rows[0];
    expect(sweepPolicy).toMatchObject({ cmd: 'SELECT' });
    expect(sweepPolicy.qual).toContain("current_setting('app.approval_sweep'");
    expect(sweepPolicy.qual).toContain("= 'on'");
  }, 120_000);

  it('**行が1件でもあれば down を拒否する(前進修復)**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    expect(await noticeRows(org)).toHaveLength(1);
    const down = migrate('down', '--to', '0040');
    try {
      expect(down.ok).toBe(false);
      expect(down.output).toContain('0041 rollback refused');
      expect((await q(`SELECT 1 FROM schema_migration WHERE version='0041'`)).rowCount).toBe(1);
      expect(await noticeRows(org)).toHaveLength(1);
      expect(await currentStep(created.id)).toBeDefined();
    } finally {
      // 0042(代理承認)はデータが無いため先に巻き戻っている。0041 の拒否を確かめた後に戻す。
      const restored = migrate('up');
      expect(restored.ok, restored.output).toBe(true);
      expect((await q(`SELECT 1 FROM schema_migration WHERE version='0042'`)).rowCount).toBe(1);
    }
  }, 120_000);
});

describe('組織の一覧の例外: 登録制・読み取りだけ (02.18 §3.6 / DL-063)', () => {
  /** アプリケーションロールの接続で、指定のトランザクションを実行する。 */
  async function asApp<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('**フラグ無しでは organization が0件(fail closed)。フラグありで全組織のIDが読める**', async () => {
    const withoutFlag = await asApp(
      async (client) =>
        (await client.query('SELECT count(*)::int AS n FROM organization')).rows[0].n,
    );
    expect(withoutFlag).toBe(0);

    const withFlag = await asApp(async (client) => {
      await client.query("SELECT set_config('app.approval_sweep', 'on', true)");
      return (
        await client.query<{ id: string }>('SELECT id FROM organization ORDER BY id')
      ).rows.map((row) => row.id);
    });
    expect(withFlag).toEqual(expect.arrayContaining([org, otherOrg]));
    // 読むのは id だけである(他の列を SELECT しない)。
    const sweep = newSweeper();
    await expect(sweep.listOrganizationIds()).resolves.toEqual(withFlag);
  });

  it('**フラグが次のトランザクションへ残らない**(SET LOCAL)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.approval_sweep', 'on', true)");
      expect(
        (await client.query('SELECT count(*)::int AS n FROM organization')).rows[0].n,
      ).toBeGreaterThan(0);
      await client.query('COMMIT');

      await client.query('BEGIN');
      expect((await client.query('SELECT count(*)::int AS n FROM organization')).rows[0].n).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('**フラグを立てても、組織の文脈が無ければ業務テーブルは0件のまま**', async () => {
    // 検査の対象になる行を先に作る(この検査は空の表では何も証明しない)。
    const itemId = await publishItem({ approverId: fixedA.id });
    await createRequest(requester, itemId, { approverId: fixedA.id });
    // 検査の前提として、対象のテーブルに行があることを管理者接続で確かめる。
    // notification は配送の検査でしか作られないため、ここでは前提にしない
    // (フラグを立てても0件であることは下で必ず検査する)。
    for (const table of [
      'local_request_approval',
      'local_service_request',
      'local_request_approval_notice',
      'app_user',
      'role_binding',
      'outbox_event',
    ]) {
      const n = (await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      expect(n, `${table} に検査用の行がありません`).toBeGreaterThan(0);
    }

    for (const table of [
      'local_request_approval',
      'local_service_request',
      'local_request_approval_notice',
      'app_user',
      'role_binding',
      'outbox_event',
      'notification',
    ]) {
      const n = await asApp(async (client) => {
        await client.query("SELECT set_config('app.approval_sweep', 'on', true)");
        return (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      });
      expect(n, `${table} がフラグで越境して読めています`).toBe(0);
    }
  });

  it('**フラグを立てても、アプリケーションロールは organization を UPDATE できない**', async () => {
    const before = (await q('SELECT name FROM organization WHERE id=$1', [otherOrg])).rows[0];
    const outcome = await asApp(async (client) => {
      await client.query("SELECT set_config('app.current_org', $1, true)", [org]);
      await client.query("SELECT set_config('app.approval_sweep', 'on', true)");
      try {
        const result = await client.query(
          'UPDATE organization SET name = name WHERE id=$1 RETURNING id',
          [otherOrg],
        );
        return { rows: result.rowCount };
      } catch (error) {
        return { error: (error as { code?: string }).code ?? 'unknown' };
      }
    });
    // 0行(RLSで見えない)か、権限の拒否のどちらかである。
    expect('error' in outcome || outcome.rows === 0).toBe(true);
    expect((await q('SELECT name FROM organization WHERE id=$1', [otherOrg])).rows[0]).toEqual(
      before,
    );
  });
});

describe('依頼の通知: 段が pending になる4つの契機 (WP §7)', () => {
  async function requestedNotices(requestId: string) {
    const steps = await stepRows(requestId);
    const rows = await noticeRows(org);
    return steps.map(
      (step) =>
        rows.filter((row) => row.approval_id === step.id && row.kind === 'requested').length,
    );
  }

  it('**申請**: 最初のステップに1件だけ。Outbox は識別子だけを持つ', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const steps = await stepRows(created.id);
    expect(steps).toHaveLength(1);
    expect(await requestedNotices(created.id)).toEqual([1]);
    const events = await outboxForRequest(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('approval.notice.requested');
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['approvalId', 'requestId']);
    expect(events[0]!.payload.approvalId).toBe(steps[0]!.id);
    expect(events[0]!.payload.requestId).toBe(created.id);
  });

  it('**申請内容の変更**: 新しい版の最初のステップに1件だけ', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    await run(() =>
      catalog.edit(requester.auth, created.id, {
        expectedVersion: 1,
        reason: '合成: 内容の変更',
        durationDays: 7,
        approverId: fixedA.id,
      }),
    );
    expect(await requestedNotices(created.id)).toEqual([1, 1]);
    const events = await outboxForRequest(created.id);
    expect(events.map((event) => event.event_type)).toEqual([
      'approval.notice.requested',
      'approval.notice.requested',
    ]);
  });

  it('**前の段の承認**: 次のステップに1件だけ', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), fixedStep(fixedB.id)]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    expect(await requestedNotices(created.id)).toEqual([1, 1]);
  });

  it('**再割当**: 新しい世代のステップに1件だけ', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    await expireBinding(manager.id);
    await setManager(requester.id, manager2.id);
    await reassign(adminUser, created.id);
    const steps = await stepRows(created.id);
    const notices = await noticeRows(org);
    const newStep = steps.find((step) => step.route_generation === 2)!;
    expect(
      notices.filter((row) => row.approval_id === newStep.id && row.kind === 'requested'),
    ).toHaveLength(1);
    // 承認済みの段には依頼の通知を積み直さない。
    const approved = steps.find((step) => step.step_no === 1)!;
    expect(
      notices.filter((row) => row.approval_id === approved.id && row.kind === 'requested'),
    ).toHaveLength(1);
  });

  it('**リンクは申請の詳細**(依頼・期限前。承認者不在だけが再割当の画面)', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const step = (await stepRows(created.id))[0]!;
    const requested = (await outboxForRequest(created.id))[0]!;
    const deliveredRequested = await deliver(requested);
    expect(deliveredRequested.sender.sent.map((item) => item.linkPath)).toEqual([
      `/requests/${created.id}`,
    ]);

    const now = new Date();
    await setExpiry(step.id, new Date(now.getTime() + 23 * HOUR));
    await sweep(org, now);
    const expiring = (await outboxForRequest(created.id)).find(
      (event) => event.event_type === 'approval.notice.expiring',
    )!;
    const deliveredExpiring = await deliver(expiring);
    expect(deliveredExpiring.sender.sent.map((item) => item.linkPath)).toEqual([
      `/requests/${created.id}`,
    ]);
  });

  it('**同じステップに2件目は積まれない**(主キーで止め、Outbox も増やさない)', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const step = (await stepRows(created.id))[0]!;
    const before = (await outboxForRequest(created.id)).length;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
      const queued = await recordApprovalNotice(client, {
        organizationId: org,
        approvalId: step.id,
        requestId: created.id,
        kind: 'requested',
      });
      await client.query('COMMIT');
      expect(queued).toBe(false);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    expect((await outboxForRequest(created.id)).length).toBe(before);
    expect((await noticeRows(org, step.id)).filter((row) => row.kind === 'requested')).toHaveLength(
      1,
    );
  });
});

describe('期限前の通知 (WP §7)', () => {
  async function pendingRequest() {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const step = await currentStep(created.id);
    return { requestId: created.id, step };
  }

  it('**24時間より前は積まれない**', async () => {
    const { requestId, step } = await pendingRequest();
    const now = new Date();
    await setExpiry(step.id, new Date(now.getTime() + 25 * HOUR));
    const summary = await sweep(org, now);
    expect(summary.expiringQueued).toBe(0);
    expect(await noticeRows(org, step.id)).toHaveLength(1); // requested だけ
    expect((await outboxForRequest(requestId)).map((event) => event.event_type)).toEqual([
      'approval.notice.requested',
    ]);
  });

  it('**24時間以内で1件。もう1周しても増えない**', async () => {
    const { requestId, step } = await pendingRequest();
    const now = new Date();
    await setExpiry(step.id, new Date(now.getTime() + 23 * HOUR));
    expect((await sweep(org, now)).expiringQueued).toBe(1);
    expect((await sweep(org, now)).expiringQueued).toBe(0);
    const expiring = (await noticeRows(org, step.id)).filter((row) => row.kind === 'expiring');
    expect(expiring).toHaveLength(1);
    const events = (await outboxForRequest(requestId)).filter(
      (event) => event.event_type === 'approval.notice.expiring',
    );
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['approvalId', 'requestId']);
  });

  it('**同時に2周走らせても1件**', async () => {
    const { step } = await pendingRequest();
    const now = new Date();
    await setExpiry(step.id, new Date(now.getTime() + 23 * HOUR));
    const results = await Promise.all([sweep(org, now), sweep(org, now)]);
    expect(results.reduce((sum, result) => sum + result.expiringQueued, 0)).toBe(1);
    expect((await noticeRows(org, step.id)).filter((row) => row.kind === 'expiring')).toHaveLength(
      1,
    );
  });

  it('**決定済み・無効・期限切れのステップには積まれない**', async () => {
    // 決定済み
    const approvedItem = await publishItem({ approverId: fixedA.id });
    const approved = await createRequest(requester, approvedItem, { approverId: fixedA.id });
    const approvedStep = await currentStep(approved.id);
    await decide(fixedA, approved.id, 1, 'approve');
    await setExpiry(approvedStep.id, new Date(Date.now() + 23 * HOUR));
    // 無効(申請内容の変更で置き換えられた旧版のステップ)
    const editedItem = await publishItem({ approverId: fixedA.id });
    const edited = await createRequest(requester, editedItem, { approverId: fixedA.id });
    const oldStep = await currentStep(edited.id);
    await run(() =>
      catalog.edit(requester.auth, edited.id, {
        expectedVersion: 1,
        reason: '合成: 無効化',
        durationDays: 7,
        approverId: fixedA.id,
      }),
    );
    await setExpiry(oldStep.id, new Date(Date.now() + 23 * HOUR));
    // 期限切れ
    const expiredItem = await publishItem({ approverId: fixedA.id });
    const expired = await createRequest(requester, expiredItem, { approverId: fixedA.id });
    const expiredStep = await currentStep(expired.id);
    const now = new Date();
    await setExpiry(expiredStep.id, new Date(now.getTime() - HOUR));
    await sweep(org, now);
    await setExpiry(expiredStep.id, new Date(now.getTime() + 23 * HOUR));

    const summary = await sweep(org, now);
    expect(summary.expiringQueued).toBe(0);
    for (const step of [approvedStep, oldStep, expiredStep])
      expect(
        (await noticeRows(org, step.id)).filter((row) => row.kind === 'expiring'),
      ).toHaveLength(0);
  });
});

describe('期限切れ (WP §7)', () => {
  async function overdueRequest(options: { pastBy?: number } = {}) {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const step = await currentStep(created.id);
    await setExpiry(step.id, new Date(Date.now() - (options.pastBy ?? HOUR)));
    return { requestId: created.id, step };
  }

  it('**expired になり、`approval.expired` が1件、申請者への通知が1件**', async () => {
    const { requestId, step } = await overdueRequest();
    const now = new Date();
    const summary = await sweep(org, now);
    expect(summary.expired).toBe(1);
    expect(summary.expiredFailed).toBe(0);

    const after = await currentStep(requestId);
    expect(after.state).toBe('expired');
    // 申請の状態は変えない(期限切れは導出のまま)。
    expect((await requestRow(requestId)).state).toBe('pending');
    const audits = await auditFor(requestId, 'approval.expired');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: 'system',
      actor_display: 'approval_expiry',
      action: 'approval.expired',
      approval_ref: step.id,
    });
    expect(audits[0]!.before_state).toMatchObject({
      stepState: 'pending',
      requestState: 'pending',
      revision: 1,
      routeGeneration: 1,
      stepNo: 1,
    });
    expect(audits[0]!.after_state).toMatchObject({ stepState: 'expired' });
    // **入力値・理由を監査に載せない。**
    expect(JSON.stringify(audits[0])).not.toContain('WP019 の通知');
    const expiredNotices = (await noticeRows(org, step.id)).filter((row) => row.kind === 'expired');
    expect(expiredNotices).toHaveLength(1);
    expect(
      (await outboxForRequest(requestId)).filter(
        (event) => event.event_type === 'approval.notice.expired',
      ),
    ).toHaveLength(1);
  });

  it('**もう1周しても増えない**', async () => {
    const { requestId } = await overdueRequest();
    const now = new Date();
    expect((await sweep(org, now)).expired).toBe(1);
    expect((await sweep(org, now)).expired).toBe(0);
    expect((await sweep(org, now)).expired).toBe(0);
    expect(await auditFor(requestId, 'approval.expired')).toHaveLength(1);
    expect(
      (await outboxForRequest(requestId)).filter(
        (event) => event.event_type === 'approval.notice.expired',
      ),
    ).toHaveLength(1);
  });

  it('**期限切れの承認での決定・再割当・実行が拒否される**', async () => {
    const { requestId } = await overdueRequest();
    await sweep(org, new Date());
    await expectProblem(decide(fixedA, requestId, 1, 'approve'), 409);
    await expectProblem(reassign(adminUser, requestId), 409, ['expired']);
    // 実行前検証(作業チェックの更新)も失敗する。
    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, requestId, {
          requestRevision: 1,
          expectedVersion: 1,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
    expect((await currentStep(requestId)).state).toBe('expired');
  });

  it('**期限切れ×決定**: 状態と監査が二重にならない', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const step = await currentStep(created.id);
    // 決定はDBの現在時刻で判定する。定期処理には2秒先の時刻を渡し、
    // 決定が先に通った場合は期限切れが後から上書きしないことを見る。
    await setExpiry(step.id, new Date(Date.now() + 1_000));
    const future = new Date(Date.now() + 2_000);
    const results = await Promise.allSettled([
      decide(fixedA, created.id, 1, 'approve'),
      sweep(org, future),
    ]);
    const decided = results[0]!.status === 'fulfilled';
    const state = (await currentStep(created.id)).state;
    expect(['approved', 'expired']).toContain(state);
    expect(decided ? state === 'approved' : state === 'expired').toBe(true);
    const audits = await auditFor(created.id, 'approval.expired');
    expect(audits.length).toBeLessThanOrEqual(1);
    if (state === 'expired') expect(audits).toHaveLength(1);
    else expect(audits).toHaveLength(0);
  });

  it('**期限切れ×再割当**: 状態と監査が二重にならない', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    await expireBinding(manager.id);
    await setManager(requester.id, manager2.id);
    const step = await currentStep(created.id);
    await setExpiry(step.id, new Date(Date.now() - 1_000));
    const results = await Promise.allSettled([
      reassign(adminUser, created.id),
      sweep(org, new Date()),
    ]);
    // 再割当は期限切れなので必ず 409。期限切れは1回だけ。
    expect(results[0]!.status).toBe('rejected');
    const steps = await stepRows(created.id);
    expect(steps.filter((row) => row.state === 'pending')).toHaveLength(0);
    expect(await auditFor(created.id, 'approval.expired')).toHaveLength(1);
  });

  it('**監査の書込みに失敗したら、その1件だけを失敗させる**', async () => {
    const { requestId } = await overdueRequest();
    await admin.query(
      `CREATE OR REPLACE FUNCTION wp019_fail_expired_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
       BEGIN
         IF NEW.event_type = 'approval.expired' THEN
           RAISE EXCEPTION 'wp019_forced_audit_failure';
         END IF;
         RETURN NEW;
       END $f$`,
    );
    await admin.query(
      `CREATE TRIGGER wp019_fail_expired_audit BEFORE INSERT ON audit_event
         FOR EACH ROW EXECUTE FUNCTION wp019_fail_expired_audit()`,
    );
    try {
      const summary = await sweep(org, new Date());
      expect(summary.expired).toBe(0);
      expect(summary.expiredFailed).toBe(1);
      expect((await currentStep(requestId)).state).toBe('pending');
      expect(await noticeRows(org)).toHaveLength(1);
    } finally {
      await admin.query('DROP TRIGGER wp019_fail_expired_audit ON audit_event');
      await admin.query('DROP FUNCTION wp019_fail_expired_audit()');
    }
    expect((await sweep(org, new Date())).expired).toBe(1);
    expect((await currentStep(requestId)).state).toBe('expired');
  });
});

describe('承認者不在 (WP §7)', () => {
  async function unavailableStep() {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1, 'approve');
    await expireBinding(manager.id);
    const step = await currentStep(created.id);
    expect(step.approver_id).toBe(manager.id);
    return { requestId: created.id, step };
  }

  it('**有効な組織管理者の全員へ1件ずつ。停止・期限切れの管理者へは送らない**', async () => {
    const { requestId, step } = await unavailableStep();
    const before = {
      revision: await revisionRow(requestId),
      steps: await stepRows(requestId),
    };
    const now = new Date();
    const summary = await sweep(org, now);
    expect(summary.unavailableQueued).toBe(1);

    const notices = (await noticeRows(org, step.id)).filter(
      (row) => row.kind === 'approver_unavailable',
    );
    expect(notices).toHaveLength(1);

    const events = (await outboxForRequest(requestId)).filter(
      (event) => event.event_type === 'approval.notice.approver_unavailable',
    );
    expect(events).toHaveLength(1);
    const delivered = await deliver(events[0]!);
    // 有効な組織管理者は adminUser と secondAdmin の2人。
    expect(delivered.sent).toBe(2);
    expect(delivered.sender.sent.map((item) => item.to).sort()).toEqual(
      [adminUser.email, secondAdmin.email].sort(),
    );
    // 承認者不在だけは再割当の画面（組織管理者向け）を指す。申請の詳細には再割当の操作が無い。
    expect(delivered.sender.sent.map((item) => item.linkPath)).toEqual([
      '/ops/approvals',
      '/ops/approvals',
    ]);
    expect(delivered.sender.sent.some((item) => item.to === stoppedAdmin.email)).toBe(false);
    expect(delivered.sender.sent.some((item) => item.to === expiredAdmin.email)).toBe(false);

    // 経路・承認者・ステップを変えない(自動で差し替えない)。
    expect(await revisionRow(requestId)).toEqual(before.revision);
    expect(await stepRows(requestId)).toEqual(before.steps);
  });

  it('**組織管理者が0人なら積まない。記録も作らない**', async () => {
    const { requestId, step } = await unavailableStep();
    await expireBinding(adminUser.id);
    await expireBinding(secondAdmin.id);
    const now = new Date();
    const summary = await sweep(org, now);
    expect(summary.unavailableQueued).toBe(0);
    expect(summary.unavailableSkippedNoAdmin).toBe(1);
    expect(await noticeRows(org, step.id)).toHaveLength(1); // requested だけ
    expect(
      (await outboxForRequest(requestId)).filter(
        (event) => event.event_type === 'approval.notice.approver_unavailable',
      ),
    ).toHaveLength(0);
    // 管理者が戻れば、次の周で送れる。
    await restoreBinding(adminUser.id);
    await restoreBinding(secondAdmin.id);
    expect((await sweep(org, now)).unavailableQueued).toBe(1);
  });

  it('**もう1周しても増えない**', async () => {
    const { step } = await unavailableStep();
    const now = new Date();
    expect((await sweep(org, now)).unavailableQueued).toBe(1);
    expect((await sweep(org, now)).unavailableQueued).toBe(0);
    expect(
      (await noticeRows(org, step.id)).filter((row) => row.kind === 'approver_unavailable'),
    ).toHaveLength(1);
  });

  it('**期限内の pending のステップだけが対象**(期限切れは対象外)', async () => {
    const { step } = await unavailableStep();
    await setExpiry(step.id, new Date(Date.now() - 1_000));
    const summary = await sweep(org, new Date());
    expect(summary.unavailableQueued).toBe(0);
    expect(
      (await noticeRows(org, step.id)).filter((row) => row.kind === 'approver_unavailable'),
    ).toHaveLength(0);
  });
});

describe('候補の抽出: 通知済みのステップを除く (指摘1.1)', () => {
  type Pending = { requestId: string; step: ApprovalStepRow };

  async function fixedPending(count: number, now: Date): Promise<Pending[]> {
    const made: Pending[] = [];
    for (let index = 0; index < count; index += 1) {
      const itemId = await publishItem({ approverId: fixedA.id });
      const created = await createRequest(requester, itemId, { approverId: fixedA.id });
      const step = await currentStep(created.id);
      // 先に作ったものほど期限を早くする(候補の並びを決定的にする)。
      await setExpiry(step.id, new Date(now.getTime() + (index + 1) * HOUR));
      made.push({ requestId: created.id, step });
    }
    return made;
  }

  it('**期限前: 通知済みが上限以上あっても、未通知のステップに積まれる**', async () => {
    const now = new Date();
    const made = await fixedPending(3, now);
    expect((await sweep(org, now, 2)).expiringQueued).toBe(2);
    // 上限で切られた3件目は、まだ通知されていない。
    expect(
      (await noticeRows(org, made[2]!.step.id)).filter((row) => row.kind === 'expiring'),
    ).toHaveLength(0);
    // 通知済みの2件を候補から除かないと、ここで再び上限に当たり3件目に順番が回らない。
    expect((await sweep(org, now, 2)).expiringQueued).toBe(1);
    expect(
      (await noticeRows(org, made[2]!.step.id)).filter((row) => row.kind === 'expiring'),
    ).toHaveLength(1);
    expect((await sweep(org, now, 2)).expiringQueued).toBe(0);
  });

  it('**承認者不在: 通知済みが上限以上あっても、未通知のステップに積まれる**', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const made: Pending[] = [];
    for (let index = 0; index < 3; index += 1) {
      const itemId = await publishItem({ ruleId });
      const created = await createRequest(requester, itemId);
      await decide(fixedA, created.id, 1, 'approve');
      const step = await currentStep(created.id);
      expect(step.approver_id).toBe(manager.id);
      made.push({ requestId: created.id, step });
    }
    await expireBinding(manager.id);
    const now = new Date();
    expect((await sweep(org, now, 2)).unavailableQueued).toBe(2);
    expect(
      (await noticeRows(org, made[2]!.step.id)).filter(
        (row) => row.kind === 'approver_unavailable',
      ),
    ).toHaveLength(0);
    expect((await sweep(org, now, 2)).unavailableQueued).toBe(1);
    expect(
      (await noticeRows(org, made[2]!.step.id)).filter(
        (row) => row.kind === 'approver_unavailable',
      ),
    ).toHaveLength(1);
    expect((await sweep(org, now, 2)).unavailableQueued).toBe(0);
  });

  it('**管理者が0人の組織では、その周の不在の処理を早く打ち切る**(候補を押し出さない)', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const made: Pending[] = [];
    for (let index = 0; index < 3; index += 1) {
      const itemId = await publishItem({ ruleId });
      const created = await createRequest(requester, itemId);
      await decide(fixedA, created.id, 1, 'approve');
      made.push({ requestId: created.id, step: await currentStep(created.id) });
    }
    await expireBinding(manager.id);
    await expireBinding(adminUser.id);
    await expireBinding(secondAdmin.id);
    const now = new Date();
    const skipped = await sweep(org, now, 2);
    expect(skipped.unavailableQueued).toBe(0);
    // 記録を作らないので候補に残り続ける。上限までの候補を**1回で**打ち切る。
    expect(skipped.unavailableSkippedNoAdmin).toBe(2);
    for (const { step } of made)
      expect(
        (await noticeRows(org, step.id)).filter((row) => row.kind === 'approver_unavailable'),
      ).toHaveLength(0);

    // 管理者が任命されれば、次の周から順に積まれる(永久に残らない)。
    await restoreBinding(adminUser.id);
    await restoreBinding(secondAdmin.id);
    expect((await sweep(org, now, 2)).unavailableQueued).toBe(2);
    expect((await sweep(org, now, 2)).unavailableQueued).toBe(1);
    const notices = (await noticeRows(org)).filter((row) => row.kind === 'approver_unavailable');
    expect(notices).toHaveLength(3);
  });
});

describe('通知の内容: 申請の入力値・個人データを載せない (WP §7)', () => {
  it('**件名・リンク・Outbox の payload に含まれない**', async () => {
    const markers = {
      reason: 'WP019-MARK-REASON-9f31',
      employeeNo: 'WP019-MARK-EMP-7731',
      jobTitle: 'WP019-MARK-TITLE-5521',
      workplace: 'WP019-MARK-PLACE-1187',
    };
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId, {
      reason: markers.reason,
      values: {
        employee_no: markers.employeeNo,
        job_title: markers.jobTitle,
        workplace: markers.workplace,
      },
    });
    await decide(fixedA, created.id, 1, 'approve');
    await expireBinding(manager.id);
    const step = await currentStep(created.id);
    const now = new Date();
    // 期限内にすると、期限前と承認者不在の通知が同じ1周で積まれる。
    await setExpiry(step.id, new Date(now.getTime() + 23 * HOUR));
    await sweep(org, now);
    // 期限を過ぎた状態でもう1周し、期限切れの通知を積む。
    await setExpiry(step.id, new Date(now.getTime() - HOUR));
    await sweep(org, now);

    const outbox = await outboxForRequest(created.id);
    expect(new Set(outbox.map((event) => event.event_type))).toEqual(
      new Set([
        'approval.notice.requested',
        'approval.notice.expiring',
        'approval.notice.expired',
        'approval.notice.approver_unavailable',
      ]),
    );
    const text = JSON.stringify(outbox.map((event) => event.payload));
    for (const marker of Object.values(markers)) expect(text).not.toContain(marker);

    // 配送して、件名・リンクにも含まれないことを見る(申請者への期限切れ通知)。
    const expiredEvent = outbox.find((event) => event.event_type === 'approval.notice.expired')!;
    const delivered = await deliver(expiredEvent);
    expect(delivered.sent).toBe(1);
    expect(delivered.sender.sent[0]!.to).toBe(requester.email);
    // 件名には申請番号を含めてよい。
    const ticket = (
      await q('SELECT number FROM ticket WHERE id=$1', [(await requestRow(created.id)).ticket_id])
    ).rows[0]!;
    expect(delivered.sender.sent[0]!.subject).toContain(ticket.number);
    for (const marker of Object.values(markers)) {
      expect(delivered.sender.sent[0]!.subject).not.toContain(marker);
      expect(delivered.sender.sent[0]!.linkPath).not.toContain(marker);
    }
    expect(delivered.sender.sent[0]!.linkPath).toBe(`/requests/${created.id}`);
  });
});

describe('宛先は配送の時点の有効な所属に限る (WP §7)', () => {
  it('**停止された承認者・所属の切れた承認者へは送らない**', async () => {
    for (const target of ['stopped', 'expired'] as const) {
      const approver = await makeUser(`delivery-${target}`, ['approver']);
      const itemId = await publishItem({ approverId: approver.id });
      const created = await createRequest(requester, itemId, { approverId: approver.id });
      if (target === 'stopped')
        await q(`UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1`, [
          approver.id,
        ]);
      else await expireBinding(approver.id);
      const event = (await outboxForRequest(created.id)).find(
        (row) => row.event_type === 'approval.notice.requested',
      )!;
      const delivered = await deliver(event);
      expect(delivered.sent, target).toBe(0);
      expect(delivered.sender.sent, target).toHaveLength(0);
    }
  });
});

describe('組織境界 (WP §7)', () => {
  it('**組織Aの1周で、組織Bのステップ・記録・Outbox が変わらない**', async () => {
    // 組織B: 期限内で承認者不在のステップ。
    await q(
      `INSERT INTO department (id, organization_id, code, name, parent_id) VALUES ($1,$2,$3,$4,NULL)`,
      [randomUUID(), otherOrg, `wp019-other-dept-${SUFFIX}`, 'WP019 他組織 部署'],
    );
    await q(
      `INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1,$2)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [otherOrg, otherUser.id],
    );
    // 組織Bに有効な組織管理者を1人置く(承認者不在の通知の宛先)。
    // 同じ利用者を承認者にもする。承認者としては所属を切って「不在」にする。
    await q(
      `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source,valid_from,valid_until)
       VALUES($1,$2,(SELECT id FROM role WHERE code='org_admin' AND scope='org'),'org',$3,'manual',$4,NULL)`,
      [randomUUID(), otherUser.id, otherOrg, PAST],
    );
    await q(
      `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source,valid_from,valid_until)
       VALUES($1,$2,(SELECT id FROM role WHERE code='approver' AND scope='org'),'org',$3,'manual',$4,$5)`,
      [randomUUID(), otherUser.id, otherOrg, PAST, new Date(Date.now() - HOUR)],
    );
    const otherApprovalId = uuidv7();
    const otherRequestId = uuidv7();
    const otherSnapshot = {
      item: {
        id: uuidv7(),
        version: 1,
        title: '他組織の合成申請',
        definition: definition({ approverId: otherUser.id }),
      },
      inputs: { reason: '合成', durationDays: 7 },
      requesterId: otherUser.id,
    };
    const otherTicketId = uuidv7();
    await q(
      `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition,active)
       VALUES($1,$2,$3,1,'他組織の合成申請','合成',$4,true)`,
      [
        otherSnapshot.item.id,
        otherOrg,
        `wp019-other-item-${SUFFIX}`,
        definition({ approverId: otherUser.id }),
      ],
    );
    await q(
      `INSERT INTO ticket(id,organization_id,number,kind,state,subject,body,requester_id,impact,urgency,priority)
       VALUES($1,$2,$3,'request','new','他組織の合成申請','合成',$4,'low','low','low')`,
      [
        otherTicketId,
        otherOrg,
        `REQ-2026-8${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
        otherUser.id,
      ],
    );
    await admin.query('BEGIN');
    try {
      await q(
        `INSERT INTO local_service_request(id,organization_id,item_id,requester_id,ticket_id,idempotency_key,version,revision,state,snapshot,snapshot_hash,current_approval_id)
         VALUES($1,$2,$3,$4,$5,$6,1,1,'pending',$7,$8,$9)`,
        [
          otherRequestId,
          otherOrg,
          otherSnapshot.item.id,
          otherUser.id,
          otherTicketId,
          uuidv7(),
          otherSnapshot,
          hash(otherSnapshot),
          otherApprovalId,
        ],
      );
      await q(
        `INSERT INTO local_request_revision(request_id,organization_id,revision,snapshot,snapshot_hash,changed_by)
         VALUES($1,$2,1,$3,$4,$5)`,
        [otherRequestId, otherOrg, otherSnapshot, hash(otherSnapshot), otherUser.id],
      );
      await q(
        `INSERT INTO local_request_approval(id,organization_id,request_id,revision,snapshot_hash,approver_id,state,expires_at)
         VALUES($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '23 hours')`,
        [otherApprovalId, otherOrg, otherRequestId, hash(otherSnapshot), otherUser.id],
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    const otherStepBefore = (
      await q('SELECT * FROM local_request_approval WHERE id=$1', [otherApprovalId])
    ).rows[0];
    const otherOutboxBefore = (
      await q('SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1', [otherOrg])
    ).rows[0].n;

    // 組織Aの1周。組織Bのステップと Outbox は変わらない。
    const summary = await sweep(org, new Date());
    expect(summary.expired).toBe(0);
    expect(
      (await q('SELECT * FROM local_request_approval WHERE id=$1', [otherApprovalId])).rows[0],
    ).toEqual(otherStepBefore);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM local_request_approval_notice WHERE organization_id=$1',
          [otherOrg],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await q('SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1', [otherOrg]))
        .rows[0].n,
    ).toBe(otherOutboxBefore);

    // 組織Bの1周では、組織Bのステップだけが対象になる。
    const otherSummary = await sweep(otherOrg, new Date());
    expect(otherSummary.unavailableQueued).toBe(1);
    const otherKinds = (
      await q(
        'SELECT kind FROM local_request_approval_notice WHERE organization_id=$1 ORDER BY kind',
        [otherOrg],
      )
    ).rows.map((row) => row.kind);
    // 期限内なので期限前の通知も同じ1周で積まれる。
    expect(otherKinds).toEqual(['approver_unavailable', 'expiring']);
    expect(
      (
        await q(
          'SELECT count(*)::int AS n FROM local_request_approval_notice WHERE organization_id=$1',
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});

describe('送信の記録の保護 (WP §7)', () => {
  it('**アプリケーションロールから UPDATE / DELETE が拒否される**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    expect(await noticeRows(org)).toHaveLength(1);
    for (const statement of [
      'UPDATE local_request_approval_notice SET kind=$2 WHERE approval_id=$1',
      'DELETE FROM local_request_approval_notice WHERE approval_id=$1',
    ]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
        const params = statement.startsWith('UPDATE')
          ? [(await currentStep(created.id)).id, 'expired']
          : [(await currentStep(created.id)).id];
        await expect(client.query(statement, params)).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    expect(await noticeRows(org)).toHaveLength(1);
  });

  it('**他組織の記録は読めない(RLS)**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    await createRequest(requester, itemId, { approverId: fixedA.id });
    expect(await noticeRows(org)).toHaveLength(1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [otherOrg]);
      expect(
        (
          await client.query(
            'SELECT count(*)::int AS n FROM local_request_approval_notice WHERE organization_id=$1',
            [org],
          )
        ).rows[0].n,
      ).toBe(0);
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
});

describe('状態 expired の行への追従 (WP §6.4 / §7)', () => {
  it('**決定・再割当・実行前検証の結果が同じ**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const expired = await createRequest(requester, itemId, { approverId: fixedA.id });
    const now = new Date();
    await setExpiry((await currentStep(expired.id)).id, new Date(now.getTime() - HOUR));
    // expired だけを定期処理に通す。
    expect((await sweep(org, now)).expired).toBe(1);
    // 定期処理を回さない申請を作る(行は pending のまま期限を過ぎている)。
    const pendingProbe = await createRequest(requester, itemId, { approverId: fixedA.id });
    await setExpiry((await currentStep(pendingProbe.id)).id, new Date(now.getTime() - HOUR));

    const pendingDecide = await expectProblem(decide(fixedA, pendingProbe.id, 1, 'approve'), 409);
    const expiredDecide = await expectProblem(decide(fixedA, expired.id, 1, 'approve'), 409);
    expect(pendingDecide.message).toBe(expiredDecide.message);

    const pendingReassign = await expectProblem(reassign(adminUser, pendingProbe.id), 409);
    const expiredReassign = await expectProblem(reassign(adminUser, expired.id), 409);
    expect(pendingReassign.errors).toEqual(expiredReassign.errors);

    expect(await checkComplete(pendingProbe.id)).toEqual({
      ok: false,
      reason: 'request_not_approved',
    });
    expect(await checkComplete(expired.id)).toEqual({ ok: false, reason: 'request_not_approved' });

    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, pendingProbe.id, {
          requestRevision: 1,
          expectedVersion: 1,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
    await expectProblem(
      run(() =>
        catalog.updateChecklist(agent.auth, expired.id, {
          requestRevision: 1,
          expectedVersion: 1,
          key: 'prepare',
          completed: true,
        }),
      ),
      409,
    );
  });

  it('**一覧・詳細・受信箱・承認者不在の一覧の結果が同じ**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const expired = await createRequest(requester, itemId, { approverId: fixedA.id });
    const now = new Date();
    await setExpiry((await currentStep(expired.id)).id, new Date(now.getTime() - HOUR));
    // expired だけを定期処理に通す。
    expect((await sweep(org, now)).expired).toBe(1);
    // 定期処理を回さない申請を作る(行は pending のまま期限を過ぎている)。
    const probe = await createRequest(requester, itemId, { approverId: fixedA.id });
    await setExpiry((await currentStep(probe.id)).id, new Date(now.getTime() - HOUR));

    const list = async (params: Record<string, string>) =>
      run(() => catalog.list(adminUser.auth, new URLSearchParams(params)));
    const expiredList = await list({ state: 'expired', page: '1' });
    const ids = new Set(expiredList.items.map((item: { id: string }) => item.id));
    expect(ids.has(probe.id)).toBe(true);
    expect(ids.has(expired.id)).toBe(true);
    const pendingList = await list({ state: 'pending', page: '1' });
    const pendingIds = new Set(pendingList.items.map((item: { id: string }) => item.id));
    expect(pendingIds.has(probe.id)).toBe(false);
    expect(pendingIds.has(expired.id)).toBe(false);
    const approvalsView = await list({ view: 'approvals', page: '1' });
    const approvalIds = new Set(approvalsView.items.map((item: { id: string }) => item.id));
    expect(approvalIds.has(probe.id)).toBe(false);
    expect(approvalIds.has(expired.id)).toBe(false);
    const unavailable = await list({ approverUnavailable: '1', page: '1' });
    const unavailableIds = new Set(unavailable.items.map((item: { id: string }) => item.id));
    expect(unavailableIds.has(probe.id)).toBe(false);
    expect(unavailableIds.has(expired.id)).toBe(false);
    for (const item of expiredList.items) {
      if (item.id === probe.id || item.id === expired.id)
        expect(item.approvalState).toBe('expired');
    }

    const probeDetail = await detailFor(requester, probe.id);
    const expiredDetail = await detailFor(requester, expired.id);
    expect(probeDetail.approval.state).toBe('expired');
    expect(expiredDetail.approval.state).toBe('expired');
    expect(probeDetail.steps[0]!.state).toBe('expired');
    expect(expiredDetail.steps[0]!.state).toBe('expired');
    expect(probeDetail.approverUnavailable).toBe(false);
    expect(expiredDetail.approverUnavailable).toBe(false);

    const inboxForApprover = await run(() => inbox.list(fixedA.auth, { page: '1' }));
    const inboxIds = new Set(inboxForApprover.items.map((item: { id: string }) => item.id));
    expect(inboxIds.has(probe.id)).toBe(false);
    expect(inboxIds.has(expired.id)).toBe(false);
  });

  it('**申請内容の変更は、どちらの状態でも同じように次の版を作れる**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const expired = await createRequest(requester, itemId, { approverId: fixedA.id });
    const now = new Date();
    await setExpiry((await currentStep(expired.id)).id, new Date(now.getTime() - HOUR));
    expect((await sweep(org, now)).expired).toBe(1);
    // 定期処理を回さない申請(行は pending のまま期限を過ぎている)を作る。
    const probe2 = await createRequest(requester, itemId, { approverId: fixedA.id });
    await setExpiry((await currentStep(probe2.id)).id, new Date(now.getTime() - HOUR));

    const editedProbe = await run(() =>
      catalog.edit(requester.auth, probe2.id, {
        expectedVersion: 1,
        reason: '合成: 期限切れからの変更',
        durationDays: 7,
        approverId: fixedA.id,
      }),
    );
    const editedExpired = await run(() =>
      catalog.edit(requester.auth, expired.id, {
        expectedVersion: 1,
        reason: '合成: 期限切れからの変更',
        durationDays: 7,
        approverId: fixedA.id,
      }),
    );
    expect(editedProbe).toEqual({ id: probe2.id, version: 2 });
    expect(editedExpired).toEqual({ id: expired.id, version: 2 });
    const newProbeStep = await currentStep(probe2.id);
    const newExpiredStep = await currentStep(expired.id);
    expect(newProbeStep.state).toBe('pending');
    expect(newExpiredStep.state).toBe('pending');
    expect(newProbeStep.revision).toBe(2);
    expect(newExpiredStep.revision).toBe(2);
  });
});

describe('実行前検証は定期処理に依存しない (WP §7)', () => {
  it('**定期処理を一度も走らせなくても、期限切れの承認で実行が拒否される**', async () => {
    const itemId = await publishItem({ approverId: fixedA.id });
    const created = await createRequest(requester, itemId, { approverId: fixedA.id });
    const step = await currentStep(created.id);
    await setExpiry(step.id, new Date(Date.now() - HOUR));
    expect((await currentStep(created.id)).state).toBe('pending');
    // 一度も sweep を呼ばない。
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
      await expect(
        assertApprovalComplete(client, { organizationId: org, requestId: created.id }),
      ).rejects.toMatchObject({ status: 409 });
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
});

describe('通知のリンクの宛先が申請を開けるか (指摘3)', () => {
  it('**承認者・申請者・組織管理者は `/requests/<id>` を開ける。他組織の利用者は開けない**', async () => {
    const ruleId = await createRule([fixedStep(fixedA.id), managerStep()]);
    const itemId = await publishItem({ ruleId });
    const created = await createRequest(requester, itemId);

    // 段1が pending の時点の宛先(承認者・申請者・組織管理者)。
    for (const person of [fixedA, requester, adminUser]) {
      const detail = await detailFor(person, created.id);
      expect(detail.request.id).toBe(created.id);
    }
    await expectProblem(detailFor(otherUser, created.id), 404);

    // 段2(上長)が承認者不在の時点の宛先。
    await decide(fixedA, created.id, 1, 'approve');
    await expireBinding(manager.id);
    for (const person of [requester, adminUser, manager])
      await expect(detailFor(person, created.id)).resolves.toBeDefined();

    // 期限切れの通知の宛先(申請者)。
    const step = await currentStep(created.id);
    await setExpiry(step.id, new Date(Date.now() - HOUR));
    await sweep(org, new Date());
    await expect(detailFor(requester, created.id)).resolves.toBeDefined();
  });
});

describe('巡回: 組織を1つずつ処理し、失敗を隔離する (指摘2.2)', () => {
  type OrgFixture = {
    organizationId: string;
    admin: Person;
    requester: Person;
    approver: Person;
    approver2: Person;
  };

  type Seeded = {
    expiringRequest: string;
    expiringStep: ApprovalStepRow;
    expiredRequest: string;
    expiredStep: ApprovalStepRow;
    unavailableRequest: string;
    unavailableStep: ApprovalStepRow;
  };

  /** 期限前・期限切れ・承認者不在のステップを1つずつ作る(すべて合成)。 */
  async function seed(fixture: OrgFixture, now: Date): Promise<Seeded> {
    await enableRouting(true, fixture.admin);

    const expiringItem = await publishItem({ approverId: fixture.approver.id }, fixture.admin);
    const expiring = await createRequest(fixture.requester, expiringItem, {
      approverId: fixture.approver.id,
    });
    const expiringStep = await currentStep(expiring.id);
    await setExpiry(expiringStep.id, new Date(now.getTime() + 2 * HOUR));

    const expiredItem = await publishItem({ approverId: fixture.approver.id }, fixture.admin);
    const expired = await createRequest(fixture.requester, expiredItem, {
      approverId: fixture.approver.id,
    });
    const expiredStep = await currentStep(expired.id);
    await setExpiry(expiredStep.id, new Date(now.getTime() - 2 * HOUR));

    // 2段目を固定承認者にし、1段目の承認後にその人を停止して「不在」にする。
    const ruleId = await createRule(
      [fixedStep(fixture.approver.id), fixedStep(fixture.approver2.id)],
      undefined,
      fixture.admin,
    );
    const unavailableItem = await publishItem({ ruleId }, fixture.admin);
    const unavailable = await createRequest(fixture.requester, unavailableItem);
    await decide(fixture.approver, unavailable.id, 1, 'approve');
    const unavailableStep = await currentStep(unavailable.id);
    expect(unavailableStep.approver_id).toBe(fixture.approver2.id);
    await q(`UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1`, [
      fixture.approver2.id,
    ]);

    return {
      expiringRequest: expiring.id,
      expiringStep,
      expiredRequest: expired.id,
      expiredStep,
      unavailableRequest: unavailable.id,
      unavailableStep,
    };
  }

  const kindsFor = async (organizationId: string, approvalId: string) =>
    (await noticeRows(organizationId, approvalId)).map((row) => row.kind).sort();

  it('**2つの組織を1周で処理し、監査と送信の記録をそれぞれの組織に残す**', async () => {
    const now = new Date();
    const a = await seed(
      { organizationId: org, admin: adminUser, requester, approver: fixedA, approver2: fixedB },
      now,
    );
    const b = await seed(
      {
        organizationId: otherOrg,
        admin: otherAdmin,
        requester: otherRequester,
        approver: otherApprover,
        approver2: otherApprover2,
      },
      now,
    );

    const summary = await sweepAll(now);
    expect(summary.skippedOverlap).toBe(false);
    expect(summary.failedOrganizations).toBe(0);
    expect(summary.processedOrganizations).toBeGreaterThanOrEqual(2);

    for (const [organizationId, data] of [
      [org, a],
      [otherOrg, b],
    ] as const) {
      // 期限切れは状態と監査がその組織に残る。
      expect((await currentStep(data.expiredRequest)).state).toBe('expired');
      expect(await auditFor(data.expiredRequest, 'approval.expired')).toHaveLength(1);
      expect(await kindsFor(organizationId, data.expiringStep.id)).toEqual([
        'expiring',
        'requested',
      ]);
      expect(await kindsFor(organizationId, data.expiredStep.id)).toEqual(['expired', 'requested']);
      expect(await kindsFor(organizationId, data.unavailableStep.id)).toEqual([
        'approver_unavailable',
        'requested',
      ]);
      // 記録も Outbox も、その組織の行だけである。
      expect(
        (await noticeRows(organizationId)).every((row) => row.organization_id === organizationId),
      ).toBe(true);
      expect(
        (await outboxForRequest(data.unavailableRequest)).every(
          (event) => event.organization_id === organizationId,
        ),
      ).toBe(true);
    }
    // 組織Aの1周で、組織Bのステップは変わっていない(逆も同じ)。
    expect((await noticeRows(org)).map((row) => row.approval_id)).not.toContain(b.expiringStep.id);
    expect((await noticeRows(otherOrg)).map((row) => row.approval_id)).not.toContain(
      a.expiringStep.id,
    );
    expect((await currentStep(b.unavailableRequest)).state).toBe('pending');
    expect((await currentStep(a.unavailableRequest)).state).toBe('pending');
  });

  it('**片方の組織の処理が失敗しても、もう片方は処理される**', async () => {
    const now = new Date();
    const a = await seed(
      { organizationId: org, admin: adminUser, requester, approver: fixedA, approver2: fixedB },
      now,
    );
    class FailingSweeper extends ApprovalNoticeSweeper {
      constructor(
        pool: pg.Pool,
        private readonly brokenOrganizationId: string,
      ) {
        super(pool, silent);
      }
      override async runOnce(input: { organizationId: string; now: Date }) {
        if (input.organizationId === this.brokenOrganizationId)
          throw new Error('合成の失敗(この組織だけ)');
        return super.runOnce(input);
      }
    }
    const summary = await run(() => new FailingSweeper(pool, otherOrg).sweepAllOnce(now));
    expect(summary.failedOrganizations).toBeGreaterThanOrEqual(1);
    expect(summary.processedOrganizations).toBeGreaterThanOrEqual(1);
    // 組織Aは処理され、組織Bは何も増えていない。
    expect(await kindsFor(org, a.expiringStep.id)).toEqual(['expiring', 'requested']);
    expect(await noticeRows(otherOrg)).toHaveLength(0);
  });

  it('**前の周が終わっていないうちに、次の周を始めない**', async () => {
    const now = new Date();
    const a = await seed(
      { organizationId: org, admin: adminUser, requester, approver: fixedA, approver2: fixedB },
      now,
    );
    const sweeper = newSweeper(2);
    const first = sweeper.sweepAllOnce(now);
    const second = await sweeper.sweepAllOnce(now);
    expect(second.skippedOverlap).toBe(true);
    const result = await first;
    expect(result.skippedOverlap).toBe(false);
    // 重ねて走らせても、期限前の通知は1件のままである。
    expect(await kindsFor(org, a.expiringStep.id)).toEqual(['expiring', 'requested']);
  });
});

describe('バッチの上限・定期処理の登録・RLSの例外 (指摘1.1 / 2.2)', () => {
  it('**1周で扱う上限がコードに明示され、上限はテストから小さくできる**', () => {
    const source = readFileSync(
      join(ROOT, 'services/api/src/modules/catalog/approval-notice-sweep.ts'),
      'utf8',
    );
    expect(source).toContain('APPROVAL_NOTICE_BATCH_LIMIT');
    expect(source).toContain('LIMIT ${this.batchLimit}');
    // 候補の抽出で、通知済みを除いている(上限で未通知を押し出さない)。
    expect(source).toContain("n.kind = 'expiring'");
    expect(source).toContain("n.kind = 'approver_unavailable'");
    // 組織の一覧は、登録した1つのフラグだけで読む。
    expect(source).toContain("set_config('app.approval_sweep', 'on', true)");
    for (const other of [
      'app.auth',
      'app.expiry',
      'app.autoclose',
      'app.anchor',
      'app.dispatcher',
      'app.scanner',
    ])
      expect(source).not.toContain(other);
  });

  it('**定期処理が main.ts に登録され、停止時にタイマーも止める**', () => {
    const main = readFileSync(join(ROOT, 'services/api/src/main.ts'), 'utf8');
    expect(main).toContain('new ApprovalNoticeSweeper');
    expect(main).toContain('startApprovalNoticeLoop');
    expect(main).toContain('APPROVAL_NOTICE_SWEEP_INTERVAL_MS');
    expect(main).toContain('clearInterval(approvalNoticeTimer)');
  });

  it('**RLS の例外は organization の読み取り1件だけ**(分離ポリシーは organization_id)', async () => {
    const policies = (
      await q(
        `SELECT policyname, qual, with_check FROM pg_policies
          WHERE schemaname='public' AND tablename='local_request_approval_notice'`,
      )
    ).rows;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.policyname).toBe('local_request_approval_notice_isolation');
    expect(policies[0]!.qual).toContain('app_current_org()');
    expect(policies[0]!.with_check).toContain('app_current_org()');

    // 0041 が足した例外は、organization の1件だけである。
    const sweep = (
      await q(
        `SELECT tablename, cmd FROM pg_policies
          WHERE schemaname='public' AND policyname='organization_approval_sweep_lookup'`,
      )
    ).rows;
    expect(sweep).toEqual([{ tablename: 'organization', cmd: 'SELECT' }]);
  });
});
