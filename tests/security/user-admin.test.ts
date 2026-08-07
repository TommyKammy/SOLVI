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

async function loginAs(
  email: string,
  orgId: string,
): Promise<AuthenticatedRequest & { token: string }> {
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
      token: result.token,
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

describe('利用者の作成 (WP-P1-IDM-016)', () => {
  it('**管理者が利用者を作れる**(これまで人を作る経路が無かった)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    const created = await run(() =>
      users.createUser(orgAdmin, {
        email: 'newcomer@example.com',
        displayName: '新入 太郎',
        roleCode: 'requester',
        reason: '入社のため',
      }),
    );
    expect(created.status).toBe(201);

    const list = await run(() => users.list(orgAdmin));
    const member = list.body.items.find((m) => m.email === 'newcomer@example.com');
    expect(member).toBeDefined();
    expect(member!.roleCodes).toContain('requester');
    expect(member!.status).toBe('active');
  });

  it('**作っただけではログインできない**(資格情報は別の手順)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await run(() =>
      users.createUser(orgAdmin, {
        email: 'nopass@example.com',
        displayName: 'パスワード未設定',
        roleCode: 'agent',
        reason: '入社のため',
      }),
    );

    // identity も local_credential も作らない。**作ることと入れるようにすることを分ける。**
    const { rows } = await admin.query(
      `SELECT
         (SELECT count(*)::int FROM identity i JOIN app_user u ON u.id = i.user_id
           WHERE u.primary_email = 'nopass@example.com') AS identities,
         (SELECT count(*)::int FROM local_credential c JOIN app_user u ON u.id = c.user_id
           WHERE u.primary_email = 'nopass@example.com') AS credentials`,
    );
    expect(rows[0].identities).toBe(0);
    expect(rows[0].credentials).toBe(0);
  });

  it('**同じ組織に同じ連絡先の人は作れない** (409)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('dup@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() =>
        users.createUser(orgAdmin, {
          email: 'dup@example.com',
          displayName: '重複',
          roleCode: 'requester',
          reason: '二重作成',
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('**他組織の重複は検出しない**(検出できないことを隠さない)', async () => {
    // 検出するには組織をまたいでメールを引く必要があり、それは
    // **在籍者の総当たりができる経路**になる。作れてしまうのは承知のうえで、
    // 「検出したふり」をしない。この検査はその判断を固定する。
    await createUser('adm-a@example.com', ORG_A, 'org_admin');
    await createUser('only-b@example.com', ORG_B, 'agent');
    const admA = await loginAs('adm-a@example.com', ORG_A);

    const created = await run(() =>
      users.createUser(admA, {
        email: 'only-b@example.com',
        displayName: '同じ連絡先の別人',
        roleCode: 'requester',
        reason: '他組織の重複は見えない',
      }),
    );
    expect(created.status).toBe(201);

    // **別の行として作られる。** 同じ人を指しているかどうかは分からない。
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM app_user WHERE lower(primary_email) = 'only-b@example.com'",
    );
    expect(rows[0].n).toBe(2);
  });

  it('**platform ロールでは作れない**(二重承認が要る)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() =>
        users.createUser(orgAdmin, {
          email: 'evil@example.com',
          displayName: '奪取',
          roleCode: 'platform_admin',
          reason: '奪取の試み',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('メールの形式を見る', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() =>
        users.createUser(orgAdmin, {
          email: 'not-an-email',
          displayName: '形式不正',
          roleCode: 'requester',
          reason: '検査',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('理由なしでは作れない', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() =>
        users.createUser(orgAdmin, {
          email: 'noreason@example.com',
          displayName: '理由なし',
          roleCode: 'requester',
          reason: '   ',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**担当者は利用者を作れない**', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);

    await expect(
      run(() =>
        users.createUser(agent, {
          email: 'byagent@example.com',
          displayName: '担当者が作る',
          roleCode: 'agent',
          reason: '権限外',
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**作成と最初の役割を別々に記録する**(人を作ったことと権限は別の事実)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    const created = await run(() =>
      users.createUser(orgAdmin, {
        email: 'audited@example.com',
        displayName: '監査対象',
        roleCode: 'agent',
        reason: '中途入社',
      }),
    );

    const { rows } = await admin.query(
      `SELECT event_type, action FROM audit_event
        WHERE subject_user_id = $1 ORDER BY event_id`,
      [created.body.userId],
    );
    const types = rows.map((r) => `${r.event_type}:${r.action}`);
    expect(types).toContain('user.created:create');
    expect(types).toContain('role.binding.created:grant');
  });

  it('メールの大文字小文字を揃える(同じ人を二人作らない)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await run(() =>
      users.createUser(orgAdmin, {
        email: 'Mixed.Case@Example.com',
        displayName: '大文字混じり',
        roleCode: 'requester',
        reason: '入社',
      }),
    );

    await expect(
      run(() =>
        users.createUser(orgAdmin, {
          email: 'mixed.case@example.com',
          displayName: '小文字',
          roleCode: 'requester',
          reason: '二重',
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('役割の付与と取り消し (WP-P1-IDM-015)', () => {
  it('**管理者が役割を与えられる**(これまで配る経路が無かった)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('member@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const memberId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['member@example.com'])
    ).rows[0].id;

    await run(() =>
      users.grantRole(orgAdmin, memberId, { roleCode: 'agent', reason: 'ヘルプデスクへ異動' }),
    );

    const result = await run(() => users.list(orgAdmin));
    const member = result.body.items.find((m) => m.userId === memberId);
    expect(member!.roleCodes).toContain('agent');
  });

  it('**期限つきで与えられる**(兼務・出向 / FR-IDM-006)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('temp@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const tempId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['temp@example.com'])
    ).rows[0].id;

    await run(() =>
      users.grantRole(orgAdmin, tempId, {
        roleCode: 'approver',
        reason: '3か月の応援',
        validUntil: '2026-12-31',
      }),
    );

    const result = await run(() => users.list(orgAdmin));
    const member = result.body.items.find((m) => m.userId === tempId);
    expect(member!.temporaryRoles.map((t) => t.roleCode)).toContain('approver');
  });

  it('**platform ロールはこの画面から配れない**(二重承認が要る / 02.18 §2)', async () => {
    // 承認を伴わない経路をここに作ると、組織の管理者一人が
    // プラットフォーム全体を奪える。
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('target@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const targetId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['target@example.com'])
    ).rows[0].id;

    await expect(
      run(() =>
        users.grantRole(orgAdmin, targetId, {
          roleCode: 'platform_admin',
          reason: '奪取の試み',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM role_binding WHERE user_id = $1 AND role_scope = 'platform'`,
      [targetId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('理由なしでは与えられない', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('m@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['m@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.grantRole(orgAdmin, id, { roleCode: 'agent', reason: '  ' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**過ぎた期限では与えられない**(与えた瞬間に失効する)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('m@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['m@example.com'])
    ).rows[0].id;

    await expect(
      run(() =>
        users.grantRole(orgAdmin, id, {
          roleCode: 'agent',
          reason: '過去の期限',
          validUntil: '2020-01-01',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('既に持っている役割は二重に与えない (409)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('dup@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['dup@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.grantRole(orgAdmin, id, { roleCode: 'agent', reason: '再付与' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('停止された利用者には与えられない (409)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('off@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['off@example.com'])
    ).rows[0].id;
    await run(() => users.deactivate(orgAdmin, id, { reason: '退職' }));

    await expect(
      run(() => users.grantRole(orgAdmin, id, { roleCode: 'agent', reason: '止めた人に付与' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('**担当者は役割を配れない**(体制を変えられるのは管理者)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    await createUser('m@example.com', ORG_A, 'requester');
    const agent = await loginAs('ops@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['m@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.grantRole(agent, id, { roleCode: 'agent', reason: '自分で増やす' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**与えた役割はすぐ効く**(画面がそう書いている)', async () => {
    // 役割は毎回のセッション検証で解決される。ログインし直す必要は無い。
    // **画面の文言がこの挙動に依存している**ので、ここで固定する。
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('now@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const target = await loginAs('now@example.com', ORG_A);

    const before = await run(() => users.list(orgAdmin));
    expect(before.body.items.find((m) => m.userId === target.userId)!.roleCodes).not.toContain(
      'agent',
    );

    await run(() =>
      users.grantRole(orgAdmin, target.userId, { roleCode: 'agent', reason: '即時反映の確認' }),
    );

    // 同じセッションのまま、新しい役割が見える
    const client = await pool.connect();
    try {
      await beginAuthTransaction(client);
      const validation = await new SessionService(client).validate(target.token);
      await client.query('COMMIT');
      expect(validation.valid).toBe(true);
      if (validation.valid) {
        expect(validation.principal.bindings.map((b) => b.roleCode)).toContain('agent');
      }
    } finally {
      client.release();
    }
  });

  it('付与が監査に残る (`role.binding.created`)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('aud@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['aud@example.com'])
    ).rows[0].id;

    await run(() => users.grantRole(orgAdmin, id, { roleCode: 'agent', reason: '異動のため' }));

    const { rows } = await admin.query(
      `SELECT event_type, action, actor_id, after_state FROM audit_event
        WHERE subject_user_id = $1 AND event_type = 'role.binding.created'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('grant');
    // **誰が配ったかを残す。** 期限到来(system)と区別できなければ調査にならない。
    expect(rows[0].actor_id).toBe(orgAdmin.userId);
    expect(rows[0].after_state.reason).toContain('異動');
  });
});

describe('役割の取り消し (WP-P1-IDM-015)', () => {
  it('**取り消すと権限を失う。行は残る**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('rev@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['rev@example.com'])
    ).rows[0].id;

    await run(() => users.revokeRole(orgAdmin, id, { roleCode: 'agent', reason: '異動のため' }));

    const result = await run(() => users.list(orgAdmin));
    const member = result.body.items.find((m) => m.userId === id);
    expect(member?.roleCodes ?? []).not.toContain('agent');

    // 行は消さない。**履歴として残す。**
    const { rows } = await admin.query(
      `SELECT valid_until, expiry_recorded_at FROM role_binding rb
        JOIN role r ON r.id = rb.role_id
       WHERE rb.user_id = $1 AND r.code = 'agent'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].valid_until).not.toBeNull();
    // 期限到来の定期処理が同じ失権を二重に記録しないよう、印を付ける。
    expect(rows[0].expiry_recorded_at).not.toBeNull();
  });

  it('**取り消しは期限到来と区別して記録する**', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('rev2@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['rev2@example.com'])
    ).rows[0].id;

    await run(() => users.revokeRole(orgAdmin, id, { roleCode: 'agent', reason: '権限の見直し' }));

    const { rows } = await admin.query(
      `SELECT action, actor_type, actor_id FROM audit_event
        WHERE subject_user_id = $1 AND event_type = 'role.binding.deleted'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    // 「切れた」(system/expire)と「取り消した」(user/revoke)は別の出来事である。
    expect(rows[0].action).toBe('revoke');
    expect(rows[0].actor_type).toBe('user');
    expect(rows[0].actor_id).toBe(orgAdmin.userId);
  });

  it('**自分自身の組織管理者は取り消せない**(締め出しを作らない)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('adm2@example.com', ORG_A, 'org_admin');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);

    await expect(
      run(() =>
        users.revokeRole(orgAdmin, orgAdmin.userId, {
          roleCode: 'org_admin',
          reason: '自分を外す',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('持っていない役割は取り消せない (404)', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('none@example.com', ORG_A, 'requester');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['none@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.revokeRole(orgAdmin, id, { roleCode: 'auditor', reason: '無い役割' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('理由なしでは取り消せない', async () => {
    await createUser('adm@example.com', ORG_A, 'org_admin');
    await createUser('r@example.com', ORG_A, 'agent');
    const orgAdmin = await loginAs('adm@example.com', ORG_A);
    const id = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['r@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.revokeRole(orgAdmin, id, { roleCode: 'agent', reason: '' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**他組織の利用者は触れない**', async () => {
    await createUser('adm-a@example.com', ORG_A, 'org_admin');
    await createUser('other@example.com', ORG_B, 'agent');
    const admA = await loginAs('adm-a@example.com', ORG_A);
    const foreignId = (
      await admin.query('SELECT id FROM app_user WHERE primary_email = $1', ['other@example.com'])
    ).rows[0].id;

    await expect(
      run(() => users.grantRole(admA, foreignId, { roleCode: 'agent', reason: '越境の試み' })),
    ).rejects.toMatchObject({ status: 404 });
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
