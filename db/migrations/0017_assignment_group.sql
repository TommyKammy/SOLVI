-- 担当グループ (FR-TKT-003 / WP-P2-GRP-015)
--
-- 要求は「担当 Group / User を設定」だが、実装は個人割当だけだった。
--
-- **これはITSMの基本動作の欠落である。** 問い合わせはまず担当グループの
-- キューに入り、そこから個人が引き受ける。個人指名しかできないと、
-- 「誰に振ればいいか分かる人」が全件を捌くことになり、その人が
-- ボトルネックになる。休んだ日に問い合わせが止まる。
--
-- ---------------------------------------------------------------------------
-- グループと状態の関係
--
-- **グループ割当は状態を動かさない。** 状態機械には手を入れない。
--
-- グループに入っただけのチケットを `assigned` にすると、
-- 「担当者が決まった」ことになってしまう。実際には誰も見ていない。
-- SLAの応答時間は人が応答するまでの時間であり、キューに入った時刻ではない。
--
-- グループは**経路**であって**進行状態**ではない。別の軸として持つ。
-- ---------------------------------------------------------------------------

-- +migrate up

CREATE TABLE assignment_group (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,

  -- 画面や会話で指し示すための短い識別子。組織内で一意。
  -- UUIDを人に読ませないための値である(WP-P1-IDM-010 / WP-P2-RELUI-012 と同じ理由)。
  code            text NOT NULL,
  name            text NOT NULL,
  description     text,

  -- **消さずに閉じる。** グループを削除すると、過去のチケットが
  -- 「どこへ振られたか」を失う。運用から外すのは無効化で行う。
  active          boolean NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assignment_group_code_format
    CHECK (code ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  CONSTRAINT assignment_group_name_length
    CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX assignment_group_code_key
  ON assignment_group (organization_id, code);
CREATE INDEX assignment_group_active_idx
  ON assignment_group (organization_id, name) WHERE active;

COMMENT ON TABLE assignment_group IS
  '担当グループ(キュー)。FR-TKT-003。経路であって進行状態ではない';
COMMENT ON COLUMN assignment_group.active IS
  '運用から外すのは無効化で行う。削除すると過去のチケットが振り先を失う';

CREATE TRIGGER assignment_group_updated_at
  BEFORE UPDATE ON assignment_group
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- メンバー
--
-- 「自分のグループのキュー」を引くために要る。これが無いと担当者は
-- 全グループのキューを目で選り分けることになり、キューの意味が無くなる。
-- ---------------------------------------------------------------------------

CREATE TABLE assignment_group_member (
  group_id        uuid NOT NULL REFERENCES assignment_group(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  -- RLSのために持つ。group_id から辿れるが、ポリシーで結合すると
  -- 全ての参照にJOINが要る。**分離は結合なしで判定できる形にする。**
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,

  added_at        timestamptz NOT NULL DEFAULT now(),
  added_by        uuid REFERENCES app_user(id) ON DELETE SET NULL,

  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX assignment_group_member_user_idx
  ON assignment_group_member (user_id, organization_id);

COMMENT ON TABLE assignment_group_member IS
  'グループの所属。「自分のグループのキュー」を引くために使う';

-- ---------------------------------------------------------------------------
-- チケットの振り先
-- ---------------------------------------------------------------------------

ALTER TABLE ticket
  ADD COLUMN assignee_group_id uuid REFERENCES assignment_group(id) ON DELETE RESTRICT;

COMMENT ON COLUMN ticket.assignee_group_id IS
  '担当グループ(キュー)。個人の担当(assignee_id)とは別の軸。両方が入りうる';

-- キューの一覧を引く索引。未着手のものを先に見るため、状態も入れる。
CREATE INDEX ticket_group_queue_idx
  ON ticket (organization_id, assignee_group_id, state)
  WHERE assignee_group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 履歴
--
-- 個人の割当履歴(`ticket_assignment`)と同じ理由で残す。
-- 「なぜこのグループに来たのか」を後から辿れないと、
-- 振り間違いの原因が分からない。
-- ---------------------------------------------------------------------------

ALTER TABLE ticket_assignment
  ADD COLUMN group_id          uuid REFERENCES assignment_group(id) ON DELETE RESTRICT,
  ADD COLUMN previous_group_id uuid REFERENCES assignment_group(id) ON DELETE RESTRICT;

COMMENT ON COLUMN ticket_assignment.group_id IS
  'グループ割当の履歴。個人の割当と同じ表に残す(1つのチケットの振られ方を1か所で辿る)';

-- 履歴の制約を「担当が変わる」から「**どちらかが変わる**」へ広げる。
--
-- 0006 の制約は `assignee_id IS DISTINCT FROM previous_assignee_id` だった。
-- グループだけを変える履歴は個人の担当が変わらないため、この制約に触れる。
-- 意図は「何も変わらない行を残さない」ことであり、担当者に限る理由は無い。
ALTER TABLE ticket_assignment DROP CONSTRAINT ticket_assignment_changes_assignee;
ALTER TABLE ticket_assignment ADD CONSTRAINT ticket_assignment_changes_something
  CHECK (
    assignee_id IS DISTINCT FROM previous_assignee_id
    OR group_id IS DISTINCT FROM previous_group_id
  );

-- ---------------------------------------------------------------------------
-- RLS
--
-- 越境の例外は作らない。グループは業務データであり、
-- 定期処理が横断して読む必要は無い。
-- ---------------------------------------------------------------------------

ALTER TABLE assignment_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_group FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_group_isolation ON assignment_group
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE assignment_group_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_group_member FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_group_member_isolation ON assignment_group_member
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

GRANT SELECT, INSERT, UPDATE ON assignment_group TO solvi_app;
GRANT SELECT ON assignment_group TO solvi_auditor;
-- DELETE を与えない。運用から外すのは `active = false` で行う。
REVOKE DELETE ON assignment_group FROM solvi_app;

GRANT SELECT, INSERT, DELETE ON assignment_group_member TO solvi_app;
GRANT SELECT ON assignment_group_member TO solvi_auditor;

-- +migrate down

DROP INDEX IF EXISTS ticket_group_queue_idx;

ALTER TABLE ticket_assignment DROP CONSTRAINT IF EXISTS ticket_assignment_changes_something;
ALTER TABLE ticket_assignment
  DROP COLUMN IF EXISTS previous_group_id,
  DROP COLUMN IF EXISTS group_id;
ALTER TABLE ticket_assignment ADD CONSTRAINT ticket_assignment_changes_assignee
  CHECK (assignee_id IS DISTINCT FROM previous_assignee_id);
ALTER TABLE ticket DROP COLUMN IF EXISTS assignee_group_id;
DROP TABLE IF EXISTS assignment_group_member;
DROP TABLE IF EXISTS assignment_group;
