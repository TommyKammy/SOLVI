import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  ProblemError,
  Problems,
  correlationIdFromHeader,
  runWithContext,
  newContext,
  CORRELATION_HEADER,
  REQUEST_ID_HEADER,
  recordHttpRequest,
  withSpan,
  withRestoredTraceContext,
  type Logger,
} from '@solvi/shared';
import { randomUUID } from 'node:crypto';

/** パスパラメータ。`/tickets/:id` の `:id` に入った値。 */
export type RouteParams = Readonly<Record<string, string>>;

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: RouteParams,
) => Promise<unknown> | unknown;

interface Route {
  method: string;
  /** 登録時のパターン(`/tickets/:id`)。メトリクスとトレースにはこれを使う。 */
  path: string;
  segments: string[];
  handler: Handler;
}

/**
 * パターンと実パスの照合。
 *
 * ここで返すのは値だけで、**メトリクスやスパン名にはパターンを使う**。
 * 実IDを載せると時系列が無限に増えて監視基盤を壊す(metrics.ts の方針)。
 */
function matchPath(segments: string[], pathname: string): RouteParams | null {
  const actual = pathname.split('/').filter((s) => s.length > 0);
  if (actual.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const pattern = segments[i]!;
    const value = actual[i]!;
    if (pattern.startsWith(':')) {
      params[pattern.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (pattern !== value) return null;
  }
  return params;
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

  private register(method: string, path: string, handler: Handler): this {
    this.routes.push({
      method,
      path,
      segments: path.split('/').filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.register('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.register('POST', path, handler);
  }

  patch(path: string, handler: Handler): this {
    return this.register('PATCH', path, handler);
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

    // 受信したW3Cトレース文脈を復元してからスパンを開始する。
    // 呼び出し元(Portal や他サービス)のトレースへ繋げるため。
    const incoming: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'traceparent' || key === 'tracestate') {
        incoming[key] = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
      }
    }

    await runWithContext(context, async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      let route: Route | undefined;
      let params: RouteParams = {};
      for (const candidate of this.routes) {
        if (candidate.method !== req.method) continue;
        const matched = matchPath(candidate.segments, url.pathname);
        if (matched) {
          route = candidate;
          params = matched;
          break;
        }
      }

      // ヘルスチェックはスパンを作らない。大量に来るうえ障害解析の役に立たず、
      // 記録するとノイズでトレースが埋まる。
      const skipTrace = url.pathname === '/healthz' || url.pathname === '/readyz';

      const run = async (): Promise<void> => {
        try {
          if (!route) throw Problems.notFound('エンドポイント');
          const body = await route.handler(req, res, params);
          if (res.writableEnded) return;
          this.sendJson(res, 200, body ?? {});
        } catch (error) {
          this.sendError(res, error, correlationId, url.pathname, log);
        } finally {
          const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
          // メトリクスには**ルートパターン**を渡す。実IDを含む生パスを渡すと
          // 時系列が無限に増えて監視基盤を壊す(metrics.ts の方針)。
          recordHttpRequest({
            method: req.method ?? 'UNKNOWN',
            route: route?.path ?? '(unmatched)',
            statusCode: res.statusCode,
            durationMs,
          });
          log.info('request completed', {
            method: req.method ?? 'UNKNOWN',
            path: url.pathname,
            statusCode: res.statusCode,
            durationMs: Math.round(durationMs * 100) / 100,
          });
        }
      };

      if (skipTrace) {
        await run();
        return;
      }

      // 自動計装(instrumentation-http)は実行環境によって無言で無効になる
      // (tsx/ESM ではモジュールのパッチが効かない)。実際に検証で発覚したため、
      // アプリ側で明示的にスパンを張る。自動計装は補助であり、依存しない。
      await withRestoredTraceContext(incoming, () =>
        withSpan(
          `${req.method ?? 'UNKNOWN'} ${route?.path ?? '(unmatched)'}`,
          {
            'http.request.method': req.method ?? 'UNKNOWN',
            'http.route': route?.path ?? '(unmatched)',
            // 相関IDをスパンにも載せ、ログ・監査と突き合わせられるようにする
            'solvi.correlation_id': correlationId,
          },
          async (span) => {
            await run();
            span.setAttribute('http.response.status_code', res.statusCode);
          },
        ),
      );
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
