/**
 * 「組織管理者の上長は常に未設定」が**同時実行で破れない**こと
 * (WP-P4-IDM-013 §6 / ADR-0023 §3 / 脅威 T-26)。
 *
 * 逐次の検査では足りない。`updateProfile`(上長の設定)は「対象が有効な `org_admin` か」を、
 * `grantRole`(`org_admin` の付与)は「対象に上長があるか」を検査する。どちらもロックを
 * 取らずに検査すると、2つのトランザクションが互いの未コミットの変更を見られず、
 * **両方が通り、上長を持つ組織管理者ができる。**
 *
 * ここでは実PostgreSQLの2接続で、次を確かめる。
 *
 *   1. 一方を未コミットで止め、他方が**待機する**(`pg_stat_activity` / `pg_blocking_pids`)
 *   2. 先行のコミット後、後続は**409で拒否される**
 *   3. どちらの順序でも、**「有効な `org_admin` かつ上長あり」が残らない**
 *   4. 同じプロフィールを2人が更新したとき、後続の監査の before が**先行の after と一致する**
 *
 * 接続先は使い捨てDB(名前に `test` を含む)に限る。開発用DBを触らないためのガードを
 * 最初に置く(`department-profile-concurrency.test.ts` と同じ方式)。合成データだけを使う。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithContext, newContext } from '@solvi/shared';
import { UserAdminService } from '../../services/api/src/modules/auth/user-admin.service.js';
import type { AuthzContext, RoleCode } from '../../services/api/src/common/authz/authz.js';
import { cleanAuditData } from '../support/cleanup.js';

const PAST = new Date('2020-01-01T00:00:00Z');
const SUFFIX = randomUUID().slice(0, 8);

let admin: pg.Client;
let appUrl: string;
let orgId: string;
let actorA: string;
let actorB: string;

const clients: pg.Client[] = [];
const createdUserIds: string[] = [];

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

function ctxFor(userId: string, roles: RoleCode[]): AuthzContext {
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

async function connectApp(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  clients.push(client);
  return client;
}

/** トランザクションを開き、組織コンテキストを設定する。 */
async function begin(client: pg.Client): Promise<void> {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
}

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
  return rows[0].pid as number;
}

interface Tx {
  client: pg.Client;
  pid: number;
  service: UserAdminService;
}

async function openTx(): Promise<Tx> {
  const client = await connectApp();
  await begin(client);
  return { client, pid: await backendPid(client), service: new UserAdminService(client) };
}

/**
 * 他方のセッションが**そのトランザクションのロック**で待つまで待つ。
 * 単に `wait_event_type = 'Lock'` を見るだけでは、別の待ちと区別できない。
 */
async function waitUntilBlockedBy(
  pid: number,
  blockerPid: number,
  timeoutMs = 4000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      `SELECT wait_event_type,
              pg_blocking_pids(pid) AS blockers
         FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    const blockers = (rows[0]?.blockers as number[] | undefined) ?? [];
    if (rows[0]?.wait_event_type === 'Lock' && blockers.includes(blockerPid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

type Settled = { ok: true; message: '' } | { ok: false; status?: number; message: string };

async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    await promise;
    return { ok: true, message: '' };
  } catch (error) {
    const err = error as Error & { status?: number };
    return { ok: false, status: err.status, message: err.message };
  }
}

async function mkMember(label: string, roles: RoleCode[]): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `wp013-c-${label}-${id.slice(0, 8)}@example.test`, `WP013-C ${label}`],
  );
  for (const role of roles) {
    await admin.query(
      `INSERT INTO role_binding
         (id, user_id, role_id, role_scope, organization_id, source, valid_from)
       VALUES ($1, $2, (SELECT id FROM role WHERE code = $3 AND scope = 'org'),
               'org', $4, 'manual', $5)`,
      [randomUUID(), id, role, orgId, PAST.toISOString()],
    );
  }
  // 有効な所属には必ずプロフィール行がある(0037 のバックフィルと同じ状態)。
  await admin.query('INSERT INTO org_member_profile (organization_id, user_id) VALUES ($1, $2)', [
    orgId,
    id,
  ]);
  createdUserIds.push(id);
  return id;
}

/** 確定した最終状態。不変条件の検査に使う。 */
async function finalState(userId: string): Promise<{
  managerUserId: string | null;
  effectiveAdmin: boolean;
}> {
  const { rows } = await admin.query(
    `SELECT p.manager_user_id,
            EXISTS (
              SELECT 1 FROM role_binding rb
                JOIN role r ON r.id = rb.role_id
               WHERE rb.user_id = p.user_id AND rb.organization_id = p.organization_id
                 AND r.code = 'org_admin'
                 AND rb.valid_from <= clock_timestamp()
                 AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
            ) AS effective_admin
       FROM org_member_profile p
      WHERE p.organization_id = $1 AND p.user_id = $2`,
    [orgId, userId],
  );
  return {
    managerUserId: (rows[0]?.manager_user_id as string | null) ?? null,
    effectiveAdmin: rows[0]?.effective_admin === true,
  };
}

beforeAll(async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const url = process.env.DATABASE_URL;
  if (!adminUrl || !url) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  appUrl = url;
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  // **開発用DBへ書かない。** 使い捨てDB(名前に test を含む)でなければここで止める。
  const probe = new pg.Client({ connectionString: appUrl });
  await probe.connect();
  const names = [
    (await admin.query('SELECT current_database() AS n')).rows[0].n as string,
    (await probe.query('SELECT current_database() AS n')).rows[0].n as string,
  ];
  await probe.end();
  for (const name of names) {
    if (!name.includes('test')) {
      await admin.end();
      throw new Error(`接続先 ${name} は使い捨てDB(名前に test を含む)ではありません。中止します`);
    }
  }

  orgId = randomUUID();
  await admin.query('INSERT INTO organization (id, code, name) VALUES ($1, $2, $3)', [
    orgId,
    `wp013-c-${SUFFIX}`,
    'WP-P4-IDM-013 concurrency (合成)',
  ]);
  actorA = await mkMember('actor-a', ['org_admin']);
  actorB = await mkMember('actor-b', ['org_admin']);
});

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => undefined);
  if (!admin || !orgId) return;
  await cleanAuditData(admin, `organization_id = '${orgId}'`);
  await admin.query(
    'UPDATE org_member_profile SET manager_user_id = NULL WHERE organization_id = $1',
    [orgId],
  );
  await admin.query('DELETE FROM org_member_profile WHERE organization_id = $1', [orgId]);
  await admin.query('DELETE FROM role_binding WHERE organization_id = $1', [orgId]);
  if (createdUserIds.length > 0) {
    await admin.query('DELETE FROM app_user WHERE id = ANY($1::uuid[])', [createdUserIds]);
  }
  await admin.query('DELETE FROM organization WHERE id = $1', [orgId]);
  await admin.end();
});

describe('「上長の設定」と「org_admin の付与」は同時でも両立しない (ADR-0023 §3)', () => {
  it('**上長の設定が先行**: 付与は待機し、409で拒否される。上長を持つ組織管理者は残らない', async () => {
    const target = await mkMember('set-first', ['requester']);
    const manager = await mkMember('set-first-manager', ['agent']);
    const leader = await openTx();
    const follower = await openTx();

    try {
      // 先行: 上長を設定(未コミット。プロフィール行のロックを保持)
      await run(() =>
        leader.service.updateProfile(ctxFor(actorA, ['org_admin']), target, {
          managerUserId: manager,
        }),
      );

      // 後続: org_admin を付与。先行がコミットするまで待つ。
      const second = settle(
        run(() =>
          follower.service.grantRole(ctxFor(actorB, ['org_admin']), target, 'org_admin', {
            validUntil: null,
            reason: '同時実行の検査(上長の設定が先行)',
          }),
        ),
      );
      const waited = await waitUntilBlockedBy(follower.pid, leader.pid);
      await leader.client.query('COMMIT');
      const result = await second;
      await follower.client.query(result.ok ? 'COMMIT' : 'ROLLBACK');

      expect(waited, '後続が待機していない(ロックが効いていない)').toBe(true);
      expect(result.ok, '上長付きの利用者に org_admin が付与された').toBe(false);
      expect(result.ok ? undefined : result.status).toBe(409);

      const state = await finalState(target);
      expect(state.managerUserId).toBe(manager);
      expect(state.effectiveAdmin).toBe(false);
      expect(state.effectiveAdmin && state.managerUserId !== null).toBe(false);
    } finally {
      // 失敗してもロックを残さない。コミット済みなら警告のみで無害。
      await leader.client.query('ROLLBACK').catch(() => undefined);
      await follower.client.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('**org_admin の付与が先行**: 上長の設定は待機し、409で拒否される。上長を持つ組織管理者は残らない', async () => {
    const target = await mkMember('grant-first', ['requester']);
    const manager = await mkMember('grant-first-manager', ['agent']);
    const leader = await openTx();
    const follower = await openTx();

    try {
      // 先行: org_admin を付与(未コミット。プロフィール行のロックを保持)
      await run(() =>
        leader.service.grantRole(ctxFor(actorA, ['org_admin']), target, 'org_admin', {
          validUntil: null,
          reason: '同時実行の検査(付与が先行)',
        }),
      );

      // 後続: 上長を設定。先行がコミットするまで待つ。
      const second = settle(
        run(() =>
          follower.service.updateProfile(ctxFor(actorB, ['org_admin']), target, {
            managerUserId: manager,
          }),
        ),
      );
      const waited = await waitUntilBlockedBy(follower.pid, leader.pid);
      await leader.client.query('COMMIT');
      const result = await second;
      await follower.client.query(result.ok ? 'COMMIT' : 'ROLLBACK');

      expect(waited, '後続が待機していない(ロックが効いていない)').toBe(true);
      expect(result.ok, '組織管理者に上長が設定された').toBe(false);
      expect(result.ok ? undefined : result.status).toBe(409);

      const state = await finalState(target);
      expect(state.effectiveAdmin).toBe(true);
      expect(state.managerUserId).toBeNull();
      expect(state.effectiveAdmin && state.managerUserId !== null).toBe(false);
    } finally {
      await leader.client.query('ROLLBACK').catch(() => undefined);
      await follower.client.query('ROLLBACK').catch(() => undefined);
    }
  });
});

describe('同じプロフィールの同時更新 (監査の before)', () => {
  it('**後続の監査の before は先行の after と一致する**', async () => {
    const target = await mkMember('audit-target', ['requester']);
    const leader = await openTx();
    const follower = await openTx();

    try {
      await run(() =>
        leader.service.updateProfile(ctxFor(actorA, ['org_admin']), target, {
          jobTitle: '先行の役職',
        }),
      );
      const second = settle(
        run(() =>
          follower.service.updateProfile(ctxFor(actorB, ['org_admin']), target, {
            jobTitle: '後続の役職',
          }),
        ),
      );
      const waited = await waitUntilBlockedBy(follower.pid, leader.pid);
      await leader.client.query('COMMIT');
      const result = await second;
      await follower.client.query(result.ok ? 'COMMIT' : 'ROLLBACK');

      expect(waited, '後続が待機していない(ロックが効いていない)').toBe(true);
      expect(result.ok).toBe(true);

      const { rows } = await admin.query(
        `SELECT before_state, after_state
           FROM audit_event
          WHERE organization_id = $1
            AND subject_user_id = $2
            AND event_type = 'org.member.profile.updated'
          ORDER BY event_id`,
        [orgId, target],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].after_state.jobTitle).toBe('先行の役職');
      expect(rows[1].before_state.jobTitle).toBe(rows[0].after_state.jobTitle);
      expect(rows[1].after_state.jobTitle).toBe('後続の役職');
    } finally {
      await leader.client.query('ROLLBACK').catch(() => undefined);
      await follower.client.query('ROLLBACK').catch(() => undefined);
    }
  });
});
