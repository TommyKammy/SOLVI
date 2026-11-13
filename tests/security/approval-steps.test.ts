/**
 * WP-P4-APR-014: 経路・ステップ・状態機械・監査イベントの実DB検証(TL-02 / TL-04 / TL-16)。
 *
 * - 製品コードが生成する経路は常に1段。2段はテストが版の route をDBへ直接用意する。
 * - 決定・実行はすべて製品コードを通す(DBの状態だけを見て合格にしない)。
 * - 合成データのみ。使い捨てDB(名前に `test` を含む)以外では即失敗する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newContext, runWithContext } from '@solvi/shared';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import {
  checkApprovalComplete,
  type ApprovalFailure,
} from '../../services/api/src/modules/catalog/approval-assertion.js';
import {
  type ApprovalRoute,
  routeHash,
} from '../../services/api/src/modules/catalog/approval-state.js';
import { CatalogController } from '../../services/api/src/modules/catalog/catalog.routes.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';

const ORG = '00000000-0000-4000-9000-000000000001'; // seed の acme
const PAST = new Date('2026-01-01T00:00:00Z');

type Role = 'requester' | 'approver' | 'agent' | 'org_admin';
type User = { id: string; roles: Role[]; bindings: string[] };
type Fixture = {
  requester: User;
  first: User;
  second: User;
  agent: User;
  id: string;
  ticketId: string;
};

let pool: pg.Pool;
let admin: pg.Client;
let controller: CatalogController;
const made = {
  users: [] as string[],
  bindings: [] as string[],
  items: [] as string[],
  requests: [] as string[],
};

const run = <T>(fn: () => Promise<T>) => runWithContext(newContext(), fn);
const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

async function makeUser(role: Role, extra: Role[] = []): Promise<User> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [id, `apr014-${id}@example.test`, `合成 ${role}`],
  );
  made.users.push(id);
  const roles: Role[] = [role, ...extra];
  const bindings: string[] = [];
  for (const code of roles) {
    const r = (await admin.query('SELECT id, scope FROM role WHERE code=$1', [code])).rows[0];
    const bindingId = uuidv7();
    await admin.query(
      `INSERT INTO role_binding (id,user_id,role_id,role_scope,organization_id,source,valid_from,valid_until)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,NULL)`,
      [bindingId, id, r.id, r.scope, ORG, PAST],
    );
    made.bindings.push(bindingId);
    bindings.push(bindingId);
  }
  return { id, roles, bindings };
}

const actor = (user: User): AuthenticatedRequest => ({
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

const definition = (fixed?: string, checks = true) => ({
  mode: 'local_simulation',
  action: 'simulate.access_grant',
  targetLabel: '合成対象',
  allowedDurations: [7],
  maxReasonLength: 2000,
  ...(fixed ? { approval: { mode: 'fixed', approverId: fixed } } : {}),
  ...(checks ? { checklist: [{ key: 'prepare', label: '準備確認', required: true }] } : {}),
});

async function makeItem(d: ReturnType<typeof definition>): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `INSERT INTO local_catalog_item(id,organization_id,code,version,title,description,definition)
     VALUES($1,$2,$3,1,'合成 承認ステップ','APR-014 合成データ',$4)`,
    [id, ORG, `apr014-${id}`, d],
  );
  made.items.push(id);
  return id;
}

async function createRequest(
  requester: User,
  approver: User,
  d = definition(approver.id),
): Promise<{ id: string; ticketId: string }> {
  const itemId = await makeItem(d);
  const created = await run(() =>
    controller.create(actor(requester), {
      itemId,
      itemVersion: 1,
      idempotencyKey: uuidv7(),
      approverId: approver.id,
      reason: '合成: 多段承認',
      durationDays: 7,
    }),
  );
  made.requests.push(created.id);
  return created;
}

/** 版1の route を2段(fixed)へ差し替える。製品コードは2段を生成しないため、テストが直接用意する。 */
async function setTwoStepRoute(
  requestId: string,
  first: User,
  second: User,
): Promise<ApprovalRoute> {
  const route: ApprovalRoute = {
    steps: [
      { stepNo: 1, approverId: first.id, authorityType: 'fixed', resolvedFrom: null },
      { stepNo: 2, approverId: second.id, authorityType: 'fixed', resolvedFrom: null },
    ],
    ruleRef: null,
  };
  await q(
    'UPDATE local_request_revision SET route=$2,route_hash=$3 WHERE request_id=$1 AND revision=1',
    [requestId, route, routeHash(route)],
  );
  await q(
    "UPDATE local_request_approval SET authority_type='fixed' WHERE request_id=$1 AND revision=1 AND step_no=1",
    [requestId],
  );
  return route;
}

async function twoStep(): Promise<Fixture> {
  const requester = await makeUser('requester');
  const first = await makeUser('approver');
  const second = await makeUser('approver');
  const agent = await makeUser('agent');
  const created = await createRequest(requester, first, definition(first.id));
  await setTwoStepRoute(created.id, first, second);
  return { requester, first, second, agent, ...created };
}

const decide = (
  user: User,
  id: string,
  expectedVersion: number,
  decision: 'approve' | 'reject' | 'revoke' = 'approve',
  reason = '',
) => run(() => controller.decide(actor(user), id, { decision, expectedVersion, reason }));

const requestRow = async (id: string) =>
  (await q('SELECT * FROM local_service_request WHERE id=$1', [id])).rows[0];
const revisionRow = async (id: string, revision: number) =>
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
  ).rows;
const check = async (id: string) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org',$1,true)", [ORG]);
    const result = await checkApprovalComplete(client, { organizationId: ORG, requestId: id });
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
};
const tick = async (f: Fixture, revision = 1, version = 1) =>
  run(() =>
    controller.updateChecklist(actor(f.agent), f.id, {
      requestRevision: revision,
      expectedVersion: version,
      key: 'prepare',
      completed: true,
    }),
  );
const simulate = async (f: Fixture) => {
  const row = await requestRow(f.id);
  return run(() => controller.simulate(actor(f.agent), f.id, { expectedVersion: row.version }));
};

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 6 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // **開発用DBへ書かない。** 使い捨てDB(名前に test を含む)でなければここで止める。
  for (const client of [pool, admin]) {
    const name = (await client.query('SELECT current_database() AS n')).rows[0].n as string;
    if (!name.includes('test')) {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      throw new Error(`接続先 ${name} は使い捨てDB(名前に test を含む)ではありません。中止します`);
    }
  }
  controller = new CatalogController(
    pool,
    {} as ConstructorParameters<typeof CatalogController>[1],
    true,
  );
}, 30_000);

afterAll(async () => {
  const attempt = async (sql: string, params: unknown[]) => {
    try {
      await admin.query(sql, params);
    } catch {
      /* 片付け失敗は検証結果に影響しない(監査は append-only のため残る) */
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
    const ids = [made.requests];
    await attempt('DELETE FROM local_simulation_receipt WHERE request_id=ANY($1::uuid[])', ids);
    await attempt(
      'DELETE FROM local_request_checklist_progress WHERE request_id=ANY($1::uuid[])',
      ids,
    );
    try {
      await admin.query('BEGIN');
      await admin.query('DELETE FROM local_request_approval WHERE request_id=ANY($1::uuid[])', ids);
      await admin.query('DELETE FROM local_request_revision WHERE request_id=ANY($1::uuid[])', ids);
      await admin.query('DELETE FROM local_service_request WHERE id=ANY($1::uuid[])', ids);
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

describe('2段の直列承認(TL-02)', () => {
  it('1段目だけでは実行できず、2段目まで承認すると実行できる', async () => {
    const f = await twoStep();
    const before = await requestRow(f.id);
    expect(before.state).toBe('pending');
    expect(before.version).toBe(1);

    // state は申請の状態(途中ステップの承認ではまだ pending)、ステップの状態は stepState
    await expect(decide(f.first, f.id, 1)).resolves.toEqual({
      id: f.id,
      state: 'pending',
      stepState: 'approved',
    });
    const afterFirst = await requestRow(f.id);
    expect(afterFirst.state).toBe('pending');
    expect(afterFirst.version).toBe(2);
    const stepsAfterFirst = await stepRows(f.id);
    expect(stepsAfterFirst).toHaveLength(2);
    expect(stepsAfterFirst.map((s) => [s.step_no, s.state, s.approver_id])).toEqual([
      [1, 'approved', f.first.id],
      [2, 'pending', f.second.id],
    ]);
    expect(stepsAfterFirst[0]!.decided_by).toBe(f.first.id);
    expect(afterFirst.current_approval_id).toBe(stepsAfterFirst[1]!.id);

    // 2段目の期限は1段目の承認時刻から72時間
    const seconds = (
      await q(
        `SELECT extract(epoch FROM (b.expires_at - a.decided_at))::int AS seconds
           FROM local_request_approval a JOIN local_request_approval b
             ON b.request_id=a.request_id AND b.step_no=a.step_no+1
          WHERE a.request_id=$1 AND a.step_no=1`,
        [f.id],
      )
    ).rows[0].seconds as number;
    expect(Math.abs(seconds - 72 * 3600)).toBeLessThanOrEqual(5);

    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await q('SELECT count(*)::int AS n FROM local_simulation_receipt WHERE request_id=$1', [
          f.id,
        ])
      ).rows[0].n,
    ).toBe(0);

    await expect(decide(f.second, f.id, 2)).resolves.toEqual({
      id: f.id,
      state: 'approved',
      stepState: 'approved',
    });
    const approved = await requestRow(f.id);
    expect(approved.state).toBe('approved');
    expect(approved.version).toBe(3);
    const finalSteps = await stepRows(f.id);
    expect(finalSteps.map((s) => [s.step_no, s.state, s.decided_by])).toEqual([
      [1, 'approved', f.first.id],
      [2, 'approved', f.second.id],
    ]);
    expect(await check(f.id)).toEqual({
      ok: true,
      steps: finalSteps.map((s) => ({ approvalId: s.id, approverId: s.approver_id })),
    });

    await expect(tick(f)).resolves.toMatchObject({ checklistVersion: 2 });
    const simulated = await simulate(f);
    expect(simulated.replayed).toBe(false);
    expect((await requestRow(f.id)).state).toBe('completed');
    const receipt = (
      await q('SELECT approval_id FROM local_simulation_receipt WHERE request_id=$1', [f.id])
    ).rows[0];
    expect(receipt.approval_id).toBe(finalSteps[1]!.id);
  }, 30_000);

  it('監査は approval.* で記録され、after に版・世代・ステップ・段数・権限種別を持つ', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await decide(f.second, f.id, 2);
    const rows = (
      await q(
        `SELECT event_type,after_state,approval_ref FROM audit_event
          WHERE target_id=$1 AND event_type LIKE 'approval.%' ORDER BY occurred_at,event_id`,
        [f.id],
      )
    ).rows;
    expect(rows.map((r) => r.event_type)).toEqual([
      'approval.requested', // 作成時の1段目
      'approval.approved', // 1段目
      'approval.requested', // 2段目の作成
      'approval.approved', // 2段目
    ]);
    const stepCounts = [1, 2, 2, 2];
    for (const [index, row] of rows.entries()) {
      expect(row.approval_ref).toBeTruthy();
      expect(row.after_state).toMatchObject({
        revision: 1,
        routeGeneration: 1,
        stepCount: stepCounts[index]!,
        authorityType: 'fixed',
      });
      expect(row.after_state.stepNo).toBeGreaterThanOrEqual(1);
      expect(Object.keys(row.after_state).sort()).toEqual(
        [
          'authorityType',
          'finalStep',
          'requestState',
          'revision',
          'routeGeneration',
          'stepCount',
          'stepNo',
        ]
          .filter((key) => key in row.after_state)
          .sort(),
      );
      // 入力値・スナップショット本文を載せない
      expect(JSON.stringify(row.after_state)).not.toContain('合成: 多段承認');
    }
    // 旧 request.approved は書かない
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1 AND event_type IN ('request.approved','request.rejected','request.revoked')",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(0);
  }, 30_000);

  it('同時の決定でも2段目は二重に作られず、500にしない', async () => {
    const f = await twoStep();
    const results = await Promise.allSettled([decide(f.first, f.id, 1), decide(f.first, f.id, 1)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0] as PromiseRejectedResult;
    expect([403, 409]).toContain((reason.reason as { status?: number }).status);
    const second = await q(
      'SELECT count(*)::int AS n FROM local_request_approval WHERE request_id=$1 AND step_no=2',
      [f.id],
    );
    expect(second.rows[0].n).toBe(1);
    expect((await requestRow(f.id)).state).toBe('pending');
    expect((await stepRows(f.id)).map((s) => s.state)).toEqual(['approved', 'pending']);
  }, 30_000);
});

describe('申請内容の変更と承認取消(FR-CAT-008 / FR-CAT-009)', () => {
  it('変更でその版の全ステップが invalidated になり、新しい版で pending になる', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await run(() =>
      controller.edit(actor(f.requester), f.id, {
        expectedVersion: 2,
        approverId: f.first.id,
        reason: '合成: 変更後の再承認',
        durationDays: 7,
      }),
    );
    const request = await requestRow(f.id);
    expect(request.state).toBe('pending');
    expect(request.revision).toBe(2);
    expect(request.version).toBe(3);
    const oldSteps = await stepRows(f.id, 1);
    expect(oldSteps.map((s) => [s.step_no, s.state])).toEqual([
      [1, 'invalidated'],
      [2, 'invalidated'],
    ]);
    const newSteps = await stepRows(f.id, 2);
    expect(newSteps.map((s) => [s.step_no, s.state, s.approver_id])).toEqual([
      [1, 'pending', f.first.id],
    ]);
    const newRevision = await revisionRow(f.id, 2);
    expect(newRevision.route).not.toBeNull();
    expect(newRevision.route_hash).toBe(routeHash(newRevision.route as ApprovalRoute));
    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f, 2)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });

    // 旧世代のステップでは決定できない(現在の版の承認者ではないため404で秘匿する)
    await expect(decide(f.second, f.id, 3)).rejects.toMatchObject({ status: 404 });
    // 新しい版を承認すれば再び実行できる
    await decide(f.first, f.id, 3);
    expect((await requestRow(f.id)).state).toBe('approved');
    await expect(tick(f, 2)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(f)).resolves.toMatchObject({ replayed: false });

    const events = (
      await q(
        `SELECT event_type,after_state FROM audit_event WHERE target_id=$1 AND event_type LIKE 'approval.%' ORDER BY occurred_at,event_id`,
        [f.id],
      )
    ).rows;
    expect(events.filter((e) => e.event_type === 'approval.invalidated')).toHaveLength(2);
    for (const event of events.filter((e) => e.event_type === 'approval.invalidated'))
      expect(event.after_state).toMatchObject({ cause: 'request_changed' });
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1 AND event_type='request.changed'",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(1);
  }, 30_000);

  it('承認取消で全ステップが invalidated、申請が invalidated になり実行できない', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await decide(f.second, f.id, 2);
    await run(() =>
      controller.decide(actor(f.second), f.id, {
        decision: 'revoke',
        expectedVersion: 3,
        reason: '合成: 誤承認の取消',
      }),
    );
    const request = await requestRow(f.id);
    expect(request.state).toBe('invalidated');
    expect(request.version).toBe(4);
    expect((await stepRows(f.id)).map((s) => [s.step_no, s.state])).toEqual([
      [1, 'invalidated'],
      [2, 'invalidated'],
    ]);
    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
    const events = (
      await q(
        `SELECT event_type,after_state FROM audit_event WHERE target_id=$1 AND event_type LIKE 'approval.%'`,
        [f.id],
      )
    ).rows;
    expect(events.filter((e) => e.event_type === 'approval.invalidated')).toHaveLength(2);
    for (const event of events.filter((e) => e.event_type === 'approval.invalidated'))
      expect(event.after_state).toMatchObject({ cause: 'revoked' });
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1 AND event_type='request.revoked'",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // 承認取消済みの申請は、申請者が内容を修正して再申請できる(WP §6.1 / 03.5)。
    // 旧版のステップは既に invalidated。状態も監査も重ねて書かない。
    await run(() =>
      controller.edit(actor(f.requester), f.id, {
        expectedVersion: 4,
        approverId: f.first.id,
        reason: '合成: 取消後の再申請',
        durationDays: 7,
      }),
    );
    const reapplied = await requestRow(f.id);
    expect(reapplied.state).toBe('pending');
    expect(reapplied.revision).toBe(2);
    expect(reapplied.version).toBe(5);
    // 旧版のステップは invalidated のままで、approval.invalidated を重ねて書かない
    expect((await stepRows(f.id, 1)).map((s) => [s.step_no, s.state])).toEqual([
      [1, 'invalidated'],
      [2, 'invalidated'],
    ]);
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1 AND event_type='approval.invalidated'",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_event WHERE target_id=$1 AND event_type='request.changed'",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // 新しい版の最初のステップが pending で作られる
    expect((await stepRows(f.id, 2)).map((s) => [s.step_no, s.state, s.approver_id])).toEqual([
      [1, 'pending', f.first.id],
    ]);
    // 旧版のステップでは決定も実行もできない
    await expect(decide(f.second, f.id, 5)).rejects.toMatchObject({ status: 404 });
    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f, 2)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
    // 新しい版を承認すれば再び実行できる
    await decide(f.first, f.id, 5);
    expect((await requestRow(f.id)).state).toBe('approved');
    await expect(tick(f, 2)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(f)).resolves.toMatchObject({ replayed: false });
  }, 30_000);

  it('却下された申請は、申請者が内容を修正して再承認を依頼できる', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await decide(f.second, f.id, 2, 'reject', '合成: 却下');
    const rejected = await requestRow(f.id);
    expect(rejected.state).toBe('rejected');
    expect(rejected.version).toBe(3);
    expect((await stepRows(f.id)).map((s) => [s.step_no, s.state])).toEqual([
      [1, 'approved'],
      [2, 'rejected'],
    ]);

    await run(() =>
      controller.edit(actor(f.requester), f.id, {
        expectedVersion: 3,
        approverId: f.first.id,
        reason: '合成: 却下後の再申請',
        durationDays: 7,
      }),
    );
    const reapplied = await requestRow(f.id);
    expect(reapplied.state).toBe('pending');
    expect(reapplied.revision).toBe(2);
    expect(reapplied.version).toBe(4);
    // 旧版は承認済み・却下の両方が invalidated になる
    expect((await stepRows(f.id, 1)).map((s) => [s.step_no, s.state])).toEqual([
      [1, 'invalidated'],
      [2, 'invalidated'],
    ]);
    expect((await stepRows(f.id, 2)).map((s) => [s.step_no, s.state, s.approver_id])).toEqual([
      [1, 'pending', f.first.id],
    ]);
    // 旧版のステップでは決定も実行もできない
    await expect(decide(f.second, f.id, 4)).rejects.toMatchObject({ status: 404 });
    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f, 2)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
    // 新しい版を承認すれば実行できる
    await decide(f.first, f.id, 4);
    expect((await requestRow(f.id)).state).toBe('approved');
    await expect(tick(f, 2)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(f)).resolves.toMatchObject({ replayed: false });
  }, 30_000);

  it('完了・取下げ済みの申請は変更できない', async () => {
    const completed = await twoStep();
    await decide(completed.first, completed.id, 1);
    await decide(completed.second, completed.id, 2);
    await tick(completed);
    await simulate(completed);
    const completedRow = await requestRow(completed.id);
    expect(completedRow.state).toBe('completed');
    await expect(
      run(() =>
        controller.edit(actor(completed.requester), completed.id, {
          expectedVersion: completedRow.version,
          approverId: completed.first.id,
          reason: '合成: 完了後の変更',
          durationDays: 7,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const cancelled = await twoStep();
    const cancelledRow = await requestRow(cancelled.id);
    // 現在の製品コードに取下げ操作は無い(approval.cancelled は予約)。状態だけを直接用意する。
    await q("UPDATE local_service_request SET state='cancelled' WHERE id=$1", [cancelled.id]);
    await expect(
      run(() =>
        controller.edit(actor(cancelled.requester), cancelled.id, {
          expectedVersion: cancelledRow.version,
          approverId: cancelled.first.id,
          reason: '合成: 取下げ後の変更',
          durationDays: 7,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  }, 30_000);
});

describe('期限(FR-CAT-011)と未定義遷移', () => {
  it('期限切れのステップは決定も実行も拒否される', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await q(
      "UPDATE local_request_approval SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1 AND step_no=2",
      [f.id],
    );
    await expect(decide(f.second, f.id, 2)).rejects.toMatchObject({ status: 409 });
    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
    // 期限内に戻せば決定できる(期限切れは導出で、状態を勝手に書き換えない)
    await q(
      "UPDATE local_request_approval SET expires_at=clock_timestamp()+interval '1 hour' WHERE request_id=$1 AND step_no=2",
      [f.id],
    );
    await expect(decide(f.second, f.id, 2)).resolves.toMatchObject({ state: 'approved' });
    expect(await check(f.id)).toMatchObject({ ok: true });
  }, 30_000);

  it('期限切れの申請は、申請者が内容を修正して再承認を依頼できる', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await q(
      "UPDATE local_request_approval SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=$1 AND step_no=2",
      [f.id],
    );
    const expired = await requestRow(f.id);
    expect(expired.state).toBe('pending');
    expect(expired.version).toBe(2);
    // ステップは pending のまま(期限切れは導出)。変更で pending → invalidated の遷移を使う。
    await run(() =>
      controller.edit(actor(f.requester), f.id, {
        expectedVersion: 2,
        approverId: f.first.id,
        reason: '合成: 期限切れ後の修正',
        durationDays: 7,
      }),
    );
    const reapplied = await requestRow(f.id);
    expect(reapplied.state).toBe('pending');
    expect(reapplied.revision).toBe(2);
    expect(reapplied.version).toBe(3);
    expect((await stepRows(f.id, 1)).map((s) => [s.step_no, s.state])).toEqual([
      [1, 'invalidated'],
      [2, 'invalidated'],
    ]);
    const newStep = (await stepRows(f.id, 2))[0]!;
    expect([newStep.step_no, newStep.state, newStep.approver_id]).toEqual([
      1,
      'pending',
      f.first.id,
    ]);
    // 新しいステップの期限は変更時刻から72時間
    const seconds = (
      await q(
        `SELECT extract(epoch FROM (expires_at - clock_timestamp()))::int AS seconds
           FROM local_request_approval WHERE id=$1`,
        [newStep.id],
      )
    ).rows[0].seconds as number;
    expect(Math.abs(seconds - 72 * 3600)).toBeLessThanOrEqual(5);
    // 旧版のステップでは決定も実行もできない
    await expect(decide(f.second, f.id, 3)).rejects.toMatchObject({ status: 404 });
    expect(await check(f.id)).toEqual({ ok: false, reason: 'request_not_approved' });
    await expect(tick(f, 2)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
    // 新しい版を承認すれば実行できる
    await decide(f.first, f.id, 3);
    expect((await requestRow(f.id)).state).toBe('approved');
    await expect(tick(f, 2)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(f)).resolves.toMatchObject({ replayed: false });
  }, 30_000);

  it.each([
    [
      '承認済みの再承認',
      async (f: Fixture) => {
        await decide(f.first, f.id, 1);
        await decide(f.second, f.id, 2);
        await expect(decide(f.second, f.id, 3)).rejects.toMatchObject({ status: 409 });
      },
    ],
    [
      '却下後の承認',
      async (f: Fixture) => {
        await decide(f.first, f.id, 1, 'reject', '合成: 却下');
        expect((await requestRow(f.id)).state).toBe('rejected');
        await expect(decide(f.first, f.id, 2)).rejects.toMatchObject({ status: 409 });
        await expect(tick(f)).rejects.toMatchObject({ status: 409 });
        await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
      },
    ],
    [
      '承認待ちでないステップの取消',
      async (f: Fixture) => {
        await expect(
          run(() =>
            controller.decide(actor(f.first), f.id, {
              decision: 'revoke',
              expectedVersion: 1,
              reason: '合成: 未承認の取消',
            }),
          ),
        ).rejects.toMatchObject({ status: 409 });
      },
    ],
  ] as const)(
    '未定義の遷移は409: %s',
    async (_name, act) => {
      await act(await twoStep());
    },
    30_000,
  );
});

describe('経路の改ざん・世代・行数の拒否(TL-16)', () => {
  it('route_hash を改ざんした版では決定も実行も拒否される', async () => {
    const f = await twoStep();
    await q(
      "UPDATE local_request_revision SET route_hash=repeat('0',64) WHERE request_id=$1 AND revision=1",
      [f.id],
    );
    await expect(decide(f.first, f.id, 1)).rejects.toMatchObject({ status: 409 });
    // 承認後に改ざんしても実行前検証が止める
    await q('UPDATE local_request_revision SET route_hash=$2 WHERE request_id=$1 AND revision=1', [
      f.id,
      routeHash((await revisionRow(f.id, 1)).route as ApprovalRoute),
    ]);
    await decide(f.first, f.id, 1);
    await decide(f.second, f.id, 2);
    await q(
      "UPDATE local_request_revision SET route_hash=repeat('0',64) WHERE request_id=$1 AND revision=1",
      [f.id],
    );
    expect(await check(f.id)).toEqual({ ok: false, reason: 'route_hash_mismatch' });
    await expect(tick(f)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
  }, 30_000);

  it('ステップ数と行数が一致しない版は実行できない(余分な行)', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await decide(f.second, f.id, 2);
    const third = await makeUser('approver');
    await q(
      `INSERT INTO local_request_approval(id,organization_id,request_id,revision,route_generation,step_no,snapshot_hash,approver_id,authority_type,state,expires_at)
       SELECT $2,organization_id,request_id,revision,route_generation,3,snapshot_hash,$3,'fixed','approved',expires_at
         FROM local_request_approval WHERE request_id=$1 AND step_no=2`,
      [f.id, uuidv7(), third.id],
    );
    expect(await check(f.id)).toEqual({ ok: false, reason: 'route_step_count' });
    await expect(tick(f)).rejects.toMatchObject({ status: 409 });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
  }, 30_000);

  it('旧 route_generation のステップでは決定できない', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await q(
      'UPDATE local_request_revision SET route_generation=2 WHERE request_id=$1 AND revision=1',
      [f.id],
    );
    // 旧世代のステップは現在の版の承認者として可視でない(404)
    await expect(decide(f.second, f.id, 2)).rejects.toMatchObject({ status: 404 });
    expect(await check(f.id)).toMatchObject({ ok: false });
  }, 30_000);

  it('承認者を差し替えた行・最終ステップを指さない current_approval_id を拒否する', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    await decide(f.second, f.id, 2);
    const other = await makeUser('approver');
    await q('UPDATE local_request_approval SET approver_id=$2 WHERE request_id=$1 AND step_no=2', [
      f.id,
      other.id,
    ]);
    expect(await check(f.id)).toEqual({ ok: false, reason: 'route_step_mismatch' });
    await q('UPDATE local_request_approval SET approver_id=$2 WHERE request_id=$1 AND step_no=2', [
      f.id,
      f.second.id,
    ]);
    const firstStep = (await stepRows(f.id))[0]!;
    await q('UPDATE local_service_request SET current_approval_id=$2 WHERE id=$1', [
      f.id,
      firstStep.id,
    ]);
    expect(await check(f.id)).toEqual({ ok: false, reason: 'approval_not_current' });
    await expect(simulate(f)).rejects.toMatchObject({ status: 409 });
  }, 30_000);
});

describe('認可を緩めない', () => {
  it('approver ロールの無い利用者・割当外の承認者・申請者は決定できない', async () => {
    const f = await twoStep();
    // 割当外(approver ロールはある)。他人の申請は404で秘匿する(T-02)
    await expect(decide(await makeUser('approver'), f.id, 1)).rejects.toMatchObject({
      status: 404,
    });
    // 割当された承認者だが、リクエスト文脈に approver ロールが無い
    const noRole: User = { ...f.first, roles: ['requester'] };
    await expect(decide(noRole, f.id, 1)).rejects.toMatchObject({ status: 403 });
    // 申請者
    await expect(decide(f.requester, f.id, 1)).rejects.toMatchObject({ status: 403 });
    expect((await stepRows(f.id))[0]!.state).toBe('pending');
  }, 30_000);
});

describe('移行前(route NULL)の互換', () => {
  it('route が NULL の1段申請は従来どおり決定・実行できる', async () => {
    const requester = await makeUser('requester');
    const approver = await makeUser('approver');
    const agent = await makeUser('agent');
    const created = await createRequest(requester, approver, definition());
    await q('UPDATE local_request_revision SET route=NULL,route_hash=NULL WHERE request_id=$1', [
      created.id,
    ]);
    const f: Fixture = { requester, first: approver, second: approver, agent, ...created };
    const revision = await revisionRow(created.id, 1);
    expect(revision.route).toBeNull();
    const details = await run(() => controller.detail(actor(requester), created.id));
    expect(details.steps).toHaveLength(1);
    expect(details.steps[0]).toMatchObject({ stepNo: 1, authorityType: 'legacy' });
    await decide(approver, created.id, 1);
    expect(await check(created.id)).toMatchObject({ ok: true });
    await expect(tick(f)).resolves.toMatchObject({ checklistVersion: 2 });
    await expect(simulate(f)).resolves.toMatchObject({ replayed: false });
    expect((await requestRow(created.id)).state).toBe('completed');
  }, 30_000);
});

describe('冪等リプレイ(FR-CAT-003 / §7)', () => {
  it('同じキー・同じ内容は再生し、内容・承認者・経路が違えば409', async () => {
    const requester = await makeUser('requester');
    const first = await makeUser('approver');
    const second = await makeUser('approver');
    const itemId = await makeItem(definition(first.id));
    const key = uuidv7();
    const body = {
      itemId,
      itemVersion: 1,
      idempotencyKey: key,
      approverId: first.id,
      reason: '合成: リプレイ',
      durationDays: 7,
    };
    const created = await run(() => controller.create(actor(requester), body));
    made.requests.push(created.id);
    await expect(run(() => controller.create(actor(requester), body))).resolves.toEqual({
      id: created.id,
      ticketId: created.ticketId,
      replayed: true,
    });
    await expect(
      run(() => controller.create(actor(requester), { ...body, reason: '合成: 変更' })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      run(() => controller.create(actor(requester), { ...body, approverId: second.id })),
    ).rejects.toMatchObject({ status: 409 });
    // 経路がある版は route_hash で同一性を判定する
    const route: ApprovalRoute = {
      steps: [{ stepNo: 1, approverId: second.id, authorityType: 'fixed', resolvedFrom: null }],
      ruleRef: null,
    };
    await q('UPDATE local_request_revision SET route_hash=$2 WHERE request_id=$1', [
      created.id,
      routeHash(route),
    ]);
    await expect(run(() => controller.create(actor(requester), body))).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (
        await q('SELECT count(*)::int AS n FROM local_service_request WHERE idempotency_key=$1', [
          key,
        ])
      ).rows[0].n,
    ).toBe(1);
  }, 30_000);
});

describe('詳細・一覧は現在のステップを指し、全ステップを返す', () => {
  it('detail は steps を加算し、history は全ステップを返す', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    const details = await run(() => controller.detail(actor(f.requester), f.id));
    expect(details.approval.step_no).toBe(2);
    expect(details.steps).toHaveLength(2);
    expect(
      details.steps.map((s: { stepNo: number; state: string }) => [s.stepNo, s.state]),
    ).toEqual([
      [1, 'approved'],
      [2, 'pending'],
    ]);
    expect(details.history).toHaveLength(2);
    expect(details.request.state).toBe('pending');
    expect(details.request.revision).toBe(1);
  }, 30_000);

  it('承認待ち一覧は現在のステップの承認者だけに出す', async () => {
    const f = await twoStep();
    await decide(f.first, f.id, 1);
    const asSecond = await run(() =>
      controller.list(actor(f.second), new URLSearchParams({ view: 'approvals' })),
    );
    expect(asSecond.items.map((i: { id: string }) => i.id)).toContain(f.id);
    const asFirst = await run(() =>
      controller.list(actor(f.first), new URLSearchParams({ view: 'approvals' })),
    );
    expect(asFirst.items.map((i: { id: string }) => i.id)).not.toContain(f.id);
  }, 30_000);
});

describe('承認完了検証の失敗理由(補助)', () => {
  it('移行前の1行が invalidated の場合は no_current_approval', async () => {
    const requester = await makeUser('requester');
    const approver = await makeUser('approver');
    const created = await createRequest(requester, approver, definition());
    await q('UPDATE local_request_revision SET route=NULL,route_hash=NULL WHERE request_id=$1', [
      created.id,
    ]);
    await q("UPDATE local_request_approval SET state='invalidated' WHERE request_id=$1", [
      created.id,
    ]);
    const result = (await check(created.id)) as { ok: false; reason: ApprovalFailure };
    expect(result.ok).toBe(false);
    expect(['request_not_approved', 'no_current_approval']).toContain(result.reason);
  }, 30_000);
});
