-- WP-P4-APR-015 (段階A) / ADR-0023 §6・§9・§10・§13. Approval rules and organization routing setting.
--
-- 方針:
--  - 承認ルールは組織スコープ。カタログ定義の版属性 `approval.ruleId` で項目に結び付ける。
--  - ルールの版は append-only。UPDATE/DELETE はトリガで拒否し、アプリロールへ DELETE を与えない。
--    「編集」は新しい版の追加だけである。
--  - ルールの使用は組織単位の設定(DB)で有効化する。環境変数・フラグにしない。
--    行が無ければ無効(fail closed)。
--  - organization_id を持つ3テーブルすべてに RLS(ENABLE/FORCE)と組織分離ポリシーを設ける。
--  - 複合外部キーで他組織のルール改版を作れないようにする(RLS は第二層)。
--  - `steps` は jsonb 配列で1〜3要素。要素の形は共有 Zod スキーマとAPIで検証する
--    (最大段数3は DB と API の両方で検証する / WP §6.1)。
--  - down はデータがあれば拒否する(0036 / 0037 / 0038 と同じ前進修復)。
--  - 部署の無効化トリガへの追加は行わない(§6.1 で取り下げ。ルールは部署を参照しない)。
-- +migrate up

-- ---------------------------------------------------------------- 承認ルール

CREATE TABLE approval_rule (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 code text NOT NULL,
 name text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 current_revision integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT approval_rule_org_code_key UNIQUE (organization_id, code),
 -- 複合外部キーの参照先。改版の組織を、ルールの組織と切り離せなくする。
 CONSTRAINT approval_rule_id_org_key UNIQUE (id, organization_id),
 CONSTRAINT approval_rule_code_length CHECK (char_length(code) BETWEEN 1 AND 64),
 CONSTRAINT approval_rule_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
 CONSTRAINT approval_rule_current_revision_check CHECK (current_revision >= 1)
);
CREATE INDEX approval_rule_org_active_idx ON approval_rule (organization_id, active, code);
COMMENT ON TABLE approval_rule IS
 '組織ごとの承認ルール。版は approval_rule_revision に append-only で積む。';
COMMENT ON COLUMN approval_rule.current_revision IS
 '申請・変更の経路解決に使う版。改版は新しい版の追加で行い、既存版を書き換えない。';

CREATE TABLE approval_rule_revision (
 rule_id uuid NOT NULL,
 organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK (revision > 0),
 steps jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (rule_id, organization_id, revision),
 CONSTRAINT approval_rule_revision_rule_fk FOREIGN KEY (rule_id, organization_id)
  REFERENCES approval_rule (id, organization_id) ON DELETE RESTRICT,
 -- 1〜3段(最大段数は WP §6.1 で確定)。要素の形は共有 Zod スキーマで検証する。
 CONSTRAINT approval_rule_revision_steps_array CHECK (
  jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 3
 )
);
COMMENT ON TABLE approval_rule_revision IS
 '承認ルールの版。append-only(UPDATE/DELETE はトリガで拒否)。';
COMMENT ON COLUMN approval_rule_revision.steps IS
 '直列ステップの配列(1〜3要素)。fixed / manager / department_head を共有スキーマで検証する。';

-- current_revision が実在する版を指すことを、コミット時に検証する。
-- ルール行の作成と最初の版の作成は同一トランザクションで行う。
ALTER TABLE approval_rule
 ADD CONSTRAINT approval_rule_current_revision_fk
 FOREIGN KEY (id, organization_id, current_revision)
 REFERENCES approval_rule_revision (rule_id, organization_id, revision)
 DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------- 組織単位の有効化設定

CREATE TABLE org_approval_setting (
 organization_id uuid PRIMARY KEY REFERENCES organization(id) ON DELETE RESTRICT,
 rule_routing_enabled boolean NOT NULL DEFAULT false,
 updated_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE org_approval_setting IS
 '組織単位の承認ルール有効化設定。行が無ければ無効。切替は org_admin のみで監査する。';

-- ---------------------------------------------------------------- トリガ

CREATE TRIGGER approval_rule_updated_at BEFORE UPDATE ON approval_rule
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ルール行の識別列の不変と、current_revision の後退禁止。
-- 版の追加は current_revision を増やすだけで、既存版の中身は変えない。
CREATE FUNCTION approval_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 IF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.code <> OLD.code
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION 'approval_rule_immutable: identity columns cannot change'
   USING ERRCODE = 'check_violation';
 END IF;
 IF NEW.current_revision < OLD.current_revision THEN
  RAISE EXCEPTION 'approval_rule_revision_regression: current_revision cannot decrease'
   USING ERRCODE = 'check_violation';
 END IF;
 -- 無効化は一方向。再有効化の経路は設けない(必要になったら監査付きの新しい経路として追加する)。
 IF NOT OLD.active AND NEW.active THEN
  RAISE EXCEPTION 'approval_rule_reactivation: inactive rules cannot be reactivated'
   USING ERRCODE = 'check_violation';
 END IF;
 RETURN NEW;
END
$fn$;

CREATE TRIGGER approval_rule_guard_update BEFORE UPDATE ON approval_rule
 FOR EACH ROW EXECUTE FUNCTION approval_rule_guard();

-- ルールの版は append-only。共有の拒否関数を使う(0028 で作成済み)。
CREATE TRIGGER approval_rule_revision_immutable BEFORE UPDATE OR DELETE ON approval_rule_revision
 FOR EACH ROW EXECUTE FUNCTION reject_asset_history_change();

-- ---------------------------------------------------------------- RLS / GRANT

ALTER TABLE approval_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_rule_isolation ON approval_rule
 USING (organization_id = app_current_org())
 WITH CHECK (organization_id = app_current_org());

ALTER TABLE approval_rule_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rule_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_rule_revision_isolation ON approval_rule_revision
 USING (organization_id = app_current_org())
 WITH CHECK (organization_id = app_current_org());

ALTER TABLE org_approval_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_approval_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY org_approval_setting_isolation ON org_approval_setting
 USING (organization_id = app_current_org())
 WITH CHECK (organization_id = app_current_org());

-- DELETE は与えない。ルールは active=false、版は追加のみ、設定は行を消さず false にする。
GRANT SELECT, INSERT, UPDATE ON approval_rule TO solvi_app;
GRANT SELECT, INSERT ON approval_rule_revision TO solvi_app;
GRANT SELECT, INSERT, UPDATE ON org_approval_setting TO solvi_app;
GRANT SELECT ON approval_rule, approval_rule_revision, org_approval_setting TO solvi_auditor;

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and stop writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
SET LOCAL row_security = off;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM approval_rule)
 OR EXISTS (SELECT 1 FROM approval_rule_revision)
 OR EXISTS (SELECT 1 FROM org_approval_setting)
 THEN RAISE EXCEPTION '0039 rollback refused: retain approval rule and routing setting data and compatible readers'; END IF;
END $$;
SET LOCAL row_security = on;

ALTER TABLE approval_rule DROP CONSTRAINT approval_rule_current_revision_fk;
DROP TABLE org_approval_setting;
DROP TRIGGER approval_rule_guard_update ON approval_rule;
DROP TABLE approval_rule_revision;
DROP TABLE approval_rule;
DROP FUNCTION approval_rule_guard();
