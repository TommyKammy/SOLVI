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

describe('キーワード検索', () => {
  it('件名から探せる', async () => {
    await createUser('k1@example.com', ORG_A, 'agent');
    const agent = await loginAs('k1@example.com', ORG_A);
    await newTicket(agent, { subject: 'プリンタが動かない' });
    await newTicket(agent, { subject: 'メールが送れない' });

    const result = await listWith(agent, 'keyword=' + encodeURIComponent('プリンタ'));
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]!.subject).toBe('プリンタが動かない');
  });

  it('受付番号から探せる', async () => {
    await createUser('k2@example.com', ORG_A, 'agent');
    const agent = await loginAs('k2@example.com', ORG_A);
    const id = await newTicket(agent, { subject: '番号で探す' });

    const detail = await run(() => tickets.findById(agent, id));
    const number = detail.body.number as string;

    const result = await listWith(agent, 'keyword=' + encodeURIComponent(number));
    expect(result.body.items.map((t) => t.id)).toContain(id);
  });

  it.each([
    ['%', '%'],
    ['_', '_'],
    ['バックスラッシュ', '\\'],
  ])('**ワイルドカード %s が全件一致にならない**', async (_label, wildcard) => {
    await createUser('k3@example.com', ORG_A, 'agent');
    const agent = await loginAs('k3@example.com', ORG_A);
    await newTicket(agent, { subject: '普通の件名' });
    await newTicket(agent, { subject: 'もう一つの件名' });

    // エスケープしないと、`%` は「何でも一致」として解釈され
    // 「検索した」という体裁で全件が返る。
    const result = await listWith(agent, 'keyword=' + encodeURIComponent(wildcard));
    expect(result.body.items).toHaveLength(0);
  });

  it('**検索が認可の範囲を広げない**', async () => {
    await createUser('k4@example.com', ORG_A, 'requester');
    await createUser('k4b@example.com', ORG_A, 'requester');
    const me = await loginAs('k4@example.com', ORG_A);
    const other = await loginAs('k4b@example.com', ORG_A);

    await newTicket(me, { subject: '共通のことば' });
    await newTicket(other, { subject: '共通のことば' });

    const result = await listWith(me, 'keyword=' + encodeURIComponent('共通のことば'));
    // 検索語が一致しても、見える範囲は変わらない
    expect(result.body.items).toHaveLength(1);
    expect(result.body.scope).toBe('own');
  });

  it('**他組織のチケットは検索に出ない**', async () => {
    await createUser('k5@example.com', ORG_A, 'agent');
    await createUser('k5b@example.com', ORG_B, 'agent');
    const inA = await loginAs('k5@example.com', ORG_A);
    const inB = await loginAs('k5b@example.com', ORG_B);

    await newTicket(inB, { subject: '越境してはいけない語' });

    const result = await listWith(inA, 'keyword=' + encodeURIComponent('越境してはいけない語'));
    expect(result.body.items).toHaveLength(0);
  });

  it('長すぎる検索語を拒否する', async () => {
    await createUser('k6@example.com', ORG_A, 'agent');
    const agent = await loginAs('k6@example.com', ORG_A);
    await expect(listWith(agent, 'keyword=' + 'あ'.repeat(300))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('空白だけの検索語は条件として扱わない', async () => {
    await createUser('k7@example.com', ORG_A, 'agent');
    const agent = await loginAs('k7@example.com', ORG_A);
    await newTicket(agent, { subject: '何か' });

    const result = await listWith(agent, 'keyword=' + encodeURIComponent('   '));
    // 「空で検索した」を「全件」として扱う。エラーにすると、
    // 入力欄を空にして押しただけで怒られることになる。
    expect(result.body.appliedFilter).not.toHaveProperty('keyword');
    expect(result.body.items.length).toBeGreaterThan(0);
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

/**
 * 期限の可視化 (FR-TKT-008 / WP-P2-SLAUI-016)。
 *
 * `slaStatus()` はテストからしか呼ばれておらず、期限はどの画面にも
 * 出ていなかった。さらに判定は保存列に書かれ、**更新されるのは
 * 状態遷移のときだけ**だった — 一覧で最も見たい「放置されたもの」だけが
 * 更新されない状態だった。
 *
 * 判定は読むたびに計算する。計算してしまえば陳腐化しない。
 */
describe('期限の可視化 (FR-TKT-008)', () => {
  it('**一覧に期限が載る**(保存値ではなく計算値)', async () => {
    await createUser('sla-a@example.com', ORG_A, 'agent');
    const agent = await loginAs('sla-a@example.com', ORG_A);
    await newTicket(agent, { subject: '期限の確認' });

    const result = await run(() => tickets.list(agent, new URLSearchParams()));
    const item = result.body.items[0]!;
    expect(item.sla).toBeDefined();
    expect(typeof item.sla.remainingSeconds).toBe('number');
    expect(item.sla.breached).toBe(false);
  });

  it('**放置しただけで超過になる**(誰も触らなくても判定される)', async () => {
    await createUser('sla-b@example.com', ORG_A, 'agent');
    const agent = await loginAs('sla-b@example.com', ORG_A);
    const ticketId = await newTicket(agent, { subject: '放置される問い合わせ' });

    // 誰も触らない。クロックの経過だけを進める。
    // 保存値を使っていた頃は、これが永久に超過にならなかった。
    await admin.query(
      `UPDATE ticket SET sla_elapsed_seconds = 999999, sla_clock_started_at = NULL WHERE id = $1`,
      [ticketId],
    );

    const result = await run(() => tickets.list(agent, new URLSearchParams()));
    const item = result.body.items.find((t) => t.id === ticketId)!;
    expect(item.sla.breached).toBe(true);
    expect(item.sla.remainingSeconds).toBeLessThan(0);
  });

  it('超過だけを絞り込める', async () => {
    await createUser('sla-c@example.com', ORG_A, 'agent');
    const agent = await loginAs('sla-c@example.com', ORG_A);
    const overdue = await newTicket(agent, { subject: '超過するもの' });
    const fresh = await newTicket(agent, { subject: '余裕があるもの' });
    await admin.query(
      `UPDATE ticket SET sla_elapsed_seconds = 999999, sla_clock_started_at = NULL WHERE id = $1`,
      [overdue],
    );

    const result = await run(() => tickets.list(agent, new URLSearchParams({ sla: 'breached' })));
    const ids = result.body.items.map((t) => t.id);
    expect(ids).toContain(overdue);
    expect(ids).not.toContain(fresh);
  });

  it('**期限が近い順に並べられる**(最も遅れているものが先頭)', async () => {
    await createUser('sla-d@example.com', ORG_A, 'agent');
    const agent = await loginAs('sla-d@example.com', ORG_A);
    const later = await newTicket(agent, { subject: '後で良いもの' });
    const overdue = await newTicket(agent, { subject: '遅れているもの' });
    await admin.query(
      `UPDATE ticket SET sla_elapsed_seconds = 999999, sla_clock_started_at = NULL WHERE id = $1`,
      [overdue],
    );

    const result = await run(() => tickets.list(agent, new URLSearchParams({ sort: 'deadline' })));
    const ids = result.body.items.map((t) => t.id);
    expect(ids.indexOf(overdue)).toBeLessThan(ids.indexOf(later));
  });

  it('知らない並び順・期限の値は 400(黙って無視しない)', async () => {
    await createUser('sla-e@example.com', ORG_A, 'agent');
    const agent = await loginAs('sla-e@example.com', ORG_A);
    await expect(
      run(() => tickets.list(agent, new URLSearchParams({ sort: 'whatever' }))),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      run(() => tickets.list(agent, new URLSearchParams({ sla: 'whatever' }))),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**期限順では続きの取得を受け付けない**(壊れた頁を黙って返さない)', async () => {
    await createUser('sla-a@example.com', ORG_A, 'agent');
    const agent = await loginAs('sla-a@example.com', ORG_A);
    await newTicket(agent, { subject: '期限の確認' });

    // カーソルは (created_at, id) で判定するため、別の列で並べた一覧に
    // 適用すると飛ばし・重複が起きる。
    await expect(
      run(() =>
        tickets.list(
          agent,
          new URLSearchParams({
            sort: 'deadline',
            cursorCreatedAt: '2026-01-01 00:00:00+00',
            cursorId: '00000000-0000-4000-9000-000000000001',
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/**
 * 初回応答の記録 (FR-TKT-008 の応答SLA)。
 *
 * `recordFirstResponse` は「担当者の公開コメントで初めて呼ばれる」と
 * 書かれていたが**呼ぶ側が居なかった**。`first_responded_at` は永久に
 * NULL のままで、応答SLAは全件が「未応答」として判定され続けていた。
 */
describe('初回応答の記録 (FR-TKT-008)', () => {
  it('**担当者の公開コメントで初回応答が記録される**', async () => {
    await createUser('fr-req1@example.com', ORG_A, 'requester');
    await createUser('fr-ops1@example.com', ORG_A, 'agent');
    const requester = await loginAs('fr-req1@example.com', ORG_A);
    const agent = await loginAs('fr-ops1@example.com', ORG_A);
    const ticketId = await newTicket(requester, { subject: '応答の記録' });

    await run(() =>
      collab.addComment(agent, ticketId, { visibility: 'public', body: '確認しています。' }),
    );

    const { rows } = await admin.query('SELECT first_responded_at FROM ticket WHERE id = $1', [
      ticketId,
    ]);
    expect(rows[0].first_responded_at).not.toBeNull();
  });

  it('**内部メモは応答に数えない**(依頼者に届いていない)', async () => {
    await createUser('fr-req2@example.com', ORG_A, 'requester');
    await createUser('fr-ops2@example.com', ORG_A, 'agent');
    const requester = await loginAs('fr-req2@example.com', ORG_A);
    const agent = await loginAs('fr-ops2@example.com', ORG_A);
    const ticketId = await newTicket(requester, { subject: '内部メモのみ' });

    await run(() =>
      collab.addComment(agent, ticketId, { visibility: 'internal', body: '調査メモ' }),
    );

    const { rows } = await admin.query('SELECT first_responded_at FROM ticket WHERE id = $1', [
      ticketId,
    ]);
    expect(rows[0].first_responded_at).toBeNull();
  });

  it('**依頼者自身の追記は応答ではない**', async () => {
    await createUser('fr-req3@example.com', ORG_A, 'requester');
    const requester = await loginAs('fr-req3@example.com', ORG_A);
    const ticketId = await newTicket(requester, { subject: '依頼者の追記' });

    await run(() =>
      collab.addComment(requester, ticketId, { visibility: 'public', body: '補足です。' }),
    );

    const { rows } = await admin.query('SELECT first_responded_at FROM ticket WHERE id = $1', [
      ticketId,
    ]);
    expect(rows[0].first_responded_at).toBeNull();
  });

  it('2回目以降のコメントで時刻が上書きされない', async () => {
    await createUser('fr-req4@example.com', ORG_A, 'requester');
    await createUser('fr-ops4@example.com', ORG_A, 'agent');
    const requester = await loginAs('fr-req4@example.com', ORG_A);
    const agent = await loginAs('fr-ops4@example.com', ORG_A);
    const ticketId = await newTicket(requester, { subject: '2回目の応答' });

    await run(() => collab.addComment(agent, ticketId, { visibility: 'public', body: '1回目' }));
    const { rows: first } = await admin.query(
      'SELECT first_responded_at FROM ticket WHERE id = $1',
      [ticketId],
    );
    await run(() => collab.addComment(agent, ticketId, { visibility: 'public', body: '2回目' }));
    const { rows: second } = await admin.query(
      'SELECT first_responded_at FROM ticket WHERE id = $1',
      [ticketId],
    );

    expect(second[0].first_responded_at.getTime()).toBe(first[0].first_responded_at.getTime());
  });
});

/**
 * 期間と依頼者の絞り込み (FR-TKT-006 / WP-P2-SEARCH-017)。
 *
 * 要求は「番号・件名・**依頼者**・状態・担当・**期間**で検索」。
 * `TicketFilter` には最初から条件があったが、**クエリパラメータとして
 * 読んでいなかった** — 条件は書けるのに外から指定する経路が無かった。
 */
describe('期間の絞り込み (FR-TKT-006)', () => {
  it('受付日の範囲で絞り込める', async () => {
    await createUser('per-a@example.com', ORG_A, 'agent');
    const agent = await loginAs('per-a@example.com', ORG_A);
    const oldOne = await newTicket(agent, { subject: '古い問い合わせ' });
    const newOne = await newTicket(agent, { subject: '新しい問い合わせ' });
    await admin.query("UPDATE ticket SET created_at = '2026-01-15T10:00:00Z' WHERE id = $1", [
      oldOne,
    ]);

    const result = await run(() =>
      tickets.list(
        agent,
        new URLSearchParams({ createdFrom: '2026-01-01', createdTo: '2026-01-31' }),
      ),
    );
    const ids = result.body.items.map((t) => t.id);
    expect(ids).toContain(oldOne);
    expect(ids).not.toContain(newOne);
  });

  it('**「まで」はその日の終わりまで含む**', async () => {
    await createUser('per-b@example.com', ORG_A, 'agent');
    const agent = await loginAs('per-b@example.com', ORG_A);
    const id = await newTicket(agent, { subject: '当日の夜' });
    await admin.query("UPDATE ticket SET created_at = '2026-01-15T23:30:00Z' WHERE id = $1", [id]);

    // 「2026-01-15 まで」と指定した人は、その日に受け付けた分も見たい。
    const result = await run(() =>
      tickets.list(agent, new URLSearchParams({ createdTo: '2026-01-15' })),
    );
    expect(result.body.items.map((t) => t.id)).toContain(id);
  });

  it('日付の形式が不正なら 400', async () => {
    await createUser('per-c@example.com', ORG_A, 'agent');
    const agent = await loginAs('per-c@example.com', ORG_A);
    await expect(
      run(() => tickets.list(agent, new URLSearchParams({ createdFrom: '2026/01/01' }))),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**終わりが始まりより前なら 400**(0件を返して誤りに気付かせない、をしない)', async () => {
    await createUser('per-d@example.com', ORG_A, 'agent');
    const agent = await loginAs('per-d@example.com', ORG_A);
    await expect(
      run(() =>
        tickets.list(
          agent,
          new URLSearchParams({ createdFrom: '2026-02-01', createdTo: '2026-01-01' }),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('依頼者の絞り込み (FR-TKT-006)', () => {
  it('依頼者を指定して絞り込める', async () => {
    const reqId = await createUser('rq-a@example.com', ORG_A, 'requester');
    await createUser('rq-b@example.com', ORG_A, 'requester');
    await createUser('rq-ops@example.com', ORG_A, 'agent');
    const requester = await loginAs('rq-a@example.com', ORG_A);
    const other = await loginAs('rq-b@example.com', ORG_A);
    const agent = await loginAs('rq-ops@example.com', ORG_A);

    const mine = await newTicket(requester, { subject: 'この人の問い合わせ' });
    const theirs = await newTicket(other, { subject: '別の人の問い合わせ' });

    const result = await run(() => tickets.list(agent, new URLSearchParams({ requester: reqId })));
    const ids = result.body.items.map((t) => t.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('**存在しないIDでも0件を返すだけ**(実在の有無が漏れない)', async () => {
    await createUser('rq-ops2@example.com', ORG_A, 'agent');
    const agent = await loginAs('rq-ops2@example.com', ORG_A);

    // 「その利用者が居ない」と「その利用者の問い合わせが無い」を区別しない。
    const result = await run(() =>
      tickets.list(
        agent,
        new URLSearchParams({ requester: '00000000-0000-4000-9000-0000000000ff' }),
      ),
    );
    expect(result.body.items).toHaveLength(0);
  });

  it('**依頼者が他人のIDを指定しても自分の分しか出ない**', async () => {
    const otherId = await createUser('rq-c@example.com', ORG_A, 'requester');
    await createUser('rq-d@example.com', ORG_A, 'requester');
    const other = await loginAs('rq-c@example.com', ORG_A);
    const me = await loginAs('rq-d@example.com', ORG_A);
    await newTicket(other, { subject: '他人の問い合わせ' });

    // 認可条件で自分の分に絞られるため、他人のIDを名乗っても0件。
    const result = await run(() => tickets.list(me, new URLSearchParams({ requester: otherId })));
    expect(result.body.items).toHaveLength(0);
  });

  it('**他組織の依頼者のチケットは出ない**', async () => {
    const foreignId = await createUser('rq-e@example.com', ORG_B, 'requester');
    await createUser('rq-ops3@example.com', ORG_A, 'agent');
    const foreign = await loginAs('rq-e@example.com', ORG_B);
    const agent = await loginAs('rq-ops3@example.com', ORG_A);
    await newTicket(foreign, { subject: '他組織の問い合わせ' });

    const result = await run(() =>
      tickets.list(agent, new URLSearchParams({ requester: foreignId })),
    );
    expect(result.body.items).toHaveLength(0);
  });

  it('UUID以外は 400(黙って無視しない)', async () => {
    await createUser('rq-ops4@example.com', ORG_A, 'agent');
    const agent = await loginAs('rq-ops4@example.com', ORG_A);
    await expect(
      run(() => tickets.list(agent, new URLSearchParams({ requester: 'someone' }))),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('絞り込んだ条件が応答に含まれる', async () => {
    const reqId = await createUser('rq-f@example.com', ORG_A, 'requester');
    await createUser('rq-ops5@example.com', ORG_A, 'agent');
    const agent = await loginAs('rq-ops5@example.com', ORG_A);

    const result = await run(() =>
      tickets.list(agent, new URLSearchParams({ requester: reqId, createdFrom: '2026-01-01' })),
    );
    expect(result.body.appliedFilter).toMatchObject({ requesterId: reqId });
    expect(result.body.appliedFilter.createdFrom).toBeDefined();
  });
});
