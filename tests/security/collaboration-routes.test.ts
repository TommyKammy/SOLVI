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
import { AutoCloseSweeper } from '../../services/api/src/common/close/auto-close.js';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { NoopDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { createLogger } from '@solvi/shared';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PASSWORD = 'a-perfectly-fine-password';
const PAST = new Date('2026-01-01T00:00:00Z');

const SECRET_NOTE = '本人の操作ミスの可能性が高い。過去にも同様の連絡あり。';

let pool: pg.Pool;
let admin: pg.Client;
let tickets: TicketController;
let collab: CollaborationController;
const silentLogger = createLogger({ service: 'test', level: 'error', env: 'test', sink: () => {} });

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

/**
 * 影響度・緊急度の見直し (WP-P2-PRIO-013 / FR-TKT-009)。
 *
 * **優先度は入力ではない。** 影響度×緊急度から導かれる値であり、
 * 直接書き換える経路を作らない。同じ入力から常に同じ優先度が出ることが
 * SLA計測と監査の前提である。
 */
describe('見立ての見直し (FR-TKT-009)', () => {
  it('影響度と緊急度を直すと**優先度が導き直される**', async () => {
    await createUser('req-a@example.com', ORG_A, 'requester');
    await createUser('ops-a@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-a@example.com', ORG_A);
    const agent = await loginAs('ops-a@example.com', ORG_A);

    // medium × medium → medium
    const ticketId = await newTicket(requester);
    const before = await run(() => collab.workspace(agent, ticketId));
    expect(before.body.ticket.priority).toBe('medium');

    // 調べたら全社に影響していた: high × high → critical
    const result = await run(() =>
      collab.reassess(agent, ticketId, {
        impact: 'high',
        urgency: 'high',
        reason: '3部署で同じ事象を確認',
      }),
    );
    expect(result.body.priority).toBe('critical');

    const after = await run(() => collab.workspace(agent, ticketId));
    expect(after.body.ticket.priority).toBe('critical');
    expect(after.body.priorityIsDerived).toBe(true);
  });

  it('**優先度そのものは受け取らない**(送っても無視される)', async () => {
    await createUser('req-b@example.com', ORG_A, 'requester');
    await createUser('ops-b@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-b@example.com', ORG_A);
    const agent = await loginAs('ops-b@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await run(() =>
      collab.reassess(agent, ticketId, {
        impact: 'low',
        urgency: 'low',
        reason: '本人の端末だけの事象',
        // 攻撃者(あるいは誤った画面)が優先度を名乗っても効かない
        priority: 'critical',
      }),
    );

    const after = await run(() => collab.workspace(agent, ticketId));
    expect(after.body.ticket.priority).toBe('low');
  });

  it('**理由なしでは見直せない**(SLAの期限が動く操作である)', async () => {
    await createUser('req-c@example.com', ORG_A, 'requester');
    await createUser('ops-c@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-c@example.com', ORG_A);
    const agent = await loginAs('ops-c@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await expect(
      run(() =>
        collab.reassess(agent, ticketId, { impact: 'high', urgency: 'high', reason: '  ' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('変更が無ければ拒否する(**黙って成功にしない**)', async () => {
    await createUser('req-d@example.com', ORG_A, 'requester');
    await createUser('ops-d@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-d@example.com', ORG_A);
    const agent = await loginAs('ops-d@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // 押したのに何も起きないと、利用者は操作が効いていないと考える。
    await expect(
      run(() =>
        collab.reassess(agent, ticketId, {
          impact: 'medium',
          urgency: 'medium',
          reason: '変えていない',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('**依頼者は見直せない**(見立ては担当側の判断)', async () => {
    await createUser('req-e@example.com', ORG_A, 'requester');
    const requester = await loginAs('req-e@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await expect(
      run(() =>
        collab.reassess(requester, ticketId, {
          impact: 'high',
          urgency: 'high',
          reason: '急いでいます',
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('**終わった案件は見直せない**(SLAの達成状況を後から書き換えない)', async () => {
    await createUser('req-f@example.com', ORG_A, 'requester');
    await createUser('ops-f@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-f@example.com', ORG_A);
    const agent = await loginAs('ops-f@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    for (const [to, reason] of [
      ['assigned', 'assign'],
      ['in_progress', 'start'],
      ['resolved', 'resolve'],
      ['closed', 'close'],
    ]) {
      await run(() => collab.transition(agent, ticketId, { to, reason }));
    }

    await expect(
      run(() =>
        collab.reassess(agent, ticketId, {
          impact: 'high',
          urgency: 'high',
          reason: '後から思い直した',
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('不正な値は 400(知らない水準を黙って受け付けない)', async () => {
    await createUser('req-g@example.com', ORG_A, 'requester');
    await createUser('ops-g@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-g@example.com', ORG_A);
    const agent = await loginAs('ops-g@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await expect(
      run(() =>
        collab.reassess(agent, ticketId, { impact: 'urgent', urgency: 'high', reason: '理由' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('前後の値と理由が監査に残る', async () => {
    await createUser('req-h@example.com', ORG_A, 'requester');
    await createUser('ops-h@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-h@example.com', ORG_A);
    const agent = await loginAs('ops-h@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    await run(() =>
      collab.reassess(agent, ticketId, {
        impact: 'high',
        urgency: 'low',
        reason: '回避策が見つかったため急ぎ具合を下げた',
      }),
    );

    const { rows } = await admin.query(
      "SELECT actor_id, before_state, after_state FROM audit_event WHERE event_type = 'ticket.reassessed'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(agent.userId);
    // **どこから**動いたかが無いと、判断の当否を後から読めない。
    expect(rows[0].before_state.priority).toBe('medium');
    expect(rows[0].after_state.priority).toBe('medium');
    expect(rows[0].after_state.impact).toBe('high');
    expect(rows[0].after_state.reason).toContain('回避策');
  });

  it('**他組織のチケットは見直せない**', async () => {
    await createUser('req-i@example.com', ORG_A, 'requester');
    await createUser('ops-i@example.com', ORG_B, 'agent');
    const requester = await loginAs('req-i@example.com', ORG_A);
    const foreignAgent = await loginAs('ops-i@example.com', ORG_B);
    const ticketId = await newTicket(requester);

    await expect(
      run(() =>
        collab.reassess(foreignAgent, ticketId, {
          impact: 'high',
          urgency: 'high',
          reason: '越境の試み',
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('優先度が変わったときだけ通知イベントを積む', async () => {
    await createUser('req-j@example.com', ORG_A, 'requester');
    await createUser('ops-j@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-j@example.com', ORG_A);
    const agent = await loginAs('ops-j@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // medium × medium → medium から high × low → medium(優先度は動かない)
    await run(() =>
      collab.reassess(agent, ticketId, { impact: 'high', urgency: 'low', reason: '影響のみ拡大' }),
    );
    let { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'ticket.reassessed'",
    );
    // 変わっていないものを知らせても「また来た」としか受け取られない。
    expect(rows[0].n).toBe(0);

    // high × high → critical(優先度が動く)
    await run(() =>
      collab.reassess(agent, ticketId, {
        impact: 'high',
        urgency: 'high',
        reason: '至急対応が必要',
      }),
    );
    ({ rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'ticket.reassessed'",
    ));
    expect(rows[0].n).toBe(1);
  });
});

/**
 * 自動クローズと Reopen (FR-TKT-012 / 03.3 状態機械 / WP-P2-CLOSE-014)。
 *
 * 要求は「Closed(Resolved後14日で自動)」であり、状態機械にも規則があった。
 * **実行する者だけが居なかった。** 解決済みチケットは永久に resolved のまま
 * 残っていた。さらにその遷移が担当者の選択肢として画面に出ていた。
 */
describe('自動クローズと再開 (FR-TKT-012)', () => {
  /** 解決済みにして、resolved_at を指定日数だけ過去へ動かす。 */
  async function resolvedDaysAgo(
    agent: AuthenticatedRequest,
    ticketId: string,
    days: number,
  ): Promise<void> {
    for (const [to, reason] of [
      ['assigned', 'assign'],
      ['in_progress', 'start'],
      ['resolved', 'resolve'],
    ]) {
      await run(() => collab.transition(agent, ticketId, { to, reason }));
    }
    await admin.query(
      `UPDATE ticket SET resolved_at = now() - ($2 || ' days')::interval WHERE id = $1`,
      [ticketId, String(days)],
    );
  }

  it('**auto_close が担当者の選択肢に出ない**(自動遷移は押すものではない)', async () => {
    await createUser('req-ac1@example.com', ORG_A, 'requester');
    await createUser('ops-ac1@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac1@example.com', ORG_A);
    const agent = await loginAs('ops-ac1@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 0);

    const ws = await run(() => collab.workspace(agent, ticketId));
    const reasons = ws.body.availableActions.map((a) => a.reason);
    // 除外しないと「完了にする」(close)と同じ意味のボタンが2つ並ぶ。
    expect(reasons).not.toContain('auto_close');
    expect(reasons).toContain('close');
  });

  it('**内部の状態名が画面へ出ない**(すべての選択肢に訳がある)', async () => {
    await createUser('req-ac2@example.com', ORG_A, 'requester');
    await createUser('ops-ac2@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac2@example.com', ORG_A);
    const agent = await loginAs('ops-ac2@example.com', ORG_A);
    const ticketId = await newTicket(requester);

    // すべての状態を辿り、どの選択肢にも「状態名 (理由)」の形が現れないこと。
    // 以前は reopen と auto_close が「in_progress にする」「closed にする」
    // という生の状態名で表示されていた。
    const states: Array<[string, string]> = [
      ['assigned', 'assign'],
      ['in_progress', 'start'],
      ['pending', 'wait_requester'],
      ['in_progress', 'resume'],
      ['resolved', 'resolve'],
    ];
    for (const [to, reason] of states) {
      const ws = await run(() => collab.workspace(agent, ticketId));
      for (const action of ws.body.availableActions) {
        expect(action.label).not.toMatch(/^[a-z_]+ \(/);
      }
      await run(() => collab.transition(agent, ticketId, { to, reason }));
    }
    const last = await run(() => collab.workspace(agent, ticketId));
    for (const action of last.body.availableActions) {
      expect(action.label).not.toMatch(/^[a-z_]+ \(/);
    }
  });

  it('**14日を過ぎた解決済みが自動で閉じる**', async () => {
    await createUser('req-ac3@example.com', ORG_A, 'requester');
    await createUser('ops-ac3@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac3@example.com', ORG_A);
    const agent = await loginAs('ops-ac3@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 15);

    const summary = await run(() => new AutoCloseSweeper(pool, silentLogger).sweepOnce());
    expect(summary.closed).toBeGreaterThanOrEqual(1);

    const { rows } = await admin.query('SELECT state, closed_at FROM ticket WHERE id = $1', [
      ticketId,
    ]);
    expect(rows[0].state).toBe('closed');
    expect(rows[0].closed_at).not.toBeNull();
  });

  it('**14日以内は閉じない**(Reopenの窓が開いている間は閉じない)', async () => {
    await createUser('req-ac4@example.com', ORG_A, 'requester');
    await createUser('ops-ac4@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac4@example.com', ORG_A);
    const agent = await loginAs('ops-ac4@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 13);

    const summary = await run(() => new AutoCloseSweeper(pool, silentLogger).sweepOnce());
    expect(summary.candidates).toBe(0);

    const { rows } = await admin.query('SELECT state FROM ticket WHERE id = $1', [ticketId]);
    expect(rows[0].state).toBe('resolved');
  });

  it('**自動クローズが system として監査に残る**(人の操作にしない)', async () => {
    await createUser('req-ac5@example.com', ORG_A, 'requester');
    await createUser('ops-ac5@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac5@example.com', ORG_A);
    const agent = await loginAs('ops-ac5@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 20);

    await run(() => new AutoCloseSweeper(pool, silentLogger).sweepOnce());

    const { rows } = await admin.query(
      `SELECT actor_type, actor_id, after_state FROM audit_event
        WHERE event_type = 'ticket.transitioned' AND action = 'auto_close' AND target_id = $1`,
      [ticketId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_type).toBe('system');
    // 記録を読む人が「誰が閉じたのか」を探して見つからない状態を作らない。
    expect(rows[0].actor_id).toBeNull();
    expect(rows[0].after_state.reason).toBe('auto_close');
  });

  it('抽出後に状態が動いていたら閉じない(**抽出時点の判断を信じない**)', async () => {
    await createUser('req-ac6@example.com', ORG_A, 'requester');
    await createUser('ops-ac6@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac6@example.com', ORG_A);
    const agent = await loginAs('ops-ac6@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 3);

    // 依頼者が期限内に再開した状態を作る(FR-TKT-012)。
    await run(() =>
      collab.transition(requester, ticketId, { to: 'in_progress', reason: 'reopen' }),
    );

    // 候補として拾われた**あとで**この状態になった、という場面を直接再現する。
    // 抽出と実行は別トランザクションであり、その隙間に人が触りうる。
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', ORG_A]);
      const service = new TicketService(client, new NoopDenialRecorder());
      const closed = await service.autoClose(ticketId);
      await client.query('COMMIT');
      // 状態機械へもう一度問うので、resolved でなければ何もしない。
      expect(closed).toBeNull();
    } finally {
      client.release();
    }

    const { rows } = await admin.query('SELECT state FROM ticket WHERE id = $1', [ticketId]);
    expect(rows[0].state).toBe('in_progress');
  });

  it('**依頼者が自分のチケットを再開できる**(FR-TKT-012)', async () => {
    await createUser('req-ac7@example.com', ORG_A, 'requester');
    await createUser('ops-ac7@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac7@example.com', ORG_A);
    const agent = await loginAs('ops-ac7@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 3);

    // これが無いと、依頼者は同じ件で新規に起票し直すしかなく履歴が分断される。
    const result = await run(() =>
      collab.transition(requester, ticketId, { to: 'in_progress', reason: 'reopen' }),
    );
    expect(result.body.state).toBe('in_progress');
  });

  it('**14日を過ぎた再開は拒否される**', async () => {
    await createUser('req-ac8@example.com', ORG_A, 'requester');
    await createUser('ops-ac8@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac8@example.com', ORG_A);
    const agent = await loginAs('ops-ac8@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 15);

    await expect(
      run(() => collab.transition(requester, ticketId, { to: 'in_progress', reason: 'reopen' })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('**他人のチケットは再開できない**', async () => {
    await createUser('req-ac9@example.com', ORG_A, 'requester');
    await createUser('other-ac9@example.com', ORG_A, 'requester');
    await createUser('ops-ac9@example.com', ORG_A, 'agent');
    const requester = await loginAs('req-ac9@example.com', ORG_A);
    const other = await loginAs('other-ac9@example.com', ORG_A);
    const agent = await loginAs('ops-ac9@example.com', ORG_A);
    const ticketId = await newTicket(requester);
    await resolvedDaysAgo(agent, ticketId, 3);

    await expect(
      run(() => collab.transition(other, ticketId, { to: 'in_progress', reason: 'reopen' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('**他組織のチケットは自動クローズの対象にならない**とは限らない — 越境しないことを確かめる', async () => {
    await createUser('req-acA@example.com', ORG_A, 'requester');
    await createUser('ops-acA@example.com', ORG_A, 'agent');
    await createUser('req-acB@example.com', ORG_B, 'requester');
    await createUser('ops-acB@example.com', ORG_B, 'agent');
    const reqA = await loginAs('req-acA@example.com', ORG_A);
    const opsA = await loginAs('ops-acA@example.com', ORG_A);
    const reqB = await loginAs('req-acB@example.com', ORG_B);
    const opsB = await loginAs('ops-acB@example.com', ORG_B);

    const idA = await newTicket(reqA);
    const idB = await newTicket(reqB);
    await resolvedDaysAgo(opsA, idA, 20);
    await resolvedDaysAgo(opsB, idB, 20);

    // 定期処理は**全組織を横断して**候補を拾う。それが要求である。
    // 確かめるのは「閉じる操作がその組織のコンテキストで行われること」。
    await run(() => new AutoCloseSweeper(pool, silentLogger).sweepOnce());

    const { rows } = await admin.query(
      'SELECT id, state FROM ticket WHERE id = ANY($1) ORDER BY id',
      [[idA, idB]],
    );
    expect(rows.every((r) => r.state === 'closed')).toBe(true);

    // 監査はそれぞれの組織スコープに残る
    const { rows: audits } = await admin.query(
      `SELECT organization_id FROM audit_event
        WHERE action = 'auto_close' AND target_id = ANY($1)`,
      [[idA, idB]],
    );
    expect(new Set(audits.map((a) => a.organization_id)).size).toBe(2);
  });
});
