import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * 1つの業務フローを横断して追跡するための識別子(NFR-OPS-003)。
 *
 * correlationId は Portal のリクエストから API → Outbox → Worker → Executor → 監査まで
 * 引き回す。requestId は個々のHTTPリクエストに閉じる。
 */
export interface RequestContext {
  correlationId: string;
  requestId: string;
  organizationId?: string;
  actorId?: string;
  actorType?: 'user' | 'system' | 'scim_client' | 'executor' | 'ai';
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** 文脈がない場所(バッチの起点など)で新しい相関IDを作る */
export function newContext(partial: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: partial.correlationId ?? randomUUID(),
    requestId: partial.requestId ?? randomUUID(),
    ...partial,
  };
}

export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * 受信ヘッダから相関IDを取り出す。
 * 外部から渡された値をそのまま信用せず、形式が想定外なら新規採番する
 * (ログ・監査のフィールドへ任意文字列を注入されるのを防ぐ)。
 */
export function correlationIdFromHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw && /^[A-Za-z0-9-]{8,64}$/.test(raw)) return raw;
  return randomUUID();
}
