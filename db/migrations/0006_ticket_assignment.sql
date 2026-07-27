-- 担当割当と一覧のための索引
-- WP-P2-OPS-003 / 要求: FR-TKT-003, FR-TKT-006, NFR-PERF-001

-- +migrate up

-- 割当履歴。誰がいつ誰へ割り当てたかを追える形で残す(FR-TKT-003)。
-- ticket.assignee_id は現在値、この表は履歴という役割分担(ADR-0013)。
CREATE TABLE ticket_assignment (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  ticket_id        uuid NOT NULL REFERENCES ticket(id) ON DELETE RESTRICT,
  -- NULL は割当解除。誰にも割り当てられていない状態も履歴として残す。
  assignee_id      uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  previous_assignee_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  assigned_by      uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  assigned_at      timestamptz NOT NULL DEFAULT now(),

  -- 同じ相手への再割当は履歴として意味がない。呼び出し側で弾くが、DBでも表明しておく。
  CONSTRAINT ticket_assignment_changes_assignee
    CHECK (assignee_id IS DISTINCT FROM previous_assignee_id)
);

CREATE INDEX ticket_assignment_ticket_idx ON ticket_assignment (ticket_id, assigned_at DESC);
CREATE INDEX ticket_assignment_assignee_idx ON ticket_assignment (assignee_id, assigned_at DESC)
  WHERE assignee_id IS NOT NULL;

COMMENT ON TABLE ticket_assignment IS
  '割当履歴。現在の担当は ticket.assignee_id(ADR-0013 の現在状態+履歴の方針)。';

ALTER TABLE ticket_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_assignment_isolation ON ticket_assignment
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- 履歴は追記のみ。訂正は新しい割当行で表現する。
GRANT SELECT, INSERT ON ticket_assignment TO solvi_app;
GRANT SELECT ON ticket_assignment TO solvi_auditor;

-- ---------------------------------------------------------------- 一覧用の索引
--
-- キーセットページネーションは (created_at DESC, id DESC) を並び順に使う。
-- 認可条件(組織 / 依頼者)を先頭に置いた複合索引を用意し、
-- 「権限で絞ってから並べる」がインデックスだけで完結するようにする。

-- 担当者視点: 組織内の全件を新しい順に
CREATE INDEX ticket_list_org_idx
  ON ticket (organization_id, created_at DESC, id DESC);

-- 依頼者視点: 自分の依頼分を新しい順に
CREATE INDEX ticket_list_requester_idx
  ON ticket (organization_id, requester_id, created_at DESC, id DESC);

-- 担当者の作業一覧
CREATE INDEX ticket_list_assignee_idx
  ON ticket (organization_id, assignee_id, created_at DESC, id DESC)
  WHERE assignee_id IS NOT NULL;

-- 状態での絞り込みは最も頻度が高い
CREATE INDEX ticket_list_state_idx
  ON ticket (organization_id, state, created_at DESC, id DESC);

-- 件名・番号の前方一致検索。全文検索は WP-P2-SEARCH-006 で別途導入する。
CREATE INDEX ticket_subject_trgm_idx ON ticket USING gin (subject gin_trgm_ops);
CREATE INDEX ticket_number_pattern_idx ON ticket (organization_id, number text_pattern_ops);

-- +migrate down

DROP INDEX IF EXISTS ticket_number_pattern_idx;
DROP INDEX IF EXISTS ticket_subject_trgm_idx;
DROP INDEX IF EXISTS ticket_list_state_idx;
DROP INDEX IF EXISTS ticket_list_assignee_idx;
DROP INDEX IF EXISTS ticket_list_requester_idx;
DROP INDEX IF EXISTS ticket_list_org_idx;
DROP TABLE IF EXISTS ticket_assignment;
-- ticket.assignee_id は WP-P2-TKT-001 の資産なので削除しない。値のみ戻す。
UPDATE ticket SET assignee_id = NULL WHERE assignee_id IS NOT NULL;
