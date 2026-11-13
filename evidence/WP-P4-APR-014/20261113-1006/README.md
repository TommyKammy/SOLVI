# Evidence: WP-P4-APR-014 R2(検査指摘3点の修正)

- Timestamp: 2026-11-13 10:06 JST
- Branch: `wp/WP-P4-APR-014`(変更は作業ツリー。コミットなし)
- Environment: macOS、Node.js `v26.13.0`、ローカル PostgreSQL。
- 検証は**使い捨てDB `solvi_wp014_test`**(Migration 0038 適用済み。seed 済み)のみ。
  Migration 互換テストは自分で `solvi_wp014_test_compat_<乱数>` を作成し、終了時に削除する。
- 開発用DB `solvi` は `SELECT count(*)` のみ。件数は作業前後で不変、`schema_migration` は37件・最大 `0037` のまま。
- 開発スタック(Web 3000 / API 3001)は停止・再起動していない。
- 接続文字列・パスワードは記録していない。`.local/credentials.txt` と `.local/investigations/` は開いていない。
- 生ログ: `raw/`(gitignore 対象)。

## 今回(R2)の修正点

1. **承認取消(`invalidated`)後の変更を再び受け付ける**: `edit` の拒否を `completed` / `cancelled` だけに戻し、遷移表に
   `edit: invalidated(step) / invalidated(申請) → step は invalidated のまま、申請は新しい版で pending` を追加した。
   既に `invalidated` のステップは UPDATE も `approval.invalidated` の監査も重ねて書かない。
   併せて、却下された多段申請で先行ステップが `approved` のまま残る場合の遷移
   (`edit: approved(step) / rejected(申請) → invalidated`)も追加した。
2. **`tests/security/department-profile.test.ts` の追従**: 0037 の down を検証する前に `migrate down --to 0037` で
   後続 Migration(0038 以降)を先に巻き戻し、`max(schema_migration.version)='0037'` を確認してから
   従来どおり「行があれば拒否 / 空なら成功」を検証する。最後に必ず `migrate up` で最新へ戻す。
   検証内容(拒否3ケース、成功1ケース、up→down→up、後片付け)は緩めていない。
3. **`decide` の応答**: `state` を申請の状態へ戻し、ステップの状態を `stepState` として加算した
   (`{ id, state: <申請>, stepState: <ステップ> }`)。途中ステップの承認は `state: 'pending'`。

## 生ログ

| ファイル | 内容 | 結果 |
|---|---|---|
| raw/00_environment.txt | 環境・branch・HEAD | - |
| raw/01_dev_db_before.json | 開発用DBの作業前件数(SELECTのみ) | 11テーブル + `schema_migration=37` |
| raw/14_dev_db_after.json | 開発用DBの作業後件数(SELECTのみ) | 作業前と完全一致。`schema_migration=37`、最大 `0037` |
| raw/02_targeted_tests.log | 対象の単体・security テスト(8ファイル) | **235 passed / 0 failed** |
| raw/04_unit_after.log / 05_*_failures.txt | `npm run test:unit` | 34 failed / 4368 passed(4402)。4ファイル |
| raw/06_unit_failure_diff.txt | 前回の基点(20261113-0946/raw/02_unit_before.log)との失敗テスト名の差分 | **空(新規失敗0)** |
| raw/08_security_full.log | `vitest run tests/security` | 687 passed / 10 skipped / **個別テストの失敗0**。失敗は既知の読み込み不能6ファイルのみ |
| raw/09_migrations.log | 使い捨てDBの 0038 down → up → status | down成功(データなし)、up成功、38/38 |
| raw/07_check_rls.log | `node tools/check_rls.mjs`(使い捨てDB) | 問題0件 / OK |
| raw/10_typecheck.log / 10_typecheck.exit | `npm run typecheck` | 成功(exit 0) |
| raw/11_lint.log / 11_lint.exit | `npm run lint` | 成功(exit 0) |
| raw/12_check_all.log / 12_check_all.exit | `npm run check:all` | **成功(exit 0)**。`check:traceability` も OK |
| raw/13_prettier.txt | 変更ファイルの整形確認 | 成功 |
| raw/15_disposable_dbs.json | 名前が `wp014` のDB | `solvi_wp014_test` のみ |
| raw/16_git_status.txt | `git status --short` | Allowed Paths 内 + 監督者が更新した `03.18` / WP |

## R2 の検証項目と結果

- 取消済みの申請の変更: `tests/security/approval-steps.test.ts`「承認取消で全ステップが invalidated…」の後半で、
  取消 → 申請者が変更 → 新しい版で `pending` → 承認 → 作業チェック更新 → 模擬完了までを通し、
  旧版のステップでは決定(404)も実行(409)もできないこと、`approval.invalidated` を重ねて書かないこと
  (取消時の2件のまま)を確認。
- 却下 → 変更 → 再承認: 同ファイル「却下された申請は、申請者が内容を修正して再承認を依頼できる」。
- 期限切れ → 変更 → 再承認: 同ファイル「期限切れの申請は、申請者が内容を修正して再承認を依頼できる」。
  新しいステップの期限が変更時刻から72時間であることも確認。
- 完了・取下げの変更は409: 同ファイル「完了・取下げ済みの申請は変更できない」。
- `completed` / `cancelled` の遷移が未定義であること: `tests/unit/approval-state.test.ts`。
- 遷移表と1:1: `tests/unit/approval-state.test.ts`(表の `toStrictEqual` と全組み合わせ)。
- `decide` の応答: 上記 security テストの1段目承認(`state: 'pending', stepState: 'approved'`)、
  最終ステップ(`state: 'approved', stepState: 'approved'`)、`approval-migration-compat.test.ts`。
- 0037 の down: `tests/security/department-profile.test.ts`(27 passed)。後続 Migration があっても成立。

## 既知の失敗(本WPの変更に起因しない)

- `npm run test:unit`: 34 failed / 4ファイル(`knowledge-list`, `knowledge-search-page`,
  `performance-runtime`, `performance-search-static-cli`)。前回の基点と失敗テスト名が完全一致(差分空)。
- `vitest run tests/security`: 失敗は既知の読み込み不能6ファイルのみ
  (`knowledge-pagination`, `notification-list`, `notification-manual-retry`, `notification-preference`,
  `notification-retry`, `user-directory-consistency`。`evidence/WP-P3-KNWUI-054/...` の欠落モジュールに依存)。
  これらを除く32ファイルは 687 passed / 10 skipped / 0 failed。

## セキュリティ影響

- 承認取消後の再申請は「新しい版・新しい経路・新しい最初のステップ」を作る。旧版のステップは `invalidated` のまま
  変更せず、決定・実行の対象にならない(`current_approval_id` は新しいステップを指す)。
- `edit` の拒否は `completed` / `cancelled` だけに戻したが、`approver` ロール・固定承認者の一致・
  自己承認の拒否・有効な所属の検証は変更していない。未定義の遷移は遷移表で 409 のまま。
- 監査は業務と同一トランザクション。取消済みステップの `approval.invalidated` を重ねて書かないことをテストで固定。
- 承認行の削除経路、認可のバイパス、環境変数による切替は追加していない。
- 新規依存パッケージ0件。`package.json` / lockfile / `.env` / `next.config.*` / `apps/web/` は未変更。

## 検査用に残したDB

- `solvi_wp014_test`(Migration 38件適用済み、0038 含む、seed 済み)。
- 現在 `wp014` を含むDBはこの1つのみ(`solvi_wp014_test_compat_*` はテストが終了時に削除)。
