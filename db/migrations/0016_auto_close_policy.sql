-- 自動クローズの候補抽出 (FR-TKT-012 / WP-P2-CLOSE-014)
--
-- 要求(03.3 状態機械)は「Closed(Resolved後14日で自動)」であり、
-- 状態機械にも `resolved → closed (auto_close)` の規則がある。
-- ところが**それを実行する者が居なかった。** 解決済みチケットは
-- 永久に resolved のまま残り、ITSMとして完了しない。
--
-- 定期処理は全Organizationを横断して候補を探す。実行時点で組織コンテキストを
-- 持たないため、`ticket` の組織RLSでは1件も引けない。
--
-- migration 0010(app.dispatcher)/ 0011・0015(app.auth)/ 0012(app.scanner)/
-- 0014(app.anchor)と同じ**登録制の例外**にする。専用のフラグを使い、
-- 既存のものを流用しない。
--
-- 制限:
--   * `FOR SELECT` のみ。**状態の書き換えは対象組織のコンテキストで行う**
--   * 対象は `ticket` の1テーブルのみ
--   * `SET LOCAL` でのみ設定する
--
-- 読み取りを越境させ、書き込みは越境させない。この分け方が要点である。
-- 候補の一覧を作るには横断が要るが、1件を閉じる操作は必ず
-- その組織の中で行われ、監査もその組織のスコープに残る。
--
-- 抽出した候補は実行時にもう一度状態機械へ問う。抽出から実行までに
-- 人が Reopen していることがあり、**抽出時点の判断を信じない。**

-- +migrate up

CREATE POLICY ticket_autoclose_lookup ON ticket
  FOR SELECT USING (current_setting('app.autoclose', true) = 'on');

COMMENT ON POLICY ticket_autoclose_lookup ON ticket IS
  '自動クローズの候補抽出専用の読み取り例外(02.18 §3 / FR-TKT-012)。SET LOCAL app.autoclose のトランザクション内に限る';

-- 候補の抽出を軽くする。解決済みで、まだ閉じていないものだけを見る。
-- 全件走査になると、チケットが増えたときに定期処理が重くなる。
CREATE INDEX ticket_resolved_pending_close_idx ON ticket (resolved_at)
  WHERE state = 'resolved';

-- +migrate down

DROP INDEX IF EXISTS ticket_resolved_pending_close_idx;
DROP POLICY IF EXISTS ticket_autoclose_lookup ON ticket;
