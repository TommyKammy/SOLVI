# Evidence: WP-P4-APR-020 段階A(代理承認。API・DB・通知)

- 実施日: 2026-11-15
- ブランチ: `wp/WP-P4-APR-020`
- 検証用の使い捨てDB: `solvi_wp020_wp019_wp018_wp015_test`(作業後に検査用として残した)
- 開発用DB `solvi` には Migration・テスト・cleanup・seed・書込みを行っていない(`SELECT` と件数のみ)。

## ファイル

| ファイル | 内容 |
|---|---|
| `security.txt` | `npx vitest run tests/security` 全体。900 passed / 10 skipped / 失敗は既知の読み込み不能6ファイルのみ |
| `unit-targeted.txt` | `npx vitest run tests/unit/approval-*.test.ts tests/unit/catalog-*.test.ts tests/unit/requests-ui.test.ts`。911 passed |
| `test-unit.txt` | `npm run test:unit` の全体。34 failed / 4539 passed(失敗は knowledge・performance の4ファイルだけ) |
| `check-rls.txt` | `node tools/check_rls.mjs`(使い捨てDB)。問題0件 |
| `check-all.txt` | `npm run check:all`。OK |
| `typecheck.txt` | `npm run typecheck`。エラー0 |
| `eslint.txt` | `npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'`。警告0 |
| `migration-roundtrip.txt` | Migration 0042 の down(`--to 0041`)→ up |
| `dev-db-counts.md` | 開発用DBの件数の作業前後 |
| `git-status.txt` | 作業後の `git status --short` |

## 補足

- 上記のコマンドはすべて、`DATABASE_URL` / `DATABASE_ADMIN_URL` を
  `solvi_wp020_wp019_wp018_wp015_test` へ上書きし、実行前に `current_database()` が
  `wp020` と `test` を含むことを確かめてから実行した。
- 既知の読み込み不能6ファイル: `knowledge-pagination` / `notification-list` /
  `notification-manual-retry` / `notification-preference` / `notification-retry`(いずれも
  `evidence/WP-P3-KNWUI-054/...` の fixture 不在)/ `user-directory-consistency`(分離DBの setup 失敗)。
- 秘密情報・`.env` の値・パスワードはこのディレクトリにも報告にも含めていない。
