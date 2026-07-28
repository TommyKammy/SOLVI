import type pg from 'pg';
import {
  withRestoredTraceContext,
  withSpan,
  recordOutboxLag,
  runWithContext,
  newContext,
  type Logger,
} from '@solvi/shared';

/**
 * Outboxディスパッチャ(ADR-0008 / WP-P2-NTF-005)。
 *
 * **配送は API プロセスで動かす。**
 *
 * 本来この役割は worker のものだが、配送には通知サービスと監査の書き込みが要り、
 * どちらも `services/api` にある。worker から import するとサービス間依存になり、
 * `packages/shared` へ移すと共有パッケージが `pg` に依存することになる —
 * どちらも `check_architecture.mjs` が禁じている。
 *
 * 永続化層を共有パッケージ化すれば worker へ移せるが、それは境界の変更であり
 * 後継ADRが要る(AGENTS.md §1.9)。**それまでは API で動かす。**
 * ADR-0001 のモジュラモノリスの方針とも矛盾しない。
 *
 * 複数のAPIプロセスが同時に動いても `FOR UPDATE SKIP LOCKED` で二重配送しない。
 *
 * 設計上の要点:
 *
 * 1. `FOR UPDATE SKIP LOCKED` で取得する。複数のワーカーが同時に動いても、
 *    同じイベントを2つのプロセスが掴まない。ロックではなくスキップにするのは、
 *    1件の処理が詰まっても他が進めるようにするため。
 *
 * 2. `locked_until` を併用する。プロセスが異常終了するとDBのロックは解けるが、
 *    「取得したまま消えた」イベントを検出する手段が必要になる。期限で再取得できるようにする。
 *
 * 3. **上限に達したら諦める。** 無限リトライは、壊れた1件が延々と資源を食い、
 *    正常なイベントの配送を遅らせる。失敗として記録し、運用が気付ける形にする。
 */

export interface OutboxRecord {
  id: string;
  organizationId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  traceparent: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

/** 配送の結果。呼び出し側がリトライの要否を決められるようにする。 */
export type HandlerResult =
  | { status: 'ok' }
  | { status: 'retry'; reason: string }
  /** 再試行しても成功しないことが明らかな場合(不正なペイロードなど) */
  | { status: 'permanent_failure'; reason: string };

export type OutboxHandler = (record: OutboxRecord, client: pg.PoolClient) => Promise<HandlerResult>;

export interface DispatcherOptions {
  batchSize?: number;
  /** 取得したイベントを保持する時間。処理がこれを超えると他のワーカーが再取得する。 */
  lockSeconds?: number;
  /** テスト用の時刻注入 */
  now?: () => Date;
}

export interface DispatchSummary {
  fetched: number;
  succeeded: number;
  retried: number;
  failed: number;
}

/**
 * 再試行間隔。指数バックオフに上限を設ける。
 * 上限がないと、試行回数が増えるにつれ次の試行が何時間も先になり、
 * 一時障害が回復しても復旧しない。
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts * 10, 600); // 10s, 20s, 40s, ... 最大10分
}

function toRecord(row: Record<string, unknown>): OutboxRecord {
  return {
    id: row.id as string,
    organizationId: (row.organization_id as string | null) ?? null,
    eventType: row.event_type as string,
    payload: (row.payload as Record<string, unknown>) ?? {},
    correlationId: (row.correlation_id as string | null) ?? null,
    traceparent: (row.traceparent as string | null) ?? null,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    createdAt: row.created_at as Date,
  };
}

export class OutboxDispatcher {
  private readonly batchSize: number;
  private readonly lockSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly handlers: Map<string, OutboxHandler>,
    private readonly logger: Logger,
    options: DispatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.lockSeconds = options.lockSeconds ?? 60;
    this.now = options.now ?? (() => new Date());
  }

  /** 1回分の取得と配送。定期実行から呼ぶ。 */
  async dispatchOnce(): Promise<DispatchSummary> {
    const summary: DispatchSummary = { fetched: 0, succeeded: 0, retried: 0, failed: 0 };
    const records = await this.claim();
    summary.fetched = records.length;

    for (const record of records) {
      const outcome = await this.process(record);
      summary[outcome] += 1;
    }
    return summary;
  }

  /**
   * 未処理イベントを取得してロックする。
   *
   * `SKIP LOCKED` により、他のワーカーが処理中の行は飛ばす。
   * ここを普通の `FOR UPDATE` にすると、先頭の1件が詰まった瞬間に全体が止まる。
   */
  private async claim(): Promise<OutboxRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 全org走査の背景ジョブとしてOutboxを読む(02.18 §3 例外2 / migration 0010)。
      // SET LOCAL なのでトランザクション外へ漏れない。
      await client.query("SELECT set_config('app.dispatcher', 'on', true)");
      const { rows } = await client.query(
        `SELECT * FROM outbox_event
          WHERE processed_at IS NULL
            AND failed_at IS NULL
            AND available_at <= $1
            AND (locked_until IS NULL OR locked_until < $1)
          ORDER BY available_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [this.now(), this.batchSize],
      );

      if (rows.length > 0) {
        const lockedUntil = new Date(this.now().getTime() + this.lockSeconds * 1000);
        await client.query('UPDATE outbox_event SET locked_until = $2 WHERE id = ANY($1)', [
          rows.map((r) => r.id),
          lockedUntil,
        ]);
      }
      await client.query('COMMIT');
      return rows.map(toRecord);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async process(record: OutboxRecord): Promise<'succeeded' | 'retried' | 'failed'> {
    const handler = this.handlers.get(record.eventType);

    if (!handler) {
      // 未知のイベント型は再試行しても処理できない。すぐ失敗にする。
      await this.markFailed(record, `ハンドラが未登録です: ${record.eventType}`);
      return 'failed';
    }

    // 配送遅延を記録する(NFR-PERF-003: p95 30秒)
    const lagSeconds = (this.now().getTime() - record.createdAt.getTime()) / 1000;
    recordOutboxLag(record.eventType, lagSeconds);

    // 発行元のトレース文脈を復元する。これがないと、
    // 発行から配送までが別々のトレースに分かれて追えなくなる。
    const carrier = record.traceparent ? { traceparent: record.traceparent } : null;
    const context = newContext(record.correlationId ? { correlationId: record.correlationId } : {});

    const result = await runWithContext(context, () =>
      withRestoredTraceContext(carrier, () =>
        withSpan(
          `outbox.dispatch ${record.eventType}`,
          { 'outbox.event_type': record.eventType, 'outbox.attempts': record.attempts },
          async (): Promise<HandlerResult> => {
            const client = await this.pool.connect();
            try {
              // 組織コンテキストを設定する。ハンドラがRLS配下のテーブルを読むため。
              await client.query('BEGIN');
              await client.query('SELECT set_config($1, $2, true)', [
                'app.current_org',
                record.organizationId ?? '',
              ]);
              const handlerResult = await handler(record, client);
              await client.query('COMMIT');
              return handlerResult;
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined);
              return {
                status: 'retry',
                reason: error instanceof Error ? error.message : String(error),
              };
            } finally {
              client.release();
            }
          },
        ),
      ),
    );

    if (result.status === 'ok') {
      await this.markProcessed(record);
      return 'succeeded';
    }

    if (result.status === 'permanent_failure') {
      await this.markFailed(record, result.reason);
      this.logger.error('outbox event permanently failed', undefined, {
        eventType: record.eventType,
        errorMessage: result.reason,
      });
      return 'failed';
    }

    // 一時的な失敗。上限に達していれば諦める。
    const nextAttempts = record.attempts + 1;
    if (nextAttempts >= record.maxAttempts) {
      await this.markFailed(record, `最大試行回数に到達しました: ${result.reason}`);
      this.logger.error('outbox event exhausted retries', undefined, {
        eventType: record.eventType,
        attempt: nextAttempts,
        errorMessage: result.reason,
      });
      return 'failed';
    }

    await this.scheduleRetry(record, nextAttempts, result.reason);
    return 'retried';
  }

  /**
   * Outboxの状態更新。ディスパッチャ文脈で実行する。
   * 通常の組織コンテキストでは他組織のイベントを更新できないため。
   */
  private async updateOutbox(sql: string, params: unknown[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.dispatcher', 'on', true)");
      await client.query(sql, params);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async markProcessed(record: OutboxRecord): Promise<void> {
    await this.updateOutbox(
      'UPDATE outbox_event SET processed_at = $2, locked_until = NULL WHERE id = $1',
      [record.id, this.now()],
    );
  }

  private async markFailed(record: OutboxRecord, reason: string): Promise<void> {
    await this.updateOutbox(
      'UPDATE outbox_event SET failed_at = $2, last_error = $3, locked_until = NULL WHERE id = $1',
      [record.id, this.now(), reason.slice(0, 1000)],
    );
  }

  private async scheduleRetry(
    record: OutboxRecord,
    attempts: number,
    reason: string,
  ): Promise<void> {
    const nextAt = new Date(this.now().getTime() + backoffSeconds(attempts) * 1000);
    await this.updateOutbox(
      `UPDATE outbox_event
          SET attempts = $2, available_at = $3, last_error = $4, locked_until = NULL
        WHERE id = $1`,
      [record.id, attempts, nextAt, reason.slice(0, 1000)],
    );
  }
}
