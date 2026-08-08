-- 期限切れの予告を1度だけ送るための印 (FR-IDM-006 / WP-P1-IDM-017)
--
-- [[WP-P1-IDM-014]] で期限到来を記録できるようにしたが、
-- **気付けるのは切れたあと**である。画面には出したが、
-- 管理者が `/ops/users` を見に行かなければ分からない。
--
-- 兼務・出向の期限が切れると、ある日その組織が見えなくなる。
-- **切れる前に知らせなければ、延長するかどうかを判断する機会が無い。**
--
-- ## なぜ印が要るか
--
-- 「あと N 日」は期限到来と同じく**状態であって出来事ではない**。
-- 条件は N 日間ずっと真であり、そのままでは毎周回で予告を送ってしまう。
-- 送った印を残し、**1つの期限につき1度だけ**送る。
--
-- 到来の記録(`expiry_recorded_at`)とは別の列にする。
-- 「予告した」と「切れた」は別の出来事であり、
-- **1つの列で2つの事実を表そうとすると、片方が消える。**

-- +migrate up

ALTER TABLE role_binding
  ADD COLUMN expiry_notified_at timestamptz;

COMMENT ON COLUMN role_binding.expiry_notified_at IS
  '期限切れの予告を送った時刻 (FR-IDM-006)。二重に送らないための印であり、失権の判定には使わない';

-- 抽出用。**期限があり、まだ予告していないもの**だけを引く。
CREATE INDEX role_binding_pending_notice_idx
  ON role_binding (valid_until)
  WHERE valid_until IS NOT NULL AND expiry_notified_at IS NULL;

-- +migrate down

DROP INDEX IF EXISTS role_binding_pending_notice_idx;
ALTER TABLE role_binding DROP COLUMN IF EXISTS expiry_notified_at;
