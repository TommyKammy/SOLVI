import { metrics, type Counter, type Histogram, type ObservableGauge } from '@opentelemetry/api';

/**
 * メトリクス(NFR-OPS-001 / NFR-PERF-001 / 02.13)。
 *
 * 何を測るかの方針: **SLOの判定に使えるものだけを定義する。**
 * 「あると便利そう」で増やすと、どれを見て判断するのかが曖昧になり、
 * 結果としてどれも見られなくなる。
 *
 * 属性(ラベル)にはカーディナリティの低い値だけを入れる。
 * ticket_id や user_id を入れると時系列が無限に増え、監視基盤を壊す。
 * 個別の追跡はトレースと監査イベントの役割。
 */

const meter = () => metrics.getMeter('solvi');

let instruments: Instruments | undefined;

interface Instruments {
  httpRequests: Counter;
  httpDuration: Histogram;
  outboxLag: Histogram;
  domainEvents: Counter;
  authzDenials: Counter;
}

function getInstruments(): Instruments {
  if (instruments) return instruments;
  const m = meter();
  instruments = {
    httpRequests: m.createCounter('solvi.http.requests', {
      description: 'HTTPリクエスト数',
    }),
    httpDuration: m.createHistogram('solvi.http.duration', {
      description: 'HTTPリクエストの処理時間',
      unit: 'ms',
    }),
    outboxLag: m.createHistogram('solvi.outbox.lag', {
      description: 'Outboxイベントの発行から処理開始までの遅延(NFR-PERF-003)',
      unit: 's',
    }),
    domainEvents: m.createCounter('solvi.domain.events', {
      description: '業務イベントの発生数(チケット作成・遷移など)',
    }),
    authzDenials: m.createCounter('solvi.authz.denials', {
      description: '認可拒否の発生数。急増は攻撃または権限設定の誤りを示す',
    }),
  };
  return instruments;
}

/**
 * SLOの分母に入れないルート。
 *
 * ヘルスチェックは高頻度で、かつ常に速く常に成功する。SLOの系列に混ぜると
 * **可用性を水増しし、レイテンシのp95を薄める**。利用者が1件も成功していなくても、
 * ヘルスチェックが毎秒通っていれば可用性99.9%と表示されてしまう。
 *
 * 「クエリ側でフィルタすればよい」ではなく記録側で落とすのは、
 * 新しいダッシュボードやアラートを書く人がフィルタを忘れた時点で
 * 数字が静かに嘘になるため。除外を1か所に閉じる。
 *
 * ヘルスチェック自体の失敗は Prometheus の `up` とコンテナの healthcheck で見る。
 */
const SLO_EXCLUDED_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * HTTPリクエストの記録。
 * @param route ルートパターン(`/tickets/:id`)。実IDを含む生パスを渡さないこと。
 */
export function recordHttpRequest(params: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}): void {
  if (SLO_EXCLUDED_ROUTES.has(params.route)) return;

  const attributes = {
    'http.method': params.method,
    'http.route': params.route,
    // ステータスコードそのものではなく階級で持つ。
    // 個別コードは時系列を増やすわりに、判断は 2xx/4xx/5xx の別で足りる。
    'http.status_class': `${Math.floor(params.statusCode / 100)}xx`,
  };
  const i = getInstruments();
  i.httpRequests.add(1, attributes);
  i.httpDuration.record(params.durationMs, attributes);
}

/** Outboxの配送遅延。滞留の検知に使う(NFR-PERF-003: p95 30秒)。 */
export function recordOutboxLag(eventType: string, lagSeconds: number): void {
  getInstruments().outboxLag.record(lagSeconds, { 'event.type': eventType });
}

/** 業務イベント。ticket.created / ticket.transitioned など。 */
export function recordDomainEvent(eventType: string, outcome: 'success' | 'failure'): void {
  getInstruments().domainEvents.add(1, { 'event.type': eventType, outcome });
}

/**
 * 認可拒否。急増は攻撃または権限設定の誤りを示す。
 * 誰が拒否されたかは属性に入れない(カーディナリティと個人情報の両方の理由)。
 */
export function recordAuthzDenial(rule: string): void {
  getInstruments().authzDenials.add(1, { rule });
}

/**
 * ゲージの登録。値の取得は監視側からの問い合わせ時に実行される。
 * @param collect 現在値を返す関数。DBへの問い合わせを含む場合は軽量に保つこと。
 */
export function registerGauge(
  name: string,
  description: string,
  collect: () => Promise<number>,
): ObservableGauge {
  const gauge = meter().createObservableGauge(name, { description });
  gauge.addCallback(async (result) => {
    try {
      result.observe(await collect());
    } catch {
      // 監視の失敗でアプリを止めない。値が欠けることは監視側で検知できる。
    }
  });
  return gauge;
}

/** テスト用。インストゥルメントのキャッシュを捨てる。 */
export function resetInstrumentsForTest(): void {
  instruments = undefined;
}
