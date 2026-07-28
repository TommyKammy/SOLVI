import type { NotificationSender } from '../../services/api/src/modules/notification/notification.service.js';

/**
 * 送信を必ず失敗させる。リトライ経路の検証に使う。
 *
 * **本番のソースには置かない。** 以前は `services/api` 側にあったが、
 * 意図的に失敗する実装が本番のビルドに含まれていると、
 * 設定の取り違え1つで配送を止められる。テスト専用のものはテスト側に置く。
 */
export class FailingEmailSender implements NotificationSender {
  readonly channel = 'email' as const;
  constructor(private readonly reason = 'SMTP接続に失敗しました') {}
  async send(): Promise<void> {
    throw new Error(this.reason);
  }
}
