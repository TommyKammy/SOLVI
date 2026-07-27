import type pg from 'pg';
import { Problems, recordDomainEvent, allowedTransitionsFrom } from '@solvi/shared';
import { TicketService } from './ticket.service.js';
import { CollaborationService, type TicketComment } from './collaboration.service.js';
import type { ObjectStorage } from '@solvi/shared';
import type { PoolDenialRecorder } from '../../common/audit/denial-recorder.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';

/**
 * コメントと担当者操作のHTTP面 (WP-P2-OPSUI-010)。
 *
 * **画面が出さないことを防御にしない。**
 *
 * 画面側では「実行できない操作をボタンとして出さない」設計にするが、
 * それは使いやすさのためであって安全のためではない。APIは直接叩ける。
 * ここで必ず拒否する。画面の作りが変わっても、この層が変わらなければ安全は保たれる。
 */

export interface CollaborationRouteDeps {
  pool: pg.Pool;
  storage: ObjectStorage;
  denialRecorder: PoolDenialRecorder;
}

/** 担当者が「いま何ができるか」。画面のボタン表示に使う。 */
export interface AvailableAction {
  to: string;
  reason: string;
  label: string;
}

/**
 * 遷移の表示名。
 *
 * 状態名ではなく**行動**で書く。「in_progress にする」ではなく「対応を始める」。
 * 担当者が押すのは状態ではなく行動である。
 */
const ACTION_LABELS: Record<string, string> = {
  'assigned:assign': '引き受ける',
  'in_progress:start': '対応を始める',
  'pending:wait_requester': '依頼者の返信を待つ',
  'pending:wait_external': '外部の対応を待つ',
  'in_progress:resume': '対応を再開する',
  'resolved:resolve': '解決にする',
  'closed:close': '完了にする',
  'cancelled:cancel': '取り消す',
};

function toActions(state: string): AvailableAction[] {
  return (
    allowedTransitionsFrom(state as never)
      .map((rule) => ({
        to: rule.to,
        reason: rule.reason,
        label: ACTION_LABELS[`${rule.to}:${rule.reason}`] ?? `${rule.to} にする`,
      }))
      // 統合は関連付け画面の操作であり、ここには出さない。
      // 出すと「間違えて統合してしまった」が起きやすい。
      .filter((action) => action.to !== 'merged')
  );
}

function toCommentView(comment: TicketComment): Record<string, unknown> {
  return {
    id: comment.id,
    authorId: comment.authorId,
    visibility: comment.visibility,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
  };
}

export class CollaborationController {
  constructor(private readonly deps: CollaborationRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (services: { tickets: TicketService; collab: CollaborationService }) => Promise<T>,
  ): Promise<T> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const out = await fn({
        tickets: new TicketService(client, this.deps.denialRecorder),
        collab: new CollaborationService(client, this.deps.storage, this.deps.denialRecorder),
      });
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * コメント一覧。
   *
   * **内部メモの除外はサービス層が行う。** ここでフィルタすると、
   * 別の呼び出し元が同じフィルタを書き忘れた時点で漏れる。
   * 除外は1か所に閉じ、この層は返ってきたものを整形するだけにする。
   */
  async listComments(auth: AuthenticatedRequest, ticketId: string) {
    const comments = await this.run(auth, ({ collab }) =>
      collab.listComments(auth.authz, ticketId),
    );
    return { status: 200, body: { items: comments.map(toCommentView) } };
  }

  async addComment(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const input = parseCommentBody(body);
    const comment = await this.run(auth, ({ collab }) =>
      collab.addComment(auth.authz, {
        ticketId,
        visibility: input.visibility,
        body: input.body,
      }),
    );
    recordDomainEvent('ticket.comment.added', 'success');
    return { status: 201, body: toCommentView(comment) };
  }

  /**
   * 担当者向けの詳細。
   *
   * チケット・コメント・**いま実行できる操作**をまとめて返す。
   * 画面が3回に分けて取りに来ると、その間に状態が変わって
   * 「押せたはずのボタンが押せない」が起きる。1回の応答で整合させる。
   */
  async workspace(auth: AuthenticatedRequest, ticketId: string) {
    const result = await this.run(auth, async ({ tickets, collab }) => {
      const ticket = await tickets.findById(auth.authz, ticketId);
      const comments = await collab.listComments(auth.authz, ticketId);
      return { ticket, comments };
    });

    return {
      status: 200,
      body: {
        ticket: {
          id: result.ticket.id,
          number: result.ticket.number,
          kind: result.ticket.kind,
          state: result.ticket.state,
          subject: result.ticket.subject,
          body: result.ticket.body,
          priority: result.ticket.priority,
          impact: result.ticket.impact,
          urgency: result.ticket.urgency,
          requesterId: result.ticket.requesterId,
          assigneeId: result.ticket.assigneeId,
          createdAt: result.ticket.createdAt.toISOString(),
          resolvedAt: result.ticket.resolvedAt?.toISOString() ?? null,
        },
        comments: result.comments.map(toCommentView),
        availableActions: toActions(result.ticket.state),
      },
    };
  }

  async transition(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const input = parseTransitionBody(body);
    const ticket = await this.run(auth, ({ tickets }) =>
      tickets.transition(auth.authz, {
        ticketId,
        to: input.to as never,
        reason: input.reason as never,
      }),
    );
    recordDomainEvent('ticket.transitioned', 'success');
    return { status: 200, body: { state: ticket.state } };
  }

  async assign(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    // 空文字は「担当を外す」。null と区別せずに扱うと、
    // フォームから空で送られたときに意図せず外れる/外れないが分かれる。
    const raw = record.assigneeId;
    const assigneeId = typeof raw === 'string' && raw.length > 0 ? raw : null;

    const ticket = await this.run(auth, ({ tickets }) =>
      tickets.assign(auth.authz, ticketId, assigneeId),
    );
    recordDomainEvent('ticket.assigned', 'success');
    return { status: 200, body: { assigneeId: ticket.assigneeId } };
  }
}

const VISIBILITIES = new Set(['public', 'internal']);

function parseCommentBody(body: unknown): { visibility: 'public' | 'internal'; body: string } {
  const errors: Array<{ field: string; message: string }> = [];
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const visibility = String(record.visibility ?? 'public');
  if (!VISIBILITIES.has(visibility)) {
    errors.push({ field: 'visibility', message: '公開範囲を選んでください' });
  }

  const text = typeof record.body === 'string' ? record.body.trim() : '';
  if (text.length === 0) {
    errors.push({ field: 'body', message: '内容を入力してください' });
  } else if (text.length > 10_000) {
    errors.push({ field: 'body', message: '内容は10,000文字以内で入力してください' });
  }

  if (errors.length > 0) throw Problems.validation(errors);
  return { visibility: visibility as 'public' | 'internal', body: text };
}

function parseTransitionBody(body: unknown): { to: string; reason: string } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const to = typeof record.to === 'string' ? record.to : '';
  const reason = typeof record.reason === 'string' ? record.reason : '';

  // 値の妥当性は状態機械が判定する。ここで許可値を二重に持つと、
  // 遷移表を変えたときに片方だけ直して食い違う。
  if (to.length === 0 || reason.length === 0) {
    throw Problems.validation([{ field: 'to', message: '操作を選んでください' }]);
  }
  return { to, reason };
}
