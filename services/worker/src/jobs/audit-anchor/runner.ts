import type pg from 'pg';
import { recordAuditAnchor, type Logger } from '@solvi/shared';
import { computeDailyRoot, persistAnchor, verifyAnchor } from './anchor.js';
import { uploadAnchorDocument, verifyExternalAnchor } from './external.js';
import type { ObjectStorage } from '@solvi/shared';

/**
 * 日次アンカーの実行 (ADR-0009 / WP-P1-AUD-004)。
 *
 * `anchor.ts` は計算と保存と照合の関数を持っていたが、**どこからも呼ばれていなかった。**
 * 関数どうしは呼び合い、テストも通り、worker の main.ts はこのファイルを
 * 読み込んですらいなかった。改ざん検知は「実装済み」として扱われながら、
 * 一度も実行されていない状態だった。
 *
 * この欠陥の性質は「動かない」ではなく「**何も起きない**」である。
 * 監査アンカーは平時に何も出力しないため、動いていないことと
 * 正常であることが外から区別できない。
 * したがってこの実行器は、成功時にも必ず1行ログを出し、
 * メトリクスを出す。**沈黙を正常と読み替えられないようにする。**
 */

/** 何日分さかのぼって照合するか。全期間の再計算は重すぎる。 */
const VERIFY_WINDOW_DAYS = 3;

export interface AnchorRunSummary {
  anchored: string | null;
  eventCount: number;
  verified: number;
  mismatched: string[];
}

/** UTCの日付文字列。ローカルタイムゾーンで日付が変わると、日の境界がずれる。 */
function utcDate(offsetDays: number, now = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * 例外ポリシーが実在することを確かめる。
 *
 * **無ければアンカーは「0件の1日」を正常に記録してしまう。**
 * 起動時に確認し、無ければ実行しない。誤ったアンカーを1件でも保存すると、
 * 上書き禁止(ON CONFLICT DO NOTHING)のせいで後から直せない。
 */
export async function assertAnchorPolicyExists(client: pg.PoolClient | pg.Client): Promise<void> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'audit_event'
        AND policyname = 'audit_event_anchor_lookup'`,
  );
  if (rows[0]?.n !== '1') {
    throw new Error(
      'audit_event_anchor_lookup ポリシーがありません(migration 0014)。' +
        'このまま実行すると、全組織のイベントが0件に見え、空のアンカーが保存されます。',
    );
  }
}

/**
 * 前日分のアンカーを作り、直近数日分を照合する。
 *
 * 当日分は作らない。まだイベントが増える途中の日をアンカーすると、
 * 翌日には必ず不一致になる。**閉じた日だけを固定する。**
 */
export async function runDailyAnchor(
  pool: pg.Pool,
  logger: Logger,
  now = new Date(),
  /**
   * 外部保存 (WP-P1-AUD-019)。省略すると DB にだけ残る。
   *
   * **省略できるようにしてある。** ストレージが無い環境でも
   * アンカーそのものは作れるべきである — 作れないより、
   * 外に置けないほうがまだましである。
   */
  external?: { storage: ObjectStorage; bucket: string },
): Promise<AnchorRunSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.anchor', 'on', true)");
    await assertAnchorPolicyExists(client);

    const target = utcDate(-1, now);
    const result = await computeDailyRoot(client, target);

    // **先に外へ置く。** `audit_anchor` は行を入れたあと更新できない
    // (`audit_anchor_no_update`)ので、URI を持った状態で入れる必要がある。
    // 鍵は日付から決まるため、置く前から URI が分かる。
    //
    // 置けなかったときは URI なしで保存する。
    // **アンカーそのものを失うほうが重い** — 記録されない日は作り直せない。
    let externalUri: string | null = null;
    if (external) {
      try {
        externalUri = await uploadAnchorDocument(external.storage, external.bucket, result);
      } catch (error) {
        // **握り潰さない。** 外部保存が効いていないことは、
        // 改ざん検知が効いていないことである。
        logger.error('audit anchor upload failed', error, { message: target });
      }
    }

    const outcome = await persistAnchor(client, result, externalUri);

    const mismatched: string[] = [];
    let verified = 0;
    for (let back = 1; back <= VERIFY_WINDOW_DAYS; back += 1) {
      const day = utcDate(-back, now);
      const check = await verifyAnchor(client, day);
      if (check.status === 'no_anchor') continue;
      verified += 1;
      if (check.status === 'mismatch') mismatched.push(day);
    }

    await client.query('COMMIT');

    // **外部への書き込みはトランザクションの外で行う。**
    // 巻き戻せない操作をトランザクションに入れると、
    // 「外部にはあるが DB では無かったことになった」が起きる。
    let externalMismatch = false;
    if (external) {
      // **外部と DB を突き合わせる。これが改ざん検知の本体である。**
      // DB だけを書き換えた者は、ここで食い違いとして現れる。
      for (let back = 1; back <= VERIFY_WINDOW_DAYS; back += 1) {
        const day = utcDate(-back, now);
        const check = await verifyExternalAnchor(client, external.storage, day);
        if (check.status === 'mismatch') {
          externalMismatch = true;
          // **握り潰さない。** 外部と食い違うことは、
          // どちらかが書き換えられたということである。
          logger.error(
            'audit anchor external mismatch',
            new Error(`stored=${check.stored} external=${check.external}`),
            { message: day },
          );
          if (!mismatched.includes(day)) mismatched.push(day);
        }
      }
      if (externalUri) {
        logger.info('audit anchor externalized', { message: externalUri });
      }
    }

    recordAuditAnchor(mismatched.length > 0 || externalMismatch ? 'mismatch' : 'match');

    if (mismatched.length > 0) {
      // **これは事故である。** 保存済みのアンカーと現在のイベントが食い違うのは、
      // 監査イベントが事後に変更・削除・追加されたということでしかない。
      logger.error('audit anchor mismatch', undefined, {
        message:
          `${mismatched.join(', ')} のアンカーが一致しません。` +
          '監査イベントが事後に改変された可能性があります。08.10_Audit_Export の手順で調査してください',
      });
    } else {
      logger.info('audit anchor', {
        count: result.eventCount,
        message: `date=${target} ${outcome} verified=${verified} root=${result.rootHash.slice(0, 12)}`,
      });
    }

    return { anchored: target, eventCount: result.eventCount, verified, mismatched };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
