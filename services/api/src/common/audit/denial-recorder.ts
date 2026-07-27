import type pg from 'pg';
import { recordAuditEvent, type AuditEventInput } from './audit.js';

/**
 * 拒否イベントを業務トランザクションの**外**で記録する。
 *
 * なぜ分けるのか:
 *   成功時の監査は業務トランザクションと同一でなければならない(証跡なしで状態を変えないため)。
 *   一方、拒否時は業務処理がロールバックされる。同じトランザクションに書くと
 *   拒否の記録ごと消え、「拒否された操作が試みられた」という検知の材料が残らない。
 *
 *   拒否には状態変更が伴わないため、原子性を要求する理由がない。
 *   必要なのは「業務処理の成否によらず残ること」であり、独立した接続で書く。
 *
 * 失敗した場合は例外を投げない。監査の書き込み失敗を理由に、
 * 既に確定している「拒否」という結果を覆さない(拒否は拒否のまま返す)。
 * ただしログには残し、監視で気付けるようにする。
 */
export interface DenialRecorder {
  record(organizationId: string, input: AuditEventInput): Promise<void>;
}

export class PoolDenialRecorder implements DenialRecorder {
  constructor(
    private readonly pool: pg.Pool,
    private readonly onError?: (error: unknown) => void,
  ) {}

  async record(organizationId: string, input: AuditEventInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', organizationId]);
      await recordAuditEvent(client, input);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // 監査書き込みの失敗で拒否処理を止めない。ただし黙って握りつぶさない。
      this.onError?.(error);
    } finally {
      client.release();
    }
  }
}

/** 拒否記録を行わない実装。単体テストなど、DBを持たない文脈で使う。 */
export class NoopDenialRecorder implements DenialRecorder {
  async record(): Promise<void> {
    // 意図的に何もしない
  }
}
