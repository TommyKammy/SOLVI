import type pg from 'pg';
import {
  applyClockAction,
  canTransition,
  clockActionFor,
  derivePriority,
  isTerminal,
  evaluateSla,
  Problems,
  type Impact,
  DEFAULT_SLA_TARGETS,
  type Priority,
  type TicketState,
  type SlaClockState,
  type SlaStatus,
  type TransitionReason,
  type Urgency,
} from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { enqueueOutboxEvent } from '../../common/outbox/outbox.js';
import { NoopDenialRecorder, type DenialRecorder } from '../../common/audit/denial-recorder.js';
import {
  canAccess,
  requireAccess,
  requireRole,
  type AuthzContext,
} from '../../common/authz/authz.js';
import { buildListQuery, visibilityScope, type ListOptions, type Cursor } from './ticket-query.js';

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
  /** SLAクロック。停止中は startedAt が null(FR-TKT-008)。 */
  slaClock: SlaClockState;
  firstRespondedAt: Date | null;
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

/**
 * 自動処理の主体を表す固定ID。
 *
 * **実在の利用者ではない。** 監査には `actorType: 'system'` として記録し、
 * `actorId` は載せない(この値をDBへ書かない)。
 * `AuthzContext` が `userId` を要求するため、その場所を埋めるだけに使う。
 */
const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

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
    slaClock: {
      startedAt: (row.sla_clock_started_at as Date | null) ?? null,
      elapsedSeconds: Number(row.sla_elapsed_seconds ?? 0),
    },
    firstRespondedAt: (row.first_responded_at as Date | null) ?? null,
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
          requester_id, impact, urgency, priority, sla_clock_started_at)
       VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8, $9, $10, now())
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

    // 通知イベントを**同一トランザクションで積む**(ADR-0008)。
    // 別トランザクションにすると「チケットは作られたが通知は積まれなかった」
    // という状態が生まれ、依頼者は受け付けられたことを知らないまま待つ。
    await enqueueOutboxEvent(this.client, {
      eventType: 'ticket.created',
      organizationId: ctx.organizationId,
      payload: { ticketId: id, ticketNumber: number, actorId: ctx.principal.userId },
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

    // 依頼者に許す操作は2つだけ。
    //
    //   cancel  「やっぱり不要でした」。これが無いと、取り消しのためだけに
    //           担当者へ連絡することになる
    //   reopen  「解決したことになっているが直っていない」(FR-TKT-012)。
    //           これが無いと、依頼者は同じ件で新規に起票し直すしかなく、
    //           **履歴が分断される**。担当側から見ても再発なのか
    //           未解決なのか区別できなくなる
    //
    // どちらも**自分のチケットに限る**。期限(14日)の判定は状態機械が持つ。
    const isRequesterSelfAction =
      (input.reason === 'cancel' || input.reason === 'reopen') &&
      ticket.requesterId === ctx.principal.userId;
    const permitted =
      isRequesterSelfAction ||
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

    return this.applyTransition(ctx, ticket, input, {
      type: 'user',
      userId: ctx.principal.userId,
    });
  }

  /**
   * 遷移の実行部分。**判定を通ったあとだけ呼ばれる。**
   *
   * `transition`(人の操作)と `autoClose`(時間による自動遷移)で共有する。
   * 分けて書くと、SLAクロックの扱いや監査の項目が片方だけ直されて食い違う。
   * 実際、状態機械には `auto_close` の規則があるのに**実行する経路が無く**、
   * 解決済みチケットが永久に閉じない状態が続いていた(WP-P2-CLOSE-014)。
   */
  private async applyTransition(
    ctx: AuthzContext,
    ticket: Ticket,
    input: TransitionInput,
    actor: { type: 'user'; userId: string } | { type: 'system' },
  ): Promise<Ticket> {
    // SLAクロックの更新。停止・再開の条件は状態機械の slaClock を唯一の根拠とする
    // (ここで独自の条件分岐を書くと遷移表と挙動が食い違う / FR-TKT-008)。
    const now = ctx.now ?? new Date();
    const action = clockActionFor(ticket.state, input.to, input.reason);
    const nextClock = action ? applyClockAction(ticket.slaClock, action, now) : ticket.slaClock;

    const { rows: updated } = await this.client.query(
      `UPDATE ticket
          SET state = $2,
              resolved_at = CASE
                WHEN $2 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now())
                ELSE NULL
              END,
              closed_at = CASE WHEN $2 = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END,
              sla_clock_started_at = $3,
              sla_elapsed_seconds = $4
        WHERE id = $1
        RETURNING *`,
      [ticket.id, input.to, nextClock.startedAt, nextClock.elapsedSeconds],
    );

    // SLA判定は記録のみ。**超過しても遷移は止めない**(WP-P2-SEARCH-006 §6)。
    // SLAは計測指標であり統制ではない。
    await this.refreshSlaBreach(ctx, toTicket(updated[0]!), now);

    await recordAuditEvent(this.client, {
      eventType: 'ticket.transitioned',
      organizationId: ctx.organizationId,
      // **自動遷移を人の操作として記録しない。** 記録を読む人が
      // 「誰が閉じたのか」を探して見つからず、時間を使うことになる。
      actorType: actor.type,
      ...(actor.type === 'user' ? { actorId: actor.userId } : {}),
      subjectUserId: ticket.requesterId,
      targetType: 'ticket',
      targetId: ticket.id,
      action: input.reason,
      outcome: 'success',
      beforeState: { state: ticket.state },
      afterState: { state: input.to, reason: input.reason },
    });

    await enqueueOutboxEvent(this.client, {
      eventType: 'ticket.transitioned',
      organizationId: ctx.organizationId,
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        // 自動遷移には操作者が居ない。null にすると通知側の自己除外が
        // 誰にも当たらず、**関係者全員へ届く**。それが正しい。
        ...(actor.type === 'user' ? { actorId: actor.userId } : {}),
      },
    });

    return toTicket(updated[0]!);
  }

  /**
   * 解決済みチケットの自動クローズ (FR-TKT-012 / 03.3 状態機械)。
   *
   * **人の操作ではない。** 要求は「Resolved後14日で自動」であり、
   * 担当者が押すボタンではない。それにもかかわらず状態機械の `auto_close`
   * 規則は担当者の選択肢として画面に出ており、かつ**自動で実行する者は
   * 居なかった**。押されなければ永久に resolved のまま残っていた。
   *
   * 14日待つのは、Reopen の窓と同じ長さにするためである(FR-TKT-012)。
   * 閉じてから再開できないと、依頼者は同じ件で新規に起票し直すことになり、
   * 履歴が分断される。**窓が開いている間は閉じない。**
   *
   * @returns 閉じたチケットの受付番号
   */
  async autoClose(ticketId: string, now = new Date()): Promise<string | null> {
    const { rows } = await this.client.query('SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [
      ticketId,
    ]);
    if (rows.length === 0) return null;
    const ticket = toTicket(rows[0]!);

    // 候補の抽出から実行までに人が触っていることがある。
    // **もう一度状態機械へ問う。** 抽出時点の判断を信じない。
    const decision = canTransition(ticket.state, 'closed', 'auto_close', {
      resolvedAt: ticket.resolvedAt,
      now,
    });
    if (!decision.allowed) return null;

    const ctx: AuthzContext = {
      // 自動処理に主体は無い。組織だけが要る(監査とRLSのため)。
      principal: { userId: SYSTEM_ACTOR_ID, status: 'active', bindings: [] },
      organizationId: ticket.organizationId,
      now,
    };

    await this.applyTransition(
      ctx,
      ticket,
      { ticketId, to: 'closed', reason: 'auto_close' },
      { type: 'system' },
    );
    return ticket.number;
  }

  /**
   * 担当者の割当(FR-TKT-003)。
   *
   * 割当先が同一Organizationに所属していることを必ず検証する。
   * 他組織のユーザを担当者にできると、そのユーザ経由でチケットの内容が読める。
   *
   * @param assigneeId null を渡すと割当解除
   */
  async assign(ctx: AuthzContext, ticketId: string, assigneeId: string | null): Promise<Ticket> {
    requireRole(ctx, 'agent', 'org_admin', 'platform_admin');

    const { rows } = await this.client.query('SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [
      ticketId,
    ]);
    if (rows.length === 0) throw Problems.notFound('チケット');
    const ticket = toTicket(rows[0]!);

    if (assigneeId !== null) {
      // 所属の検証。RLSにより他組織のrole_bindingは見えないため、
      // 「見つからない = この組織に所属していない」と判定できる。
      const { rows: members } = await this.client.query(
        `SELECT 1 FROM role_binding
          WHERE user_id = $1
            AND organization_id = $2
            AND valid_from <= now()
            AND (valid_until IS NULL OR valid_until > now())
          LIMIT 1`,
        [assigneeId, ctx.organizationId],
      );
      if (members.length === 0) {
        await this.denialRecorder.record(ctx.organizationId, {
          eventType: 'authz.access.denied',
          organizationId: ctx.organizationId,
          actorType: 'user',
          actorId: ctx.principal.userId,
          targetType: 'ticket',
          targetId: ticketId,
          action: 'assign',
          outcome: 'denied',
          policyDecision: { rule: 'assignee_membership', detail: '割当先が組織に所属していません' },
        });
        throw Problems.validation([
          { field: 'assigneeId', message: '指定された担当者はこの組織に所属していません' },
        ]);
      }
    }

    if (ticket.assigneeId === assigneeId) {
      // 同じ相手への再割当は履歴として意味がない。無変更で返す。
      return ticket;
    }

    const { rows: updated } = await this.client.query(
      'UPDATE ticket SET assignee_id = $2 WHERE id = $1 RETURNING *',
      [ticketId, assigneeId],
    );

    await this.client.query(
      `INSERT INTO ticket_assignment
         (id, organization_id, ticket_id, assignee_id, previous_assignee_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), ctx.organizationId, ticketId, assigneeId, ticket.assigneeId, ctx.principal.userId],
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.assigned',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: assigneeId,
      targetType: 'ticket',
      targetId: ticketId,
      action: assigneeId === null ? 'unassign' : 'assign',
      outcome: 'success',
      beforeState: { assigneeId: ticket.assigneeId },
      afterState: { assigneeId },
    });

    await enqueueOutboxEvent(this.client, {
      eventType: 'ticket.assigned',
      organizationId: ctx.organizationId,
      payload: { ticketId, ticketNumber: ticket.number, actorId: ctx.principal.userId },
    });

    return toTicket(updated[0]!);
  }

  /**
   * 影響度・緊急度の見直し (FR-TKT-009 / WP-P2-PRIO-013)。
   *
   * **優先度を直接書き換えさせない。** 影響度と緊急度を直し、優先度は
   * 規則から導き直す。理由は3つある。
   *
   *   1. 同じ入力から常に同じ優先度が出ることが、SLA計測と監査の前提である
   *      (`packages/shared/src/ticket/priority.ts`)。直接書き換えを許すと
   *      その前提が崩れ、**優先度を再現できなくなる**
   *   2. 監査に残るのが「誰かが critical にした」ではなく
   *      「影響範囲が広いと分かった」になる。後から読んで判断の当否を検証できる
   *   3. 優先度を直接上げられると、上げること自体が交渉の道具になる。
   *      影響度・緊急度で語らせるほうが、議論が事実に向く
   *
   * 申告時の値は依頼者の見立てであり、調べた結果と食い違うのが普通である。
   * **見直せないほうが不自然**であり、見直せないと現場は
   * 「とりあえず緊急にして起票する」を覚える。
   */
  async reassess(
    ctx: AuthzContext,
    input: { ticketId: string; impact: Impact; urgency: Urgency; reason: string },
  ): Promise<Ticket> {
    requireRole(ctx, 'agent', 'org_admin', 'platform_admin');

    const reason = input.reason.trim();
    if (reason.length === 0) {
      // 見直しは SLA の期限を動かす。理由の無い変更を残さない。
      throw Problems.validation([{ field: 'reason', message: '見直した理由を入力してください' }]);
    }
    if (reason.length > 500) {
      throw Problems.validation([
        { field: 'reason', message: '理由は500文字以内で入力してください' },
      ]);
    }

    const { rows } = await this.client.query('SELECT * FROM ticket WHERE id = $1 FOR UPDATE', [
      input.ticketId,
    ]);
    if (rows.length === 0) throw Problems.notFound('チケット');
    const ticket = toTicket(rows[0]!);

    requireAccess(
      ctx,
      { organizationId: ticket.organizationId, ownerUserId: ticket.requesterId },
      {
        organizationWide: [...TRANSITION_POLICY.organizationWide],
        allowOwner: TRANSITION_POLICY.allowOwner,
      },
      'チケット',
    );

    if (isTerminal(ticket.state)) {
      // 終わった案件の見直しは、SLAの達成状況を後から書き換えることになる。
      // 記録を後から都合よく変えられる経路は作らない。
      throw Problems.conflict('完了・取消・統合済みの問い合わせは見直せません');
    }

    if (ticket.impact === input.impact && ticket.urgency === input.urgency) {
      // 何も変わらない見直しを記録しない。**黙って成功にもしない** —
      // 押したのに何も起きないと、利用者は操作が効いていないと考える。
      throw Problems.validation([{ field: 'impact', message: '影響度も緊急度も変わっていません' }]);
    }

    const priority = derivePriority(input.impact, input.urgency);

    const { rows: updated } = await this.client.query(
      'UPDATE ticket SET impact = $2, urgency = $3, priority = $4 WHERE id = $1 RETURNING *',
      [input.ticketId, input.impact, input.urgency, priority],
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.reassessed',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket',
      targetId: input.ticketId,
      action: 'reassess',
      outcome: 'success',
      // 前後を両方残す。「どこから」が無いと、判断の当否を後から読めない。
      beforeState: {
        impact: ticket.impact,
        urgency: ticket.urgency,
        priority: ticket.priority,
      },
      afterState: { impact: input.impact, urgency: input.urgency, priority, reason },
    });

    // 優先度が変わったときだけ知らせる。影響度と緊急度の入れ替えで
    // 優先度が動かないこともあり、**変わっていないものを知らせても
    // 「また来た」としか受け取られない。**
    if (priority !== ticket.priority) {
      await enqueueOutboxEvent(this.client, {
        eventType: 'ticket.reassessed',
        organizationId: ctx.organizationId,
        payload: {
          ticketId: input.ticketId,
          ticketNumber: ticket.number,
          actorId: ctx.principal.userId,
        },
      });
    }

    return toTicket(updated[0]!);
  }

  /**
   * 一覧(FR-TKT-006)。
   *
   * 認可条件は WHERE 句に含まれる(ticket-query.ts)。
   * 取得後のフィルタにすると、条件の書き忘れが大量漏えいに直結する。
   * 件数も同じ条件で数え、権限外の件数を漏らさない。
   */
  async list(
    ctx: AuthzContext,
    options: ListOptions = {},
  ): Promise<{ items: Ticket[]; total: number; nextCursor: Cursor | null; scope: string }> {
    const query = buildListQuery(ctx, options);
    const [listResult, countResult] = await Promise.all([
      this.client.query(query.sql, query.params),
      this.client.query<{ total: number }>(query.countSql, query.countParams),
    ]);

    const items = listResult.rows.map(toTicket);
    // limit 件ちょうど返ったときのみ次ページがあり得る。
    // カーソルの時刻は DB が返した文字列をそのまま使う(Date を経由すると
    // マイクロ秒が失われ、次ページが空になる)。
    const lastRow = listResult.rows[listResult.rows.length - 1];
    const nextCursor =
      items.length === query.limit && lastRow
        ? { createdAt: lastRow.cursor_created_at as string, id: lastRow.id as string }
        : null;

    return {
      items,
      total: countResult.rows[0]!.total,
      nextCursor,
      scope: visibilityScope(ctx),
    };
  }

  /** 組織のSLAポリシーを取得する。未設定なら既定値を使う。 */
  private async slaTargetFor(
    ctx: AuthzContext,
    priority: Priority,
  ): Promise<{ responseTargetMinutes: number; resolutionTargetMinutes: number }> {
    const { rows } = await this.client.query<{
      response_target_minutes: number;
      resolution_target_minutes: number;
    }>(
      'SELECT response_target_minutes, resolution_target_minutes FROM sla_policy WHERE organization_id = $1 AND priority = $2',
      [ctx.organizationId, priority],
    );
    if (rows.length === 0) return DEFAULT_SLA_TARGETS[priority];
    return {
      responseTargetMinutes: rows[0]!.response_target_minutes,
      resolutionTargetMinutes: rows[0]!.resolution_target_minutes,
    };
  }

  /** SLAの判定結果を記録する。遷移を止めることはしない。 */
  private async refreshSlaBreach(ctx: AuthzContext, ticket: Ticket, now: Date): Promise<void> {
    const status = evaluateSla({
      clock: ticket.slaClock,
      target: await this.slaTargetFor(ctx, ticket.priority),
      firstRespondedAt: ticket.firstRespondedAt,
      createdAt: ticket.createdAt,
      resolvedAt: ticket.resolvedAt,
      now,
    });
    await this.client.query(
      'UPDATE ticket SET response_sla_breached = $2, resolution_sla_breached = $3 WHERE id = $1',
      [ticket.id, status.responseBreached, status.resolutionBreached],
    );
  }

  /** 現時点のSLA状況。一覧・詳細の表示に使う。 */
  async slaStatus(ctx: AuthzContext, ticketId: string, now = new Date()): Promise<SlaStatus> {
    const ticket = await this.findById(ctx, ticketId);
    return evaluateSla({
      clock: ticket.slaClock,
      target: await this.slaTargetFor(ctx, ticket.priority),
      firstRespondedAt: ticket.firstRespondedAt,
      createdAt: ticket.createdAt,
      resolvedAt: ticket.resolvedAt,
      now,
    });
  }

  /**
   * 初回応答の記録(FR-TKT-008の応答SLA)。
   * 担当者の公開コメントで初めて呼ばれる。2回目以降は何もしない。
   */
  async recordFirstResponse(ctx: AuthzContext, ticketId: string, at = new Date()): Promise<void> {
    await this.client.query(
      'UPDATE ticket SET first_responded_at = $2 WHERE id = $1 AND first_responded_at IS NULL',
      [ticketId, at],
    );
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
