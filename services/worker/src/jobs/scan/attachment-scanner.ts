import type pg from 'pg';
import {
  ClamAvScanner,
  withSpan,
  recordAttachmentScan,
  type Logger,
  type ObjectStorage,
} from '@solvi/shared';

/**
 * 添付ファイルのウイルススキャン (WP-P2-SCAN-011 / OQ-011 / FR-TKT-005)。
 *
 * `scan_status` が `pending` の添付を拾い、ClamAV へ流して結果を書き戻す。
 *
 * **設計の中心は「clean を安売りしないこと」。**
 *
 * ダウンロードURLは `scan_status = 'clean'` でなければ発行されない
 * ([[WP-P2-COLLAB-004]])。したがってこのワーカーが誤って `clean` を書けば、
 * 検疫はその瞬間に無効になる。スキャナへ到達できない・応答が解釈できない・
 * サイズ上限を超える — いずれも `clean` にせず `pending` のまま残して再試行する。
 *
 * 滞留は「使いにくい」だけだが、誤った `clean` は**社内へのマルウェア配布経路**になる。
 * 天秤は明らかである。
 */

export interface ScanSummary {
  scanned: number;
  clean: number;
  infected: number;
  /** 判定できず pending のまま残した件数。滞留の監視対象。 */
  deferred: number;
}

export interface AttachmentScannerOptions {
  /** 1回で処理する件数。大きくすると1件の詰まりが後続を巻き込む。 */
  batchSize?: number;
  /** 再試行の上限。超えたものは人が見る必要がある。 */
  maxAttempts?: number;
  now?: () => Date;
}

interface PendingRow {
  id: string;
  organization_id: string;
  storage_key: string;
  file_name: string;
  size_bytes: string;
  scan_attempts: number;
}

export class AttachmentScanner {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly storage: ObjectStorage,
    private readonly scanner: ClamAvScanner,
    private readonly logger: Logger,
    options: AttachmentScannerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 5;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  async scanPending(): Promise<ScanSummary> {
    const summary: ScanSummary = { scanned: 0, clean: 0, infected: 0, deferred: 0 };
    const rows = await this.claim();
    summary.scanned = rows.length;

    for (const row of rows) {
      const outcome = await this.scanOne(row);
      summary[outcome] += 1;
      recordAttachmentScan(outcome);
    }
    return summary;
  }

  /**
   * 未スキャンの添付を取得する。
   *
   * 組織を横断するため、登録制の読み取り専用例外を使う
   * (migration 0012 / 02.18 §3.3)。**`app.dispatcher` は流用しない** —
   * 流用すると Outbox 用に許した越境が添付にも効くことになる。
   *
   * ここで読めるのはメタデータだけである。実体はオブジェクトストレージにあり、
   * 結果の書き戻しは対象組織のコンテキストで行う。
   *
   * **行ロック(`FOR UPDATE SKIP LOCKED`)は使わない。**
   * PostgreSQL はロック句を伴う SELECT に UPDATE ポリシーも要求するため、
   * SELECT限定の例外では通らない。ロックを通すには例外を UPDATE まで
   * 広げる必要があり、それは「読めるが書けない」という制限を捨てることになる。
   *
   * ロックが無いと、ワーカーを複数動かしたとき同じ添付を二重にスキャンしうる。
   * ただし**二重スキャンは無害である** — 同じ内容には同じ判定が出て、
   * 書き戻しも同じ値になる。通知の二重配送(利用者に2通届く)とは性質が違う。
   * 無駄な計算と引き換えに、越境の範囲を狭く保つほうを選ぶ。
   */
  private async claim(): Promise<PendingRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.scanner', 'on', true)");
      const { rows } = await client.query<PendingRow>(
        `SELECT id, organization_id, storage_key, file_name, size_bytes,
                COALESCE(scan_attempts, 0) AS scan_attempts
           FROM ticket_attachment
          WHERE scan_status = 'pending'
            AND COALESCE(scan_attempts, 0) < $2
          ORDER BY created_at
          LIMIT $1`,
        [this.batchSize, this.maxAttempts],
      );
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async scanOne(row: PendingRow): Promise<'clean' | 'infected' | 'deferred'> {
    return withSpan(
      'attachment.scan',
      { 'attachment.size_bytes': Number(row.size_bytes) },
      async () => {
        let content: Buffer;
        try {
          content = await this.storage.getObject(row.storage_key);
        } catch (error) {
          // 実体を読めない。アップロードが完了していない可能性がある。
          // **clean にはしない。**
          await this.recordAttempt(row, `実体を取得できません: ${describe(error)}`);
          return 'deferred';
        }

        const verdict = await this.scanner.scan(content);

        if (verdict.status === 'clean') {
          await this.recordResult(row, 'clean', null);
          return 'clean';
        }

        if (verdict.status === 'infected') {
          await this.recordResult(row, 'infected', verdict.signature);
          // **検体名はログに出すが、ファイル名は出さない。**
          // ファイル名には業務情報が含まれる(「2026年度_人事評価.xlsx」等)。
          this.logger.error('infected attachment detected', undefined, {
            errorMessage: verdict.signature,
          });
          return 'infected';
        }

        // 判定できなかった。pending のまま残して再試行する。
        await this.recordAttempt(row, verdict.reason);
        this.logger.warn('attachment scan deferred', { errorMessage: verdict.reason });
        return 'deferred';
      },
    );
  }

  private async recordResult(
    row: PendingRow,
    status: 'clean' | 'infected',
    signature: string | null,
  ): Promise<void> {
    await this.withOrg(row.organization_id, async (client) => {
      await client.query(
        `UPDATE ticket_attachment
            SET scan_status = $2, scanned_at = $3, scan_signature = $4,
                scan_attempts = COALESCE(scan_attempts, 0) + 1, scan_last_error = NULL
          WHERE id = $1`,
        [row.id, status, this.now(), signature],
      );
    });
  }

  /** 判定できなかった場合。`scan_status` は `pending` のまま動かさない。 */
  private async recordAttempt(row: PendingRow, reason: string): Promise<void> {
    await this.withOrg(row.organization_id, async (client) => {
      await client.query(
        `UPDATE ticket_attachment
            SET scan_attempts = COALESCE(scan_attempts, 0) + 1,
                scan_last_error = $2
          WHERE id = $1`,
        [row.id, reason.slice(0, 1000)],
      );
    });
  }

  private async withOrg(
    organizationId: string,
    fn: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', organizationId]);
      await fn(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
