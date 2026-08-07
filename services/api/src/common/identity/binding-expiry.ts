import type pg from 'pg';
import { runWithContext, newContext, type Logger } from '@solvi/shared';
import { recordAuditEvent } from '../audit/audit.js';

/**
 * 役割の期限到来を記録する (FR-IDM-006 / WP-P1-IDM-014)。
 *
 * FR-IDM-006 の受入基準は「期限到来で**自動失権+監査イベント**」。
 *
 * 自動失権は動いている(`resolveBindings()` が `valid_until` を見ている)。
 * **監査イベントだけが無かった。** `role.binding.deleted` は型として
 * 定義されているのに、発行する者がどこにも居なかった。
 *
 * ## なぜ記録が要るか
 *
 * 実害は静かである。兼務・出向の期限が切れると、ある日その組織が見えなくなる。
 * 本人には理由が分からず、管理者にも「いつ切れたか」を示す記録が無い。
 *
 * **「権限を失った」ことは、失った瞬間に記録しないと後から作れない。**
 * 束縛の行は残るが、「いつ効力を失ったか」を後から言えるのは
 * 記録があるときだけである。
 *
 * ## 越境は読み取りだけ (ADR-0015 / DL-019)
 *
 * 候補の一覧を作るには全組織の横断が要るが、1件を記録する操作は
 * その組織の文脈で行う。監査もその組織に残る。
 */

/** 1周で扱う上限。**一度に全部を書かない** — 監査の連鎖に長い書き込みを作らない。 */
const BATCH_LIMIT = 200;

export interface ExpirySweepSummary {
  /** 記録した件数 */
  recorded: number;
  /**
   * 対象外にした件数。
   *
   * **黙って飛ばさない。** platform スコープの束縛は組織に属さないため、
   * 記録の書き込みを行う組織の文脈が無い。件数を返して見えるようにする。
   */
  skippedPlatform: number;
}

interface PendingRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  role_scope: string;
  valid_until: Date;
  source: string;
  role_code: string;
}

export class RoleBindingExpirySweeper {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 候補の抽出。**読み取りだけを越境させる。**
   *
   * 読むのは記録に要る列だけである。氏名もメールも読まない —
   * 横断の読み取りで拾う情報は、必要な最小限に留める。
   */
  private async findExpired(): Promise<PendingRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.expiry', 'on', true)");
      const { rows } = await client.query(
        `SELECT rb.id, rb.user_id, rb.organization_id, rb.role_scope,
                rb.valid_until, rb.source, r.code AS role_code
           FROM role_binding rb
           JOIN role r ON r.id = rb.role_id
          WHERE rb.valid_until IS NOT NULL
            AND rb.valid_until <= $1
            AND rb.expiry_recorded_at IS NULL
          ORDER BY rb.valid_until
          LIMIT ${BATCH_LIMIT}`,
        [this.now()],
      );
      await client.query('COMMIT');
      return rows as PendingRow[];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 1件を記録する。**その組織の文脈で行う。**
   *
   * 印の更新と監査の書き込みを1つのトランザクションに入れる。
   * 分けると「記録したが印が付いていない」が生まれ、次の周回で二重に書く。
   */
  private async recordOne(row: PendingRow): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        row.organization_id,
      ]);

      // **印を先に付け、更新できた場合だけ記録する。**
      // 別の周回が同じ行を拾っていた場合、ここで 0 件になる。
      const { rowCount } = await client.query(
        `UPDATE role_binding SET expiry_recorded_at = $2
          WHERE id = $1 AND expiry_recorded_at IS NULL`,
        [row.id, this.now()],
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return;
      }

      await recordAuditEvent(client, {
        eventType: 'role.binding.deleted',
        organizationId: row.organization_id,
        // 人が行った操作ではない。**期限が来ただけである。**
        actorType: 'system',
        actorDisplay: 'role_binding_expiry',
        subjectUserId: row.user_id,
        targetType: 'role_binding',
        targetId: row.id,
        action: 'expire',
        outcome: 'success',
        beforeState: { roleCode: row.role_code, source: row.source, scope: row.role_scope },
        afterState: { effective: false, validUntil: row.valid_until.toISOString() },
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async sweepOnce(): Promise<ExpirySweepSummary> {
    const pending = await this.findExpired();
    let recorded = 0;
    let skippedPlatform = 0;

    for (const row of pending) {
      if (row.organization_id === null) {
        // platform スコープの束縛は組織に属さない。記録を書き込む文脈が無い。
        // **越境の例外を読み取りだけに保つため**、ここは記録しない。
        skippedPlatform++;
        continue;
      }
      try {
        await this.recordOne(row);
        recorded++;
      } catch (error) {
        // 1件の失敗で全体を止めない。**止めると滞留が積み上がる。**
        this.logger.error('role binding expiry record failed', error);
      }
    }

    return { recorded, skippedPlatform };
  }
}

export function startRoleBindingExpiryLoop(
  sweeper: RoleBindingExpirySweeper,
  logger: Logger,
  intervalMs: number,
): NodeJS.Timeout {
  const tick = (): void => {
    void runWithContext(newContext(), async () => {
      try {
        const summary = await sweeper.sweepOnce();
        if (summary.recorded > 0 || summary.skippedPlatform > 0) {
          logger.info('role binding expiry sweep', {
            count: summary.recorded,
            message: `recorded=${summary.recorded} skippedPlatform=${summary.skippedPlatform}`,
          });
        }
      } catch (error) {
        logger.error('role binding expiry sweep failed', error);
      }
    });
  };
  tick();
  return setInterval(tick, intervalMs);
}
