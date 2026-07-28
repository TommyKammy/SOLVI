-- 監査アンカーの越境読み取り例外 (ADR-0009 / WP-P1-AUD-004)
--
-- 日次アンカーは**全Organizationの監査イベントを1本の連鎖ハッシュにまとめる**。
-- 組織ごとに分けると、組織Aの行を丸ごと消してもAのアンカーを作り直せば辻褄が合う。
-- 横断で1本にしておけば、どの1行を触っても翌日以降の照合で必ず露見する。
--
-- ところが `audit_event` の組織RLSは `organization_id = app_current_org()` である。
-- 組織コンテキストを持たないバッチが素直に SELECT すると **0件が返る**。
-- そして 0件の連鎖ハッシュは正しく計算でき、`persistAnchor` は成功する。
--
-- **つまり例外が無いと、アンカーは「空の1日」を毎日記録し続け、
-- ログにもヘルスチェックにも何の異常も現れない。**
-- これは検知の仕組みそのものが黙って無効化されている状態である。
--
-- migration 0010(app.dispatcher)/ 0011(app.auth)/ 0012(app.scanner)と同じ
-- **登録制の例外**にする。専用のフラグを使い、既存のものを流用しない。
-- 流用すると「監査の越境を許した設定」が他のテーブルにも効いてしまう。
--
-- 制限:
--   * `FOR SELECT` のみ。監査イベントは append-only であり、
--     アンカー処理は1行も書き換えない
--   * 対象は `audit_event` の1テーブルのみ
--   * `SET LOCAL` でのみ設定する(トランザクションを越えて残らない)
--
-- この例外を持つのはワーカーのアンカー処理だけである。
-- API経路がこのフラグを立てることは無い。

-- +migrate up

CREATE POLICY audit_event_anchor_lookup ON audit_event
  FOR SELECT USING (current_setting('app.anchor', true) = 'on');

COMMENT ON POLICY audit_event_anchor_lookup ON audit_event IS
  '日次アンカーの読み取り専用例外(02.18 §3 / ADR-0009)。SET LOCAL app.anchor のトランザクション内に限る';

-- ---------------------------------------------------------------------------
-- 例外メッセージが実際のテーブル名を名乗るようにする
--
-- `audit_event_immutable()` は audit_event と audit_anchor の両方から使われるが、
-- 文面は常に「audit_event は append-only です」だった。
-- アンカーの削除を試したとき **触っていないテーブルの名前が返る**。
-- 調査の起点がずれるので、TG_TABLE_NAME を使う。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% は append-only です(% は許可されていません)。訂正は打消しイベントの追加で行ってください。',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- +migrate down

CREATE OR REPLACE FUNCTION audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event は append-only です(% は許可されていません)。訂正は打消しイベントの追加で行ってください。',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

DROP POLICY IF EXISTS audit_event_anchor_lookup ON audit_event;
