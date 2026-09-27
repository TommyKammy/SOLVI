-- アクセスレビュー (NFR-SEC-002 / WP-P1-SEC-024)
--
-- 誰が何を持っているかは見えていた。配ることも取り消すことも動いていた。
-- **見直す手続きが無かった。**
--
-- 権限は増える方向にしか動かない。異動で足され、兼務で足され、
-- 「念のため」で足される。減るのは、減らす日を決めたときだけである。
--
-- ---------------------------------------------------------------------------
-- なぜ項目を「固定」するのか
--
-- レビューの対象を毎回「いま有効な役割」で引き直すと、
-- **レビュー中に対象が動く。** 決めた項目が消え、決めていない項目が現れる。
-- 何を見たのかが後から言えないものは、記録として使えない。
--
-- 開いた時点の姿を項目として書き出し、そこに決定を書く。
-- 開いた後に付与された役割は、次の期で見る。
-- ---------------------------------------------------------------------------

-- +migrate up

CREATE TABLE access_review (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,

  -- 人が期を呼ぶための名前(「2026-Q3」など)。組織内で一意。
  -- UUIDを人に読ませないための値である(WP-P1-IDM-010 と同じ理由)。
  period_label    text NOT NULL,

  opened_at       timestamptz NOT NULL DEFAULT now(),
  opened_by       uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  -- **どこから始まったか。** 人が開いたのか、定期処理が開いたのか。
  -- 「四半期ごとに実施している」と言うためには、後者が要る(後続WP)。
  source          text NOT NULL DEFAULT 'manual',

  completed_at    timestamptz,
  completed_by    uuid REFERENCES app_user(id) ON DELETE RESTRICT,

  -- **platform スコープの件数は持たない。**
  --
  -- 最初は WP-P1-IDM-014 に倣って「対象外にした件数」を残す設計にした。
  -- 実際に測ると、`role_binding_isolation` は organization_id が NULL の行
  -- (= platform 束縛)を app ロールに見せない。所有者から 3 件見える状態で、
  -- アプリからは 0 件だった。
  --
  -- **列を置けば、常に 0 が入る。** 0 は「無い」に見えるが、実際は
  -- 「見えない」である。数えられないものを数えたふりをしない(DL-062)。
  -- 表示のためだけに越境読み取りの例外を増やすこともしない。

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT access_review_source CHECK (source IN ('manual', 'scheduled')),
  CONSTRAINT access_review_period_format
    CHECK (period_label ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$'),

  -- 完了は「時刻と人」が揃って初めて成立する。片方だけの完了を作らない。
  CONSTRAINT access_review_completion_pair CHECK (
    (completed_at IS NULL AND completed_by IS NULL) OR
    (completed_at IS NOT NULL AND completed_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX access_review_period_key
  ON access_review (organization_id, period_label);

-- **開いているレビューは組織に1つ。**
--
-- 2つ開くと、同じ役割が2つの期に現れ、片方で残し片方で取り消せる。
-- どちらが結論なのかを決める規則が要る — 規則を作るより、1つに絞る。
CREATE UNIQUE INDEX access_review_single_open
  ON access_review (organization_id) WHERE completed_at IS NULL;

COMMENT ON TABLE access_review IS
  'アクセスレビューの期。NFR-SEC-002 の四半期レビュー。実施した記録そのもの';

CREATE TRIGGER access_review_updated_at
  BEFORE UPDATE ON access_review
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 項目
--
-- 開いた時点の「誰が・どの役割を・いつまで」を写し取る。
--
-- `role_binding_id` は参照だが、**判定の材料は写した値のほうである。**
-- 束縛が後から失効しても、レビュー時点で何を見たかは変わらない。
-- ---------------------------------------------------------------------------

CREATE TABLE access_review_item (
  id              uuid PRIMARY KEY,
  review_id       uuid NOT NULL REFERENCES access_review(id) ON DELETE CASCADE,

  -- RLSのために持つ。review_id から辿れるが、ポリシーで結合すると
  -- 全ての参照にJOINが要る(0017 と同じ判断)。
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,

  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  role_binding_id uuid NOT NULL REFERENCES role_binding(id) ON DELETE RESTRICT,

  -- 開いた時点の写し。後から役割の定義が変わっても、見たものは変わらない。
  role_code       text NOT NULL,
  valid_until_at_open timestamptz,

  decision        text NOT NULL DEFAULT 'pending',
  decided_at      timestamptz,
  decided_by      uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  reason          text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT access_review_item_decision
    CHECK (decision IN ('pending', 'keep', 'revoke')),

  -- **決定には理由が要る。** 「残す」も判断であり、判断には理由がある。
  -- 決まっていないものに決定者や理由が入っていることも許さない。
  CONSTRAINT access_review_item_decision_shape CHECK (
    (decision = 'pending'
      AND decided_at IS NULL AND decided_by IS NULL AND reason IS NULL)
    OR
    (decision <> 'pending'
      AND decided_at IS NOT NULL AND decided_by IS NOT NULL
      AND reason IS NOT NULL AND char_length(btrim(reason)) > 0)
  )
);

-- 同じ束縛を1つの期に二重に載せない。
CREATE UNIQUE INDEX access_review_item_binding_key
  ON access_review_item (review_id, role_binding_id);

CREATE INDEX access_review_item_pending_idx
  ON access_review_item (review_id, decision);

COMMENT ON TABLE access_review_item IS
  'レビュー対象1件。開いた時点の姿を写し取る。束縛が後で失効しても記録は変わらない。'
  'org スコープのみ — platform 束縛は RLS により見えず、件数も出せない (DL-062)';
COMMENT ON COLUMN access_review_item.role_code IS
  '開いた時点の写し。role の定義が変わっても、見たものは変わらない';

CREATE TRIGGER access_review_item_updated_at
  BEFORE UPDATE ON access_review_item
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
--
-- 越境の例外は作らない。レビューは組織の中の手続きである。
-- ---------------------------------------------------------------------------

ALTER TABLE access_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_review FORCE ROW LEVEL SECURITY;
CREATE POLICY access_review_isolation ON access_review
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

ALTER TABLE access_review_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_review_item FORCE ROW LEVEL SECURITY;
CREATE POLICY access_review_item_isolation ON access_review_item
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- DELETE を与えない。**実施した記録を消せる経路を作らない。**
-- 誤って開いた期は、完了させて残す(「実施した」ことは事実である)。
GRANT SELECT, INSERT, UPDATE ON access_review TO solvi_app;
GRANT SELECT, INSERT, UPDATE ON access_review_item TO solvi_app;
GRANT SELECT ON access_review TO solvi_auditor;
GRANT SELECT ON access_review_item TO solvi_auditor;

-- +migrate down

DROP TABLE IF EXISTS access_review_item;
DROP TABLE IF EXISTS access_review;
