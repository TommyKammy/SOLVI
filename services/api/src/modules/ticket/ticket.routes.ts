import type pg from 'pg';
import { Problems, recordDomainEvent } from '@solvi/shared';
import { TicketService, type Ticket } from './ticket.service.js';
import { PoolDenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

/**
 * チケットのHTTP面 (WP-P2-PORTAL-002)。
 *
 * ここは薄い層に保つ。判断はすべて `TicketService` にあり、
 * このファイルの仕事は「入力を型に落とす」「応答の形を決める」の2つだけである。
 *
 * **応答に含める項目を明示的に選ぶ。** サービスが返す `Ticket` をそのまま
 * JSON にすると、後でフィールドを足したときに意図せず外へ出る。
 * 依頼者向けの応答には、依頼者が見てよいものだけを載せる。
 */

export interface TicketRouteDeps {
  pool: pg.Pool;
  denialRecorder: PoolDenialRecorder;
}

/** 依頼者へ返す形。内部IDや担当者の詳細は含めない。 */
function toPortalView(ticket: Ticket): Record<string, unknown> {
  return {
    id: ticket.id,
    number: ticket.number,
    kind: ticket.kind,
    state: ticket.state,
    subject: ticket.subject,
    body: ticket.body,
    impact: ticket.impact,
    urgency: ticket.urgency,
    priority: ticket.priority,
    createdAt: ticket.createdAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    // 担当者は「割り当て済みかどうか」だけを伝える。
    // 誰が担当かは依頼者にとって必要な情報ではなく、
    // 担当者の稼働状況が外から見える状態を作る必要も無い。
    assigned: ticket.assigneeId !== null,
  };
}

const KINDS = new Set(['incident', 'request']);
const IMPACTS = new Set(['low', 'medium', 'high']);
const URGENCIES = new Set(['low', 'medium', 'high']);

/** 入力の検証。**許可する値を列挙する**(拒否リストにしない)。 */
function parseCreateBody(body: unknown): {
  kind: 'incident' | 'request';
  subject: string;
  body: string;
  impact: 'low' | 'medium' | 'high';
  urgency: 'low' | 'medium' | 'high';
} {
  const errors: Array<{ field: string; message: string }> = [];
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const kind = String(record.kind ?? '');
  if (!KINDS.has(kind)) {
    errors.push({ field: 'kind', message: '種別を選んでください' });
  }

  const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
  if (subject.length === 0) {
    errors.push({ field: 'subject', message: '件名を入力してください' });
  } else if (subject.length > 200) {
    errors.push({ field: 'subject', message: '件名は200文字以内で入力してください' });
  }

  const text = typeof record.body === 'string' ? record.body.trim() : '';
  if (text.length === 0) {
    errors.push({ field: 'body', message: '内容を入力してください' });
  } else if (text.length > 10_000) {
    errors.push({ field: 'body', message: '内容は10,000文字以内で入力してください' });
  }

  const impact = String(record.impact ?? 'medium');
  if (!IMPACTS.has(impact)) {
    errors.push({ field: 'impact', message: '影響範囲を選んでください' });
  }

  const urgency = String(record.urgency ?? 'medium');
  if (!URGENCIES.has(urgency)) {
    errors.push({ field: 'urgency', message: '緊急度を選んでください' });
  }

  // **すべての誤りをまとめて返す。** 1つずつ返すと、利用者は
  // 送信のたびに次の誤りを知ることになり、往復が増える(NFR-UX-003)。
  if (errors.length > 0) throw Problems.validation(errors);

  return {
    kind: kind as 'incident' | 'request',
    subject,
    body: text,
    impact: impact as 'low' | 'medium' | 'high',
    urgency: urgency as 'low' | 'medium' | 'high',
  };
}

export class TicketController {
  constructor(private readonly deps: TicketRouteDeps) {}

  /**
   * 組織コンテキスト付きでサービスを実行する。
   *
   * `SET LOCAL app.current_org` を張るのはここ1か所。
   * 各ハンドラで書くと、1か所忘れた時点で fail-closed の0件になり、
   * 「データが無い」のか「文脈を設定し忘れた」のかが区別できなくなる。
   */
  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: TicketService) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const service = new TicketService(client, this.deps.denialRecorder);
      const out = await fn(service);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(auth: AuthenticatedRequest, body: unknown) {
    const input = parseCreateBody(body);
    const ticket = await this.run(auth, (service) => service.create(auth.authz, input));
    recordDomainEvent('ticket.created', 'success');
    return { status: 201, body: toPortalView(ticket) };
  }

  async list(auth: AuthenticatedRequest, query: URLSearchParams) {
    const limitRaw = query.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw Problems.validation([{ field: 'limit', message: '1〜100の範囲で指定してください' }]);
    }

    const result = await this.run(auth, (service) =>
      service.list(auth.authz, {
        ...(limit !== undefined ? { limit } : {}),
        // カーソルはサーバが返した文字列をそのまま受け取る。
        // クライアントで組み立てさせない(マイクロ秒が落ちてページが空になる)。
        ...(query.get('cursorCreatedAt') && query.get('cursorId')
          ? {
              cursor: {
                createdAt: query.get('cursorCreatedAt')!,
                id: query.get('cursorId')!,
              },
            }
          : {}),
      }),
    );

    return {
      status: 200,
      body: {
        items: result.items.map(toPortalView),
        total: result.total,
        nextCursor: result.nextCursor,
        // どの範囲が見えているかを明示する。依頼者は自分の分だけ、
        // 担当者は組織全体。画面側で「全件が見えている」と誤解させない。
        scope: result.scope,
      },
    };
  }

  async findById(auth: AuthenticatedRequest, ticketId: string) {
    // 権限が無いチケットは 404 になる(存在秘匿 / NFR-SEC-006)。
    // ここで 403 を返すと「そのIDは存在する」ことを教えてしまう。
    const ticket = await this.run(auth, (service) => service.findById(auth.authz, ticketId));
    return { status: 200, body: toPortalView(ticket) };
  }
}
