/**
 * 添付の検疫 (WP-P2-SCAN-011 / FR-TKT-005 / OQ-011)。
 *
 * **実際のスキャナに対して実行する。** モックで「infected を返したら infected になる」
 * ことを確かめても、検疫が働く証拠にはならない。確かめたいのは
 * 「**本物のマルウェアを本物のスキャナが止めるか**」である。
 *
 * EICAR は、そのために業界で用意された無害な試験用ファイルである。
 * 実害なくスキャナの検出能力を実証できる。
 *
 * ClamAV が起動していない場合、このファイルは**スキップせずに失敗する**。
 * 「スキャナが無いから検証を飛ばす」を許すと、検疫の検証が
 * いつの間にか行われなくなる。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  ClamAvScanner,
  S3CompatibleStorage,
  createLogger,
  runWithContext,
  newContext,
} from '@solvi/shared';
import { AttachmentScanner } from '../../services/worker/src/jobs/scan/attachment-scanner.js';
import { uuidv7 } from '../../services/api/src/common/audit/audit.js';

/**
 * EICAR 標準試験文字列。
 * マルウェアではないが、すべてのウイルス対策製品が検出することになっている。
 * 分割して書いているのは、このソースファイル自体が検疫に引っかからないようにするため。
 */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(
  '',
);

const ORG_A = '00000000-0000-4000-9000-000000000001';
const CLAMAV_HOST = process.env.CLAMAV_HOST ?? '127.0.0.1';
const CLAMAV_PORT = Number(process.env.CLAMAV_PORT ?? 3310);
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9100';

let pool: pg.Pool;
let admin: pg.Client;
let storage: S3CompatibleStorage;
let scanner: AttachmentScanner;
/** このファイルが自前で用意するチケット。他ファイルの残存データに依存しない。 */
let fixtureTicketId: string;
let fixtureUserId: string;
const logger = createLogger({ service: 'test', level: 'error', env: 'test', sink: () => {} });

/** 添付行と実体を用意する。 */
async function putAttachment(content: Buffer, fileName: string): Promise<string> {
  const id = uuidv7();
  const storageKey = `attachments/test/${id}`;

  const signed = storage.presignPut(storageKey, 300, 'application/octet-stream');
  const uploaded = await fetch(signed.url, {
    method: 'PUT',
    body: new Uint8Array(content),
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!uploaded.ok) throw new Error(`アップロードに失敗しました: ${uploaded.status}`);

  await admin.query(
    `INSERT INTO ticket_attachment
       (id, organization_id, ticket_id, uploaded_by, file_name, content_type,
        size_bytes, storage_key, scan_status)
     VALUES ($1, $2, $3, $4, $5, 'application/octet-stream', $6, $7, 'pending')`,
    [id, ORG_A, fixtureTicketId, fixtureUserId, fileName, content.length, storageKey],
  );
  return id;
}

async function statusOf(id: string) {
  const { rows } = await admin.query(
    'SELECT scan_status, scan_signature, scan_attempts, scan_last_error FROM ticket_attachment WHERE id = $1',
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('DATABASE_URL と DATABASE_ADMIN_URL が必要です');

  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  storage = new S3CompatibleStorage({
    endpoint: S3_ENDPOINT,
    bucket: process.env.S3_BUCKET_ATTACHMENTS ?? 'solvi-attachments',
    accessKey: process.env.S3_ACCESS_KEY ?? 'solvi',
    secretKey: process.env.S3_SECRET_KEY ?? 'solvi-dev-secret',
    region: process.env.S3_REGION ?? 'ap-northeast-1',
  });

  const clam = new ClamAvScanner({ host: CLAMAV_HOST, port: CLAMAV_PORT });
  // **スキャナが無いときはスキップせずに失敗させる。**
  // 飛ばすと、検疫の検証がいつの間にか行われなくなる。
  const reachable = await clam.ping();
  if (!reachable) {
    throw new Error(
      `ClamAV へ接続できません (${CLAMAV_HOST}:${CLAMAV_PORT})。` +
        '`docker compose up -d clamav` を実行してから再試行してください。',
    );
  }

  scanner = new AttachmentScanner(pool, storage, clam, logger, { batchSize: 10 });
});

afterAll(async () => {
  await admin?.end();
  await pool?.end();
});

/**
 * テスト用のチケットを毎回作り直す。
 *
 * 他のテストファイルが `cleanBusinessData` で全チケットを消すため、
 * 「既にあるチケットを1件借りる」作りにすると、単体では通るのに
 * 全体実行では落ちる(実際に落ちた)。
 */
beforeEach(async () => {
  await admin.query('DELETE FROM ticket_attachment');
  await admin.query("DELETE FROM ticket WHERE subject = 'スキャンテスト用'");
  await admin.query("DELETE FROM app_user WHERE primary_email = 'scan-fixture@example.test'");

  fixtureUserId = uuidv7();
  await admin.query(
    `INSERT INTO app_user (id, primary_email, display_name, status, created_via)
     VALUES ($1, 'scan-fixture@example.test', 'scan fixture', 'active', 'admin')`,
    [fixtureUserId],
  );

  fixtureTicketId = uuidv7();
  await admin.query(
    `INSERT INTO ticket
       (id, organization_id, number, kind, state, subject, body,
        requester_id, impact, urgency, priority)
     VALUES ($1, $2, $3, 'incident', 'new', 'スキャンテスト用', '本文',
             $4, 'low', 'low', 'low')`,
    [fixtureTicketId, ORG_A, `SCAN-${Date.now()}`, fixtureUserId],
  );
});

describe('検出能力の実証 (OQ-011)', () => {
  it('**EICAR が infected として検疫される**', async () => {
    const id = await putAttachment(Buffer.from(EICAR), 'harmless-looking.txt');

    const summary = await runWithContext(newContext(), () => scanner.scanPending());
    expect(summary.infected).toBe(1);

    const row = await statusOf(id);
    expect(row.scan_status).toBe('infected');
    // 何が検出されたかを残す。「危険」だけでは対応が決まらない。
    expect(row.scan_signature).toContain('Eicar');
  });

  it('通常のファイルは clean になる', async () => {
    const id = await putAttachment(
      Buffer.from('これは普通のテキストファイルです。業務上の添付を想定しています。'),
      'normal.txt',
    );

    const summary = await runWithContext(newContext(), () => scanner.scanPending());
    expect(summary.clean).toBe(1);
    expect((await statusOf(id)).scan_status).toBe('clean');
  });

  it('**infected でなければ検体名が入らない**(DB制約)', async () => {
    await putAttachment(Buffer.from('普通の内容'), 'ok.txt');
    await runWithContext(newContext(), () => scanner.scanPending());

    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM ticket_attachment WHERE scan_status <> 'infected' AND scan_signature IS NOT NULL",
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('判定できない場合に clean を安売りしない', () => {
  it('**スキャナへ到達できないとき pending のまま残る**', async () => {
    const id = await putAttachment(Buffer.from('内容'), 'unreachable.txt');

    const broken = new AttachmentScanner(
      pool,
      storage,
      new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }),
      logger,
    );
    const summary = await runWithContext(newContext(), () => broken.scanPending());

    expect(summary.deferred).toBe(1);
    expect(summary.clean).toBe(0);

    const row = await statusOf(id);
    // **ここが最も重要。** スキャナが落ちている間のアップロードが
    // clean になってしまうと、検疫は無効になる。
    expect(row.scan_status).toBe('pending');
    expect(row.scan_attempts).toBe(1);
    expect(row.scan_last_error).toBeTruthy();
  });

  it('**実体が存在しないとき pending のまま残る**', async () => {
    const id = uuidv7();
    await admin.query(
      `INSERT INTO ticket_attachment
         (id, organization_id, ticket_id, uploaded_by, file_name, content_type,
          size_bytes, storage_key, scan_status)
       VALUES ($1, $2, $3, $4, 'ghost.txt', 'application/octet-stream', 10,
               'attachments/test/does-not-exist', 'pending')`,
      [id, ORG_A, fixtureTicketId, fixtureUserId],
    );

    const summary = await runWithContext(newContext(), () => scanner.scanPending());
    expect(summary.deferred).toBe(1);
    expect((await statusOf(id)).scan_status).toBe('pending');
  });

  it('**上限回数に達したものは自動で clean にならない**', async () => {
    const id = await putAttachment(Buffer.from('内容'), 'exhausted.txt');
    await admin.query('UPDATE ticket_attachment SET scan_attempts = 99 WHERE id = $1', [id]);

    // 上限超過のものは取得対象から外れる = 放置される。
    // 「諦めて clean にする」ではなく、人が見るまで配布しない。
    const limited = new AttachmentScanner(
      pool,
      storage,
      new ClamAvScanner({
        host: CLAMAV_HOST,
        port: CLAMAV_PORT,
      }),
      logger,
      { maxAttempts: 10 },
    );

    const summary = await runWithContext(newContext(), () => limited.scanPending());
    expect(summary.scanned).toBe(0);
    expect((await statusOf(id)).scan_status).toBe('pending');
  });

  it('**一度失敗しても、次に成功すれば前回の失敗は消える**', async () => {
    const id = await putAttachment(Buffer.from('内容'), 'retried.txt');

    // 1周目: スキャナへ到達できない
    const broken = new AttachmentScanner(
      pool,
      storage,
      new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }),
      logger,
    );
    await runWithContext(newContext(), () => broken.scanPending());
    const afterFailure = await statusOf(id);
    expect(afterFailure.scan_last_error).toBeTruthy();

    // 2周目: 成功する
    await runWithContext(newContext(), () => scanner.scanPending());
    const afterSuccess = await statusOf(id);

    expect(afterSuccess.scan_status).toBe('clean');
    // **前回の失敗理由を消す。** 残したままだと、いま健全な添付が
    // 「エラーを抱えている」ように見え、調べるべきものが埋もれる。
    //
    // 結果を書く経路が二か所にあったとき、片方(API側の写し)は
    // この列を知らないまま `scan_status` だけを書いていた。
    expect(afterSuccess.scan_last_error).toBeNull();
    // 試行回数は消さない。何周かかったかは運用上の情報である。
    expect(afterSuccess.scan_attempts).toBe(2);
  });
});

describe('再スキャンしない', () => {
  it('clean になった添付は次の周回で取得されない', async () => {
    await putAttachment(Buffer.from('内容'), 'once.txt');

    const first = await runWithContext(newContext(), () => scanner.scanPending());
    expect(first.scanned).toBe(1);

    const second = await runWithContext(newContext(), () => scanner.scanPending());
    expect(second.scanned).toBe(0);
  });
});
