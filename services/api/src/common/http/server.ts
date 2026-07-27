import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  ProblemError,
  Problems,
  correlationIdFromHeader,
  runWithContext,
  newContext,
  CORRELATION_HEADER,
  REQUEST_ID_HEADER,
  type Logger,
} from '@solvi/shared';
import { randomUUID } from 'node:crypto';

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown;

interface Route {
  method: string;
  path: string;
  handler: Handler;
}

/**
 * 最小構成のHTTPルータ。
 *
 * Phase 1 の目的は基盤の確立であり、ここではフレームワークを持ち込まずに
 * 「相関ID・エラー表現・セキュリティヘッダ」の一貫性だけを保証する。
 * ドメインのエンドポイントが増える Phase 2 でNestJSへ載せ替える(ADR-0002)。
 */
export class HttpServer {
  private readonly routes: Route[] = [];
  private server?: Server;

  constructor(private readonly logger: Logger) {}

  get(path: string, handler: Handler): this {
    this.routes.push({ method: 'GET', path, handler });
    return this;
  }

  post(path: string, handler: Handler): this {
    this.routes.push({ method: 'POST', path, handler });
    return this;
  }

  listen(port: number): Server {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.listen(port);
    return this.server;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const correlationId = correlationIdFromHeader(req.headers[CORRELATION_HEADER]);
    const requestId = randomUUID();
    const started = process.hrtime.bigint();

    res.setHeader(CORRELATION_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    // APIはHTMLを返さないが、誤ってコンテンツを解釈させないための最低限の防御
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const context = newContext({ correlationId, requestId });
    const log = this.logger.child({ correlationId, requestId });

    await runWithContext(context, async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = this.routes.find((r) => r.method === req.method && r.path === url.pathname);

      try {
        if (!route) throw Problems.notFound('エンドポイント');
        const body = await route.handler(req, res);
        if (res.writableEnded) return;
        this.sendJson(res, 200, body ?? {});
      } catch (error) {
        this.sendError(res, error, correlationId, url.pathname, log);
      } finally {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        log.info('request completed', {
          method: req.method ?? 'UNKNOWN',
          path: url.pathname,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        });
      }
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  private sendError(
    res: ServerResponse,
    error: unknown,
    correlationId: string,
    instance: string,
    log: Logger,
  ): void {
    if (error instanceof ProblemError) {
      // 4xx は想定内。運用ログを汚さないよう info/warn に留める。
      if (error.status >= 500) log.error('request failed', error);
      else log.warn('request rejected', { statusCode: error.status, path: instance });
      const problem = error.toProblemDetails(correlationId, instance);
      res.writeHead(error.status, { 'Content-Type': 'application/problem+json; charset=utf-8' });
      res.end(JSON.stringify(problem));
      return;
    }

    // 想定外の例外。内部情報をクライアントへ返さない。
    log.error('unhandled error', error, { path: instance });
    const problem = Problems.internal().toProblemDetails(correlationId, instance);
    res.writeHead(500, { 'Content-Type': 'application/problem+json; charset=utf-8' });
    res.end(JSON.stringify(problem));
  }
}
