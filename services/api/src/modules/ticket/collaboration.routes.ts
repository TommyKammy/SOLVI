import type pg from 'pg';
import {
  Problems,
  recordDomainEvent,
  allowedTransitionsFrom,
  isDerivedPriority,
  IMPACT_LEVELS,
  URGENCY_LEVELS,
  type Impact,
  type Urgency,
} from '@solvi/shared';
import { TicketService } from './ticket.service.js';
import { GroupService } from './group.service.js';
import {
  CollaborationService,
  type TicketComment,
  type TicketAttachment,
} from './collaboration.service.js';
import type { ObjectStorage } from '@solvi/shared';
import type { PoolDenialRecorder } from '../../common/audit/denial-recorder.js';
import { hasRole } from '../../common/authz/authz.js';
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
  // 「解決したが直っていない」ときの操作。状態名ではなく行動で書く。
  'in_progress:reopen': '対応を再開する(解決を取り消す)',
};

/**
 * 人が選べない遷移理由。
 *
 * `auto_close` は**時間による自動遷移**であり、押すボタンではない
 * (03.3 状態機械「Closed(Resolved後14日で自動)」)。
 * 除外しないと「完了にする」(`close`)と並んで
 * **同じ意味のボタンが2つ出る**。実際そうなっていた。
 *
 * `merge` は関連付けの画面の操作である。ここに出すと
 * 「間違えて統合してしまった」が起きやすい。
 */
const NOT_MANUAL_REASONS = new Set(['auto_close', 'merge']);

function toActions(state: string): AvailableAction[] {
  return allowedTransitionsFrom(state as never)
    .filter((rule) => !NOT_MANUAL_REASONS.has(rule.reason) && rule.to !== 'merged')
    .map((rule) => ({
      to: rule.to,
      reason: rule.reason,
      // **内部の状態名を画面へ出さない。** 訳が無いことに気付ける形にする。
      // 以前は `?? \`${rule.to} にする\`` で埋めていたため、
      // `reopen` と `auto_close` が「in_progress にする」「closed にする」
      // という生の状態名で表示されていた。
      label: ACTION_LABELS[`${rule.to}:${rule.reason}`] ?? `${rule.to} (${rule.reason})`,
    }));
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

/**
 * 添付の表示用。
 *
 * **保管キーを返さない。** 実体の場所が分かると、署名の不備を突く試行の
 * 出発点になる。ダウンロードは毎回サーバへ問い合わせて署名を発行する。
 */
function toAttachmentView(attachment: TicketAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    // 誰が添付したかは画面が「自分のものか」を判断するために要る。
    // 表示名ではなくIDにとどめる — 一覧に他人の名前を並べる必要は無い。
    uploadedBy: attachment.uploadedBy,
    fileName: attachment.fileName,
    sizeBytes: attachment.sizeBytes,
    visibility: attachment.visibility,
    scanStatus: attachment.scanStatus,
    createdAt: attachment.createdAt.toISOString(),
    // 「開けるかどうか」を明示する。画面が scanStatus を解釈して
    // 判断すると、状態が増えたときに画面ごとに判断が分かれる。
    downloadable: attachment.scanStatus === 'clean',
  };
}

export class CollaborationController {
  constructor(private readonly deps: CollaborationRouteDeps) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (services: {
      tickets: TicketService;
      collab: CollaborationService;
      groups: GroupService;
    }) => Promise<T>,
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
        groups: new GroupService(client, this.deps.denialRecorder),
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
    const result = await this.run(auth, async ({ tickets, collab, groups }) => {
      const ticket = await tickets.findById(auth.authz, ticketId);
      const comments = await collab.listComments(auth.authz, ticketId);
      const attachments = await collab.listAttachments(auth.authz, ticketId);
      // 振り先の選択肢も返す。別の問い合わせにすると、画面が
      // 「グループ名を出すためだけ」に毎回1往復増やすことになる。
      //
      // **振れない人には空で返す。** この応答は依頼者も取得しうる
      // (内部メモが混ざらないことを検査する経路がある)。
      // グループが引けないことを理由に応答全体を失敗させると、
      // 依頼者から見て画面が開かなくなる。
      const availableGroups = hasRole(auth.authz, 'agent', 'org_admin', 'platform_admin')
        ? await groups.list(auth.authz)
        : [];
      return { ticket, comments, attachments, availableGroups };
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
          assigneeGroupId: result.ticket.assigneeGroupId,
          createdAt: result.ticket.createdAt.toISOString(),
          resolvedAt: result.ticket.resolvedAt?.toISOString() ?? null,
        },
        comments: result.comments.map(toCommentView),
        attachments: result.attachments.map(toAttachmentView),
        availableActions: toActions(result.ticket.state),
        // 振り先の候補。**無効化したグループは含まれない**(新しく振れない)。
        availableGroups: result.availableGroups.map((g) => ({
          id: g.id,
          name: g.name,
          memberCount: g.memberCount,
        })),
        // **優先度が規則どおりかを画面へ渡す。**
        //
        // 優先度は影響度×緊急度から導かれる値であり、直接書き換える経路は無い。
        // それでも DB を直接触られたり、将来の機能が上書きしたりすれば食い違いうる。
        // 食い違ったまま画面に出すと、**再現できない優先度**を根拠に
        // 対応順が決まることになる。合わないなら合わないと言う。
        priorityIsDerived: isDerivedPriority(
          result.ticket.impact,
          result.ticket.urgency,
          result.ticket.priority,
        ),
      },
    };
  }

  async listAttachments(auth: AuthenticatedRequest, ticketId: string) {
    const attachments = await this.run(auth, ({ collab }) =>
      collab.listAttachments(auth.authz, ticketId),
    );
    return { status: 200, body: { items: attachments.map(toAttachmentView) } };
  }

  /**
   * アップロードURLの発行。
   *
   * ブラウザは**ここで受け取った署名付きURLへ直接 PUT する**。
   * アプリを経由させると、大きなファイルでプロセスが詰まり、
   * 同時に何人かが送っただけで他のリクエストが待たされる。
   *
   * 検証(拡張子・MIME・サイズ)はURLを出す前に行う。
   * 出してしまってから拒否しても、実体は既に保存されている。
   */
  async requestUpload(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const input = parseUploadRequest(body);
    const ticketRecord = await this.run(auth, ({ collab }) =>
      collab.createAttachment(auth.authz, {
        ticketId,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        visibility: input.visibility,
      }),
    );

    return {
      status: 201,
      body: {
        attachmentId: ticketRecord.attachmentId,
        uploadUrl: ticketRecord.uploadUrl.url,
        expiresAt: ticketRecord.uploadUrl.expiresAt.toISOString(),
      },
    };
  }

  /**
   * ダウンロードURLの発行。
   *
   * `scan_status` が `clean` でなければサービス層がURLを出さない。
   * **「画面に出さない」ではなく「URLが存在しない」**状態を保つ。
   */
  async createDownloadUrl(auth: AuthenticatedRequest, attachmentId: string) {
    const signed = await this.run(auth, ({ collab }) =>
      collab.createDownloadUrl(auth.authz, attachmentId),
    );
    return {
      status: 200,
      body: { url: signed.url, expiresAt: signed.expiresAt.toISOString() },
    };
  }

  /**
   * 添付の削除。
   *
   * **理由を必須にする。** 「誤って添付した」と「都合の悪い記録を消した」は
   * 後から区別できなければならない。理由の無い削除は、その区別を放棄することになる。
   */
  async deleteAttachment(auth: AuthenticatedRequest, attachmentId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const reason = typeof record.reason === 'string' ? record.reason : '';

    await this.run(auth, ({ collab }) => collab.deleteAttachment(auth.authz, attachmentId, reason));
    return { status: 204, body: null };
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

  /**
   * 影響度・緊急度の見直し (WP-P2-PRIO-013)。
   *
   * **優先度そのものは受け取らない。** 受け取ると、画面が計算した値と
   * サーバが導く値が食い違ったときに、どちらを採るかという問題が生まれる。
   * 入力は影響度と緊急度だけにし、優先度は常にサーバが導く。
   */
  async reassess(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const input = parseReassessBody(body);
    const ticket = await this.run(auth, ({ tickets }) =>
      tickets.reassess(auth.authz, {
        ticketId,
        impact: input.impact,
        urgency: input.urgency,
        reason: input.reason,
      }),
    );
    recordDomainEvent('ticket.reassessed', 'success');
    return {
      status: 200,
      body: {
        impact: ticket.impact,
        urgency: ticket.urgency,
        priority: ticket.priority,
      },
    };
  }

  /**
   * 担当グループの割当 (FR-TKT-003 / WP-P2-GRP-015)。
   *
   * **個人の担当とは別の経路にする。** 1つのエンドポイントで両方を
   * 受け取ると、「グループだけ変えたつもりで担当も外れた」が起きる。
   */
  async assignGroup(auth: AuthenticatedRequest, ticketId: string, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    // 空文字は「キューから外す」。null と区別せずに扱うと、
    // フォームから空で送られたときに意図せず外れる/外れないが分かれる。
    const raw = record.groupId;
    const groupId = typeof raw === 'string' && raw.length > 0 ? raw : null;

    const ticket = await this.run(auth, ({ tickets }) =>
      tickets.assignGroup(auth.authz, ticketId, groupId),
    );
    recordDomainEvent('ticket.assigned', 'success');
    return { status: 200, body: { assigneeGroupId: ticket.assigneeGroupId } };
  }

  /** 振り先の候補。振る画面が名前を出すために使う。 */
  async listGroups(auth: AuthenticatedRequest) {
    const groups = await this.run(auth, ({ groups: service }) => service.list(auth.authz));
    return {
      status: 200,
      body: {
        items: groups.map((g) => ({
          id: g.id,
          code: g.code,
          name: g.name,
          description: g.description,
          memberCount: g.memberCount,
        })),
      },
    };
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

function parseUploadRequest(body: unknown): {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  visibility: 'public' | 'internal';
} {
  const errors: Array<{ field: string; message: string }> = [];
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  if (fileName.length === 0) {
    errors.push({ field: 'fileName', message: 'ファイルを選んでください' });
  } else if (fileName.length > 255) {
    errors.push({ field: 'fileName', message: 'ファイル名が長すぎます' });
  }

  const contentType = typeof record.contentType === 'string' ? record.contentType : '';
  const sizeBytes = Number(record.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    errors.push({ field: 'sizeBytes', message: 'ファイルの大きさを取得できませんでした' });
  }

  const visibility = String(record.visibility ?? 'public');
  if (!VISIBILITIES.has(visibility)) {
    errors.push({ field: 'visibility', message: '公開範囲を選んでください' });
  }

  if (errors.length > 0) throw Problems.validation(errors);
  return {
    fileName,
    contentType,
    sizeBytes,
    visibility: visibility as 'public' | 'internal',
  };
}

function parseReassessBody(body: unknown): { impact: Impact; urgency: Urgency; reason: string } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const errors: Array<{ field: string; message: string }> = [];

  const impact = String(record.impact ?? '');
  if (!(IMPACT_LEVELS as readonly string[]).includes(impact)) {
    errors.push({ field: 'impact', message: '影響の範囲を選んでください' });
  }
  const urgency = String(record.urgency ?? '');
  if (!(URGENCY_LEVELS as readonly string[]).includes(urgency)) {
    errors.push({ field: 'urgency', message: '急ぎ具合を選んでください' });
  }

  // 理由の長さと空判定はサービス層が持つ。ここで二重に持つと、
  // 片方だけ直したときに食い違う。
  const reason = typeof record.reason === 'string' ? record.reason : '';

  if (errors.length > 0) throw Problems.validation(errors);
  return { impact: impact as Impact, urgency: urgency as Urgency, reason };
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
