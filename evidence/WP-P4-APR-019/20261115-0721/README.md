# WP-P4-APR-019 段階B の Evidence

日時: 2026-11-15 07:21 (JST)
作業ツリー: `wp/WP-P4-APR-019`(未コミット。段階Aの成果を含む)

接続文字列・パスワード・`.env` の値は、このディレクトリのログと本ファイルに含めていない。
開発用DB(`solvi`)へは `SELECT` だけを実行した(件数の確認)。検証はすべて、
名前に `wp019` を含む使い捨てDBで行った。

## 使い捨てDB

- `solvi_wp019_test`: Migration 0041 の up / down / up と、データがある状態の down の拒否。
- `solvi_wp019_wp018_wp015_test`: 承認の security テスト一式(`wp015` / `wp018` / `wp019` の
  接続先ガードをすべて満たすため)。`tests/security` 全体もこのDBで実行した。
- どちらも Migration 41 件・最大 `0041`、`organization_approval_sweep_lookup` あり。
  検査用に残している。

## ファイル

| ファイル | 内容 |
|---|---|
| `db-counts-before.log` | 開発用DBの件数(管理者接続)。作業前 |
| `db-counts-after.log` | 開発用DBの件数(管理者接続)。作業後。前後で同じ |
| `approval-security.log` | `tests/security/approval-*.test.ts` 5ファイル / 167 tests passed |
| `security-full.log` | `vitest run tests/security`。6 failed(既知の読み込み不能6ファイル)/ 37 passed、853 passed / 10 skipped。S3 の 403 は出なかった |
| `unit-full.log` | `npm run test:unit`。34 failed / 4526 passed。失敗は `knowledge-list` / `knowledge-search-page` / `performance-runtime` / `performance-search-static-cli` の4ファイルだけで、承認・通知・申請のテストに失敗は無い(基点と同じ34件)。無関係な性能テストが表示する**合成の**接続文字列は、実値と誤解されないよう `<REDACTED-SYNTHETIC-URL>` に伏せた |
| `check-all.log` | `npm run check:all` exit 0(未接続検査を含む) |
| `check-rls.log` | `node tools/check_rls.mjs` 問題0件 |
| `lint-with-claude.log` | `npm run lint`。`.claude/worktrees/` の追跡外ファイル1件のみ |
| `eslint-without-claude.log` | `npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'` exit 0(空ファイル) |
| `typecheck.log` | `npm run typecheck` exit 0 |
| `migration-0041-roundtrip.log` | 0041 の up / down / up、データがある状態の down の拒否、掃除後の再往復 |
| `git-status.txt` | `git status --short` |

## 開発用DBの件数(管理者接続の SELECT)

| テーブル | 作業前 | 作業後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 26 | 26 |
| `local_service_request` | 17 | 17 |
| `local_request_revision` | 22 | 22 |
| `local_request_approval` | 29 | 29 |
| `local_request_route_generation` | 2 | 2 |
| `outbox_event` | 440 | 440 |
| `notification` | 82 | 82 |

`schema_migration` は40件・最大 `0040` のまま。`local_request_approval_notice` は
開発用DBに無い(0041 未適用)。

## セキュリティ上の確認

- 新しい RLS の例外は `organization` の `FOR SELECT` 1件だけ(`app.approval_sweep`)。
  `COMMENT ON POLICY` を付け、down で `DROP POLICY IF EXISTS` する。
- 組織の一覧を読むトランザクションは `organization` の `id` だけを読み、
  業務テーブルを読み書きしない。フラグは `SET LOCAL` で次のトランザクションへ残らない。
- フラグを立てても、業務テーブルは組織の文脈が無ければ0件のまま。
  アプリケーションロールは `organization` を越境して `UPDATE` できない。
- 承認・申請・通知のテーブルに新しい例外は無い。
