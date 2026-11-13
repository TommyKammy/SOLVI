/**
 * WP-P4-APR-011: 全ステップ承認の実行前検証(assertApprovalComplete)を実PostgreSQLで確認する。
 *
 * - TL-04: 実DB + RLS(アプリ接続は solvi_app)。承認バイパス(TL-16)は、DBを直接書き換えて
 *   「承認後に内容・版・承認者・期限が壊れた」状態を作り、作業チェック更新と模擬完了が止まることで確認する。
 * - **追加のみ**。既存データを消さない・初期化しない(合成の利用者・カタログ・申請を新規に作る)。
 *   終了時は、このテストが作った行だけを best-effort で片付ける(失敗しても他の行には触れない)。
 *
 * 挙動変更(ADR-0023 §7): 承認後に承認者が無効になっても、実行(作業チェック更新・模擬完了)は止まらない。
 * 変更前は実行時に validateApprover が再照会し、現在有効な承認者でなければ **403** で止めていた。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { hash } from '../../services/api/src/modules/catalog/snapshot-hash.js';
import { checkApprovalComplete } from '../../services/api/src/modules/catalog/approval-assertion.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';

const ORG = '00000000-0000-4000-9000-000000000001';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let controller: CatalogController;
const made = {
  users: [] as string[],
  items: [] as string[],
  requests: [] as string[],
  bindings: [] as string[],
};

type Role = 'requester' | 'approver' | 'agent';
const run = <T>(fn: () => Promise<T>) => runWithContext(newContext(), fn);

async function makeUser(role: Role, extraRoles: Role[] = []) {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `apr011-${id}@example.test`, `合成 ${role}`],
  );
  made.users.push(id);
  const bindings: string[] = [];
  for (const code of [role, ...extraRoles]) {
    const r = (await admin.query('SELECT id, scope FROM role WHERE code=$1', [code])).rows[0];
    const bindingId = uuidv7();
    await admin.query(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,NULL)`,
      [bindingId, id, r.id, r.scope, ORG, PAST],
    );
    made.bindings.push(bindingId);
    bindings.push(bindingId);
  }
  return { id, bindings, roles: [role, ...extraRoles] };
}

const actor = (user: { id: string; roles: Role[] }): AuthenticatedRequest => ({
  userId: user.id,
  sessionId: uuidv7(),
  authz: {
    organizationId: ORG,
    principal: {
      userId: user.id,
      status: 'active',
      bindings: user.roles.map((roleCode) => ({
        roleCode,
        organizationId: ORG,
        validFrom: PAST,
        validUntil: null,
      })),
    },
  },
});

const definition = (approverId?: string) => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  ...(approverId ? { approval: { mode: 'fixed', approverId } } : {}),
  checklist: [{ key: 'prepare', label: '準備確認', required: true }],
});

async function makeItem(approverId?: string) {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition)
     VALUES($1,$2,$3,1,'合成 承認検証','APR-011 合成データ',$4)`,
    [id, ORG, `apr011-${id}`, definition(approverId)],
  );
  made.items.push(id);
  return id;
}

/** 申請 → 承認までを実コントローラで通し、approved の申請を返す。 */
async function approvedRequest(opts: { fixed?: boolean } = {}) {
  const requester = await makeUser('requester');
  const approver = await makeUser('approver');
  const agent = await makeUser('agent');
  const itemId = await makeItem(opts.fixed ? approver.id : undefined);
  const created = await run(() =>
    controller.create(actor(requester), {
      itemId,
      itemVersion: 1,
      idempotencyKey: uuidv7(),
      approverId: approver.id,
      reason: '合成: 承認後の実行検証',
      durationDays: 7,
    }),
  );
  made.requests.push(created.id);
  await run(() =>
    controller.decide(actor(approver), created.id, {
      decision: 'approve',
      expectedVersion: 1,
    }),
  );
  return { requester, approver, agent, id: created.id, ticketId: created.ticketId };
}

type Ctx = Awaited<ReturnType<typeof approvedRequest>>;
const checklistBody = (revision = 1, version = 1) => ({
  requestRevision: revision,
  expectedVersion: version,
  key: 'prepare',
  completed: true,
});
const tick = (c: Ctx) =>
  run(() => controller.updateChecklist(actor(c.agent), c.id, checklistBody()));
const simulate = async (c: Ctx) => {
  const version = (
    await admin.query('SELECT version FROM local_service_request WHERE id=$1', [c.id])
  ).rows[0].version;
  return run(() => controller.simulate(actor(c.agent), c.id, { expectedVersion: version }));
};
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
const check = async (c: Ctx) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [ORG]);
    const result = await checkApprovalComplete(client, { organizationId: ORG, requestId: c.id });
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
};

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const storage = {} as ConstructorParameters<typeof CatalogController>[1];
  controller = new CatalogController(pool, storage, true);
}, 30_000);

afterAll(async () => {
  // このテストが作った行だけを best-effort で削除する。失敗しても続行する(監査はappend-onlyのため残る)。
  const attempt = async (sql: string, params: unknown[]) => {
    try {
      await admin.query(sql, params);
    } catch {
      /* 片付け失敗は検証結果に影響しない */
    }
  };
  if (admin) {
    const tickets = (
      await admin
        .query('SELECT ticket_id FROM local_service_request WHERE id=ANY($1::uuid[])', [
          made.requests,
        ])
        .catch(() => ({ rows: [] as { ticket_id: string }[] }))
    ).rows.map((r) => r.ticket_id);
    const r = [made.requests];
    await attempt('DELETE FROM local_simulation_receipt WHERE request_id=ANY($1::uuid[])', r);
    await attempt(
      'DELETE FROM local_request_checklist_progress WHERE request_id=ANY($1::uuid[])',
      r,
    );
    try {
      await admin.query('BEGIN');
      // request.current_approval_id の外部キーは DEFERRED。承認 → 版 → 申請の順に消す。
      await admin.query('DELETE FROM local_request_approval WHERE request_id=ANY($1::uuid[])', r);
      await admin.query('DELETE FROM local_request_revision WHERE request_id=ANY($1::uuid[])', r);
      await admin.query('DELETE FROM local_service_request WHERE id=ANY($1::uuid[])', r);
      await admin.query('COMMIT');
    } catch {
      await admin.query('ROLLBACK').catch(() => undefined);
    }
    for (const t of ['ticket_comment', 'ticket_assignment', 'ticket_attachment'])
      await attempt(`DELETE FROM ${t} WHERE ticket_id=ANY($1::uuid[])`, [tickets]);
    await attempt('DELETE FROM ticket WHERE id=ANY($1::uuid[])', [tickets]);
    await attempt('DELETE FROM local_catalog_item WHERE id=ANY($1::uuid[])', [made.items]);
    await attempt('DELETE FROM role_binding WHERE id=ANY($1::uuid[])', [made.bindings]);
    await attempt('DELETE FROM app_user WHERE id=ANY($1::uuid[])', [made.users]);
  }
  await admin?.end();
  await pool?.end();
});

describe('既存の保存済み snapshot_hash との互換(TL-02)', () => {
  it('DBにある全申請・全版の snapshot_hash が、抽出後の hash() の再計算値と一致する', async () => {
    // 空のDBでも通るよう、比較対象をこのテストで作る(既存申請の存在を前提にしない)。
    const c = await approvedRequest();
    const requests = (
      await q('SELECT id, snapshot, snapshot_hash FROM local_service_request WHERE id=$1', [c.id])
    ).rows;
    const revisions = (
      await q(
        'SELECT request_id, revision, snapshot, snapshot_hash FROM local_request_revision WHERE request_id=$1',
        [c.id],
      )
    ).rows;
    expect(requests.length).toBeGreaterThan(0);
    for (const row of [...requests, ...revisions])
      expect(hash(row.snapshot), `hash drift in ${row.id ?? row.request_id}`).toBe(
        row.snapshot_hash,
      );
  });
});

describe('成功経路(固定承認者なし/あり)', () => {
  it.each([false, true])(
    '承認 → 作業チェック更新 → 模擬完了が通り、監査イベントが残る(固定承認者=%s)',
    async (fixed) => {
      const c = await approvedRequest({ fixed });
      expect(await check(c)).toMatchObject({ ok: true });
      await tick(c);
      const result = await simulate(c);
      expect(result.replayed).toBe(false);
      expect(
        (await q('SELECT state FROM local_service_request WHERE id=$1', [c.id])).rows[0].state,
      ).toBe('completed');
      const events = (
        await q('SELECT event_type FROM audit_event WHERE target_id=$1 ORDER BY occurred_at', [
          c.id,
        ])
      ).rows.map((r) => r.event_type);
      expect(events).toEqual(
        expect.arrayContaining([
          'request.submitted',
          'approval.requested',
          'approval.approved',
          'request.checklist.updated',
          'request.simulated',
        ]),
      );
      // 冪等: 完了後の再実行は既存レシートを返し、検証でも拒否されない
      expect((await simulate(c)).replayed).toBe(true);
    },
    30_000,
  );
});

describe('ADR-0023 §7: 承認者が後から無効になっても、承認済みの実行は止まらない(挙動変更)', () => {
  it('承認後に承認者の app_user.status を deactivated にしても作業チェック更新と模擬完了が成功する(変更前は validateApprover により403で止まっていた)', async () => {
    const c = await approvedRequest();
    await q("UPDATE app_user SET status='deactivated', deactivated_at=now() WHERE id=$1", [
      c.approver.id,
    ]);
    expect(await check(c)).toMatchObject({ ok: true });
    await expect(tick(c)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(c)).resolves.toMatchObject({ replayed: false });
  }, 30_000);
  it('承認後に承認者の approver ロールの role_binding を期限切れにしても成功する(変更前は403で止まっていた)', async () => {
    const c = await approvedRequest();
    await q('UPDATE role_binding SET valid_until=$2 WHERE id=ANY($1::uuid[])', [
      c.approver.bindings,
      new Date(Date.now() - 1000),
    ]);
    await expect(tick(c)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(c)).resolves.toMatchObject({ replayed: false });
  }, 30_000);
  it('承認後に承認者の approver ロールの role_binding を削除しても成功する(変更前は403で止まっていた)', async () => {
    const c = await approvedRequest();
    await q('DELETE FROM role_binding WHERE id=ANY($1::uuid[])', [c.approver.bindings]);
    await expect(tick(c)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(c)).resolves.toMatchObject({ replayed: false });
  }, 30_000);
});

describe('承認バイパスの拒否(TL-16): 承認後にDBの状態が壊れた場合は409で止まる', () => {
  const rejected = async (c: Ctx) => {
    await expect(tick(c)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(c)).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await q('SELECT count(*)::int AS n FROM local_simulation_receipt WHERE request_id=$1', [
          c.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect((await check(c)).ok).toBe(false);
  };
  const mutations: [string, (c: Ctx) => Promise<unknown>, boolean?][] = [
    [
      '申請の本文を承認後に改変した(再計算hashと不一致)',
      (c) =>
        q(
          `UPDATE local_service_request SET snapshot=jsonb_set(snapshot,'{inputs,reason}','"承認後の改変"') WHERE id=$1`,
          [c.id],
        ),
    ],
    [
      '承認行の snapshot_hash が申請と不一致',
      (c) =>
        q('UPDATE local_request_approval SET snapshot_hash=$2 WHERE request_id=$1', [
          c.id,
          '0'.repeat(64),
        ]),
    ],
    [
      '版(local_request_revision)の snapshot_hash が申請と不一致',
      (c) =>
        q('UPDATE local_request_revision SET snapshot_hash=$2 WHERE request_id=$1', [
          c.id,
          '1'.repeat(64),
        ]),
    ],
    [
      '期限切れ',
      (c) =>
        q(
          "UPDATE local_request_approval SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1",
          [c.id],
        ),
    ],
    [
      'decided_at が期限より後',
      (c) =>
        q(
          "UPDATE local_request_approval SET decided_at=expires_at+interval '1 hour' WHERE request_id=$1",
          [c.id],
        ),
    ],
    [
      '承認行が approved でない(pending に戻された)',
      (c) => q("UPDATE local_request_approval SET state='pending' WHERE request_id=$1", [c.id]),
    ],
    [
      '現在の版に有効な承認行がもう1行ある',
      async (c) => {
        const extra = await makeUser('approver');
        await q(
          `INSERT INTO local_request_approval(id,organization_id,request_id,revision,route_generation,step_no,snapshot_hash,approver_id,authority_type,state,expires_at)
           SELECT $2,organization_id,request_id,revision,route_generation,2,snapshot_hash,$3,'legacy','pending',expires_at FROM local_request_approval WHERE request_id=$1 AND step_no=1`,
          [c.id, uuidv7(), extra.id],
        );
      },
    ],
    [
      '承認行の承認者が、固定承認者と異なる者に差し替えられた',
      async (c) => {
        const other = await makeUser('approver');
        await q('UPDATE local_request_approval SET approver_id=$2 WHERE request_id=$1', [
          c.id,
          other.id,
        ]);
      },
      true,
    ],
  ];
  it.each(mutations)(
    '%s',
    async (_name, mutate, fixed) => {
      const c = await approvedRequest({ fixed: fixed === true });
      await mutate(c);
      await rejected(c);
    },
    30_000,
  );

  it('承認後に申請内容を変更すると(再承認待ち)実行できない', async () => {
    const c = await approvedRequest();
    await run(() =>
      controller.edit(actor(c.requester), c.id, {
        expectedVersion: 2,
        approverId: c.approver.id,
        reason: '合成: 承認後の変更',
        durationDays: 7,
      }),
    );
    await expect(
      run(() => controller.updateChecklist(actor(c.agent), c.id, checklistBody(2))),
    ).rejects.toMatchObject({ status: 409 });
    await expect(simulate(c)).rejects.toMatchObject({ status: 409 });
    expect((await check(c)).ok).toBe(false);
  }, 30_000);

  it('承認取消(revoke)後は実行できない', async () => {
    const c = await approvedRequest();
    await run(() =>
      controller.decide(actor(c.approver), c.id, {
        decision: 'revoke',
        expectedVersion: 2,
        reason: '合成: 取消',
      }),
    );
    await rejected(c);
  }, 30_000);
});

describe('申請者=承認者(自己承認)', () => {
  it('申請者本人と承認者が同一の承認行(DBへ直接作成)は、承認者が有効でも拒否される', async () => {
    const c = await approvedRequest();
    // 申請者を有効な approver にもして、「承認者として有効」な状態を作る
    const r = (await q("SELECT id, scope FROM role WHERE code='approver'")).rows[0];
    const bindingId = uuidv7();
    await q(
      `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source,valid_from,valid_until)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,NULL)`,
      [bindingId, c.requester.id, r.id, r.scope, ORG, PAST],
    );
    made.bindings.push(bindingId);
    // 移行前(route NULL)の1行として、自己承認の静的検査を通す
    await q('UPDATE local_request_revision SET route=NULL,route_hash=NULL WHERE request_id=$1', [
      c.id,
    ]);
    await q('UPDATE local_request_approval SET approver_id=$2 WHERE request_id=$1', [
      c.id,
      c.requester.id,
    ]);
    await expect(tick(c)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(c)).rejects.toMatchObject({ status: 409 });
    expect(await check(c)).toEqual({ ok: false, reason: 'self_approval' });
  }, 30_000);
});

describe('RLS: 他組織の申請は検証できない', () => {
  it('別組織の文脈では申請が見つからず拒否される', async () => {
    const c = await approvedRequest();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org',$1,true)", [
        '00000000-0000-4000-9000-000000000002',
      ]);
      expect(
        await checkApprovalComplete(client, {
          organizationId: '00000000-0000-4000-9000-000000000002',
          requestId: c.id,
        }),
      ).toEqual({ ok: false, reason: 'request_not_found' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }, 30_000);
});
