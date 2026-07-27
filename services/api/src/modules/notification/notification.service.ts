import type pg from 'pg';
import { scrubFreeText } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { OutboxRecordLike } from './types.js';

/**
 * 通知の組み立てと配送(FR-TKT-007)。
 *
 * このモジュールの設計は「何を送らないか」で決まっている。
 *
 * **本文を送らない。** 件名とリンクだけを送り、中身はリンク先で認証してから見せる。
 * メールは転送・誤送信・端末紛失・メールボックスの共有で第三者の目に触れる。
 * 本文を載せなければ、漏えいは「そのチケットが存在すること」までに留まる。
 *
 * **内部メモを通知しない。** IT担当の調査メモには他の利用者の情報や未確定の憶測が
 * 含まれる。依頼者へ通知が飛ぶ経路を作らない(FR-TKT-004)。
 */

export type NotificationChannel = 'email' | 'webhook';

export interface NotificationRecipient {
  userId: string;
  address: string;
}

export interface NotificationDraft {
  channel: NotificationChannel;
  recipient: NotificationRecipient;
  subject: string;
  linkPath: string;
}

/** 配送チャネルの実装。開発時は記録型、本番はSES等へ差し替える。 */
export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(params: { to: string; subject: string; linkPath: string }): Promise<void>;
}

/**
 * 通知対象としないイベント。
 *
 * ここに載せる判断は「うるさいから」ではなく「送ってはいけないから」。
 * 単なる音量調整は購読設定(将来)で行う。
 */
const NEVER_NOTIFY: ReadonlySet<string> = new Set([
  // 内部メモは依頼者に見えない。通知経路も作らない(FR-TKT-004)。
  'ticket.comment.added:internal',
]);

export function isNotifiable(eventType: string, visibility?: string): boolean {
  if (visibility) return !NEVER_NOTIFY.has(`${eventType}:${visibility}`);
  return !NEVER_NOTIFY.has(eventType);
}

/** 件名の組み立て。**本文は含めない。** */
export function buildSubject(eventType: string, ticketNumber: string): string {
  const label: Record<string, string> = {
    'ticket.created': '受け付けました',
    'ticket.transitioned': '状況が更新されました',
    'ticket.assigned': '担当者が決まりました',
    'ticket.comment.added': '新しいコメントがあります',
    'ticket.merged': '他の問い合わせに統合されました',
  };
  return `[${ticketNumber}] ${label[eventType] ?? '更新がありました'}`;
}

export function buildLinkPath(ticketId: string): string {
  return `/tickets/${ticketId}`;
}

export class NotificationService {
  constructor(
    private readonly client: pg.PoolClient | pg.Client,
    private readonly senders: Map<NotificationChannel, NotificationSender>,
  ) {}

  /**
   * 宛先を解決する。
   *
   * **必ず Organization 内で完結させる。** role_binding を経由して所属を確認するため、
   * 他組織のユーザは物理的に候補に上がらない。件名だけでも業務内容は漏れる。
   */
  async resolveRecipients(
    organizationId: string,
    ticketId: string,
  ): Promise<NotificationRecipient[]> {
    const { rows } = await this.client.query<{ user_id: string; email: string | null }>(
      `SELECT DISTINCT u.id AS user_id, u.primary_email::text AS email
         FROM ticket t
         JOIN app_user u
           ON u.id IN (t.requester_id, t.assignee_id)
         JOIN role_binding rb
           ON rb.user_id = u.id
          AND rb.organization_id = $2
          AND rb.valid_from <= now()
          AND (rb.valid_until IS NULL OR rb.valid_until > now())
        WHERE t.id = $1
          AND t.organization_id = $2
          AND u.status = 'active'`,
      [ticketId, organizationId],
    );

    // 無効化されたユーザや、メールアドレスのないユーザへは送らない
    return rows
      .filter((r): r is { user_id: string; email: string } => Boolean(r.email))
      .map((r) => ({ userId: r.user_id, address: r.email }));
  }

  /**
   * Outboxイベントから通知を作成して送る。
   *
   * `notification` には (outbox_event_id, recipient_address) の一意制約があり、
   * at-least-once配送でディスパッチャが同じイベントを2回処理しても、
   * 受信者から見た重複は生じない(ADR-0008 の「受信側の冪等性」)。
   */
  async deliverForEvent(record: OutboxRecordLike): Promise<{ sent: number; skipped: number }> {
    const organizationId = record.organizationId;
    const ticketId = String(record.payload.ticketId ?? '');
    const ticketNumber = String(record.payload.ticketNumber ?? '');

    if (!organizationId || !ticketId || !ticketNumber) {
      // ペイロードが不足している。再試行しても直らないため呼び出し側が
      // permanent_failure として扱えるよう、例外ではなく明示的に返す。
      throw new Error('通知に必要な情報がペイロードにありません');
    }

    const visibility = record.payload.visibility ? String(record.payload.visibility) : undefined;
    if (!isNotifiable(record.eventType, visibility)) {
      return { sent: 0, skipped: 1 };
    }

    const recipients = await this.resolveRecipients(organizationId, ticketId);
    const subject = buildSubject(record.eventType, ticketNumber);
    const linkPath = buildLinkPath(ticketId);

    let sent = 0;
    let skipped = 0;

    for (const recipient of recipients) {
      // 自分の操作で自分に通知しない。ノイズになるうえ、
      // 「自分が今やった操作」の通知は情報として無価値。
      if (record.payload.actorId && recipient.userId === record.payload.actorId) {
        skipped += 1;
        continue;
      }

      const created = await this.insertNotification(organizationId, record.id, {
        channel: 'email',
        recipient,
        subject,
        linkPath,
      });

      if (!created) {
        // 一意制約により既に作成済み = 前回の試行で送信済み。
        skipped += 1;
        continue;
      }

      await this.dispatch(created, organizationId, recipient, subject, linkPath);
      sent += 1;
    }

    return { sent, skipped };
  }

  /** @returns 作成した通知ID。既に存在する場合は null。 */
  private async insertNotification(
    organizationId: string,
    outboxEventId: string,
    draft: NotificationDraft,
  ): Promise<string | null> {
    const id = uuidv7();
    const { rowCount } = await this.client.query(
      `INSERT INTO notification
         (id, organization_id, outbox_event_id, channel, recipient_user_id,
          recipient_address, subject, link_path, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       -- 一意索引が部分索引(WHERE outbox_event_id IS NOT NULL)のため、
       -- 競合対象にも同じ述語を書く必要がある。省略すると
       -- 「there is no unique or exclusion constraint matching」で失敗する。
       ON CONFLICT (outbox_event_id, recipient_address)
         WHERE outbox_event_id IS NOT NULL
         DO NOTHING`,
      [
        id,
        organizationId,
        outboxEventId,
        draft.channel,
        draft.recipient.userId,
        draft.recipient.address,
        draft.subject,
        draft.linkPath,
      ],
    );
    return rowCount === 1 ? id : null;
  }

  private async dispatch(
    notificationId: string,
    organizationId: string,
    recipient: NotificationRecipient,
    subject: string,
    linkPath: string,
  ): Promise<void> {
    const sender = this.senders.get('email');
    if (!sender) throw new Error('email チャネルの実装が登録されていません');

    try {
      await sender.send({ to: recipient.address, subject, linkPath });
      await this.client.query(
        "UPDATE notification SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1",
        [notificationId],
      );
      await recordAuditEvent(this.client, {
        eventType: 'notification.sent',
        organizationId,
        actorType: 'system',
        subjectUserId: recipient.userId,
        targetType: 'notification',
        targetId: notificationId,
        action: 'send',
        outcome: 'success',
        // 宛先アドレスも件名も監査へ入れない。宛先はPIIであり、
        // 件名にはチケット番号が含まれる。参照IDで足りる。
        afterState: { channel: 'email' },
      });
    } catch (error) {
      const reason = scrubFreeText(error instanceof Error ? error.message : String(error), 500);
      await this.client.query(
        `UPDATE notification
            SET status = 'failed', failed_at = now(), last_error = $2, attempts = attempts + 1
          WHERE id = $1`,
        [notificationId, reason],
      );
      await recordAuditEvent(this.client, {
        eventType: 'notification.failed',
        organizationId,
        actorType: 'system',
        subjectUserId: recipient.userId,
        targetType: 'notification',
        targetId: notificationId,
        action: 'send',
        outcome: 'failure',
        afterState: { channel: 'email', errorSummary: reason },
      });
      throw error;
    }
  }
}
