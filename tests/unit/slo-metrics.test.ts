/**
 * SLOメトリクスの記録 (WP-P2-SLO-008 / TL-15)。
 *
 * 検証の重点は「値が正しいこと」より **「そもそも記録されていること」**。
 *
 * WP-P1-OBS-005 は計器を定義したが MeterProvider を繋いでおらず、
 * `metrics.getMeter()` が NoopMeterProvider を返すため、
 * すべての記録呼び出しが黙って捨てられていた。例外も警告も出ない。
 *
 * このファイルは実物の MeterProvider を立てて、記録が読み出せることを確かめる。
 * ただし**それだけでは足りない**。単体テストは自前のリーダーを使うため、
 * 本番の配線が切れていても緑になる。本番経路の確認は
 * `tools/verify_slo_pipeline.mjs`(稼働中スタックに対して実行)が担う。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import {
  recordHttpRequest,
  recordOutboxLag,
  recordAuthzDenial,
  recordDomainEvent,
} from '../../packages/shared/src/observability/metrics.js';

let provider: MeterProvider;
let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;

beforeAll(() => {
  // DELTA を使う。CUMULATIVE だと前のテストで積んだ値が次の収集にも乗り、
  // テストの順序に依存して壊れる(実際に壊れた)。
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  reader = new PeriodicExportingMetricReader({
    exporter,
    // テストからは collect() を明示的に呼ぶ。周期エクスポートに頼ると
    // 待ち時間の当て推量になり、遅いマシンで不安定になる。
    exportIntervalMillis: 600_000,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

beforeEach(() => {
  exporter.reset();
});

/** 記録済みのメトリクスを名前で引く。 */
async function collect(name: string) {
  await reader.forceFlush();
  const batches = exporter.getMetrics();
  const all = batches.flatMap((b) => b.scopeMetrics.flatMap((s) => s.metrics));
  return all.find((m) => m.descriptor.name === name);
}

describe('計器が実際に記録される', () => {
  it('HTTPリクエストが記録される', async () => {
    recordHttpRequest({ method: 'GET', route: '/tickets', statusCode: 200, durationMs: 12 });

    const counter = await collect('solvi.http.requests');
    expect(counter, 'solvi.http.requests が1件も記録されていない').toBeDefined();
    expect(counter!.dataPoints.length).toBeGreaterThan(0);
    expect(counter!.dataPoints[0].value).toBe(1);
  });

  it('処理時間がヒストグラムに記録される', async () => {
    recordHttpRequest({ method: 'GET', route: '/tickets', statusCode: 200, durationMs: 42 });

    const histogram = await collect('solvi.http.duration');
    expect(histogram, 'solvi.http.duration が1件も記録されていない').toBeDefined();
    const point = histogram!.dataPoints[0].value as { count: number; sum?: number };
    expect(point.count).toBe(1);
    expect(point.sum).toBe(42);
  });

  it('Outbox遅延が記録される', async () => {
    recordOutboxLag('ticket.created', 3.5);

    const histogram = await collect('solvi.outbox.lag');
    expect(histogram, 'solvi.outbox.lag が1件も記録されていない').toBeDefined();
    const point = histogram!.dataPoints[0].value as { count: number; sum?: number };
    expect(point.sum).toBe(3.5);
  });

  it('認可拒否が記録される', async () => {
    recordAuthzDenial('ticket.read');

    const counter = await collect('solvi.authz.denials');
    expect(counter, 'solvi.authz.denials が1件も記録されていない').toBeDefined();
    expect(counter!.dataPoints[0].value).toBe(1);
  });

  it('業務イベントが記録される', async () => {
    recordDomainEvent('ticket.created', 'success');

    const counter = await collect('solvi.domain.events');
    expect(counter, 'solvi.domain.events が1件も記録されていない').toBeDefined();
  });
});

describe('SLIの分母を汚さない', () => {
  // ヘルスチェックは高頻度・常に高速・常に成功する。混ぜると
  // 可用性が水増しされ、レイテンシのp95が薄まる。
  // 利用者が1件も成功していなくても、可用性99.9%と表示されうる。
  it.each(['/healthz', '/readyz', '/metrics'])('%s は SLI の系列に入らない', async (route) => {
    recordHttpRequest({ method: 'GET', route, statusCode: 200, durationMs: 1 });

    const counter = await collect('solvi.http.requests');
    const routes = (counter?.dataPoints ?? []).map((p) => p.attributes['http.route']);
    expect(routes).not.toContain(route);
  });

  it('業務ルートは除外されない', async () => {
    recordHttpRequest({ method: 'GET', route: '/tickets', statusCode: 200, durationMs: 1 });

    const counter = await collect('solvi.http.requests');
    const routes = (counter?.dataPoints ?? []).map((p) => p.attributes['http.route']);
    expect(routes).toContain('/tickets');
  });
});

describe('ラベルのカーディナリティ', () => {
  // ticket_id や user_id をラベルに入れると時系列が無限に増えて監視基盤を壊す。
  // 同時に、アラート本文へ業務情報が載る経路にもなる。
  // カーディナリティ対策と情報漏えい対策が同じ設計で両立している。
  it('ステータスコードは階級で持つ(個別コードを持たない)', async () => {
    for (const code of [500, 502, 503]) {
      recordHttpRequest({ method: 'GET', route: '/tickets', statusCode: code, durationMs: 1 });
    }

    const counter = await collect('solvi.http.requests');
    const classes = new Set(
      (counter?.dataPoints ?? []).map((p) => p.attributes['http.status_class']),
    );
    // 500/502/503 が3系列に分かれず、5xx の1系列に集約される
    expect(classes).toContain('5xx');
    const fivexx = (counter?.dataPoints ?? []).filter(
      (p) => p.attributes['http.status_class'] === '5xx',
    );
    expect(fivexx).toHaveLength(1);
    expect(fivexx[0].value).toBe(3);
  });

  it('属性に識別子が含まれない', async () => {
    recordHttpRequest({ method: 'GET', route: '/tickets/:id', statusCode: 200, durationMs: 1 });

    const counter = await collect('solvi.http.requests');
    const keys = Object.keys(counter?.dataPoints[0].attributes ?? {});
    for (const forbidden of ['ticket.id', 'user.id', 'organization.id', 'correlation.id']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
