/**
 * 一覧の絞り込み (WP-P2-OPSUI-010)。
 *
 * 絞り込みで最も危険なのは **「絞り込んだつもりで絞り込めていない」** 状態である。
 *
 * 知らない値を黙って無視すると、担当者は条件が効いていると思ったまま
 * 全件を見る。逆に、絞り込みが認可の範囲を広げてしまえば越境になる。
 * どちらも画面上は正常に見える。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { CollaborationController } from '../../services/api/src/modules/ticket/collaboration.routes.js';
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

async function createUser(email: string, orgId: string, roleCode: string): Promise<string> {
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
    [uuidv7(), userId, rows[0].id, rows[0].scope, orgId, PAST],
  );
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

async function newTicket(
  auth: AuthenticatedRequest,
  input: { kind?: string; subject: string; impact?: string; urgency?: string },
): Promise<string> {
  const created = await run(() =>
    tickets.create(auth, {
      kind: input.kind ?? 'incident',
      subject: input.subject,
      body: '本文です。',
      impact: input.impact ?? 'medium',
      urgency: input.urgency ?? 'medium',
    }),
  );
  return created.body.id as string;
}

const listWith = (auth: AuthenticatedRequest, query: string) =>
  run(() => tickets.list(auth, new URLSearchParams(query)));

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const denialRecorder = new PoolDenialRecorder(pool);
  tickets = new TicketController({ pool, denialRecorder });
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
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM session');
  await admin.query('DELETE FROM local_credential');
  await admin.query('DELETE FROM identity WHERE issuer = $1', [LOCAL_ISSUER]);
  await cleanBusinessData(admin);
  await admin.query("DELETE FROM role_binding WHERE source = 'manual'");
  await admin.query("DELETE FROM app_user WHERE created_via = 'admin'");
  await cleanAuditData(admin, "target_type IN ('ticket', 'session', 'app_user')");
});

describe('知らない値を黙って無視しない', () => {
  it.each([
    ['状態', 'state=nonexistent'],
    ['種別', 'kind=question'],
    ['優先度', 'priority=urgent'],
    ['担当', 'assignment=someone-else'],
  ])('**%s に不正な値を渡すと 400**(全件を返さない)', async (_label, query) => {
    await createUser('f1@example.com', ORG_A, 'agent');
    const agent = await loginAs('f1@example.com', ORG_A);
    await newTicket(agent, { subject: 'テスト' });

    // 黙って無視すると、担当者は条件が効いていると思ったまま全件を見る。
    await expect(listWith(agent, query)).rejects.toMatchObject({ status: 400 });
  });

  it('正しい値と不正な値が混ざっていても拒否する', async () => {
    await createUser('f2@example.com', ORG_A, 'agent');
    const agent = await loginAs('f2@example.com', ORG_A);
    await expect(listWith(agent, 'state=new&state=bogus')).rejects.toMatchObject({ status: 400 });
  });
});

describe('絞り込みが効く', () => {
  it('状態で絞り込める', async () => {
    await createUser('f3@example.com', ORG_A, 'agent');
    const agent = await loginAs('f3@example.com', ORG_A);

    const target = await newTicket(agent, { subject: '進行中にするもの' });
    await newTicket(agent, { subject: '新規のまま' });

    await run(() => collab.assign(agent, target, { assigneeId: agent.userId }));
    await run(() => collab.transition(agent, target, { to: 'assigned', reason: 'assign' }));

    const result = await listWith(agent, 'state=assigned');
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.subject).toBe('進行中にするもの');
  });

  it('複数の状態を指定できる(OR)', async () => {
    await createUser('f4@example.com', ORG_A, 'agent');
    const agent = await loginAs('f4@example.com', ORG_A);

    const a = await newTicket(agent, { subject: 'A' });
    await newTicket(agent, { subject: 'B' });
    await run(() => collab.assign(agent, a, { assigneeId: agent.userId }));
    await run(() => collab.transition(agent, a, { to: 'assigned', reason: 'assign' }));

    const result = await listWith(agent, 'state=new&state=assigned');
    expect(result.body.items).toHaveLength(2);
  });

  it('種別で絞り込める', async () => {
    await createUser('f5@example.com', ORG_A, 'agent');
    const agent = await loginAs('f5@example.com', ORG_A);
    await newTicket(agent, { kind: 'incident', subject: '障害' });
    await newTicket(agent, { kind: 'request', subject: '依頼' });

    const result = await listWith(agent, 'kind=request');
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.kind).toBe('request');
  });

  it('優先度で絞り込める', async () => {
    await createUser('f6@example.com', ORG_A, 'agent');
    const agent = await loginAs('f6@example.com', ORG_A);
    await newTicket(agent, { subject: '高', impact: 'high', urgency: 'high' });
    await newTicket(agent, { subject: '低', impact: 'low', urgency: 'low' });

    const result = await listWith(agent, 'priority=low');
    expect(result.body.items.every((t) => t.priority === 'low')).toBe(true);
    expect(result.body.items.length).toBeGreaterThan(0);
  });

  it('**未割当だけを絞り込める**(誰も見ていないものを見つける)', async () => {
    await createUser('f7@example.com', ORG_A, 'agent');
    const agent = await loginAs('f7@example.com', ORG_A);

    const assigned = await newTicket(agent, { subject: '割当済み' });
    await newTicket(agent, { subject: '未割当' });
    await run(() => collab.assign(agent, assigned, { assigneeId: agent.userId }));

    const result = await listWith(agent, 'assignment=unassigned');
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.subject).toBe('未割当');
  });

  it('自分の担当だけを絞り込める', async () => {
    await createUser('f8@example.com', ORG_A, 'agent');
    await createUser('f8b@example.com', ORG_A, 'agent');
    const me = await loginAs('f8@example.com', ORG_A);
    const other = await loginAs('f8b@example.com', ORG_A);

    const mine = await newTicket(me, { subject: '自分の' });
    const theirs = await newTicket(me, { subject: '他人の' });
    await run(() => collab.assign(me, mine, { assigneeId: me.userId }));
    await run(() => collab.assign(me, theirs, { assigneeId: other.userId }));

    const result = await listWith(me, 'assignment=mine');
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.subject).toBe('自分の');
  });

  it('条件を組み合わせられる(AND)', async () => {
    await createUser('f9@example.com', ORG_A, 'agent');
    const agent = await loginAs('f9@example.com', ORG_A);
    await newTicket(agent, {
      kind: 'incident',
      subject: '障害・低',
      impact: 'low',
      urgency: 'low',
    });
    await newTicket(agent, { kind: 'request', subject: '依頼・低', impact: 'low', urgency: 'low' });

    const result = await listWith(agent, 'kind=incident&priority=low');
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.subject).toBe('障害・低');
  });
});

describe('絞り込みが認可を広げない', () => {
  it('**依頼者が絞り込んでも他人の分は見えない**', async () => {
    await createUser('r1@example.com', ORG_A, 'requester');
    await createUser('r2@example.com', ORG_A, 'requester');
    const me = await loginAs('r1@example.com', ORG_A);
    const other = await loginAs('r2@example.com', ORG_A);

    await newTicket(me, { subject: '自分の' });
    await newTicket(other, { subject: '他人の' });

    // 「未割当」で絞ると両方が該当するが、認可の範囲は変わらない
    const result = await listWith(me, 'assignment=unassigned');
    expect(result.body.scope).toBe('own');
    expect(result.body.items.map((t) => t.subject)).not.toContain('他人の');
  });

  it('**他組織のチケットは絞り込みでも現れない**', async () => {
    await createUser('o1@example.com', ORG_A, 'agent');
    await createUser('o2@example.com', ORG_B, 'agent');
    const inA = await loginAs('o1@example.com', ORG_A);
    const inB = await loginAs('o2@example.com', ORG_B);

    await newTicket(inB, { subject: 'ORG_Bの秘密' });

    const result = await listWith(inA, 'state=new');
    expect(result.body.items.map((t) => t.subject)).not.toContain('ORG_Bの秘密');
  });

  it('**任意の利用者IDで絞り込めない**(在籍者の総当たり経路を作らない)', async () => {
    await createUser('a1@example.com', ORG_A, 'agent');
    const agent = await loginAs('a1@example.com', ORG_A);

    // assignment は mine / unassigned のみ。任意のIDは受け付けない。
    await expect(listWith(agent, `assignment=${uuidv7()}`)).rejects.toMatchObject({ status: 400 });
  });
});

describe('適用された条件を応答で返す', () => {
  it('**画面が送った条件と突き合わせられる**', async () => {
    await createUser('ap@example.com', ORG_A, 'agent');
    const agent = await loginAs('ap@example.com', ORG_A);

    const result = await listWith(agent, 'state=new&kind=incident');
    // これが無いと「絞り込んだつもりで全件を見ている」に気付けない
    expect(result.body.appliedFilter).toMatchObject({ state: ['new'], kind: ['incident'] });
  });

  it('条件なしなら空になる', async () => {
    await createUser('ap2@example.com', ORG_A, 'agent');
    const agent = await loginAs('ap2@example.com', ORG_A);

    const result = await listWith(agent, '');
    expect(result.body.appliedFilter).toEqual({});
  });
});
