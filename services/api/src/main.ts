import {
  apiEnvSchema,
  loadEnv,
  createLogger,
  EnvValidationError,
  startTracing,
  stopTracing,
  type ApiEnv,
} from '@solvi/shared';
import { Database } from './common/db/pool.js';
import { HttpServer } from './common/http/server.js';
import { HealthService } from './modules/health/health.js';

const SERVICE_VERSION = process.env.SOLVI_VERSION ?? 'dev';

async function bootstrap(): Promise<void> {
  let env: ApiEnv;
  try {
    env = loadEnv(apiEnvSchema, 'services/api');
  } catch (error) {
    // 設定が足りない状態で起動させない。ロガー初期化前なのでstderrへ直接出す。
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  // 計装は他の初期化より先に行う。後から始めると、起動時の処理が計装されない。
  startTracing({
    serviceName: 'solvi-api',
    serviceVersion: SERVICE_VERSION,
    environment: env.NODE_ENV,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    metricsPort: env.METRICS_PORT,
  });

  const logger = createLogger({
    service: 'api',
    level: env.LOG_LEVEL,
    env: env.NODE_ENV,
  });

  const db = new Database(env.DATABASE_URL, logger);
  const health = new HealthService(db, logger, SERVICE_VERSION);

  const app = new HttpServer(logger)
    .get('/healthz', () => health.liveness())
    .get('/readyz', async (_req, res) => {
      const report = await health.readiness();
      if (report.status !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(report));
        return;
      }
      return report;
    });

  const server = app.listen(env.API_PORT);
  logger.info('api listening', { count: env.API_PORT });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { message: signal });
    // 新規受付を止めてから接続を閉じる。処理中のリクエストを切らない。
    server.close();
    await app.close();
    await db.close();
    await stopTracing();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('failed to start api', error);
  process.exit(1);
});
