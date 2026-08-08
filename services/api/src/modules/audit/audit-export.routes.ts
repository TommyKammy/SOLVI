import type pg from 'pg';
import { AuditExportService, toJsonl } from './audit-export.service.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

/**
 * 監査の書き出し (AUD-002 / AUD-003 / WP-P1-AUD-018)。
 *
 * **JSONL で返す。** 1行目が manifest、以降が1件ずつ。
 * 表計算に貼るためではなく、**再計算するため**の形式である。
 */

export interface AuditExportRouteDeps {
  pool: pg.Pool;
}

export class AuditExportController {
  constructor(private readonly deps: AuditExportRouteDeps) {}

  async exportDay(
    auth: AuthenticatedRequest,
    date: string,
  ): Promise<{ status: number; body: string }> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const result = await new AuditExportService(client).exportDay(auth.authz, date);
      await client.query('COMMIT');
      return { status: 200, body: toJsonl(result) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
