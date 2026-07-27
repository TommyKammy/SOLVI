import pg from 'pg';
import type { Logger } from '@solvi/shared';

/**
 * PostgreSQL 接続。
 *
 * ADR-0015 により、アプリケーションは**非owner・NOBYPASSRLS**のロールで接続する。
 * トランザクションごとに `SET LOCAL app.current_org` を設定し、RLS が効いた状態でのみ
 * 業務テーブルへ触れる。プール利用時に設定が他リクエストへ漏れないよう、
 * SET は必ず LOCAL(トランザクションスコープ)にする。
 */

export interface TxContext {
  organizationId: string | null;
  actorId?: string;
  /** platform_admin が対象Orgを明示切替した場合に true。監査対象(02.18 §3) */
  crossOrg?: boolean;
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly logger: Logger,
    poolConfig: Partial<pg.PoolConfig> = {},
  ) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...poolConfig,
    });
    this.pool.on('error', (err) => {
      // アイドル接続のエラーはプロセスを落とさない。次の取得でリトライされる。
      this.logger.error('postgres idle client error', err);
    });
  }

  /** 接続確認のみ。業務クエリには使わない。 */
  async ping(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  }

  /**
   * Organizationコンテキスト付きトランザクション。
   *
   * `app.current_org` を設定しないまま業務テーブルを読むと、RLSにより0行が返る(fail closed)。
   * これは意図した挙動であり、「設定を忘れたら見えない」側に倒す。
   */
  async withOrgTransaction<T>(
    context: TxContext,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // set_config の第3引数 true = トランザクションローカル
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        context.organizationId ?? '',
      ]);
      if (context.actorId) {
        await client.query('SELECT set_config($1, $2, true)', [
          'app.current_actor',
          context.actorId,
        ]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Organization境界の外で実行する読み取り(ヘルスチェック、マイグレーション状態など)。
   * 業務データへ使わないこと。
   */
  async queryOutsideOrgScope<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(sql, params);
  }

  /**
   * 認証層のためのプール参照。
   *
   * **業務データには使わない。** 認証は組織コンテキストが確立する前に走るため、
   * `withOrgTransaction` を通せない(組織を決めるにはセッションが要り、
   * セッションを引くには組織が要る、という循環になる)。
   * 触ってよいのは `session` / `local_credential` / `app_user` / `role_binding` に限る
   * (WP-P1-IDM-009 / ADR-0019)。
   */
  authPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
