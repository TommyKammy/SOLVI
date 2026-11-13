# Evidence: WP-P4-APR-016 段階A(管理者向けの画面)

- Timestamp: 2026-11-14 08:22-08:36 JST(UTC 2026-11-13 23:22-23:36)
- Commit SHA(base HEAD、変更は作業ツリー): `921d7f9` / branch `wp/WP-P4-APR-016`
- Environment: macOS、Node.js `v26.13.0`。開発スタック(Web `127.0.0.1:3000`、API `127.0.0.1:3001`)は停止・再起動せず、そのまま使った。
- 開発用DB `solvi` への書込みは**ブラウザ経由の画面操作だけ**。件数確認は `SELECT count(*)` のみ。
- security テストは使い捨てDB `solvi_wp016_wp015_test`(名前に `wp016` と `test` を含む。`approval-rule.test.ts` が要求する `wp015` も含む)だけで実行し、Migration 39 件(0039 まで)を適用した。seed は実行していない。
- 接続文字列・パスワードは記録していない。ブラウザのパスワードは環境変数から読み、ログ・summary・本READMEに残していない。

## 結果

| 検証 | 結果 |
|---|---|
| Chromium 承認ルールUI(18 checks / 16 axe scans) | PASS |
| WebKit 承認ルールUI(18 checks / 16 axe scans) | PASS |
| axe serious/critical 違反 | 0(全スキャンで violations 0) |
| 1440px / 375px の横溢れ | なし |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run check:all` | exit 0 |
| `npm run test:unit` | 34 failed / 4418 passed。変更前(34 failed / 4397 passed)と失敗テスト名が完全一致(新規失敗0) |
| `tests/security/relationship-change.test.ts` / `approval-rule.test.ts` | 39 passed / 0 failed |
| 組織でのルール有効化 | 検査の最後に無効へ戻した(`org_approval_setting.rule_routing_enabled = false`) |
| 有効な `ui016-syn-` ルール | 0件(コードはAPIの制約により小文字。名称に `UI016` を含む) |

## ブラウザ確認の内容

`tools/ui_approval_routing_check.mjs` を Chromium と WebKit で実行した。

1. 管理ホームのカードと左レールから `/ops/approvals` を開ける。
2. キーボードだけで `上長 → 固定承認者` の2段ルールを作成できる。
3. 既存の版を変えずに新しい版を追加できる(版の履歴が2件)。
4. ルールのプレビューで、解決できない理由と足りない設定を表示する。
5. 公開済みカタログ項目のプレビューで、承認者の経路を段ごとに表示する。
6. 解決できない人の一覧を表示し、`/ops/users?selected=...` へ辿れる。
7. 合成カタログ項目に承認ルールを結び付けて保存・公開できる。
8. 有効化の確認画面に WP §6.1 の3点を表示し、有効化して状態を確認する。
9. 確認画面を挟んで無効へ戻せる。
10. 承認者不在の申請の節と案内を表示し、再割当の操作を出さない。
11. 上長・部署長の変更履歴を期間指定・新しい順で表示する。
12. アクセスレビューから変更履歴へ辿れる。
13. `agent` には画面も導線も出ない。`auditor` は変更履歴だけを見られる。
14. 1440px と 375px で横溢れがない。
15. 読み取り専用の再検証(無効化したルールの履歴、承認者不在の節)。
16. 再検証でも 1440px / 375px の横溢れがない。
17. 変更した既存画面(`/ops/admin`、`/catalog/manage/new`、`/ops/access-review`)の表示と axe。
18. APIの拒否理由(重複コード)を画面に表示し、内部の例外文を出さない。

補足(検査ツールの不具合と復旧): Chromium の初回実行は、左レールの項目を開く操作の不具合で失敗した。作成済みの合成ルールは無効化し、修正後の再実行では「カタログ項目の作成または変更は最大1件」を守るため、初回に作成した合成項目を再利用した。初回の記録は `browser/chromium/attempt1/` に残している。

さらに、重複コードの拒否を確認する再検証で、ツールが新しい目印からコードを作ってしまい、意図せず合成ルールを1件ずつ作成した(Chromium と WebKit)。どちらも直ちに無効化し、ツールを修正して既存コードを使うように直した。最終状態で有効な合成ルールは0件。合成ルールは Chromium 3件、WebKit 2件で、いずれも無効。エンジンごとの上限4件以内。カタログ項目は各1件のまま。

## 開発用DBに残した合成データ

| データ | 件数 | 状態 |
|---|---|---|
| 承認ルール(`ui016-syn-*`) | 5件 | すべて無効。Chromium 3件(初回失敗分・再実行分・重複確認の誤作成分)、WebKit 2件(実行分・重複確認の誤作成分) |
| 承認ルールの版 | 8件 | 実行したルールは版1と版2。重複確認の誤作成分は版1のみ。保存済みの版は変更していない |
| `org_approval_setting` | 1行 | `rule_routing_enabled = false`。有効な組織は0 |
| 合成カタログ項目(`UI016 合成カタログ *`) | 2件 | すべて非公開。下書きの承認ルール結び付けを外した |
| 既存の公開済みカタログ項目 | 0件変更 | プレビューで読んだだけ |

開発用DBの件数(作業前 → 作業後):

| テーブル | 前 | 後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 21 | 21 |
| `ticket` | 23 | 23 |
| `local_catalog_item` | 19 | 21 |
| `local_service_request` | 12 | 12 |
| `local_request_revision` | 17 | 17 |
| `local_request_approval` | 17 | 17 |
| `department` | 17 | 17 |
| `org_member_profile` | 15 | 15 |
| `department_head` | 5 | 5 |
| `approval_rule` | 0 | 5 |
| `approval_rule_revision` | 0 | 8 |
| `org_approval_setting` | 0 | 1(無効) |
| `audit_event` | 1430 | 1525 |
| `session` | 328 | 376 |

増分の説明:

- `local_catalog_item` +2: Chromium 用1件(初回に作成し、再実行で再利用)、WebKit 用1件。どちらも非公開。
- `approval_rule` +5 / `approval_rule_revision` +8: 各エンジンの作成と版の追加、重複確認の誤作成分。すべて無効。
- `org_approval_setting` +1: 有効化の切替で行が作られ、最後に無効へ戻した。
- `audit_event` +95 / `session` +48: 承認ルール・有効化・カタログの画面操作と、ブラウザ確認のログインによる増分。

## ファイル

| ファイル | 内容 |
|---|---|
| `browser/chromium/summary.json` | Chromium の18 checks、axe結果、スクリーンショット一覧、書込み件数、片付け結果 |
| `browser/webkit/summary.json` | WebKit の同上(18 checks) |
| `browser/*/*.png` | 1440px / 375px のスクリーンショット |
| `browser/chromium/attempt1/` | 初回失敗時の summary と failure.png(参考。スクリーンショットは再実行で上書き) |
| `raw/00_environment.txt` | 環境・DB名・ブラウザ版・注記 |
| `raw/01_dev_db_before.json` / `02_dev_db_after.json` | 開発用DBの件数(前後) |
| `raw/03_unit_before_failures.txt` / `04_unit_after_failures.txt` / `05_unit_failure_diff.txt` | 単体テストの変更前後の失敗名と差分(新規失敗0) |
| `raw/06_related_unit.log` | 関連unit 87 passed |
| `raw/07_security.log` | security 39 passed(使い捨てDB) |
| `raw/08_typecheck.log` / `09_lint.log` / `10_check_all.log` | 品質ゲート |
| `raw/11_git_status.txt` | 変更ファイル(Allowed Paths 内) |
| `raw/12_axe_chromium.json` / `12_axe_webkit.json` | axe結果の抜粋 |
| `raw/13_*.log`〜`17_*.log` | ブラウザ検査の実行ログ |
| `raw/18_final_state.txt` | 検査後の有効化設定・合成ルール・合成カタログ項目の状態(読み取り) |

## 片付けの確認

- `org_approval_setting` の有効な行: 0件。
- 有効な `ui016-syn-*` ルール: 0件。
- 合成カタログ項目: すべて `active = false`。下書きの `approval.ruleId` は無し。
- 作った承認ルールはすべて `active = false`。
- 利用者・ロール・チケット・申請・部署・プロフィール・部署長は変更していない。
- `.env`、`package.json`、lockfile、`next.config.*`、Migration は変更していない。
