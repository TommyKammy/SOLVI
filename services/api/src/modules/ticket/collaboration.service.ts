import type pg from 'pg';
import { Problems, validateAttachment, MAX_ATTACHMENT_BYTES } from '@solvi/shared';
import { TicketService } from './ticket.service.js';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import { enqueueOutboxEvent } from '../../common/outbox/outbox.js';
import { NoopDenialRecorder, type DenialRecorder } from '../../common/audit/denial-recorder.js';
import {
  hasRole,
  requireAccess,
  type AuthzContext,
  type RoleCode,
} from '../../common/authz/authz.js';
import {
  generateStorageKey,
  MAX_SIGNED_URL_TTL_SECONDS,
  type ObjectStorage,
  type SignedUrl,
} from '@solvi/shared';

/**
 * コメント・内部メモ・添付(FR-TKT-004 / FR-TKT-005)。
 *
 * このサービスの要点は2つの漏えい経路を塞ぐこと。
 *   1. 内部メモが依頼者へ渡らないこと ― 可視性はSQLの条件で表現する
 *   2. 添付が権限外・スキャン未完了のまま配布されないこと
 */

export type Visibility = 'public' | 'internal';
export type ScanStatus = 'pending' | 'clean' | 'infected' | 'failed';

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  visibility: Visibility;
  body: string;
  createdAt: Date;
}

export interface TicketAttachment {
  id: string;
  ticketId: string;
  visibility: Visibility;
  uploadedBy: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  createdAt: Date;
}

/** 内部メモを読めるロール。ここに requester を入れてはならない。 */
const INTERNAL_VISIBLE_ROLES: readonly RoleCode[] = [
  'agent',
  'org_admin',
  'auditor',
  'platform_admin',
  'platform_auditor',
];

/** チケット本体を読めるかの判定に使う(ticket.service.ts と同じ規則) */
const TICKET_READ_POLICY = {
  organizationWide: ['agent', 'org_admin', 'auditor', 'platform_admin'] as RoleCode[],
  allowOwner: true,
};

export interface AddCommentInput {
  ticketId: string;
  visibility: Visibility;
  body: string;
}

export interface AddAttachmentInput {
  ticketId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  visibility?: Visibility;
}

export interface AttachmentUploadTicket {
  attachmentId: string;
  uploadUrl: SignedUrl;
  storageKey: string;
}

export class CollaborationService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly storage: ObjectStorage,
    private readonly denialRecorder: DenialRecorder = new NoopDenialRecorder(),
  ) {}

  /**
   * 内部メモを読めるかどうか。
   * この判定結果をSQLの条件に落とし、取得後のフィルタにはしない。
   */
  private canSeeInternal(ctx: AuthzContext): boolean {
    return hasRole(ctx, ...INTERNAL_VISIBLE_ROLES);
  }

  /** チケット本体へのアクセス可否。ここを通らないとコメント・添付にも触れない。 */
  private async assertTicketAccess(ctx: AuthzContext, ticketId: string): Promise<void> {
    const { rows } = await this.client.query(
      'SELECT organization_id, requester_id FROM ticket WHERE id = $1',
      [ticketId],
    );
    if (rows.length === 0) throw Problems.notFound('チケット');
    requireAccess(
      ctx,
      { organizationId: rows[0]!.organization_id, ownerUserId: rows[0]!.requester_id },
      TICKET_READ_POLICY,
      'チケット',
    );
  }

  async addComment(ctx: AuthzContext, input: AddCommentInput): Promise<TicketComment> {
    await this.assertTicketAccess(ctx, input.ticketId);

    // 内部メモを書けるのは、内部メモを読めるロールに限る。
    // 依頼者が internal で書けてしまうと、本人にも見えないコメントが生まれて混乱する。
    if (input.visibility === 'internal' && !this.canSeeInternal(ctx)) {
      await this.denialRecorder.record(ctx.organizationId, {
        eventType: 'authz.access.denied',
        organizationId: ctx.organizationId,
        actorType: 'user',
        actorId: ctx.principal.userId,
        targetType: 'ticket',
        targetId: input.ticketId,
        action: 'comment.add_internal',
        outcome: 'denied',
        policyDecision: {
          rule: 'internal_note_write',
          detail: '内部メモを追加する権限がありません',
        },
      });
      throw Problems.forbidden('内部メモを追加する権限がありません');
    }

    const body = input.body.trim();
    if (body.length === 0) {
      throw Problems.validation([{ field: 'body', message: '本文を入力してください' }]);
    }

    const id = uuidv7();
    const { rows } = await this.client.query(
      `INSERT INTO ticket_comment (id, organization_id, ticket_id, author_id, visibility, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, ctx.organizationId, input.ticketId, ctx.principal.userId, input.visibility, body],
    );

    // 初回応答の記録 (FR-TKT-008 の応答SLA / WP-P2-SLAUI-016)。
    //
    // `TicketService.recordFirstResponse` は「担当者の公開コメントで
    // 初めて呼ばれる」と書かれていたが、**呼ぶ側が居なかった。**
    // `first_responded_at` は永久に NULL のままで、
    // 応答SLAは全件が「未応答」として判定され続けていた。
    //
    // 数えるのは**担当側の公開コメント**だけである。
    //   * 内部メモは依頼者に届かない。応答ではない
    //   * 依頼者自身の追記は応答ではない
    if (input.visibility === 'public') {
      // **同じSQLを書き写さない。** 「何を初回応答と数えるか」は
      // `TicketService` が持つ業務の定義である。ここに書き写すと、
      // 定義が変わったときに片方だけ直る。
      await new TicketService(this.client).recordFirstResponse(ctx, input.ticketId);
    }

    await recordAuditEvent(this.client, {
      eventType: 'ticket.comment.added',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket',
      targetId: input.ticketId,
      action: 'comment.add',
      outcome: 'success',
      // 本文は監査へ入れない(02.17 §4)。区分と長さのみ。
      afterState: { commentId: id, visibility: input.visibility, bodyLength: body.length },
    });

    // **内部メモも積む。** 積まずに済ませると、将来別の経路がイベントを
    // 拾ったときに漏れる。通知側が visibility を見て弾く。
    const { rows: ticketRows } = await this.client.query<{ number: string }>(
      'SELECT number FROM ticket WHERE id = $1',
      [input.ticketId],
    );
    await enqueueOutboxEvent(this.client, {
      eventType: 'ticket.comment.added',
      organizationId: ctx.organizationId,
      payload: {
        ticketId: input.ticketId,
        ticketNumber: ticketRows[0]?.number ?? '',
        actorId: ctx.principal.userId,
        visibility: input.visibility,
      },
    });

    return toComment(rows[0]!);
  }

  /**
   * コメント一覧。
   *
   * **可視性はSQLの条件で絞る。** 全件取得してからフィルタする実装にすると、
   * フィルタを1箇所書き忘れた瞬間に内部メモが漏れる。
   */
  async listComments(ctx: AuthzContext, ticketId: string): Promise<TicketComment[]> {
    await this.assertTicketAccess(ctx, ticketId);

    const includeInternal = this.canSeeInternal(ctx);
    const { rows } = await this.client.query(
      `SELECT * FROM ticket_comment
        WHERE ticket_id = $1
          AND ($2::boolean OR visibility = 'public')
        ORDER BY created_at, id`,
      [ticketId, includeInternal],
    );
    return rows.map(toComment);
  }

  /** 単一取得。権限のない内部メモは404(存在を推測させない / NFR-SEC-006)。 */
  async findComment(ctx: AuthzContext, commentId: string): Promise<TicketComment> {
    const { rows } = await this.client.query(
      `SELECT * FROM ticket_comment
        WHERE id = $1 AND ($2::boolean OR visibility = 'public')`,
      [commentId, this.canSeeInternal(ctx)],
    );
    if (rows.length === 0) throw Problems.notFound('コメント');
    const comment = toComment(rows[0]!);
    await this.assertTicketAccess(ctx, comment.ticketId);
    return comment;
  }

  /**
   * 添付の登録。
   *
   * 順序が重要: 検証 → メタデータ作成(pending)→ アップロードURL発行。
   * 「オブジェクト保存 → メタデータ確定」の順を守るため、
   * メタデータは先に pending で作り、実体が上がってから scan へ進む。
   * 実体が上がらなければ孤児メタデータが残るが、これは棚卸しで回収できる
   * (逆順にすると参照切れ = 実体があるのに辿れない状態になり、回収が難しい)。
   */
  async createAttachment(
    ctx: AuthzContext,
    input: AddAttachmentInput,
  ): Promise<AttachmentUploadTicket> {
    await this.assertTicketAccess(ctx, input.ticketId);

    const visibility = input.visibility ?? 'public';
    if (visibility === 'internal' && !this.canSeeInternal(ctx)) {
      throw Problems.forbidden('内部添付を追加する権限がありません');
    }

    const validation = validateAttachment(input);
    if (!validation.ok) {
      throw Problems.validation([
        { field: 'file', message: validation.message ?? '添付できません' },
      ]);
    }

    const id = uuidv7();
    const storageKey = generateStorageKey();

    const { rows } = await this.client.query(
      `INSERT INTO ticket_attachment
         (id, organization_id, ticket_id, visibility, uploaded_by,
          file_name, content_type, size_bytes, storage_key, scan_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING *`,
      [
        id,
        ctx.organizationId,
        input.ticketId,
        visibility,
        ctx.principal.userId,
        validation.safeFileName,
        input.contentType,
        input.sizeBytes,
        storageKey,
      ],
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.attachment.added',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket',
      targetId: input.ticketId,
      action: 'attachment.create',
      outcome: 'success',
      // ファイル名は監査へ入れない(02.17 §4)。サイズと種類のみ。
      afterState: {
        attachmentId: id,
        visibility,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        scanStatus: 'pending',
      },
    });

    void toAttachment(rows[0]!);
    return {
      attachmentId: id,
      storageKey,
      uploadUrl: this.storage.presignPut(storageKey, MAX_SIGNED_URL_TTL_SECONDS, input.contentType),
    };
  }

  /**
   * ダウンロードURLの発行。
   *
   * ここが FR-TKT-005 の実体。scan_status が clean でなければURLを出さない。
   * 「UIに表示しない」ではなく「URLが存在しない」状態にする。
   */
  async createDownloadUrl(ctx: AuthzContext, attachmentId: string): Promise<SignedUrl> {
    const { rows } = await this.client.query(
      `SELECT * FROM ticket_attachment
        WHERE id = $1 AND ($2::boolean OR visibility = 'public')
          AND deleted_at IS NULL`,
      [attachmentId, this.canSeeInternal(ctx)],
    );
    if (rows.length === 0) throw Problems.notFound('添付ファイル');
    const attachment = toAttachment(rows[0]!);

    await this.assertTicketAccess(ctx, attachment.ticketId);

    if (attachment.scanStatus !== 'clean') {
      await this.denialRecorder.record(ctx.organizationId, {
        eventType: 'authz.access.denied',
        organizationId: ctx.organizationId,
        actorType: 'user',
        actorId: ctx.principal.userId,
        targetType: 'attachment',
        targetId: attachmentId,
        action: 'attachment.download',
        outcome: 'denied',
        policyDecision: { rule: 'scan_gate', scanStatus: attachment.scanStatus },
      });
      throw Problems.conflict(
        attachment.scanStatus === 'pending'
          ? 'ファイルの検査中です。しばらくしてからお試しください。'
          : 'このファイルは安全性が確認できないため取得できません。',
      );
    }

    const url = this.storage.presignGet(
      rows[0]!.storage_key as string,
      MAX_SIGNED_URL_TTL_SECONDS,
      attachment.fileName,
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.attachment.downloaded',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'attachment',
      targetId: attachmentId,
      action: 'attachment.download',
      outcome: 'success',
      afterState: { ticketId: attachment.ticketId, ttlSeconds: url.ttlSeconds },
    });

    return url;
  }

  async listAttachments(ctx: AuthzContext, ticketId: string): Promise<TicketAttachment[]> {
    await this.assertTicketAccess(ctx, ticketId);
    const { rows } = await this.client.query(
      `SELECT * FROM ticket_attachment
        WHERE ticket_id = $1 AND ($2::boolean OR visibility = 'public')
          AND deleted_at IS NULL
        ORDER BY created_at, id`,
      [ticketId, this.canSeeInternal(ctx)],
    );
    return rows.map(toAttachment);
  }

  /**
   * 添付の削除。
   *
   * **実体は消すが、あったことは残す。**
   *
   *   実体を残すと   → 削除したつもりで漏えいが続く
   *   記録ごと消すと → 誰が何を消したか追えず、証拠隠滅と区別できない
   *
   * 誤って他人の情報が写った画像を添付した場合、メタデータを隠すだけでは
   * 実体が残り、署名を作れる者には依然として読める。
   * **実体を消して初めて「取り消した」と言える。**
   *
   * 消せるのは「自分が添付したもの」と「担当者が組織内のもの」に限る。
   * 依頼者が担当者の添付を消せると、対応の記録を一方的に削れてしまう。
   */
  async deleteAttachment(ctx: AuthzContext, attachmentId: string, reason: string): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      // 理由の無い削除は、後から「なぜ消えたのか」が分からない。
      throw Problems.validation([{ field: 'reason', message: '削除の理由を入力してください' }]);
    }

    const { rows } = await this.client.query(
      `SELECT * FROM ticket_attachment WHERE id = $1 AND deleted_at IS NULL`,
      [attachmentId],
    );
    if (rows.length === 0) throw Problems.notFound('添付ファイル');
    const attachment = toAttachment(rows[0]!);

    // チケットへのアクセス権が無ければ、そもそも存在を知られない。
    await this.assertTicketAccess(ctx, attachment.ticketId);

    // 内部添付は内部を見られる者だけが消せる。
    if (attachment.visibility === 'internal' && !this.canSeeInternal(ctx)) {
      throw Problems.notFound('添付ファイル');
    }

    const isOwner = attachment.uploadedBy === ctx.principal.userId;
    const isAgent = this.canSeeInternal(ctx);
    if (!isOwner && !isAgent) {
      await this.denialRecorder.record(ctx.organizationId, {
        eventType: 'authz.access.denied',
        organizationId: ctx.organizationId,
        actorType: 'user',
        actorId: ctx.principal.userId,
        targetType: 'ticket_attachment',
        targetId: attachmentId,
        action: 'delete',
        outcome: 'denied',
        policyDecision: { rule: 'attachment_delete', detail: '自分が添付したものではありません' },
      });
      throw Problems.forbidden('この添付を削除する権限がありません');
    }

    // **先に実体を消す。** メタデータを先に消すと、実体の削除に失敗したとき
    // 「消えたはずのファイルが残っている」状態になり、しかも一覧に出ないため
    // 気付けない。実体の削除が失敗すれば、ここで処理全体が止まる。
    //
    // `storageKey` は表示用の型に含めていない(実体の場所を外へ出さないため)。
    // ここでは行から直接読む。
    await this.storage.deleteObject(rows[0]!.storage_key as string);

    await this.client.query(
      `UPDATE ticket_attachment
          SET deleted_at = now(), deleted_by = $2, deletion_reason = $3
        WHERE id = $1`,
      [attachmentId, ctx.principal.userId, trimmed.slice(0, 500)],
    );

    await recordAuditEvent(this.client, {
      eventType: 'ticket.attachment.deleted',
      organizationId: ctx.organizationId,
      actorType: 'user',
      actorId: ctx.principal.userId,
      targetType: 'ticket_attachment',
      targetId: attachmentId,
      action: 'delete',
      outcome: 'success',
      // **ファイル名は残す。** 何が削除されたか分からなければ監査にならない。
      // 理由も残す — 「誤添付」と「証拠隠滅」を後から区別する材料になる。
      beforeState: { fileName: attachment.fileName, visibility: attachment.visibility },
      afterState: { deleted: true, reason: trimmed.slice(0, 500) },
    });
  }

  /**
   * スキャン結果の反映。スキャナ本体の統合は後続WP。
   * ここでは結果を受け取る口だけを用意し、clean 以外は配布されない状態を保つ。
   */
  async recordScanResult(
    attachmentId: string,
    status: Exclude<ScanStatus, 'pending'>,
  ): Promise<void> {
    await this.client.query(
      `UPDATE ticket_attachment SET scan_status = $2, scanned_at = now() WHERE id = $1`,
      [attachmentId, status],
    );
  }
}

function toComment(row: Record<string, unknown>): TicketComment {
  return {
    id: row.id as string,
    ticketId: row.ticket_id as string,
    authorId: row.author_id as string,
    visibility: row.visibility as Visibility,
    body: row.body as string,
    createdAt: row.created_at as Date,
  };
}

function toAttachment(row: Record<string, unknown>): TicketAttachment {
  return {
    id: row.id as string,
    ticketId: row.ticket_id as string,
    visibility: row.visibility as Visibility,
    uploadedBy: row.uploaded_by as string,
    fileName: row.file_name as string,
    contentType: row.content_type as string,
    sizeBytes: Number(row.size_bytes),
    scanStatus: row.scan_status as ScanStatus,
    createdAt: row.created_at as Date,
  };
}

export { MAX_ATTACHMENT_BYTES };
