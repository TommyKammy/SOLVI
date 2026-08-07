/**
 * 役割の期限到来 (FR-IDM-006 / WP-P1-IDM-014)。
 *
 * 受入基準は「期限到来で**自動失権+監査イベント**」。
 *
 * 自動失権は動いていた(`resolveBindings()` が `valid_until` を見ている)。
 * **監査イベントだけが無かった。** `role.binding.deleted` は型として
 * 定義されているのに、発行する者がどこにも居なかった。
 *
 * 実害は静かである。兼務・出向の期限が切れると、ある日その組織が見えなくなる。
 * 本人には理由が分からず、管理者にも「いつ切れたか」を示す記録が無い。
 * **「権限を失った」ことは、失った瞬間に記録しないと後から作れない。**
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext, type Logger } from '@solvi/shared';
import { RoleBindingExpirySweeper } from '../../services/api/src/common/identity/binding-expiry.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import { cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sweep = (): Promise<{ recorded: number; skippedPlatform: number }> =>
  runWithContext(newContext(), () => new RoleBindingExpirySweeper(pool, silent).sweepOnce());

/** 期限つきの束縛を作る。`validUntil` が過去なら既に切れている。 */
async function makeBinding(params: {
  orgId: string | null;
  roleCode: string;
  validUntil: Date | null;
}): Promise<{ bindingId: string; userId: string }> {
  const userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [userId, `expiry-${userId}@example.com`, 'expiry test'],
  );
  const { rows } = await admin.query('SELECT id, scope FROM role WHERE code = $1', [
    params.roleCode,
  ]);
  const bindingId = uuidv7();
  await admin.query(
    `INSERT INTO role_binding
       (id, user_id, role_id, role_scope, organization_id, source, valid_from, valid_until)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)`,
    [
      bindingId,
      userId,
      rows[0].id,
      rows[0].scope,
      rows[0].scope === 'platform' ? null : params.orgId,
      PAST,
      params.validUntil,
    ],
  );
  return { bindingId, userId };
}

const auditFor = async (bindingId: string) => {
  const { rows } = await admin.query(
    `SELECT event_type, organization_id, actor_type, actor_display, action,
            before_state, after_state, subject_user_id
       FROM audit_event WHERE target_id = $1 AND target_type = 'role_binding'`,
    [bindingId],
  );
  return rows;
};

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await cleanAuditData(admin, "target_type = 'role_binding'");
  // **この検査が作ったものだけを消す。** `created_via = 'admin'` で
  // 一括削除すると、他の検査が作った利用者まで巻き込む
  // (実際に一度やって、チケットの外部キーで落ちた)。
  await admin.query(
    `DELETE FROM role_binding
      WHERE user_id IN (SELECT id FROM app_user WHERE primary_email LIKE 'expiry-%@example.com')`,
  );
  await admin.query("DELETE FROM app_user WHERE primary_email LIKE 'expiry-%@example.com'");
  // シードの束縛(兼務の例)は 90 日先なので、この検査では拾われない。
  // 拾われる状態になっていたら、その前提そのものが崩れている。
  await admin.query(`UPDATE role_binding SET expiry_recorded_at = NULL WHERE source = 'seed'`);
});

describe('期限が来たら監査に残る', () => {
  it('**切れた束縛が `role.binding.deleted` として記録される**', async () => {
    const { bindingId, userId } = await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });

    const result = await sweep();
    expect(result.recorded).toBe(1);

    const events = await auditFor(bindingId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('role.binding.deleted');
    expect(events[0].action).toBe('expire');
    // 人が行った操作ではない。**期限が来ただけである。**
    expect(events[0].actor_type).toBe('system');
    expect(events[0].subject_user_id).toBe(userId);
    // どの組織で失われたかが分からなければ、調査の役に立たない。
    expect(events[0].organization_id).toBe(ORG_A);
    // 何を失ったのかを残す。行は消えないが、役割名は後から読めなくなりうる。
    expect(events[0].before_state.roleCode).toBe('requester');
  });

  it('**まだ切れていないものは記録しない**', async () => {
    await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() + 86_400_000),
    });
    expect((await sweep()).recorded).toBe(0);
  });

  it('期限の無い束縛は対象外', async () => {
    await makeBinding({ orgId: ORG_A, roleCode: 'agent', validUntil: null });
    expect((await sweep()).recorded).toBe(0);
  });

  it('**何度回しても1件しか書かない**(期限切れは状態であって出来事ではない)', async () => {
    const { bindingId } = await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });

    expect((await sweep()).recorded).toBe(1);
    expect((await sweep()).recorded).toBe(0);
    expect((await sweep()).recorded).toBe(0);
    expect(await auditFor(bindingId)).toHaveLength(1);
  });

  it('複数の組織にまたがって拾う(横断の読み取り)', async () => {
    await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });
    await makeBinding({
      orgId: ORG_B,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });

    expect((await sweep()).recorded).toBe(2);
  });

  it('**記録はその組織に残る**(書き込みは越境させない)', async () => {
    const a = await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });
    const b = await makeBinding({
      orgId: ORG_B,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });
    await sweep();

    expect((await auditFor(a.bindingId))[0].organization_id).toBe(ORG_A);
    expect((await auditFor(b.bindingId))[0].organization_id).toBe(ORG_B);
  });

  it('**platform スコープは黙って飛ばさず件数で返す**', async () => {
    await makeBinding({
      orgId: null,
      roleCode: 'platform_admin',
      validUntil: new Date(Date.now() - 86_400_000),
    });

    const result = await sweep();
    expect(result.recorded).toBe(0);
    // 組織の文脈が無いため記録できない。**見えるようにする。**
    expect(result.skippedPlatform).toBe(1);
  });
});

describe('束縛そのものは消さない', () => {
  it('**行は残る。** 記録するだけで、履歴を消さない', async () => {
    const { bindingId } = await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });
    await sweep();

    const { rows } = await admin.query(
      'SELECT valid_until, expiry_recorded_at FROM role_binding WHERE id = $1',
      [bindingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].valid_until).not.toBeNull();
    expect(rows[0].expiry_recorded_at).not.toBeNull();
  });

  it('印は失権の判定に使わない(記録前でも権限は失われている)', async () => {
    // 記録の有無に関わらず、`valid_until` を過ぎた束縛は権限にならない。
    // これは `authz` 側の検査(tests/unit/authz.test.ts)が担保している。
    // ここでは印が権限の判定へ漏れ出していないことだけを見る。
    const { bindingId } = await makeBinding({
      orgId: ORG_A,
      roleCode: 'requester',
      validUntil: new Date(Date.now() - 86_400_000),
    });
    const before = await admin.query('SELECT expiry_recorded_at FROM role_binding WHERE id = $1', [
      bindingId,
    ]);
    expect(before.rows[0].expiry_recorded_at).toBeNull();
    // 印が無くても失権している(authz の検査で固定済み)。ここは印の初期値のみ確認。
  });
});
