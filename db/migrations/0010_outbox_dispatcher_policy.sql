-- Outboxディスパッチャの越境例外
-- WP-P2-NTF-005 / 02.18 §3 の「登録制の全org走査ジョブ」に該当
--
-- ディスパッチャは全Organizationのイベントを配送する背景ジョブであり、
-- 組織コンテキストを持たない。一方、RLSを外すと業務データまで見えてしまう。
--
-- したがって例外は **outbox_event の1テーブルに限定**する。
-- 個々のイベントを処理する際は app.current_org を対象組織へ設定するため、
-- ハンドラが触る業務テーブルは通常どおりRLSの下にある。

-- +migrate up

DROP POLICY IF EXISTS outbox_event_isolation ON outbox_event;

-- 通常の組織コンテキストからは自組織のみ。
CREATE POLICY outbox_event_isolation ON outbox_event
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org() OR organization_id IS NULL);

-- ディスパッチャ専用。app.dispatcher = 'on' はトランザクションローカルでのみ設定する
-- (SET LOCAL)。接続に残らないため、通常のリクエスト処理へ漏れない。
CREATE POLICY outbox_event_dispatcher ON outbox_event
  USING (current_setting('app.dispatcher', true) = 'on')
  WITH CHECK (current_setting('app.dispatcher', true) = 'on');

COMMENT ON POLICY outbox_event_dispatcher ON outbox_event IS
  '全org走査の背景ジョブ用(02.18 §3 例外2)。この例外は outbox_event のみに適用する。';

-- +migrate down

DROP POLICY IF EXISTS outbox_event_dispatcher ON outbox_event;
DROP POLICY IF EXISTS outbox_event_isolation ON outbox_event;
CREATE POLICY outbox_event_isolation ON outbox_event
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org() OR organization_id IS NULL);
