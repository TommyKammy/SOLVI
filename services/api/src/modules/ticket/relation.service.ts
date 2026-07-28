import type pg from 'pg';
import { Problems, type TicketState } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { NoopDenialRecorder, type DenialRecorder } from '../../common/audit/denial-recorder.js';
import {
  requireAccess,
  requireRole,
  type AuthzContext,
  type RoleCode,
} from '../../common/authz/authz.js';

/**
 * チケットの関連付けとMerge(FR-TKT-010 / FR-TKT-011)。
 *
 * 設計判断は WP-P2-REL-009 §6 に記録済み。実装上の要点:
 *
 * 1. 関連付けには**両側**のチケットへの閲覧権限を要求する。
 *    片側だけ見える状態で関連付けられると、関連チケットの件名や番号から
 *    権限外の情報が推測できてしまう(脅威 T-02)。
 *
 * 2. Merge はコメント・添付を**移動しない**。移すと元チケットの履歴が空洞化し、
 *    依頼者が自分の起票を開いたときに中身が消えて見える。監査上も
 *    「何が起きたか」を辿れなくなる。
 */

export type RelationType = 'related' | 'parent_of';

export interface TicketRelation {
  id: string;
  relationType: RelationType;
  sourceTicketId: string;
  targetTicketId: string;
  createdBy: string;
  createdAt: Date;
}

export interface RelatedTicketSummary {
  ticketId: string;
  number: string;
  subject: string;
  state: TicketState;
  /** この関連における相手の役割 */
  role: 'related' | 'parent' | 'child';
}

const READ_POLICY = {
  organizationWide: ['agent', 'org_admin', 'auditor', 'platform_admin'] as RoleCode[],
  allowOwner: true,
};

/** 関連付け・Merge を行えるロール。依頼者には許可しない。 */
const MUTATE_ROLES: readonly RoleCode[] = ['agent', 'org_admin', 'platform_admin'];

interface TicketRow {
  id: string;
  organization_id: string;
  requester_id: string;
  number: string;
  subject: string;
  state: TicketState;
  merged_into_id: string | null;
}

export interface MergeResult {
  sourceTicketId: string;
  targetTicketId: string;
  /** Merge元に残ったコメント・添付の件数(移動していないことの確認に使う) */
  retained: { comments: number; attachments: number };
}

export class RelationService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly denialRecorder: DenialRecorder = new NoopDenialRecorder(),
  ) {}

  /**
   * 両側のチケットを取得し、いずれも閲覧できることを確認する。
   * 片方でも見えなければ 404(存在秘匿)。
   */
  private async loadBoth(
    ctx: AuthzContext,
    aId: string,
    bId: string,
  ): Promise<{ a: TicketRow; b: TicketRow }> {
    if (aId === bId) {
      throw Problems.validation([
        { field: 'targetTicketId', message: '同じチケット同士は関連付けできません' },
      ]);
    }

    const { rows } = await this.client.query<TicketRow>(
      'SELECT id, organization_id, requester_id, number, subject, state, merged_into_id FROM ticket WHERE id = ANY($1)',
      [[aId, bId]],
    );
    const a = rows.find((r) => r.id === aId);
    const b = rows.find((r) => r.id === bId);
    // RLS により他組織の行はそもそも返らない。ここで見つからない = 存在しないか権限外。
    if (!a || !b) throw Problems.notFound('チケット');

    for (const ticket of [a, b]) {
      requireAccess(
        ctx,
        { organizationId: ticket.organization_id, ownerUserId: ticket.requester_id },
        READ_POLICY,
        'チケット',
      );
    }
    return { a, b };
  }

  /**
   * 受付番号でチケットを引く (WP-P2-RELUI-012)。
   *
   * 担当者が見ているのは番号(`INC-2026-000012`)であり、UUID ではない。
   * 画面にUUIDを手で写させると、**写し間違いで別のチケットを統合しうる**。
   * 統合は取り消せないので、その経路を作らない。
   *
   * 見つからない場合も権限が無い場合も**同じ文面**を返す。
   * 区別すると、番号を総当たりして他組織・他人のチケットの実在を確かめられる。
   */
  async findByNumber(ctx: AuthzContext, number: string): Promise<RelatedTicketSummary> {
    const trimmed = number.trim();
    const notFoundError = Problems.validation([
      { field: 'targetTicketNumber', message: 'その受付番号のチケットは見つかりません' },
    ]);
    if (trimmed.length === 0) throw notFoundError;

    // RLS により他組織の行はそもそも返らない。
    const { rows } = await this.client.query<TicketRow>(
      'SELECT id, organization_id, requester_id, number, subject, state, merged_into_id FROM ticket WHERE number = $1',
      [trimmed],
    );
    if (rows.length === 0) throw notFoundError;
    const ticket = rows[0]!;

    try {
      requireAccess(
        ctx,
        { organizationId: ticket.organization_id, ownerUserId: ticket.requester_id },
        READ_POLICY,
        'チケット',
      );
    } catch {
      // 403 を返すと「その番号は実在する」と分かってしまう。
      throw notFoundError;
    }

    return {
      ticketId: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      state: ticket.state,
      role: 'related',
    };
  }

  async link(
    ctx: AuthzContext,
    sourceTicketId: string,
    targetTicketId: string,
    relationType: RelationType,
  ): Promise<TicketRelation> {
    requireRole(ctx, ...MUTATE_ROLES);
    const { a, b } = await this.loadBoth(ctx, sourceTicketId, targetTicketId);

    // 統合済みチケットに新しい関連を足しても辿れない。入口で止める。
    for (const ticket of [a, b]) {
      if (ticket.state === 'merged') {
        throw Problems.conflict('統合済みのチケットは関連付けできません');
      }
    }

    const id = uuidv7();
    try {
      await this.client.query(
        `INSERT INTO ticket_relation
           (id, organization_id, relation_type, source_ticket_id, target_ticket_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          ctx.organizationId,
          relationType,
          sourceTicketId,
          targetTicketId,
          ctx.principal.userId,
        ],
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      // 23505 = unique_violation, 23001 = restrict_violation(1階層トリガ)
      if (code === '23505') {
        throw Problems.conflict('この関連付けは既に存在します');
      }
      if (code === '23001') {
        throw Problems.conflict(
          (error as { message?: string }).message ?? '親子関係は1階層までです',
        );
      }
      throw error;
    }

    await recordAuditEvent(this.client, {
      eventType: 'ticket.linked',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket',
      targetId: sourceTicketId,
      action: `link.${relationType}`,
      outcome: 'success',
      // 件名は監査へ入れない(02.17 §4)。IDと種別のみ。
      afterState: { relationType, targetTicketId, relationId: id },
    });

    return {
      id,
      relationType,
      sourceTicketId,
      targetTicketId,
      createdBy: ctx.principal.userId,
      createdAt: new Date(),
    };
  }

  async unlink(ctx: AuthzContext, relationId: string): Promise<void> {
    requireRole(ctx, ...MUTATE_ROLES);

    const { rows } = await this.client.query('SELECT * FROM ticket_relation WHERE id = $1', [
      relationId,
    ]);
    if (rows.length === 0) throw Problems.notFound('関連付け');
    const relation = rows[0]!;

    // 解除にも両側の閲覧権限を要求する(片側しか見えない関連を操作させない)
    await this.loadBoth(ctx, relation.source_ticket_id, relation.target_ticket_id);

    await this.client.query('DELETE FROM ticket_relation WHERE id = $1', [relationId]);

    await recordAuditEvent(this.client, {
      eventType: 'ticket.unlinked',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket',
      targetId: relation.source_ticket_id,
      action: `unlink.${relation.relation_type}`,
      outcome: 'success',
      beforeState: {
        relationType: relation.relation_type,
        targetTicketId: relation.target_ticket_id,
      },
    });
  }

  /**
   * あるチケットに紐づく関連の一覧。
   * related は無向なので、source/target どちらに入っていても相手を返す。
   */
  async listRelations(ctx: AuthzContext, ticketId: string): Promise<RelatedTicketSummary[]> {
    const { rows: ticketRows } = await this.client.query<TicketRow>(
      'SELECT id, organization_id, requester_id, number, subject, state, merged_into_id FROM ticket WHERE id = $1',
      [ticketId],
    );
    if (ticketRows.length === 0) throw Problems.notFound('チケット');
    requireAccess(
      ctx,
      {
        organizationId: ticketRows[0]!.organization_id,
        ownerUserId: ticketRows[0]!.requester_id,
      },
      READ_POLICY,
      'チケット',
    );

    // 相手側のチケットも RLS と結合条件で絞られる。
    // 権限外のチケットが相手の場合でも、番号や件名を返さない。
    const { rows } = await this.client.query(
      `SELECT r.relation_type,
              CASE WHEN r.source_ticket_id = $1 THEN 'source' ELSE 'target' END AS side,
              o.id, o.number, o.subject, o.state
         FROM ticket_relation r
         JOIN ticket o
           ON o.id = CASE WHEN r.source_ticket_id = $1 THEN r.target_ticket_id ELSE r.source_ticket_id END
        WHERE r.source_ticket_id = $1 OR r.target_ticket_id = $1
        ORDER BY r.created_at`,
      [ticketId],
    );

    return rows.map((row) => ({
      ticketId: row.id as string,
      number: row.number as string,
      subject: row.subject as string,
      state: row.state as TicketState,
      role:
        row.relation_type === 'related'
          ? 'related'
          : // parent_of で自分が source なら相手は子、target なら相手は親
            row.side === 'source'
            ? 'child'
            : 'parent',
    }));
  }

  /**
   * 重複チケットの統合(FR-TKT-011)。
   *
   * source を target へ統合する。**コメント・添付は移動しない**(WP §6)。
   * source は `merged` 終端になり、以降の状態変更は state machine が拒否する。
   */
  async merge(
    ctx: AuthzContext,
    sourceTicketId: string,
    targetTicketId: string,
    reason: string,
  ): Promise<MergeResult> {
    requireRole(ctx, ...MUTATE_ROLES);

    if (reason.trim().length === 0) {
      // 統合は不可逆。なぜ統合したかが残らない操作を許さない。
      throw Problems.validation([{ field: 'reason', message: '統合の理由を入力してください' }]);
    }

    const { a: source, b: target } = await this.loadBoth(ctx, sourceTicketId, targetTicketId);

    if (source.state === 'merged') {
      throw Problems.conflict('このチケットは既に統合されています');
    }
    if (target.state === 'merged') {
      // 統合の連鎖を許すと、最終的な統合先を辿る処理が必要になり表示も監査も複雑になる。
      await this.denialRecorder.record(ctx.organizationId, {
        eventType: 'authz.access.denied',
        organizationId: ctx.organizationId,
        actorType: 'user',
        actorId: ctx.principal.userId,
        targetType: 'ticket',
        targetId: sourceTicketId,
        action: 'merge',
        outcome: 'denied',
        policyDecision: { rule: 'merge_chain', detail: '統合先が既に統合済みです' },
      });
      throw Problems.conflict(
        '統合先のチケットは既に別のチケットへ統合されています。最終的な統合先を指定してください。',
      );
    }

    // 状態と統合先を同時に更新する。ticket_merged_into_consistency 制約により
    // merged 状態と merged_into_id は必ず対で設定される。
    await this.client.query(
      `UPDATE ticket
          SET state = 'merged', merged_into_id = $2, resolved_at = NULL, closed_at = NULL
        WHERE id = $1`,
      [sourceTicketId, targetTicketId],
    );

    // 統合先から元チケットを辿れるようにする(related として双方向に見える)。
    //
    // **既に関連付けられている場合がある。** 担当者が「関連しているようだ」と
    // 気付いて先に関連付け、そのあとで「やはり重複だ」と統合する —
    // これは異常な操作順ではなく、むしろ自然な流れである。
    //
    // ここで一意制約違反を JavaScript の catch で握り潰してはいけない。
    // **PostgreSQL では文がエラーになった時点でトランザクション全体が中断する。**
    // 例外を捕まえても中断は解けず、以降のクエリはすべて
    // 「current transaction is aborted」で失敗する。
    // 実際この経路は 500 を返していた(統合そのものは成立せず、
    // 「先に関連付けてから統合する」と必ず失敗した)。
    //
    // 部分一意索引に合わせた `ON CONFLICT` を書く。`WHERE` を省くと
    // 索引が一致せず「no unique or exclusion constraint matching」で落ちる。
    await this.client.query(
      `INSERT INTO ticket_relation
         (id, organization_id, relation_type, source_ticket_id, target_ticket_id, created_by)
       VALUES ($1, $2, 'related', $3, $4, $5)
       ON CONFLICT (
         LEAST(source_ticket_id, target_ticket_id),
         GREATEST(source_ticket_id, target_ticket_id)
       ) WHERE relation_type = 'related' DO NOTHING`,
      [uuidv7(), ctx.organizationId, targetTicketId, sourceTicketId, ctx.principal.userId],
    );

    // コメント・添付が元チケットに残っていることを数える。
    // 「移動しない」という決定が守られていることを、実行時にも確認できるようにする。
    const { rows: retained } = await this.client.query<{ comments: number; attachments: number }>(
      `SELECT
         (SELECT count(*)::int FROM ticket_comment WHERE ticket_id = $1) AS comments,
         (SELECT count(*)::int FROM ticket_attachment WHERE ticket_id = $1) AS attachments`,
      [sourceTicketId],
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.merged',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      subjectUserId: source.requester_id,
      targetType: 'ticket',
      targetId: sourceTicketId,
      action: 'merge',
      outcome: 'success',
      beforeState: { state: source.state },
      afterState: {
        state: 'merged',
        mergedIntoId: targetTicketId,
        reason: reason.trim(),
        retainedComments: retained[0]!.comments,
        retainedAttachments: retained[0]!.attachments,
      },
    });

    return {
      sourceTicketId,
      targetTicketId,
      retained: { comments: retained[0]!.comments, attachments: retained[0]!.attachments },
    };
  }

  /**
   * 親チケットを解決してよいかの確認(WP §6: 拒否ではなく警告)。
   *
   * 子が未解決でも解決を止めない。子が別チームの担当で長期化することがあり、
   * 拒否すると運用が詰まる。判断は人間に残す。
   */
  async unresolvedChildren(ctx: AuthzContext, ticketId: string): Promise<RelatedTicketSummary[]> {
    const relations = await this.listRelations(ctx, ticketId);
    const children = relations.filter((r) => r.role === 'child');
    const openStates: TicketState[] = ['new', 'assigned', 'in_progress', 'pending'];
    return children.filter((c) => openStates.includes(c.state));
  }
}
