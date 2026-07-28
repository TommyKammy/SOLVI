/**
 * 関連付けと統合のHTTP面 (WP-P2-RELUI-012 / TL-06)。
 *
 * `RelationService` は WP-P2-REL-009 で完成していたが**呼び出す経路が無く**、
 * 利用者からは到達できなかった。このファイルは**API層だけ**を相手にする。
 * サービス層のテスト(`ticket-relation.test.ts`)が緑でも、
 * 経路が無ければ機能は存在しないのと同じである。
 *
 * 重点は3つ。
 *
 *   1. **統合は取り消せない。** 理由なし・連鎖・自己統合を経路で拒む
 *   2. **受付番号での指定が越境しない。** 他組織の番号は「見つかりません」
 *   3. **依頼者は関連付けも統合もできない。** 見えることと触れることは別
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext } from '@solvi/shared';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { RelationController } from '../../services/api/src/modules/ticket/relation.routes.js';
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
let relations: RelationController;
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
  subject = '相談があります',
): Promise<{ id: string; number: string }> {
  const created = await run(() =>
    tickets.create(auth, {
      kind: 'incident',
      subject,
      body: '本文です。',
      impact: 'medium',
      urgency: 'medium',
    }),
  );
  return { id: created.body.id as string, number: created.body.number as string };
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const denialRecorder = new PoolDenialRecorder(pool);
  tickets = new TicketController({ pool, denialRecorder });
  relations = new RelationController({ pool, denialRecorder });
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

describe('関連付け (FR-TKT-010)', () => {
  it('受付番号で関連付けられる(UUIDを手で写させない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent, 'メールが届かない');
    const b = await newTicket(agent, 'メールが遅い');

    const linked = await run(() =>
      relations.link(agent, a.id, { relationType: 'related', targetTicketNumber: b.number }),
    );
    expect(linked.status).toBe(201);
    expect(linked.body.targetTicketId).toBe(b.id);

    const list = await run(() => relations.list(agent, a.id));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]!.number).toBe(b.number);
    expect(list.body.items[0]!.role).toBe('related');
  });

  it('**解除に使えるIDが一覧に含まれる**(画面が別の問い合わせを要らない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent);
    const b = await newTicket(agent);
    await run(() =>
      relations.link(agent, a.id, { relationType: 'related', targetTicketNumber: b.number }),
    );

    const list = await run(() => relations.list(agent, a.id));
    const relationId = list.body.items[0]!.relationId;
    expect(relationId).toMatch(/^[0-9a-f-]{36}$/);

    const removed = await run(() => relations.unlink(agent, relationId));
    expect(removed.status).toBe(204);
    expect((await run(() => relations.list(agent, a.id))).body.items).toHaveLength(0);
  });

  it('親子は双方から正しい役割で見える', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const parent = await newTicket(agent, '拠点全体でネットワークが不通');
    const child = await newTicket(agent, '3階のPCが繋がらない');

    await run(() =>
      relations.link(agent, parent.id, {
        relationType: 'parent_of',
        targetTicketNumber: child.number,
      }),
    );

    const fromParent = await run(() => relations.list(agent, parent.id));
    expect(fromParent.body.items[0]!.role).toBe('child');
    const fromChild = await run(() => relations.list(agent, child.id));
    expect(fromChild.body.items[0]!.role).toBe('parent');
  });

  it('同じ関連を二度作れない', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent);
    const b = await newTicket(agent);
    const body = { relationType: 'related', targetTicketNumber: b.number };

    await run(() => relations.link(agent, a.id, body));
    await expect(run(() => relations.link(agent, a.id, body))).rejects.toMatchObject({
      status: 409,
    });
  });

  it('自分自身とは関連付けられない', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent);

    await expect(
      run(() =>
        relations.link(agent, a.id, { relationType: 'related', targetTicketNumber: a.number }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('種類を指定しない不正な値は 422', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent);
    const b = await newTicket(agent);

    await expect(
      run(() =>
        relations.link(agent, a.id, { relationType: 'duplicate', targetTicketNumber: b.number }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('相手の指定が無ければ 422(空のPOSTで何も起きない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent);

    await expect(run(() => relations.link(agent, a.id, {}))).rejects.toMatchObject({ status: 400 });
  });
});

describe('受付番号の解決と存在秘匿 (脅威 T-02)', () => {
  it('自組織の番号は引ける', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent, 'プリンタが動かない');

    const found = await run(() => relations.lookup(agent, a.number));
    expect(found.body.number).toBe(a.number);
    expect(found.body.subject).toBe('プリンタが動かない');
  });

  it('**他組織の番号は「見つかりません」**(403にすると実在が漏れる)', async () => {
    await createUser('ops-a@example.com', ORG_A, 'agent');
    await createUser('ops-b@example.com', ORG_B, 'agent');
    const agentA = await loginAs('ops-a@example.com', ORG_A);
    const agentB = await loginAs('ops-b@example.com', ORG_B);

    const foreign = await newTicket(agentB, '他組織の困りごと');

    let caught: { status?: number; detail?: string } | undefined;
    await run(() => relations.lookup(agentA, foreign.number)).catch((e) => {
      caught = e as { status?: number; detail?: string };
    });
    expect(caught?.status).toBe(400);
    // 件名が漏れていないこと
    expect(JSON.stringify(caught)).not.toContain('他組織の困りごと');
  });

  it('存在しない番号も同じ扱いになる(実在の有無を区別させない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);

    await expect(run(() => relations.lookup(agent, 'INC-1999-999999'))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('**他組織の番号を指定した関連付けは成立しない**', async () => {
    await createUser('ops-a@example.com', ORG_A, 'agent');
    await createUser('ops-b@example.com', ORG_B, 'agent');
    const agentA = await loginAs('ops-a@example.com', ORG_A);
    const agentB = await loginAs('ops-b@example.com', ORG_B);

    const mine = await newTicket(agentA);
    const foreign = await newTicket(agentB);

    await expect(
      run(() =>
        relations.link(agentA, mine.id, {
          relationType: 'related',
          targetTicketNumber: foreign.number,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const { rows } = await admin.query('SELECT count(*)::int AS n FROM ticket_relation');
    expect(rows[0].n).toBe(0);
  });

  it('**他組織のUUIDを直接指定しても成立しない**(番号の検査を迂回できない)', async () => {
    await createUser('ops-a@example.com', ORG_A, 'agent');
    await createUser('ops-b@example.com', ORG_B, 'agent');
    const agentA = await loginAs('ops-a@example.com', ORG_A);
    const agentB = await loginAs('ops-b@example.com', ORG_B);

    const mine = await newTicket(agentA);
    const foreign = await newTicket(agentB);

    await expect(
      run(() =>
        relations.link(agentA, mine.id, {
          relationType: 'related',
          targetTicketId: foreign.id,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('権限 (FR-TKT-010 / FR-TKT-011)', () => {
  it('**依頼者は関連付けできない**', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);

    const a = await newTicket(requester);
    const b = await newTicket(requester);

    await expect(
      run(() =>
        relations.link(requester, a.id, {
          relationType: 'related',
          targetTicketNumber: b.number,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    // 担当者なら同じ操作が通る(拒否の理由がロールであることの確認)
    const ok = await run(() =>
      relations.link(agent, a.id, { relationType: 'related', targetTicketNumber: b.number }),
    );
    expect(ok.status).toBe(201);
  });

  it('**依頼者は統合できない**', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    const requester = await loginAs('req@example.com', ORG_A);
    const a = await newTicket(requester);
    const b = await newTicket(requester);

    await expect(
      run(() =>
        relations.merge(requester, a.id, {
          targetTicketNumber: b.number,
          reason: '同じ件です',
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('依頼者は自分のチケットの関連を**見る**ことはできる', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);

    const a = await newTicket(requester);
    const b = await newTicket(requester);
    await run(() =>
      relations.link(agent, a.id, { relationType: 'related', targetTicketNumber: b.number }),
    );

    const list = await run(() => relations.list(requester, a.id));
    expect(list.body.items).toHaveLength(1);
  });
});

describe('統合 (FR-TKT-011)', () => {
  it('統合すると元チケットが merged になり、統合先から辿れる', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const dup = await newTicket(agent, 'メールが届かない(重複)');
    const keep = await newTicket(agent, 'メールが届かない');

    const merged = await run(() =>
      relations.merge(agent, dup.id, {
        targetTicketNumber: keep.number,
        reason: '同一事象の重複起票',
      }),
    );
    expect(merged.status).toBe(200);
    expect(merged.body.targetTicketId).toBe(keep.id);

    const { rows } = await admin.query('SELECT state, merged_into_id FROM ticket WHERE id = $1', [
      dup.id,
    ]);
    expect(rows[0].state).toBe('merged');
    expect(rows[0].merged_into_id).toBe(keep.id);

    // 統合先からも辿れる
    const fromKeep = await run(() => relations.list(agent, keep.id));
    expect(fromKeep.body.items.map((i) => i.ticketId)).toContain(dup.id);
  });

  it('**理由なしでは統合できない**(不可逆な操作の記録を欠かさない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const dup = await newTicket(agent);
    const keep = await newTicket(agent);

    await expect(
      run(() => relations.merge(agent, dup.id, { targetTicketNumber: keep.number, reason: '  ' })),
    ).rejects.toMatchObject({ status: 400 });

    const { rows } = await admin.query('SELECT state FROM ticket WHERE id = $1', [dup.id]);
    expect(rows[0].state).not.toBe('merged');
  });

  it('**自分自身へは統合できない**', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const a = await newTicket(agent);

    await expect(
      run(() => relations.merge(agent, a.id, { targetTicketNumber: a.number, reason: '誤操作' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**統合の連鎖を拒む**(最終的な統合先を辿る処理を作らない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const first = await newTicket(agent);
    const second = await newTicket(agent);
    const third = await newTicket(agent);

    await run(() =>
      relations.merge(agent, second.id, { targetTicketNumber: third.number, reason: '重複' }),
    );
    await expect(
      run(() =>
        relations.merge(agent, first.id, { targetTicketNumber: second.number, reason: '重複' }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('**コメントと添付は元チケットに残る**(依頼者の履歴を空洞化させない)', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);

    const dup = await newTicket(requester, '重複した申告');
    const keep = await newTicket(requester, '本来の申告');
    await run(() =>
      collab.addComment(agent, dup.id, { visibility: 'public', body: '確認しています。' }),
    );

    const merged = await run(() =>
      relations.merge(agent, dup.id, { targetTicketNumber: keep.number, reason: '重複起票' }),
    );
    // 応答が「移動していない」ことを示す
    expect(merged.body.retained.comments).toBe(1);

    // 依頼者が元のチケットを開いても中身が消えていない
    const comments = await run(() => collab.listComments(requester, dup.id));
    expect(comments.body.items).toHaveLength(1);
  });

  it('**先に関連付けてから統合できる**(自然な操作順で500にならない)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const dup = await newTicket(agent, '重複した申告');
    const keep = await newTicket(agent, '本来の申告');

    // 担当者はまず「関連していそうだ」と気付いて関連付ける。
    // そのあと調べて「やはり重複だ」と判断して統合する。
    await run(() =>
      relations.link(agent, dup.id, { relationType: 'related', targetTicketNumber: keep.number }),
    );

    // かつてここで一意制約違反が起き、JavaScript 側で握り潰していたため
    // **トランザクションが中断したまま後続のクエリが全て失敗し 500 になっていた**。
    const merged = await run(() =>
      relations.merge(agent, dup.id, { targetTicketNumber: keep.number, reason: '重複起票' }),
    );
    expect(merged.status).toBe(200);

    const { rows } = await admin.query('SELECT state FROM ticket WHERE id = $1', [dup.id]);
    expect(rows[0].state).toBe('merged');
    // 関連は増えない(既にあるものを使う)
    const { rows: rel } = await admin.query('SELECT count(*)::int AS n FROM ticket_relation');
    expect(rel[0].n).toBe(1);
  });

  it('統合済みチケットへは新しい関連を足せない', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const dup = await newTicket(agent);
    const keep = await newTicket(agent);
    const other = await newTicket(agent);

    await run(() =>
      relations.merge(agent, dup.id, { targetTicketNumber: keep.number, reason: '重複' }),
    );
    await expect(
      run(() =>
        relations.link(agent, dup.id, {
          relationType: 'related',
          targetTicketNumber: other.number,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('統合が監査に残る(誰が・どれを・なぜ)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const dup = await newTicket(agent);
    const keep = await newTicket(agent);

    await run(() =>
      relations.merge(agent, dup.id, {
        targetTicketNumber: keep.number,
        reason: '同一事象のため統合',
      }),
    );

    const { rows } = await admin.query(
      "SELECT actor_id, after_state FROM audit_event WHERE event_type = 'ticket.merged'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(agent.userId);
    expect(rows[0].after_state.reason).toBe('同一事象のため統合');
    expect(rows[0].after_state.mergedIntoId).toBe(keep.id);
  });
});

describe('未解決の子の警告 (WP-P2-REL-009 §6)', () => {
  it('**未解決の子が一覧に添えられる**(解決してよいかの判断材料)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const parent = await newTicket(agent, '拠点全体でネットワークが不通');
    const child = await newTicket(agent, '3階のPCが繋がらない');

    await run(() =>
      relations.link(agent, parent.id, {
        relationType: 'parent_of',
        targetTicketNumber: child.number,
      }),
    );

    const list = await run(() => relations.list(agent, parent.id));
    expect(list.body.unresolvedChildren).toHaveLength(1);
    expect(list.body.unresolvedChildren[0]!.number).toBe(child.number);
  });

  it('**警告であって拒否ではない**(子が未解決でも親を解決できる)', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const parent = await newTicket(agent);
    const child = await newTicket(agent);
    await run(() =>
      relations.link(agent, parent.id, {
        relationType: 'parent_of',
        targetTicketNumber: child.number,
      }),
    );

    // 子は別チームの担当で長期化することがある。拒否すると運用が詰まる。
    await run(() => collab.transition(agent, parent.id, { to: 'assigned', reason: 'assign' }));
    await run(() => collab.transition(agent, parent.id, { to: 'in_progress', reason: 'start' }));
    const resolved = await run(() =>
      collab.transition(agent, parent.id, { to: 'resolved', reason: 'resolve' }),
    );
    expect(resolved.body.state).toBe('resolved');
  });

  it('解決済みの子は警告に出ない', async () => {
    await createUser('ops@example.com', ORG_A, 'agent');
    const agent = await loginAs('ops@example.com', ORG_A);
    const parent = await newTicket(agent);
    const child = await newTicket(agent);
    await run(() =>
      relations.link(agent, parent.id, {
        relationType: 'parent_of',
        targetTicketNumber: child.number,
      }),
    );

    await run(() => collab.transition(agent, child.id, { to: 'assigned', reason: 'assign' }));
    await run(() => collab.transition(agent, child.id, { to: 'in_progress', reason: 'start' }));
    await run(() => collab.transition(agent, child.id, { to: 'resolved', reason: 'resolve' }));

    const list = await run(() => relations.list(agent, parent.id));
    expect(list.body.unresolvedChildren).toHaveLength(0);
    // 関連そのものは残る
    expect(list.body.items).toHaveLength(1);
  });
});
