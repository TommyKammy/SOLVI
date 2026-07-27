import { createServer } from 'node:http';
import {
  executorEnvSchema,
  loadEnv,
  createLogger,
  EnvValidationError,
  type ExecutorEnv,
} from '@solvi/shared';
import pg from 'pg';

/**
 * SOLVI Run — 特権操作を実行する分離サービス(ADR-0006 / 02.16 Executor Command Contract)。
 *
 * Phase 1 の時点では **Command を受け付ける経路をまだ開かない**。
 * 契約検証(署名・期限・nonce・Allowlist・承認再検証)が実装されるのは WP-P4-EXEC-004 であり、
 * それ以前に受付口を用意すると、検証のないまま到達できる特権面ができてしまう。
 * ここではプロセスの器・別資格情報での接続・健全性確認までを用意する。
 *
 * 不変条件(WP-P4 以降も維持する):
 *  - Core API とは別の DB ロールで接続する
 *  - AI サービスからこのプロセスへ到達する経路を作らない
 *  - 外部公開しない(compose では expose のみ。ports で公開しない)
 */

const SERVICE_VERSION = process.env.SOLVI_VERSION ?? 'dev';

async function bootstrap(): Promise<void> {
  let env: ExecutorEnv;
  try {
    env = loadEnv(executorEnvSchema, 'services/executor');
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(78);
    }
    throw error;
  }

  const logger = createLogger({ service: 'executor', level: env.LOG_LEVEL, env: env.NODE_ENV });
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  pool.on('error', (err) => logger.error('postgres idle client error', err));

  let dbHealthy = false;
  const checkDb = async (): Promise<void> => {
    try {
      await pool.query('SELECT 1');
      dbHealthy = true;
    } catch (error) {
      dbHealthy = false;
      logger.error('database check failed', error);
    }
  };
  await checkDb();
  const healthTimer = setInterval(() => void checkDb(), 10_000);

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'executor', version: SERVICE_VERSION }));
      return;
    }
    if (req.url === '/readyz') {
      res.writeHead(dbHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: dbHealthy ? 'ready' : 'not_ready',
          dependencies: [{ name: 'postgres', status: dbHealthy ? 'up' : 'down' }],
          // Command受付が未実装であることを明示する。
          commandIntake: 'closed (implemented in WP-P4-EXEC-004)',
          checkedAt: new Date().toISOString(),
        }),
      );
      return;
    }
    // 健全性以外の経路は開かない。将来の /commands は契約検証と同時に追加する。
    res.writeHead(404).end();
  });
  server.listen(env.EXECUTOR_PORT);
  logger.info('executor listening (command intake closed)', { count: env.EXECUTOR_PORT });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { message: signal });
    clearInterval(healthTimer);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('failed to start executor', error);
  process.exit(1);
});
