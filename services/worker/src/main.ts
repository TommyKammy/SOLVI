import { createServer } from 'node:http';
import {
  workerEnvSchema,
  loadEnv,
  createLogger,
  EnvValidationError,
  newContext,
  runWithContext,
  type WorkerEnv,
} from '@solvi/shared';
import pg from 'pg';

/**
 * Outbox配送とWorkflow進行を担うプロセス(ADR-0008)。
 *
 * Phase 1 ではプロセスの器と健全性確認のみを用意する。
 * Outboxのディスパッチ実装は WP-P4-WF-003、監査アンカーのバッチは WP-P1-AUD-004 で追加する。
 */

const SERVICE_VERSION = process.env.SOLVI_VERSION ?? 'dev';

async function bootstrap(): Promise<void> {
  let env: WorkerEnv;
  try {
    env = loadEnv(workerEnvSchema, 'services/worker');
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(78);
    }
    throw error;
  }

  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL, env: env.NODE_ENV });
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
      res.end(JSON.stringify({ status: 'ok', service: 'worker', version: SERVICE_VERSION }));
      return;
    }
    if (req.url === '/readyz') {
      res.writeHead(dbHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: dbHealthy ? 'ready' : 'not_ready',
          dependencies: [{ name: 'postgres', status: dbHealthy ? 'up' : 'down' }],
          checkedAt: new Date().toISOString(),
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(env.WORKER_PORT);
  logger.info('worker listening', { count: env.WORKER_PORT });

  // ループの各周回に独立した相関IDを与える。バッチ起点の処理も追跡できるようにする。
  const tick = (): void => {
    runWithContext(newContext(), () => {
      logger.debug('outbox dispatch tick (no dispatcher yet — WP-P4-WF-003)');
    });
  };
  const loopTimer = setInterval(tick, 30_000);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { message: signal });
    clearInterval(loopTimer);
    clearInterval(healthTimer);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('failed to start worker', error);
  process.exit(1);
});
