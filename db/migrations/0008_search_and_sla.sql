-- チケット検索とSLA Lite
-- WP-P2-SEARCH-006 / 要求: FR-TKT-006, FR-TKT-008
--
-- 検索: ADR-0011 により PostgreSQL の全文検索で開始する。外部検索クラスタは導入しない。
--       日本語は形態素解析拡張を入れず、pg_trgm による部分一致で始める(WP §6)。
--       精度が不足した時点で ADR-0011 の Follow-up として再評価する。
--
-- SLA:  累積経過時間を列に保持し、状態遷移のたびに加算する(WP §6)。
--       都度計算(遷移履歴の全走査)は一覧表示で重くなるため採らない。

-- +migrate up

-- ---------------------------------------------------------------- SLAポリシー

CREATE TABLE sla_policy (
  id                     uuid PRIMARY KEY,
  organization_id        uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  priority               text NOT NULL,
  -- 初回応答までの目標(分)。暦時間で計算する(営業時間対応は Out of Scope)。
  response_target_minutes  integer NOT NULL,
  -- 解決までの目標(分)
  resolution_target_minutes integer NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sla_policy_priority_check CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT sla_policy_response_positive CHECK (response_target_minutes > 0),
  CONSTRAINT sla_policy_resolution_positive CHECK (resolution_target_minutes > 0),
  -- 解決目標が応答目標より短いのは設定ミス。DBで弾く。
  CONSTRAINT sla_policy_resolution_after_response
    CHECK (resolution_target_minutes >= response_target_minutes)
);

CREATE UNIQUE INDEX sla_policy_org_priority_key ON sla_policy (organization_id, priority);

CREATE TRIGGER sla_policy_updated_at BEFORE UPDATE ON sla_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE sla_policy IS
  '暦時間(24時間)での目標値。営業時間・祝日を考慮した計算は Gate A 後に判断する(WP §5)。';

ALTER TABLE sla_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY sla_policy_isolation ON sla_policy
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT, UPDATE ON sla_policy TO solvi_app;
GRANT SELECT ON sla_policy TO solvi_auditor;

-- ---------------------------------------------------------------- SLA計測列

ALTER TABLE ticket
  -- クロックが動いている状態になった時刻。停止中は NULL。
  ADD COLUMN sla_clock_started_at   timestamptz,
  -- 停止までに積み上がった経過時間(秒)。停止のたびに加算する。
  ADD COLUMN sla_elapsed_seconds    integer NOT NULL DEFAULT 0,
  -- 初回応答(担当者の公開コメント)の時刻。応答SLAの判定に使う。
  ADD COLUMN first_responded_at     timestamptz,
  -- 判定結果。超過しても遷移は止めない(WP §6)。記録するだけ。
  ADD COLUMN response_sla_breached  boolean NOT NULL DEFAULT false,
  ADD COLUMN resolution_sla_breached boolean NOT NULL DEFAULT false;

ALTER TABLE ticket
  ADD CONSTRAINT ticket_sla_elapsed_non_negative CHECK (sla_elapsed_seconds >= 0);

COMMENT ON COLUMN ticket.sla_elapsed_seconds IS
  'クロックが動いていた累積秒数。pending 中は加算されない(FR-TKT-008)。';
COMMENT ON COLUMN ticket.sla_clock_started_at IS
  '現在クロックが動いている場合の開始時刻。停止中は NULL。';

-- SLA超過チケットの抽出(担当者の作業一覧で使う)
CREATE INDEX ticket_sla_breach_idx
  ON ticket (organization_id, created_at DESC)
  WHERE response_sla_breached OR resolution_sla_breached;

-- ---------------------------------------------------------------- 全文検索

-- 検索対象の文字列を1列にまとめる。番号・件名・本文を対象にする。
-- 生成列にすることで、更新漏れによる索引と実体の乖離を防ぐ。
ALTER TABLE ticket
  ADD COLUMN search_text text
  GENERATED ALWAYS AS (number || ' ' || subject || ' ' || body) STORED;

-- pg_trgm による部分一致索引。日本語は語境界が曖昧なため、
-- 形態素解析を入れるまでは trigram の部分一致で扱う(ADR-0011 / WP §6)。
CREATE INDEX ticket_search_trgm_idx ON ticket USING gin (search_text gin_trgm_ops);

COMMENT ON COLUMN ticket.search_text IS
  '検索対象の連結列(生成列)。更新漏れによる索引と実体の乖離を防ぐため GENERATED にする。';

-- ---------------------------------------------------------------- 既定のSLAポリシー

-- 既存組織に既定値を入れる。値は初期案であり、運用実績で見直す。
INSERT INTO sla_policy (id, organization_id, priority, response_target_minutes, resolution_target_minutes)
SELECT gen_random_uuid(), o.id, p.priority, p.response_minutes, p.resolution_minutes
  FROM organization o
 CROSS JOIN (VALUES
    ('critical',  30,   240),   -- 30分 / 4時間
    ('high',     120,  1440),   -- 2時間 / 1日
    ('medium',   480,  4320),   -- 8時間 / 3日
    ('low',     1440, 10080)    -- 1日 / 7日
 ) AS p(priority, response_minutes, resolution_minutes)
ON CONFLICT (organization_id, priority) DO NOTHING;

-- +migrate down

DROP INDEX IF EXISTS ticket_search_trgm_idx;
ALTER TABLE ticket DROP COLUMN IF EXISTS search_text;

DROP INDEX IF EXISTS ticket_sla_breach_idx;
ALTER TABLE ticket
  DROP CONSTRAINT IF EXISTS ticket_sla_elapsed_non_negative,
  DROP COLUMN IF EXISTS resolution_sla_breached,
  DROP COLUMN IF EXISTS response_sla_breached,
  DROP COLUMN IF EXISTS first_responded_at,
  DROP COLUMN IF EXISTS sla_elapsed_seconds,
  DROP COLUMN IF EXISTS sla_clock_started_at;

DROP TABLE IF EXISTS sla_policy;
