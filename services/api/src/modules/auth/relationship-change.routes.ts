import type pg from 'pg';
import {
  RelationshipChangeService,
  parseRelationshipChangeQuery,
} from './relationship-change.service.js';
import type { AuthenticatedRequest } from './auth.routes.js';

/**
 * 上長・主部署・部署長の変更履歴 API (WP-P4-APR-015 §6.1)。
 *
 * 読み取り専用。`org_admin` と `auditor` だけが期間を指定して参照できる。
 * 監査イベントを読むだけで、新しいテーブルは作らない。
 */

export interface RelationshipChangeRouteDeps {
  pool: pg.Pool;
}

export class RelationshipChangeController {
  constructor(private readonly deps: RelationshipChangeRouteDeps) {}

  async list(auth: AuthenticatedRequest, query: URLSearchParams) {
    const input = parseRelationshipChangeQuery(Object.fromEntries(query));
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const result = await new RelationshipChangeService(client).list(auth.authz, input);
      await client.query('COMMIT');
      return { status: 200, body: result };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
