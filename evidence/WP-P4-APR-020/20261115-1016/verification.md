# WP-P4-APR-020 段階B 検証

環境: `DATABASE_URL` / `DATABASE_ADMIN_URL` を `solvi_wp020_wp019_wp018_wp015_test` に上書きし、
実行前に毎回 `current_database()` が `wp020` と `test` を含むことを確認した。

| コマンド | 結果 |
|---|---|
| `npx vitest run tests/security/approval-*.test.ts` | 250 passed(8ファイル) |
| `npx vitest run tests/security` | 902 passed / 10 skipped。失敗は既知の読み込み不能6ファイルのみ(`knowledge-pagination` / `notification-*` 4件 / `user-directory-consistency`)。テスト自体の失敗は0 |
| `npx vitest run tests/unit/approval-*.test.ts tests/unit/catalog-*.test.ts tests/unit/requests-ui.test.ts tests/unit/notification-list.test.ts tests/unit/notification-list-ui.test.ts` | 1083 passed(28ファイル) |
| `npm run test:unit` | 34 failed / 4594 passed(108ファイル中4ファイル)。失敗は `knowledge-list` / `knowledge-search-page` / `performance-runtime` / `performance-search-static-cli` のみ。段階Aの基点(34件)と同じで、承認・カタログ・受信箱・通知の新規失敗は0 |
| `npm run typecheck` | エラー0 |
| `npm run check:all` | OK |
| `npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'` | 警告0 |
| `node tools/check_rls.mjs`(使い捨てDB) | 問題0件 |
| `node --check tools/ui_approval_routing_check.mjs` | 構文 OK(既存の段階は変更していない。`wp020` は実行していない) |

## 画面(ハーネス)

**実画面ではない。** `apps/web/src/app/globals.css` と `apps/web/src/app/freshservice.css` を
そのまま読み込み、画面と同じクラス・同じ文言で組んだ静的HTMLを撮った。

- 7状態 × Chromium / WebKit × 1440px / 375px = 28 スキャン
- axe(serious / critical): 0
- 375px の横はみ出し: 0
- 状態: 委任者・代理者・組織管理者・候補0人・承認待ちの一覧・申請の詳細・受信箱

## 開発用DB(before / after)

`db/dev-before.json` と `db/dev-after.json` は同一。書込み・Migration・seed・cleanup は行っていない。

- `schema_migration` 42件(最大0042)、`pg_policies`(public)79件。
- 0042 は作業開始前(`2026-11-15T00:55:15Z`)に適用済みだった。本作業では変更していない。
- `approval_delegation` は0行。
