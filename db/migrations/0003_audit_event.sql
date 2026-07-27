-- 監査イベント基盤(append-only)
-- WP-P1-AUD-004 / 設計: docs/planning/02_Architecture/02.17_Audit_Event_Catalog.md
--
-- 方針(ADR-0009):
--  - アプリケーションロールから UPDATE / DELETE / TRUNCATE を **不可能** にする。
--    権限のREVOKEとルールの二重化で、アプリのバグや意図的な操作の両方を止める。
--  - 監査本文にチケット本文・Secret・PII を入れない。参照とハッシュのみ(02.17 §4)。
--  - DB内の全行ハッシュチェーンは採用しない(書込み直列化のコストが見合わない / RA-01)。
--    代わりに日次の外部アンカーで事後改変を検知する。

-- +migrate up

CREATE TABLE audit_event (
  -- uuid v7 相当(アプリが時系列順序を持つIDを採番する)
  event_id             uuid PRIMARY KEY,
  schema_version       smallint NOT NULL DEFAULT 1,
  event_type           text NOT NULL,
  occurred_at          timestamptz NOT NULL DEFAULT now(),

  -- テナント境界。プラットフォーム全体のイベントは 'platform' を示す NULL。
  organization_id      uuid REFERENCES organization(id),

  -- actor: 誰が。退職後も表示できるよう display を非正規化して保持する。
  actor_type           text NOT NULL,
  actor_id             uuid,
  actor_display        text,

  -- subject: 影響を受けた人(いない場合は NULL)
  subject_user_id      uuid,

  -- target: 何に対して
  target_type          text,
  target_id            text,

  action               text NOT NULL,
  outcome              text NOT NULL,

  -- 状態変更の前後。機微属性は登録時に redact 済みであることを前提とする。
  before_state         jsonb,
  after_state          jsonb,

  -- 相関(NFR-OPS-003)
  correlation_id       text,
  request_id           text,
  workflow_run_id      uuid,

  -- 対人アクセスでは必須。SCIM/Executor はクライアント識別子を入れる。
  source_ip            inet,
  user_agent           text,

  -- 認可判定の根拠。denied のときは必須。
  policy_decision      jsonb,

  -- 特権系イベントで必須(WP-P4 以降で使用)
  approval_ref         uuid,
  receipt_ref          uuid,

  CONSTRAINT audit_event_actor_type_check
    CHECK (actor_type IN ('user', 'system', 'scim_client', 'executor', 'ai')),
  CONSTRAINT audit_event_outcome_check
    CHECK (outcome IN ('success', 'denied', 'failure')),
  -- 拒否イベントは理由を残す。「なぜ拒否したか」が分からない監査は説明に使えない。
  CONSTRAINT audit_event_denied_requires_policy
    CHECK (outcome <> 'denied' OR policy_decision IS NOT NULL),
  -- 利用者操作の追跡には相関IDが要る。system/executor の内部処理は省略可。
  CONSTRAINT audit_event_user_action_requires_correlation
    CHECK (actor_type <> 'user' OR correlation_id IS NOT NULL)
);

-- 監査は「いつ・どの組織で何が起きたか」を辿る用途が中心
CREATE INDEX audit_event_occurred_at_idx ON audit_event (occurred_at DESC);
CREATE INDEX audit_event_org_occurred_idx ON audit_event (organization_id, occurred_at DESC);
CREATE INDEX audit_event_correlation_idx ON audit_event (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX audit_event_type_idx ON audit_event (event_type, occurred_at DESC);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_id, occurred_at DESC)
  WHERE actor_id IS NOT NULL;
CREATE INDEX audit_event_target_idx ON audit_event (target_type, target_id)
  WHERE target_id IS NOT NULL;

COMMENT ON TABLE audit_event IS
  'append-only。UPDATE/DELETE はアプリロールから不可(ADR-0009)。訂正は打消しイベントの追加で行う。';
COMMENT ON COLUMN audit_event.before_state IS
  '機微属性は登録前に redact する。チケット本文・Secret・PII を入れない(02.17 §4)。';

-- ---------------------------------------------------------------- append-only の強制

-- 層1: 権限。アプリロールに UPDATE/DELETE を与えない。
GRANT SELECT, INSERT ON audit_event TO solvi_app;
GRANT SELECT, INSERT ON audit_event TO solvi_executor;
GRANT SELECT ON audit_event TO solvi_auditor;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM solvi_app, solvi_executor, solvi_auditor;

-- 層2: ルール。owner 権限で接続された場合や、将来 GRANT が誤って広がった場合にも止める。
-- ルールは行の書き換えを「無視」するのではなく、明示的に例外を投げる。
CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event は append-only です(% は許可されていません)。訂正は打消しイベントの追加で行ってください。',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_immutable();

-- ---------------------------------------------------------------- RLS

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;

-- 自組織のイベントのみ参照可能。platform 全体のイベント(organization_id IS NULL)は
-- 組織コンテキストからは見えない(platform_auditor が専用経路で参照する)。
CREATE POLICY audit_event_isolation ON audit_event
  USING (organization_id = app_current_org());

-- 書き込みは自組織、または platform スコープ(organization_id IS NULL)のみ許す。
-- 他組織のIDを詐称した監査レコードの捏造を防ぐ。
CREATE POLICY audit_event_insert ON audit_event FOR INSERT
  WITH CHECK (organization_id = app_current_org() OR organization_id IS NULL);

-- ---------------------------------------------------------------- 日次アンカー

-- 当日分の連鎖ハッシュのルート値を保持する。実体は外部(S3 Object Lock)へ書き出し、
-- ここには「何を書き出したか」の記録だけを残す。
CREATE TABLE audit_anchor (
  anchor_date     date PRIMARY KEY,
  event_count     bigint NOT NULL,
  first_event_id  uuid,
  last_event_id   uuid,
  root_hash       text NOT NULL,
  algorithm       text NOT NULL DEFAULT 'sha256-chain-v1',
  external_uri    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_anchor_root_hash_format CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_anchor_count_non_negative CHECK (event_count >= 0)
);

COMMENT ON TABLE audit_anchor IS
  '日次の連鎖ハッシュ。DB内の値が改ざんされても、外部保管(S3 Object Lock)との照合で検知できる。';

GRANT SELECT ON audit_anchor TO solvi_app, solvi_auditor;
-- アンカーの作成は Worker(アプリロール)が行う。更新・削除は与えない。
GRANT INSERT ON audit_anchor TO solvi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_anchor FROM solvi_app, solvi_auditor;

CREATE TRIGGER audit_anchor_no_update
  BEFORE UPDATE ON audit_anchor
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
CREATE TRIGGER audit_anchor_no_delete
  BEFORE DELETE ON audit_anchor
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

-- アンカーは組織横断の整合性を担保するものであり、組織ごとに分割しない。
-- 参照は監査者に限定されるため RLS は全許可とし、権限で制御する。
ALTER TABLE audit_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_anchor_readable ON audit_anchor FOR SELECT USING (true);
CREATE POLICY audit_anchor_insertable ON audit_anchor FOR INSERT WITH CHECK (true);

-- +migrate down

DROP TABLE IF EXISTS audit_anchor;
DROP TABLE IF EXISTS audit_event;
DROP FUNCTION IF EXISTS audit_event_immutable();
