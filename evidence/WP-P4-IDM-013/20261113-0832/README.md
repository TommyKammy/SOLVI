# WP-P4-IDM-013 段階B 検証記録

2026-11-13。ブランチ `wp/WP-P4-IDM-013`、基点 `6eaea46`(段階A)。変更は作業ツリーにあり、コミット・pushはしていない。

利用者管理 `/ops/users` に部署・上長・役職の列と絞り込み、プロフィール充足状況、組織プロフィールの編集を追加した。部署管理 `/ops/departments` を新設し、ツリー・追加・編集・無効化(確認画面つき)・メンバー・部署長の設定と終了を実装した。左レールの管理メニュー(`navigation-groups.ts`)と `/ops/admin` はWPのAllowed Paths外のため変更せず、`/ops/users` の見出しに `/ops/departments` への導線を置いた。

## 環境

- Node.js v26.13.0 / Darwin arm64
- 稼働中の開発スタック: Web `http://127.0.0.1:3000`、API `http://127.0.0.1:3001`(停止・再起動・追加起動なし)
- ブラウザ: Chromium 157.0.8103.51 (channel `chrome`)、WebKit 26.5
- 開発用DB `solvi`(Migration 0037 適用済み)
- 使い捨てDB `solvi_wp013_test`(securityテストの再実行だけに使用)

## 検証結果

| 検証 | 結果 |
|---|---|
| `npm run typecheck` | 成功 |
| `npm run lint` | 成功 |
| `npm run check:all` | 成功(check:paths / architecture / images / skips / unwired / traceability / workpackages) |
| `npx vitest run tests/unit/department-ui.test.ts tests/unit/user-directory.test.ts tests/unit/user-directory-read.test.ts` | 41 passed |
| `npm run test:unit` | 34 failed / 4,326 passed(4,360)。失敗名の集合は段階Aの基点と同一。新規失敗0。差分は追加した13件の成功 |
| security再実行(使い捨てDB) | `department-api` / `department-api-concurrency` / `user-admin` の3ファイル 93 passed |
| ブラウザ WebKit | 15 checks、axe 9回・違反0、スクリーンショット9枚、1440/375px |
| ブラウザ Chromium | 14 checks、axe 10回・違反0、スクリーンショット10枚、1440/375px |

### ブラウザ確認の内訳

WebKit は、管理者ログイン → 利用者一覧の列・絞り込み・充足状況 → `部署管理` へのキーボード移動 → ルート部署のキーボードのみでの作成 → 子部署作成 → 主部署・上長の設定 → 部署長の設定 → 子部署・メンバー・部署長が残る無効化の拒否理由表示 → 本人/組織管理者の欄の無効化 → 社員番号が一覧・URLに出ないこと → 375px → 非org_adminの画面・導線なし → 片付け、までを通した。

Chromium は同じツールで、利用者一覧、導線、キーボードでのルート部署作成、子部署作成、主部署・上長の設定、部署長の設定、片付けまでを実施した(書き込みは部署3・部署長1・プロフィール1。片付けで部署長終了・プロフィール復元・部署3件の無効化)。その後、ツールのセレクタ競合で「現在の部署長」の表示確認が失敗した。原因を修正した後、データ上限(Chromiumの合成部署6件)に達していたため新規作成は行わず、`summary.json` の記録済みIDを読み取って、一覧・ツリー・詳細・拒否理由の表示・本人/組織管理者の欄・375px・非org_admin・片付けの照合を読み取りだけでやり直した(`success: true`)。Chromiumの無効化拒否3種の実操作と「現在の部署長」の表示確認はWebKitで通している。Chromiumの書き込み記録と片付けは `browser/chromium/summary.json` の `writes` / `cleanup` に残る。

- WebKit: `browser/webkit/summary.json`(15 checks / 9 axe / 9 screenshots)
- Chromium: `browser/chromium/summary.json`(14 checks / 10 axe / 10 screenshots)
- 失敗した試行の記録: `browser/chromium-attempt1/`、`browser/webkit-attempt1/`
- 画面画像: `browser/<engine>/*.png`

axe は WCAG 2.0/2.1/2.2 A/AA のタグで実行し、全スキャンで違反0。1440px と 375px の双方で `documentElement.scrollWidth <= innerWidth`、重複IDなしを確認した。外部オリジンへのリクエストは両エンジンとも0件(`blocked: []`)。

## 開発用DBの合成データ

作業前後(読み取りのみの `SELECT count(*)`。`raw/dev-db-before.json` / `raw/dev-db-counts.json`):

| テーブル | 前 | 後 | 差 |
|---|---:|---:|---:|
| app_user | 15 | 15 | 0 |
| role_binding | 21 | 21 | 0 |
| ticket | 23 | 23 | 0 |
| local_service_request | 12 | 12 | 0 |
| local_request_approval | 17 | 17 | 0 |
| org_member_profile | 15 | 15 | 0 |
| department | 0 | 11 | +11(すべて `UI013-SYN-`、すべて無効) |
| department_head | 0 | 3 | +3(すべて終了済み) |
| audit_event | 1,328 | 1,384 | +56 |
| session | 291 | 307 | +16 |

増分の内訳(`occurred_at >= 2026-11-12T23:30:00Z`): ログイン16、組織切替2、部署作成11、部署無効化11、部署編集4、部署長設定3、部署長終了3、プロフィール更新6。部署・部署長・プロフィールの操作回数と一致する。

残した合成部署(すべて無効。削除できないため無効化して残した):

- `UI013-SYN-1794526364473-chromium-ROOT` / `-CHILD` / `-HEAD`
- `UI013-SYN-1794526521592-chromium-ROOT` / `-CHILD` / `-HEAD`
- `UI013-SYN-1794526617676-webkit-ROOT` / `-CHILD`
- `UI013-SYN-1794526662854-webkit-ROOT` / `-CHILD` / `-HEAD`

部署長3件はすべて `valid_until` を設定して終了済み。既存利用者のプロフィールはすべて未設定へ戻した(`job_title` / `location` / `employee_id` / 主部署 / 上長が空。`raw/dev-db-counts.json` の `remainingProfileValues` は0行)。既存のチケット・申請・カタログ・ロール・利用者は変更していない。

## 実行コマンド

- `npm run typecheck`
- `npm run lint`
- `npm run check:all`
- `npx vitest run tests/unit/department-ui.test.ts tests/unit/user-directory.test.ts tests/unit/user-directory-read.test.ts`
- `npm run test:unit -- --reporter=json --outputFile=evidence/WP-P4-IDM-013/20261113-0832/raw/unit-after.json`
- `DATABASE_URL=<solvi_wp013_test> DATABASE_ADMIN_URL=<solvi_wp013_test> npx vitest run tests/security/department-api.test.ts tests/security/department-api-concurrency.test.ts tests/security/user-admin.test.ts`
- `SOLVI_SMOKE_PASSWORD=<非出力の環境変数> SOLVI_UI_BROWSER=chromium SOLVI_UI_OUT=evidence/WP-P4-IDM-013/20261113-0832/browser/chromium node tools/ui_department_check.mjs`
- `SOLVI_SMOKE_PASSWORD=<非出力の環境変数> SOLVI_UI_BROWSER=webkit SOLVI_UI_OUT=evidence/WP-P4-IDM-013/20261113-0832/browser/webkit node tools/ui_department_check.mjs`

資格情報・接続文字列・パスワードは記録していない。`.env` は変更していない。
