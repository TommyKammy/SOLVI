import type pg from 'pg';
import { runWithContext, newContext, recordDomainEvent, type Logger } from '@solvi/shared';
import { TicketService } from '../../modules/ticket/ticket.service.js';
import { NoopDenialRecorder } from '../audit/denial-recorder.js';

/**
 * 解決済みチケットの自動クローズ (FR-TKT-012 / 03.3 状態機械 / WP-P2-CLOSE-014)。
 *
 * **要求はあり、規則もあり、実行する者だけが居なかった。**
 *
 * 03.3 の状態機械は「Closed(Resolved後14日で自動)」と定めており、
 * `state-machine.ts` にも `resolved → closed (auto_close)` の規則がある。
 * しかし `auto_close` を実行する経路がどこにも無く、
 * **解決済みチケットは永久に resolved のまま残っていた。**
 *
 * さらに悪いことに、この遷移が担当者の選択肢として画面に出ていた。
 * 自動化のための遷移理由が手動操作のボタンになっており、
 * 「完了にする」と「closed にする」という同じ意味のボタンが2つ並んでいた。
 *
 * APIプロセスで動かす理由は Outboxディスパッチャと同じである
 * (`../outbox/dispatcher.ts` の冒頭)。監査と通知の書き込みが `services/api`
 * にあり、worker から使うと境界を越える。
 *
 * 設計上の要点:
 *
 * 1. **読み取りは越境させ、書き込みは越境させない。** 候補の一覧を作るには
 *    全組織を横断する必要があるが、1件を閉じる操作は必ずその組織の中で行う
 *    (migration 0016)。
 *
 * 2. **抽出時点の判断を信じない。** 抽出から実行までに人が Reopen している
 *    ことがある。1件ごとに状態機械へもう一度問う。
 *
 * 3. **1件の失敗で全体を止めない。** 1件が制約違反で落ちても、
 *    残りは閉じる。止めると滞留が積み上がり、あとで一度に大量に閉じることになる。
 */

/** 解決から自動クローズまでの日数。Reopen の窓と同じ長さにする(FR-TKT-012)。 */
export const AUTO_CLOSE_AFTER_DAYS = 14;

export interface AutoCloseSummary {
  candidates: number;
  closed: number;
  skipped: number;
  failed: number;
}

interface Candidate {
  id: string;
  organizationId: string;
}

export class AutoCloseSweeper {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 候補を全組織から拾う。
   *
   * ここで返るのはIDと組織IDだけである。件名も本文も読まない —
   * 越境して読む範囲は、必要な最小限にとどめる。
   */
  private async findCandidates(limit: number): Promise<Candidate[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.autoclose', 'on', true)");
      const { rows } = await client.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id
           FROM ticket
          WHERE state = 'resolved'
            AND resolved_at IS NOT NULL
            AND resolved_at <= $1::timestamptz - ($2 || ' days')::interval
          ORDER BY resolved_at
          LIMIT $3`,
        [this.now().toISOString(), String(AUTO_CLOSE_AFTER_DAYS), limit],
      );
      await client.query('COMMIT');
      return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 1件を、その組織のコンテキストで閉じる。 */
  private async closeOne(candidate: Candidate): Promise<'closed' | 'skipped'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        candidate.organizationId,
      ]);
      const service = new TicketService(client, new NoopDenialRecorder());
      const number = await service.autoClose(candidate.id, this.now());
      await client.query('COMMIT');
      return number === null ? 'skipped' : 'closed';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 1周回。
   *
   * @param limit 1周で扱う上限。多すぎると1回のトランザクションが長引き、
   *   少なすぎると滞留が減らない。既定は控えめにし、周回で追いつかせる。
   */
  async sweepOnce(limit = 200): Promise<AutoCloseSummary> {
    const candidates = await this.findCandidates(limit);
    const summary: AutoCloseSummary = {
      candidates: candidates.length,
      closed: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        const outcome = await this.closeOne(candidate);
        if (outcome === 'closed') {
          summary.closed += 1;
          recordDomainEvent('ticket.transitioned', 'success');
        } else {
          // 抽出後に人が Reopen した、など。異常ではない。
          summary.skipped += 1;
        }
      } catch (error) {
        summary.failed += 1;
        // **握り潰さない。** 閉じられないチケットが積み上がると、
        // 一覧の「解決済み」が実態より多くなり、対応漏れの判断を誤らせる。
        this.logger.error('auto close failed', error, {
          targetType: 'ticket',
          targetId: candidate.id,
        });
      }
    }

    return summary;
  }
}

/**
 * 定期実行の入口。
 *
 * **成功時にも件数をログへ出す。** 自動クローズは平時に何も出力しないため、
 * 止まっていることと対象が無いことが外から区別できない
 * (監査アンカーで同じ問題を踏んだ / 04.23_Wiring_Verification §3.1)。
 */
export function startAutoCloseLoop(
  sweeper: AutoCloseSweeper,
  logger: Logger,
  intervalMs: number,
): NodeJS.Timeout {
  const tick = (): void => {
    void runWithContext(newContext(), async () => {
      try {
        const summary = await sweeper.sweepOnce();
        logger.info('auto close sweep', {
          count: summary.closed,
          message: `candidates=${summary.candidates} closed=${summary.closed} skipped=${summary.skipped} failed=${summary.failed}`,
        });
      } catch (error) {
        logger.error('auto close sweep failed', error);
      }
    });
  };
  tick();
  return setInterval(tick, intervalMs);
}
