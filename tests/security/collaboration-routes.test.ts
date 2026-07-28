/**
 * コメントと担当者操作のHTTP面 (WP-P2-OPSUI-010 / TL-06)。
 *
 * 画面は「実行できない操作をボタンとして出さない」作りにしているが、
 * **それは使いやすさのためであって安全のためではない。** APIは直接叩ける。
 * このファイルはAPI層だけを相手にし、画面の作りに一切依存しない。
 *
 * 最も重要なのは **内部メモが依頼者へ一切届かないこと**。
 * 本文だけでなく、件数や存在の痕跡も渡してはいけない。
 * 「内部メモがあること」が分かるだけで、依頼者は「何か隠されている」と感じる。
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

const SECRET_NOTE = '本人の操作ミスの可能性が高い。過去にも同様の連絡あり。';

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

async function newTicket(auth: AuthenticatedRequest, subject = '相談があります') {
  const created = await run(() =>
    tickets.create(auth, {
      kind: 'incident',
      subject,
      body: '本文です。',
      impact: 'medium',
      urgency: 'medium',
    }),
  );
  return created.body.id as string;
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const denialRecorder = new PoolDenialRecorder(pool);
  const storage = new S3CompatibleStorage({
    endpoint: 'http://127.0.0.1:9100',
    bucket: 'solvi-attachments',
    accessKey: 'test',
    secretKey: 'test',
    region: 'ap-northeast-1',
  });
  tickets = new TicketController({ pool, denialRecorder });
  collab = new CollaborationController({ pool, storage, denialRecorder });
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

describe('内部メモの非漏えい (FR-TKT-004)', () => {
  it('**依頼者の一覧に内部メモが1件も現れない**', async () => {
    await createUser('req@example.com', ORG_A, 'requester');
    await createUser('ops@example.com', ORG_A, 'agent');
    const requester = await loginAs('req@example.com', ORG_A);
    const agent = await loginAs('ops@example.com', ORG_A);

    const ticketId = await newTicket(requester);

    await run(() =>
      collab.addComment(agent, ticketId, { visibility: 'internal', body: SECRET_NOTE }),
    );
    await run(() =>
      collab.addComment(agent, ticketId, {
        visibility: 'public',
        body: '確認しております。少々お待ちください。',
      }),
    );

    const forRequester = await run(() => collab.listComments(requester, ticketId));

    // 本文が無いこと
    expect(JSON.stringify(forRequester.body)).not.toContain('操作ミス');
    expect(JSON.stringify(forRequester.body)).not.toContain('過去にも同様');

    // **件数にも現れないこと。** 「1件隠されている」と分かるだけで
    // 依頼者は不信を持つ。
    expect(forRequester.body.items).toHaveLength(1);
    expect(forRequester.body.items[0]!.visibility).toBe('public');
  });

  it('担当者には内部メモが見える(見えないと業務が回らない)', async () => {
    await createUser('req2@example.com', ORG_A, 'requester');
    await createUser('ops2@example.com', ORG_A, 'agent');
    const requester = await loginAs('req2@example.com', ORG_A);
    const agent = await loginAs('ops2@example.com', ORG_A);

    const ticketId = await newTicket(requester);
    await run(() =>
      collab.addComment(agent, ticketId, { visibility: 'internal', body: SECRET_NOTE }),
    );

    const forAgent = await run(() => collab.listComments(agent, ticketId));
    expect(forAgent.body.items).toHaveLength(1);
    expect(forAgent.body.items[0]!.visibility).toBe('internal');
  });

  it('**依頼者は内部メモを投稿できない**(本人にも見えない投稿を生まない)', async () => {
    await createUser('req3@example.com', ORG_A, 'requester');
    const requester = await loginAs('req3@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await expect(
      run(() =>
        collab.addComment(requester, ticketId, {
          visibility: 'internal',
          body: '内部メモのつもり',
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**workspace 応答にも依頼者向けには内部メモが入らない**', async () => {
    await createUser('req4@example.com', ORG_A, 'requester');
    await createUser('ops4@example.com', ORG_A, 'agent');
    const requester = await loginAs('req4@example.com', ORG_A);
    const agent = await loginAs('ops4@example.com', ORG_A);

    const ticketId = await newTicket(requester);
    await run(() =>
      collab.addComment(agent, ticketId, { visibility: 'internal', body: SECRET_NOTE }),
    );

    // 依頼者が workspace を直接叩いた場合(画面には出さないが、APIは叩ける)
    const workspace = await run(() => collab.workspace(requester, ticketId));
    expect(JSON.stringify(workspace.body.comments)).not.toContain('操作ミス');
    expect(workspace.body.comments).toHaveLength(0);
  });
});

describe('コメントの投稿', () => {
  it('依頼者が自分のチケットへ公開コメントを投稿できる', async () => {
    await createUser('req5@example.com', ORG_A, 'requester');
    const requester = await loginAs('req5@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    const posted = await run(() =>
      collab.addComment(requester, ticketId, {
        visibility: 'public',
        body: '追加の情報です。',
      }),
    );
    expect(posted.status).toBe(201);
    expect(posted.body.visibility).toBe('public');
  });

  it.each([
    ['本文が空', { visibility: 'public', body: '   ' }],
    ['公開範囲が不正', { visibility: 'secret', body: '本文' }],
  ])('%s なら 400', async (_label, body) => {
    await createUser('req6@example.com', ORG_A, 'requester');
    const requester = await loginAs('req6@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await expect(run(() => collab.addComment(requester, ticketId, body))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('**他人のチケットへは投稿できない**(404で存在も秘匿する)', async () => {
    await createUser('mine@example.com', ORG_A, 'requester');
    await createUser('yours@example.com', ORG_A, 'requester');
    const mine = await loginAs('mine@example.com', ORG_A);
    const yours = await loginAs('yours@example.com', ORG_A);

    const ticketId = await newTicket(yours);

    await expect(
      run(() => collab.addComment(mine, ticketId, { visibility: 'public', body: '横入り' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('**他組織のチケットへは投稿できない**', async () => {
    await createUser('a@example.com', ORG_A, 'agent');
    await createUser('b@example.com', ORG_B, 'agent');
    const inA = await loginAs('a@example.com', ORG_A);
    const inB = await loginAs('b@example.com', ORG_B);

    const ticketId = await newTicket(inB);

    await expect(
      run(() => collab.addComment(inA, ticketId, { visibility: 'public', body: '越境' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('担当者の操作', () => {
  it('引受・着手・解決が順に行える', async () => {
    await createUser('req7@example.com', ORG_A, 'requester');
    await createUser('ops7@example.com', ORG_A, 'agent');
    const requester = await loginAs('req7@example.com', ORG_A);
    const agent = await loginAs('ops7@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await run(() => collab.assign(agent, ticketId, { assigneeId: agent.userId }));
    expect(
      (await run(() => collab.transition(agent, ticketId, { to: 'assigned', reason: 'assign' })))
        .body.state,
    ).toBe('assigned');
    expect(
      (await run(() => collab.transition(agent, ticketId, { to: 'in_progress', reason: 'start' })))
        .body.state,
    ).toBe('in_progress');
    expect(
      (await run(() => collab.transition(agent, ticketId, { to: 'resolved', reason: 'resolve' })))
        .body.state,
    ).toBe('resolved');
  });

  it('**実行できる操作が状態から算出される**', async () => {
    await createUser('req8@example.com', ORG_A, 'requester');
    await createUser('ops8@example.com', ORG_A, 'agent');
    const requester = await loginAs('req8@example.com', ORG_A);
    const agent = await loginAs('ops8@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    const atNew = await run(() => collab.workspace(agent, ticketId));
    const newTargets = atNew.body.availableActions.map((a) => a.to);
    expect(newTargets).toContain('assigned');
    // new から直接 resolved へは行けない
    expect(newTargets).not.toContain('resolved');
    // 統合は関連付け画面の操作であり、ここには出さない
    expect(newTargets).not.toContain('merged');

    await run(() => collab.transition(agent, ticketId, { to: 'assigned', reason: 'assign' }));
    const atAssigned = await run(() => collab.workspace(agent, ticketId));
    expect(atAssigned.body.availableActions.map((a) => a.to)).toContain('in_progress');
  });

  it('操作に**行動としての表示名**が付く(状態名を出さない)', async () => {
    await createUser('req9@example.com', ORG_A, 'requester');
    await createUser('ops9@example.com', ORG_A, 'agent');
    const requester = await loginAs('req9@example.com', ORG_A);
    const agent = await loginAs('ops9@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    const workspace = await run(() => collab.workspace(agent, ticketId));
    const assign = workspace.body.availableActions.find((a) => a.to === 'assigned');
    expect(assign?.label).toBe('引き受ける');
  });

  it('**依頼者は状態を変えられない**(404で応答し、閲覧可否で挙動を変えない)', async () => {
    await createUser('req10@example.com', ORG_A, 'requester');
    const requester = await loginAs('req10@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // 404 を返すのは意図した設計である(ticket.service.ts の注記)。
    // 「操作は拒否するが存在は認める」形にすると、他人のチケットを
    // 総当たりしたときに 403 と 404 の差でIDの実在が分かってしまう。
    await expect(
      run(() => collab.transition(requester, ticketId, { to: 'assigned', reason: 'assign' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('依頼者は自分のチケットを取り消せる(唯一許された遷移)', async () => {
    await createUser('req10b@example.com', ORG_A, 'requester');
    const requester = await loginAs('req10b@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // 「やっぱり不要でした」を依頼者自身が行えないと、
    // 取り消しのためだけに担当者へ連絡することになる。
    const result = await run(() =>
      collab.transition(requester, ticketId, { to: 'cancelled', reason: 'cancel' }),
    );
    expect(result.body.state).toBe('cancelled');
  });

  it('**依頼者は担当を割り当てられない**(403。役割として持たない権限)', async () => {
    await createUser('req11@example.com', ORG_A, 'requester');
    const requester = await loginAs('req11@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // ここが 403 で、遷移が 404 なのは食い違いではない。
    //   403 = 「その役割にこの操作は存在しない」(どのチケットでも同じ。存在は漏れない)
    //   404 = 「このチケットはあなたのものではない」(存在を秘匿する必要がある)
    await expect(
      run(() => collab.assign(requester, ticketId, { assigneeId: requester.userId })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**画面が出さない遷移もAPIが拒否する**(表示を防御にしない)', async () => {
    await createUser('req12@example.com', ORG_A, 'requester');
    await createUser('ops12@example.com', ORG_A, 'agent');
    const requester = await loginAs('req12@example.com', ORG_A);
    const agent = await loginAs('ops12@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // availableActions に出ていない遷移を直接叩く
    await expect(
      run(() => collab.transition(agent, ticketId, { to: 'closed', reason: 'close' })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('担当を外せる(空文字は null として扱う)', async () => {
    await createUser('req13@example.com', ORG_A, 'requester');
    await createUser('ops13@example.com', ORG_A, 'agent');
    const requester = await loginAs('req13@example.com', ORG_A);
    const agent = await loginAs('ops13@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await run(() => collab.assign(agent, ticketId, { assigneeId: agent.userId }));
    const cleared = await run(() => collab.assign(agent, ticketId, { assigneeId: '' }));
    expect(cleared.body.assigneeId).toBeNull();
  });
});
