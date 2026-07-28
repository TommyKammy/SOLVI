-- 認証層が組織名を読めるようにする (WP-P1-IDM-010)
--
-- ログイン画面から**組織IDの手入力を無くす**ために、認証層が
-- 「この人はどの組織に所属しているか」を名前つきで返す必要がある。
--
-- ところが `organization` のRLSは `id = app_current_org()` である。
-- 認証の最中はまだ組織が決まっていない(決めるために引いているのだから、
-- 当然である)。したがって **JOIN が0件になり、所属が無いように見える。**
--
-- この形は既に4回踏んでいる:
--   * Outboxディスパッチャが0件を引いた (migration 0010)
--   * 認証層が app_user を引けなかった (migration 0011)
--   * スキャナが添付を引けなかった (migration 0012)
--   * 監査アンカーが空の1日を記録し続けた (migration 0014)
--
-- 今回は**テストが即座に落ちた**ため、静かに壊れることはなかった。
-- 認証は全経路が通るため、壊れれば必ず表に出る。
--
-- migration 0011 で作った `app.auth` を使う。新しいフラグは作らない。
-- 0011 は既に `app_user` と `role_binding` の2テーブルを同じフラグで
-- 覆っており、**フラグの単位は「テーブル」ではなく「認証層という用途」**である。
-- 組織名の参照はその用途の内側にある。
--
-- 制限:
--   * `FOR SELECT` のみ。認証層は組織を作らない・変えない
--   * `SET LOCAL` でのみ設定する(トランザクションを越えて残らない)
--
-- 読めるのは組織のコードと名前だけである。組織名は請求書にも
-- メールの署名にも出るものであり、機微ではない。
-- それでも書き込みは許さず、トランザクション内に閉じる。

-- +migrate up

CREATE POLICY organization_auth_lookup ON organization
  FOR SELECT USING (current_setting('app.auth', true) = 'on');

COMMENT ON POLICY organization_auth_lookup ON organization IS
  '認証層の読み取り専用例外(02.18 §3 / WP-P1-IDM-010)。所属組織を利用者へ提示するために使う';

-- +migrate down

DROP POLICY IF EXISTS organization_auth_lookup ON organization;
