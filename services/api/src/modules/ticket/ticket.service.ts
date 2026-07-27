import type pg from 'pg';
import {
  canTransition,
  derivePriority,
  Problems,
  type Impact,
  type Priority,
  type TicketState,
  type TransitionReason,
  type Urgency,
} from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { NoopDenialRecorder, type DenialRecorder } from '../../common/audit/denial-recorder.js';
import {
  canAccess,
  requireAccess,
  requireRole,
  type AuthzContext,
} from '../../common/authz/authz.js';

/**
 * チケットのアプリケーションサービス。
 *
 * 状態変更の唯一の入口。ここを通らない UPDATE は作らない(ADR-0013)。
 * HTTPレイヤは WP-P1-IDM-003(OIDC)完了後に接続する。
 * 認証なしで動く経路を先に作ると、消し忘れたまま残る危険があるため
 * このWPではドメイン層までに留める(WP §5)。
 */

export type TicketKind = 'incident' | 'request';

export interface Ticket {
  id: string;
  organizationId: string;
  number: string;
  kind: TicketKind;
  state: TicketState;
  subject: string;
  body: string;
  requesterId: string;
  assigneeId: string | null;
  impact: Impact;
  urgency: Urgency;
  priority: Priority;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

/**
 * 作成時の入力。
 *
 * `state` `priority` `organizationId` `number` を**受け取らない**。
 * これらは入力ではなく、サーバ側が決める値である(mass assignment 防止 / 脅威 T-03)。
 */
export interface CreateTicketInput {
  kind: TicketKind;
  subject: string;
  body: string;
  impact: Impact;
  urgency: Urgency;
  /** 代理起票。省略時は操作者本人が依頼者になる。 */
  requesterId?: string;
}

export interface TransitionInput {
  ticketId: string;
  to: TicketState;
  reason: TransitionReason;
  /** 利用者向けの補足。監査には保存せず、コメントとして残すのは WP-P2-COLLAB-004。 */
  note?: string;
}

/** 一覧・詳細の閲覧ポリシー。担当者は組織内全件、依頼者は自分の分のみ。 */
const READ_POLICY = {
  organizationWide: ['agent', 'org_admin', 'auditor', 'platform_admin'] as const,
  allowOwner: true,
};
/** 状態を動かせるのは担当側のみ。依頼者は取消のみ別途許可する。 */
const TRANSITION_POLICY = {
  organizationWide: ['agent', 'org_admin', 'platform_admin'] as const,
  allowOwner: false,
};

function toTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    number: row.number as string,
    kind: row.kind as TicketKind,
    state: row.state as TicketState,
    subject: row.subject as string,
    body: row.body as string,
    requesterId: row.requester_id as string,
    assigneeId: (row.assignee_id as string | null) ?? null,
    impact: row.impact as Impact,
    urgency: row.urgency as Urgency,
    priority: row.priority as Priority,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    closedAt: (row.closed_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

export class TicketService {
  /**
   * @param client Organizationコンテキストが設定済みのトランザクションクライアント。
   *   成功時の監査を同一トランザクションで書くため、サービス側では接続を取得しない。
   * @param denialRecorder 拒否イベントの記録先。業務トランザクションはロールバックされるため、
   *   拒否だけは独立した接続で書く(denial-recorder.ts の説明を参照)。
   */
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly denialRecorder: DenialRecorder = new NoopDenialRecorder(),
  ) {}

  async create(ctx: AuthzContext, input: CreateTicketInput): Promise<Ticket> {
    // 起票は組織に所属していれば誰でもできる
    requireRole(ctx, 'requester', 'agent', 'approver', 'org_admin', 'auditor', 'platform_admin');

    const requesterId = input.requesterId ?? ctx.principal.userId;
    // 代理起票は担当者のみ。他人名義の起票を一般利用者に許すと、
    // 依頼者を詐称した申請が作れてしまう。
    if (requesterId !== ctx.principal.userId) {
      requireRole(ctx, 'agent', 'org_admin', 'platform_admin');
    }

    const subject = input.subject.trim();
    if (subject.length === 0) {
      throw Problems.validation([{ field: 'subject', message: '件名を入力してください' }]);
    }

    const priority = derivePriority(input.impact, input.urgency);
    const id = uuidv7();

    const { rows: numberRows } = await this.client.query<{ number: string }>(
      'SELECT next_ticket_number($1, $2) AS number',
      [ctx.organizationId, input.kind],
    );
    const number = numberRows[0]!.number;

    const { rows } = await this.client.query(
      `INSERT INTO ticket
         (id, organization_id, number, kind, state, subject, body,
          requester_id, impact, urgency, priority)
       VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        id,
        ctx.organizationId,
        number,
        input.kind,
        subject,
        input.body,
        requesterId,
        input.impact,
        input.urgency,
        priority,
      ],
    );

    // 監査は同一トランザクション。失敗すればチケット作成も巻き戻る。
    await recordAuditEvent(this.client, {
      eventType: 'ticket.created',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: requesterId,
      targetType: 'ticket',
      targetId: id,
      action: 'create',
      outcome: 'success',
      // 本文・件名は監査へ入れない(02.17 §4)。参照IDと分類のみ。
      afterState: {
        number,
        kind: input.kind,
        state: 'new',
        priority,
        impact: input.impact,
        urgency: input.urgency,
      },
    });

    return toTicket(rows[0]!);
  }

  async findById(ctx: AuthzContext, ticketId: string): Promise<Ticket> {
    // RLS により他組織の行はそもそも返らない。ここでの 404 は
    // 「同一組織内だが閲覧権限がない」場合の存在秘匿(NFR-SEC-006)。
    const { rows } = await this.client.query('SELECT * FROM ticket WHERE id = $1', [ticketId]);
    if (rows.length === 0) throw Problems.notFound('チケット');

    const ticket = toTicket(rows[0]!);
    requireAccess(
      ctx,
      { organizationId: ticket.organizationId, ownerUserId: ticket.requesterId },
      { organizationWide: [...READ_POLICY.organizationWide], allowOwner: READ_POLICY.allowOwner },
      'チケット',
    );
    return ticket;
  }

  /**
   * 状態遷移。遷移表にない遷移、終端状態からの遷移、期限切れのReopenを拒否する。
   * 拒否は監査へ `denied` として残す(なぜ拒否したかを policyDecision に記録)。
   */
  async transition(ctx: AuthzContext, input: TransitionInput): Promise<Ticket> {
    const { rows } = await this.client.query('SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [
      input.ticketId,
    ]);
    if (rows.length === 0) throw Problems.notFound('チケット');
    const ticket = toTicket(rows[0]!);

    const isRequesterCancel =
      input.reason === 'cancel' && ticket.requesterId === ctx.principal.userId;
    const permitted =
      isRequesterCancel ||
      canAccess(
        ctx,
        { organizationId: ticket.organizationId, ownerUserId: ticket.requesterId },
        {
          organizationWide: [...TRANSITION_POLICY.organizationWide],
          allowOwner: TRANSITION_POLICY.allowOwner,
        },
      );

    if (!permitted) {
      await this.recordDenial(ctx, ticket, input, {
        rule: 'transition_policy',
        detail: 'この操作を行う権限がありません',
      });
      // 閲覧できるかどうかで応答を変えない。存在秘匿を保つ。
      throw Problems.notFound('チケット');
    }

    const decision = canTransition(ticket.state, input.to, input.reason, {
      resolvedAt: ticket.resolvedAt,
      now: ctx.now,
    });

    if (!decision.allowed) {
      await this.recordDenial(ctx, ticket, input, {
        rule: 'state_machine',
        denialCode: decision.denialCode,
        detail: decision.message,
      });
      throw Problems.invalidTransition(ticket.state, input.to);
    }

    const { rows: updated } = await this.client.query(
      `UPDATE ticket
          SET state = $2,
              resolved_at = CASE
                WHEN $2 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now())
                ELSE NULL
              END,
              closed_at = CASE WHEN $2 = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END
        WHERE id = $1
        RETURNING *`,
      [ticket.id, input.to],
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.transitioned',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: ticket.requesterId,
      targetType: 'ticket',
      targetId: ticket.id,
      action: input.reason,
      outcome: 'success',
      beforeState: { state: ticket.state },
      afterState: { state: input.to, reason: input.reason },
    });

    return toTicket(updated[0]!);
  }

  /**
   * 拒否も証跡に残す。「拒否された操作が試みられた」ことは検知の材料になる。
   * 業務トランザクションではなく独立した接続で書く(ロールバックで消えないように)。
   */
  private async recordDenial(
    ctx: AuthzContext,
    ticket: Ticket,
    input: TransitionInput,
    policyDecision: Record<string, unknown>,
  ): Promise<void> {
    await this.denialRecorder.record(ctx.organizationId, {
      eventType: 'authz.access.denied',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket',
      targetId: ticket.id,
      action: input.reason,
      outcome: 'denied',
      beforeState: { state: ticket.state },
      afterState: { attemptedState: input.to },
      policyDecision,
    });
  }
}
