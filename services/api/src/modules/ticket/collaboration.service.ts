import type pg from 'pg';
import { Problems, validateAttachment, MAX_ATTACHMENT_BYTES } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
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
} from '../../common/storage/object-storage.js';

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
        WHERE id = $1 AND ($2::boolean OR visibility = 'public')`,
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
        ORDER BY created_at, id`,
      [ticketId, this.canSeeInternal(ctx)],
    );
    return rows.map(toAttachment);
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
