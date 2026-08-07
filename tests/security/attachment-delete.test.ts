/**
 * 添付の削除 (WP-P2-SCAN-011 追補 / FR-TKT-005)。
 *
 * 誤って他人の情報が写った画像を添付した場合、**取り消せなければ
 * 情報漏えいに対して打つ手が無い**。
 *
 * 設計の要点は「**実体は消すが、あったことは残す**」。
 *
 *   実体を残すと   → 削除したつもりで漏えいが続く
 *   記録ごと消すと → 誰が何を消したか追えず、証拠隠滅と区別できない
 *
 * したがって最も重要な検証は次の2つである。
 *   1. **実体が本当に消えている**(メタデータを隠しただけではない)
 *   2. **誰が・何を・なぜ消したかが監査に残る**
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runWithContext, newContext, S3CompatibleStorage } from '@solvi/shared';
import { hashPassword } from '../../packages/shared/src/auth/password.js';
import { TicketController } from '../../services/api/src/modules/ticket/ticket.routes.js';
import { CollaborationController } from '../../services/api/src/modules/ticket/collaboration.routes.js';
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
import { markScanned } from '../support/scan.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const PASSWORD = 'a-perfectly-fine-password';
const PAST = new Date('2026-01-01T00:00:00Z');
const SECRET_CONTENT = '他の方の給与が写っている画像の中身';

let pool: pg.Pool;
let admin: pg.Client;
let storage: S3CompatibleStorage;
let tickets: TicketController;
let collab: CollaborationController;

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

const run = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(newContext(), fn);

async function newTicket(auth: AuthenticatedRequest): Promise<string> {
  const created = await run(() =>
    tickets.create(auth, {
      kind: 'incident',
      subject: '添付削除のテスト',
      body: '本文',
      impact: 'low',
      urgency: 'low',
    }),
  );
  return created.body.id as string;
}

/** 添付を作り、実体もアップロードする。 */
async function attach(
  auth: AuthenticatedRequest,
  ticketId: string,
  fileName: string,
  content: string,
  visibility: 'public' | 'internal' = 'public',
): Promise<{ attachmentId: string; storageKey: string }> {
  const requested = await run(() =>
    collab.requestUpload(auth, ticketId, {
      fileName,
      contentType: 'text/plain',
      sizeBytes: Buffer.byteLength(content),
      visibility,
    }),
  );
  const attachmentId = requested.body.attachmentId as string;

  const put = await fetch(requested.body.uploadUrl as string, {
    method: 'PUT',
    body: content,
    headers: { 'content-type': 'text/plain' },
  });
  if (!put.ok) throw new Error(`アップロードに失敗: ${put.status}`);

  const { rows } = await admin.query('SELECT storage_key FROM ticket_attachment WHERE id = $1', [
    attachmentId,
  ]);
  return { attachmentId, storageKey: rows[0].storage_key as string };
}

/** 実体が存在するかを直接確かめる。 */
async function objectExists(storageKey: string): Promise<boolean> {
  try {
    await storage.getObject(storageKey);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  storage = new S3CompatibleStorage({
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9100',
    bucket: process.env.S3_BUCKET_ATTACHMENTS ?? 'solvi-attachments',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    region: process.env.S3_REGION ?? 'ap-northeast-1',
  });

  const denialRecorder = new PoolDenialRecorder(pool);
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
  await cleanAuditData(
    admin,
    "target_type IN ('ticket', 'ticket_attachment', 'session', 'app_user')",
  );
});

describe('実体を本当に消す', () => {
  it('**削除するとオブジェクトストレージから実体が消える**', async () => {
    await createUser('d1@example.com', 'requester');
    const user = await loginAs('d1@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId, storageKey } = await attach(
      user,
      ticketId,
      'mistake.txt',
      SECRET_CONTENT,
    );

    expect(await objectExists(storageKey)).toBe(true);

    await run(() =>
      collab.deleteAttachment(user, attachmentId, { reason: '他の方の情報が写っていた' }),
    );

    // **ここが本題。** メタデータを隠すだけでは、署名を作れる者には依然として読める。
    expect(await objectExists(storageKey)).toBe(false);
  });

  it('削除後は一覧に現れない', async () => {
    await createUser('d2@example.com', 'requester');
    const user = await loginAs('d2@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'gone.txt', '内容');

    await run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' }));

    const list = await run(() => collab.listAttachments(user, ticketId));
    expect(list.body.items).toHaveLength(0);
  });

  it('**削除後はダウンロードURLが出ない**', async () => {
    await createUser('d3@example.com', 'agent');
    const user = await loginAs('d3@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'gone.txt', '内容');

    // スキャン済みにしてダウンロード可能な状態にしてから削除する
    await markScanned(admin, attachmentId, 'clean');
    await run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' }));

    await expect(run(() => collab.createDownloadUrl(user, attachmentId))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('二重に削除しても壊れない(既に無いものを消せる)', async () => {
    await createUser('d4@example.com', 'requester');
    const user = await loginAs('d4@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'twice.txt', '内容');

    await run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' }));
    // 2回目は「見つからない」。実体の削除で落ちたりしない。
    await expect(
      run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('あったことは残す', () => {
  it('**誰が・何を・なぜ消したかが監査に残る**', async () => {
    const userId = await createUser('d5@example.com', 'requester');
    const user = await loginAs('d5@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, '給与明細_誤送.txt', SECRET_CONTENT);

    await run(() =>
      collab.deleteAttachment(user, attachmentId, { reason: '他の方の情報が写っていた' }),
    );

    const { rows } = await admin.query(
      "SELECT actor_id, before_state, after_state FROM audit_event WHERE event_type = 'ticket.attachment.deleted'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(userId);
    // ファイル名が残らないと「何が削除されたか」が分からず、監査にならない
    expect(rows[0].before_state.fileName).toBe('給与明細_誤送.txt');
    // 理由が残らないと「誤添付」と「証拠隠滅」を区別できない
    expect(rows[0].after_state.reason).toBe('他の方の情報が写っていた');
  });

  it('メタデータの行は残る(消えた記録ごと消さない)', async () => {
    await createUser('d6@example.com', 'requester');
    const user = await loginAs('d6@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'kept.txt', '内容');

    await run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' }));

    const { rows } = await admin.query(
      'SELECT file_name, deleted_at, deleted_by, deletion_reason FROM ticket_attachment WHERE id = $1',
      [attachmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].file_name).toBe('kept.txt');
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].deletion_reason).toBe('誤添付');
  });

  it('**「誰が」と「なぜ」の欠けた削除を作れない**(DB制約)', async () => {
    await createUser('d7@example.com', 'requester');
    const user = await loginAs('d7@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'x.txt', '内容');

    await expect(
      admin.query('UPDATE ticket_attachment SET deleted_at = now() WHERE id = $1', [attachmentId]),
    ).rejects.toThrow(/ticket_attachment_deletion_complete/);
  });

  it('理由が空なら 400', async () => {
    await createUser('d8@example.com', 'requester');
    const user = await loginAs('d8@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'x.txt', '内容');

    await expect(
      run(() => collab.deleteAttachment(user, attachmentId, { reason: '   ' })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('誰が消せるか', () => {
  it('自分が添付したものは消せる', async () => {
    await createUser('d9@example.com', 'requester');
    const user = await loginAs('d9@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'mine.txt', '内容');

    await expect(
      run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' })),
    ).resolves.toMatchObject({ status: 204 });
  });

  it('**依頼者は担当者の添付を消せない**(対応の記録を一方的に削れない)', async () => {
    await createUser('d10@example.com', 'requester');
    await createUser('ops10@example.com', 'agent');
    const requester = await loginAs('d10@example.com');
    const agent = await loginAs('ops10@example.com');

    const ticketId = await newTicket(requester);
    const { attachmentId } = await attach(agent, ticketId, 'agent-file.txt', '担当者の資料');

    await expect(
      run(() => collab.deleteAttachment(requester, attachmentId, { reason: '消したい' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('担当者は組織内の添付を消せる', async () => {
    await createUser('d11@example.com', 'requester');
    await createUser('ops11@example.com', 'agent');
    const requester = await loginAs('d11@example.com');
    const agent = await loginAs('ops11@example.com');

    const ticketId = await newTicket(requester);
    const { attachmentId } = await attach(requester, ticketId, 'leaked.txt', SECRET_CONTENT);

    // 依頼者が誤って添付したものを、担当者が気付いて消せる必要がある
    await expect(
      run(() =>
        collab.deleteAttachment(agent, attachmentId, { reason: '他の方の情報が写っていた' }),
      ),
    ).resolves.toMatchObject({ status: 204 });
  });

  it('**依頼者は内部添付を消せない**(存在も知らせない)', async () => {
    await createUser('d12@example.com', 'requester');
    await createUser('ops12@example.com', 'agent');
    const requester = await loginAs('d12@example.com');
    const agent = await loginAs('ops12@example.com');

    const ticketId = await newTicket(requester);
    const { attachmentId } = await attach(agent, ticketId, 'internal.txt', '内部資料', 'internal');

    // 403 ではなく 404。403 だと「そのIDの内部添付が存在する」と教えてしまう。
    await expect(
      run(() => collab.deleteAttachment(requester, attachmentId, { reason: 'x' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('**他人のチケットの添付は消せない**', async () => {
    await createUser('d13@example.com', 'requester');
    await createUser('d13b@example.com', 'requester');
    const mine = await loginAs('d13@example.com');
    const other = await loginAs('d13b@example.com');

    const ticketId = await newTicket(other);
    const { attachmentId } = await attach(other, ticketId, 'theirs.txt', '内容');

    await expect(
      run(() => collab.deleteAttachment(mine, attachmentId, { reason: 'x' })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('削除済みはスキャン対象から外れる', () => {
  it('実体が無いものを永久に再試行しない', async () => {
    await createUser('d14@example.com', 'requester');
    const user = await loginAs('d14@example.com');
    const ticketId = await newTicket(user);
    const { attachmentId } = await attach(user, ticketId, 'x.txt', '内容');

    await run(() => collab.deleteAttachment(user, attachmentId, { reason: '誤添付' }));

    // 削除済みは pending のままだが、スキャナの取得対象から外れる。
    // 外さないと、実体が無いため永久に deferred が積み上がる。
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM ticket_attachment WHERE scan_status = 'pending' AND deleted_at IS NULL AND id = $1",
      [attachmentId],
    );
    expect(rows[0].n).toBe(0);
  });
});
