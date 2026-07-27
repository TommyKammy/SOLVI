-- チケットドメイン
-- WP-P2-TKT-001 / 要求: docs/planning/03_Requirements/03.3_Ticket_Requirements.md
--
-- 採番方式の選定(§7 の「同時実行しても重複しない」への対応):
--   案1 max(number)+1        → 同時実行で重複する。採用しない。
--   案2 グローバルsequence     → 種別・年をまたいで連番になり、要求の書式を満たせない。
--   案3 採番カウンタ行 + UPDATE ... RETURNING(採用)
--        (organization_id, kind, year) をキーにした行を UPDATE で加算する。
--        行ロックにより同時実行が直列化され、重複しない。
--        sequence と違いトランザクションのロールバックで番号が戻るため、欠番も出にくい。
--        直列化の範囲が「同一組織・同一種別・同一年」に限られるので競合も局所的。

-- +migrate up

CREATE TABLE ticket_number_counter (
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  kind             text NOT NULL,
  year             smallint NOT NULL,
  last_value       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, kind, year),
  CONSTRAINT ticket_number_counter_kind_check CHECK (kind IN ('incident', 'request')),
  CONSTRAINT ticket_number_counter_value_check CHECK (last_value >= 0)
);

CREATE TABLE ticket (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  number           text NOT NULL,
  kind             text NOT NULL,
  state            text NOT NULL DEFAULT 'new',
  subject          text NOT NULL,
  body             text NOT NULL,

  requester_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  -- 担当の割当は WP-P2-OPS-003 で本格実装する。ここでは列だけ用意する。
  assignee_id      uuid REFERENCES app_user(id) ON DELETE RESTRICT,

  impact           text NOT NULL,
  urgency          text NOT NULL,
  priority         text NOT NULL,

  -- Reopen の期限判定に使う(FR-TKT-012)。resolved へ遷移した時刻。
  resolved_at      timestamptz,
  closed_at        timestamptz,
  -- Merge 先。merged 状態のときのみ設定される(FR-TKT-011、実装は WP-P2-OPS-003)。
  merged_into_id   uuid REFERENCES ticket(id) ON DELETE RESTRICT,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ticket_kind_check CHECK (kind IN ('incident', 'request')),
  CONSTRAINT ticket_state_check CHECK (state IN (
    'new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled', 'merged'
  )),
  CONSTRAINT ticket_impact_check CHECK (impact IN ('low', 'medium', 'high')),
  CONSTRAINT ticket_urgency_check CHECK (urgency IN ('low', 'medium', 'high')),
  CONSTRAINT ticket_priority_check CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT ticket_subject_not_blank CHECK (length(btrim(subject)) > 0),

  -- 状態と時刻の整合。resolved を経ずに resolved_at が入る、といった不整合を防ぐ。
  CONSTRAINT ticket_resolved_at_consistency
    CHECK ((state IN ('resolved', 'closed')) = (resolved_at IS NOT NULL)),
  CONSTRAINT ticket_closed_at_consistency
    CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT ticket_merged_into_consistency
    CHECK ((state = 'merged') = (merged_into_id IS NOT NULL)),
  CONSTRAINT ticket_no_self_merge CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

-- 番号は組織内で一意。組織をまたいだ重複は許す(別会社の REQ-2026-000001 は別物)。
CREATE UNIQUE INDEX ticket_number_key ON ticket (organization_id, number);
CREATE INDEX ticket_org_state_idx ON ticket (organization_id, state, created_at DESC);
CREATE INDEX ticket_requester_idx ON ticket (requester_id, created_at DESC);
CREATE INDEX ticket_assignee_idx ON ticket (assignee_id, created_at DESC)
  WHERE assignee_id IS NOT NULL;

CREATE TRIGGER ticket_updated_at BEFORE UPDATE ON ticket
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN ticket.state IS
  '遷移は packages/shared/src/ticket/state-machine.ts の遷移表に従う。直接UPDATEしない。';
COMMENT ON COLUMN ticket.priority IS
  'impact × urgency から決定論的に導出する(FR-TKT-009)。AIは確定に関与しない。';

-- ---------------------------------------------------------------- RLS

ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_isolation ON ticket
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE ticket_number_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_number_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_number_counter_isolation ON ticket_number_counter
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ---------------------------------------------------------------- 権限

GRANT SELECT, INSERT, UPDATE ON ticket TO solvi_app;
GRANT SELECT, INSERT, UPDATE ON ticket_number_counter TO solvi_app;
GRANT SELECT ON ticket TO solvi_auditor;
-- DELETE は与えない。取消は cancelled 状態で表現する(履歴を残す)。

-- ---------------------------------------------------------------- 採番関数

-- 同一 (org, kind, year) の採番を行ロックで直列化する。
-- 呼び出し側のトランザクション内で実行され、ロールバック時は番号も戻る。
CREATE OR REPLACE FUNCTION next_ticket_number(p_org uuid, p_kind text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_year  smallint := EXTRACT(YEAR FROM now())::smallint;
  v_value integer;
  v_prefix text;
BEGIN
  INSERT INTO ticket_number_counter (organization_id, kind, year, last_value)
       VALUES (p_org, p_kind, v_year, 1)
  ON CONFLICT (organization_id, kind, year)
  DO UPDATE SET last_value = ticket_number_counter.last_value + 1
    RETURNING last_value INTO v_value;

  v_prefix := CASE p_kind WHEN 'incident' THEN 'INC' WHEN 'request' THEN 'REQ' END;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION '未知のチケット種別です: %', p_kind;
  END IF;

  RETURN format('%s-%s-%s', v_prefix, v_year, lpad(v_value::text, 6, '0'));
END
$$;

COMMENT ON FUNCTION next_ticket_number(uuid, text) IS
  '採番カウンタ行のUPDATEで直列化する。同時実行しても重複しない(WP-P2-TKT-001)。';

-- +migrate down

DROP FUNCTION IF EXISTS next_ticket_number(uuid, text);
DROP TABLE IF EXISTS ticket;
DROP TABLE IF EXISTS ticket_number_counter;
