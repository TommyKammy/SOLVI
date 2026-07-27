import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getContext, scrubFreeText } from '@solvi/shared';

/**
 * 監査イベントの記録(ADR-0009 / 02.17 Audit Event Catalog)。
 *
 * 重要な設計判断:
 *  - **業務トランザクションと同一のクライアント**で書く。監査だけ別接続にすると、
 *    業務がコミットされて監査が失われる(またはその逆)状態が生まれる。
 *  - **監査の書き込みに失敗したら業務処理も失敗させる**。証跡なしで状態を変えない。
 *  - before/after には redact 済みの値だけを入れる。本文は参照とハッシュに留める。
 */

/** 02.17 §2 のカタログ。ここにない値は使えない(自由文字列を許さない)。 */
export const AUDIT_EVENT_TYPES = [
  // Phase 1(Gate 1 G1-4 の判定対象)
  'auth.login.success',
  'auth.login.denied',
  'auth.session.revoked',
  'authz.access.denied',
  'org.member.added',
  'org.member.removed',
  'role.binding.created',
  'role.binding.deleted',
  'user.created',
  'user.updated',
  'user.deactivated',
  'audit.export.executed',
  'config.changed',
  // 組織切替(02.18 §3 / 脅威 T-20)
  'platform.org_context.switched',
  // Phase 2(WP-P2-TKT-001)
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.comment.added',
  'ticket.attachment.added',
  'ticket.attachment.downloaded',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type ActorType = 'user' | 'system' | 'scim_client' | 'executor' | 'ai';
export type Outcome = 'success' | 'denied' | 'failure';

export interface AuditEventInput {
  eventType: AuditEventType;
  /** null はプラットフォーム全体のイベント */
  organizationId: string | null;
  actorType: ActorType;
  actorId?: string | null;
  actorDisplay?: string | null;
  subjectUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  action: string;
  outcome: Outcome;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  sourceIp?: string | null;
  userAgent?: string | null;
  /** outcome が 'denied' のときは必須(DB制約でも強制) */
  policyDecision?: Record<string, unknown> | null;
  workflowRunId?: string | null;
  approvalRef?: string | null;
  receiptRef?: string | null;
}

/**
 * before/after に入れてよい値の型。
 * ネストしたオブジェクトを丸ごと入れることを型で抑止する ―
 * 監査に構造体を流し込むと、いつのまにか本文やPIIが混ざる。
 */
type AuditScalar = string | number | boolean | null;

/** 状態の差分を、スカラー値だけの平坦なオブジェクトへ整える。 */
export function auditState(
  input: Record<string, unknown> | null | undefined,
): Record<string, AuditScalar> | null {
  if (!input) return null;
  const out: Record<string, AuditScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === 'string') {
      out[key] = scrubFreeText(value, 200);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    } else {
      // 構造体は値を入れず、型だけを残す。中身が必要なら明示的に平坦化すること。
      out[key] = `[${Array.isArray(value) ? 'array' : 'object'} omitted]`;
    }
  }
  return out;
}

export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super(`監査イベントの記録に失敗しました: ${cause instanceof Error ? cause.message : cause}`);
    this.name = 'AuditWriteError';
  }
}

/**
 * uuid v7(RFC 9562)。時刻順に単調増加するIDを採番する。
 *
 * 同一ミリ秒内でも順序が保たれることが重要:
 * 日次アンカーの連鎖ハッシュは event_id 順にイベントを並べて計算するため
 * (services/worker/src/jobs/audit-anchor/anchor.ts)、順序が非決定的だと
 * 同じデータから別のルートハッシュが出てしまい、改ざん検知が機能しない。
 * そのため rand_a(12bit)を同一ミリ秒内の単調カウンタとして使う。
 */
let lastTimestamp = 0;
let sequence = 0;
const MAX_SEQUENCE = 0x0fff; // 12bit

export function uuidv7(): string {
  let ts = Date.now();

  if (ts === lastTimestamp) {
    sequence += 1;
    if (sequence > MAX_SEQUENCE) {
      // 1ミリ秒あたり4096件を超えた場合は次のミリ秒へ繰り上げる。
      // 実時刻より僅かに先行するが、順序の一貫性を優先する。
      ts = lastTimestamp + 1;
      sequence = 0;
    }
  } else if (ts > lastTimestamp) {
    sequence = 0;
  } else {
    // 時計が巻き戻った(NTP調整など)。IDの後退を避けるため直前の時刻を維持する。
    ts = lastTimestamp;
    sequence += 1;
  }
  lastTimestamp = ts;

  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ts, 0, 6);
  // version(4bit) + sequence上位4bit
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  // 残り62bitは乱数。variant(2bit)を設定する。
  const rand = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  rand.copy(bytes, 8, 8, 16);
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 監査イベントを記録する。
 * @param client 業務処理と同一のトランザクションクライアント
 */
export async function recordAuditEvent(
  client: pg.PoolClient | pg.Client,
  input: AuditEventInput,
): Promise<string> {
  const ctx = getContext();
  const eventId = uuidv7();

  if (input.outcome === 'denied' && !input.policyDecision) {
    // 「なぜ拒否したか」が残らない監査は説明に使えない。DB制約より前に開発時点で気付かせる。
    throw new AuditWriteError('outcome=denied のイベントには policyDecision が必要です');
  }

  try {
    await client.query(
      `INSERT INTO audit_event (
         event_id, event_type, organization_id,
         actor_type, actor_id, actor_display, subject_user_id,
         target_type, target_id, action, outcome,
         before_state, after_state,
         correlation_id, request_id, workflow_run_id,
         source_ip, user_agent, policy_decision, approval_ref, receipt_ref
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
       )`,
      [
        eventId,
        input.eventType,
        input.organizationId,
        input.actorType,
        input.actorId ?? null,
        input.actorDisplay ?? null,
        input.subjectUserId ?? null,
        input.targetType ?? null,
        input.targetId ?? null,
        input.action,
        input.outcome,
        auditState(input.beforeState),
        auditState(input.afterState),
        ctx?.correlationId ?? null,
        ctx?.requestId ?? null,
        input.workflowRunId ?? null,
        input.sourceIp ?? null,
        input.userAgent ? scrubFreeText(input.userAgent, 300) : null,
        input.policyDecision ?? null,
        input.approvalRef ?? null,
        input.receiptRef ?? null,
      ],
    );
    return eventId;
  } catch (error) {
    // 呼び出し側のトランザクションを巻き戻させる。監査なしで状態変更を成立させない。
    throw new AuditWriteError(error);
  }
}
