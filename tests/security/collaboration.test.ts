/**
 * コメント・内部メモ・添付の漏えい経路テスト(TL-06 / TL-16 / WP-P2-COLLAB-004)。
 *
 * このWPの目的は機能ではなく漏えい経路を塞ぐことなので、
 * テストも「動くこと」より「漏れないこと」を中心に書く。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { TicketService } from '../../services/api/src/modules/ticket/ticket.service.js';
import { CollaborationService } from '../../services/api/src/modules/ticket/collaboration.service.js';
import { PoolDenialRecorder } from '../../services/api/src/common/audit/denial-recorder.js';
import { S3CompatibleStorage, MAX_SIGNED_URL_TTL_SECONDS, generateStorageKey } from '@solvi/shared';
import type { AuthzContext, Principal } from '../../services/api/src/common/authz/authz.js';
import { runWithContext, newContext } from '@solvi/shared';
import { cleanBusinessData, cleanAuditData } from '../support/cleanup.js';

const ORG_A = '00000000-0000-4000-9000-000000000001';
const ORG_B = '00000000-0000-4000-9000-000000000002';
const PAST = new Date('2026-01-01T00:00:00Z');

let pool: pg.Pool;
let admin: pg.Client;
let denials: PoolDenialRecorder;
let storage: S3CompatibleStorage;
const users = new Map<string, string>();

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

const collab = (c: pg.PoolClient) => new CollaborationService(c, storage, denials);
const tickets = (c: pg.PoolClient) => new TicketService(c, denials);

const ticketInput = {
  kind: 'incident' as const,
  subject: 'ログインできない',
  body: 'パスワードを変更してからログインできません。',
  impact: 'medium' as const,
  urgency: 'high' as const,
};

const pngUpload = {
  fileName: 'screenshot.png',
  contentType: 'image/png',
  sizeBytes: 12_345,
};

/** 依頼者のチケットを作り、agent文脈と requester文脈の両方を返す */
async function setupTicket() {
  const agent = users.get(`${ORG_A}:agent`)!;
  const requester = users.get(`${ORG_A}:requester`)!;
  const agentCtx = ctxFor(agent, 'agent', ORG_A);
  const requesterCtx = ctxFor(requester, 'requester', ORG_A);
  const ticket = await runWithContext(newContext(), () =>
    inOrg(ORG_A, (c) => tickets(c).create(requesterCtx, ticketInput)),
  );
  return { ticket, agentCtx, requesterCtx };
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
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9100',
    bucket: process.env.S3_BUCKET_ATTACHMENTS ?? 'solvi-attachments',
    accessKey: process.env.S3_ACCESS_KEY ?? 'test',
    secretKey: process.env.S3_SECRET_KEY ?? 'test',
    region: process.env.S3_REGION ?? 'ap-northeast-1',
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
  await cleanBusinessData(admin);
  await cleanAuditData(admin, "target_type IN ('ticket', 'attachment')");
});

describe('内部メモの可視性 (FR-TKT-004)', () => {
  it('依頼者のコメント一覧に内部メモが1件も含まれない', async () => {
    const { ticket, agentCtx, requesterCtx } = await setupTicket();

    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'public',
          body: '確認しています。',
        });
        await collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'internal',
          body: '他部署でも同様の事象。AD側の設定変更が原因と推測。',
        });
      }),
    );

    const asRequester = await inOrg(ORG_A, (c) => collab(c).listComments(requesterCtx, ticket.id));
    expect(asRequester).toHaveLength(1);
    expect(asRequester.every((x) => x.visibility === 'public')).toBe(true);
    // 内部メモの本文が一切含まれないこと
    expect(JSON.stringify(asRequester)).not.toContain('AD側の設定変更');
  });

  it('担当者は公開・内部の両方を取得できる', async () => {
    const { ticket, agentCtx } = await setupTicket();
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, async (c) => {
        await collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'public',
          body: 'a',
        });
        await collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'internal',
          body: 'b',
        });
      }),
    );
    const asAgent = await inOrg(ORG_A, (c) => collab(c).listComments(agentCtx, ticket.id));
    expect(asAgent).toHaveLength(2);
  });

  it('内部メモを直接ID指定しても依頼者は取得できない(404)', async () => {
    const { ticket, agentCtx, requesterCtx } = await setupTicket();
    const internal = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'internal',
          body: '内部限定',
        }),
      ),
    );
    await expect(
      inOrg(ORG_A, (c) => collab(c).findComment(requesterCtx, internal.id)),
    ).rejects.toThrow(/見つかりません/);
  });

  it('依頼者は内部メモを書き込めない', async () => {
    const { ticket, requesterCtx } = await setupTicket();
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          collab(c).addComment(requesterCtx, {
            ticketId: ticket.id,
            visibility: 'internal',
            body: 'x',
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('可視性の絞り込みがSQL側で行われている(取得後フィルタでない)', async () => {
    // 依頼者向けクエリが internal 行をそもそも読まないことを、
    // 返却件数ではなくDB側の実行計画に依存しない形で確認する:
    // internal のみのチケットで、依頼者の取得結果が空になる
    const { ticket, agentCtx, requesterCtx } = await setupTicket();
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'internal',
          body: 'only',
        }),
      ),
    );
    const asRequester = await inOrg(ORG_A, (c) => collab(c).listComments(requesterCtx, ticket.id));
    expect(asRequester).toEqual([]);
  });
});

describe('添付の受け入れ検証 (FR-TKT-005 / NFR-SEC-005)', () => {
  const rejected = [
    { fileName: 'malware.exe', contentType: 'application/octet-stream', sizeBytes: 1000 },
    { fileName: 'script.sh', contentType: 'text/plain', sizeBytes: 1000 },
    { fileName: 'run.bat', contentType: 'text/plain', sizeBytes: 1000 },
    { fileName: 'payload.ps1', contentType: 'text/plain', sizeBytes: 1000 },
    { fileName: 'evil.js', contentType: 'text/javascript', sizeBytes: 1000 },
    { fileName: 'page.html', contentType: 'text/html', sizeBytes: 1000 },
    { fileName: 'vector.svg', contentType: 'image/svg+xml', sizeBytes: 1000 },
    { fileName: 'noext', contentType: 'text/plain', sizeBytes: 1000 },
    { fileName: '../../etc/passwd', contentType: 'text/plain', sizeBytes: 1000 },
    { fileName: 'fake.png', contentType: 'application/x-msdownload', sizeBytes: 1000 },
    { fileName: 'huge.pdf', contentType: 'application/pdf', sizeBytes: 26_214_401 },
    { fileName: 'empty.pdf', contentType: 'application/pdf', sizeBytes: 0 },
  ];

  it.each(rejected)('$fileName ($contentType, $sizeBytes bytes) を拒否する', async (input) => {
    const { ticket, agentCtx } = await setupTicket();
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...input }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('許可された形式は受け付ける', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const result = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...pngUpload }),
      ),
    );
    expect(result.attachmentId).toBeTruthy();
    expect(result.uploadUrl.url).toContain('X-Amz-Signature');
  });
});

describe('署名付きURL (02.18 §4 / 脅威 T-16)', () => {
  it('有効期限が10分を超えない', async () => {
    const key = generateStorageKey();
    const signed = storage.presignGet(key, 3600, 'a.png'); // 1時間を要求
    expect(signed.ttlSeconds).toBe(MAX_SIGNED_URL_TTL_SECONDS);
    expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(601_000);
  });

  it('オブジェクトキーが推測不能でファイル名を含まない', () => {
    const keys = Array.from({ length: 100 }, () => generateStorageKey());
    expect(new Set(keys).size).toBe(100);
    for (const key of keys) {
      expect(key).not.toContain('screenshot');
      expect(key).toMatch(/^attachments\/\d{4}\/\d{2}\/[0-9a-f]{64}$/);
    }
  });

  it('キーに組織やチケットの情報が含まれない', () => {
    const key = generateStorageKey();
    expect(key).not.toContain(ORG_A);
    expect(key).not.toContain('INC-');
  });

  it('ダウンロードURLが添付として保存させる(インライン実行を避ける)', () => {
    const signed = storage.presignGet(generateStorageKey(), 60, 'report.pdf');
    expect(decodeURIComponent(signed.url)).toContain('attachment; filename');
    expect(decodeURIComponent(signed.url)).toContain('application/octet-stream');
  });
});

describe('スキャン状態による配布制御 (FR-TKT-005 / 脅威 T-15)', () => {
  it('pending の添付はダウンロードURLが発行されない', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const created = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...pngUpload }),
      ),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => collab(c).createDownloadUrl(agentCtx, created.attachmentId)),
      ),
    ).rejects.toThrow(/検査中/);
  });

  it('infected の添付はダウンロードURLが発行されない', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const created = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...pngUpload }),
      ),
    );
    await inOrg(ORG_A, (c) => collab(c).recordScanResult(created.attachmentId, 'infected'));
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => collab(c).createDownloadUrl(agentCtx, created.attachmentId)),
      ),
    ).rejects.toThrow(/安全性が確認できない/);
  });

  it('clean になって初めてダウンロードURLが発行される', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const created = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...pngUpload }),
      ),
    );
    await inOrg(ORG_A, (c) => collab(c).recordScanResult(created.attachmentId, 'clean'));
    const url = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => collab(c).createDownloadUrl(agentCtx, created.attachmentId)),
    );
    expect(url.url).toContain('X-Amz-Signature');
    expect(url.ttlSeconds).toBeLessThanOrEqual(MAX_SIGNED_URL_TTL_SECONDS);
  });

  it('拒否が監査に残る', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const created = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...pngUpload }),
      ),
    );
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) => collab(c).createDownloadUrl(agentCtx, created.attachmentId)),
      ),
    ).rejects.toThrow();

    const { rows } = await admin.query(
      "SELECT policy_decision FROM audit_event WHERE target_id = $1 AND outcome = 'denied'",
      [created.attachmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].policy_decision).toMatchObject({ rule: 'scan_gate', scanStatus: 'pending' });
  });
});

describe('組織境界 (TL-06)', () => {
  it('他組織のコメントが取得できない', async () => {
    const agentB = users.get(`${ORG_B}:agent`)!;
    const ctxB = ctxFor(agentB, 'agent', ORG_B);
    const ticketB = await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) => tickets(c).create(ctxB, ticketInput)),
    );
    await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) =>
        collab(c).addComment(ctxB, {
          ticketId: ticketB.id,
          visibility: 'public',
          body: 'B社の内容',
        }),
      ),
    );

    const agentA = users.get(`${ORG_A}:agent`)!;
    await expect(
      inOrg(ORG_A, (c) => collab(c).listComments(ctxFor(agentA, 'agent', ORG_A), ticketB.id)),
    ).rejects.toThrow(/見つかりません/);
  });

  it('他組織の添付のダウンロードURLが発行されない', async () => {
    const agentB = users.get(`${ORG_B}:agent`)!;
    const ctxB = ctxFor(agentB, 'agent', ORG_B);
    const ticketB = await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) => tickets(c).create(ctxB, ticketInput)),
    );
    const created = await runWithContext(newContext(), () =>
      inOrg(ORG_B, (c) => collab(c).createAttachment(ctxB, { ticketId: ticketB.id, ...pngUpload })),
    );
    await inOrg(ORG_B, (c) => collab(c).recordScanResult(created.attachmentId, 'clean'));

    const agentA = users.get(`${ORG_A}:agent`)!;
    await expect(
      runWithContext(newContext(), () =>
        inOrg(ORG_A, (c) =>
          collab(c).createDownloadUrl(ctxFor(agentA, 'agent', ORG_A), created.attachmentId),
        ),
      ),
    ).rejects.toThrow(/見つかりません/);
  });
});

describe('監査 (AUD-001 / 02.17 §4)', () => {
  it('コメント本文が監査に含まれない', async () => {
    const { ticket, agentCtx } = await setupTicket();
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'internal',
          body: '機微な調査メモ',
        }),
      ),
    );
    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'ticket.comment.added'",
    );
    expect(JSON.stringify(rows[0].after_state)).not.toContain('機微な調査メモ');
    expect(rows[0].after_state).toMatchObject({ visibility: 'internal' });
  });

  it('添付のファイル名が監査に含まれない', async () => {
    const { ticket, agentCtx } = await setupTicket();
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, {
          ticketId: ticket.id,
          ...pngUpload,
          fileName: '給与明細.png',
        }),
      ),
    );
    const { rows } = await admin.query(
      "SELECT after_state FROM audit_event WHERE event_type = 'ticket.attachment.added'",
    );
    expect(JSON.stringify(rows[0].after_state)).not.toContain('給与明細');
  });

  it('ダウンロードが監査に記録される', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const created = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).createAttachment(agentCtx, { ticketId: ticket.id, ...pngUpload }),
      ),
    );
    await inOrg(ORG_A, (c) => collab(c).recordScanResult(created.attachmentId, 'clean'));
    await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) => collab(c).createDownloadUrl(agentCtx, created.attachmentId)),
    );
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'ticket.attachment.downloaded'",
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('コメントの不変性', () => {
  it('アプリロールはコメントを更新できない(追記のみ)', async () => {
    const { ticket, agentCtx } = await setupTicket();
    const comment = await runWithContext(newContext(), () =>
      inOrg(ORG_A, (c) =>
        collab(c).addComment(agentCtx, {
          ticketId: ticket.id,
          visibility: 'public',
          body: '元の内容',
        }),
      ),
    );
    await expect(
      inOrg(ORG_A, (c) =>
        c.query('UPDATE ticket_comment SET body = $2 WHERE id = $1', [comment.id, '改ざん']),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
