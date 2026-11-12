# Evidence: WP-P4-IDM-013 段階A 修正(A2: 同時実行)

- Timestamp: 2026-11-12 22:10 JST(UTC 13:10)
- Commit SHA(base HEAD、変更は作業ツリー): `8c7b27d` / branch `wp/WP-P4-IDM-013`
- Environment: macOS、Node.js `v26.13.0`、ローカル PostgreSQL。**使い捨てDB `solvi_wp013_test` のみ**で検証。開発用DB `solvi` は `SELECT` の件数確認だけ。
- 接続文字列・パスワードは記録していない。`08_unit_after.log` には既存テストが表示する**合成のダミー**接続文字列(`synthetic`)が含まれるが、実際の `.env` の値ではない。
- 使い捨てDBは作り直し、`tools/migrate.mjs up` で37件(0037まで)を適用し、`tools/seed.mjs` で合成データのみを投入した。検査用に残している。
- 生ログ: `raw/`(gitignore 対象)。

## 修正の内容

「上長の設定」(`updateProfile`)と「`org_admin` の付与」(`grantRole`)は、どちらも対象利用者の
`org_member_profile` 行を `SELECT ... FOR UPDATE` でロックしてから検査する。行が無ければ
`ensureOrgMemberProfile` で作ってからロックする。READ COMMITTED では、ロック取得後の文が
先行トランザクションのコミットを見るため、後続は 409 で拒否される。

`updateProfile` の現在値・本人変更の検査・監査の before も、ロック後に読み直した値を使う。
ロック順序は両経路とも対象利用者のプロフィール行が先で、DBトリガの advisory lock はその後。

## ファイル

| ファイル | 内容 | 結果 |
|---|---|---|
| raw/00_dev_db_before.json | 開発用DBの作業前件数(SELECTのみ) | app_user=15 / role_binding=21 / ticket=23 / local_service_request=12 / local_request_approval=17 / audit_event=1328 / session=291 / schema 0037 |
| raw/13_dev_db_after.json | 開発用DBの作業後件数(SELECTのみ) | 作業前と同一。**開発用DBには書き込んでいない** |
| raw/01_no_lock_run.log | `FOR UPDATE` を外した状態(付与前の ensure は残す)で新規テスト | 1 failed / 2 passed。付与が先行する順序で「後続が待機していない」 |
| raw/02_no_lock_both_orders_run.log | ロックなし+修正前の順序(付与前の ensure も外す)で新規テスト | **2 failed / 1 passed**。「上長付きの利用者に org_admin が付与された」(実際に不変条件が破れた) |
| raw/03_concurrency_after_restore.log | ファイル復元後の新規テスト | 3 passed |
| raw/04_related_tests.log | 関連7ファイル(既存6+新規) | 157 passed |
| raw/05_typecheck.log | `npm run typecheck` | 成功(exit 0) |
| raw/06_lint.log | `npm run lint` | 成功(exit 0) |
| raw/07_check_all.log | `npm run check:all` | 成功(exit 0) |
| raw/08_unit_after.log | `npm run test:unit` | 34 failed / 4313 passed(4347) |
| raw/09_unit_after_failures.txt | 失敗したテスト名の一覧 | 35行(34件+ファイル単位1) |
| raw/10_unit_failure_diff.txt | 段階Aの基点との差分 | 空(新しい失敗なし) |
| raw/11_security_full.log | `vitest run tests/security` 全体 | 31 failed / 627 passed / 10 skipped。環境依存(下記) |
| raw/12_prettier.log | 変更ファイルの整形確認 | 成功 |
| raw/14_disposable_db_state.txt | 検査用に残したDBの状態 | `solvi_wp013_test`、37 migrations |
| raw/15_git_status.txt | `git status --short` | `apps/web/` と `tools/` に変更なし |

## 修正前(ロックなし)の確認

作業ツリーのファイルを `git stash` / `git checkout` で巻き戻さず、`lockProfileRow` の
`FOR UPDATE` を一時的に外して実行した。さらに修正前のコードの順序(上長の検査より後に
プロフィール行を作る)に合わせるため、`grantRole` の付与前の `ensureOrgMemberProfile` も
一時的に外した。この状態では2つの順序の両方が失敗し、とくに「上長の設定が先行」では
**「上長付きの利用者に `org_admin` が付与された」**で失敗した(最終状態が
「有効な `org_admin` かつ上長あり」になった)。

その後、退避したファイルから復元し、SHA-256 が元と一致することを確認してから再実行し、
3 passed。壊れた状態のコードは残していない。

## 注記

- 作業開始時点で、開発用DB `solvi` には Migration `0037` が適用済みだった(前回の記録では未適用)。
  件数は前回の記録と同一であり、本作業では開発用DBへ書き込んでいない。監督者側の作業と思われる。
- `tests/security` 全体の31件の失敗は、記憶域・スキャナのサービス未起動、既知の読込不能6ファイル、
  `approval-assertion` の申請0件前提、`user-directory-consistency` の専用DB名要求による。
  本WPの変更を通るテストではない。関連7ファイルは 157 passed。
- Migration は0件。スキーマ変更なし。新規依存パッケージは0件(`package.json` / lockfile 未変更)。
