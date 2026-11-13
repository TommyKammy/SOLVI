# Evidence: WP-P4-APR-014(承認の経路・ステップ、状態機械、監査イベント移行)

- Timestamp: 2026-11-13 09:46 JST
- Branch: `wp/WP-P4-APR-014`(変更は作業ツリー。コミットなし)
- Environment: macOS、Node.js `v26.13.0`、ローカル PostgreSQL。
- 検証は**使い捨てDB `solvi_wp014_test`**(Migration 0038 適用済み。seed 済み)のみ。
  Migration 互換テストは自分で `solvi_wp014_test_compat_<乱数>` を作成し、終了時に削除する。
- 開発用DB `solvi` は `SELECT count(*)` のみ。件数は作業前後で不変、`schema_migration` は37件のまま。
- 接続文字列・パスワードは記録していない。`.local/credentials.txt` と `.local/investigations/` は開いていない。
- 生ログ: `raw/`(gitignore 対象)。

| ファイル | 内容 | 結果 |
|---|---|---|
| raw/00_environment.txt | 環境・branch・base HEAD | - |
| raw/01_dev_db_before.json | 開発用DBの作業前件数(SELECTのみ) | 11テーブル+`schema_migration=37` |
| raw/19_dev_db_after.json | 開発用DBの作業後件数(SELECTのみ) | 作業前と完全一致。`schema_max_version=0037` |
| raw/02_unit_before.log / 03_*_failures.txt | `npm run test:unit` 変更前 | 34 failed / 4329 passed(4363) |
| raw/04_unit_after.log / 05_*_failures.txt | 変更後 | 34 failed / 4359 passed(4393)。**新規失敗0** |
| raw/06_unit_failure_diff.txt | 失敗テスト名の差分 | 空 |
| raw/07_targeted_tests.log | 状態機械・assertion・catalog-*・新規security | 7ファイル 196 passed |
| raw/08_security_full.log | `vitest run tests/security` | 683 passed / 1 failed / 10 skipped。失敗は `department-profile.test.ts` の「0037が最後のMigration」前提(下記)。既知の読み込み不能6ファイルは別途 |
| raw/09_security_excluding_known.log | 上記1件と読み込み不能6ファイルを除く security 全体 | 31ファイル 657 passed / 0 failed |
| raw/10_typecheck.log / 11_lint.log | `npm run typecheck` / `npm run lint` | 成功 |
| raw/12_check_all.log | `npm run check:all` | `check:traceability` のみ失敗(03.18のStatus 3行。指示により未変更) |
| raw/14_check_rls.log | `node tools/check_rls.mjs`(使い捨てDB) | 問題0件 |
| raw/15_migrate_status.txt | 使い捨てDBのMigration | 38件適用済み(0038まで) |
| raw/16_disposable_db_state.json | 検査用に残したDBの状態 | `solvi_wp014_test` / 0038適用済み |
| raw/17_disposable_db_names.json | 名前が `wp014` のDB | `solvi_wp014_test` のみ(compat DBはテストが削除) |
| raw/18_prettier.txt | 変更ファイルの整形確認 | 成功 |
| raw/20_git_status.txt | `git status --short` | Allowed Paths内のみ |

## 受入基準(§7)の充足

1. 03.5の全遷移: `services/api/src/modules/catalog/approval-state.ts` の `APPROVAL_TRANSITIONS` と `tests/unit/approval-state.test.ts`(表と1:1)。未定義遷移は `tests/security/approval-steps.test.ts` で409。
2. 2段の一部承認: `approval-steps.test.ts`「1段目だけでは実行できず…」。`assertApprovalComplete` が失敗し、作業チェック・模擬完了が409。
3. 変更・取消: 同ファイル「変更でその版の全ステップが invalidated…」「承認取消で…」。全ステップ invalidated、新版 pending、取消後は終端。
4. 期限: 同ファイル「2段目の期限は1段目の承認時刻から72時間」と「期限切れのステップは決定も実行も拒否」。
5. 移行互換: `approval-migration-compat.test.ts`(0037→0038、バックフィル、down/up、down拒否、重複で失敗)。
6. 冪等リプレイ: `approval-steps.test.ts`「同じキー・同じ内容は再生し…」。`route_hash` で同一性判定。
7. 監査: `approval-steps.test.ts`「監査は approval.* で記録され…」。同一トランザクション、既存 `request.*` は不変、旧 `request.approved/rejected/revoked` は書かない。
8. 改ざん拒否: 同ファイル「route_hash を改ざん」「ステップ数と行数」「旧 route_generation」「承認者差し替え/current_approval_id」。
9. down拒否・型・lint: compat test と `typecheck` / `lint` 成功。`check:all` は 03.18 の Status 3行のみ(下記)。

## 既知の失敗・未解決

- `tests/security/department-profile.test.ts:1095` は `node tools/migrate.mjs down` が**最後のMigration(0037)を戻す**前提で書かれている。0038を追加したため、最初の down が0038を戻して成功し、1件失敗する。Allowed Paths外のため未修正。修正するなら `down --to 0036` 等で0037を対象にする必要がある。
- `npm run check:all` の `check:traceability` が FR-CAT-008/009/011 の Status 3行で失敗する。`03.18_Requirements_Traceability_Matrix.md` は指示により未変更。`node tools/check_traceability.mjs --write` で更新できる。

## セキュリティ影響

- 承認の実行前検証を、現在の版・現在の `route_generation` の全ステップ、`route` の段数と行数、`route_hash` の再計算値、期限、hash、自己承認・重複承認者まで拡張した。`route IS NULL` は移行前の1行legacy検証。
- 決定時の認可(approverロール必須、`approver_id` 一致、自己承認拒否、有効な所属)は緩めていない。`manager`/`department_head` のステップは本WPでは生成しない。
- 承認行の削除経路は追加していない。アプリロールへの DELETE 付与も変更なし。
- 監査 `approval.*` は業務と同一トランザクションで書き、失敗時は業務も失敗する。`afterState` に入力値・スナップショット本文を載せない。
