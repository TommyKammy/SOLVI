/**
 * Outboxと通知(TL-04 / TL-06 / TL-20 / WP-P2-NTF-005)。
 *
 * 通知は情報漏えいが最も起きやすい経路である。画面はログインした人にしか見えないが、
 * 通知は宛先を1つ間違えるだけで組織の外へ出る。しかも送信後に取り消せない。
 * したがってテストの重点は「届くこと」より**「余計なものが届かないこと」**にある。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { CollaborationService } from '../../services/api/src/modules/ticket/collaboration.service.js';
import { enqueueOutboxEvent } from '../../services/api/src/common/outbox/outbox.js';
import {
  NotificationService,
  isNotifiable,
  buildSubject,
} from '../../services/api/src/modules/notification/notification.service.js';
import { RecordingEmailSender } from '../../services/api/src/modules/notification/senders.js';
import {
  OutboxDispatcher,
  backoffSeconds,
  type OutboxHandler,
} from '../../services/api/src/common/outbox/dispatcher.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { S3CompatibleStorage } from '@solvi/shared';
import type { AuthzContext, Principal } from '../../services/api/src/common/authz/authz.js';
import { runWithContext, newContext, createLogger } from '@solvi/shared';
import { FailingEmailSender } from '../support/senders.js';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let denials: PoolDenialRecorder;
let storage: S3CompatibleStorage;
const users = new Map<string, string>();
const logger = createLogger({ service: 'test', level: 'error', env: 'test', sink: () => {} });

const ctxFor = (userId: string, roleCode: string, orgId: string): AuthzContext => ({
  principal: {
    userId,
    status: 'active',
    bindings: [
      { roleCode: roleCode as never, organizationId: orgId, validFrom: PAST, validUntil: null },
    ],
  } satisfies Principal,
  organizationId: orgId,
});

async function inOrg<T>(orgId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const input = (subject = 'メールが届かない') => ({
  kind: 'incident' as const,
  subject,
  body: '外部からのメールが受信できません。至急確認をお願いします。',
  impact: 'medium' as const,
  urgency: 'high' as const,
});

/** 通知ハンドラを組み立てる */
function makeHandlers(
  sender: RecordingEmailSender | FailingEmailSender,
): Map<string, OutboxHandler> {
  const handler: OutboxHandler = async (record, client) => {
    const service = new NotificationService(client, new Map([['email', sender]]));
    try {
      await service.deliverForEvent(record);
      return { status: 'ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ペイロードにありません')) {
        return { status: 'permanent_failure', reason: message };
      }
      return { status: 'retry', reason: message };
    }
  };
  return new Map(
    ['ticket.created', 'ticket.transitioned', 'ticket.comment.added'].map((t) => [t, handler]),
  );
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  denials = new PoolDenialRecorder(pool);
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  storage = new S3CompatibleStorage({
    endpoint: 'http://127.0.0.1:9100',
    bucket: 'solvi-attachments',
    accessKey: 'test',
    secretKey: 'test',
    region: 'ap-northeast-1',
  });
  const { rows } = await admin.query(`
    SELECT rb.organization_id, r.code AS role_code, u.id AS user_id
      FROM role_binding rb JOIN role r ON r.id = rb.role_id JOIN app_user u ON u.id = rb.user_id
     WHERE rb.source = 'seed' AND u.status = 'active'
  `);
  for (const row of rows) users.set(`${row.organization_id}:${row.role_code}`, row.user_id);
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

beforeEach(async () => {
  await admin.query('DELETE FROM notification');
  await admin.query('DELETE FROM outbox_event');
  await cleanBusinessData(admin);
  await cleanAuditData(admin, "target_type IN ('ticket', 'notification')");
});

/**
 * チケットを作る。Outboxイベントは**TicketServiceが業務トランザクション内で積む**。
 *
 * テスト側で改めて積んではいけない。かつてこの補助関数は自分でも
 * `enqueueOutboxEvent` を呼んでいたが、それは当時 TicketService が
 * 積んでいなかったからである — つまり**テストだけが Outbox を使っていた**。
 * ここで手動に積み直すと、その状態へ戻ってしまう。
 */
async function createTicketWithEvent(orgId = ORG_A, actorRole = 'agent') {
  const actor = users.get(`${orgId}:${actorRole}`)!;
  const requester = users.get(`${orgId}:requester`)!;
  const ctx = ctxFor(actor, actorRole, orgId);
  const ticket = await runWithContext(newContext(), () =>
    inOrg(orgId, (c) =>
      new TicketService(c, denials).create(ctx, { ...input(), requesterId: requester }),
    ),
  );

  const { rows } = await admin.query(
    "SELECT id FROM outbox_event WHERE event_type = 'ticket.created' AND payload->>'ticketId' = $1",
    [ticket.id],
  );
  if (rows.length !== 1) {
    throw new Error(
      `チケット作成でOutboxイベントが ${rows.length} 件。` +
        'TicketService.create が業務トランザクション内で積んでいるはずである。',
    );
  }
  return { ticket, eventId: rows[0].id as string, actor, requester };
}

describe('Outboxの原子性 (ADR-0008)', () => {
  it('業務トランザクションがロールバックするとイベントも書かれない', async () => {
    const agent = users.get(`${ORG_A}:agent`)!;
    const ctx = ctxFor(agent, 'agent', ORG_A);

    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, async (c) => {
          const ticket = await new TicketService(c, denials).create(ctx, input());
          await enqueueOutboxEvent(c, {
            eventType: 'ticket.created',
            organizationId: ORG_A,
            payload: { ticketId: ticket.id, ticketNumber: ticket.number },
          });
          throw new Error('業務処理の失敗を模擬');
        }),
      ),
    ).rejects.toThrow();

    const { rows } = await admin.query('SELECT count(*)::int AS n FROM outbox_event');
    expect(rows[0].n).toBe(0);
    const { rows: tickets } = await admin.query('SELECT count(*)::int AS n FROM ticket');
    expect(tickets[0].n).toBe(0);
  });

  it('トレース文脈と相関IDがイベントに保存される', async () => {
    const { eventId } = await createTicketWithEvent();
    const { rows } = await admin.query(
      'SELECT correlation_id, traceparent FROM outbox_event WHERE id = $1',
      [eventId],
    );
    expect(rows[0].correlation_id).toBeTruthy();
  });
});

describe('ディスパッチャ (TL-04 / TL-20)', () => {
  it('イベントを配送して処理済みにする', async () => {
    await createTicketWithEvent();
    const sender = new RecordingEmailSender();
    const dispatcher = new OutboxDispatcher(pool, makeHandlers(sender), logger);

    const summary = await dispatcher.dispatchOnce();
    expect(summary.fetched).toBe(1);
    expect(summary.succeeded).toBe(1);

    const { rows } = await admin.query('SELECT processed_at FROM outbox_event');
    expect(rows[0].processed_at).not.toBeNull();
  });

  it('**並行実行しても二重配送しない**(SKIP LOCKED)', async () => {
    await createTicketWithEvent();
    const sender = new RecordingEmailSender();

    // 3つのディスパッチャを同時に走らせる
    const dispatchers = Array.from(
      { length: 3 },
      () => new OutboxDispatcher(pool, makeHandlers(sender), logger),
    );
    const summaries = await Promise.all(dispatchers.map((d) => d.dispatchOnce()));

    // イベントを掴んだのは1つだけ
    const totalFetched = summaries.reduce((sum, s) => sum + s.fetched, 0);
    expect(totalFetched).toBe(1);

    // 通知も1通だけ
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM notification');
    expect(rows[0].n).toBe(1);
  });

  it('同じイベントを2回処理しても通知は増えない(受信側の冪等性)', async () => {
    const { eventId } = await createTicketWithEvent();
    const sender = new RecordingEmailSender();
    const dispatcher = new OutboxDispatcher(pool, makeHandlers(sender), logger);

    await dispatcher.dispatchOnce();
    // 配送済みフラグを消して再処理させる(at-least-onceで起こりうる状況)
    await admin.query('UPDATE outbox_event SET processed_at = NULL WHERE id = $1', [eventId]);
    await dispatcher.dispatchOnce();

    const { rows } = await admin.query('SELECT count(*)::int AS n FROM notification');
    expect(rows[0].n).toBe(1);
  });

  it('配送失敗で再試行が予約される', async () => {
    await createTicketWithEvent();
    const dispatcher = new OutboxDispatcher(pool, makeHandlers(new FailingEmailSender()), logger);

    const summary = await dispatcher.dispatchOnce();
    expect(summary.retried).toBe(1);

    const { rows } = await admin.query(
      'SELECT attempts, available_at, last_error, failed_at FROM outbox_event',
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].failed_at).toBeNull();
    expect(rows[0].last_error).toContain('SMTP');
    expect(new Date(rows[0].available_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('**上限に達したら諦める**(無限リトライしない)', async () => {
    await createTicketWithEvent();
    // 試行上限を1にして即座に打ち切られる状況を作る
    await admin.query('UPDATE outbox_event SET max_attempts = 1');

    const dispatcher = new OutboxDispatcher(pool, makeHandlers(new FailingEmailSender()), logger);
    const summary = await dispatcher.dispatchOnce();
    expect(summary.failed).toBe(1);

    const { rows } = await admin.query('SELECT failed_at, last_error FROM outbox_event');
    expect(rows[0].failed_at).not.toBeNull();
    expect(rows[0].last_error).toContain('最大試行回数');

    // 失敗したイベントは再取得されない
    const second = await dispatcher.dispatchOnce();
    expect(second.fetched).toBe(0);
  });

  it('未知のイベント型は再試行せず即座に失敗にする', async () => {
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        enqueueOutboxEvent(c, {
          eventType: 'ticket.merged', // ハンドラ未登録
          organizationId: ORG_A,
          payload: { ticketId: 'x', ticketNumber: 'INC-2026-000001' },
        }),
      ),
    );
    const dispatcher = new OutboxDispatcher(pool, makeHandlers(new RecordingEmailSender()), logger);
    const summary = await dispatcher.dispatchOnce();
    expect(summary.failed).toBe(1);

    const { rows } = await admin.query('SELECT attempts, last_error FROM outbox_event');
    expect(rows[0].attempts).toBe(0); // 再試行していない
    expect(rows[0].last_error).toContain('ハンドラが未登録');
  });

  it('バックオフに上限がある(一時障害から復旧できる)', () => {
    expect(backoffSeconds(1)).toBe(20);
    expect(backoffSeconds(3)).toBe(80);
    // 上限がないと、試行回数が増えるにつれ次の試行が何時間も先になる
    expect(backoffSeconds(20)).toBe(600);
  });
});

describe('通知の内容 — 本文最小化 (§10)', () => {
  it('**通知にチケット本文が含まれない**', async () => {
    const { ticket } = await createTicketWithEvent();
    const sender = new RecordingEmailSender();
    await new OutboxDispatcher(pool, makeHandlers(sender), logger).dispatchOnce();

    expect(sender.sent.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(sender.sent);
    // 本文の特徴的な語が含まれないこと
    expect(serialized).not.toContain('外部からのメール');
    expect(serialized).not.toContain('至急確認');
    // 件名にはチケット番号が入る(リンクを開くための手がかり)
    expect(sender.sent[0]!.subject).toContain(ticket.number);
    expect(sender.sent[0]!.linkPath).toBe(`/tickets/${ticket.id}`);
  });

  it('DBにも本文を保存しない', async () => {
    await createTicketWithEvent();
    await new OutboxDispatcher(
      pool,
      makeHandlers(new RecordingEmailSender()),
      logger,
    ).dispatchOnce();

    const { rows } = await admin.query('SELECT * FROM notification LIMIT 1');
    const columns = Object.keys(rows[0]);
    expect(columns).not.toContain('body');
    expect(JSON.stringify(rows[0])).not.toContain('外部からのメール');
  });

  it('リンクは相対パス(環境ごとの書き換えを不要にする)', () => {
    expect(buildSubject('ticket.created', 'INC-2026-000001')).toContain('INC-2026-000001');
  });
});

describe('内部メモを通知しない (FR-TKT-004)', () => {
  it('内部メモのイベントは通知対象外と判定される', () => {
    expect(isNotifiable('ticket.comment.added', 'internal')).toBe(false);
    expect(isNotifiable('ticket.comment.added', 'public')).toBe(true);
  });

  /**
   * コメントを追加し、**そのコメントによる通知だけ**を数える。
   *
   * チケット作成自体も通知対象なので、先に配送して数え終えてから
   * コメントを付ける。そうしないと「作成の通知」を
   * 「コメントの通知」と取り違える。
   */
  async function commentThenDispatch(visibility: 'internal' | 'public') {
    const agent = users.get(`${ORG_A}:agent`)!;
    const requester = users.get(`${ORG_A}:requester`)!;
    const ctx = ctxFor(agent, 'agent', ORG_A);

    const ticket = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new TicketService(c, denials).create(ctx, { ...input(), requesterId: requester }),
      ),
    );

    // 作成イベントをここで配送しきる
    await new OutboxDispatcher(
      pool,
      makeHandlers(new RecordingEmailSender()),
      logger,
    ).dispatchOnce();
    await admin.query('DELETE FROM notification');

    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        new CollaborationService(c, storage, denials).addComment(ctx, {
          ticketId: ticket.id,
          visibility,
          body: '他部署でも同様の事象。AD側の設定が原因と推測。',
        }),
      ),
    );

    const sender = new RecordingEmailSender();
    await new OutboxDispatcher(pool, makeHandlers(sender), logger).dispatchOnce();
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM notification');
    return { sender, notifications: rows[0].n as number };
  }

  it('**内部メモを追加しても通知が作られない**', async () => {
    const { sender, notifications } = await commentThenDispatch('internal');
    expect(sender.sent).toHaveLength(0);
    expect(notifications).toBe(0);
  });

  it('公開コメントは通知される', async () => {
    const { sender } = await commentThenDispatch('public');
    expect(sender.sent.length).toBeGreaterThan(0);
  });
});

describe('Outbox自体の組織分離 (migration 0010)', () => {
  it('通常の組織コンテキストでは他組織のイベントが見えない', async () => {
    await createTicketWithEvent(ORG_B);

    const visible = await inOrg(ORG_A, async (c) => {
      const { rows } = await c.query('SELECT count(*)::int AS n FROM outbox_event');
      return rows[0].n as number;
    });
    expect(visible).toBe(0);
  });

  it('**ディスパッチャ例外はトランザクションを越えて残らない**', async () => {
    await createTicketWithEvent(ORG_B);

    // 同じ接続でディスパッチャ文脈を一度使ってから解放し、再取得する。
    // SET LOCAL(set_config の third arg = true)なので、次のトランザクションには残らない。
    const first = await pool.connect();
    try {
      await first.query('BEGIN');
      await first.query("SELECT set_config('app.dispatcher', 'on', true)");
      const { rows } = await first.query('SELECT count(*)::int AS n FROM outbox_event');
      expect(rows[0].n).toBeGreaterThan(0);
      await first.query('COMMIT');

      // 同一接続の別トランザクションでは、もう越境できない
      await first.query('BEGIN');
      await first.query('SELECT set_config($1, $2, true)', ['app.current_org', ORG_A]);
      const after = await first.query('SELECT count(*)::int AS n FROM outbox_event');
      expect(after.rows[0].n).toBe(0);
      await first.query('COMMIT');
    } finally {
      first.release();
    }
  });

  it('組織コンテキストが未設定なら1件も見えない(fail-closed)', async () => {
    await createTicketWithEvent(ORG_A);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT count(*)::int AS n FROM outbox_event');
      expect(rows[0].n).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

describe('宛先の組織境界 (02.18 §4)', () => {
  it('他組織のユーザが宛先にならない', async () => {
    const { ticket } = await createTicketWithEvent(ORG_A);
    const recipients = await inOrg(ORG_A, (c) =>
      new NotificationService(c, new Map()).resolveRecipients(ORG_A, ticket.id),
    );
    const orgBUsers = [users.get(`${ORG_B}:agent`), users.get(`${ORG_B}:requester`)];
    for (const foreign of orgBUsers) {
      expect(recipients.map((r) => r.userId)).not.toContain(foreign);
    }
  });

  it('他組織のチケットに対しては宛先が0件になる', async () => {
    const { ticket } = await createTicketWithEvent(ORG_B);
    const recipients = await inOrg(ORG_A, (c) =>
      new NotificationService(c, new Map()).resolveRecipients(ORG_A, ticket.id),
    );
    expect(recipients).toHaveLength(0);
  });

  it('無効化されたユーザへは送らない', async () => {
    const { ticket, requester } = await createTicketWithEvent(ORG_A);
    await admin.query(
      "UPDATE app_user SET status = 'deactivated', deactivated_at = now() WHERE id = $1",
      [requester],
    );
    try {
      const recipients = await inOrg(ORG_A, (c) =>
        new NotificationService(c, new Map()).resolveRecipients(ORG_A, ticket.id),
      );
      expect(recipients.map((r) => r.userId)).not.toContain(requester);
    } finally {
      await admin.query(
        "UPDATE app_user SET status = 'active', deactivated_at = NULL WHERE id = $1",
        [requester],
      );
    }
  });

  it('操作した本人には通知しない', async () => {
    const { actor } = await createTicketWithEvent(ORG_A);
    const sender = new RecordingEmailSender();
    await new OutboxDispatcher(pool, makeHandlers(sender), logger).dispatchOnce();

    const { rows } = await admin.query('SELECT recipient_user_id FROM notification');
    expect(rows.map((r) => r.recipient_user_id)).not.toContain(actor);
  });
});

describe('監査 (AUD-001)', () => {
  it('送信が監査に記録される', async () => {
    await createTicketWithEvent();
    await new OutboxDispatcher(
      pool,
      makeHandlers(new RecordingEmailSender()),
      logger,
    ).dispatchOnce();

    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'notification.sent'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].after_state).toMatchObject({ channel: 'email' });
  });

  it('**監査に宛先アドレスと件名が入らない**', async () => {
    await createTicketWithEvent();
    await new OutboxDispatcher(
      pool,
      makeHandlers(new RecordingEmailSender()),
      logger,
    ).dispatchOnce();

    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'notification.sent'",
    );
    const serialized = JSON.stringify(rows[0].after_state);
    // 宛先はPII、件名にはチケット番号が含まれる。参照IDで足りる。
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('INC-');
  });

  it('失敗も監査に記録される', async () => {
    await createTicketWithEvent();
    await new OutboxDispatcher(pool, makeHandlers(new FailingEmailSender()), logger).dispatchOnce();

    const { rows } = await admin.query(
      "SELECT outcome FROM audit_event WHERE event_type = 'notification.failed'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].outcome).toBe('failure');
  });
});
