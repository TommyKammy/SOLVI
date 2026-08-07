-- 利用者を作れるようにする (WP-P1-IDM-016)
--
-- `app_user` の RLS は `app_user_visible_within_org` だけで、
-- **USING しか持たない。** PostgreSQL では INSERT の可否は WITH CHECK が決めるため、
-- 方針が1つも無い INSERT はすべて拒否される。
--
-- そして仮に USING を INSERT へ適用できたとしても通らない。条件が
-- 「その組織に role_binding を持つこと」であり、**作りたての利用者は
-- まだ束縛を持たない。** 束縛は app_user を参照するので先には作れない。
--
-- ## RLS では守れないことを認める
--
-- `app_user` は組織に属さない(1人が複数組織に所属しうる / 0002 の設計)。
-- 組織の列が無い行に対して、RLS が書き込みを絞る根拠は無い。
--
-- **守れないものを守れるふりをしない。** `session`(0011)と同じ扱いにする。
-- 認可はサービス層(`UserAdminService.createUser` の `requireRole`)が持ち、
-- 誰がどの組織に属するかは `role_binding` の分離規則が守る。
--
-- **行を作っただけでは何も見えない。** 見え方を決めるのは束縛であり、
-- 束縛は組織で分離されている。

-- +migrate up

CREATE POLICY app_user_insert ON app_user
  FOR INSERT WITH CHECK (true);

COMMENT ON POLICY app_user_insert ON app_user IS
  'app_user は組織に属さないため RLS で絞る根拠が無い。認可はサービス層が持つ (WP-P1-IDM-016)';

-- +migrate down

DROP POLICY IF EXISTS app_user_insert ON app_user;
