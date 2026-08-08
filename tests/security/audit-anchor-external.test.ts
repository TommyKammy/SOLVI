/**
 * 監査アンカーの外部保存 (ADR-0009 / AUD-003 / WP-P1-AUD-019)。
 *
 * [[WP-P1-AUD-018]] で書き出しと照合を作ったとき、道具の末尾にこう書いた。
 *
 * > **DB の中だけで完結する照合は、DB を書ける者には破れる。**
 *
 * アンカーが DB にしか無ければ、改ざんする者はイベントを書き換えたうえで
 * アンカーも書き換えればよい。**外に置いて初めて、2か所を同時に偽る
 * 必要が生まれる。**
 *
 * `audit_anchor.external_uri` の列は最初からあったが、
 * `persistAnchor(client, result, null)` と、**常に null が渡されていた。**
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import type { ObjectStorage } from '@solvi/shared';
import {
  uploadAnchorDocument,
  verifyExternalAnchor,
  anchorObjectKey,
} from '../../services/worker/src/jobs/audit-anchor/external.js';

const BUCKET = 'test-anchors';
let admin: pg.Client;

/** 記憶の中のストレージ。**外部保存の意味を確かめるのに実体は要らない。** */
class InMemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  /** 書き込みを1度だけ失敗させる。再試行の検査に使う。 */
  failNextPut = false;

  presignGet(): never {
    throw new Error('未使用');
  }
  presignPut(): never {
    throw new Error('未使用');
  }
  async putObject(key: string, body: Buffer): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('書き込みに失敗しました');
    }
    this.objects.set(key, body);
  }
  async getObject(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`ありません: ${key}`);
    return found;
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/**
 * **`audit_anchor` は削除できない**(0003 の append-only トリガ)。
 * 検査ごとに使い捨ての日付を採る — 片付けられないものは、汚さない。
 */
let dateSeq = 0;
const uniqueDate = (): string => {
  dateSeq += 1;
  const base = new Date(Date.UTC(2100, 0, 1));
  base.setUTCDate(base.getUTCDate() + dateSeq + Math.floor(Math.random() * 100000));
  return base.toISOString().slice(0, 10);
};
let DATE_A = '';
let DATE_B = '';

async function makeAnchor(date: string, rootHash: string): Promise<void> {
  // **`audit_anchor` は更新も削除もできない**(0003 のトリガ)。
  // 検査は毎回まっさらな日付から始める前提で書く。
  await admin.query(
    `INSERT INTO audit_anchor (anchor_date, event_count, root_hash, algorithm)
     VALUES ($1::date, 3, $2, 'sha256-chain-v1')`,
    [date, rootHash],
  );
}

beforeAll(async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL が必要です');
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
});

beforeEach(() => {
  DATE_A = uniqueDate();
  DATE_B = uniqueDate();
});

describe('外部へ置く', () => {
  it('**行を入れる前に置ける**(鍵が日付から決まるので URI が先に分かる)', async () => {
    const storage = new InMemoryStorage();
    const uri = await uploadAnchorDocument(storage, BUCKET, {
      anchorDate: DATE_A,
      eventCount: 3,
      rootHash: 'a'.repeat(64),
      firstEventId: null,
      lastEventId: null,
    });

    expect(uri).toBe(`s3://${BUCKET}/${anchorObjectKey(DATE_A)}`);
    expect(storage.objects.has(anchorObjectKey(DATE_A))).toBe(true);
  });

  it('**中身だけで照合できる形になっている**', async () => {
    const storage = new InMemoryStorage();
    await uploadAnchorDocument(storage, BUCKET, {
      anchorDate: DATE_A,
      eventCount: 7,
      rootHash: 'b'.repeat(64),
      firstEventId: null,
      lastEventId: null,
    });

    const body = JSON.parse(storage.objects.get(anchorObjectKey(DATE_A))!.toString('utf8'));
    expect(body.anchorDate).toBe(DATE_A);
    expect(body.rootHash).toBe('b'.repeat(64));
    expect(body.eventCount).toBe(7);
    expect(body.algorithm).toBe('sha256-chain-v1');
  });

  it('**置けなければ例外にする**(黙って続けない)', async () => {
    const storage = new InMemoryStorage();
    storage.failNextPut = true;
    await expect(
      uploadAnchorDocument(storage, BUCKET, {
        anchorDate: DATE_A,
        eventCount: 1,
        rootHash: 'c'.repeat(64),
        firstEventId: null,
        lastEventId: null,
      }),
    ).rejects.toThrow();
  });
});

describe('外部と DB を突き合わせる — これが改ざん検知の本体', () => {
  it('一致すれば match', async () => {
    const storage = new InMemoryStorage();
    await uploadAnchorDocument(storage, BUCKET, {
      anchorDate: DATE_A,
      eventCount: 3,
      rootHash: '0'.repeat(64),
      firstEventId: null,
      lastEventId: null,
    });
    await makeAnchor(DATE_A, '0'.repeat(64));

    const check = await verifyExternalAnchor(admin, storage, DATE_A);
    expect(check.status).toBe('match');
  });

  it('**DB だけを書き換えると食い違いとして現れる**', async () => {
    const storage = new InMemoryStorage();
    await uploadAnchorDocument(storage, BUCKET, {
      anchorDate: DATE_A,
      eventCount: 3,
      rootHash: '1'.repeat(64),
      firstEventId: null,
      lastEventId: null,
    });
    // 改ざんを模す。外部には触れず、DB のルートだけを別の値で入れる。
    await makeAnchor(DATE_A, '9'.repeat(64));

    const check = await verifyExternalAnchor(admin, storage, DATE_A);
    expect(check.status).toBe('mismatch');
    if (check.status === 'mismatch') {
      expect(check.stored).toBe('9'.repeat(64));
      expect(check.external).toBe('1'.repeat(64));
    }
  });

  it('**外部に無ければ not_uploaded**(「一致した」とは言わない)', async () => {
    await makeAnchor(DATE_A, '2'.repeat(64));
    const check = await verifyExternalAnchor(admin, new InMemoryStorage(), DATE_A);
    expect(check.status).toBe('not_uploaded');
  });

  it('アンカーそのものが無ければ no_anchor', async () => {
    const check = await verifyExternalAnchor(admin, new InMemoryStorage(), DATE_B);
    expect(check.status).toBe('no_anchor');
  });

  it('**列だけを見て「置いてある」と信じない**(実物を取りに行く)', async () => {
    // `external_uri` が入っていても、実物が消えていれば not_uploaded。
    const storage = new InMemoryStorage();
    await uploadAnchorDocument(storage, BUCKET, {
      anchorDate: DATE_A,
      eventCount: 3,
      rootHash: '3'.repeat(64),
      firstEventId: null,
      lastEventId: null,
    });
    await admin.query(
      `INSERT INTO audit_anchor (anchor_date, event_count, root_hash, algorithm, external_uri)
       VALUES ($1::date, 3, $2, 'sha256-chain-v1', $3)`,
      [DATE_A, '3'.repeat(64), `s3://${BUCKET}/${anchorObjectKey(DATE_A)}`],
    );

    storage.objects.delete(anchorObjectKey(DATE_A));
    const check = await verifyExternalAnchor(admin, storage, DATE_A);
    expect(check.status).toBe('not_uploaded');
  });
});
