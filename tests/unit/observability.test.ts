/**
 * 可観測性(TL-12 / TL-16 / WP-P1-OBS-005)。
 *
 * 検証の重点は2つ。
 *   1. 非同期をまたいでもトレースが分断されないこと(Outbox経由の伝播)
 *   2. ログに秘密・本文が出ないこと。計装を足したことで新たな露出経路を作っていないこと
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { trace, context, propagation } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  withSpan,
  serializeTraceContext,
  withRestoredTraceContext,
  currentTraceId,
} from '../../packages/shared/src/observability/tracing.js';
import { Logger } from '../../packages/shared/src/logging/logger.js';
import { redactLogRecord, REDACTED } from '../../packages/shared/src/logging/redact.js';

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeAll(() => {
  // テスト用のインメモリ実装。実際のエクスポータには繋がない。
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(async () => {
  await provider.shutdown();
});

describe('トレースの伝播 (NFR-OPS-003)', () => {
  it('非同期処理をまたいでも同一spanの文脈が保たれる', async () => {
    exporter.reset();
    let inner: string | undefined;
    await withSpan('parent', {}, async () => {
      await new Promise((r) => setTimeout(r, 1));
      inner = currentTraceId();
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(inner).toBe(spans[0]!.spanContext().traceId);
  });

  it('**Outbox経由でトレース文脈を運べる**(プロセスをまたいだ追跡)', async () => {
    exporter.reset();
    // 送信側: API がイベントを書くときに文脈をシリアライズする
    let carrier: Record<string, string> = {};
    let producerTraceId: string | undefined;
    await withSpan('api.create_ticket', {}, async () => {
      producerTraceId = currentTraceId();
      carrier = serializeTraceContext();
    });

    expect(carrier.traceparent).toBeDefined();
    expect(carrier.traceparent).toContain(producerTraceId!);

    // 受信側: Worker が別プロセス・別時刻でイベントを処理する
    let consumerTraceId: string | undefined;
    await withRestoredTraceContext(carrier, async () => {
      await withSpan('worker.dispatch', {}, async () => {
        consumerTraceId = currentTraceId();
      });
    });

    // 同一のtrace idで繋がっていること。これが切れると
    // 「申請は成功したが実行されていない」場合の追跡ができなくなる。
    expect(consumerTraceId).toBe(producerTraceId);
  });

  it('文脈がない場合も処理は実行される(トレースの有無で挙動を変えない)', async () => {
    let ran = false;
    await withRestoredTraceContext(null, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await withRestoredTraceContext({}, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('例外はspanに記録されたうえで再送出される(握りつぶさない)', async () => {
    exporter.reset();
    await expect(
      withSpan('failing', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(2); // ERROR
    expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('トレースが有効でないときは trace id を返さない', () => {
    // アクティブなスパンがない状態
    const id = context.with(
      trace.setSpan(
        context.active(),
        trace.wrapSpanContext({
          traceId: '00000000000000000000000000000000',
          spanId: '0000000000000000',
          traceFlags: 0,
        }),
      ),
      () => currentTraceId(),
    );
    expect(id).toBeUndefined();
  });
});

describe('ログとトレースの突き合わせ', () => {
  const capture = () => {
    const lines: string[] = [];
    return {
      lines,
      logger: new Logger({
        service: 'test',
        level: 'info',
        env: 'test',
        sink: (l) => lines.push(l),
      }),
    };
  };

  it('スパン内のログに trace id が載る', async () => {
    const { lines, logger } = capture();
    await withSpan('op', {}, async () => {
      logger.info('inside span');
    });
    const record = JSON.parse(lines[0]!);
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('スパン外のログには trace id が載らない(全ゼロを書かない)', () => {
    const { lines, logger } = capture();
    logger.info('outside span');
    expect(JSON.parse(lines[0]!).traceId).toBeUndefined();
  });
});

describe('計装が新たな露出経路を作っていないこと (NFR-SEC-004 / 脅威 T-22)', () => {
  it('traceId は許可されるが、それ以外の新規キーは落ちる', () => {
    const out = redactLogRecord({
      traceId: 'abc123',
      spanId: 'def456',
      // 計装が付けそうな属性のうち、許可していないもの
      'http.request.header.authorization': 'Bearer secret',
      dbStatement: 'SELECT * FROM ticket WHERE body = ...',
    });
    expect(out.traceId).toBe('abc123');
    expect(out.spanId).toBe('def456');
    expect(Object.keys(out)).not.toContain('http.request.header.authorization');
    expect(Object.keys(out)).not.toContain('dbStatement');
  });

  it('traceId の値に秘密らしい文字列が来たら落とす', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
    expect(redactLogRecord({ traceId: jwt }).traceId).toBe(REDACTED);
  });

  it('スパン属性にチケット本文を入れないこと(規約の明示)', async () => {
    exporter.reset();
    await withSpan(
      'ticket.create',
      { 'ticket.kind': 'incident', 'ticket.priority': 'high' },
      async () => {},
    );
    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    // 分類はよいが、本文・件名は入れない
    expect(attrs['ticket.kind']).toBe('incident');
    expect(Object.keys(attrs)).not.toContain('ticket.subject');
    expect(Object.keys(attrs)).not.toContain('ticket.body');
  });
});
