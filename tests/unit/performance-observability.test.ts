import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { Database } from '../../services/api/src/common/db/pool.js';
import { HttpServer } from '../../services/api/src/common/http/server.js';
import { apiEnvSchema } from '../../packages/shared/src/config/env.js';
import { startTracing, stopTracing } from '../../packages/shared/src/observability/tracing.js';
import { createLogger } from '@solvi/shared';

const tracingMocks = vi.hoisted(() => ({
  exporters: [] as Record<string, unknown>[],
  start: vi.fn(),
  shutdown: vi.fn(async () => undefined),
}));

// Verify exporter configuration without opening an extra listener or sending OTLP.
vi.mock('@opentelemetry/exporter-prometheus', () => ({
  PrometheusExporter: class {
    constructor(options: Record<string, unknown>) {
      tracingMocks.exporters.push(options);
    }
  },
}));
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start = tracingMocks.start;
    shutdown = tracingMocks.shutdown;
  },
}));

/** A socket-free client; the real pg.Pool still owns queues, timeouts and release. */
class SyntheticClient extends EventEmitter {
  static nextConnectError: Error | undefined;
  static statements: string[] = [];
  _queryable = true;
  _ending = false;

  connect(callback: (error?: Error) => void): void {
    const error = SyntheticClient.nextConnectError;
    SyntheticClient.nextConnectError = undefined;
    queueMicrotask(() => callback(error));
  }

  query(
    sql: string,
    _values?: unknown[],
    callback?: (error: Error | null, result: pg.QueryResult) => void,
  ): Promise<pg.QueryResult> | void {
    SyntheticClient.statements.push(sql);
    const result = { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [{ ok: 1 }] };
    if (callback) queueMicrotask(() => callback(null, result));
    else return Promise.resolve(result);
  }

  end(callback?: () => void): void {
    this._ending = true;
    queueMicrotask(() => {
      this.emit('end');
      callback?.();
    });
  }

  ref(): void {}
  unref(): void {}
}

const logger = createLogger({ service: 'performance-unit', level: 'error', env: 'test' });
const databases = new Set<Database>();
let provider: MeterProvider;
let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;

beforeAll(() => {
  metrics.disable();
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
});

beforeEach(async () => {
  // Finish the prior delta interval through the reader's normal lifecycle.
  await reader.forceFlush();
  exporter.reset();
  SyntheticClient.nextConnectError = undefined;
  SyntheticClient.statements = [];
  tracingMocks.exporters.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...databases].map((database) => database.close()));
  databases.clear();
  await stopTracing();
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

function database(config: pg.PoolConfig = {}): Database {
  const result = new Database('postgres://fixture:fixture@127.0.0.1/unused', logger, {
    Client: SyntheticClient as unknown as NonNullable<pg.PoolConfig['Client']>,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 100,
    ...config,
  });
  databases.add(result);
  return result;
}

async function collect() {
  exporter.reset();
  await reader.forceFlush();
  return exporter
    .getMetrics()
    .flatMap((batch) => batch.scopeMetrics.flatMap((scope) => scope.metrics));
}

const acquireName = 'solvi.db.pool.acquire.duration';

function firstPoint(metric: MetricData | undefined) {
  const point = metric?.dataPoints[0];
  if (!point) throw new Error('Expected an exported metric data point');
  return point;
}

describe('API pool observability with real pg.Pool lifecycle', () => {
  it('observes occupied, waiting and released connections without database identifiers', async () => {
    const db = database();
    const pool = db.authPool();
    const first = await pool.connect();
    const queued = pool.connect();
    expect(pool.waitingCount).toBe(1);
    const waiting = await collect();
    for (const [key, expected] of Object.entries({ total: 1, idle: 0, waiting: 1 })) {
      const point = firstPoint(
        waiting.find((m) => m.descriptor.name.endsWith(`connections.${key}`)),
      );
      expect(point.value).toBe(expected);
      expect(point.attributes).toEqual({});
    }
    first.release();
    const second = await queued;
    second.release();
    const released = await collect();
    expect(
      firstPoint(released.find((m) => m.descriptor.name.endsWith('connections.idle'))).value,
    ).toBe(1);
    expect(
      firstPoint(released.find((m) => m.descriptor.name.endsWith('connections.waiting'))).value,
    ).toBe(0);
    const acquisition = released.find((m) => m.descriptor.name === acquireName)!;
    expect(acquisition.descriptor.unit).toBe('ms');
    expect(firstPoint(acquisition).attributes).toEqual({ outcome: 'success' });
  });

  it('records queued acquisition timeout as failure and retains the original rejection', async () => {
    const db = database({ connectionTimeoutMillis: 20 });
    const held = await db.authPool().connect();
    try {
      await expect(db.authPool().connect()).rejects.toThrow('timeout exceeded');
      const recorded = await collect();
      const failure = recorded
        .find((m) => m.descriptor.name === acquireName)!
        .dataPoints.find((point) => point.attributes.outcome === 'failure')!;
      expect(failure.attributes).toEqual({ outcome: 'failure' });
      expect(failure.value).toMatchObject({ count: 1 });
      expect((failure.value as { sum: number }).sum).toBeGreaterThan(0);
      expect(db.authPool().waitingCount).toBe(0);
    } finally {
      held.release();
    }
  });

  it('records connection failure through both promise and callback paths without error details', async () => {
    const db = database();
    const failure = new Error('sensitive diagnostic must not be a metric label');
    SyntheticClient.nextConnectError = failure;
    await expect(db.ping()).rejects.toBe(failure);
    SyntheticClient.nextConnectError = failure;
    await new Promise<void>((resolve, reject) => {
      db.authPool().connect((error, client) => {
        try {
          expect(error).toBe(failure);
          expect(client).toBeUndefined();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const recorded = await collect();
    const point = firstPoint(recorded.find((m) => m.descriptor.name === acquireName));
    expect(point.attributes).toEqual({ outcome: 'failure' });
    expect(point.value).toMatchObject({ count: 2 });
    expect(JSON.stringify(recorded)).not.toContain(failure.message);
  });

  it('covers implicit pool.query acquisition and callback release without changing results', async () => {
    const db = database();
    expect((await db.queryOutsideOrgScope('SELECT 1')).rows).toEqual([{ ok: 1 }]);
    expect((await db.authPool().query('SELECT 1')).rowCount).toBe(1);
    await new Promise<void>((resolve, reject) => {
      db.authPool().connect((error, client, release) => {
        if (error || !client) return reject(error ?? new Error('missing client'));
        release();
        resolve();
      });
    });
    expect(db.authPool().idleCount).toBe(1);
    const recorded = await collect();
    expect(firstPoint(recorded.find((m) => m.descriptor.name === acquireName)).value).toMatchObject(
      { count: 3 },
    );
  });

  it('retains rollback and release on business failure; acquisition remains successful', async () => {
    const db = database();
    const failure = new Error('operation failed');
    await expect(
      db.withOrgTransaction({ organizationId: 'synthetic-org' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(SyntheticClient.statements).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'ROLLBACK',
    ]);
    expect(db.authPool().idleCount).toBe(1);
    const recorded = await collect();
    expect(firstPoint(recorded.find((m) => m.descriptor.name === acquireName)).attributes).toEqual({
      outcome: 'success',
    });
  });

  it('aggregates multiple pools and unregisters their observations on close', async () => {
    const first = database();
    const second = database();
    await first.ping();
    await second.ping();
    let recorded = await collect();
    expect(
      firstPoint(recorded.find((m) => m.descriptor.name.endsWith('connections.total'))).value,
    ).toBe(2);
    await first.close();
    databases.delete(first);
    recorded = await collect();
    expect(
      firstPoint(recorded.find((m) => m.descriptor.name.endsWith('connections.total'))).value,
    ).toBe(1);
    await second.close();
    databases.delete(second);
    recorded = await collect();
    expect(
      firstPoint(recorded.find((m) => m.descriptor.name.endsWith('connections.total'))).value,
    ).toBe(0);
  });

  it('removes observation callbacks even when closing the pool fails', async () => {
    const db = database();
    const pool = db.authPool();
    const failure = new Error('close failed');
    vi.spyOn(pool, 'end').mockRejectedValueOnce(failure);
    await expect(db.close()).rejects.toBe(failure);
    vi.spyOn(pool, 'totalCount', 'get').mockImplementation(() => {
      throw new Error('closed pool must not be observed');
    });
    const recorded = await collect();
    expect(
      firstPoint(recorded.find((m) => m.descriptor.name.endsWith('connections.total'))).value,
    ).toBe(0);
  });
});

const minimalEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1/unused',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'local',
  S3_BUCKET_ATTACHMENTS: 'attachments',
  S3_BUCKET_AUDIT_ANCHOR: 'audit',
  S3_ACCESS_KEY: 'synthetic',
  S3_SECRET_KEY: 'synthetic',
};

describe('optional explicit listener hosts', () => {
  it('keeps hosts unspecified by default and accepts IP/hostname bind values', () => {
    const defaults = apiEnvSchema.parse(minimalEnv);
    expect(defaults.API_HOST).toBeUndefined();
    expect(defaults.METRICS_HOST).toBeUndefined();
    for (const host of ['127.0.0.1', '::1', '0.0.0.0', 'localhost', 'api.internal']) {
      const parsed = apiEnvSchema.parse({ ...minimalEnv, API_HOST: host, METRICS_HOST: host });
      expect(parsed.API_HOST).toBe(host);
      expect(parsed.METRICS_HOST).toBe(host);
    }
  });

  it.each(['', ' ', 'http://127.0.0.1', '127.0.0.1:3001', 'x/y', 'a..b', '-host'])(
    'rejects malformed bind value %j',
    (host) => {
      expect(apiEnvSchema.safeParse({ ...minimalEnv, API_HOST: host }).success).toBe(false);
      expect(apiEnvSchema.safeParse({ ...minimalEnv, METRICS_HOST: host }).success).toBe(false);
    },
  );

  it('does not weaken production local-auth prohibition when hosts are specified', () => {
    const result = apiEnvSchema.safeParse({
      ...minimalEnv,
      NODE_ENV: 'production',
      AUTH_LOCAL_ENABLED: 'true',
      API_HOST: '127.0.0.1',
      METRICS_HOST: '127.0.0.1',
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path.includes('AUTH_LOCAL_ENABLED'))).toBe(
        true,
      );
  });

  it('binds the real HTTP listener on loopback and serves a request', async () => {
    const app = new HttpServer(logger);
    app.get('/probe', () => ({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${address.port}/probe`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('preserves the wildcard listener when host is unspecified', async () => {
    const app = new HttpServer(logger);
    const server = app.listen(0);
    try {
      await once(server, 'listening');
      expect(['::', '0.0.0.0']).toContain((server.address() as AddressInfo).address);
    } finally {
      await app.close();
    }
  });

  it('passes explicit metrics host to the exporter and leaves its default untouched', async () => {
    const options = {
      serviceName: 'unit',
      serviceVersion: '1',
      environment: 'test',
      metricsPort: 9464,
    };
    startTracing({ ...options, metricsHost: '127.0.0.1' });
    expect(tracingMocks.exporters[0]).toEqual({
      host: '127.0.0.1',
      port: 9464,
      endpoint: '/metrics',
    });
    await stopTracing();
    expect(tracingMocks.shutdown).toHaveBeenCalledTimes(1);
    startTracing(options);
    expect(tracingMocks.exporters[1]).toEqual({ port: 9464, endpoint: '/metrics' });
  });
});
