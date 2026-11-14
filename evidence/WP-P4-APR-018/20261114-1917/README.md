# WP-P4-APR-018 段階A Evidence

- 日時: 2026-11-14 19:17 (JST)
- 範囲: 再割当のスキーマ・現在の経路の導出・実行前検証・API・状態機械・監査(段階A)
- 使い捨てDB: `solvi_wp018_test`(Migration 40件・seed)、`solvi_wp018_wp015_test`(全 security 用)
- 開発用DB `solvi` には Migration・テスト・cleanup・seed・書込みを実行していない(SELECT の件数確認のみ)

## 主要な結果

| 検証 | 結果 |
|---|---|
| `tests/security/approval-reassign.test.ts` | 36 passed / 0 failed |
| `tests/unit/approval-reassign.test.ts` | 18 passed / 0 failed |
| 既存の承認・部門・関係・利用者テスト(10ファイル) | 282 passed / 0 failed |
| `vitest run tests/security` | 36 passed / 6 failed(既知の読み込み不能6ファイル)/ 807 passed / 10 skipped |
| `npm run test:unit` | 34 failed / 4455 passed(4489)。基点の失敗名35行と完全一致(新規失敗0) |
| `node tools/check_rls.mjs`(使い捨てDB) | 問題0件 / OK |
| `npm run typecheck` / `npm run lint` / `npm run check:all` | すべて exit 0 |
| 開発用DBの件数・Migration | 作業前後で完全一致。`schema_migration` は39件・最大 `0039` のまま |

## ファイル

- `raw/reassign-tests.log`: 新規の security / unit テスト(54 passed)
- `raw/security.log`: `vitest run tests/security` 全体
- `raw/unit-after.log`: `npm run test:unit`
- `raw/unit-before-failures.txt` / `raw/unit-after-failures.txt`: 失敗名の比較(完全一致)
- `raw/check-all.log` / `raw/typecheck.log` / `raw/lint.log` / `raw/check-rls.log`
- `raw/dev-counts-before.txt` / `raw/dev-counts-after.txt`: 開発用DBの件数
- `raw/migrate-status-wp018.txt`: 使い捨てDBの Migration 40件
- `raw/git-status.txt`: 変更ファイル

## 未完了

- `services/api/src/main.ts` への POST `/service-requests/:id/reassignments` の登録。
  WP §4 の Allowed Paths に `main.ts` が無いため、ブリーフの指示に従い変更していない。
  コントローラのメソッドと全検査は実装済み。
- 画面(段階B)と `tools/ui_approval_routing_check.mjs`。
