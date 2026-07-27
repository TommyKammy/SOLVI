import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * 監査ログの日次アンカー(ADR-0009 / 02.17 §3)。
 *
 * 目的は「改ざんを防ぐ」ではなく「改ざんを**検知できる**」こと。
 * DBの権限とトリガはアプリ経路を塞ぐが、DBAやインフラ管理者による直接操作までは止められない。
 * 当日分のイベントを連鎖ハッシュ化し、ルート値を改変不能な外部ストレージ(S3 Object Lock)へ
 * 書き出しておけば、事後の書き換え・削除は翌日以降の照合で必ず露見する。
 *
 * DB内で全行チェーンを持たない理由: 書き込みの直列化が必要になり、
 * 監査書き込みが業務トランザクションのボトルネックになる(リスク受容 RA-01)。
 */

export interface AnchorResult {
  anchorDate: string;
  eventCount: number;
  rootHash: string;
  firstEventId: string | null;
  lastEventId: string | null;
}

/**
 * 1件のイベントを決定的な文字列へ落とす。
 * JSONのキー順やタイムゾーン表記の揺れでハッシュが変わらないよう、DB側で正規化する。
 *
 * **この式を変更すると過去のアンカーと照合できなくなる。**
 * フィールドを追加・削除する場合は algorithm を新しい版(sha256-chain-v2 等)にし、
 * 切替日以降のアンカーだけ新方式で計算すること。
 */
const ROW_CANONICAL_SQL = `
  concat_ws('|',
    event_id::text,
    event_type,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(organization_id::text, ''),
    actor_type,
    coalesce(actor_id::text, ''),
    coalesce(subject_user_id::text, ''),
    coalesce(target_type, ''),
    coalesce(target_id, ''),
    action,
    outcome,
    coalesce(before_state::jsonb::text, ''),
    coalesce(after_state::jsonb::text, ''),
    coalesce(correlation_id, ''),
    coalesce(policy_decision::jsonb::text, '')
  )
`;

/**
 * 指定日の連鎖ハッシュを計算する。
 * h_0 = sha256(""), h_n = sha256(h_{n-1} || canonical(event_n))
 */
export async function computeDailyRoot(
  client: pg.PoolClient | pg.Client,
  anchorDate: string,
): Promise<AnchorResult> {
  const { rows } = await client.query<{ event_id: string; canonical: string }>(
    `SELECT event_id, ${ROW_CANONICAL_SQL} AS canonical
       FROM audit_event
      WHERE occurred_at >= $1::date
        AND occurred_at <  ($1::date + interval '1 day')
      ORDER BY event_id`,
    [anchorDate],
  );

  let chain = createHash('sha256').update('').digest('hex');
  for (const row of rows) {
    chain = createHash('sha256').update(chain).update(row.canonical).digest('hex');
  }

  return {
    anchorDate,
    eventCount: rows.length,
    rootHash: chain,
    firstEventId: rows[0]?.event_id ?? null,
    lastEventId: rows[rows.length - 1]?.event_id ?? null,
  };
}

/**
 * アンカーを保存する。既に保存済みの日付は上書きしない
 * (上書きできるなら、改ざん後に再計算して辻褄を合わせられてしまう)。
 */
export async function persistAnchor(
  client: pg.PoolClient | pg.Client,
  result: AnchorResult,
  externalUri: string | null,
): Promise<'created' | 'already_exists'> {
  const { rowCount } = await client.query(
    `INSERT INTO audit_anchor
       (anchor_date, event_count, first_event_id, last_event_id, root_hash, external_uri)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (anchor_date) DO NOTHING`,
    [
      result.anchorDate,
      result.eventCount,
      result.firstEventId,
      result.lastEventId,
      result.rootHash,
      externalUri,
    ],
  );
  return rowCount === 1 ? 'created' : 'already_exists';
}

export interface VerificationResult {
  anchorDate: string;
  status: 'match' | 'mismatch' | 'no_anchor';
  storedRootHash?: string;
  recomputedRootHash?: string;
  storedEventCount?: number;
  currentEventCount?: number;
}

/**
 * 保存済みアンカーと現在のイベントを再計算して照合する。
 * mismatch は「その日の監査イベントが事後に変更・削除・追加された」ことを意味する。
 * 運用手順は docs/planning/08_Runbooks/08.10_Audit_Export.md。
 */
export async function verifyAnchor(
  client: pg.PoolClient | pg.Client,
  anchorDate: string,
): Promise<VerificationResult> {
  const { rows } = await client.query<{ root_hash: string; event_count: string }>(
    'SELECT root_hash, event_count FROM audit_anchor WHERE anchor_date = $1',
    [anchorDate],
  );
  if (rows.length === 0) return { anchorDate, status: 'no_anchor' };

  const stored = rows[0]!;
  const recomputed = await computeDailyRoot(client, anchorDate);
  return {
    anchorDate,
    status: stored.root_hash === recomputed.rootHash ? 'match' : 'mismatch',
    storedRootHash: stored.root_hash,
    recomputedRootHash: recomputed.rootHash,
    storedEventCount: Number(stored.event_count),
    currentEventCount: recomputed.eventCount,
  };
}
