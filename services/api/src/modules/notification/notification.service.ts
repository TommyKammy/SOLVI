import type pg from 'pg';
import { scrubFreeText, daysUntil } from '@solvi/shared';
import { recordAuditEvent, uuidv7 } from '../../common/audit/audit.js';
import type { OutboxRecordLike } from './types.js';
import {
  allowTicketEmailPreparation,
  OPTIONAL_TICKET_EMAIL_EVENTS,
} from './notification-preference.service.js';
import {
  activeApprovalDelegateRecipientSql,
  activeMemberRecipientSql,
  activeOrgAdminRecipientSql,
  isApprovalNoticeEventType,
  isDelegationNoticeEventType,
} from '../catalog/approval-notice.js';

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
    // **優先度が変わったことだけを伝える。** どう変わったかは画面で見てもらう。
    // 件名に「critical になりました」と書くと、メールの一覧に
    // 緊急度が並ぶことになり、本文を読まずに騒ぎが起きる。
    'ticket.reassessed': '優先度が見直されました',
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
   * at-least-once配送では成功済みの宛先だけを省略する。
   * pending/failedは同じ行を再利用する。呼出側のOrganization付き
   * トランザクション内で行ロックを保持する(ADR-0008)。
   */
  async deliverForEvent(record: OutboxRecordLike): Promise<{ sent: number; skipped: number }> {
    const organizationId = record.organizationId;

    // **チケット以外の通知がある** (WP-P1-IDM-017)。
    // 役割の期限が近いことを本人と組織の管理者へ知らせる。
    // ここを分けないと、チケット番号を持たない出来事が
    // 「ペイロードが不足している」として恒久失敗になる。
    if (record.eventType === 'role.binding.expiring') {
      return this.deliverRoleExpiryNotice(record);
    }

    // 承認の通知 (WP-P4-APR-019)。チケット番号を持たないため、チケットの経路より先に分ける。
    if (isApprovalNoticeEventType(record.eventType)) {
      return this.deliverApprovalNotice(record);
    }

    // 委任の作成・取消の通知 (WP-P4-APR-020 §6.5)。承認の通知とは宛先も文面も別である。
    if (isDelegationNoticeEventType(record.eventType)) {
      return this.deliverDelegationNotice(record);
    }

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

      const ready = await this.prepareNotification(
        organizationId,
        record.id,
        { channel: 'email', recipient, subject, linkPath },
        OPTIONAL_TICKET_EMAIL_EVENTS.has(record.eventType),
      );

      if (!ready) {
        // 新規の任意通知OFF、または作成済みで送信成功の場合だけ省略する。
        skipped += 1;
        continue;
      }

      await this.dispatch(ready, organizationId, recipient, subject, linkPath);
      sent += 1;
    }

    return { sent, skipped };
  }

  /**
   * 役割の期限が近いことを知らせる (FR-IDM-006 / WP-P1-IDM-017)。
   *
   * 宛先は**本人と、その組織の管理者**である。
   *
   *   - 本人 … 予定を立てられる。切れてから「入れない」と気付くのを防ぐ
   *   - 管理者 … 延長するかどうかを決められる。決められるのは管理者だけである
   *
   * **役割名を件名に書かない。** 「監査者の権限が切れます」と件名に出ると、
   * メールの一覧にその人の権限が並ぶ。何の期限かは画面で見てもらう。
   */
  private async deliverRoleExpiryNotice(
    record: OutboxRecordLike,
  ): Promise<{ sent: number; skipped: number }> {
    const organizationId = record.organizationId;
    const userId = String(record.payload.userId ?? '');
    const validUntil = String(record.payload.validUntil ?? '');

    if (!organizationId || !userId || !validUntil) {
      throw new Error('通知に必要な情報がペイロードにありません');
    }

    const { rows } = await this.client.query<{ user_id: string; email: string | null }>(
      `SELECT DISTINCT u.id AS user_id, u.primary_email::text AS email
         FROM app_user u
         JOIN role_binding rb
           ON rb.user_id = u.id
          AND rb.organization_id = $1
          AND rb.valid_from <= now()
          AND (rb.valid_until IS NULL OR rb.valid_until > now())
         LEFT JOIN role r ON r.id = rb.role_id
        WHERE u.status = 'active'
          -- 本人、または**この組織の管理者**。
          -- 越境しない: role_binding を組織で絞っているため、
          -- 他組織の管理者は候補に上がらない。
          AND (u.id = $2 OR r.code = 'org_admin')`,
      [organizationId, userId],
    );

    const days = daysUntil(validUntil);
    const subject = `[SOLVI] 権限の期限が近づいています(あと ${Math.max(days, 0)} 日)`;
    // 一覧へ送る。**その人の役割を名指ししない。**
    const linkPath = '/ops/users';

    let sent = 0;
    let skipped = 0;
    for (const row of rows) {
      if (!row.email) {
        skipped += 1;
        continue;
      }
      const recipient = { userId: row.user_id, address: row.email };
      const ready = await this.prepareNotification(organizationId, record.id, {
        channel: 'email',
        recipient,
        subject,
        linkPath,
      });
      if (!ready) {
        skipped += 1;
        continue;
      }
      await this.dispatch(ready, organizationId, recipient, subject, linkPath);
      sent += 1;
    }

    return { sent, skipped };
  }

  /**
   * 承認の通知を配送する (WP-P4-APR-019 §6.1)。
   *
   * **件名とリンクだけを送る。** 申請の入力値・理由・社員番号・役職・勤務地は
   * 件名にもリンクにも載せない。件名には申請の番号だけを含めてよい。
   *
   * 宛先は**配送の時点**で決める。積んだ時点の宛先を信じない:
   *   - 有効な所属でなくなった利用者へは送らない(ADR-0023 §1)
   *   - 承認者不在の通知は、その組織の現在有効な組織管理者の全員
   *
   * 通知設定(`notification_preference`)は既存の `role.binding.expiring` と同じ扱いにする。
   * この表は `ticket_email_enabled` だけを持ち、チケット以外の通知は止めない。
   */
  private async deliverApprovalNotice(
    record: OutboxRecordLike,
  ): Promise<{ sent: number; skipped: number }> {
    const organizationId = record.organizationId;
    const approvalId = String(record.payload.approvalId ?? '');
    const requestId = String(record.payload.requestId ?? '');
    if (!organizationId || !approvalId || !requestId) {
      throw new Error('通知に必要な情報がペイロードにありません');
    }

    // 種別ごとに必要な宛先が違う。**文面の判断は件名の表だけに閉じる。**
    const labels: Record<string, string> = {
      requested: '承認の依頼があります',
      expiring: '承認期限が近づいています',
      expired: '承認期限が過ぎました。再申請を確認してください',
      approver_unavailable: '承認者が不在です',
    };
    const kind = record.eventType.slice('approval.notice.'.length);
    const label = labels[kind];
    if (!label) throw new Error('承認の通知の種類を確認できません');

    // 対象の申請と番号。RLS の組織文脈に加え、明示的に組織で絞る。
    const target = (
      await this.client.query<{ requester_id: string; number: string }>(
        `SELECT q.requester_id, t.number
           FROM local_service_request q
           JOIN ticket t ON t.id=q.ticket_id AND t.organization_id=q.organization_id
          WHERE q.id=$1 AND q.organization_id=$2`,
        [requestId, organizationId],
      )
    ).rows[0];
    const approval = (
      await this.client.query<{
        request_id: string;
        approver_id: string;
        authority_type: string;
      }>(
        `SELECT request_id, approver_id, authority_type FROM local_request_approval
          WHERE id=$1 AND organization_id=$2`,
        [approvalId, organizationId],
      )
    ).rows[0];
    if (!target || !approval || approval.request_id !== requestId) {
      // 対象が読めない通知は送らない。再試行の上限で止まり、運用が気付ける。
      throw new Error('承認の通知の対象を確認できません');
    }

    // 依頼・期限前は、承認者に加えて**配送の時点で有効な委任の代理者**へも送る
    // (ADR-0025 §5)。委任が無効(期間外・取消済み・委任者や代理者が資格を失った)なら
    // 宛先に上がらない。承認者不在の判定と、期限切れの宛先(申請者)は変えない。
    let recipients: NotificationRecipient[];
    if (kind === 'approver_unavailable') recipients = await this.activeOrgAdmins(organizationId);
    else if (kind === 'expired')
      recipients = await this.activeMembers(organizationId, target.requester_id);
    else
      recipients = this.mergeRecipients(
        await this.activeMembers(organizationId, approval.approver_id),
        await this.activeApprovalDelegates(
          organizationId,
          approval.approver_id,
          approval.authority_type,
        ),
      );
    if (recipients.length === 0) return { sent: 0, skipped: 1 };

    // 件名には申請番号を含めてよい。**入力値・理由・個人データは含めない。**
    const subject = `[${target.number}] ${label}`;
    // 承認者不在の通知だけは再割当の画面へ送る。再割当の操作は `/ops/approvals` にしかない
    // (申請の詳細には無い)。リンクにクエリ・フラグメント・申請ID・個人データを付けない。
    const linkPath = kind === 'approver_unavailable' ? '/ops/approvals' : `/requests/${requestId}`;

    let sent = 0;
    let skipped = 0;
    for (const recipient of recipients) {
      const ready = await this.prepareNotification(organizationId, record.id, {
        channel: 'email',
        recipient,
        subject,
        linkPath,
      });
      if (!ready) {
        skipped += 1;
        continue;
      }
      await this.dispatch(ready, organizationId, recipient, subject, linkPath);
      sent += 1;
    }
    return { sent, skipped };
  }

  /** 有効な所属の利用者だけを返す(判定は `approval-resolver` の共有述語)。 */
  private async activeMembers(
    organizationId: string,
    userId: string,
  ): Promise<NotificationRecipient[]> {
    const { rows } = await this.client.query<{ user_id: string; email: string | null }>(
      activeMemberRecipientSql({ organizationId: '$1', userId: '$2', at: 'now()' }),
      [organizationId, userId],
    );
    return rows
      .filter((row): row is { user_id: string; email: string } => Boolean(row.email))
      .map((row) => ({ userId: row.user_id, address: row.email }));
  }

  /** その組織の現在有効な組織管理者の全員。 */
  private async activeOrgAdmins(organizationId: string): Promise<NotificationRecipient[]> {
    const { rows } = await this.client.query<{ user_id: string; email: string | null }>(
      activeOrgAdminRecipientSql({ organizationId: '$1', at: 'now()' }),
      [organizationId],
    );
    return rows
      .filter((row): row is { user_id: string; email: string } => Boolean(row.email))
      .map((row) => ({ userId: row.user_id, address: row.email }));
  }

  /**
   * ある承認者宛ての、配送の時点で有効な委任の代理者(ADR-0025 §2・§3)。
   * 判定は `approval-notice.ts` の共有述語に閉じる(期間・取消・資格をここで書き直さない)。
   */
  private async activeApprovalDelegates(
    organizationId: string,
    approverId: string,
    authorityType: string,
  ): Promise<NotificationRecipient[]> {
    const { rows } = await this.client.query<{ user_id: string; email: string | null }>(
      activeApprovalDelegateRecipientSql({
        organizationId: '$1',
        approverId: '$2',
        authorityType: '$3',
        at: 'now()',
      }),
      [organizationId, approverId, authorityType],
    );
    return rows
      .filter((row): row is { user_id: string; email: string } => Boolean(row.email))
      .map((row) => ({ userId: row.user_id, address: row.email }));
  }

  /** 宛先を利用者IDで重複排除する(承認者と代理者が同じになることはないが、防御的に行う)。 */
  private mergeRecipients(...groups: NotificationRecipient[][]): NotificationRecipient[] {
    const seen = new Map<string, NotificationRecipient>();
    for (const group of groups)
      for (const recipient of group)
        if (!seen.has(recipient.userId)) seen.set(recipient.userId, recipient);
    return [...seen.values()];
  }

  /**
   * 委任の作成・取消の通知 (WP-P4-APR-020 §6.5)。
   *
   * **件名とリンクだけを送る。** 委任者・代理者の氏名、期間、取消の理由は件名にも
   * リンクにも載せない。宛先は配送の時点で委任の行から解決し、有効な所属の
   * 利用者にだけ送る(資格を失った人へは送らない)。
   */
  private async deliverDelegationNotice(
    record: OutboxRecordLike,
  ): Promise<{ sent: number; skipped: number }> {
    const organizationId = record.organizationId;
    const delegationId = String(record.payload.delegationId ?? '');
    if (!organizationId || !delegationId) {
      throw new Error('通知に必要な情報がペイロードにありません');
    }
    const delegation = (
      await this.client.query<{ delegator_id: string; delegate_id: string }>(
        `SELECT delegator_id, delegate_id FROM approval_delegation
          WHERE id=$1 AND organization_id=$2`,
        [delegationId, organizationId],
      )
    ).rows[0];
    if (!delegation) {
      // 対象が読めない通知は送らない。再試行の上限で止まり、運用が気付ける。
      throw new Error('委任の通知の対象を確認できません');
    }
    const label =
      record.eventType === 'approval.delegation.created'
        ? '代理承認の委任を作成しました'
        : '代理承認の委任を取り消しました';
    const subject = `[SOLVI] ${label}`;
    // 委任の画面(段階B)。クエリ・フラグメント・委任のIDを付けない。
    const linkPath = '/approvals/delegations';

    const recipients = this.mergeRecipients(
      await this.activeMembers(organizationId, delegation.delegator_id),
      await this.activeMembers(organizationId, delegation.delegate_id),
    );

    let sent = 0;
    let skipped = 0;
    for (const recipient of recipients) {
      const ready = await this.prepareNotification(organizationId, record.id, {
        channel: 'email',
        recipient,
        subject,
        linkPath,
      });
      if (!ready) {
        skipped += 1;
        continue;
      }
      await this.dispatch(ready, organizationId, recipient, subject, linkPath);
      sent += 1;
    }
    return { sent, skipped };
  }

  /** @returns 配送する通知ID。成功済み/任意新規通知OFFはnull。呼出側の取引を必要とする。 */
  private async prepareNotification(
    organizationId: string,
    outboxEventId: string,
    draft: NotificationDraft,
    optionalTicketEmail = false,
  ): Promise<string | null> {
    if (
      optionalTicketEmail &&
      draft.channel === 'email' &&
      !(await allowTicketEmailPreparation(
        this.client,
        organizationId,
        draft.recipient.userId,
        outboxEventId,
        draft.recipient.address,
      ))
    )
      return null;

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
    if (rowCount === 1) return id;

    // INSERT競合は送信成功を意味しない。既存行をロックし、待機した
    // 同時試行も先行取引のコミット後の状態を見て判断する。
    const { rows } = await this.client.query<{
      id: string;
      organization_id: string;
      outbox_event_id: string;
      recipient_address: string;
      recipient_user_id: string;
      channel: string;
      status: string;
    }>(
      `SELECT id, organization_id, outbox_event_id, recipient_address,
              recipient_user_id, channel, status
         FROM notification
        WHERE organization_id = $1
          AND outbox_event_id = $2
          AND recipient_address = $3
        FOR UPDATE`,
      [organizationId, outboxEventId, draft.recipient.address],
    );
    const existing = rows[0];
    if (
      rows.length !== 1 ||
      !existing ||
      existing.organization_id !== organizationId ||
      existing.outbox_event_id !== outboxEventId ||
      existing.recipient_address !== draft.recipient.address ||
      existing.recipient_user_id !== draft.recipient.userId ||
      existing.channel !== draft.channel
    ) {
      // 他の利用者やチャネルの記録を、配送済みとも再試行対象とも扱わない。
      throw new Error('通知の再試行対象が一致しません');
    }
    if (existing.status === 'sent') return null;
    if (existing.status === 'pending' || existing.status === 'failed') return existing.id;
    throw new Error('通知の再試行状態が不正です');
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
    } catch (error) {
      const reason = scrubFreeText(error instanceof Error ? error.message : String(error), 500);
      await this.client.query(
        `UPDATE notification
            SET status = 'failed', sent_at = NULL, failed_at = now(),
                last_error = $2, attempts = attempts + 1
          WHERE id = $1 AND organization_id = $3`,
        [notificationId, reason, organizationId],
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

    // sender成功後のDB/監査エラーを送信失敗に置き換えない。
    // 監査失敗は呼出側の取引をrollbackさせる。
    await this.client.query(
      `UPDATE notification
          SET status = 'sent', sent_at = now(), failed_at = NULL,
              last_error = NULL, attempts = attempts + 1
        WHERE id = $1 AND organization_id = $2`,
      [notificationId, organizationId],
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
      // 宛先アドレスと件名を監査へ入れず、参照IDだけを保持する。
      afterState: { channel: 'email' },
    });
  }
}
