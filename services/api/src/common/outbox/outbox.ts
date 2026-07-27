import type pg from 'pg';
import { getContext, serializeTraceContext } from '@solvi/shared';
import { uuidv7 } from '../audit/audit.js';

/**
 * Transactional Outbox(ADR-0008)。
 *
 * 業務状態の変更と同一トランザクションでイベントを書き、別プロセスが配送する。
 * 同期送信にしないのは、DBコミットと外部作用の間で不整合が起きるため:
 *   - 通知は送ったがDBはロールバックされた → 存在しない変更を知らせてしまう
 *   - DBはコミットされたが通知は失敗した → 誰も気付かない
 *
 * 配送は at-least-once。受信側が冪等性で重複を吸収する
 * (通知は `notification_event_recipient_key` の一意制約で担保)。
 */

/** 02.17 のカタログと対応する。自由文字列を使わない。 */
export const OUTBOX_EVENT_TYPES = [
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.merged',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/**
 * ペイロードに入れてよい値。
 *
 * **本文・PII を入れない。** 配送側が必要とするのは「誰に何の件で知らせるか」であり、
 * 中身はリンク先で認証してから見せる(§10 本文最小化)。
 * 型でスカラーに限ることで、オブジェクトを丸ごと渡す実装を書けなくする。
 */
export type OutboxPayload = Record<string, string | number | boolean | null>;

export interface EnqueueInput {
  eventType: OutboxEventType;
  /** null はプラットフォーム全体のイベント */
  organizationId: string | null;
  payload: OutboxPayload;
  /** 配送を遅らせたい場合(既定は即時) */
  availableAt?: Date;
  maxAttempts?: number;
}

/**
 * イベントを登録する。
 * @param client **業務処理と同一のトランザクションクライアント**。
 *   別接続で書くと、業務がロールバックされてもイベントだけ残る。
 */
export async function enqueueOutboxEvent(
  client: pg.PoolClient | pg.Client,
  input: EnqueueInput,
): Promise<string> {
  const ctx = getContext();
  const id = uuidv7();

  // トレース文脈を保存する。配送は別プロセス・別時刻で走るため、
  // ここで運ばないと発行から配送までのトレースが分断される(02.13 §2)。
  const carrier = serializeTraceContext();

  await client.query(
    `INSERT INTO outbox_event
       (id, organization_id, event_type, payload, correlation_id, traceparent,
        available_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.organizationId,
      input.eventType,
      JSON.stringify(input.payload),
      ctx?.correlationId ?? null,
      carrier.traceparent ?? null,
      input.availableAt ?? new Date(),
      input.maxAttempts ?? 5,
    ],
  );

  return id;
}
