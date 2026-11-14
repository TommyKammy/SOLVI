-- WP-P4-APR-018 / ADR-0024 §1〜§3. Approval route generations (append-only).
--
-- 方針:
--  - 再割当後の経路は、版(`local_request_revision`)を書き換えず、追記専用の
--    別テーブルへ世代として保存する。版の route / route_hash / route_generation は
--    世代1の記録として残し、アプリケーションロールに UPDATE を与えない。
--  - 1行が「ある申請の版の、1つの経路世代」を表す。`route` は全段を持ち、
--    `from_step_no` より前の段は直前の世代と同じでなければならない(APIで検証する)。
--  - 組織境界は複合外部キー(他組織の版を参照できない)と RLS(第二層)で守る。
--  - UPDATE / DELETE は共有の拒否関数 `reject_asset_history_change()`(0028)で拒否し、
--    アプリケーションロールには SELECT と INSERT だけを与える。
--  - down は行が1件でもあれば拒否する(0037〜0039 と同じ前進修復)。
-- +migrate up

CREATE TABLE local_request_route_generation (
  request_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  -- 世代1は版の列が持つ。この表は再割当の世代(2以上)だけを持つ。
  route_generation integer NOT NULL,
  -- 再解決した最初の段。1〜3(最大段数は WP-P4-APR-015 §6.1)。
  from_step_no integer NOT NULL,
  -- 全段の経路。要素の形は API の共有スキーマで検証する。
  route jsonb NOT NULL,
  route_hash text NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT local_request_route_generation_pkey
    PRIMARY KEY (request_id, organization_id, revision, route_generation),
  -- 版への複合外部キー。他組織の申請・版に世代を作れない。
  CONSTRAINT local_request_route_generation_revision_fk
    FOREIGN KEY (request_id, organization_id, revision)
    REFERENCES local_request_revision (request_id, organization_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT local_request_route_generation_generation_check CHECK (route_generation >= 2),
  CONSTRAINT local_request_route_generation_from_step_check CHECK (from_step_no BETWEEN 1 AND 3),
  CONSTRAINT local_request_route_generation_route_object CHECK (jsonb_typeof(route) = 'object'),
  CONSTRAINT local_request_route_generation_route_steps CHECK (
    jsonb_typeof(route -> 'steps') = 'array'
    AND jsonb_array_length(route -> 'steps') BETWEEN 1 AND 3
  ),
  CONSTRAINT local_request_route_generation_route_hash_format
    CHECK (route_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_request_route_generation_reason_length
    CHECK (char_length(reason) BETWEEN 1 AND 2000)
);
CREATE INDEX local_request_route_generation_revision_idx
  ON local_request_route_generation (organization_id, request_id, revision);
COMMENT ON TABLE local_request_route_generation IS
  '再割当で増えた承認経路の世代(ADR-0024 §1)。append-only。版は書き換えない。';
COMMENT ON COLUMN local_request_route_generation.route_generation IS
  '経路世代。版の列は世代1を表し、この表は2以上だけを持つ。';
COMMENT ON COLUMN local_request_route_generation.from_step_no IS
  '再解決した最初の段。この段より前は直前の世代と同一でなければならない。';
COMMENT ON COLUMN local_request_route_generation.reason IS
  '再割当の理由(必須・2000文字以内)。APIの入力値をそのまま保存する。';

-- 追記専用。共有の拒否関数を使う(0028 で作成済み)。
CREATE TRIGGER local_request_route_generation_immutable
  BEFORE UPDATE OR DELETE ON local_request_route_generation
  FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();

-- ---------------------------------------------------------------- RLS / GRANT

ALTER TABLE local_request_route_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_request_route_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY local_request_route_generation_isolation ON local_request_route_generation
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- DELETE / UPDATE は与えない。再割当は INSERT だけである。
GRANT SELECT, INSERT ON local_request_route_generation TO solvi_app;
GRANT SELECT ON local_request_route_generation TO solvi_auditor;

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and stop reassignment writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
SET LOCAL row_security = off;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM local_request_route_generation) THEN
    RAISE EXCEPTION '0040 rollback refused: retain approval route generations and compatible readers';
  END IF;
END $$;
SET LOCAL row_security = on;

DROP TRIGGER local_request_route_generation_immutable ON local_request_route_generation;
DROP TABLE local_request_route_generation;
