import type { NotificationSender } from './notification.service.js';
import type { Logger } from '@solvi/shared';

/**
 * 開発・テスト用の記録型チャネル。
 *
 * 実際のメール送信基盤(SES等)への接続は環境確保後に行う(WP §6 Out of Scope)。
 * 本番用の実装を書く前に、**送る内容が正しいこと**をここで確認できるようにする。
 */
export class RecordingEmailSender implements NotificationSender {
  readonly channel = 'email' as const;
  readonly sent: Array<{ to: string; subject: string; linkPath: string; at: Date }> = [];

  constructor(private readonly logger?: Logger) {}

  async send(params: { to: string; subject: string; linkPath: string }): Promise<void> {
    this.sent.push({ ...params, at: new Date() });
    // 宛先はPII。ログには件名とリンクのみを出す。
    this.logger?.info('notification queued (recording sender)', {
      targetType: 'notification',
      message: params.subject,
    });
  }

  reset(): void {
    this.sent.length = 0;
  }
}

/** 送信を必ず失敗させる。リトライ経路の検証に使う。 */
export class FailingEmailSender implements NotificationSender {
  readonly channel = 'email' as const;
  constructor(private readonly reason = 'SMTP接続に失敗しました') {}
  async send(): Promise<void> {
    throw new Error(this.reason);
  }
}
