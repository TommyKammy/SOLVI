-- WP-P4-APR-014 / ADR-0023 §6・§8・§11. Approval route and serial steps.
--
-- 方針:
--  - 加算的な列追加のみ。既存の申請・版・承認行の中身は書き換えない。
--  - 移行前の承認行は step_no=1, route_generation=1, authority_type='legacy' として読める。
--    既存申請の route は NULL のまま(再解決しない)。
--  - 新しい版・ステップは製品コードが必ず route / route_hash / route_generation を保存する。
--  - down は新しい列にデータがあれば拒否する(0036 / 0037 と同じ方式の前進修復)。
-- +migrate up

ALTER TABLE local_request_revision
  ADD COLUMN route jsonb NULL,
  ADD COLUMN route_hash text NULL,
  ADD COLUMN route_generation integer NOT NULL DEFAULT 1;

ALTER TABLE local_request_revision
  ADD CONSTRAINT local_request_revision_route_object
    CHECK (route IS NULL OR jsonb_typeof(route) = 'object'),
  ADD CONSTRAINT local_request_revision_route_hash_format
    CHECK (route_hash IS NULL OR route_hash ~ '^[0-9a-f]{64}$'),
  -- route と route_hash は対で保存する。片方だけの行は検証できないため拒否する。
  ADD CONSTRAINT local_request_revision_route_pair
    CHECK ((route IS NULL) = (route_hash IS NULL)),
  ADD CONSTRAINT local_request_revision_route_generation_check
    CHECK (route_generation >= 1);

ALTER TABLE local_request_approval
  ADD COLUMN step_no integer NOT NULL DEFAULT 1,
  ADD COLUMN route_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN authority_type text NOT NULL DEFAULT 'legacy',
  ADD COLUMN resolved_from text NULL,
  ADD COLUMN decided_by uuid NULL REFERENCES app_user(id) ON DELETE RESTRICT;

ALTER TABLE local_request_approval
  ADD CONSTRAINT local_request_approval_step_no_check CHECK (step_no >= 1),
  ADD CONSTRAINT local_request_approval_route_generation_check CHECK (route_generation >= 1),
  ADD CONSTRAINT local_request_approval_authority_type_check
    CHECK (authority_type IN ('legacy', 'fixed', 'manager', 'department_head')),
  ADD CONSTRAINT local_request_approval_resolved_from_length
    CHECK (resolved_from IS NULL OR char_length(resolved_from) <= 200),
  -- 同一の版・経路世代・ステップ番号は1行だけ。既存データに重複があればこの制約で失敗する
  -- (黙って直さない)。
  ADD CONSTRAINT local_request_approval_step_key
    UNIQUE (request_id, organization_id, revision, route_generation, step_no);

-- 既存行のバックフィル。既定値と同じ値だけを入れ、申請の再解決はしない。
UPDATE local_request_approval
   SET step_no = 1,
       route_generation = 1,
       authority_type = 'legacy'
 WHERE step_no IS DISTINCT FROM 1
    OR route_generation IS DISTINCT FROM 1
    OR authority_type IS DISTINCT FROM 'legacy';

-- バックフィルが漏れていないことを確認する(fail closed)。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM local_request_approval
     WHERE step_no <> 1 OR route_generation <> 1 OR authority_type <> 'legacy'
  ) THEN
    RAISE EXCEPTION '0038 backfill incomplete: approval rows are not legacy step 1';
  END IF;
  IF EXISTS (
    SELECT 1 FROM local_request_revision
     WHERE route IS NOT NULL OR route_hash IS NOT NULL OR route_generation <> 1
  ) THEN
    RAISE EXCEPTION '0038 backfill incomplete: existing revisions must keep route NULL';
  END IF;
END $$;

COMMENT ON COLUMN local_request_revision.route IS
  '版に固定した承認経路(ADR-0023 §6)。移行前の版は NULL。';
COMMENT ON COLUMN local_request_revision.route_hash IS
  'route の sha256(canonical)。route と対で保存し、決定・実行前に再計算して照合する。';
COMMENT ON COLUMN local_request_revision.route_generation IS
  '経路世代。再割当で増やす(本WPでは常に1)。';
COMMENT ON COLUMN local_request_approval.step_no IS
  '直列ステップの番号(1始まり)。現在の経路世代の行だけを決定・実行に使う。';
COMMENT ON COLUMN local_request_approval.authority_type IS
  '権限根拠。legacy は移行前の行、fixed は固定承認者。manager/department_head は WP-P4-APR-015 が生成する。';
COMMENT ON COLUMN local_request_approval.decided_by IS
  '決定者。代理導入(WP-P4-APR-017)までは approver_id と同じ。';

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and stop multi-step writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
SET LOCAL row_security = off;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM local_request_revision
     WHERE route IS NOT NULL OR route_hash IS NOT NULL OR route_generation <> 1
  ) OR EXISTS (
    SELECT 1 FROM local_request_approval
     WHERE step_no <> 1
        OR route_generation <> 1
        OR authority_type <> 'legacy'
        OR resolved_from IS NOT NULL
        OR decided_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0038 rollback refused: retain approval route/step data and compatible readers';
  END IF;
END $$;
SET LOCAL row_security = on;

ALTER TABLE local_request_approval
  DROP CONSTRAINT local_request_approval_step_key,
  DROP CONSTRAINT local_request_approval_authority_type_check,
  DROP CONSTRAINT local_request_approval_route_generation_check,
  DROP CONSTRAINT local_request_approval_step_no_check,
  DROP CONSTRAINT local_request_approval_resolved_from_length,
  DROP COLUMN decided_by,
  DROP COLUMN resolved_from,
  DROP COLUMN authority_type,
  DROP COLUMN route_generation,
  DROP COLUMN step_no;

ALTER TABLE local_request_revision
  DROP CONSTRAINT local_request_revision_route_pair,
  DROP CONSTRAINT local_request_revision_route_hash_format,
  DROP CONSTRAINT local_request_revision_route_object,
  DROP CONSTRAINT local_request_revision_route_generation_check,
  DROP COLUMN route_generation,
  DROP COLUMN route_hash,
  DROP COLUMN route;
