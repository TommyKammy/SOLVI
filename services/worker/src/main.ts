import { createServer } from 'node:http';
import {
  workerEnvSchema,
  loadEnv,
  createLogger,
  EnvValidationError,
  startTracing,
  stopTracing,
  newContext,
  runWithContext,
  ClamAvScanner,
  S3CompatibleStorage,
  type WorkerEnv,
} from '@solvi/shared';
import pg from 'pg';
import { AttachmentScanner } from './jobs/scan/attachment-scanner.js';

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

  // 計装は他の初期化より先に行う
  startTracing({
    serviceName: 'solvi-worker',
    serviceVersion: SERVICE_VERSION,
    environment: env.NODE_ENV,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    metricsPort: env.METRICS_PORT,
  });

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

  // 添付のウイルススキャン (WP-P2-SCAN-011 / OQ-011)。
  //
  // CLAMAV_HOST が未設定なら**スキャンを行わない**。その場合 scan_status は
  // pending のまま残り、ダウンロードURLは発行されない。
  // 「スキャナが無いから素通しする」という経路は作らない。
  const scanPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const attachmentScanner = env.CLAMAV_HOST
    ? new AttachmentScanner(
        scanPool,
        new S3CompatibleStorage({
          endpoint: env.S3_ENDPOINT,
          bucket: env.S3_BUCKET_ATTACHMENTS,
          accessKey: env.S3_ACCESS_KEY,
          secretKey: env.S3_SECRET_KEY,
          region: env.S3_REGION,
        }),
        new ClamAvScanner({
          host: env.CLAMAV_HOST,
          port: env.CLAMAV_PORT,
          maxBytes: env.CLAMAV_MAX_BYTES,
        }),
        logger,
      )
    : undefined;

  if (!attachmentScanner) {
    logger.warn('attachment scanning is disabled', {
      message: 'CLAMAV_HOST が未設定です。添付は pending のまま残り、ダウンロードできません',
    });
  }

  // ループの各周回に独立した相関IDを与える。バッチ起点の処理も追跡できるようにする。
  const tick = (): void => {
    void runWithContext(newContext(), async () => {
      if (!attachmentScanner) return;
      try {
        const summary = await attachmentScanner.scanPending();
        if (summary.scanned > 0) {
          logger.info('attachment scan tick', {
            count: summary.scanned,
            message: `clean=${summary.clean} infected=${summary.infected} deferred=${summary.deferred}`,
          });
        }
      } catch (error) {
        // スキャンの失敗でワーカーを落とさない。次の周回で再試行する。
        logger.error('attachment scan tick failed', error);
      }
    });
  };
  const loopTimer = setInterval(tick, 30_000);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { message: signal });
    clearInterval(loopTimer);
    clearInterval(healthTimer);
    await scanPool.end().catch(() => undefined);
    server.close();
    await pool.end();
    await stopTracing();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('failed to start worker', error);
  process.exit(1);
});
