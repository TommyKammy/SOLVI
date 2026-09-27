import type pg from 'pg';
import { Problems } from '@solvi/shared';
import { AccessReviewService, type ReviewDecision } from './access-review.service.js';
import type { AuthenticatedRequest } from './auth.routes.js';

/**
 * アクセスレビューの経路 (NFR-SEC-002 / WP-P1-SEC-024)。
 *
 * **サービスだけを作って経路を作らない、を繰り返さない**
 * ([[04.23_Wiring_Verification]] §4.1)。繋がっていない機能は、
 * 使えないだけでなく、その中の欠陥も隠す。
 */

export interface AccessReviewRouteDeps {
  pool: pg.Pool;
  /** 完了期日(日)。**仮値**(`ACCESS_REVIEW_DUE_DAYS`)。人が開く期にも同じ期日を付ける。 */
  dueDays?: number;
}

export class AccessReviewController {
  constructor(private readonly deps: AccessReviewRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: AccessReviewService) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const out = await fn(new AccessReviewService(client, this.deps.dueDays));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(auth: AuthenticatedRequest) {
    const items = await this.run(auth, (s) => s.list(auth.authz));
    return { status: 200, body: { items } };
  }

  async open(auth: AuthenticatedRequest, body: unknown) {
    const input = (body ?? {}) as { periodLabel?: unknown };
    if (typeof input.periodLabel !== 'string') {
      throw Problems.validation([{ field: 'periodLabel', message: '期の名前を入力してください' }]);
    }
    const out = await this.run(auth, (s) => s.open(auth.authz, input.periodLabel as string));
    return { status: 201, body: out };
  }

  async detail(auth: AuthenticatedRequest, reviewId: string) {
    const out = await this.run(auth, (s) => s.detail(auth.authz, reviewId));
    return { status: 200, body: out };
  }

  async decide(auth: AuthenticatedRequest, reviewId: string, itemId: string, body: unknown) {
    const input = (body ?? {}) as { decision?: unknown; reason?: unknown };
    if (input.decision !== 'keep' && input.decision !== 'revoke') {
      // **自由文字列を受け取らない。** 閉じた選択肢だけを通す。
      throw Problems.validation([{ field: 'decision', message: '判断は keep または revoke です' }]);
    }
    if (typeof input.reason !== 'string') {
      throw Problems.validation([{ field: 'reason', message: '判断の理由を入力してください' }]);
    }
    await this.run(auth, (s) =>
      s.decide(
        auth.authz,
        reviewId,
        itemId,
        input.decision as ReviewDecision,
        input.reason as string,
      ),
    );
    return { status: 204, body: null };
  }

  async complete(auth: AuthenticatedRequest, reviewId: string) {
    const out = await this.run(auth, (s) => s.complete(auth.authz, reviewId));
    return { status: 200, body: out };
  }
}
