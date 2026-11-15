/**
 * WP-P4-APR-021 段階A: 高リスク申請の二重承認とSoD (TL-02 / TL-06 / TL-10 / TL-16)。
 *
 * - 高リスクの判定はカタログ定義の版属性 `approval.highRisk` で行う(ADR-0024 §4)。
 * - 条件(ルール・別人の fixed 2段以上)は共有の判定1か所で、公開・ルール/設定の変更・
 *   申請・変更・再割当・実行前検証のすべてが使う。
 * - 高リスクの申請では代理者の決定・可視性・通知を認めない(ADR-0026 §1)。
 * - 属性の変更は org_admin だけ。公開の時点で `catalog.high_risk_changed` に残す(§3)。
 *
 * 実行先は使い捨てDB(名前に `wp021` と `test` を含む)に限る。合成データだけを使う。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createLogger, newContext, runWithContext, type Logger } from '@solvi/shared';
import { approvalRuleStepsSchema, type ApprovalRuleStep } from '@solvi/shared/catalog';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import {
  type ApprovalStepRow,
} from '../../services/api/src/modules/catalog/approval-state.js';
import {
  assertApprovalComplete,
  checkApprovalComplete,
} from '../../services/api/src/modules/catalog/approval-assertion.js';
import { hash } from '../../services/api/src/modules/catalog/snapshot-hash.js';
import { ApprovalRuleController } from '../../services/api/src/modules/catalog/approval-rule.routes.js';
import { CatalogAdminController } from '../../services/api/src/modules/catalog/catalog-admin.routes.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import { ApprovalDelegationController } from '../../services/api/src/modules/catalog/approval-delegation.routes.js';
import { InboxController } from '../../services/api/src/modules/inbox/inbox.routes.js';
import { NotificationService } from '../../services/api/src/modules/notification/notification.service.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import { recordApprovalNotice } from '../../services/api/src/modules/catalog/approval-notice.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import type { RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanApprovalNoticeData, cleanAuditData } from '../support/cleanup.js';

const PAST = new Date('2026-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const silent: Logger = createLogger({
  service: 'wp021-dual-control',
  level: 'error',
  env: 'test',
  sink: () => undefined,
});

let pool: pg.Pool;
let admin: pg.Client;
let rules: ApprovalRuleController;
let catalogAdmin: CatalogAdminController;
let catalog: CatalogController;
let delegations: ApprovalDelegationController;
let inbox: InboxController;

let org: string;
let otherOrg: string;
let dept: string;

type Person = { id: string; auth: AuthenticatedRequest; email: string };
let adminUser: Person;
let editor: Person;
let requester: Person;
let fixedA: Person;
let fixedB: Person;
let fixedC: Person;
let managerPerson: Person;
let delegate: Person;
let delegate2: Person;
let agent: Person;
let outsider: Person;
let outsiderAuth: AuthenticatedRequest;

const made = { users: [] as string[], orgs: [] as string[] };
let sequence = 0;

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

function authFor(userId: string, roles: RoleCode[], organizationId = org): AuthenticatedRequest {
  return {
    userId,
    sessionId: `wp021-${userId.slice(0, 8)}`,
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

async function makeUser(label: string, roles: RoleCode[]): Promise<Person> {
  const id = randomUUID();
  const email = `wp021-${label}-${id.slice(0, 8)}@example.test`;
  await q(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, email, `WP021 ${label}`],
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
  return { id, auth: authFor(id, roles), email };
}

async function expectProblem(
  promise: Promise<unknown>,
  status: number,
  messageParts: string[] = [],
): Promise<Error & { status?: number; errors?: Array<{ field: string; message: string }> }> {
  let caught:
    | (Error & { status?: number; errors?: Array<{ field: string; message: string }> })
    | undefined;
  try {
    await promise;
  } catch (error) {
    caught = error as Error & { status?: number; errors?: Array<{ field: string; message: string }> };
  }
  expect(caught, '拒否されるべき操作が成功した').toBeDefined();
  expect(caught?.status, caught?.message).toBe(status);
  const text = `${caught?.message ?? ''} ${JSON.stringify(caught?.errors ?? [])}`;
  for (const part of messageParts) expect(text).toContain(part);
  return caught!;
}

const nextCode = () => `wp021-${SUFFIX}-${++sequence}`;
const fixed = (approverId: string) => ({ type: 'fixed' as const, approverId });
const manager = (onUnresolved: 'department_head' | 'reject' = 'reject') => ({
  type: 'manager' as const,
  onUnresolved,
});

function definition(approval: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    mode: 'local_simulation',
    action: 'simulate.access_grant',
    targetLabel: '合成対象',
    allowedDurations: [7],
    maxReasonLength: 2000,
    approval,
    ...extra,
  };
}

async function createRule(
  person: Person,
  steps: ApprovalRuleStep[],
  options: { code?: string; name?: string } = {},
): Promise<string> {
  const created = await run(() =>
    rules.create(person.auth, {
      code: options.code ?? nextCode(),
      name: options.name ?? `合成 ${options.code ?? ''}`,
      steps,
    }),
  );
  return created.body.rule.id as string;
}

/** 定義の下書きを作る。高リスクの指定は呼び出し側が `approval` に入れる。 */
async function createDraft(
  person: Person,
  approval: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await run(() =>
    catalogAdmin.create(person.auth, {
      code: nextCode(),
      title: 'WP021 合成カタログ',
      description: '合成',
      definition: definition(approval, extra),
      creationKey: randomUUID(),
    }),
  );
  return created.id as string;
}

const saveDraft = (
  person: Person,
  id: string,
  approval: Record<string, unknown>,
  expectedVersion: number,
  extra: Record<string, unknown> = {},
) =>
  run(() =>
    catalogAdmin.save(person.auth, id, {
      title: 'WP021 合成カタログ',
      description: '合成',
      definition: definition(approval, extra),
      expectedVersion,
    }),
  );

const publish = (person: Person, id: string, expectedVersion: number) =>
  run(() =>
    catalogAdmin.publication(person.auth, id, { expectedVersion, state: 'published' }),
  );

const unpublish = (person: Person, id: string, expectedVersion: number) =>
  run(() =>
    catalogAdmin.publication(person.auth, id, { expectedVersion, state: 'unpublished' }),
  );

const enableRouting = (enabled = true) =>
  run(() => rules.updateSettings(adminUser.auth, { enabled }));

const itemRow = async (id: string) =>
  (await q('SELECT * FROM local_catalog_item WHERE id=$1', [id])).rows[0];
const ruleRow = async (id: string) =>
  (await q('SELECT * FROM approval_rule WHERE id=$1', [id])).rows[0];
const ruleSteps = async (id: string) => {
  const rule = await ruleRow(id);
  return (await q('SELECT steps FROM approval_rule_revision WHERE rule_id=$1 AND revision=$2', [
    id,
    rule.current_revision,
  ])).rows[0].steps;
};

/**
 * 保存済みのルールの段を DB で直接書き換える。既存の保存の検証(`fixed` の重複の 400)を
 * 通らない「壊れたルール」は、公開・変更の側の防御を確かめるためだけに作る。
 */
async function rewriteRuleSteps(ruleId: string, steps: unknown): Promise<void> {
  const rule = await ruleRow(ruleId);
  await admin.query(
    'ALTER TABLE approval_rule_revision DISABLE TRIGGER approval_rule_revision_immutable',
  );
  try {
    await q('UPDATE approval_rule_revision SET steps=$3::jsonb WHERE rule_id=$1 AND revision=$2', [
      ruleId,
      rule.current_revision,
      JSON.stringify(steps),
    ]);
  } finally {
    await admin.query(
      'ALTER TABLE approval_rule_revision ENABLE TRIGGER approval_rule_revision_immutable',
    );
  }
}
const requestRow = async (id: string) =>
  (await q('SELECT * FROM local_service_request WHERE id=$1', [id])).rows[0];
const revisionRow = async (id: string) =>
  (
    await q('SELECT * FROM local_request_revision WHERE request_id=$1 AND revision=$2', [
      id,
      (await requestRow(id)).revision,
    ])
  ).rows[0];
const stepRows = async (id: string) =>
  (
    await q(
      `SELECT * FROM local_request_approval WHERE request_id=$1
        ORDER BY revision, route_generation, step_no, id`,
      [id],
    )
  ).rows as ApprovalStepRow[];
const generationRows = async (id: string) =>
  (
    await q(
      `SELECT * FROM local_request_route_generation WHERE request_id=$1 ORDER BY revision, route_generation`,
      [id],
    )
  ).rows;
const auditRows = async (targetId: string, eventType?: string) =>
  (
    await q(
      `SELECT event_type, actor_id, before_state, after_state, target_id FROM audit_event
        WHERE target_id=$1${eventType ? ' AND event_type=$2' : ''} ORDER BY occurred_at, event_id`,
      eventType ? [targetId, eventType] : [targetId],
    )
  ).rows;
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

async function createRequest(person: Person, itemId: string, extra: Record<string, unknown> = {}) {
  const item = await itemRow(itemId);
  return run(() =>
    catalog.create(person.auth, {
      itemId,
      itemVersion: item.version,
      idempotencyKey: uuidv7(),
      reason: '合成: 二重承認',
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

const reassign = (person: Person, id: string, reason = '合成: 再割当') =>
  run(() => catalog.reassign(person.auth, id, { reason }));

const detailFor = (person: Person, id: string) => run(() => catalog.detail(person.auth, id));
const listFor = (person: Person) => run(() => catalog.list(person.auth));
const inboxFor = (person: Person) => run(() => inbox.list(person.auth, {}));

const createDelegation = (person: Person, delegateId: string, offsetMs = HOUR) =>
  run(() =>
    delegations.create(person.auth, {
      delegateId,
      startsAt: new Date(Date.now() - MINUTE).toISOString(),
      endsAt: new Date(Date.now() + offsetMs).toISOString(),
    }),
  );

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

async function assertCompleteFailure(requestId: string): Promise<string> {
  const client = await pool.connect();
  let caught: unknown;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
    try {
      await assertApprovalComplete(client, { organizationId: org, requestId });
    } catch (error) {
      caught = error;
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  expect(caught, '実行前検証が通ってしまった').toBeDefined();
  return String((caught as Error).message);
}

/** 申請の snapshot(本体・版・承認行)を、ハッシュごと書き換える。管理者接続だけを使う。 */
type MutableSnapshot = {
  item: { definition: { approval: Record<string, unknown> } };
};
async function rewriteSnapshot(
  requestId: string,
  mutate: (snapshot: MutableSnapshot) => void,
): Promise<void> {
  const request = await requestRow(requestId);
  const snapshot = request.snapshot as MutableSnapshot;
  mutate(snapshot);
  const snapshotHash = hash(snapshot);
  await admin.query('BEGIN');
  try {
    await q('UPDATE local_service_request SET snapshot=$2, snapshot_hash=$3 WHERE id=$1', [
      requestId,
      snapshot,
      snapshotHash,
    ]);
    await q(
      'UPDATE local_request_revision SET snapshot=$3, snapshot_hash=$4 WHERE request_id=$1 AND revision=$2',
      [requestId, request.revision, snapshot, snapshotHash],
    );
    await q('UPDATE local_request_approval SET snapshot_hash=$2 WHERE request_id=$1', [
      requestId,
      snapshotHash,
    ]);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

type Delivered = { sender: RecordingEmailSender; sent: number; skipped: number };
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

/** 期限前の通知を、定期処理と同じ記録の関数で積む(時刻を待たない)。 */
async function queueExpiringNotice(requestId: string): Promise<void> {
  const request = await requestRow(requestId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [org]);
    await recordApprovalNotice(client, {
      organizationId: org,
      approvalId: request.current_approval_id,
      requestId,
      kind: 'expiring',
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expireBinding(userId: string): Promise<void> {
  await q(
    `UPDATE role_binding SET valid_until=clock_timestamp()-interval '1 second'
      WHERE organization_id=$1 AND user_id=$2 AND valid_until IS NULL`,
    [org, userId],
  );
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
    await admin
      .query(
        'ALTER TABLE approval_rule_revision ENABLE TRIGGER approval_rule_revision_immutable',
      )
      .catch(() => undefined);
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
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  await admin.query('ALTER TABLE approval_delegation DISABLE TRIGGER approval_delegation_guard_delete');
  try {
    await q('DELETE FROM approval_delegation WHERE organization_id=$1', [org]);
  } finally {
    await admin.query('ALTER TABLE approval_delegation ENABLE TRIGGER approval_delegation_guard_delete');
  }
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
  await admin.query('ALTER TABLE local_catalog_revision DISABLE TRIGGER local_catalog_revision_immutable');
  try {
    await q('DELETE FROM local_catalog_revision WHERE organization_id=$1', [org]);
  } finally {
    await admin.query('ALTER TABLE local_catalog_revision ENABLE TRIGGER local_catalog_revision_immutable');
  }
  await q('DELETE FROM local_catalog_item WHERE organization_id=$1', [org]);
  await cleanRulesFor(org);
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
    if (!name.includes('wp021') || !name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は wp021 の使い捨てDBではありません。中止します`);
    }
  }
  rules = new ApprovalRuleController(pool, true);
  catalogAdmin = new CatalogAdminController(pool, true);
  catalog = new CatalogController(
    pool,
    {} as ConstructorParameters<typeof CatalogController>[1],
    true,
    silent,
  );
  delegations = new ApprovalDelegationController(pool, true, silent);
  inbox = new InboxController(pool, true);

  org = randomUUID();
  made.orgs.push(org);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    org,
    `wp021-${SUFFIX}`,
    'WP021 二重承認 (合成)',
  ]);
  await q(
    `INSERT INTO department (id, organization_id, code, name) VALUES ($1,$2,$3,$4)`,
    [(dept = randomUUID()), org, `wp021-${SUFFIX}`, 'WP021 部署 (合成)'],
  );
  adminUser = await makeUser('admin', ['org_admin']);
  editor = await makeUser('editor', ['catalog_editor']);
  requester = await makeUser('requester', ['requester']);
  fixedA = await makeUser('fixed-a', ['approver']);
  fixedB = await makeUser('fixed-b', ['approver']);
  fixedC = await makeUser('fixed-c', ['approver']);
  managerPerson = await makeUser('manager', ['requester']);
  delegate = await makeUser('delegate', ['approver']);
  delegate2 = await makeUser('delegate2', ['approver']);
  agent = await makeUser('agent', ['agent']);
  outsider = await makeUser('outsider', ['requester']);
  for (const person of [requester, fixedA, fixedB, fixedC, managerPerson, delegate, delegate2])
    await q(
      'UPDATE org_member_profile SET primary_department_id=$3 WHERE organization_id=$1 AND user_id=$2',
      [org, person.id, dept],
    );
  // 「上長」の段を解決できるようにする。テストごとに必要なら差し替える。
  await q(
    'UPDATE org_member_profile SET manager_user_id=$3 WHERE organization_id=$1 AND user_id=$2',
    [org, requester.id, managerPerson.id],
  );

  otherOrg = randomUUID();
  made.orgs.push(otherOrg);
  await q('INSERT INTO organization (id, code, name) VALUES ($1,$2,$3)', [
    otherOrg,
    `wp021-other-${SUFFIX}`,
    'WP021 他組織 (合成)',
  ]);
  outsiderAuth = authFor(outsider.id, ['requester'], otherOrg);
}, 120_000);

afterAll(async () => {
  if (admin) {
    try {
      await cleanOrgData();
      await q('DELETE FROM department_head WHERE organization_id=$1', [org]);
      await q('DELETE FROM org_member_profile WHERE organization_id=$1', [org]);
      await q('DELETE FROM role_binding WHERE organization_id=$1', [org]);
      await q('DELETE FROM app_user WHERE id=ANY($1::uuid[])', [made.users]);
      await cleanAuditData(admin, `organization_id = '${org}'`);
      await q('DELETE FROM department WHERE organization_id=$1', [org]);
      await q('DELETE FROM organization WHERE id=$1', [org]);
    } finally {
      await admin.end();
    }
  }
  await pool?.end();
});

beforeEach(async () => {
  if (!admin) return;
  await cleanOrgData();
  await q(`UPDATE app_user SET status='active', deactivated_at=NULL WHERE id=ANY($1::uuid[])`, [
    made.users,
  ]);
  await q(
    'UPDATE role_binding SET valid_until=NULL WHERE organization_id=$1 AND user_id=ANY($2::uuid[])',
    [org, made.users],
  );
  await q(
    'UPDATE org_member_profile SET manager_user_id=$3 WHERE organization_id=$1 AND user_id=$2',
    [org, requester.id, managerPerson.id],
  );
  await enableRouting(true);
});

/** 高リスクの項目(2名の固定承認者)と、そのルールを作る。 */
async function highRiskFixture(options: { enableRouting?: boolean } = {}) {
  const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
  const itemId = await createDraft(adminUser, { ruleId, highRisk: true });
  await publish(adminUser, itemId, 1);
  if (options.enableRouting === false) await enableRouting(false);
  return { ruleId, itemId };
}

describe('属性の権限と監査 (WP §6.1 / §7-7)', () => {
  it('委任された編集者は、新規の下書きで高リスクを真にできない(省略・偽は可)', async () => {
    await expectProblem(
      run(() =>
        catalogAdmin.create(editor.auth, {
          code: nextCode(),
          title: '合成',
          description: '合成',
          definition: definition({ approverId: fixedA.id, highRisk: true }),
          creationKey: randomUUID(),
        }),
      ),
      403,
      ['高リスクの指定を変更できるのは組織管理者だけです'],
    );
    const allowed = await run(() =>
      catalogAdmin.create(editor.auth, {
        code: nextCode(),
        title: '合成',
        description: '合成',
        definition: definition({ approverId: fixedA.id }),
        creationKey: randomUUID(),
      }),
    );
    expect(allowed.id).toBeTypeOf('string');
    const explicitFalse = await run(() =>
      catalogAdmin.create(editor.auth, {
        code: nextCode(),
        title: '合成',
        description: '合成',
        definition: definition({ approverId: fixedA.id, highRisk: false }),
        creationKey: randomUUID(),
      }),
    );
    expect(explicitFalse.id).toBeTypeOf('string');
  });

  it('委任された編集者は、直前の下書きと異なる値を保存できない(省略と偽は同じ値)', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    const id = await run(() =>
      catalogAdmin.create(editor.auth, {
        code: nextCode(),
        title: '合成',
        description: '合成',
        definition: definition({ ruleId }),
        creationKey: randomUUID(),
      }),
    );
    // 省略 → 偽(同じ値)は通る。
    await saveDraft(editor, id.id as string, { ruleId, highRisk: false }, 1, {
      ownerId: editor.id,
    });
    // 偽 → 真は 403。
    await expectProblem(
      saveDraft(editor, id.id as string, { ruleId, highRisk: true }, 2, { ownerId: editor.id }),
      403,
      ['高リスクの指定を変更できるのは組織管理者だけです'],
    );
    // 真にできるのは org_admin だけ。
    await saveDraft(adminUser, id.id as string, { ruleId, highRisk: true }, 2, {
      ownerId: editor.id,
    });
    // 真 → 偽も編集者はできない。
    await expectProblem(
      saveDraft(editor, id.id as string, { ruleId, highRisk: false }, 3, { ownerId: editor.id }),
      403,
      ['高リスクの指定を変更できるのは組織管理者だけです'],
    );
    // 同じ値(真 → 真)は通る。
    await saveDraft(editor, id.id as string, { ruleId, highRisk: true }, 3, { ownerId: editor.id });
    const saved = await q(
      `SELECT count(*)::int AS n FROM local_catalog_revision WHERE item_id=$1`,
      [id.id],
    );
    expect(saved.rows[0].n).toBe(4);
  });

  it('高リスクの指定の変更は、公開の時点で前後の値とともに記録される(下書きでは記録しない)', async () => {
    const { itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    const ruleId = item.definition.approval.ruleId;
    const audits = await auditRows(itemId, 'catalog.high_risk_changed');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: adminUser.id,
      before_state: { revision: null, highRisk: false },
      after_state: { highRisk: true },
    });
    expect(audits[0]!.after_state.revision).toBe(1);
    expect(audits[0]!.after_state.code).toBe(item.code);

    // 同じ値のまま下書きを保存しても記録しない(下書きの保存は属性の変更に数えない)。
    await saveDraft(adminUser, itemId, { ruleId, highRisk: true }, 2);
    expect(await auditRows(itemId, 'catalog.high_risk_changed')).toHaveLength(1);
    // 同じ値のまま公開しても記録しない(版1 → 版2)。
    await publish(adminUser, itemId, 3);
    expect(await auditRows(itemId, 'catalog.high_risk_changed')).toHaveLength(1);

    // 真 → 偽で公開すると記録が増える(版2 → 版3)。
    await saveDraft(adminUser, itemId, { ruleId, highRisk: false }, 4);
    await publish(adminUser, itemId, 5);
    let after = await auditRows(itemId, 'catalog.high_risk_changed');
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({
      before_state: { revision: 2, highRisk: true },
      after_state: { revision: 3, highRisk: false },
    });

    // 偽 → 真で公開すると、さらに記録が増える(版3 → 版4)。
    await saveDraft(adminUser, itemId, { ruleId, highRisk: true }, 6);
    await publish(adminUser, itemId, 7);
    after = await auditRows(itemId, 'catalog.high_risk_changed');
    expect(after).toHaveLength(3);
    expect(after[2]).toMatchObject({
      before_state: { revision: 3, highRisk: false },
      after_state: { revision: 4, highRisk: true },
    });
    // 入力値・個人データを載せない(キーは code / revision / highRisk だけ)。
    for (const audit of after)
      for (const state of [audit.before_state, audit.after_state])
        expect(Object.keys(state).sort()).toEqual(['code', 'highRisk', 'revision']);
  });
});

describe('公開の条件 (WP §6.3-1 / §7-4・§7-6)', () => {
  it('別人の fixed 2段以上を持つ有効なルールなら公開できる', async () => {
    const { itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    expect(item.active).toBe(true);
    expect(item.published_revision).toBe(1);
    expect(item.definition.approval.highRisk).toBe(true);
  });

  it('ルールの無い定義(固定承認者・申請者選択)は公開できない', async () => {
    const id = await createDraft(adminUser, { approverId: fixedA.id, highRisk: true });
    await expectProblem(publish(adminUser, id, 1), 400, [
      '高リスクの項目には承認ルールを設定してください',
    ]);
    expect((await itemRow(id)).active).toBe(false);
  });

  it('組織でルールの使用が無効なら公開できない', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    await enableRouting(false);
    const id = await createDraft(adminUser, { ruleId, highRisk: true });
    await expectProblem(publish(adminUser, id, 1), 400, [
      '組織で承認ルールの使用が有効になっていません',
    ]);
  });

  it('関係ベースの段だけ・fixed 1段・fixed 2段が同じ承認者のルールは公開できない', async () => {
    const cases: Array<{ steps: ApprovalRuleStep[]; message: string }> = [
      { steps: [manager(), manager()], message: '別人の固定承認者を2段以上' },
      { steps: [fixed(fixedA.id)], message: '別人の固定承認者を2段以上' },
      { steps: [fixed(fixedA.id), manager()], message: '別人の固定承認者を2段以上' },
    ];
    for (const entry of cases) {
      const ruleId = await createRule(adminUser, entry.steps);
      const id = await createDraft(adminUser, { ruleId, highRisk: true });
      await expectProblem(publish(adminUser, id, 1), 400, [entry.message]);
      expect((await itemRow(id)).active).toBe(false);
    }
    // 保存の検証(400)を通らない「同じ承認者の2段」は、DBで直接作って公開の判定を確かめる。
    const duplicateRule = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    await rewriteRuleSteps(duplicateRule, [fixed(fixedA.id), fixed(fixedA.id)]);
    const id = await createDraft(adminUser, { ruleId: duplicateRule, highRisk: true });
    await expectProblem(publish(adminUser, id, 1), 400, ['固定承認者を段ごとに別人']);
    expect((await itemRow(id)).active).toBe(false);
  });

  it('高リスクでない定義は、条件を満たさないルールでも公開できる(既存の挙動を変えない)', async () => {
    const ruleId = await createRule(adminUser, [manager()]);
    const id = await createDraft(adminUser, { ruleId });
    await publish(adminUser, id, 1);
    expect((await itemRow(id)).active).toBe(true);
    expect(await auditRows(id, 'catalog.high_risk_changed')).toHaveLength(0);
  });

  it('ルールが無効化済みの場合は公開できない(既存の 400 を維持する)', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    const id = await createDraft(adminUser, { ruleId, highRisk: true });
    await run(() => rules.deactivate(adminUser.auth, ruleId));
    await expectProblem(publish(adminUser, id, 1), 400, ['現在有効な同じ組織の承認ルール']);
    expect((await itemRow(id)).active).toBe(false);
  });
});

describe('ルール・設定の変更の拒否 (WP §6.3-2 / §7-5)', () => {
  it('公開中の高リスクの項目を壊すルールの版の追加は、影響する項目を示して 409', async () => {
    const { ruleId, itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    const error = await expectProblem(
      run(() =>
        rules.revise(adminUser.auth, ruleId, {
          expectedRevision: 1,
          steps: [fixed(fixedA.id)],
        }),
      ),
      409,
      ['high_risk_definition_blocked', `${item.code}: ${item.title}`],
    );
    expect(error.errors?.[0]?.message).toBe('high_risk_definition_blocked');
    expect((await ruleRow(ruleId)).current_revision).toBe(1);
  });

  it('fixed の 2段が同じ承認者になる版の追加も、影響する項目を示して 409(既存の 400 より先)', async () => {
    const { ruleId, itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    await expectProblem(
      run(() =>
        rules.revise(adminUser.auth, ruleId, {
          expectedRevision: 1,
          steps: [fixed(fixedA.id), fixed(fixedA.id)],
        }),
      ),
      409,
      ['high_risk_definition_blocked', `${item.code}: ${item.title}`],
    );
    expect((await ruleRow(ruleId)).current_revision).toBe(1);
  });

  it('関係ベースの段だけにする版の追加も、影響する項目を示して 409', async () => {
    const { ruleId, itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    await expectProblem(
      run(() => rules.revise(adminUser.auth, ruleId, { expectedRevision: 1, steps: [manager()] })),
      409,
      ['high_risk_definition_blocked', `${item.code}: ${item.title}`],
    );
    expect((await ruleRow(ruleId)).current_revision).toBe(1);
  });

  it('公開中の高リスクの項目があるルールの無効化は 409、項目が無ければ成功する', async () => {
    const { ruleId, itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    await expectProblem(run(() => rules.deactivate(adminUser.auth, ruleId)), 409, [
      'high_risk_definition_blocked',
      `${item.code}: ${item.title}`,
    ]);
    expect((await ruleRow(ruleId)).active).toBe(true);

    // 公開を取り下げると、無効化できる(既存の挙動)。
    const current = await itemRow(itemId);
    await unpublish(adminUser, itemId, current.edit_version);
    await run(() => rules.deactivate(adminUser.auth, ruleId));
    expect((await ruleRow(ruleId)).active).toBe(false);
  });

  it('組織でのルールの使用の停止は、公開中の高リスクの項目を示して 409', async () => {
    const { itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    await expectProblem(enableRouting(false), 409, [
      'high_risk_definition_blocked',
      `${item.code}: ${item.title}`,
    ]);
    const setting = await q('SELECT rule_routing_enabled FROM org_approval_setting WHERE organization_id=$1', [org]);
    expect(setting.rows[0].rule_routing_enabled).toBe(true);
  });

  it('高リスクでない項目しか無ければ、ルール・設定の変更は従来どおり成功する', async () => {
    const ruleId = await createRule(adminUser, [manager()]);
    const id = await createDraft(adminUser, { ruleId });
    await publish(adminUser, id, 1);
    await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)], {
      code: nextCode(),
    });
    await run(() =>
      rules.revise(adminUser.auth, ruleId, {
        expectedRevision: 1,
        steps: [fixed(fixedA.id), fixed(fixedB.id)],
      }),
    );
    await enableRouting(false);
    await run(() => rules.deactivate(adminUser.auth, ruleId));
  });
});

describe('申請と申請内容の変更 (WP §6.4 / §7-4・§7-6)', () => {
  it('高リスクの申請は、別人の fixed 2段の経路で作成できる', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    const revision = await revisionRow(created.id);
    expect(
      (revision.route as { steps: Array<{ approverId: string }> }).steps.map(
        (step) => step.approverId,
      ),
    ).toEqual([fixedA.id, fixedB.id]);
    expect((await stepRows(created.id)).map((step) => step.state)).toEqual(['pending']);
  });

  it('ルールの無い定義(固定承認者1人)を高リスクにした申請は 409(high_risk_route_invalid)', async () => {
    const id = await createDraft(adminUser, { approverId: fixedA.id });
    await publish(adminUser, id, 1);
    // 公開の API は高リスクを拒否するため、属性を DB で直接付ける(公開・申請の防御の検査)。
    await q(
      `UPDATE local_catalog_item
          SET definition = jsonb_set(definition, '{approval,highRisk}', 'true'::jsonb)
        WHERE id=$1`,
      [id],
    );
    await expectProblem(createRequest(requester, id), 409, ['high_risk_route_invalid']);
    const item = await itemRow(id);
    expect(
      (await q('SELECT count(*)::int AS n FROM local_service_request WHERE item_id=$1', [id]))
        .rows[0].n,
    ).toBe(0);
    expect(item.version).toBe(1);
  });

  it('組織でルールの使用が無効な場合の申請は 409(high_risk_route_invalid)', async () => {
    const { itemId } = await highRiskFixture();
    // 公開の API は停止を拒否するため、設定を DB で直接無効にする(fail closed の検査)。
    await q('UPDATE org_approval_setting SET rule_routing_enabled=false WHERE organization_id=$1', [org]);
    await expectProblem(createRequest(requester, itemId), 409, ['high_risk_route_invalid']);
    expect(
      (await q('SELECT count(*)::int AS n FROM local_service_request WHERE organization_id=$1', [org]))
        .rows[0].n,
    ).toBe(0);
  });

  it('申請時: 関係ベースだけ・fixed 1段・同じ人の2段・無効なルールは拒否する', async () => {
    const { itemId } = await highRiskFixture();
    const cases: Array<{ ruleId: string; prepare?: () => Promise<void> }> = [
      { ruleId: await createRule(adminUser, [manager()]) },
      { ruleId: await createRule(adminUser, [fixed(fixedC.id)]) },
    ];
    const duplicate = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    await rewriteRuleSteps(duplicate, [fixed(fixedA.id), fixed(fixedA.id)]);
    cases.push({ ruleId: duplicate });
    const inactive = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    cases.push({
      ruleId: inactive,
      prepare: () => q('UPDATE approval_rule SET active=false WHERE id=$1', [inactive]),
    });
    for (const entry of cases) {
      await q(
        `UPDATE local_catalog_item
            SET definition = jsonb_set(definition, '{approval,ruleId}', to_jsonb($2::text))
          WHERE id=$1`,
        [itemId, entry.ruleId],
      );
      await entry.prepare?.();
      await expectProblem(createRequest(requester, itemId), 409);
      expect(
        (await q('SELECT count(*)::int AS n FROM local_service_request WHERE item_id=$1', [
          itemId,
        ])).rows[0].n,
      ).toBe(0);
    }
  });

  it('申請内容の変更でも、経路の条件を満たさなければ拒否する', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    // 申請の snapshot を 1段のルールへ差し替える(公開 API は 1段の高リスクを拒否する)。
    const otherRule = await createRule(adminUser, [fixed(fixedC.id)]);
    await rewriteSnapshot(created.id, (snapshot) => {
      snapshot.item.definition.approval.ruleId = otherRule;
    });
    const request = await requestRow(created.id);
    await expectProblem(
      run(() =>
        catalog.edit(requester.auth, created.id, {
          expectedVersion: request.version,
          reason: '合成: 変更',
          durationDays: 7,
        }),
      ),
      409,
      ['high_risk_route_invalid'],
    );
    expect((await requestRow(created.id)).revision).toBe(1);
  });
});

describe('決定と代理の不可 (WP §6.5 / §7-1〜§7-3)', () => {
  it('申請者は決定できない(403)。1段目の決定者による2段目の決定は 409', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    await expectProblem(decide(requester, created.id, 1), 403, ['自己承認・自己決定はできません']);
    await decide(fixedA, created.id, 1);
    // 1段目の決定者を2段目の承認者と同じ人物にする(決定者2名の非重複の検査)。
    // 現行の経路では、同じ人が2段の承認者になることはルール保存で拒否される。
    await q(
      `UPDATE local_request_approval SET decided_by=$2
        WHERE request_id=$1 AND step_no=1 AND state='approved'`,
      [created.id, fixedB.id],
    );
    const before = await stepRows(created.id);
    const auditsBefore = (await auditRows(created.id)).length;
    await expectProblem(decide(fixedB, created.id, 2), 409, [
      '同じ申請の複数の段を同じ人が決定することはできません',
    ]);
    expect(await stepRows(created.id)).toEqual(before);
    expect((await auditRows(created.id)).length).toBe(auditsBefore);
  });

  it('有効な委任の代理者でも、高リスクの申請は決定できない(委任の無い利用者と同じ 404)', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegate.id);
    const stepsBefore = await stepRows(created.id);
    const auditsBefore = (await auditRows(created.id)).length;
    const noticesBefore = (await q('SELECT count(*)::int AS n FROM local_request_approval_notice WHERE organization_id=$1', [org])).rows[0].n;
    // 委任の無い同じ組織の利用者(fixedC)と同じ応答で、存在を漏らさない。
    await expectProblem(decide(fixedC, created.id, 1), 404, ['申請が見つかりません']);
    await expectProblem(decide(delegate, created.id, 1), 404, ['申請が見つかりません']);
    expect(await stepRows(created.id)).toEqual(stepsBefore);
    expect((await auditRows(created.id)).length).toBe(auditsBefore);
    expect(
      (await q('SELECT count(*)::int AS n FROM local_request_approval_notice WHERE organization_id=$1', [org])).rows[0].n,
    ).toBe(noticesBefore);

    // 一覧・受信箱・詳細のどれにも出ない(委任による可視性から除く)。
    expect((await listFor(delegate)).items).toHaveLength(0);
    expect((await inboxFor(delegate)).items).toHaveLength(0);
    await expectProblem(detailFor(delegate, created.id), 404, ['申請が見つかりません']);

    // 委任者本人は決定できる。
    await decide(fixedA, created.id, 1);
    await decide(fixedB, created.id, 2);
  });

  it('高リスクでない申請では、代理者が従来どおり決定でき、一覧・受信箱・詳細にも出る', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    const itemId = await createDraft(adminUser, { ruleId });
    await publish(adminUser, itemId, 1);
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegate.id);

    expect((await listFor(delegate)).items.map((row: { id: string }) => row.id)).toContain(
      created.id,
    );
    expect((await inboxFor(delegate)).items.map((row: { id: string }) => row.id)).toContain(
      created.id,
    );
    const detail = await detailFor(delegate, created.id);
    expect(detail.currentDelegation).toMatchObject({ delegatorId: fixedA.id });

    await decide(delegate, created.id, 1);
    expect((await stepRows(created.id))[0]!.decided_by).toBe(delegate.id);
    expect((await stepRows(created.id))[0]!.delegation_id).toBeTypeOf('string');
    // 2段目は fixedB 本人が決定する。
    await decide(fixedB, created.id, 2);
  });

  it('高リスクの申請の依頼・期限前の通知は、代理者へ送らない', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegate.id);

    const requested = (await outboxForRequest(created.id)).find(
      (event) => event.event_type === 'approval.notice.requested',
    )!;
    const deliveredRequested = await deliver(requested);
    expect(deliveredRequested.sender.sent.map((mail) => mail.to)).toEqual([fixedA.email]);

    await queueExpiringNotice(created.id);
    const expiring = (await outboxForRequest(created.id)).find(
      (event) => event.event_type === 'approval.notice.expiring',
    )!;
    const deliveredExpiring = await deliver(expiring);
    expect(deliveredExpiring.sender.sent.map((mail) => mail.to)).toEqual([fixedA.email]);
  });

  it('高リスクでない申請の依頼の通知は、代理者へも送る(既存の挙動)', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    const itemId = await createDraft(adminUser, { ruleId });
    await publish(adminUser, itemId, 1);
    const created = await createRequest(requester, itemId);
    await createDelegation(fixedA, delegate.id);
    const requested = (await outboxForRequest(created.id)).find(
      (event) => event.event_type === 'approval.notice.requested',
    )!;
    const delivered = await deliver(requested);
    expect(delivered.sender.sent.map((mail) => mail.to).sort()).toEqual(
      [fixedA.email, delegate.email].sort(),
    );
  });
});

describe('再割当 (WP §6.6 / §7-8)', () => {
  it('高リスクの申請で、再割当後の経路が条件を満たさなければ 409 で何も変えない', async () => {
    // 高リスクの公開は 2段の fixed を要求するため、申請の snapshot を書き換えて
    // 「高リスクなのに fixed が1段の経路」を作る(実行前検証と同じ fail closed の検査)。
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), manager()]);
    const itemId = await createDraft(adminUser, { ruleId });
    await publish(adminUser, itemId, 1);
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1);
    await rewriteSnapshot(created.id, (snapshot) => {
      snapshot.item.definition.approval.highRisk = true;
    });
    const step2 = (await stepRows(created.id)).find((step) => step.step_no === 2)!;
    expect(step2.approver_id).toBe(managerPerson.id);
    // 現在の承認者(上長)を不在にし、再解決先だけを有効な別人にする。
    await q(
      'UPDATE org_member_profile SET manager_user_id=$3 WHERE organization_id=$1 AND user_id=$2',
      [org, requester.id, delegate2.id],
    );
    await expireBinding(managerPerson.id);

    const before = {
      steps: await stepRows(created.id),
      generations: await generationRows(created.id),
      audits: (await auditRows(created.id)).length,
      request: await requestRow(created.id),
    };
    await expectProblem(reassign(adminUser, created.id), 409, ['high_risk_route_invalid']);
    expect(await stepRows(created.id)).toEqual(before.steps);
    expect(await generationRows(created.id)).toEqual(before.generations);
    expect((await auditRows(created.id)).length).toBe(before.audits);
    expect(await requestRow(created.id)).toEqual(before.request);
  });

  it('高リスクでない申請の再割当は従来どおり成功する', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), manager()]);
    const itemId = await createDraft(adminUser, { ruleId });
    await publish(adminUser, itemId, 1);
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1);
    // 上長(2段目の承認者)を不在にし、新しい上長を有効な別人にする。
    await q(
      'UPDATE org_member_profile SET manager_user_id=$3 WHERE organization_id=$1 AND user_id=$2',
      [org, requester.id, delegate2.id],
    );
    await expireBinding(managerPerson.id);
    const result = await reassign(adminUser, created.id);
    expect(result.routeGeneration).toBe(2);
    const steps = await stepRows(created.id);
    expect(steps.find((step) => step.route_generation === 2)!.approver_id).toBe(delegate2.id);
    expect(await checkComplete(created.id)).toMatchObject({ ok: false });
    await decide(delegate2, created.id, 3);
    expect(await checkComplete(created.id)).toMatchObject({ ok: true });
  });
});

describe('実行前検証 (WP §6.7 / §7-3)', () => {
  it('別人2名の本人が fixed の段を承認すると通り、代理の決定を混ぜると失敗する', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1);
    await decide(fixedB, created.id, 2);
    expect(await checkComplete(created.id)).toMatchObject({ ok: true });

    // 委任を作り、2段目の決定を代理の記録に書き換える(正規の経路では起きない)。
    const delegation = await createDelegation(fixedB, delegate.id);
    await q(
      `UPDATE local_request_approval
          SET decided_by=$2, delegation_id=$3, decided_at=clock_timestamp()
        WHERE request_id=$1 AND step_no=2 AND state='approved'`,
      [created.id, delegate.id, delegation.id],
    );
    expect(await checkComplete(created.id)).toEqual({
      ok: false,
      reason: 'high_risk_delegated_decision',
    });
    expect(await assertCompleteFailure(created.id)).toContain('代理による承認を認めていません');
  });

  it('fixed の承認が1段だけなら high_risk_insufficient_approvers', async () => {
    // 高リスクの公開は fixed 2段を要求するため、申請の snapshot を書き換えて
    // 「fixed 1段 + 上長1段」の承認済み申請を高リスクにする。
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), manager()]);
    const itemId = await createDraft(adminUser, { ruleId });
    await publish(adminUser, itemId, 1);
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1);
    await decide(managerPerson, created.id, 2);
    await rewriteSnapshot(created.id, (snapshot) => {
      snapshot.item.definition.approval.highRisk = true;
    });
    expect(await checkComplete(created.id)).toEqual({
      ok: false,
      reason: 'high_risk_insufficient_approvers',
    });
  });

  it('属性が真偽値でなければ high_risk_unreadable', async () => {
    const { itemId } = await highRiskFixture();
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1);
    await decide(fixedB, created.id, 2);
    await rewriteSnapshot(created.id, (snapshot) => {
      snapshot.item.definition.approval.highRisk = 'yes';
    });
    expect(await checkComplete(created.id)).toEqual({
      ok: false,
      reason: 'high_risk_unreadable',
    });
  });

  it('属性の無い既存の申請・高リスクでない申請の検証は変えない', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), manager()]);
    const itemId = await createDraft(adminUser, { ruleId });
    await publish(adminUser, itemId, 1);
    const created = await createRequest(requester, itemId);
    await decide(fixedA, created.id, 1);
    await decide(managerPerson, created.id, 2);
    expect(await checkComplete(created.id)).toMatchObject({ ok: true });
    // 属性を偽にしても通る。
    await rewriteSnapshot(created.id, (snapshot) => {
      snapshot.item.definition.approval.highRisk = false;
    });
    expect(await checkComplete(created.id)).toMatchObject({ ok: true });
  });
});

describe('ロール×操作の総当り (WP §8)', () => {
  it('承認ルール・設定・公開・属性・再割当は、許可されたロールだけが実行できる', async () => {
    const { ruleId, itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    const others = [editor, requester, fixedA, delegate, agent, outsider];
    for (const person of others) {
      const auth = person === outsider ? outsiderAuth : person.auth;
      await expectProblem(
        run(() => rules.updateSettings(auth, { enabled: false })),
        403,
      );
      await expectProblem(
        run(() => rules.revise(auth, ruleId, { expectedRevision: 1, steps: [fixed(fixedA.id)] })),
        403,
      );
      await expectProblem(run(() => rules.deactivate(auth, ruleId)), 403);
      await expectProblem(
        run(() =>
          catalogAdmin.publication(auth, itemId, {
            expectedVersion: item.edit_version,
            state: 'published',
          }),
        ),
        403,
      );
      await expectProblem(
        run(() => catalog.reassign(auth, uuidv7(), { reason: '合成' })),
        403,
      );
      // 下書きの保存での属性の変更も、org_admin 以外はできない。
      // 委任された編集者には、他人の下書きは 404(存在を漏らさない)。
      await expectProblem(
        run(() =>
          catalogAdmin.save(auth, itemId, {
            title: '合成',
            description: '合成',
            definition: definition({
              ruleId: item.definition.approval.ruleId,
              highRisk: false,
            }),
            expectedVersion: item.edit_version,
          }),
        ),
        person === editor ? 404 : 403,
      );
    }
  });

  it('委任された編集者は、他人の下書きを保存できず、自分の下書きだけを保存できる', async () => {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    const own = await createDraft(editor, { ruleId });
    await saveDraft(editor, own, { ruleId }, 1, { ownerId: editor.id });
    const admins = await createDraft(adminUser, { ruleId });
    await expectProblem(saveDraft(editor, admins, { ruleId }, 1), 404, ['カタログ項目が見つかりません']);
  });

  it('他組織の利用者は、公開中の高リスクの項目を申請できない(404)', async () => {
    const { itemId } = await highRiskFixture();
    const item = await itemRow(itemId);
    await expectProblem(
      run(() =>
        catalog.create(outsiderAuth, {
          itemId,
          itemVersion: item.version,
          idempotencyKey: uuidv7(),
          reason: '合成',
          durationDays: 7,
        }),
      ),
      404,
      ['カタログが見つかりません'],
    );
  });
});

describe('公開とルール・設定の変更の同時実行 (WP §6.3-3 / §7-5)', () => {
  async function racingPair(
    operation: (itemId: string, ruleId: string) => Promise<unknown>,
  ): Promise<{ itemId: string; rejected: number; results: Array<'fulfilled' | 'rejected'> }> {
    const ruleId = await createRule(adminUser, [fixed(fixedA.id), fixed(fixedB.id)]);
    const itemId = await createDraft(adminUser, { ruleId, highRisk: true });
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT set_config('app.current_org',$1,true)", [org]);
    await blocker.query('SELECT 1 FROM org_approval_setting WHERE organization_id=$1 FOR UPDATE', [org]);
    const publishPromise = publish(adminUser, itemId, 1);
    const otherPromise = operation(itemId, ruleId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await blocker.query('COMMIT');
    blocker.release();
    const settled = await Promise.allSettled([publishPromise, otherPromise]);
    return {
      itemId,
      rejected: settled.filter((entry) => entry.status === 'rejected').length,
      results: settled.map((entry) => entry.status),
    };
  }

  async function expectInvariant(itemId: string): Promise<void> {
    const item = await itemRow(itemId);
    if (!(item.active && item.published_revision !== null)) return;
    const rule = await ruleRow(item.definition.approval.ruleId);
    const steps = approvalRuleStepsSchema.parse(await ruleSteps(rule.id));
    const fixedIds = steps
      .filter((step): step is Extract<ApprovalRuleStep, { type: 'fixed' }> => step.type === 'fixed')
      .map((step) => step.approverId);
    const setting = await q(
      'SELECT rule_routing_enabled FROM org_approval_setting WHERE organization_id=$1',
      [org],
    );
    expect(item.definition.approval.highRisk).toBe(true);
    expect(rule.active).toBe(true);
    expect(setting.rows[0].rule_routing_enabled).toBe(true);
    expect(fixedIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fixedIds).size).toBe(fixedIds.length);
  }

  it('公開 × ルールの版の追加: どちらかが失敗し、条件の崩れた公開状態は残らない', async () => {
    const { itemId, rejected } = await racingPair((_itemId, ruleId) =>
      run(() => rules.revise(adminUser.auth, ruleId, { expectedRevision: 1, steps: [fixed(fixedA.id)] })),
    );
    expect(rejected).toBeGreaterThanOrEqual(1);
    await expectInvariant(itemId);
  });

  it('公開 × ルールの無効化: どちらかが失敗し、条件の崩れた公開状態は残らない', async () => {
    const { itemId, rejected } = await racingPair((_itemId, ruleId) =>
      run(() => rules.deactivate(adminUser.auth, ruleId)),
    );
    expect(rejected).toBeGreaterThanOrEqual(1);
    await expectInvariant(itemId);
  });

  it('公開 × ルールの使用の停止: どちらかが失敗し、条件の崩れた公開状態は残らない', async () => {
    const { itemId, rejected } = await racingPair(() => enableRouting(false));
    expect(rejected).toBeGreaterThanOrEqual(1);
    await expectInvariant(itemId);
  });
});
