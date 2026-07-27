-- Transactional Outbox と通知
-- WP-P2-NTF-005 / ADR-0008 / 要求: FR-TKT-007, NFR-SEC-007, NFR-PERF-003
--
-- Outbox の基盤を Phase 2 へ前倒しした(DL-007)。
-- 通知は業務トランザクションと同一に書いたイベントを別プロセスが配送する。
-- 同期送信は「DBはコミットされたが通知は失敗」「通知は送ったがDBはロールバック」を生む。

-- +migrate up

CREATE TABLE outbox_event (
  id               uuid PRIMARY KEY,
  organization_id  uuid REFERENCES organization(id) ON DELETE RESTRICT,
  event_type       text NOT NULL,
  -- 配送に必要な最小限の情報のみ。本文・PIIを入れない(§10 / 02.17 §4)。
  payload          jsonb NOT NULL,

  -- 相関とトレース。Outboxを渡ってもフローを追えるようにする(02.13 §2)。
  correlation_id   text,
  traceparent      text,

  -- 配送の制御
  available_at     timestamptz NOT NULL DEFAULT now(),
  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL DEFAULT 5,
  -- ディスパッチャが取得中である印。異常終了しても期限切れで再取得できる。
  locked_until     timestamptz,
  processed_at     timestamptz,
  failed_at        timestamptz,
  last_error       text,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbox_event_attempts_range CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT outbox_event_max_attempts_positive CHECK (max_attempts > 0),
  -- 成功と失敗は排他。両方が立つ状態を作らない。
  CONSTRAINT outbox_event_terminal_exclusive
    CHECK (NOT (processed_at IS NOT NULL AND failed_at IS NOT NULL)),
  -- 失敗には理由を必ず残す。理由のない失敗は調査できない。
  CONSTRAINT outbox_event_failed_requires_reason
    CHECK (failed_at IS NULL OR last_error IS NOT NULL)
);

-- ディスパッチャの取得クエリ用。未処理・配送可能時刻を過ぎた順に引く。
CREATE INDEX outbox_event_pending_idx
  ON outbox_event (available_at, id)
  WHERE processed_at IS NULL AND failed_at IS NULL;

-- 滞留・失敗の監視用(NFR-PERF-003 / WP-P2-SLO-008)
CREATE INDEX outbox_event_failed_idx ON outbox_event (failed_at DESC)
  WHERE failed_at IS NOT NULL;

COMMENT ON TABLE outbox_event IS
  '業務Txと同一で書く。配送はat-least-once。受信側が冪等性で重複を吸収する(ADR-0008)。';
COMMENT ON COLUMN outbox_event.payload IS
  '配送に必要な最小限のみ。チケット本文・コメント本文・PIIを入れない。';
COMMENT ON COLUMN outbox_event.locked_until IS
  'ディスパッチャの取得ロック。異常終了時は期限切れで他のワーカーが再取得する。';

-- ---------------------------------------------------------------- 通知

CREATE TABLE notification (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  outbox_event_id  uuid REFERENCES outbox_event(id) ON DELETE RESTRICT,

  channel          text NOT NULL,
  recipient_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  -- 宛先の実値。送信時点の値を保持する(後でユーザのメールが変わっても履歴は不変)。
  recipient_address text NOT NULL,

  -- **本文は持たない。** 件名とリンクのみ(§10 本文最小化)。
  subject          text NOT NULL,
  link_path        text NOT NULL,

  status           text NOT NULL DEFAULT 'pending',
  sent_at          timestamptz,
  failed_at        timestamptz,
  last_error       text,
  attempts         smallint NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_channel_check CHECK (channel IN ('email', 'webhook')),
  CONSTRAINT notification_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT notification_subject_not_blank CHECK (length(btrim(subject)) > 0),
  -- リンクは相対パス。完全URLを保持すると環境ごとに書き換えが必要になる。
  CONSTRAINT notification_link_is_relative CHECK (link_path LIKE '/%'),
  CONSTRAINT notification_sent_consistency CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT notification_failed_consistency CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  CONSTRAINT notification_failed_requires_reason
    CHECK (failed_at IS NULL OR last_error IS NOT NULL)
);

-- 同一イベント × 同一宛先の重複送信を防ぐ。
-- at-least-once配送のため、ディスパッチャが同じイベントを2回処理しうる。
-- ここで一意にすることで、受信者から見た重複を排除する(ADR-0008の「受信側の冪等性」)。
CREATE UNIQUE INDEX notification_event_recipient_key
  ON notification (outbox_event_id, recipient_address)
  WHERE outbox_event_id IS NOT NULL;

CREATE INDEX notification_org_created_idx ON notification (organization_id, created_at DESC);
CREATE INDEX notification_failed_idx ON notification (failed_at DESC) WHERE status = 'failed';

COMMENT ON TABLE notification IS
  '本文を持たない。件名とリンクのみ(§10)。メールは転送・誤送信・端末紛失で第三者の目に触れる。';
COMMENT ON INDEX notification_event_recipient_key IS
  'at-least-once配送に対する受信側の冪等性。同一イベント×同一宛先は1通だけ。';

-- ---------------------------------------------------------------- RLS

ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;
-- platform全体のイベント(organization_id IS NULL)はディスパッチャが扱う。
-- 組織コンテキストからは自組織のもののみ見える。
CREATE POLICY outbox_event_isolation ON outbox_event
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org() OR organization_id IS NULL);

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_isolation ON notification
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT, UPDATE ON outbox_event TO solvi_app;
GRANT SELECT, INSERT, UPDATE ON notification TO solvi_app;
GRANT SELECT ON outbox_event, notification TO solvi_auditor;
-- DELETE は与えない。処理済みイベントのアーカイブは別途バッチで行う(owner権限)。

-- +migrate down

DROP TABLE IF EXISTS notification;
DROP TABLE IF EXISTS outbox_event;
