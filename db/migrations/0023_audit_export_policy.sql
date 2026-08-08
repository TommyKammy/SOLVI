-- 監査の書き出し (AUD-002 / AUD-003 / WP-P1-AUD-018)
--
-- ADR-0009 で追記専用・ハッシュ連鎖の監査を作り、日次アンカーで固定した。
-- **取り出す手段が無かった。**
--
-- `audit.export.executed` は監査イベント型として定義されていたが、
-- 発行する者が居ない。`check_unwired` が最後まで報告し続けていた1件である。
--
-- **読めない記録は、記録していないことに近い。**
-- 監査人が確かめられなければ、追記専用であることに意味が無い。
--
-- ## なぜ横断の読み取りが要るか
--
-- 連鎖ハッシュは**組織をまたいで1本**である(`computeDailyRoot` は
-- その日の全イベントを event_id 順に連ねる)。
--
-- したがって**組織で絞った書き出しからは日次ルートを再計算できない。**
-- AUD-003 の受入基準「export実行+アンカー再計算の一致」を満たすには、
-- プラットフォーム全体を読む必要がある。
--
-- `app.dispatcher`(0010)/ `app.auth`(0011)/ `app.scanner`(0012)/
-- `app.anchor`(0014)/ `app.autoclose`(0016)/ `app.expiry`(0020)と同じ
-- **登録制の例外**にする。7つ目である。
--
-- ## 誰が使えるか
--
-- このフラグを立てるのは `platform_auditor` の書き出しだけである。
-- 組織の `auditor` には立てない — 自組織の記録しか読めないままにする
-- (AUD-002「auditor/platform_auditor のみ閲覧可」の分離を保つ)。
--
-- **フラグは読み取りだけである。** 監査は誰も書き換えられない
-- (`audit_event_immutable` トリガと、UPDATE/DELETE 権限の不在)。

-- +migrate up

CREATE POLICY audit_event_export_scan ON audit_event
  FOR SELECT USING (current_setting('app.auditexport', true) = 'on');

COMMENT ON POLICY audit_event_export_scan ON audit_event IS
  'プラットフォーム全体の書き出し専用の読み取り例外 (02.18 §3 / AUD-003)。SET LOCAL app.auditexport のトランザクション内に限る';

-- +migrate down

DROP POLICY IF EXISTS audit_event_export_scan ON audit_event;
