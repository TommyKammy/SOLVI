# Evidence: WP-P4-IDM-012

- Timestamp: 2026-11-12 15:14 JST (UTC 06:14)
- Commit SHA (base HEAD, 変更は作業ツリー): `5c33cca` / branch `wp/WP-P4-IDM-012`
- Environment: macOS, Node 使用、PostgreSQL 16.6(ローカル)、**使い捨てDB** のみ。
  - `solvi_wp012_test`: 全Migration(0037含む)+seed。主検証。
  - `solvi_wp012_test_nolock`: 0037のトリガ関数から `pg_advisory_xact_lock` を除いた版(ロックなしで落ちることの確認用)。
  - `solvi_wp012_test_base`: 0037未適用(基点)。基点のセキュリティスイートとCLIのup/down確認用。
  - `solvi_wp012_test_cascade`: 診断用。`org_member_profile.user_id` を `ON DELETE CASCADE` にした版。
  - 開発用DBには0037を適用せず、テスト・down・cleanup・書込みを実行していない(SELECTの件数確認のみ)。接続情報は記録していない。
- 生ログ: `raw/`(gitignore対象)。

| ファイル | 内容 | 結果 |
|---|---|---|
| `raw/01_migrate_up.txt` | `node tools/migrate.mjs up` / status | 0037 適用 |
| `raw/03_check_rls.txt` | `node tools/check_rls.mjs` | 問題 0 件 |
| `raw/04_department_profile.txt` | `vitest run tests/security/department-profile.test.ts` | 21 passed |
| `raw/05_concurrency_with_lock.txt` | `vitest run tests/security/department-profile-concurrency.test.ts`(ロックあり) | 6 passed |
| `raw/07_concurrency_without_lock.txt` | 同(ロックなしの関数) | **4 failed**(循環が残る)/ 2 passed(EXCLUDE と無効化は別機構) |
| `raw/06_user_admin.txt` | `vitest run tests/security/user-admin.test.ts` | 50 passed(既存46 + 追加4) |
| `raw/08_up_down_up_cli.txt` | CLIでの up→down(行あり: 拒否)→down(空: 成功)→up、バックフィル件数 15 = 有効な org 所属 15 | 期待どおり |
| `raw/09_security_suite_after.*` | `vitest run tests/security`(変更後) | 597 中 578 passed / 9 failed(access-review。下記) |
| `raw/10_security_suite_baseline_0036.json` | 同(基点・0037なし) | 566 中 556 passed / 0 failed |
| `raw/11_security_suite_diag_cascade_fk.json` | 同(診断。FKをCASCADEにした版) | 570 中 560 passed / 0 failed |
| `raw/12_*` `raw/13_*` | `vitest run tests/unit` 変更前/後 | 4305件中34失敗。失敗集合は同一(新規失敗0) |
| `raw/14_lint.txt` `15_typecheck.txt` `16_check_all.txt` | `npm run lint` / `typecheck` / `check:all` | すべて exit 0 |
| `raw/17_dev_db_before.json` `17_dev_db_after.json` | 開発用DBの主要テーブル件数 | 作業前後で同一。新テーブル0 |

## 既知の失敗(本WPが原因・Allowed Paths外)

`tests/security/access-review.test.ts` の9件は `UserAdminService.grantRole` を直接呼ぶため、WP §6-2 の仕様(同一トランザクションで `org_member_profile` を作る)により、
同ファイルの後片付け `DELETE FROM app_user WHERE primary_email LIKE 'ar-%'` が外部キー(`org_member_profile_user_id_fkey`、ON DELETE RESTRICT)で失敗する。
`raw/11` はFKを CASCADE にした使い捨てDBで0件になることを示す診断であり、Migrationの内容ではない。
同ファイルは WP §4 の Allowed Paths に含まれないため変更していない(監督者の判断事項)。

## 既存の失敗(本WPと無関係)

`knowledge-pagination` / `notification-*`(4ファイル)/ `user-directory-consistency` は `evidence/WP-P3-KNWUI-054/20261007/*.mjs` が存在せず、基点でも読み込みに失敗する(`raw/10` にも同じ6ファイル)。
