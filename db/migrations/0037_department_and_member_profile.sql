-- WP-P4-IDM-012 / ADR-0023 §3・§12 / 02.18 §2.1. Department, org member profile, department head.
--
-- 方針:
--  - 上長・部署長は承認権限の根拠になる(脅威 T-26)。他組織の参照・循環・同一部署の重複を、
--    アプリではなく **DBの制約とトリガ** で拒否する。
--  - 組織境界は複合外部キー(他組織の参照を拒否)と RLS(第二層)で守る。第一層のAPI認可は WP-P4-IDM-013。
--  - app_user は変更しない(1人が複数組織に所属しうる)。部署・上長は (organization_id, user_id) のプロフィールに置く。
--  - 循環検査は組織単位の advisory lock を取ってから祖先をたどる。ロックなしでは、
--    2つのトランザクションが逆向きの関係を同時に作ったときに双方が通り、循環が残る。
--  - 上記のロックは READ COMMITTED でしか成立しない(ロック取得後のSQL文が先行トランザクションの
--    コミットを見ることに依存する。REPEATABLE READ 以上では取得後も古いスナップショットのままで、
--    循環が通る)。ロックを取る箇所は、分離レベルが read committed でなければ例外にする(fail closed)。
--  - 無効(active=false)な部署は、新たに主部署・部署長・親に指定できない。無効化の参照確認を
--    無効化後の追加で迂回させないため。同時の「無効化」と「参照追加」は、部署行の FOR SHARE /
--    FOR NO KEY UPDATE(親は advisory lock)で直列化し、両方が通ることはない。
--  - 文字列は長さをCHECKで制限する(部署コード1〜64、部署名1〜200、役職・勤務地200以下、社員番号64以下)。
--  - トリガ関数は SECURITY INVOKER(既定)のまま。RLS は呼び出し元(アプリロール)に適用され、
--    同一組織の行だけがたどれる。複合外部キーが組織をまたぐ参照を作らせない。
-- +migrate up

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- 部署

CREATE TABLE department (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 code text NOT NULL,
 name text NOT NULL,
 parent_id uuid,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT department_org_code_key UNIQUE (organization_id, code),
 -- 複合外部キーの参照先。部署の組織を、参照する側の組織と切り離せなくする。
 CONSTRAINT department_id_org_key UNIQUE (id, organization_id),
 CONSTRAINT department_parent_fk FOREIGN KEY (parent_id, organization_id)
  REFERENCES department (id, organization_id),
 CONSTRAINT department_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
 CONSTRAINT department_code_length CHECK (char_length(code) BETWEEN 1 AND 64),
 CONSTRAINT department_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);
CREATE INDEX department_parent_idx ON department (organization_id, parent_id);
COMMENT ON TABLE department IS
 '部署。削除しない(active=false で無効化)。循環と深さ(10)はトリガで拒否する。';

-- ---------------------------------------------------------------- 組織プロフィール

CREATE TABLE org_member_profile (
 organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
 primary_department_id uuid,
 manager_user_id uuid,
 job_title text,
 location text,
 employee_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, user_id),
 CONSTRAINT org_member_profile_department_fk FOREIGN KEY (primary_department_id, organization_id)
  REFERENCES department (id, organization_id),
 CONSTRAINT org_member_profile_manager_fk FOREIGN KEY (organization_id, manager_user_id)
  REFERENCES org_member_profile (organization_id, user_id),
 CONSTRAINT org_member_profile_no_self_manager CHECK (manager_user_id IS NULL OR manager_user_id <> user_id),
 CONSTRAINT org_member_profile_job_title_length CHECK (job_title IS NULL OR char_length(job_title) <= 200),
 CONSTRAINT org_member_profile_location_length CHECK (location IS NULL OR char_length(location) <= 200),
 CONSTRAINT org_member_profile_employee_id_length CHECK (employee_id IS NULL OR char_length(employee_id) <= 64)
);
CREATE INDEX org_member_profile_department_idx ON org_member_profile (organization_id, primary_department_id);
CREATE INDEX org_member_profile_manager_idx ON org_member_profile (organization_id, manager_user_id);
COMMENT ON TABLE org_member_profile IS
 '組織ごとの主部署・上長・役職。行の存在は所属の証明にならない(有効な所属は role_binding で判定する / ADR-0023 §1)。';

-- ---------------------------------------------------------------- 部署長

CREATE TABLE department_head (
 id uuid PRIMARY KEY,
 department_id uuid NOT NULL,
 organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL,
 valid_from timestamptz NOT NULL,
 valid_until timestamptz,
 created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT department_head_department_fk FOREIGN KEY (department_id, organization_id)
  REFERENCES department (id, organization_id),
 CONSTRAINT department_head_member_fk FOREIGN KEY (organization_id, user_id)
  REFERENCES org_member_profile (organization_id, user_id),
 CONSTRAINT department_head_validity_range CHECK (valid_until IS NULL OR valid_until > valid_from),
 -- 同一部署・同一時刻に部署長は1名。範囲は [valid_from, valid_until)(終了=開始は重ならない)。
 CONSTRAINT department_head_no_overlap EXCLUDE USING gist (
  department_id WITH =, tstzrange(valid_from, valid_until) WITH &&
 )
);
CREATE INDEX department_head_member_idx ON department_head (organization_id, user_id);

-- ---------------------------------------------------------------- トリガ関数

-- advisory lock による循環検査は READ COMMITTED を前提とする。それ以外なら拒否する。
-- (read uncommitted は PostgreSQL では read committed と同じ動作だが、前提の確認は厳格に「read committed」のみ許す。)
CREATE FUNCTION department_require_read_committed() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'isolation_level: this change requires READ COMMITTED (current: %)',
   current_setting('transaction_isolation')
   USING ERRCODE = 'invalid_transaction_state';
 END IF;
END
$fn$;

-- 部署の親の循環・深さ(上限10)。祖先をたどる前に組織単位のロックを取る。
-- 取得後の各SQL文は新しいスナップショットで走るため、先行トランザクションのコミットが見える。
CREATE FUNCTION department_check_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
 ancestors integer;
 below integer;
 cyclic boolean;
 parent_active boolean;
BEGIN
 IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN RETURN NEW; END IF;

 PERFORM department_require_read_committed();
 PERFORM pg_advisory_xact_lock(hashtextextended('department:' || NEW.organization_id::text, 0));

 -- 無効な部署の下へは付けられない。無効化(同じロックを取る)と直列化されているので、取得後に確認する。
 SELECT d.active INTO parent_active FROM department d
  WHERE d.id = NEW.parent_id AND d.organization_id = NEW.organization_id
  FOR SHARE;
 IF FOUND AND NOT parent_active THEN
  RAISE EXCEPTION 'department_inactive: cannot attach under an inactive department'
   USING ERRCODE = 'check_violation';
 END IF;

 -- 新しい親から根までの祖先(自分を含まない)。自分に到達すれば循環。
 WITH RECURSIVE up(id, parent_id, depth) AS (
  SELECT d.id, d.parent_id, 1 FROM department d
   WHERE d.id = NEW.parent_id AND d.organization_id = NEW.organization_id
  UNION ALL
  SELECT p.id, p.parent_id, up.depth + 1 FROM department p
   JOIN up ON p.id = up.parent_id AND p.organization_id = NEW.organization_id
   WHERE up.depth < 12
 )
 SELECT max(depth), coalesce(bool_or(id = NEW.id), false) INTO ancestors, cyclic FROM up;
 IF cyclic THEN
  RAISE EXCEPTION 'department_cycle: department % would become its own ancestor', NEW.id
   USING ERRCODE = 'check_violation';
 END IF;

 -- 配下の最大の深さ(自分を含まない)。移動で子孫が上限を超えないようにする。
 WITH RECURSIVE down(id, depth) AS (
  SELECT c.id, 1 FROM department c
   WHERE c.parent_id = NEW.id AND c.organization_id = NEW.organization_id
  UNION ALL
  SELECT c.id, down.depth + 1 FROM department c
   JOIN down ON c.parent_id = down.id AND c.organization_id = NEW.organization_id
   WHERE down.depth < 12
 )
 SELECT coalesce(max(depth), 0) INTO below FROM down;

 -- 根の深さを1とする。自分の深さ = 祖先数 + 1。
 IF coalesce(ancestors, 0) + 1 + below > 10 THEN
  RAISE EXCEPTION 'department_depth: hierarchy deeper than 10 levels'
   USING ERRCODE = 'check_violation';
 END IF;
 RETURN NEW;
END
$fn$;

-- 識別列の不変と、無効化(active=false)の参照確認。
-- 承認ルール・進行中申請による参照の確認は、そのテーブルを作る WP-P4-APR-014 / WP-P4-APR-015 が
-- この関数へ追加する。
CREATE FUNCTION department_guard_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id THEN
  RAISE EXCEPTION 'department_immutable: id and organization_id cannot change'
   USING ERRCODE = 'check_violation';
 END IF;

 IF OLD.active AND NOT NEW.active THEN
  PERFORM department_require_read_committed();
  -- 子部署の追加・付け替え(同じロック)と直列化する。
  PERFORM pg_advisory_xact_lock(hashtextextended('department:' || OLD.organization_id::text, 0));
  -- 同時に所属・部署長を追加するトランザクション(部署行に FOR SHARE を取る)が
  -- コミットするまで待ち、以降の検査でそのコミットを見る。
  PERFORM 1 FROM department WHERE id = OLD.id AND organization_id = OLD.organization_id
   FOR NO KEY UPDATE;

  IF EXISTS (
   SELECT 1 FROM department c
    WHERE c.parent_id = OLD.id AND c.organization_id = OLD.organization_id
  ) THEN
   RAISE EXCEPTION 'department_in_use: child departments remain' USING ERRCODE = 'restrict_violation';
  END IF;

  -- 有効な所属(ADR-0023 §1): 利用者が active で、組織に有効期間内の role_binding がある。
  IF EXISTS (
   SELECT 1 FROM org_member_profile p
    JOIN app_user u ON u.id = p.user_id
    WHERE p.organization_id = OLD.organization_id
      AND p.primary_department_id = OLD.id
      AND u.status = 'active'
      AND EXISTS (
       SELECT 1 FROM role_binding rb
        WHERE rb.user_id = p.user_id AND rb.organization_id = p.organization_id
          AND rb.valid_from <= clock_timestamp()
          AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
      )
  ) THEN
   RAISE EXCEPTION 'department_in_use: active members remain' USING ERRCODE = 'restrict_violation';
  END IF;

  -- 現在有効、または将来開始の部署長。
  IF EXISTS (
   SELECT 1 FROM department_head h
    WHERE h.department_id = OLD.id AND h.organization_id = OLD.organization_id
      AND (h.valid_until IS NULL OR h.valid_until > clock_timestamp())
  ) THEN
   RAISE EXCEPTION 'department_in_use: active department head remains' USING ERRCODE = 'restrict_violation';
  END IF;
 END IF;
 RETURN NEW;
END
$fn$;

-- 上長の連鎖の循環。部署と同じく、ロックを取ってから連鎖をたどる。
CREATE FUNCTION org_member_profile_check_manager() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 IF NEW.manager_user_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND NEW.manager_user_id IS NOT DISTINCT FROM OLD.manager_user_id THEN RETURN NEW; END IF;

 PERFORM department_require_read_committed();
 PERFORM pg_advisory_xact_lock(hashtextextended('manager:' || NEW.organization_id::text, 0));

 -- 新しい上長から上へ。自分に到達すれば循環。UNION で重複を除き、必ず終了する。
 IF EXISTS (
  WITH RECURSIVE chain(user_id) AS (
   SELECT NEW.manager_user_id
   UNION
   SELECT p.manager_user_id FROM org_member_profile p
    JOIN chain ON p.user_id = chain.user_id AND p.organization_id = NEW.organization_id
    WHERE p.manager_user_id IS NOT NULL
  )
  SELECT 1 FROM chain WHERE user_id = NEW.user_id
 ) THEN
  RAISE EXCEPTION 'manager_cycle: user % would become their own manager in the chain', NEW.user_id
   USING ERRCODE = 'check_violation';
 END IF;
 RETURN NEW;
END
$fn$;

-- 識別列の不変。主部署の設定時は部署行に FOR SHARE を取り、同時の無効化と直列化したうえで、無効な部署を拒否する。
CREATE FUNCTION org_member_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
 dept_active boolean;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id) THEN
  RAISE EXCEPTION 'org_member_profile_immutable: organization_id and user_id cannot change'
   USING ERRCODE = 'check_violation';
 END IF;
 IF NEW.primary_department_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.primary_department_id IS DISTINCT FROM OLD.primary_department_id) THEN
  SELECT d.active INTO dept_active FROM department d
   WHERE d.id = NEW.primary_department_id AND d.organization_id = NEW.organization_id
   FOR SHARE;
  -- 行が無ければ複合外部キーが拒否する。無効な部署は主部署にできない。
  IF FOUND AND NOT dept_active THEN
   RAISE EXCEPTION 'department_inactive: cannot set an inactive department as primary department'
    USING ERRCODE = 'check_violation';
  END IF;
 END IF;
 RETURN NEW;
END
$fn$;

-- 部署長: INSERT は部署行に FOR SHARE(同時の無効化と直列化)を取り、無効な部署を拒否する。
-- UPDATE は valid_until の短縮(終了日付け)だけを許す。
CREATE FUNCTION department_head_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
 dept_active boolean;
BEGIN
 IF TG_OP = 'INSERT' THEN
  SELECT d.active INTO dept_active FROM department d
   WHERE d.id = NEW.department_id AND d.organization_id = NEW.organization_id
   FOR SHARE;
  IF FOUND AND NOT dept_active THEN
   RAISE EXCEPTION 'department_inactive: cannot register a head for an inactive department'
    USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
 END IF;

 IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'department_head_immutable: only valid_until may be shortened'
   USING ERRCODE = 'check_violation';
 END IF;
 IF NEW.valid_until IS NULL OR (OLD.valid_until IS NOT NULL AND NEW.valid_until > OLD.valid_until) THEN
  RAISE EXCEPTION 'department_head_immutable: valid_until can only be shortened'
   USING ERRCODE = 'check_violation';
 END IF;
 RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------- トリガ

CREATE TRIGGER department_updated_at BEFORE UPDATE ON department
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER department_check_hierarchy BEFORE INSERT OR UPDATE OF parent_id ON department
 FOR EACH ROW EXECUTE FUNCTION department_check_hierarchy();
CREATE TRIGGER department_guard_update BEFORE UPDATE ON department
 FOR EACH ROW EXECUTE FUNCTION department_guard_update();

CREATE TRIGGER org_member_profile_updated_at BEFORE UPDATE ON org_member_profile
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_member_profile_check_manager BEFORE INSERT OR UPDATE OF manager_user_id ON org_member_profile
 FOR EACH ROW EXECUTE FUNCTION org_member_profile_check_manager();
CREATE TRIGGER org_member_profile_guard BEFORE INSERT OR UPDATE ON org_member_profile
 FOR EACH ROW EXECUTE FUNCTION org_member_profile_guard();

CREATE TRIGGER department_head_guard BEFORE INSERT OR UPDATE ON department_head
 FOR EACH ROW EXECUTE FUNCTION department_head_guard();

-- ---------------------------------------------------------------- RLS / GRANT

ALTER TABLE department ENABLE ROW LEVEL SECURITY;
ALTER TABLE department FORCE ROW LEVEL SECURITY;
CREATE POLICY department_isolation ON department
 USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE org_member_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_member_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY org_member_profile_isolation ON org_member_profile
 USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

ALTER TABLE department_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_head FORCE ROW LEVEL SECURITY;
CREATE POLICY department_head_isolation ON department_head
 USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());

-- DELETE は与えない。部署は active=false、部署長は valid_until の短縮で終える。
GRANT SELECT, INSERT, UPDATE ON department, org_member_profile, department_head TO solvi_app;
GRANT SELECT ON department, org_member_profile, department_head TO solvi_auditor;

-- ---------------------------------------------------------------- バックフィル
-- 有効期間内の org スコープ role_binding を持つ (組織, 利用者) ごとに空のプロフィールを1行作る。
-- 全組織を読むため row_security を明示的に切る。切れないロール(BYPASSRLS を持たない)では
-- エラーになり、黙って0件になることはない。
-- BACKFILL-BEGIN
SET LOCAL row_security = off;
INSERT INTO org_member_profile (organization_id, user_id)
SELECT DISTINCT rb.organization_id, rb.user_id
  FROM role_binding rb
 WHERE rb.role_scope = 'org'
   AND rb.organization_id IS NOT NULL
   AND rb.valid_from <= clock_timestamp()
   AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM role_binding rb
   WHERE rb.role_scope = 'org' AND rb.organization_id IS NOT NULL
     AND rb.valid_from <= clock_timestamp()
     AND (rb.valid_until IS NULL OR rb.valid_until > clock_timestamp())
     AND NOT EXISTS (
      SELECT 1 FROM org_member_profile p
       WHERE p.organization_id = rb.organization_id AND p.user_id = rb.user_id
     )
 ) THEN
  RAISE EXCEPTION '0037 backfill incomplete: a member with a valid org binding has no profile';
 END IF;
END $$;
SET LOCAL row_security = on;
-- BACKFILL-END

-- +migrate down
-- Refuse a lossy rollback. Keep compatible readers and stop writes instead.
-- A migrator without BYPASSRLS must fail instead of seeing a silently filtered zero count.
-- btree_gist is not dropped (other objects may use it).
SET LOCAL row_security = off;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM department)
 OR EXISTS (SELECT 1 FROM org_member_profile)
 OR EXISTS (SELECT 1 FROM department_head)
 THEN RAISE EXCEPTION '0037 rollback refused: retain department / profile / head data and compatible readers'; END IF;
END $$;
SET LOCAL row_security = on;
DROP TABLE department_head;
DROP TABLE org_member_profile;
DROP TABLE department;
DROP FUNCTION department_head_guard();
DROP FUNCTION org_member_profile_guard();
DROP FUNCTION org_member_profile_check_manager();
DROP FUNCTION department_guard_update();
DROP FUNCTION department_check_hierarchy();
DROP FUNCTION department_require_read_committed();
