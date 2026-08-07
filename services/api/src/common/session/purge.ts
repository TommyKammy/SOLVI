import type pg from 'pg';
import { runWithContext, newContext, type Logger } from '@solvi/shared';
import { SessionService } from '../../modules/auth/session.service.js';

/**
 * 期限切れセッションの掃除 (WP-P1-IDM-013 / FR-IDM-008 / 03.16)。
 *
 * `SessionService.purgeExpired` は [[WP-P1-IDM-009]] で書かれ、
 * 冒頭に「定期実行から呼ぶ」と書かれていた。**その定期実行が無かった。**
 *
 * 実害は遅い。セッションは失効しても `validate()` が弾くので、
 * 溜まっていること自体で誰かが入れるようにはならない。
 * それでも放置してよい理由にはならない:
 *
 * - **消えない個人データが増え続ける。** `session` は誰がいつどこから
 *   入ったかの記録であり、保持の根拠が切れたあとも残る(03.16 の Minimization)
 * - 索引が太り、認証のたびに引く表が重くなる
 * - 「掃除されているはず」と書いてある文書が嘘になる
 *
 * ## 消しても記録は失わない
 *
 * `session` 行は業務の記録ではなく**運用の状態**である。
 * 「誰がログインしたか」「なぜ失効したか」は `audit_event` 側に
 * 追記専用・ハッシュ連鎖で残っている(ADR-0009):
 *
 * | 失効の理由 | 監査 |
 * |---|---|
 * | `logout` | `session.revoked`(local-auth.service) |
 * | `user_deactivated` | `user.deactivated`(session.service) |
 * | `password_changed` | `user.updated` / `credential.set`([[WP-P1-IDM-012]]) |
 *
 * したがって `session` を消しても、追える事実は減らない。
 * **減るなら消してはいけない** — その判断のためにこの表を書いている。
 *
 * ## 動かす場所
 *
 * APIプロセスで動かす。自動クローズ(`../close/auto-close.ts`)と同じ理由で、
 * セッションの取り扱いは `services/api` にあり、worker から使うと境界を越える。
 */

/**
 * 保持日数の既定値。
 *
 * 03.16 は「法務・監査による最終保持年数確定」を対象外としており、
 * **数値の根拠はまだ無い。** 30日は仮の値である。
 *
 * セッションの絶対有効期限は12時間(ADR-0019)なので、30日は
 * 「切れてからひと月は調査のために残す」という意味になる。
 * 法務の確認がついたら `SESSION_RETENTION_DAYS` で変える。
 */
export const DEFAULT_SESSION_RETENTION_DAYS = 30;

export class SessionPurger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly retentionDays: number = DEFAULT_SESSION_RETENTION_DAYS,
  ) {}

  /**
   * 1周分。
   *
   * **組織コンテキストを設定しない。** `session` の RLS は
   * `USING (true)`(migration 0011)であり、セッションは組織に属さない。
   * 兼務者は1つのセッションで組織を切り替えるため、
   * 組織で分けると「どちらの組織の掃除か」が決められない。
   *
   * これは越境の例外ではない。**最初から組織の軸を持たない表**である。
   */
  async sweepOnce(): Promise<{ deleted: number }> {
    const client = await this.pool.connect();
    try {
      const sessions = new SessionService(client);
      const deleted = await sessions.purgeExpired(this.retentionDays);
      return { deleted };
    } finally {
      client.release();
    }
  }
}

export function startSessionPurgeLoop(
  purger: SessionPurger,
  logger: Logger,
  intervalMs: number,
): NodeJS.Timeout {
  const tick = (): void => {
    void runWithContext(newContext(), async () => {
      try {
        const { deleted } = await purger.sweepOnce();
        // 0件の周回は書かない。**毎周ログを出すと、実際に消えた日が埋もれる。**
        if (deleted > 0) {
          logger.info('session purge', {
            count: deleted,
            message: `deleted=${deleted}`,
          });
        }
      } catch (error) {
        // 掃除の失敗でAPIを落とさない。次の周回で消えるだけである。
        logger.error('session purge failed', error);
      }
    });
  };
  tick();
  return setInterval(tick, intervalMs);
}
