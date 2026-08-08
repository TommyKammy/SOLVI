import type pg from 'pg';
import type { ObjectStorage } from '@solvi/shared';

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
 * ## 列はあったが、埋める書き込みを schema 自身が禁じていた
 *
 * `audit_anchor.external_uri` は 0003 からある。しかし
 * `audit_anchor_no_update` が**あらゆる UPDATE を拒む**。
 * 行を入れたあとで URI を書き足すことはできない。
 *
 * 誰も書いていなかったので、この矛盾は表に出なかった。
 *
 * **順序を変えて解いた。** 先に外へ置き、URI を持った状態で行を入れる。
 * 鍵は日付から決まる(`anchors/<date>.json`)ので、置く前から分かる。
 * **不変性を緩めない。**
 *
 * ## 後から埋めない
 *
 * 既にある行(URI が null)へ外部の写しを作ることはしない。
 * **DB の値から作った写しは、DB が偽られていたらその偽りを写すだけ**である。
 * 同時に書いたものでなければ、突き合わせる意味が無い。
 *
 * ## ローカルでは改ざん防止になっていない
 *
 * 本番では Object Lock(WORM)を有効にしたバケットへ置く前提である。
 * ローカルの MinIO では有効化していない(`tools/ensure_buckets.mjs`)。
 * **ローカルでは「2か所に書く」だけであり、消せない保証は無い。**
 */

/** 外部へ置く内容。**これだけで照合できる形にする。** */
export interface ExternalAnchorDocument {
  anchorDate: string;
  eventCount: number;
  rootHash: string;
  firstEventId: string | null;
  lastEventId: string | null;
  algorithm: string;
  /** 置いた時刻。**アンカーの値ではない**ので照合には使わない。 */
  writtenAt: string;
}

export const ANCHOR_ALGORITHM = 'sha256-chain-v1';

/** 保存先の鍵。**日付から決まる** — 置く前から URI が分かる。 */
export function anchorObjectKey(anchorDate: string): string {
  return `anchors/${anchorDate}.json`;
}

export function anchorObjectUri(bucket: string, anchorDate: string): string {
  return `s3://${bucket}/${anchorObjectKey(anchorDate)}`;
}

/**
 * 外部へ置く。**行を入れる前に呼ぶ。**
 *
 * @returns 置いた先の URI
 */
export async function uploadAnchorDocument(
  storage: ObjectStorage,
  bucket: string,
  result: {
    anchorDate: string;
    eventCount: number;
    rootHash: string;
    firstEventId: string | null;
    lastEventId: string | null;
  },
): Promise<string> {
  const document: ExternalAnchorDocument = {
    anchorDate: result.anchorDate,
    eventCount: result.eventCount,
    rootHash: result.rootHash,
    firstEventId: result.firstEventId,
    lastEventId: result.lastEventId,
    algorithm: ANCHOR_ALGORITHM,
    writtenAt: new Date().toISOString(),
  };

  await storage.putObject(
    anchorObjectKey(result.anchorDate),
    Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'),
    'application/json',
  );

  return anchorObjectUri(bucket, result.anchorDate);
}

export type ExternalCheck =
  | { status: 'match'; rootHash: string }
  | { status: 'mismatch'; stored: string; external: string }
  | { status: 'no_anchor' }
  | { status: 'not_uploaded' };

/**
 * 外部のアンカーと DB のアンカーを突き合わせる。
 *
 * **これが改ざん検知の本体である。** DB だけを書き換えた者は、
 * ここで食い違いとして現れる。
 *
 * 鍵は日付から決まるので、`external_uri` の記録は補助にすぎない。
 * **実物を取りに行く。** 列だけを見て「置いてあるはず」と信じない。
 */
export async function verifyExternalAnchor(
  client: pg.PoolClient | pg.Client,
  storage: ObjectStorage,
  anchorDate: string,
): Promise<ExternalCheck> {
  const { rows } = await client.query(
    'SELECT root_hash FROM audit_anchor WHERE anchor_date = $1::date',
    [anchorDate],
  );
  if (rows.length === 0) return { status: 'no_anchor' };

  let external: ExternalAnchorDocument;
  try {
    const body = await storage.getObject(anchorObjectKey(anchorDate));
    external = JSON.parse(body.toString('utf8')) as ExternalAnchorDocument;
  } catch {
    // 置いていない(この変更より前に作られたアンカー)。
    // **「一致した」とは言わない。**
    return { status: 'not_uploaded' };
  }

  return external.rootHash === rows[0]!.root_hash
    ? { status: 'match', rootHash: external.rootHash }
    : { status: 'mismatch', stored: rows[0]!.root_hash as string, external: external.rootHash };
}
