-- ローカルアカウント認証とセッション基盤 (WP-P1-IDM-009 / ADR-0019)
--
-- 設計上の中心は「セッションは仮ではない」こと。
-- ローカル認証は検証段階限りの差し替え可能な部品だが、セッションの生涯管理は
-- 外部IdP接続後もそのまま使う。したがってここは最終形として作る。
--
-- **認証テーブルは組織スコープを持たない。**
-- セッションを引くのはリクエストの最初であり、その時点ではまだ
-- 「どの組織として操作しているか」が決まっていない。組織を決めるにはセッションが要り、
-- セッションを引くには組織が要る、という循環になる。
-- したがって認証は組織より手前の層に置き、業務データを一切持たせない。
-- (tools/check_rls.mjs の NON_ORG_SCOPED へ理由付きで登録する)

-- +migrate up

-- ---------------------------------------------------------------------------
-- identity に local を許可する
--
-- issuer には予約値 urn:solvi:local を使う。外部IdPの issuer と同じ空間に置くことで、
-- (issuer, subject) の一意制約がローカルと外部の取り違えをそのまま防ぐ。
-- 別テーブルに分けると、同じ人物が二重に存在しうる。
-- ---------------------------------------------------------------------------

ALTER TABLE identity DROP CONSTRAINT identity_idp_type_check;
ALTER TABLE identity ADD CONSTRAINT identity_idp_type_check
  CHECK (idp_type IN ('okta', 'entra', 'local'));

-- ローカルidentityのissuerを予約値に固定する。
-- 任意のissuerを名乗れると、外部IdPのissuerを騙るローカルアカウントを作れてしまう。
ALTER TABLE identity ADD CONSTRAINT identity_local_issuer_check
  CHECK (idp_type <> 'local' OR issuer = 'urn:solvi:local');

COMMENT ON CONSTRAINT identity_local_issuer_check ON identity IS
  'ローカルidentityは urn:solvi:local のみ。外部IdPのissuerを騙れないようにする(ADR-0019)';

-- ---------------------------------------------------------------------------
-- ローカル資格情報
-- ---------------------------------------------------------------------------

CREATE TABLE local_credential (
  id                  uuid PRIMARY KEY,
  -- 1ユーザ1資格情報。複数持てると、どれで入れるのかが曖昧になる。
  user_id             uuid NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE RESTRICT,

  -- scrypt の派生鍵。形式は scrypt$N$r$p$<salt-b64>$<hash-b64>。
  -- パラメータを値に含めるのは、後でコストを上げたときに
  -- 既存の資格情報を読めなくしないため。
  password_hash       text NOT NULL,

  -- 総当たり対策。上限に達したら locked_until まで拒否する。
  failed_attempts     smallint NOT NULL DEFAULT 0,
  locked_until        timestamptz,

  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT local_credential_failed_attempts_range
    CHECK (failed_attempts >= 0 AND failed_attempts <= 1000),

  -- 平文や可逆な形が入らないよう、形式をDBで縛る。
  -- アプリのバグで平文を入れても、ここで落ちる。
  CONSTRAINT local_credential_hash_format
    CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$')
);

CREATE TRIGGER local_credential_updated_at BEFORE UPDATE ON local_credential
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE local_credential IS
  '検証段階限定のローカル資格情報(ADR-0019)。本番構成では認証経路ごと起動を拒否する';
COMMENT ON COLUMN local_credential.password_hash IS
  'scrypt$N$r$p$salt$hash。パラメータを値に含めるのは、コスト変更時に既存を読めなくしないため';

ALTER TABLE local_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_credential FORCE ROW LEVEL SECURITY;

-- 認証は組織より手前の層にある(冒頭の説明)。
-- 代わりに、**アプリロールから SELECT できるのはハッシュ照合に必要な行だけ**という
-- 制限はかけられない(照合はアプリ側で行うため)。
-- そこで守りは「読めても再利用できない」形に置く: 保存するのは派生鍵であり、
-- 元のパスワードではない。
CREATE POLICY local_credential_access ON local_credential USING (true) WITH CHECK (true);

COMMENT ON POLICY local_credential_access ON local_credential IS
  '認証は組織コンテキスト確立前に行うため組織で分離できない。保存値は派生鍵であり再利用できない';

-- ---------------------------------------------------------------------------
-- セッション
--
-- ここは外部IdP接続後もそのまま使う。auth_method で発行元を区別するだけで、
-- 検証・失効・期限の仕組みは共通になる。
-- ---------------------------------------------------------------------------

CREATE TABLE session (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  -- **トークンそのものを保存しない。** DBを読めた者がそのまま成りすませないようにする。
  -- 監査ログやバックアップにトークンが残る事故も防げる。
  token_hash          text NOT NULL,

  -- 発行元。本番の監査に 'local' が現れたら重大インシデント(脅威 T-25)。
  auth_method         text NOT NULL,

  -- 「いま操作している組織」。所有権ではなく選択状態である。
  -- 複数組織に所属する利用者は切り替えられる(切り替えは監査対象)。
  organization_id     uuid REFERENCES organization(id) ON DELETE RESTRICT,

  issued_at           timestamptz NOT NULL DEFAULT now(),

  -- 2種類の期限を持つ。
  --   絶対期限: 使い続けていても必ず切れる。窃取されたセッションの寿命に上限を与える
  --   アイドル期限: 使われなくなったら切れる。放置端末の乗っ取りを防ぐ
  -- 片方だけだと、どちらかの攻撃が通る。
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),

  revoked_at          timestamptz,
  revoked_reason      text,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT session_auth_method_check CHECK (auth_method IN ('local', 'oidc')),

  -- 失効には必ず理由を残す。理由の無い失効は、後から原因を追えない。
  CONSTRAINT session_revoked_requires_reason
    CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL),

  -- アイドル期限が絶対期限を超えても意味が無い(絶対期限が先に効く)
  CONSTRAINT session_idle_within_absolute
    CHECK (idle_expires_at <= absolute_expires_at),

  CONSTRAINT session_absolute_after_issue
    CHECK (absolute_expires_at > issued_at)
);

-- トークンからの引き当て。ここが遅いと全リクエストが遅くなる。
CREATE UNIQUE INDEX session_token_hash_key ON session (token_hash);
-- ユーザ単位の一括失効(無効化・パスワード変更時)
CREATE INDEX session_user_active_idx ON session (user_id) WHERE revoked_at IS NULL;
-- 期限切れセッションの掃除
CREATE INDEX session_absolute_expires_idx ON session (absolute_expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE session IS
  'セッション生涯管理。認証プロバイダに依存しないため、外部IdP接続後もそのまま使う(ADR-0019)';
COMMENT ON COLUMN session.token_hash IS
  'トークンのSHA-256。平文を保存しないため、DB流出だけでは成りすませない';
COMMENT ON COLUMN session.organization_id IS
  '所有権ではなく「いま選択している組織」。切り替えは監査対象';

ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE session FORCE ROW LEVEL SECURITY;

-- セッションを引く時点では組織が未確定のため、組織で分離できない(冒頭の説明)。
-- 守りは「読めても再利用できない」形: 保存しているのはハッシュである。
CREATE POLICY session_access ON session USING (true) WITH CHECK (true);

COMMENT ON POLICY session_access ON session IS
  '認証は組織コンテキスト確立前に行うため組織で分離できない。保存値はハッシュであり再利用できない';

-- ---------------------------------------------------------------------------
-- 権限
--
-- アプリロールに DELETE を与えない。セッションは失効(UPDATE)で無効化し、
-- 行は監査のために残す。消せてしまうと「いつ・なぜ失効したか」を追えない。
-- 期限切れの掃除は所有者権限のバッチで行う。
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON session TO solvi_app;
GRANT SELECT, INSERT, UPDATE ON local_credential TO solvi_app;

-- 監査者は資格情報を読む必要が無い。読めても派生鍵だが、
-- 必要のないものへのアクセスは与えない(最小権限 / NFR-SEC-002)。
GRANT SELECT ON session TO solvi_auditor;

-- ---------------------------------------------------------------------------
-- 認証層の読み取り例外
--
-- ログインは「メールアドレスから利用者を引く」ところから始まるが、
-- `app_user` と `role_binding` は組織スコープのRLS配下にある。
-- 組織を決めるにはセッションが要り、セッションを引くには利用者が要る、という循環になる。
--
-- migration 0010 のディスパッチャ例外と同じ形で、**明示的な登録制の例外**にする。
-- ただし今回はさらに絞る:
--
--   * `FOR SELECT` のみ。認証層は業務データを書き換えられない
--   * 対象は認証に必要な2テーブルのみ
--   * `app.auth` は `SET LOCAL` でのみ設定する。接続に残らない
--
-- 「読めても危険が小さい」ことが根拠ではない。app_user は全組織の利用者一覧であり、
-- 読めること自体に価値がある。したがって**書けないこと**と**トランザクション内に
-- 閉じること**の2点で守る。
-- ---------------------------------------------------------------------------

CREATE POLICY app_user_auth_lookup ON app_user
  FOR SELECT USING (current_setting('app.auth', true) = 'on');

CREATE POLICY role_binding_auth_lookup ON role_binding
  FOR SELECT USING (current_setting('app.auth', true) = 'on');

COMMENT ON POLICY app_user_auth_lookup ON app_user IS
  '認証層の読み取り専用例外(02.18 §3 / WP-P1-IDM-009)。SET LOCAL app.auth のトランザクション内に限る';
COMMENT ON POLICY role_binding_auth_lookup ON role_binding IS
  '同上。役割を毎リクエスト読み直すことで FR-IDM-008 の失効即時性が成立する';

-- +migrate down

DROP POLICY IF EXISTS role_binding_auth_lookup ON role_binding;
DROP POLICY IF EXISTS app_user_auth_lookup ON app_user;

DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS local_credential;

ALTER TABLE identity DROP CONSTRAINT IF EXISTS identity_local_issuer_check;
ALTER TABLE identity DROP CONSTRAINT IF EXISTS identity_idp_type_check;
ALTER TABLE identity ADD CONSTRAINT identity_idp_type_check
  CHECK (idp_type IN ('okta', 'entra'));
