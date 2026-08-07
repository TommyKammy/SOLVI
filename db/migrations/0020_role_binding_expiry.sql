-- 役割の期限到来を記録する (FR-IDM-006 / WP-P1-IDM-014)
--
-- FR-IDM-006 の受入基準は「期限到来で**自動失権+監査イベント**」である。
--
-- 自動失権は動いている。`resolveBindings()` が `valid_until` を見ており、
-- 期限を過ぎた束縛は権限として数えられない(検査もある)。
--
-- **監査イベントだけが無かった。** `role.binding.created` /
-- `role.binding.deleted` は監査イベント型として定義されているが、
-- **発行する者がどこにも居ない**(`check_unwired` が報告し続けていた)。
--
-- 実害は静かである。兼務・出向の期限が切れると、ある日その組織が見えなくなる。
-- 本人には理由が分からず、管理者にも「いつ切れたか」を示す記録が無い。
-- 「権限を失った」ことは、**失った瞬間に記録しないと後から作れない。**
--
-- ## 記録済みの印を持つ
--
-- 期限切れは状態であって出来事ではない。`valid_until < now()` は
-- 何度読んでも真であり、そのままでは毎周回で同じ監査を書いてしまう。
-- 記録した印を残し、**1つの期限切れにつき1件だけ**書く。
--
-- ## 越境は読み取りだけ (ADR-0015 / 02.18 §3 / DL-019)
--
-- 候補の一覧を作るには全組織の横断が要るが、1件を記録する操作は
-- その組織の文脈で行う。監査もその組織に残る。
--
-- `app.anchor`(0014)/`app.auth`(0015)/`app.autoclose`(0016)と同じ
-- **登録制の例外**にする。目的ごとに1つのフラグを持ち、
-- 「どの処理がなぜ越境するか」を1対1で辿れるようにする。

-- +migrate up

ALTER TABLE role_binding
  ADD COLUMN expiry_recorded_at timestamptz;

COMMENT ON COLUMN role_binding.expiry_recorded_at IS
  '期限到来を監査へ記録した時刻 (FR-IDM-006)。二重に記録しないための印であり、失権の判定には使わない';

-- 抽出用。**期限があり、まだ記録していないもの**だけを引く。
CREATE INDEX role_binding_pending_expiry_idx
  ON role_binding (valid_until)
  WHERE valid_until IS NOT NULL AND expiry_recorded_at IS NULL;

-- 横断の読み取り例外。**SELECT だけ**である。
-- 記録(監査の挿入と印の更新)は、その組織の文脈で通常の分離規則の下で行う。
CREATE POLICY role_binding_expiry_scan ON role_binding
  FOR SELECT USING (current_setting('app.expiry', true) = 'on');

COMMENT ON POLICY role_binding_expiry_scan ON role_binding IS
  '期限到来の候補抽出専用の読み取り例外 (02.18 §3 / FR-IDM-006)。SET LOCAL app.expiry のトランザクション内に限る';

-- +migrate down

DROP POLICY IF EXISTS role_binding_expiry_scan ON role_binding;
DROP INDEX IF EXISTS role_binding_pending_expiry_idx;
ALTER TABLE role_binding DROP COLUMN IF EXISTS expiry_recorded_at;
