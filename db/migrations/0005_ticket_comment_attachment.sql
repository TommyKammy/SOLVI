-- チケットのコメント・内部メモ・添付
-- WP-P2-COLLAB-004 / 要求: FR-TKT-004, FR-TKT-005
--
-- 内部メモの可視性:
--   visibility 列で 'public' / 'internal' を区別する。
--   依頼者向けの取得は「WHERE visibility = 'public'」を必ず伴う。
--   アプリで取得後にフィルタする実装にしない ― フィルタ漏れが即漏えいになる。
--
-- 添付:
--   本体は Object Storage(ADR-0010)。ここにはメタデータのみを持つ。
--   scan_status が 'clean' になるまで配布しない(FR-TKT-005 / 脅威 T-15)。

-- +migrate up

CREATE TABLE ticket_comment (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  ticket_id        uuid NOT NULL REFERENCES ticket(id) ON DELETE RESTRICT,
  author_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  visibility       text NOT NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ticket_comment_visibility_check CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT ticket_comment_body_not_blank CHECK (length(btrim(body)) > 0)
);

-- 依頼者向けの取得は (ticket_id, visibility) で絞る。この索引がその経路を支える。
CREATE INDEX ticket_comment_ticket_visibility_idx
  ON ticket_comment (ticket_id, visibility, created_at);
CREATE INDEX ticket_comment_author_idx ON ticket_comment (author_id, created_at DESC);

COMMENT ON COLUMN ticket_comment.visibility IS
  'public=依頼者に見える / internal=担当者のみ。取得時にSQLで絞る(FR-TKT-004)。';
COMMENT ON TABLE ticket_comment IS
  '編集・削除を提供しない(履歴の完全性を優先)。訂正は追記で行う。';

CREATE TABLE ticket_attachment (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  ticket_id        uuid NOT NULL REFERENCES ticket(id) ON DELETE RESTRICT,
  -- 内部メモに添付されたファイルは依頼者へ見せない。コメントと同じ区分を持たせる。
  visibility       text NOT NULL DEFAULT 'public',
  uploaded_by      uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  file_name        text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       bigint NOT NULL,
  -- 推測不能なオブジェクトキー。ファイル名や連番を使わない(脅威 T-16)。
  storage_key      text NOT NULL,
  checksum_sha256  text,

  -- スキャン結果。clean 以外は配布しない(FR-TKT-005)。
  scan_status      text NOT NULL DEFAULT 'pending',
  scanned_at       timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ticket_attachment_visibility_check CHECK (visibility IN ('public', 'internal')),
  CONSTRAINT ticket_attachment_scan_status_check
    CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  CONSTRAINT ticket_attachment_size_check
    CHECK (size_bytes > 0 AND size_bytes <= 26214400), -- 25MiB
  CONSTRAINT ticket_attachment_file_name_not_blank CHECK (length(btrim(file_name)) > 0),
  CONSTRAINT ticket_attachment_checksum_format
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  -- スキャン済みなら時刻を持つ。pending のまま scanned_at が入る不整合を防ぐ。
  CONSTRAINT ticket_attachment_scanned_at_consistency
    CHECK ((scan_status = 'pending') = (scanned_at IS NULL))
);

CREATE UNIQUE INDEX ticket_attachment_storage_key_key ON ticket_attachment (storage_key);
CREATE INDEX ticket_attachment_ticket_idx
  ON ticket_attachment (ticket_id, visibility, created_at);
-- スキャン待ちの滞留を運用で拾えるようにする
CREATE INDEX ticket_attachment_pending_scan_idx ON ticket_attachment (created_at)
  WHERE scan_status = 'pending';

COMMENT ON COLUMN ticket_attachment.storage_key IS
  'Object Storage 上のキー。推測不能な値にする。ファイル名をそのまま使わない(脅威 T-16)。';
COMMENT ON COLUMN ticket_attachment.scan_status IS
  'clean になるまでダウンロードURLを発行しない(FR-TKT-005)。';

-- ---------------------------------------------------------------- RLS

ALTER TABLE ticket_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_comment FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_comment_isolation ON ticket_comment
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE ticket_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_attachment_isolation ON ticket_attachment
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------------------------------------------------------------- 権限

-- コメントは追記のみ。UPDATE を与えない(編集を提供しない設計をDB側でも表現する)。
GRANT SELECT, INSERT ON ticket_comment TO solvi_app;
GRANT SELECT ON ticket_comment TO solvi_auditor;

-- 添付はスキャン結果の書き戻しがあるため UPDATE を与える。
GRANT SELECT, INSERT, UPDATE ON ticket_attachment TO solvi_app;
GRANT SELECT ON ticket_attachment TO solvi_auditor;

-- +migrate down

DROP TABLE IF EXISTS ticket_attachment;
DROP TABLE IF EXISTS ticket_comment;
