-- WP-P4-APR-019 / WP §6.2. 承認の通知の送信の記録(重複防止)と、
-- 定期処理が組織の一覧を読むための登録制の例外(02.18 §3.6)。
--
-- 方針:
--  - 1行が「ある承認ステップについて、ある種類の通知を積んだ」事実を表す。
--    主キー (approval_id, kind) で、定期処理の再実行・同時実行・再起動でも重複しない。
--  - 承認行への複合外部キー(組織を含む)。他組織の承認に通知の記録を作れない
--    (`local_request_approval` には 0027 の UNIQUE(id, organization_id) がある)。
--  - 追記専用。UPDATE / DELETE は共有の拒否関数(0028)で拒否し、
--    アプリケーションロールには SELECT と INSERT だけを与える(0040 と同じ流儀)。
--  - down は行が1件でもあれば拒否する(0038〜0040 と同じ前進修復)。
--
-- ## 組織の一覧の例外 (02.18 §3.6 / DL-063)
--
-- 承認の定期処理は組織を1つずつ処理するが、その一覧は `organization` の
-- 組織RLSでは読めない。読み取りだけを越境させる専用のフラグ
-- `app.approval_sweep` を1つ足す。既存のフラグ(`app.auth` など)は流用しない。
-- 対象は `organization` の1テーブル、操作は `FOR SELECT` だけである。
-- 承認・申請・通知・利用者のテーブルには例外を設けない。
-- フラグを立てたトランザクションで業務テーブルを読み書きしない(§3.6)。
-- +migrate up

CREATE TABLE local_request_approval_notice (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  approval_id uuid NOT NULL,
  -- 通知の種類。依頼・期限前・期限切れ・承認者不在の4つだけを許す。
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT local_request_approval_notice_pkey PRIMARY KEY (approval_id, kind),
  -- 承認行への複合外部キー。他組織の承認を指す記録を作れない。
  CONSTRAINT local_request_approval_notice_approval_fk
    FOREIGN KEY (approval_id, organization_id)
    REFERENCES local_request_approval (id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT local_request_approval_notice_kind_check
    CHECK (kind IN ('requested', 'expiring', 'expired', 'approver_unavailable'))
);
COMMENT ON TABLE local_request_approval_notice IS
  '承認の通知の送信の記録(WP-P4-APR-019 §6.2)。append-only。重複防止の正本。';
COMMENT ON COLUMN local_request_approval_notice.kind IS
  'requested=依頼、expiring=期限前、expired=期限切れ、approver_unavailable=承認者不在。';
COMMENT ON COLUMN local_request_approval_notice.created_at IS
  '記録した時刻。通知の送信時刻ではない(送信は notification / outbox が持つ)。';

CREATE INDEX local_request_approval_notice_org_idx
  ON local_request_approval_notice (organization_id, created_at);

-- 追記専用。共有の拒否関数を使う(0028 で作成済み)。
CREATE TRIGGER local_request_approval_notice_immutable
  BEFORE UPDATE OR DELETE ON local_request_approval_notice
  FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();

-- ---------------------------------------------------------------- RLS / GRANT

ALTER TABLE local_request_approval_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_request_approval_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY local_request_approval_notice_isolation ON local_request_approval_notice
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- UPDATE / DELETE は与えない。記録は積むだけで、消さない・書き換えない。
GRANT SELECT, INSERT ON local_request_approval_notice TO solvi_app;
GRANT SELECT ON local_request_approval_notice TO solvi_auditor;

-- ---------------------------------------------------------------- 組織一覧の例外
--
-- 承認の定期処理が組織を1つずつ処理するための、登録制の読み取り例外
-- (02.18 §3.6 / DL-063)。読み取りだけを越境させ、書き込みは越境させない。
-- 専用のフラグを使い、既存のものを流用しない。
CREATE POLICY organization_approval_sweep_lookup ON organization
  FOR SELECT USING (current_setting('app.approval_sweep', true) = 'on');

COMMENT ON POLICY organization_approval_sweep_lookup ON organization IS
  '承認の定期処理の組織一覧専用の読み取り例外(02.18 §3.6 / WP-P4-APR-019)。SET LOCAL app.approval_sweep のトランザクション内に限る。読むのは organization の id だけ';

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and stop notice writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
SET LOCAL row_security = off;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM local_request_approval_notice) THEN
    RAISE EXCEPTION '0041 rollback refused: retain approval notice records';
  END IF;
END $$;
SET LOCAL row_security = on;

DROP POLICY IF EXISTS organization_approval_sweep_lookup ON organization;
DROP TRIGGER local_request_approval_notice_immutable ON local_request_approval_notice;
DROP TABLE local_request_approval_notice;
