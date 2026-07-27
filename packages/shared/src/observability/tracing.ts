import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, context, propagation, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * 分散トレース(NFR-OPS-003 / 02.13 Observability)。
 *
 * 目的は「障害時に、1つの業務フローがどこで止まったかを追えること」。
 * SOLVIは Portal → API → Outbox → Worker → Executor と非同期をまたぐため、
 * HTTPの自動計装だけでは切れる。Outboxを渡るときにトレース文脈を明示的に運ぶ。
 *
 * 監査との関係: トレースは**運用の道具であり監査の正本ではない**(ADR-0009)。
 * サンプリングで欠落しうるし保持期間も短い。証跡は audit_event を見る。
 */

export interface TracingOptions {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  /** 未設定ならエクスポータを繋がず、計装だけ有効にする(ローカル最小構成) */
  otlpEndpoint?: string | undefined;
}

let sdk: NodeSDK | undefined;

export function startTracing(options: TracingOptions): void {
  if (sdk) return; // 二重初期化を防ぐ

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion,
    'deployment.environment.name': options.environment,
    'service.namespace': 'solvi',
  });

  sdk = new NodeSDK({
    resource,
    ...(options.otlpEndpoint
      ? { traceExporter: new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` }) }
      : {}),
    instrumentations: [
      new HttpInstrumentation({
        // ヘルスチェックは大量に来るうえ、障害解析の役に立たない。
        // 記録するとノイズでトレースが埋まる。
        ignoreIncomingRequestHook: (req) =>
          req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
      }),
      // SQLは文をそのまま属性に載せない。値がバインドされる前でも、
      // クエリ文から業務内容が推測できる場合がある。
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });

  sdk.start();
}

export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

const tracer = () => trace.getTracer('solvi');

/**
 * 業務上の意味を持つ処理をスパンで囲う。
 *
 * 例外はスパンに記録して再送出する。握りつぶすと、
 * トレース上は成功したように見えて実際は失敗している状態が生まれる。
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.name : 'UnknownError',
      });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * 現在のトレース文脈をシリアライズする(W3C traceparent)。
 *
 * Outbox経由の非同期処理は別プロセス・別時刻で走るため、
 * ここで取り出した値をイベントに載せ、受信側で復元する。
 * これをしないと、申請から実行までのトレースが分断される。
 */
export function serializeTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** シリアライズされたトレース文脈を復元して処理を実行する。 */
export async function withRestoredTraceContext<T>(
  carrier: Record<string, string> | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!carrier || Object.keys(carrier).length === 0) return fn();
  const restored = propagation.extract(context.active(), carrier);
  return context.with(restored, fn);
}

/** 現在のtrace idを返す。ログへ載せてトレースと突き合わせるために使う。 */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const id = span?.spanContext().traceId;
  // 全ゼロは「トレースが有効でない」ことを示す。ログに載せても意味がない。
  return id && /[1-9a-f]/.test(id) ? id : undefined;
}
