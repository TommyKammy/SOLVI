import type pg from 'pg';
import { runWithContext, newContext, registerGauge, type Logger } from '@solvi/shared';
import { AccessReviewService, DEFAULT_ACCESS_REVIEW_DUE_DAYS } from './access-review.service.js';

/**
 * 四半期アクセスレビューの定期起票 (NFR-SEC-002 / WP-P1-SEC-025)。
 *
 * [[WP-P1-SEC-024]] でレビューを開き・判断し・閉じられるようになった。
 * **開くのは人だけだった。** 誰も開かなければ、何も起きない。
 * 「実施できる」と「四半期ごとに実施している」の間には、始める者が要る。
 *
 * ## 設計の要点
 *
 * 1. **期の判定を期の名前で行わない。** 人は「2026-Q3-追加」のように名付ける。
 *    「その四半期に開かれたレビューがあるか」を**開始時刻**で見る。
 *
 * 2. **前の期が終わっていなければ、新しい期を開かない。** 開いているレビューは
 *    組織に1つ(SEC-024)。無理に開けば前の期の判断が宙に浮く。
 *    代わりに**遅れとして数える**。
 *
 * 3. **読み取りは越境させ、書き込みは越境させない**(0016 / 0025)。
 *    候補の抽出だけが全組織を見る。開く操作はその組織の文脈で行う。
 *
 * 4. **期日を過ぎても自動で閉じない・自動で取り消さない。** 判断は人に残す。
 *    機械がするのは、遅れていることを**人が気付く前に**見えるようにすることだけである。
 */

/** 四半期の名前と開始時刻。**境界は UTC で数える。** */
export function quarterOf(now: Date): { label: string; start: Date } {
  const year = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return { label: `${year}-Q${q}`, start: new Date(Date.UTC(year, (q - 1) * 3, 1)) };
}

export interface ScheduleSummary {
  organizations: number;
  opened: number;
  /** その四半期に既に開かれている(人でも定期処理でも)。 */
  alreadyCovered: number;
  /** 前の期が未完了のため開けなかった。**これは遅れである。** */
  blockedByOpen: number;
  failed: number;
}

interface Candidate {
  organizationId: string;
  coveredThisQuarter: boolean;
  hasOpen: boolean;
}

export class AccessReviewScheduler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly dueDays: number = DEFAULT_ACCESS_REVIEW_DUE_DAYS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 読み取り例外を張った短いトランザクションで問い合わせる。 */
  private async scan<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.access_review_schedule', 'on', true)");
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

  /**
   * 候補を全組織から拾う。
   *
   * 返すのは組織IDと2つの真偽だけである。レビューの中身も利用者も読まない —
   * 越境して読む範囲は、必要な最小限にとどめる。
   */
  private findCandidates(quarterStart: Date): Promise<Candidate[]> {
    return this.scan(async (client) => {
      const { rows } = await client.query<{
        id: string;
        covered: boolean;
        has_open: boolean;
      }>(
        `SELECT o.id,
                EXISTS (SELECT 1 FROM access_review ar
                         WHERE ar.organization_id = o.id AND ar.opened_at >= $1) AS covered,
                EXISTS (SELECT 1 FROM access_review ar
                         WHERE ar.organization_id = o.id AND ar.completed_at IS NULL) AS has_open
           FROM organization o
          WHERE o.status = 'active'
          ORDER BY o.id`,
        [quarterStart.toISOString()],
      );
      return rows.map((r) => ({
        organizationId: r.id,
        coveredThisQuarter: r.covered,
        hasOpen: r.has_open,
      }));
    });
  }

  /** 期日を過ぎて未完了のレビューの件数(全組織)。 */
  countOverdue(): Promise<number> {
    return this.scan(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM access_review
          WHERE completed_at IS NULL AND due_at < $1`,
        [this.now().toISOString()],
      );
      return Number(rows[0]?.n ?? 0);
    });
  }

  /**
   * この四半期にレビューが1つも開かれていない組織の数。
   *
   * **遅れの件数だけでは、始まらないことを捉えられない。** 定期処理が開けなければ
   * 期日を過ぎるレビューがそもそも存在せず、遅れは 0 のまま四半期が過ぎる。
   * 定期処理が正常なら、期の初めの1時間ほどを除いて 0 になる。
   */
  countMissingThisQuarter(): Promise<number> {
    const { start } = quarterOf(this.now());
    return this.scan(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM organization o
          WHERE o.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM access_review ar
                             WHERE ar.organization_id = o.id AND ar.opened_at >= $1)`,
        [start.toISOString()],
      );
      return Number(rows[0]?.n ?? 0);
    });
  }

  /** 1組織を、その組織の文脈で開く。 */
  private async openOne(organizationId: string, label: string): Promise<'opened' | 'raced'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_org', organizationId]);
      await new AccessReviewService(client, this.dueDays).openScheduled(organizationId, label);
      await client.query('COMMIT');
      return 'opened';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // **同時に2つが回っても、期は1つしかできない。** 一意索引が止める。
      // 負けた側は失敗ではない — 既に誰かが開いた。
      if ((error as { code?: string }).code === '23505') return 'raced';
      throw error;
    } finally {
      client.release();
    }
  }

  async runOnce(): Promise<ScheduleSummary> {
    const { label, start } = quarterOf(this.now());
    const candidates = await this.findCandidates(start);
    const summary: ScheduleSummary = {
      organizations: candidates.length,
      opened: 0,
      alreadyCovered: 0,
      blockedByOpen: 0,
      failed: 0,
    };

    for (const c of candidates) {
      if (c.coveredThisQuarter) {
        summary.alreadyCovered += 1;
        continue;
      }
      if (c.hasOpen) {
        // 前の期がまだ終わっていない。**開かずに、遅れとして数える。**
        summary.blockedByOpen += 1;
        continue;
      }
      try {
        const outcome = await this.openOne(c.organizationId, label);
        if (outcome === 'opened') summary.opened += 1;
        else summary.alreadyCovered += 1;
      } catch (error) {
        summary.failed += 1;
        // **握り潰さない。** 開けなかった組織は、その四半期のレビューが無いまま過ぎる。
        this.logger.error('access review schedule failed', error, {
          targetType: 'organization',
          targetId: c.organizationId,
        });
      }
    }
    return summary;
  }
}

/**
 * 定期実行の入口と、遅れのメトリクス。
 *
 * **平時にも件数をログへ出す。** 定期起票は四半期に一度しか何も開かないため、
 * 止まっていることと対象が無いことが外から区別できない(04.23 §3.1)。
 */
export function startAccessReviewScheduleLoop(
  scheduler: AccessReviewScheduler,
  logger: Logger,
  intervalMs: number,
): NodeJS.Timeout {
  // 遅れの件数は、監視が問い合わせたときに数える。
  // 周回ごとの値を覚えておく方式だと、定期処理が止まったときに**古い値が出続ける**。
  registerGauge(
    'solvi.access_review.overdue',
    '期日を過ぎて未完了のアクセスレビューの件数(NFR-SEC-002)',
    () => scheduler.countOverdue(),
  );
  registerGauge(
    'solvi.access_review.missing_this_quarter',
    'この四半期にアクセスレビューが開かれていない組織の数(NFR-SEC-002)',
    () => scheduler.countMissingThisQuarter(),
  );

  const tick = (): void => {
    void runWithContext(newContext(), async () => {
      try {
        const s = await scheduler.runOnce();
        logger.info('access review schedule', {
          count: s.opened,
          message:
            `organizations=${s.organizations} opened=${s.opened} ` +
            `alreadyCovered=${s.alreadyCovered} blockedByOpen=${s.blockedByOpen} failed=${s.failed}`,
        });
      } catch (error) {
        logger.error('access review schedule failed', error);
      }
    });
  };
  tick();
  return setInterval(tick, intervalMs);
}
