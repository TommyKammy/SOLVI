/**
 * WP-P4-APR-014: Migration 0038 の互換テスト(TL-05)。
 *
 * 0037 までの状態を持つ使い捨てDBを作り、**移行前のデータを書き換えずに** 0038 を適用する。
 * - 既存の承認行は step_no=1 / authority_type='legacy' / route_generation=1 で読める
 * - 既存申請の route は NULL のまま(再解決しない)
 * - 移行前後の表示・決定・作業チェック・模擬完了が壊れない
 * - 新しい列にデータがあると down は拒否する
 * - 既存データに重複があれば Migration は失敗する(黙って直さない)
 *
 * DB名は `solvi_wp014_test_compat_<乱数>`。テストが自分で作成し、最後に削除する。
 * 開発用DB(`solvi`)には接続しない(名前ガードで即失敗する)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { newContext, runWithContext } from '@solvi/shared';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { routeHash } from '../../services/api/src/modules/catalog/approval-state.js';
import { hash } from '../../services/api/src/modules/catalog/snapshot-hash.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';

const ROOT = join(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'db/migrations');
const DB_NAME = `solvi_wp014_test_compat_${randomUUID().slice(0, 8)}`;
const ORG = uuidv7();
const REQUESTER = uuidv7();
const APPROVER = uuidv7();
const AGENT = uuidv7();
const PAST = new Date('2026-01-01T00:00:00Z');

const legacyId = uuidv7();
const legacyTicket = uuidv7();
const legacyRevision = 1;
const legacyApproval = uuidv7();
const controlId = uuidv7();
const controlTicket = uuidv7();
const controlApproval = uuidv7();
const duplicateId = uuidv7();
const duplicateTicket = uuidv7();
const duplicateApproval = uuidv7();
const duplicateExtra = uuidv7();
const legacyAudit = uuidv7();
const itemId = uuidv7();

const definition = {
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象(移行前)',
  allowedDurations: [7],
  maxReasonLength: 2000,
  approval: { mode: 'fixed', approverId: APPROVER },
  checklist: [{ key: 'prepare', label: '準備確認', required: true }],
};
const snapshot = {
  item: { id: itemId, version: 1, title: '合成 移行前申請', definition },
  inputs: { reason: '合成: 移行前のデータ', durationDays: 7 },
  requesterId: REQUESTER,
};
const snapshotHash = hash(snapshot);

let maintenance: pg.Client;
let admin: pg.Client;
let pool: pg.Pool;
let controller: CatalogController;
let adminUrl: string;

type Migration = { name: string; up: string; checksum: string };

function migrations(): Migration[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(MIGRATIONS, file), 'utf8');
      const upStart = raw.indexOf('-- +migrate up');
      const downStart = raw.indexOf('-- +migrate down');
      if (upStart < 0 || downStart < 0) throw new Error(`${file}: markers missing`);
      return {
        name: file,
        up: raw.slice(upStart + '-- +migrate up'.length, downStart).trim(),
        checksum: createHash('sha256').update(raw).digest('hex'),
      };
    });
}

async function applyThrough(target: string): Promise<void> {
  await admin.query(`CREATE TABLE IF NOT EXISTS schema_migration (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT current_user
  )`);
  for (const migration of migrations()) {
    const version = migration.name.slice(0, 4);
    if (version > target) break;
    const exists = await admin.query('SELECT 1 FROM schema_migration WHERE version=$1', [version]);
    if (exists.rowCount) continue;
    await admin.query('BEGIN');
    try {
      await admin.query(migration.up);
      await admin.query('INSERT INTO schema_migration(version,name,checksum) VALUES($1,$2,$3)', [
        version,
        migration.name,
        migration.checksum,
      ]);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }
}

function migrate(command: 'up' | 'down'): { ok: boolean; output: string } {
  try {
    const out = execFileSync('node', ['tools/migrate.mjs', command], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

let ticketSeq = 0;

async function insertRequest(input: {
  id: string;
  ticketId: string;
  approvalId: string;
  idempotencyKey: string;
  title: string;
}): Promise<void> {
  await admin.query('BEGIN');
  try {
    await q(
      `INSERT INTO ticket(id,organization_id,number,kind,state,subject,body,requester_id,impact,urgency,priority)
       VALUES($1,$2,$3,'request','new',$4,'合成: 移行前チケット',$5,'low','low','low')`,
      [
        input.ticketId,
        ORG,
        `REQ-2026-${String(++ticketSeq).padStart(6, '0')}`,
        input.title,
        REQUESTER,
      ],
    );
    await q(
      `INSERT INTO local_service_request(id,organization_id,item_id,requester_id,ticket_id,idempotency_key,version,revision,state,snapshot,snapshot_hash,current_approval_id)
       VALUES($1,$2,$3,$4,$5,$6,1,1,'pending',$7,$8,$9)`,
      [
        input.id,
        ORG,
        itemId,
        REQUESTER,
        input.ticketId,
        input.idempotencyKey,
        snapshot,
        snapshotHash,
        input.approvalId,
      ],
    );
    await q(
      `INSERT INTO local_request_revision(request_id,organization_id,revision,snapshot,snapshot_hash,changed_by)
       VALUES($1,$2,1,$3,$4,$5)`,
      [input.id, ORG, snapshot, snapshotHash, REQUESTER],
    );
    await q(
      `INSERT INTO local_request_approval(id,organization_id,request_id,revision,snapshot_hash,approver_id,state,expires_at)
       VALUES($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '72 hours')`,
      [input.approvalId, ORG, input.id, snapshotHash, APPROVER],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

function actor(userId: string, role: 'requester' | 'approver' | 'agent'): AuthenticatedRequest {
  return {
    userId,
    sessionId: uuidv7(),
    authz: {
      organizationId: ORG,
      principal: {
        userId,
        status: 'active',
        bindings: [{ roleCode: role, organizationId: ORG, validFrom: PAST, validUntil: null }],
      },
    },
  };
}
const run = <T>(fn: () => Promise<T>) => runWithContext(newContext(), fn);

beforeAll(async () => {
  const rawAdmin = process.env.DATABASE_ADMIN_URL;
  const rawApp = process.env.DATABASE_URL;
  if (!rawAdmin || !rawApp) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  const maintenanceUrl = new URL(rawAdmin);
  maintenanceUrl.pathname = '/postgres';
  maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  const current = (await maintenance.query('SELECT current_database() AS n')).rows[0].n as string;
  if (current.includes('test') && !current.includes('wp014'))
    throw new Error('保守接続のDB名が想定と違います。中止します');
  if (!/^[a-z0-9_]+$/.test(DB_NAME) || !DB_NAME.includes('wp014') || !DB_NAME.includes('test'))
    throw new Error('テスト用DB名が不正です。中止します');

  const exists = await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1', [DB_NAME]);
  if (exists.rowCount) throw new Error(`テスト用DB ${DB_NAME} が既に存在します。中止します`);
  await maintenance.query(`CREATE DATABASE ${DB_NAME}`);

  const dbAdmin = new URL(rawAdmin);
  dbAdmin.pathname = `/${DB_NAME}`;
  adminUrl = dbAdmin.toString();
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const appUrl = new URL(rawApp);
  appUrl.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: appUrl.toString(), max: 4 });
  const name = (await pool.query('SELECT current_database() AS n')).rows[0].n as string;
  if (!name.includes('wp014') || !name.includes('test'))
    throw new Error(`接続先 ${name} は使い捨てDBではありません。中止します`);

  // 0037 までの状態を作る
  await applyThrough('0037');

  // 移行前のデータ(route 列はまだ存在しない)
  await q('INSERT INTO organization(id,code,name) VALUES($1,$2,$3)', [
    ORG,
    `apr014-${ORG.slice(0, 8)}`,
    '合成 移行前組織',
  ]);
  for (const [id, role] of [
    [REQUESTER, 'requester'],
    [APPROVER, 'approver'],
    [AGENT, 'agent'],
  ] as const) {
    await q(
      `INSERT INTO app_user(id,primary_email,display_name,status,created_via)
       VALUES($1,$2,$3,'active','admin')`,
      [id, `apr014-compat-${id}@example.test`, `合成 ${role}`],
    );
    const r = (await q('SELECT id,scope FROM role WHERE code=$1', [role])).rows[0];
    await q(
      `INSERT INTO role_binding(id,user_id,role_id,role_scope,organization_id,source,valid_from,valid_until)
       VALUES($1,$2,$3,$4,$5,'manual',$6,NULL)`,
      [uuidv7(), id, r.id, r.scope, ORG, PAST],
    );
  }
  await q(
    `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition)
     VALUES($1,$2,$3,1,'合成 移行前申請','APR-014 互換テスト',$4)`,
    [itemId, ORG, `apr014-compat-${itemId}`, definition],
  );

  await insertRequest({
    id: legacyId,
    ticketId: legacyTicket,
    approvalId: legacyApproval,
    idempotencyKey: uuidv7(),
    title: '合成 移行前申請',
  });
  await insertRequest({
    id: controlId,
    ticketId: controlTicket,
    approvalId: controlApproval,
    idempotencyKey: uuidv7(),
    title: '合成 移行前申請(対照)',
  });
  await insertRequest({
    id: duplicateId,
    ticketId: duplicateTicket,
    approvalId: duplicateApproval,
    idempotencyKey: uuidv7(),
    title: '合成 重複行',
  });
  // 既存スキーマでは同一版に複数の承認行を作れる。0038 はこれを黙って直さず失敗する。
  await q(
    `INSERT INTO local_request_approval(id,organization_id,request_id,revision,snapshot_hash,approver_id,state,expires_at)
     VALUES($1,$2,$3,1,$4,$5,'pending',clock_timestamp()+interval '72 hours')`,
    [duplicateExtra, ORG, duplicateId, snapshotHash, REQUESTER],
  );
  // 既存の request.* 監査行(書き換えないことの確認用)
  await q(
    `INSERT INTO audit_event(event_id,event_type,organization_id,actor_type,actor_id,target_type,target_id,action,outcome,correlation_id,after_state)
     VALUES($1,'request.approved',$2,'user',$3,'service_request',$4,'request.approved','success',$5,$6)`,
    [
      legacyAudit,
      ORG,
      APPROVER,
      legacyId,
      uuidv7(),
      { revision: legacyRevision, simulation: true },
    ],
  );
}, 120_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  if (maintenance) {
    try {
      if (DB_NAME.includes('wp014') && DB_NAME.includes('test'))
        await maintenance.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    } finally {
      await maintenance.end().catch(() => undefined);
    }
  }
});

describe('0038: 適用前後の互換(TL-05)', () => {
  it('既存データに重複があると 0038 は失敗し、中途半端な列を残さない', async () => {
    const before = (
      await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='local_request_approval' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(before).not.toContain('step_no');

    const up = migrations().find((m) => m.name.startsWith('0038'))!.up;
    let caught: (Error & { code?: string }) | undefined;
    await admin.query('BEGIN');
    try {
      await admin.query(up);
    } catch (error) {
      caught = error as Error & { code?: string };
    } finally {
      await admin.query('ROLLBACK');
    }
    expect(caught, '重複行があるのに 0038 が成功した').toBeDefined();
    expect(caught?.code).toBe('23505');
    expect(caught?.message).toContain('local_request_approval_step_key');

    const after = (
      await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='local_request_approval' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(after).toEqual(before);
    // 重複を消してから、実際の Migration ツールで適用する
    await q('DELETE FROM local_request_approval WHERE id=$1', [duplicateExtra]);
  }, 120_000);

  it('0038 を適用すると既存行が legacy 1段でバックフィルされ、既存申請は再解決されない', async () => {
    const up = migrate('up');
    expect(up.ok, up.output).toBe(true);
    expect(up.output).toContain('0038_approval_route_and_steps.sql');

    const revisions = (
      await q(
        `SELECT request_id,revision,route,route_hash,route_generation,snapshot,snapshot_hash
           FROM local_request_revision WHERE request_id=ANY($1::uuid[])`,
        [[legacyId, controlId, duplicateId]],
      )
    ).rows;
    expect(revisions).toHaveLength(3);
    for (const revision of revisions) {
      expect(revision.route).toBeNull();
      expect(revision.route_hash).toBeNull();
      expect(revision.route_generation).toBe(1);
      expect(revision.snapshot).toEqual(snapshot);
      expect(revision.snapshot_hash).toBe(snapshotHash);
    }
    const approvals = (
      await q(
        `SELECT request_id,step_no,route_generation,authority_type,resolved_from,decided_by,approver_id,state
           FROM local_request_approval WHERE request_id=ANY($1::uuid[]) ORDER BY request_id`,
        [[legacyId, controlId, duplicateId]],
      )
    ).rows;
    expect(approvals).toHaveLength(3);
    for (const approval of approvals)
      expect(approval).toMatchObject({
        step_no: 1,
        route_generation: 1,
        authority_type: 'legacy',
        resolved_from: null,
        decided_by: null,
        approver_id: APPROVER,
        state: 'pending',
      });

    // 旧 request.* 監査行は書き換えない
    const audit = (await q('SELECT * FROM audit_event WHERE event_id=$1', [legacyAudit])).rows[0];
    expect(audit).toMatchObject({
      event_type: 'request.approved',
      target_id: legacyId,
      after_state: { revision: 1, simulation: true },
    });
  }, 120_000);

  it('移行前後で同じ申請の表示・snapshot が変わらない', async () => {
    const legacy = (await q('SELECT * FROM local_service_request WHERE id=$1', [legacyId])).rows[0];
    expect(legacy.state).toBe('pending');
    expect(legacy.snapshot).toEqual(snapshot);
    expect(legacy.snapshot_hash).toBe(snapshotHash);
    controller = new CatalogController(
      pool,
      {} as ConstructorParameters<typeof CatalogController>[1],
      true,
    );
    const details = await run(() => controller.detail(actor(REQUESTER, 'requester'), legacyId));
    expect(details.request).toMatchObject({
      id: legacyId,
      state: 'pending',
      version: 1,
      revision: 1,
      snapshotHash,
    });
    expect(details.request.snapshot).toEqual(snapshot);
    expect(details.approval).toMatchObject({
      id: legacyApproval,
      state: 'pending',
      approver_id: APPROVER,
      step_no: 1,
      authority_type: 'legacy',
    });
    expect(details.steps).toHaveLength(1);
    expect(details.steps[0]).toMatchObject({
      id: legacyApproval,
      stepNo: 1,
      state: 'pending',
      authorityType: 'legacy',
    });
    expect(details.history).toHaveLength(1);
  }, 120_000);

  it('新しい列にデータが無ければ down → up でき、移行前の行は legacy のまま', async () => {
    const down = migrate('down');
    expect(down.ok, down.output).toBe(true);
    const columns = (
      await q(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='local_request_approval' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);
    expect(columns).not.toContain('step_no');
    const up = migrate('up');
    expect(up.ok, up.output).toBe(true);
    const legacy = (
      await q(
        'SELECT step_no,authority_type,route_generation FROM local_request_approval WHERE id=$1',
        [legacyApproval],
      )
    ).rows[0];
    expect(legacy).toEqual({ step_no: 1, authority_type: 'legacy', route_generation: 1 });
  }, 120_000);

  it('route が非NULLの行があると down を拒否する(前進修復)', async () => {
    const route = {
      steps: [{ stepNo: 1, approverId: APPROVER, authorityType: 'fixed', resolvedFrom: null }],
      ruleRef: null,
    };
    await q(
      'UPDATE local_request_revision SET route=$2,route_hash=$3 WHERE request_id=$1 AND revision=1',
      [controlId, route, routeHash(route)],
    );
    const down = migrate('down');
    expect(down.ok).toBe(false);
    expect(down.output).toContain('0038 rollback refused');
    expect((await q("SELECT 1 FROM schema_migration WHERE version='0038'")).rowCount).toBe(1);
    expect(
      (
        await q(
          `SELECT 1 FROM information_schema.columns
            WHERE table_name='local_request_approval' AND column_name='step_no'`,
        )
      ).rowCount,
    ).toBe(1);
  }, 120_000);

  it('移行前の申請はそのまま決定・作業チェック・模擬完了できる', async () => {
    await expect(
      run(() =>
        controller.decide(actor(APPROVER, 'approver'), legacyId, {
          decision: 'approve',
          expectedVersion: 1,
        }),
      ),
    ).resolves.toEqual({ id: legacyId, state: 'approved', stepState: 'approved' });
    await expect(
      run(() =>
        controller.updateChecklist(actor(AGENT, 'agent'), legacyId, {
          requestRevision: 1,
          expectedVersion: 1,
          key: 'prepare',
          completed: true,
        }),
      ),
    ).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(
      run(() => controller.simulate(actor(AGENT, 'agent'), legacyId, { expectedVersion: 2 })),
    ).resolves.toMatchObject({ replayed: false });
    expect(
      (await q('SELECT state FROM local_service_request WHERE id=$1', [legacyId])).rows[0].state,
    ).toBe('completed');

    const events = (
      await q(
        `SELECT event_type FROM audit_event WHERE target_id=$1 AND event_type LIKE 'approval.%'`,
        [legacyId],
      )
    ).rows.map((r) => r.event_type);
    expect(events).toContain('approval.approved');
    expect(events).not.toContain('request.approved');
    // 既存の request.* 行は残る
    expect((await q('SELECT 1 FROM audit_event WHERE event_id=$1', [legacyAudit])).rowCount).toBe(
      1,
    );
  }, 120_000);
});
