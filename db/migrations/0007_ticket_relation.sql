-- チケットの関連付け(Related / Parent-Child)
-- WP-P2-REL-009 / 要求: FR-TKT-010, FR-TKT-011
--
-- 設計判断は WP §6 を参照。要点:
--   - related は無向。A-B と B-A を同一視して重複登録を防ぐ
--   - parent_of は有向。**1階層のみ**を構造的に強制する
--   - Merge はコメント・添付を移動しない(元チケットの履歴を空洞化させない)

-- +migrate up

CREATE TABLE ticket_relation (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  relation_type     text NOT NULL,
  -- parent_of の場合: source が親、target が子
  source_ticket_id  uuid NOT NULL REFERENCES ticket(id) ON DELETE RESTRICT,
  target_ticket_id  uuid NOT NULL REFERENCES ticket(id) ON DELETE RESTRICT,
  created_by        uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ticket_relation_type_check CHECK (relation_type IN ('related', 'parent_of')),
  CONSTRAINT ticket_relation_no_self CHECK (source_ticket_id <> target_ticket_id)
);

-- related は無向。(A,B) と (B,A) を同じものとして扱うため、
-- 正規化した順序で一意制約を張る。アプリ側の整列に依存しない。
CREATE UNIQUE INDEX ticket_relation_related_key
  ON ticket_relation (
    LEAST(source_ticket_id, target_ticket_id),
    GREATEST(source_ticket_id, target_ticket_id)
  )
  WHERE relation_type = 'related';

-- parent_of は有向。同じ親子の重複を防ぐ。
CREATE UNIQUE INDEX ticket_relation_parent_key
  ON ticket_relation (source_ticket_id, target_ticket_id)
  WHERE relation_type = 'parent_of';

-- **子は親を1つしか持てない。** これにより「複数の親」を構造的に排除する。
CREATE UNIQUE INDEX ticket_relation_single_parent_key
  ON ticket_relation (target_ticket_id)
  WHERE relation_type = 'parent_of';

CREATE INDEX ticket_relation_source_idx ON ticket_relation (source_ticket_id, relation_type);
CREATE INDEX ticket_relation_target_idx ON ticket_relation (target_ticket_id, relation_type);

COMMENT ON TABLE ticket_relation IS
  'related は無向、parent_of は有向で1階層のみ。多階層は 01.5 Non-Goals により対象外。';
COMMENT ON INDEX ticket_relation_single_parent_key IS
  '子は親を1つだけ持つ。多重の親を構造的に排除する。';

-- 1階層の強制のうち「親が子を持てない / 子が親になれない」は
-- 2行にまたがる条件のため単一の制約では表現できない。
-- トリガで判定する。アプリ側でも検証するが、DBを最後の砦として置く。
CREATE OR REPLACE FUNCTION ticket_relation_enforce_single_level() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.relation_type <> 'parent_of' THEN
    RETURN NEW;
  END IF;

  -- 親にしようとしているチケットが、既に誰かの子である
  IF EXISTS (
    SELECT 1 FROM ticket_relation
     WHERE relation_type = 'parent_of' AND target_ticket_id = NEW.source_ticket_id
  ) THEN
    RAISE EXCEPTION
      'このチケットは既に別のチケットの子です。親子関係は1階層までです。'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 子にしようとしているチケットが、既に誰かの親である
  IF EXISTS (
    SELECT 1 FROM ticket_relation
     WHERE relation_type = 'parent_of' AND source_ticket_id = NEW.target_ticket_id
  ) THEN
    RAISE EXCEPTION
      'このチケットは既に子チケットを持っています。親子関係は1階層までです。'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER ticket_relation_single_level
  BEFORE INSERT OR UPDATE ON ticket_relation
  FOR EACH ROW EXECUTE FUNCTION ticket_relation_enforce_single_level();

-- ---------------------------------------------------------------- RLS

ALTER TABLE ticket_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_relation FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_relation_isolation ON ticket_relation
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- 関連付けの解除は行の削除で表現する(状態を持たせるほどの情報量がない)。
-- 解除自体は監査イベントで追跡できる。
GRANT SELECT, INSERT, DELETE ON ticket_relation TO solvi_app;
GRANT SELECT ON ticket_relation TO solvi_auditor;

-- +migrate down

DROP TRIGGER IF EXISTS ticket_relation_single_level ON ticket_relation;
DROP FUNCTION IF EXISTS ticket_relation_enforce_single_level();
DROP TABLE IF EXISTS ticket_relation;

-- merged 状態のチケットは終端のまま cancelled へ倒す。
-- merged_into_id は WP-P2-TKT-001 の資産なので列自体は残す。
UPDATE ticket SET state = 'cancelled', merged_into_id = NULL WHERE state = 'merged';
