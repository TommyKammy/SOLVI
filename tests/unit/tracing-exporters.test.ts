/**
 * startTracing の送信先(NFR-OPS-003 / 02.13 Observability)。
 *
 * NodeSDK は、コードで渡さなかった信号を環境変数から組み立て、既定では OTLP で送る。
 * 以前は otlpEndpoint を設定しなくても localhost:4318 へトレース・メトリクス・ログを
 * 送り続けていた。モックではなく実際の SDK と受信用の HTTP サーバーで確かめる。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import {
  currentTraceId,
  startTracing,
  stopTracing,
  withSpan,
} from '../../packages/shared/src/observability/tracing.js';

const OTEL_ENV = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_TRACES_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
] as const;

let server: Server;
let baseUrl: string;
let received: string[];
let savedEnv: Partial<Record<(typeof OTEL_ENV)[number], string | undefined>>;

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // SDK の既定値(環境変数)がこのサーバーを指すようにする。
  // コードが既定値に頼っていれば、ここへ要求が届いて検出できる。
  savedEnv = Object.fromEntries(OTEL_ENV.map((k) => [k, process.env[k]]));
  for (const k of OTEL_ENV) delete process.env[k];
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = baseUrl;
});

afterEach(async () => {
  await stopTracing();
  // 次のテストで新しい Provider を登録できるよう、グローバル登録を外す。
  trace.disable();
  metrics.disable();
  propagation.disable();
  context.disable();
  for (const k of OTEL_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  server.close();
  await once(server, 'close');
});

const base = { serviceName: 'unit', serviceVersion: '1', environment: 'test' };

describe('startTracing の送信先', () => {
  it('otlpEndpoint が無ければ、トレース・メトリクス・ログのどれも送らない', async () => {
    startTracing(base);
    let traceId: string | undefined;
    await withSpan('unit.no-endpoint', {}, async () => {
      traceId = currentTraceId();
    });
    await stopTracing(); // バッチを吐き出させる

    expect(received).toEqual([]);
    // 送らなくても計装は有効で、ログへ載せる trace id は得られる。
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('otlpEndpoint があれば、トレースだけをその宛先の /v1/traces へ送る', async () => {
    // 環境変数の既定値とは別の宛先を明示しても、明示した方へ送ること。
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
    startTracing({ ...base, otlpEndpoint: baseUrl });
    await withSpan('unit.with-endpoint', {}, async () => undefined);
    await stopTracing();

    expect(received.length).toBeGreaterThan(0);
    expect(new Set(received)).toEqual(new Set(['POST /v1/traces']));
  });
});
