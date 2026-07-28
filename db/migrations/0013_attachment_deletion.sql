-- 添付の削除 (WP-P2-SCAN-011 追補)
--
-- 誤って添付したファイルを取り消せるようにする。
--
-- 現状、他人の情報が写ったスクリーンショットを添付してしまった場合に
-- **打つ手が無い**。情報漏えいに対して何もできない状態を残さない。
--
-- 設計の要点は「**実体は消すが、あったことは残す**」。
--
--   実体を残すと      → 削除したつもりで漏えいが続く
--   記録ごと消すと    → 誰が何を消したか追えず、証拠隠滅と区別できない
--
-- したがってメタデータは論理削除で残し、オブジェクトストレージの実体だけを
-- 物理削除する。ファイル名も残す — 「何が削除されたか」が分からなければ、
-- 監査として成立しない。

-- +migrate up

ALTER TABLE ticket_attachment
  ADD COLUMN deleted_at      timestamptz,
  ADD COLUMN deleted_by      uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  ADD COLUMN deletion_reason text;

COMMENT ON COLUMN ticket_attachment.deleted_at IS
  '論理削除。実体はオブジェクトストレージから物理削除するが、記録は残す';
COMMENT ON COLUMN ticket_attachment.deleted_by IS
  '削除した利用者。誰が消したか分からない削除は、証拠隠滅と区別できない';
COMMENT ON COLUMN ticket_attachment.deletion_reason IS
  '削除の理由。「誤って添付した」「他人の情報が含まれていた」等';

-- 削除には必ず「誰が」と「なぜ」を伴う。
-- どちらか欠けた削除を作れないようにする。
ALTER TABLE ticket_attachment ADD CONSTRAINT ticket_attachment_deletion_complete
  CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL)
    OR
    (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND deletion_reason IS NOT NULL)
  );

-- 一覧は削除済みを除外する。索引で絞る。
CREATE INDEX ticket_attachment_active_idx
  ON ticket_attachment (ticket_id, created_at)
  WHERE deleted_at IS NULL;

-- 削除済みはスキャン対象から外す。実体が無いので永久に deferred になる。
DROP INDEX IF EXISTS ticket_attachment_pending_scan_idx;
CREATE INDEX ticket_attachment_pending_scan_idx
  ON ticket_attachment (created_at)
  WHERE scan_status = 'pending' AND deleted_at IS NULL;

-- +migrate down

DROP INDEX IF EXISTS ticket_attachment_active_idx;
DROP INDEX IF EXISTS ticket_attachment_pending_scan_idx;
CREATE INDEX ticket_attachment_pending_scan_idx
  ON ticket_attachment (created_at)
  WHERE scan_status = 'pending';
ALTER TABLE ticket_attachment DROP CONSTRAINT IF EXISTS ticket_attachment_deletion_complete;
ALTER TABLE ticket_attachment
  DROP COLUMN IF EXISTS deletion_reason,
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at;
