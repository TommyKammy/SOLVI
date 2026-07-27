-- Organization / User / Role のコアスキーマと RLS
-- WP-P1-DATA-002 / 設計: docs/planning/02_Architecture/02.18_Organization_Data_Model_and_RLS.md
--
-- 方針:
--  - Organization境界は「アプリ認可(主)」+「RLS(安全網)」の二層(ADR-0015)。
--    RLS を主たる認可の代わりにしない。ただし RLS がなければ実装のバグがそのまま漏えいになる。
--  - 人物の同定は identity(issuer, subject)。メールアドレスは可変であり識別子にしない(FR-IDM-002)。
--  - platform スコープのロールを IdP グループ経由で付与できないことを、
--    トリガではなく **宣言的な制約** で保証する(脅威 T-07)。
--    トリガは無効化できてしまうため、複合外部キー + CHECK で表現する。

-- +migrate up

-- ---------------------------------------------------------------- 共通関数

-- 現在のOrganizationコンテキスト。未設定なら NULL を返し、RLS は 0 行に倒れる(fail closed)。
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_org() IS
  'トランザクションローカルの app.current_org。未設定時は NULL(=RLSで0行)。';

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- Organization

CREATE TABLE organization (
  id             uuid PRIMARY KEY,
  code           text NOT NULL,
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  parent_org_id  uuid REFERENCES organization(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_status_check CHECK (status IN ('active', 'suspended', 'archived')),
  CONSTRAINT organization_code_format CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  CONSTRAINT organization_no_self_parent CHECK (parent_org_id IS NULL OR parent_org_id <> id)
);
CREATE UNIQUE INDEX organization_code_key ON organization (code);
CREATE TRIGGER organization_updated_at BEFORE UPDATE ON organization
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN organization.parent_org_id IS
  '階層は保持するが、初期リリースでは閲覧継承を行わない(完全分離 / リスク受容 RA-03)。';

-- ---------------------------------------------------------------- User / Identity

CREATE TABLE app_user (
  id             uuid PRIMARY KEY,
  primary_email  citext,
  display_name   text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  created_via    text NOT NULL,
  deactivated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_status_check CHECK (status IN ('active', 'deactivated')),
  CONSTRAINT app_user_created_via_check CHECK (created_via IN ('jit', 'scim', 'admin', 'seed')),
  -- 退職者は削除せず deactivated にする(履歴・担当参照を保つ / FR-IDM-007)
  CONSTRAINT app_user_deactivated_consistency
    CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);
CREATE TRIGGER app_user_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN app_user.primary_email IS
  '表示・通知用。**識別子ではない**。人物同定は identity(issuer, subject) で行う(FR-IDM-002)。';

CREATE TABLE identity (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  idp_type          text NOT NULL,
  issuer            text NOT NULL,
  subject           text NOT NULL,
  scim_external_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_idp_type_check CHECK (idp_type IN ('okta', 'entra'))
);
-- 同一人物の同定キー。ここが重複すると別人が同一ユーザに紐づく。
CREATE UNIQUE INDEX identity_issuer_subject_key ON identity (issuer, subject);
-- externalId は IdP 内で一意。重複は 409 で拒否する(FR-IDM-004)。
CREATE UNIQUE INDEX identity_external_id_key ON identity (idp_type, scim_external_id)
  WHERE scim_external_id IS NOT NULL;
CREATE INDEX identity_user_id_idx ON identity (user_id);
CREATE TRIGGER identity_updated_at BEFORE UPDATE ON identity
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- Role / RoleBinding

CREATE TABLE role (
  id     uuid PRIMARY KEY,
  code   text NOT NULL,
  scope  text NOT NULL,
  name   text NOT NULL,
  CONSTRAINT role_scope_check CHECK (scope IN ('platform', 'org')),
  CONSTRAINT role_code_check CHECK (code IN (
    'platform_admin', 'platform_auditor',
    'org_admin', 'agent', 'approver', 'auditor', 'requester'
  ))
);
CREATE UNIQUE INDEX role_code_key ON role (code);
-- 複合外部キーの参照先。scope をロール行と切り離せなくするために必要。
ALTER TABLE role ADD CONSTRAINT role_id_scope_key UNIQUE (id, scope);

INSERT INTO role (id, code, scope, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'platform_admin',   'platform', 'プラットフォーム管理者'),
  ('00000000-0000-4000-8000-000000000002', 'platform_auditor', 'platform', 'プラットフォーム監査者'),
  ('00000000-0000-4000-8000-000000000003', 'org_admin',        'org',      '組織管理者'),
  ('00000000-0000-4000-8000-000000000004', 'agent',            'org',      'IT担当'),
  ('00000000-0000-4000-8000-000000000005', 'approver',         'org',      '承認者'),
  ('00000000-0000-4000-8000-000000000006', 'auditor',          'org',      '監査者'),
  ('00000000-0000-4000-8000-000000000007', 'requester',        'org',      '一般利用者');

CREATE TABLE role_binding (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  role_id          uuid NOT NULL,
  role_scope       text NOT NULL,
  organization_id  uuid REFERENCES organization(id) ON DELETE RESTRICT,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_until      timestamptz,
  source           text NOT NULL,
  source_group_ref text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- role_scope をロール定義から独立に書き換えられないようにする
  CONSTRAINT role_binding_role_fk FOREIGN KEY (role_id, role_scope)
    REFERENCES role (id, scope) ON UPDATE CASCADE,

  -- platform ロールは Organization に属さない。org ロールは必ず属する。
  CONSTRAINT role_binding_scope_org_consistency CHECK (
    (role_scope = 'platform' AND organization_id IS NULL) OR
    (role_scope = 'org'      AND organization_id IS NOT NULL)
  ),

  CONSTRAINT role_binding_source_check CHECK (source IN ('idp_group', 'manual', 'seed')),

  -- platform ロールを IdP グループ同期で付与させない(脅威 T-07)。
  -- 手動付与 + 二重承認のみを経路とする(02.18 §2)。
  CONSTRAINT role_binding_platform_manual_only CHECK (
    role_scope <> 'platform' OR source <> 'idp_group'
  ),

  CONSTRAINT role_binding_validity_range CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX role_binding_user_idx ON role_binding (user_id);
CREATE INDEX role_binding_org_idx ON role_binding (organization_id);
-- 同一 user × role × org の重複付与を防ぐ(期限切れの再付与は別行として許す)
CREATE UNIQUE INDEX role_binding_active_key
  ON role_binding (user_id, role_id, COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE valid_until IS NULL;
CREATE TRIGGER role_binding_updated_at BEFORE UPDATE ON role_binding
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE role_binding IS
  '兼務・出向は複数行(期限付き)で表現する(FR-IDM-006)。';

-- ---------------------------------------------------------------- IdP グループ → ロール

CREATE TABLE idp_group_mapping (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  idp_type           text NOT NULL,
  group_external_id  text NOT NULL,
  role_id            uuid NOT NULL,
  role_scope         text NOT NULL,
  status             text NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT idp_group_mapping_role_fk FOREIGN KEY (role_id, role_scope)
    REFERENCES role (id, scope) ON UPDATE CASCADE,

  -- **platform スコープのロールをマッピング登録できない**(脅威 T-07)。
  -- IdP 側のグループを改ざんされてもプラットフォーム権限へ到達できないようにする。
  CONSTRAINT idp_group_mapping_org_scope_only CHECK (role_scope = 'org'),

  CONSTRAINT idp_group_mapping_idp_type_check CHECK (idp_type IN ('okta', 'entra')),
  CONSTRAINT idp_group_mapping_status_check CHECK (status IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX idp_group_mapping_key
  ON idp_group_mapping (organization_id, idp_type, group_external_id, role_id);
CREATE TRIGGER idp_group_mapping_updated_at BEFORE UPDATE ON idp_group_mapping
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- RLS

-- Organization: 自分のコンテキストの組織だけが見える
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON organization
  USING (id = app_current_org());

-- role_binding / idp_group_mapping: organization_id による分離
ALTER TABLE role_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY role_binding_isolation ON role_binding
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE idp_group_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE idp_group_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY idp_group_mapping_isolation ON idp_group_mapping
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- app_user / identity は Organization に属さない(1人が複数組織に所属しうる)。
-- 「所属を持つ組織のコンテキストからのみ見える」という条件で分離する。
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
CREATE POLICY app_user_visible_within_org ON app_user
  USING (
    EXISTS (
      SELECT 1 FROM role_binding rb
      WHERE rb.user_id = app_user.id
        AND rb.organization_id = app_current_org()
    )
  );

ALTER TABLE identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_visible_within_org ON identity
  USING (
    EXISTS (
      SELECT 1 FROM role_binding rb
      WHERE rb.user_id = identity.user_id
        AND rb.organization_id = app_current_org()
    )
  );

-- role は参照データ。組織に依存しないため全員が読める。
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
CREATE POLICY role_readable ON role FOR SELECT USING (true);

-- ---------------------------------------------------------------- 権限付与

-- アプリロールには必要な操作だけを与える。
-- role は参照のみ(アプリからロール定義を書き換えさせない)。
GRANT SELECT, INSERT, UPDATE ON organization, app_user, identity, role_binding, idp_group_mapping TO solvi_app;
GRANT SELECT ON role TO solvi_app;
-- DELETE は与えない。無効化は status 列で表現する(履歴保持 / FR-IDM-007)。

-- Executor は Identity を書き換えない。実行対象の解決に必要な参照のみ。
GRANT SELECT ON organization, app_user, identity, role_binding TO solvi_executor;

GRANT SELECT ON organization, app_user, identity, role_binding, idp_group_mapping, role TO solvi_auditor;

-- +migrate down

-- app_user / identity のポリシーは role_binding を参照している。
-- ポリシーを先に落とさないと role_binding を DROP できない。
DROP POLICY IF EXISTS app_user_visible_within_org ON app_user;
DROP POLICY IF EXISTS identity_visible_within_org ON identity;

DROP TABLE IF EXISTS idp_group_mapping;
DROP TABLE IF EXISTS role_binding;
DROP TABLE IF EXISTS identity;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS role;
DROP TABLE IF EXISTS organization;
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_current_org();
