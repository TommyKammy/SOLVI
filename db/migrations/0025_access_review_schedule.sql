-- 四半期アクセスレビューの自動起票と期日 (NFR-SEC-002 / WP-P1-SEC-025)
--
-- WP-P1-SEC-024 でレビューを開き・判断し・閉じることはできるようになった。
-- **開くのは人だけだった。** 誰も開かなければ、何も起きない。
--
-- 手続きは、始める日と終わる日が決まっていなければ手続きにならない。
-- ここでは「終わる日」(期日)を持たせ、定期処理が「始める」ための形を作る。

-- +migrate up

-- ---------------------------------------------------------------------------
-- 期日
--
-- **30日は仮値である。** 要求文書に数字が無い(DL-035 と同じ扱い)。
-- 値はアプリケーションが `ACCESS_REVIEW_DUE_DAYS` から決めて書き込む。
-- ここでは既存の行を埋めるためにだけ 30日を使う。
-- ---------------------------------------------------------------------------

ALTER TABLE access_review ADD COLUMN due_at timestamptz;
UPDATE access_review SET due_at = opened_at + interval '30 days' WHERE due_at IS NULL;
ALTER TABLE access_review ALTER COLUMN due_at SET NOT NULL;

ALTER TABLE access_review ADD CONSTRAINT access_review_due_after_open
  CHECK (due_at > opened_at);

COMMENT ON COLUMN access_review.due_at IS
  '完了期日。既定は開始から30日(仮値、ACCESS_REVIEW_DUE_DAYS)。過ぎても自動で閉じない';

-- 遅れを数える索引。未完了のものだけを見る。
CREATE INDEX access_review_overdue_idx
  ON access_review (due_at) WHERE completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 定期処理が開いた期
--
-- **人ではないものを人として記録しない。**
-- 定期処理が開いた期は `opened_by` を持たない。人が開いた期は必ず持つ。
-- どちらかを曖昧にすると、「誰が始めたか」を後から言えなくなる。
-- ---------------------------------------------------------------------------

ALTER TABLE access_review ALTER COLUMN opened_by DROP NOT NULL;
ALTER TABLE access_review ADD CONSTRAINT access_review_opener_matches_source CHECK (
  (source = 'manual'    AND opened_by IS NOT NULL) OR
  (source = 'scheduled' AND opened_by IS NULL)
);

-- ---------------------------------------------------------------------------
-- 候補抽出専用の読み取り例外
--
-- 「どの組織がこの四半期にまだ開いていないか」を知るには、全組織を横断する。
-- **読み取りは越境させ、書き込みは越境させない**(0016 と同じ形)。
-- 開く操作は、必ずその組織の文脈(app.current_org)で行う。
-- ---------------------------------------------------------------------------

CREATE POLICY organization_access_review_schedule ON organization
  FOR SELECT USING (current_setting('app.access_review_schedule', true) = 'on');
COMMENT ON POLICY organization_access_review_schedule ON organization IS
  'アクセスレビュー定期起票の候補抽出専用の読み取り例外(02.18 §3 / NFR-SEC-002)。SET LOCAL app.access_review_schedule のトランザクション内に限る';

CREATE POLICY access_review_schedule_scan ON access_review
  FOR SELECT USING (current_setting('app.access_review_schedule', true) = 'on');
COMMENT ON POLICY access_review_schedule_scan ON access_review IS
  '同上。期の有無と遅れの件数を数えるためだけに使う';

-- +migrate down

DROP POLICY IF EXISTS access_review_schedule_scan ON access_review;
DROP POLICY IF EXISTS organization_access_review_schedule ON organization;
ALTER TABLE access_review DROP CONSTRAINT IF EXISTS access_review_opener_matches_source;
-- 定期処理が開いた行は opened_by を持たないため、NOT NULL へ戻す前に消えない形で止める。
-- **戻せない場合は失敗させる** — 誰が開いたか分からない行を、黙って人の行にしない。
ALTER TABLE access_review ALTER COLUMN opened_by SET NOT NULL;
DROP INDEX IF EXISTS access_review_overdue_idx;
ALTER TABLE access_review DROP CONSTRAINT IF EXISTS access_review_due_after_open;
ALTER TABLE access_review DROP COLUMN IF EXISTS due_at;
