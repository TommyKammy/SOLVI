-- 添付スキャンの実行状態 (WP-P2-SCAN-011 / OQ-011)
--
-- `scan_status` は既に 0005 で存在するが、**判定できなかった場合**を扱う列が無い。
--
-- スキャナへ到達できない、応答が解釈できない、サイズ上限を超える —
-- これらを `clean` にすると検疫が素通りする。`infected` にすると正当なファイルが
-- 永久に開けなくなる。したがって `pending` のまま残して再試行するが、
-- **何回試したか・なぜ失敗したかを残さないと、滞留が見えない。**

-- +migrate up

ALTER TABLE ticket_attachment
  ADD COLUMN scan_attempts   smallint NOT NULL DEFAULT 0,
  ADD COLUMN scan_signature  text,
  ADD COLUMN scan_last_error text;

COMMENT ON COLUMN ticket_attachment.scan_attempts IS
  'スキャン試行回数。上限に達したものは人が確認する(自動では clean にしない)';
COMMENT ON COLUMN ticket_attachment.scan_signature IS
  '検出した検体名。infected のときのみ。ファイル名は含めない(業務情報が入る)';
COMMENT ON COLUMN ticket_attachment.scan_last_error IS
  '判定できなかった理由。scan_status は pending のまま動かさない';

-- infected でないのに検体名が入っている状態を作らせない。
ALTER TABLE ticket_attachment ADD CONSTRAINT ticket_attachment_signature_consistency
  CHECK (scan_signature IS NULL OR scan_status = 'infected');

-- 滞留の監視索引(`ticket_attachment_pending_scan_idx`)は 0005 で既に作成済み。
-- ここでは作らない。

-- ---------------------------------------------------------------------------
-- スキャナの読み取り例外(登録制)
--
-- スキャン対象の取得は全Organizationを横断する。組織コンテキストを持たないため
-- `ticket_attachment` の組織RLSでは1件も引けない。
--
-- migration 0010(Outboxディスパッチャ)と 0011(認証層)と同じ**登録制の例外**にする。
-- ただし専用のフラグを使い、`app.dispatcher` を流用しない。
-- 流用すると「Outboxの越境を許した設定」が添付にも効くことになり、
-- 0010 が明示した「例外は outbox_event の1テーブルに限定する」が崩れる。
--
-- 制限:
--   * `FOR SELECT` のみ。結果の書き戻しは対象組織のコンテキストで行う
--   * 対象は `ticket_attachment` の1テーブルのみ
--   * `SET LOCAL` でのみ設定する
--
-- 添付の**実体**はオブジェクトストレージにあり、この例外で読めるのは
-- メタデータ(ファイル名・サイズ・保管キー)だけである。
-- ---------------------------------------------------------------------------

CREATE POLICY ticket_attachment_scanner_lookup ON ticket_attachment
  FOR SELECT USING (current_setting('app.scanner', true) = 'on');

COMMENT ON POLICY ticket_attachment_scanner_lookup ON ticket_attachment IS
  'ウイルススキャナの読み取り専用例外(02.18 §3 / WP-P2-SCAN-011)。SET LOCAL app.scanner のトランザクション内に限る';

-- +migrate down

DROP POLICY IF EXISTS ticket_attachment_scanner_lookup ON ticket_attachment;

ALTER TABLE ticket_attachment DROP CONSTRAINT IF EXISTS ticket_attachment_signature_consistency;
ALTER TABLE ticket_attachment
  DROP COLUMN IF EXISTS scan_last_error,
  DROP COLUMN IF EXISTS scan_signature,
  DROP COLUMN IF EXISTS scan_attempts;
