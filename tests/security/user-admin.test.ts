/**
 * 在籍者の停止と復帰 (FR-IDM-007 / FR-IDM-008 / WP-P1-IDM-011 / TL-06)。
 *
 * `SessionService.deactivateUser` は WP-P1-IDM-009 で作られていたが
 * **呼ぶ経路が無かった。** 退職・停止でアクセスを止める手段が
 * 画面にもAPIにも存在せず、退職者のアカウントが有効なまま残っていた。
 *
 * 重点は3つ。
 *
 *   1. **止めたらログインできない**(受入基準)
 *   2. **履歴と担当は残る**(受入基準)
 *   3. **締め出しを作らない** — 自分自身・最後の管理者は止められない
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { CollaborationController } from '../../services/api/src/modules/ticket/collaboration.routes.js';
import { UserAdminController } from '../../services/api/src/modules/auth/user-admin.routes.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { S3CompatibleStorage } from '@solvi/shared';
import { SessionService } from '../../services/api/src/modules/auth/session.service.js';
import {
  LocalAuthService,
  LOCAL_ISSUER,
} from '../../services/api/src/modules/auth/local-auth.service.js';
import { beginAuthTransaction } from '../../services/api/src/modules/auth/auth-context.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';
import type { AuthenticatedRequest } from '../../services/api/src/modules/auth/auth.routes.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PASSWORD = 'a-perfectly-fine-password';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let tickets: TicketController;
let collab: CollaborationController;
let users: UserAdminController;

/**
 * 利用者を作る。
 *
 * `platform_admin` は組織に属さない(`role_binding_scope_org_consistency`)。
 * 組織のメンバーでもある状態を作るため、org側の役割も併せて付ける。
 */
async function createUser(
  email: string,
  orgId: string,
  roleCode: string,
  alsoPlatform?: string,
): Promise<string> {
  const userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [userId, email, email],
  );
  const { rows } = await admin.query('SELECT id, scope FROM role WHERE code = $1', [roleCode]);
  await admin.query(
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
    [
      uuidv7(),
      userId,
      rows[0].id,
      rows[0].scope,
      rows[0].scope === 'platform' ? null : orgId,
      PAST,
    ],
  );
  if (alsoPlatform) {
    const platform = await admin.query('SELECT id, scope FROM role WHERE code = $1', [
      alsoPlatform,
    ]);
    await admin.query(
      `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from)
       VALUES ($1, $2, $3, $4, NULL, 'manual', $5)`,
      [uuidv7(), userId, platform.rows[0].id, platform.rows[0].scope, PAST],
    );
  }
  await admin.query(
    `INSERT INTO identity (id, user_id, idp_type, issuer, subject) VALUES ($1, $2, 'local', $3, $4)`,
    [uuidv7(), userId, LOCAL_ISSUER, email],
  );
  await admin.query(
    `INSERT INTO local_credential (id, user_id, password_hash) VALUES ($1, $2, $3)`,
    [uuidv7(), userId, await hashPassword(PASSWORD)],
  );
  return userId;
}

async function tryLogin(email: string, orgId: string): Promise<{ ok: boolean; reason?: string }> {
  const client = await pool.connect();
  try {
    await beginAuthTransaction(client);
    const sessions = new SessionService(client);
    const auth = new LocalAuthService(client, sessions, {
      maxFailedAttempts: 5,
      lockoutSeconds: 900,
    });
    const result = await runWithContext(newContext(), () =>
      auth.authenticate({ email, password: PASSWORD, organizationId: orgId }),
    );
    await client.query('COMMIT');
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } finally {
    client.release();
  }
}

async function loginAs(email: string, orgId: string): Promise<AuthenticatedRequest> {
  const client = await pool.connect();
  try {
    await beginAuthTransaction(client);
    const sessions = new SessionService(client);
    const auth = new LocalAuthService(client, sessions, {
      maxFailedAttempts: 5,
      lockoutSeconds: 900,
    });
    const result = await runWithContext(newContext(), () =>
      auth.authenticate({ email, password: PASSWORD, organizationId: orgId }),
    );
    if (!result.ok) throw new Error(`ログイン失敗: ${result.reason}`);
    const validation = await sessions.validate(result.token);
    await client.query('COMMIT');
    if (!validation.valid) throw new Error('セッション検証に失敗');
    return {
      authz: { principal: validation.principal, organizationId: orgId },
      sessionId: validation.session.id,
      userId: validation.session.userId,
    };
  } finally {
    client.release();
  }
}

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const denialRecorder = new PoolDenialRecorder(pool);
  tickets = new TicketController({ pool, denialRecorder });
  users = new UserAdminController({ pool });
  collab = new CollaborationController({
    pool,
    denialRecorder,
    storage: new S3CompatibleStorage({
      endpoint: 'http://127.0.0.1:9100',
      bucket: 'solvi-attachments',
      accessKey: 'test',
      secretKey: 'test',
      region: 'ap-northeast-1',
    }),
  });
});

afterAll(async () => {
  await admin.query(
    `UPDATE app_user SET status = 'active', deactivated_at = NULL
      WHERE created_via = 'seed' AND status <> 'active'`,
  );
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  // **シードの利用者を必ず有効へ戻す。** この検査はシードの管理者を
  // 停止して「組織の管理者が1人だけ」の状況を作る。戻さないまま終わると、
  // 後続の検査や通し確認がログインできなくなる。
  // (以前にも `local_credential` の全削除で同じことを起こしている)
  await admin.query(
    `UPDATE app_user SET status = 'active', deactivated_at = NULL
      WHERE created_via = 'seed' AND status <> 'active'`,
  );
  await admin.query('DELETE FROM session');
  await admin.query(
    `DELETE FROM local_credential WHERE user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query(
    `DELETE FROM identity WHERE issuer = $1 AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
    [LOCAL_ISSUER],
  );
  await cleanBusinessData(admin);
  await admin.query(
    `DELETE FROM role_binding
      WHERE source = 'manual'
        AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query("DELETE FROM app_user WHERE created_via = 'admin'");
  await cleanAuditData(admin, "target_type IN ('ticket', 'session', 'app_user')");
});

describe('アクセスの停止 (FR-IDM-007)', () => {
  it('**止めたらログインできない**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const leaverId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['leaver@example.com'])
    ).rows[0].id;

    expect((await tryLogin('leaver@example.com', ORG_A)).ok).toBe(true);

    await run(() => users.deactivate(orgAdmin, leaverId, { reason: '2026-08-31 付で退職' }));

    const after = await tryLogin('leaver@example.com', ORG_A);
    expect(after.ok).toBe(false);
    expect(after.reason).toBe('user_inactive');
  });

  it('**既存のセッションもその場で切れる** (FR-IDM-008)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    const result = await run(() =>
      users.deactivate(orgAdmin, leaver.userId, { reason: '端末の紛失' }),
    );
    expect(result.body.revokedSessions).toBeGreaterThanOrEqual(1);

    const { rows } = await admin.query(
      'SELECT revoked_at, revoked_reason FROM session WHERE id = $1',
      [leaver.sessionId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].revoked_reason).toBe('user_deactivated');
  });

  it('**履歴と担当の記録は残る**(受入基準)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    const created = await run(() =>
      tickets.create(requester, {
        kind: 'incident',
        subject: '退職者が担当していた件',
        body: '本文です。',
        impact: 'medium',
        urgency: 'medium',
      }),
    );
    const ticketId = created.body.id as string;
    await run(() => collab.assign(leaver, ticketId, { assigneeId: leaver.userId }));
    await run(() =>
      collab.addComment(leaver, ticketId, { visibility: 'public', body: '確認しています。' }),
    );

    await run(() => users.deactivate(orgAdmin, leaver.userId, { reason: '退職' }));

    // 担当は外れない。誰が持っていたかが分からなくなる方が困る。
    const { rows } = await admin.query('SELECT assignee_id FROM ticket WHERE id = $1', [ticketId]);
    expect(rows[0].assignee_id).toBe(leaver.userId);

    // コメントも残る
    const comments = await run(() => collab.listComments(requester, ticketId));
    expect(comments.body.items).toHaveLength(1);
  });

  it('**対応中の件数を返す**(振り直しに気付けるように)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    const created = await run(() =>
      tickets.create(requester, {
        kind: 'incident',
        subject: '対応中',
        body: '本文です。',
        impact: 'medium',
        urgency: 'medium',
      }),
    );
    await run(() =>
      collab.assign(leaver, created.body.id as string, { assigneeId: leaver.userId }),
    );

    // **担当が残っていても止める。** 漏えいが疑われる状況で止められないと困る。
    const result = await run(() => users.deactivate(orgAdmin, leaver.userId, { reason: '退職' }));
    expect(result.body.openTicketCount).toBe(1);
  });

  it('**理由なしでは止められない**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    await expect(
      run(() => users.deactivate(orgAdmin, leaver.userId, { reason: '   ' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**自分自身は止められない**(締め出しを作らない)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('adm2@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() => users.deactivate(orgAdmin, orgAdmin.userId, { reason: '自分を止める' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**最後の管理者は止められない**(誰も権限を戻せなくなる)', async () => {
    // `platform_admin` の束縛は組織に属さない(`organization_id IS NULL`)ため、
    // **その組織の管理者としては数えない。** 組織の自治を保てるのは
    // 組織に束縛された管理者だけである。
    // つまり「組織の管理者が居なくなる」状況は、この経路で実際に作れる。
    await createUser('platform@example.com', ORG_A, 'agent', 'platform_admin');
    await createUser('last-adm@example.com', ORG_A, 'org_admin');
    const platform = await loginAs('platform@example.com', ORG_A);
    const lastAdminId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', [
        'last-adm@example.com',
      ])
    ).rows[0].id;

    // シードの org_admin を止めて、組織の管理者を last-adm 1人にする。
    // (`app_user_deactivated_consistency` があるため日時も一緒に入れる)
    await admin.query(
      `UPDATE app_user SET status = 'deactivated', deactivated_at = now()
        WHERE id IN (
          SELECT u.id FROM app_user u
          JOIN role_binding rb ON rb.user_id = u.id AND rb.organization_id = $1
          JOIN role r ON r.id = rb.role_id
          WHERE r.code IN ('org_admin', 'platform_admin') AND u.id <> $2
        )`,
      [ORG_A, lastAdminId],
    );

    await expect(
      run(() => users.deactivate(platform, lastAdminId, { reason: '退職' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('管理者が2人居れば片方は止められる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('adm2@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const other = await loginAs('adm2@example.com', ORG_A);

    await run(() => users.deactivate(orgAdmin, other.userId, { reason: '退職' }));
    expect((await tryLogin('adm2@example.com', ORG_A)).ok).toBe(false);
  });

  it('二度止めると 409', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    await run(() => users.deactivate(orgAdmin, leaver.userId, { reason: '退職' }));
    await expect(
      run(() => users.deactivate(orgAdmin, leaver.userId, { reason: '再度' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('**担当者は止められない**(体制を変えられるのは管理者)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    await expect(
      run(() => users.deactivate(agent, leaver.userId, { reason: '止めたい' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**他組織の利用者は止められない**', async () => {
    await createUser('adm-a@example.com', ORG_A, 'org_admin');
    await createUser('other@example.com', ORG_B, 'agent');
    const admA = await loginAs('adm-a@example.com', ORG_A);
    const foreignId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['other@example.com'])
    ).rows[0].id;

    // 存在を教えない。404 で返す。
    await expect(
      run(() => users.deactivate(admA, foreignId, { reason: '越境の試み' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('停止が理由つきで監査に残る', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('leaver@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const leaver = await loginAs('leaver@example.com', ORG_A);

    await run(() =>
      users.deactivate(orgAdmin, leaver.userId, { reason: '端末の紛失により一時停止' }),
    );

    const { rows } = await admin.query(
      `SELECT event_type, after_state FROM audit_event
        WHERE subject_user_id = $1 ORDER BY event_id`,
      [leaver.userId],
    );
    expect(rows.some((r) => r.event_type === 'user.deactivated')).toBe(true);
    // **「なぜ止めたか」が無いと、退職と事故対応を後から区別できない。**
    expect(rows.some((r) => r.after_state?.reason?.includes('紛失'))).toBe(true);
  });
});

describe('復帰 (FR-IDM-007)', () => {
  it('戻すとログインできる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('back@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const backId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['back@example.com'])
    ).rows[0].id;

    await run(() => users.deactivate(orgAdmin, backId, { reason: '休職' }));
    expect((await tryLogin('back@example.com', ORG_A)).ok).toBe(false);

    await run(() => users.reactivate(orgAdmin, backId, { reason: '休職から復帰' }));
    expect((await tryLogin('back@example.com', ORG_A)).ok).toBe(true);
  });

  it('**古いセッションは戻らない**(停止中に盗まれた可能性がある)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('back@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const back = await loginAs('back@example.com', ORG_A);

    await run(() => users.deactivate(orgAdmin, back.userId, { reason: '休職' }));
    await run(() => users.reactivate(orgAdmin, back.userId, { reason: '復帰' }));

    const { rows } = await admin.query('SELECT revoked_at FROM session WHERE id = $1', [
      back.sessionId,
    ]);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('止まっていない利用者は戻せない (409)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('active@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const activeId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['active@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.reactivate(orgAdmin, activeId, { reason: '戻す' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('理由なしでは戻せない', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('back@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const backId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['back@example.com'])
    ).rows[0].id;
    await run(() => users.deactivate(orgAdmin, backId, { reason: '休職' }));

    await expect(
      run(() => users.reactivate(orgAdmin, backId, { reason: '' })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('在籍者の一覧 (FR-IDM-007)', () => {
  it('管理者は在籍者と状態を見られる', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('member@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    const result = await run(() => users.list(orgAdmin));
    const member = result.body.items.find((m) => m.email === 'member@example.com');
    expect(member).toBeDefined();
    expect(member!.status).toBe('active');
    expect(member!.roleCodes).toContain('agent');
  });

  it('**担当者は在籍者の一覧を見られない**(名簿になる)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);

    await expect(run(() => users.list(agent))).rejects.toMatchObject({ status: 403 });
  });

  it('**他組織の在籍者は出ない**', async () => {
    await createUser('adm-a@example.com', ORG_A, 'org_admin');
    await createUser('only-b@example.com', ORG_B, 'agent');
    const admA = await loginAs('adm-a@example.com', ORG_A);

    const result = await run(() => users.list(admA));
    expect(result.body.items.some((m) => m.email === 'only-b@example.com')).toBe(false);
  });

  it('対応中の件数が出る(停止前の判断材料)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('busy@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const requester = await loginAs('req@example.com', ORG_A);
    const busy = await loginAs('busy@example.com', ORG_A);

    const created = await run(() =>
      tickets.create(requester, {
        kind: 'incident',
        subject: '担当あり',
        body: '本文です。',
        impact: 'medium',
        urgency: 'medium',
      }),
    );
    await run(() => collab.assign(busy, created.body.id as string, { assigneeId: busy.userId }));

    const result = await run(() => users.list(orgAdmin));
    const member = result.body.items.find((m) => m.email === 'busy@example.com');
    expect(member!.openTicketCount).toBe(1);
  });
});
