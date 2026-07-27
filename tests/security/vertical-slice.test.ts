/**
 * 縦切りE2E: 申告 → 対応 → 解決 → 通知 → 監査 (Gate A GA-1)。
 *
 * 個々の機能は各WPのテストで確認済みである。ここで確かめるのは
 * **繋いだときに繋ぎ目から漏れないこと**。
 *
 * 部品単位のテストは、それぞれの担当者が「自分の側は正しい」と示すためのものである。
 * しかし事故は部品の中ではなく、部品と部品の間で起きる。
 * 内部メモの非公開判定はコメント機能の責務だが、通知はそれを知らずに
 * 本文を送ろうとするかもしれない。監査は書かれたつもりで欠けているかもしれない。
 *
 * このファイルは1つの業務フローを最初から最後まで通し、
 * **依頼者の目に触れる全ての出口**を検査する。
 *   1. 画面(API応答)
 *   2. 通知(送信内容とDB)
 *   3. 監査(記録内容)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext, createLogger } from '@solvi/shared';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { CollaborationService } from '../../services/api/src/modules/ticket/collaboration.service.js';
import { NotificationService } from '../../services/api/src/modules/notification/notification.service.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import {
  OutboxDispatcher,
  type OutboxHandler,
} from '../../services/worker/src/dispatcher/outbox-dispatcher.js';
import { enqueueOutboxEvent } from '../../services/api/src/common/outbox/outbox.js';
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
const PASSWORD = 'a-perfectly-fine-password';
const PAST = new Date('2026-01-01T00:00:00Z');

/** 内部メモに書く、依頼者に見せてはいけない内容。 */
const INTERNAL_NOTE =
  '田中さんは以前も同じ操作でミスしている。パスワード管理が甘い可能性あり。要注意。';

let pool: pg.Pool;
let admin: pg.Client;
let storage: S3CompatibleStorage;
let denials: PoolDenialRecorder;
const logger = createLogger({ service: 'test', level: 'error', env: 'test', sink: () => {} });

async function createUser(email: string, roleCode: string): Promise<string> {
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
    [uuidv7(), userId, rows[0].id, rows[0].scope, ORG_A, PAST],
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

/** 実際にログインして認可文脈を得る。テスト用に組み立てた文脈では繋ぎ目を検査できない。 */
async function loginAs(email: string): Promise<AuthenticatedRequest> {
  const client = await pool.connect();
  try {
    await beginAuthTransaction(client);
    const sessions = new SessionService(client);
    const auth = new LocalAuthService(client, sessions, {
      maxFailedAttempts: 5,
      lockoutSeconds: 900,
    });
    const result = await runWithContext(newContext(), () =>
      auth.authenticate({ email, password: PASSWORD, organizationId: ORG_A }),
    );
    if (!result.ok) throw new Error(`ログイン失敗: ${result.reason}`);
    const validation = await sessions.validate(result.token);
    await client.query('COMMIT');
    if (!validation.valid) throw new Error('セッション検証に失敗');
    return {
      authz: { principal: validation.principal, organizationId: ORG_A },
      sessionId: validation.session.id,
      userId: validation.session.userId,
    };
  } finally {
    client.release();
  }
}

/** 組織コンテキスト付きの実行。 */
async function inOrg<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', ORG_A]);
    const out = await runWithContext(newContext(), () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function makeHandlers(sender: RecordingEmailSender): Map<string, OutboxHandler> {
  const handler: OutboxHandler = async (record, client) => {
    const service = new NotificationService(client, new Map([['email', sender]]));
    try {
      await service.deliverForEvent(record);
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'retry',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
  return new Map(
    ['ticket.created', 'ticket.transitioned', 'ticket.assigned', 'ticket.comment.added'].map(
      (t) => [t, handler],
    ),
  );
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  denials = new PoolDenialRecorder(pool);
  storage = new S3CompatibleStorage({
    endpoint: 'http://127.0.0.1:9100',
    bucket: 'solvi-attachments',
    accessKey: 'test',
    secretKey: 'test',
    region: 'ap-northeast-1',
  });
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM notification');
  await admin.query('DELETE FROM outbox_event');
  await admin.query('DELETE FROM session');
  await admin.query('DELETE FROM local_credential');
  await admin.query('DELETE FROM identity WHERE issuer = $1', [LOCAL_ISSUER]);
  await cleanBusinessData(admin);
  await admin.query("DELETE FROM role_binding WHERE source = 'manual'");
  await admin.query("DELETE FROM app_user WHERE created_via = 'admin'");
  await cleanAuditData(admin, "target_type IN ('ticket', 'notification', 'session', 'app_user')");
});

describe('縦切り: 申告 → 対応 → 解決 → 通知 → 監査 (GA-1)', () => {
  it('**1つの業務フローが最初から最後まで通り、内部メモがどの出口からも漏れない**', async () => {
    // ---------------------------------------------------------------------
    // 登場人物
    // ---------------------------------------------------------------------
    await createUser('tanaka@acme.example.test', 'requester');
    await createUser('ops@acme.example.test', 'agent');
    const requester = await loginAs('tanaka@acme.example.test');
    const agent = await loginAs('ops@acme.example.test');

    const controller = new TicketController({ pool, denialRecorder: denials });
    const sender = new RecordingEmailSender();

    // ---------------------------------------------------------------------
    // 1. 依頼者がPortalから申告する
    // ---------------------------------------------------------------------
    const created = await runWithContext(newContext(), () =>
      controller.create(requester, {
        kind: 'incident',
        subject: '経費精算システムにログインできない',
        body: '今朝からログイン画面でエラーが出ます。',
        impact: 'medium',
        urgency: 'high',
      }),
    );
    expect(created.status).toBe(201);
    const ticketId = created.body.id as string;
    const ticketNumber = created.body.number as string;

    // 起票イベントをOutboxへ(実運用ではサービス内で同一Txに積む)
    await inOrg((client) =>
      enqueueOutboxEvent(client, {
        eventType: 'ticket.created',
        organizationId: ORG_A,
        payload: { ticketId, ticketNumber, actorId: requester.userId },
      }),
    );

    // ---------------------------------------------------------------------
    // 2. 担当者が引き受け、対応を始める
    // ---------------------------------------------------------------------
    await inOrg(async (client) => {
      const service = new TicketService(client, denials);
      // assign() は担当者を設定するだけで状態は動かさない。
      // 状態遷移は明示的に呼ぶ(担当を替えても状態が勝手に戻らないための設計)。
      await service.assign(agent.authz, ticketId, agent.userId);
      await service.transition(agent.authz, {
        ticketId,
        to: 'assigned',
        reason: 'assign',
      });
      await service.transition(agent.authz, {
        ticketId,
        to: 'in_progress',
        reason: 'start',
      });
    });

    // ---------------------------------------------------------------------
    // 3. 担当者が **内部メモ** を書く(依頼者には見せない)
    // ---------------------------------------------------------------------
    await inOrg(async (client) => {
      const collab = new CollaborationService(client, storage, denials);
      await collab.addComment(agent.authz, {
        ticketId,
        visibility: 'internal',
        body: INTERNAL_NOTE,
      });
    });

    // 内部メモのイベントもOutboxへ。通知側が visibility を見て弾くはず。
    await inOrg((client) =>
      enqueueOutboxEvent(client, {
        eventType: 'ticket.comment.added',
        organizationId: ORG_A,
        payload: { ticketId, ticketNumber, actorId: agent.userId, visibility: 'internal' },
      }),
    );

    // ---------------------------------------------------------------------
    // 4. 担当者が公開コメントを書く(依頼者に見せる)
    // ---------------------------------------------------------------------
    await inOrg(async (client) => {
      const collab = new CollaborationService(client, storage, denials);
      await collab.addComment(agent.authz, {
        ticketId,
        visibility: 'public',
        body: 'アカウントのロックを解除しました。お試しください。',
      });
    });
    await inOrg((client) =>
      enqueueOutboxEvent(client, {
        eventType: 'ticket.comment.added',
        organizationId: ORG_A,
        payload: { ticketId, ticketNumber, actorId: agent.userId, visibility: 'public' },
      }),
    );

    // ---------------------------------------------------------------------
    // 5. 解決する
    // ---------------------------------------------------------------------
    await inOrg(async (client) => {
      const service = new TicketService(client, denials);
      await service.transition(agent.authz, {
        ticketId,
        to: 'resolved',
        reason: 'resolve',
      });
    });
    await inOrg((client) =>
      enqueueOutboxEvent(client, {
        eventType: 'ticket.transitioned',
        organizationId: ORG_A,
        payload: { ticketId, ticketNumber, actorId: agent.userId },
      }),
    );

    // ---------------------------------------------------------------------
    // 6. 通知を配送する
    // ---------------------------------------------------------------------
    const dispatcher = new OutboxDispatcher(pool, makeHandlers(sender), logger);
    const summary = await dispatcher.dispatchOnce();
    expect(summary.fetched).toBe(4);
    expect(summary.failed).toBe(0);

    // =====================================================================
    // 出口1: 画面(API応答)
    // =====================================================================
    const view = await runWithContext(newContext(), () => controller.findById(requester, ticketId));
    expect(view.body.state).toBe('resolved');
    expect(JSON.stringify(view.body)).not.toContain('田中さん');
    expect(JSON.stringify(view.body)).not.toContain('パスワード管理が甘い');

    // 依頼者が読めるコメントに内部メモが含まれない
    const visible = await inOrg(async (client) => {
      const collab = new CollaborationService(client, storage, denials);
      return collab.listComments(requester.authz, ticketId);
    });
    const visibleText = JSON.stringify(visible);
    expect(visibleText).not.toContain('田中さん');
    expect(visibleText).not.toContain('要注意');
    expect(visible.some((c) => c.body.includes('ロックを解除'))).toBe(true);

    // 担当者には内部メモが見える(見えなくなっていたら業務が回らない)
    const forAgent = await inOrg(async (client) => {
      const collab = new CollaborationService(client, storage, denials);
      return collab.listComments(agent.authz, ticketId);
    });
    expect(JSON.stringify(forAgent)).toContain('要注意');

    // =====================================================================
    // 出口2: 通知
    // =====================================================================
    const sentText = JSON.stringify(sender.sent);

    // **内部メモの内容が1文字も出ていないこと**
    expect(sentText).not.toContain('田中さん');
    expect(sentText).not.toContain('要注意');
    expect(sentText).not.toContain('パスワード管理');

    // 公開コメントの本文も出ていないこと(件名とリンクだけを送る設計)
    expect(sentText).not.toContain('ロックを解除');
    expect(sentText).not.toContain('今朝からログイン画面');

    // 依頼者へは届いている(届かなければ業務が止まる)
    expect(sender.sent.some((m) => m.to === 'tanaka@acme.example.test')).toBe(true);

    // 内部メモは通知されない = 4イベント中1つは通知0件
    const { rows: notifications } = await admin.query(
      `SELECT n.subject, n.link_path, n.recipient_address::text AS recipient, e.event_type, e.payload
         FROM notification n JOIN outbox_event e ON e.id = n.outbox_event_id`,
    );
    const internalNotifications = notifications.filter(
      (n) => n.event_type === 'ticket.comment.added' && n.payload.visibility === 'internal',
    );
    expect(internalNotifications).toHaveLength(0);

    // DBの通知行にも本文が無い
    const notificationText = JSON.stringify(notifications);
    expect(notificationText).not.toContain('要注意');
    expect(notificationText).not.toContain('ロックを解除');

    // =====================================================================
    // 出口3: 監査
    // =====================================================================
    const { rows: audit } = await admin.query(
      `SELECT event_type, actor_id, outcome, before_state, after_state
         FROM audit_event ORDER BY event_id`,
    );

    // 業務の各段階が記録されている
    const types = audit.map((a) => a.event_type);
    expect(types).toContain('ticket.created');
    expect(types).toContain('ticket.assigned');
    expect(types).toContain('ticket.transitioned');
    expect(types).toContain('notification.sent');

    // **監査にも内部メモの本文が入っていない**
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain('要注意');
    expect(auditText).not.toContain('パスワード管理');
    // 通知の監査に宛先アドレスが入っていない(PII)
    expect(auditText).not.toContain('tanaka@acme.example.test');

    // 誰が何をしたかは追える(監査の目的)
    const assigned = audit.find((a) => a.event_type === 'ticket.assigned');
    expect(assigned?.actor_id).toBe(agent.userId);
  });

  it('**依頼者は内部メモを書けない**(本人にも見えないコメントを生まない)', async () => {
    await createUser('req2@acme.example.test', 'requester');
    const requester = await loginAs('req2@acme.example.test');
    const controller = new TicketController({ pool, denialRecorder: denials });

    const created = await runWithContext(newContext(), () =>
      controller.create(requester, {
        kind: 'request',
        subject: 'アカウント作成のお願い',
        body: '新入社員の分をお願いします。',
        impact: 'low',
        urgency: 'low',
      }),
    );

    await expect(
      inOrg(async (client) => {
        const collab = new CollaborationService(client, storage, denials);
        return collab.addComment(requester.authz, {
          ticketId: created.body.id as string,
          visibility: 'internal',
          body: '内部メモを書こうとする',
        });
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('不正な状態遷移がAPIレベルで拒否される (GA-2)', async () => {
    await createUser('ops2@acme.example.test', 'agent');
    await createUser('req3@acme.example.test', 'requester');
    const agent = await loginAs('ops2@acme.example.test');
    const requester = await loginAs('req3@acme.example.test');
    const controller = new TicketController({ pool, denialRecorder: denials });

    const created = await runWithContext(newContext(), () =>
      controller.create(requester, {
        kind: 'incident',
        subject: '遷移テスト',
        body: '本文',
        impact: 'low',
        urgency: 'low',
      }),
    );
    const ticketId = created.body.id as string;

    // new から closed へ直接飛ばそうとする(遷移表に無い)。
    // 受付直後のチケットをいきなり完了にできると、対応していないものを
    // 「終わったこと」にできてしまう。
    await expect(
      inOrg(async (client) => {
        const service = new TicketService(client, denials);
        return service.transition(agent.authz, {
          ticketId,
          to: 'closed',
          reason: 'close',
        });
      }),
    ).rejects.toMatchObject({ status: 422 });

    // 状態が変わっていないこと。拒否したのに状態だけ動いていたら最悪である。
    const after = await runWithContext(newContext(), () =>
      controller.findById(requester, ticketId),
    );
    expect(after.body.state).toBe('new');
  });
});
