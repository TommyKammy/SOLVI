# Evidence: WP-P4-IDM-012(監督者の検査後の修正。前回 `20261112-1514/` を置き換える)

- Timestamp: 2026-11-12 15:21 JST(UTC 06:21)
- Commit SHA(base HEAD、変更は作業ツリー): `5c33cca` / branch `wp/WP-P4-IDM-012`
- Environment: macOS、PostgreSQL 16.6(ローカル)、**使い捨てDBのみ**: `solvi_wp012_test`(主)、`solvi_wp012_test_nolock`(ロックなし版)、`solvi_wp012_test_base`(診断用、0036 のみ)。開発用DBは SELECT の件数確認のみ。接続情報は記録していない。
- 生ログ: `raw/`(gitignore対象)

| ファイル | 内容 | 結果 |
|---|---|---|
| raw/03_check_rls.txt | `node tools/check_rls.mjs` | 問題 0 件 |
| raw/04_department_profile.txt | department-profile.test.ts | 27 passed |
| raw/05_concurrency_with_lock.txt | department-profile-concurrency.test.ts | 11 passed |
| raw/07_concurrency_without_lock.txt | 同(advisory lock を除いた関数) | 3 failed(部署4ノード・上長2件で循環が残る) |
| raw/06_user_admin.txt | user-admin.test.ts | 50 passed |
| raw/08_up_down_up_cli.txt | CLI の up → down(拒否)→ down(空)→ up | 期待どおり |
| raw/09_security_run1.* | `vitest run tests/security`(既定順) | 608 件中 598 passed / **0 failed** + 既存の読み込み不能 6 ファイル |
| raw/10_security_shuffled_seed7 / seed99 | 同(ファイル順をシャッフル) | いずれも 0 failed(同じ6ファイルのみ読み込み不能) |
| raw/10_security_run2_shuffled.json | 同(seed 20261112) | 1 failed(role-binding-expiry の順序依存。下記) |
| raw/12_* / 13_* | `vitest run tests/unit` 前/後 | 4305 件中 34 失敗、失敗集合は同一 |
| raw/14〜16 | lint / typecheck / check:all | すべて exit 0 |
| raw/17_dev_db_* | 開発用DB件数 前/後 | 同一、新テーブル 0、schema_migration は 0036 のまま |

基点(0037 なし)の `tests/security` は 566 件 0 失敗(前回 Evidence `raw/10_security_suite_baseline_0036.json`)。

## 注記
- seed 20261112 の順序で `role-binding-expiry.test.ts` が 1 件落ちる(期限切れ束縛の掃引が 2 件を記録)。本WPのファイルを除外しても同じ seed で落ち、基点のコピーでも同ファイルが落ちたため、本WPと無関係の既存の順序依存と判断した。
- ロックなし版でも、部署の2ノード・3ノードの輪は通る。無効な親の拒否のための `FOR SHARE` が隣接する更新を偶然に直列化するため。行を共有しない4ノードの輪と上長は advisory lock なしでは循環が残る。
- 既存の読み込み不能 6 ファイルは `evidence/WP-P3-KNWUI-054/20261007/*.mjs` が無いため(基点でも同じ)。
