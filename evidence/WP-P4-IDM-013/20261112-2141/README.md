# Evidence: WP-P4-IDM-013 段階A(API・監査・テスト)

- Timestamp: 2026-11-12 21:51 JST(UTC 12:51)
- Commit SHA(base HEAD、変更は作業ツリー): `8c7b27d` / branch `wp/WP-P4-IDM-013`
- Environment: macOS、Node.js `v26.13.0`、ローカル PostgreSQL。**使い捨てDB `solvi_wp013_test` のみ**で検証。開発用DB `solvi` は `SELECT` の件数確認だけ。
- 接続文字列・パスワードは記録していない。
- 生ログ: `raw/`(gitignore 対象)。`02_unit_before.log` / `04_unit_after.log` は、既存の単体テストが出力する**合成のダミー接続文字列**を伏字化している(実際の `.env` の値は含まれない)。

| ファイル | 内容 | 結果 |
|---|---|---|
| raw/00_environment.txt | 環境・DB名・検証上の注記 | - |
| raw/01_dev_db_before.json | 開発用DBの作業前件数(SELECTのみ) | app_user=15 / role_binding=21 / ticket=23 / local_service_request=12 / local_request_approval=17 / audit_event=1328 / session=291 / 0037テーブルなし / schema 0036 |
| raw/19_dev_db_after.json | 開発用DBの作業後件数(SELECTのみ) | 作業前と同一。0037テーブルなし。schema 0036 |
| raw/02_unit_before.log / 03_*_failures.txt | `npm run test:unit` 変更前 | 34 failed / 4309 passed(4343) |
| raw/04_unit_after.log / 05_*_failures.txt | `npm run test:unit` 変更後 | 34 failed / 4313 passed(4347) |
| raw/06_unit_failure_diff.txt | 失敗したテスト名の差分 | 空(同一) |
| raw/07_related_tests.log | department-api / user-admin / department-profile / access-review / user-directory* | 6ファイル 154 passed |
| raw/08_security_full.log | `vitest run tests/security`(使い捨てDB) | 654 passed / 1 failed / 10 skipped。失敗は approval-assertion の既存申請前提。読み込み不能6ファイルは既知 |
| raw/09_approval_assertion_isolated.log | 合成申請を1件置いたDBで approval-assertion 単独 | 18 passed |
| raw/10_typecheck.log / 11_lint.log | `npm run typecheck` / `npm run lint` | 成功 |
| raw/12_check_all.log | `npm run check:all` | `check:traceability` のみ失敗(台帳3行のStatus。RTMはAllowed Paths外のため未変更) |
| raw/13_check_workpackages.log | `npm run check:workpackages` | 成功 |
| raw/14_security_summary.txt | security 全体の要約 | - |
| raw/15_migrate_status.txt | 使い捨てDBのMigration | 37件適用済み(0037まで) |
| raw/16_disposable_db_state.txt | 検査用に残したDBの状態 | `solvi_wp013_test` |
| raw/17_git_status.txt | `git status --short` | `apps/web/` と `tools/` に変更なし |
| raw/18_prettier.txt | 変更ファイルの整形確認 | 成功 |

## 実装したHTTP経路

| Method | Path | 許可 |
|---|---|---|
| GET | `/departments` | `org_admin` |
| POST | `/departments` | `org_admin` |
| POST | `/departments/:id/edit` | `org_admin` |
| POST | `/departments/:id/deactivate` | `org_admin` |
| GET | `/departments/:id/members` | `org_admin` |
| POST | `/departments/:id/head` | `org_admin` |
| POST | `/departments/:id/head/end` | `org_admin` |
| GET | `/users`(既存を拡張) | `org_admin` / `platform_admin`(既存) |
| GET | `/users/:id/profile` | `org_admin` / 本人 / その人の上長 / `agent` は限定項目 |
| POST | `/users/:id/profile` | `org_admin` |

## 監査イベント

`AUDIT_EVENT_TYPES` に追加し、業務変更と同一トランザクションで記録する。

- `org.member.profile.updated`(社員番号は値を載せず `employeeIdChanged` のみ)
- `org.department.created` / `org.department.updated` / `org.department.deactivated`
- `org.department.head.assigned` / `org.department.head.removed`

## 注記

- Migration は0件。スキーマ変更なし。
- 新規依存パッケージは0件(`package.json` / lockfile 未変更)。
- 開発用DBへの Migration・テスト・cleanup・書込みは実行していない。
- 段階B(UI・axe・スクリーンショット)は未着手。
