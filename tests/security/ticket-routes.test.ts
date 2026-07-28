/**
 * チケットのHTTP面 (WP-P2-PORTAL-002 / TL-06)。
 *
 * 重点は「作れること」より **「作れてはいけないものが作れないこと」**と
 * **「見えてはいけないものが見えないこと」**。
 *
 * 画面は認証を通った人にしか見えないが、APIは直接叩ける。
 * 画面側で制御しているつもりの制約が、API では抜けている —
 * というのが最も起きやすい漏れ方である。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '../../packages/shared/src/correlation/context.js';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
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

let pool: pg.Pool;
let admin: pg.Client;
let controller: TicketController;

const VALID = {
  kind: 'incident',
  subject: 'ログインできない',
  body: '朝からログイン画面でエラーが出ます。',
  impact: 'medium',
  urgency: 'high',
};

async function createUser(email: string, orgId: string, roleCode: string): Promise<string> {
  const userId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, $2, $3, 'active', 'admin')`,
    [userId, email, email],
  );
  const { rows } = await admin.query('SELECT id, scope FROM role WHERE code = $1', [roleCode]);
  await admin.query(
    // valid_from を明示的に過去へ置く。既定の now() は **DBの時計** で入るため、
    // ホストの時計が僅かに遅れていると「まだ有効になっていない束縛」と判定され、
    // テストが時々落ちる。実運用では問題にならないが、テストは決定的にする。
    `INSERT INTO role_binding (id, user_id, role_id, role_scope, organization_id, source, valid_from)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
    [uuidv7(), userId, rows[0].id, rows[0].scope, orgId, new Date('2026-01-01T00:00:00Z')],
  );
  await admin.query(
    `INSERT INTO identity (id, user_id, idp_type, issuer, subject)
     VALUES ($1, $2, 'local', $3, $4)`,
    [uuidv7(), userId, LOCAL_ISSUER, email],
  );
  await admin.query(
    `INSERT INTO local_credential (id, user_id, password_hash) VALUES ($1, $2, $3)`,
    [uuidv7(), userId, await hashPassword(PASSWORD)],
  );
  return userId;
}

/** ログインして、実際のセッションから認可文脈を組み立てる。 */
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
    if (!result.ok) throw new Error(`ログインに失敗しました: ${result.reason}`);

    const validation = await sessions.validate(result.token);
    await client.query('COMMIT');
    if (!validation.valid) throw new Error('セッション検証に失敗しました');

    return {
      authz: { principal: validation.principal, organizationId: orgId },
      sessionId: validation.session.id,
      userId: validation.session.userId,
    };
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  controller = new TicketController({ pool, denialRecorder: new PoolDenialRecorder(pool) });
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM session');
  // **シードのアカウントを消さない。** テストが作るのは created_via='admin' のみ。
  // 以前はここで local_credential を全消ししており、テストを流したあとは
  // シードの利用者が誰もログインできなくなっていた。画面は正常に見えるのに
  // 全員が 401 になり、原因は認証の不具合に見える(実際は資格情報の消失)。
  await admin.query(
    `DELETE FROM local_credential WHERE user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query(
    `DELETE FROM identity WHERE issuer = $1 AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
    [LOCAL_ISSUER],
  );
  await cleanBusinessData(admin);
  // **シードの束縛を消さない。** テストが作るのは created_via='admin' の利用者だけ。
  // 以前は source='manual' の束縛を全消ししており、シードの兼務設定
  // (acme の agent が beta の requester も兼ねる)が消えていた。
  // その結果、テストのあとは兼務者が存在せず、通し確認が静かに別の経路を通っていた。
  await admin.query(
    `DELETE FROM role_binding
      WHERE source = 'manual'
        AND user_id IN (SELECT id FROM app_user WHERE created_via = 'admin')`,
  );
  await admin.query("DELETE FROM app_user WHERE created_via = 'admin'");
  await cleanAuditData(admin, "target_type IN ('ticket', 'session', 'app_user')");
});

describe('起票', () => {
  it('依頼者が自分のチケットを作れる', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    const auth = await loginAs('req@example.com', ORG_A);

    const result = await runWithContext(newContext(), () => controller.create(auth, VALID));

    expect(result.status).toBe(201);
    expect(result.body.number).toMatch(/^INC-|^REQ-|\w/);
    expect(result.body.subject).toBe(VALID.subject);
  });

  it('**優先度は利用者が選べず、影響と緊急度から決まる**(FR-TKT-002)', async () => {
    await createUser('pri@example.com', ORG_A, 'requester');
    const auth = await loginAs('pri@example.com', ORG_A);

    // 利用者が priority を送りつけても無視される
    const result = await runWithContext(newContext(), () =>
      controller.create(auth, { ...VALID, impact: 'high', urgency: 'high', priority: 'low' }),
    );
    expect(result.body.priority).not.toBe('low');
  });

  it.each([
    ['件名が空', { ...VALID, subject: '   ' }, 'subject'],
    ['内容が空', { ...VALID, body: '' }, 'body'],
    ['種別が不正', { ...VALID, kind: 'unknown' }, 'kind'],
    ['影響が不正', { ...VALID, impact: 'urgent' }, 'impact'],
    ['緊急度が不正', { ...VALID, urgency: 'asap' }, 'urgency'],
  ])('%s なら 400 を返す', async (_label, body, field) => {
    await createUser('bad@example.com', ORG_A, 'requester');
    const auth = await loginAs('bad@example.com', ORG_A);

    await expect(
      runWithContext(newContext(), () => controller.create(auth, body)),
    ).rejects.toMatchObject({ status: 400 });

    try {
      await runWithContext(newContext(), () => controller.create(auth, body));
    } catch (error) {
      const errors = (error as { errors?: Array<{ field: string }> }).errors ?? [];
      expect(errors.map((e) => e.field)).toContain(field);
    }
  });

  it('**誤りをまとめて返す**(1つずつ直させない)', async () => {
    await createUser('multi@example.com', ORG_A, 'requester');
    const auth = await loginAs('multi@example.com', ORG_A);

    try {
      await runWithContext(newContext(), () =>
        controller.create(auth, { kind: 'nope', subject: '', body: '', impact: 'x', urgency: 'y' }),
      );
      throw new Error('例外が発生しませんでした');
    } catch (error) {
      const errors = (error as { errors?: Array<{ field: string }> }).errors ?? [];
      expect(errors.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('件名が長すぎると拒否される', async () => {
    await createUser('long@example.com', ORG_A, 'requester');
    const auth = await loginAs('long@example.com', ORG_A);
    await expect(
      runWithContext(newContext(), () =>
        controller.create(auth, { ...VALID, subject: 'あ'.repeat(201) }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('応答に含める項目', () => {
  it('**担当者のIDを返さない**(誰が担当かは依頼者に不要)', async () => {
    await createUser('view@example.com', ORG_A, 'requester');
    const auth = await loginAs('view@example.com', ORG_A);
    const result = await runWithContext(newContext(), () => controller.create(auth, VALID));

    expect(result.body).not.toHaveProperty('assigneeId');
    expect(result.body).not.toHaveProperty('requesterId');
    expect(result.body).not.toHaveProperty('organizationId');
    // 割り当て済みかどうかだけは伝える
    expect(result.body).toHaveProperty('assigned');
  });

  it('SLAクロックなどの内部状態を返さない', async () => {
    await createUser('sla@example.com', ORG_A, 'requester');
    const auth = await loginAs('sla@example.com', ORG_A);
    const result = await runWithContext(newContext(), () => controller.create(auth, VALID));

    expect(result.body).not.toHaveProperty('slaClock');
    expect(result.body).not.toHaveProperty('searchVector');
  });
});

describe('一覧の可視範囲', () => {
  it('**依頼者には自分の分だけが見える**', async () => {
    await createUser('own@example.com', ORG_A, 'requester');
    await createUser('other@example.com', ORG_A, 'requester');

    const mine = await loginAs('own@example.com', ORG_A);
    const theirs = await loginAs('other@example.com', ORG_A);

    await runWithContext(newContext(), () => controller.create(mine, VALID));
    await runWithContext(newContext(), () =>
      controller.create(theirs, { ...VALID, subject: '他人のチケット' }),
    );

    const list = await runWithContext(newContext(), () =>
      controller.list(mine, new URLSearchParams()),
    );

    expect(list.body.scope).toBe('own');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items.map((t) => t.subject)).not.toContain('他人のチケット');
  });

  it('担当者には組織全体が見える', async () => {
    await createUser('agent@example.com', ORG_A, 'agent');
    await createUser('user@example.com', ORG_A, 'requester');

    const agent = await loginAs('agent@example.com', ORG_A);
    const user = await loginAs('user@example.com', ORG_A);

    await runWithContext(newContext(), () => controller.create(user, VALID));

    const list = await runWithContext(newContext(), () =>
      controller.list(agent, new URLSearchParams()),
    );
    expect(list.body.scope).toBe('organization');
    expect(list.body.items.length).toBeGreaterThan(0);
  });

  it('**他組織のチケットは一覧に現れない**', async () => {
    await createUser('a@example.com', ORG_A, 'agent');
    await createUser('b@example.com', ORG_B, 'agent');

    const inA = await loginAs('a@example.com', ORG_A);
    const inB = await loginAs('b@example.com', ORG_B);

    await runWithContext(newContext(), () =>
      controller.create(inB, { ...VALID, subject: 'ORG_Bの秘密' }),
    );

    const list = await runWithContext(newContext(), () =>
      controller.list(inA, new URLSearchParams()),
    );
    expect(list.body.items.map((t) => t.subject)).not.toContain('ORG_Bの秘密');
  });

  it('limit が範囲外なら 400', async () => {
    await createUser('lim@example.com', ORG_A, 'requester');
    const auth = await loginAs('lim@example.com', ORG_A);
    for (const bad of ['0', '101', 'abc']) {
      await expect(
        runWithContext(newContext(), () =>
          controller.list(auth, new URLSearchParams({ limit: bad })),
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('個別取得の存在秘匿 (NFR-SEC-006)', () => {
  it('**他人のチケットは 404**(403ではない)', async () => {
    await createUser('me@example.com', ORG_A, 'requester');
    await createUser('you@example.com', ORG_A, 'requester');

    const me = await loginAs('me@example.com', ORG_A);
    const you = await loginAs('you@example.com', ORG_A);

    const created = await runWithContext(newContext(), () => controller.create(you, VALID));

    // 403 を返すと「そのIDは存在する」ことを教えてしまう
    await expect(
      runWithContext(newContext(), () => controller.findById(me, created.body.id as string)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('**他組織のチケットは 404**', async () => {
    await createUser('oa@example.com', ORG_A, 'agent');
    await createUser('ob@example.com', ORG_B, 'agent');

    const inA = await loginAs('oa@example.com', ORG_A);
    const inB = await loginAs('ob@example.com', ORG_B);

    const created = await runWithContext(newContext(), () => controller.create(inB, VALID));

    await expect(
      runWithContext(newContext(), () => controller.findById(inA, created.body.id as string)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('存在しないIDも 404', async () => {
    await createUser('nf@example.com', ORG_A, 'requester');
    const auth = await loginAs('nf@example.com', ORG_A);
    await expect(
      runWithContext(newContext(), () => controller.findById(auth, uuidv7())),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('自分のチケットは取得できる', async () => {
    await createUser('self@example.com', ORG_A, 'requester');
    const auth = await loginAs('self@example.com', ORG_A);
    const created = await runWithContext(newContext(), () => controller.create(auth, VALID));

    const fetched = await runWithContext(newContext(), () =>
      controller.findById(auth, created.body.id as string),
    );
    expect(fetched.body.number).toBe(created.body.number);
  });
});
