import {
  apiEnvSchema,
  loadEnv,
  createLogger,
  EnvValidationError,
  startTracing,
  stopTracing,
  runWithContext,
  newContext,
  type ApiEnv,
} from '@solvi/shared';
import { Database } from './common/db/pool.js';
import { HttpServer } from './common/http/server.js';
import { HealthService } from './modules/health/health.js';
import { AuthController } from './modules/auth/auth.routes.js';
import { TicketController } from './modules/ticket/ticket.routes.js';
import { CollaborationController } from './modules/ticket/collaboration.routes.js';
import { S3CompatibleStorage } from '@solvi/shared';
import { OutboxDispatcher, type OutboxHandler } from './common/outbox/dispatcher.js';
import { NotificationService } from './modules/notification/notification.service.js';
import { RecordingEmailSender } from './modules/notification/senders.js';
import { PoolDenialRecorder } from './common/audit/denial-recorder.js';
import type { IncomingMessage } from 'node:http';

const SERVICE_VERSION = process.env.SOLVI_VERSION ?? 'dev';

/** 本文サイズの上限。上限が無いと、大きな本文だけでプロセスを潰せる。 */
const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error('リクエスト本文が大きすぎます');
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // 解析できない本文は、認証経路では「不正な資格情報」と同じ扱いにする。
    // 詳細を返しても利用者の役には立たない。
    return {};
  }
}

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
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE,
  });

  const logger = createLogger({
    service: 'api',
    level: env.LOG_LEVEL,
    env: env.NODE_ENV,
  });

  const db = new Database(env.DATABASE_URL, logger);
  const health = new HealthService(db, logger, SERVICE_VERSION);

  // 認証。ローカル認証が無効なら経路は 404 を返す(存在を秘匿する)。
  const auth = new AuthController(db.authPool(), {
    localAuthEnabled: env.AUTH_LOCAL_ENABLED,
    cookieSecure: env.SESSION_COOKIE_SECURE,
    localAuth: {
      maxFailedAttempts: env.AUTH_MAX_FAILED_ATTEMPTS,
      lockoutSeconds: env.AUTH_LOCKOUT_SECONDS,
    },
  });

  if (env.AUTH_LOCAL_ENABLED) {
    // 有効化されていること自体をログに残す。本番では起動時に弾かれるため、
    // この行が本番のログに出ることはない(脅威 T-25)。
    logger.warn('local authentication is enabled (development only)', {
      message: 'ADR-0019: 検証段階限定。本番構成では起動を拒否する',
    });
  }

  const denialRecorder = new PoolDenialRecorder(db.authPool());
  const tickets = new TicketController({ pool: db.authPool(), denialRecorder });

  const collaboration = new CollaborationController({
    pool: db.authPool(),
    denialRecorder,
    storage: new S3CompatibleStorage({
      endpoint: env.S3_ENDPOINT,
      // ブラウザへ渡す署名付きURLは、ブラウザから到達できるホストで署名する
      ...(env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.S3_PUBLIC_ENDPOINT } : {}),
      bucket: env.S3_BUCKET_ATTACHMENTS,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      region: env.S3_REGION,
    }),
  });

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
    })
    .post('/auth/login', async (req, res) => {
      const result = await auth.login(await readJsonBody(req));
      res.writeHead(result.status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...result.headers,
      });
      res.end(JSON.stringify(result.body));
    })
    .post('/auth/logout', async (req, res) => {
      const result = await auth.logout(req.headers);
      res.writeHead(result.status, result.headers);
      res.end();
    })
    .get('/auth/me', async (req) => {
      const result = await auth.me(req.headers);
      return result.body;
    })
    .post('/tickets', async (req, res) => {
      // 認証はハンドラの最初に置く。ルータ側の仕組みにすると、
      // 新しいルートを足した人が付け忘れても動いてしまう。
      // 各ハンドラで明示的に呼ぶほうが、抜けがレビューで見える。
      const authenticated = await auth.authenticate(req.headers);
      const result = await tickets.create(authenticated, await readJsonBody(req));
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
    })
    .get('/tickets', async (req) => {
      const authenticated = await auth.authenticate(req.headers);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const result = await tickets.list(authenticated, url.searchParams);
      return result.body;
    })
    .get('/tickets/:id', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await tickets.findById(authenticated, params.id ?? '');
      return result.body;
    })
    .get('/tickets/:id/workspace', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.workspace(authenticated, params.id ?? '');
      return result.body;
    })
    .get('/tickets/:id/comments', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.listComments(authenticated, params.id ?? '');
      return result.body;
    })
    .post('/tickets/:id/comments', async (req, res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.addComment(
        authenticated,
        params.id ?? '',
        await readJsonBody(req),
      );
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
    })
    .post('/tickets/:id/transitions', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.transition(
        authenticated,
        params.id ?? '',
        await readJsonBody(req),
      );
      return result.body;
    })
    .get('/tickets/:id/attachments', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.listAttachments(authenticated, params.id ?? '');
      return result.body;
    })
    .post('/tickets/:id/attachments', async (req, res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.requestUpload(
        authenticated,
        params.id ?? '',
        await readJsonBody(req),
      );
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.body));
    })
    .post('/attachments/:id/delete', async (req, res, params) => {
      // POST で受ける。GET や DELETE をリンクに置くと、ページを開いただけで
      // 消える経路ができる。取り消せない操作を偶発的に起こさせない。
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.deleteAttachment(
        authenticated,
        params.id ?? '',
        await readJsonBody(req),
      );
      res.writeHead(result.status);
      res.end();
    })
    .get('/attachments/:id/download', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.createDownloadUrl(authenticated, params.id ?? '');
      return result.body;
    })
    .post('/tickets/:id/assignee', async (req, _res, params) => {
      const authenticated = await auth.authenticate(req.headers);
      const result = await collaboration.assign(
        authenticated,
        params.id ?? '',
        await readJsonBody(req),
      );
      return result.body;
    });

  // ---------------------------------------------------------------------------
  // Outbox の配送 (ADR-0008 / WP-P2-NTF-005)
  //
  // **これを繋がないと、通知は一件も届かない。**
  // イベントは業務トランザクションで積まれるが、配送する者がいなければ
  // outbox_event に溜まり続ける。画面は正常に見え、テストも緑のまま、
  // 依頼者だけが「連絡が来ない」と感じる。
  //
  // 実際、この配線が抜けたまま通知機能一式が「完了」として記録されていた。
  // 横断点検(tools/check_unwired.mjs)で発見した。
  // ---------------------------------------------------------------------------
  const emailSender = new RecordingEmailSender();

  const notificationHandler: OutboxHandler = async (record, client) => {
    const service = new NotificationService(client, new Map([['email', emailSender]]));
    try {
      await service.deliverForEvent(record);
      return { status: 'ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // ペイロード不足は再試行しても直らない。
      if (message.includes('ペイロードにありません')) {
        return { status: 'permanent_failure', reason: message };
      }
      return { status: 'retry', reason: message };
    }
  };

  const outboxDispatcher = new OutboxDispatcher(
    db.authPool(),
    new Map(
      ['ticket.created', 'ticket.transitioned', 'ticket.assigned', 'ticket.comment.added'].map(
        (type) => [type, notificationHandler],
      ),
    ),
    logger,
  );

  const dispatchTick = (): void => {
    void runWithContext(newContext(), async () => {
      try {
        const summary = await outboxDispatcher.dispatchOnce();
        if (summary.fetched > 0) {
          logger.info('outbox dispatch', {
            count: summary.fetched,
            message:
              `succeeded=${summary.succeeded} retried=${summary.retried} ` +
              `failed=${summary.failed}`,
          });
        }
      } catch (error) {
        // 配送の失敗でプロセスを落とさない。次の周回で再試行する。
        logger.error('outbox dispatch failed', error);
      }
    });
  };
  // 10秒間隔。NFR-PERF-003 は p95 30秒を求めており、余裕を持たせる。
  const dispatchTimer = setInterval(dispatchTick, 10_000);
  dispatchTick();

  const server = app.listen(env.API_PORT);
  logger.info('api listening', { count: env.API_PORT });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { message: signal });
    // 新規受付を止めてから接続を閉じる。処理中のリクエストを切らない。
    clearInterval(dispatchTimer);
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
