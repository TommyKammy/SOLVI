# WP-P4-APR-015 段階B Evidence (2026-11-14)

対象: 関係ベース承認の決定認可・承認待ち一覧/詳細の可視性・滞留の導出と
一覧の案内・上長/主部署/部署長の変更履歴API・互換テストのDB名一般化。

## 実施環境

- 使い捨てDB: `solvi_wp015_test`(Migration 0039 まで適用済み)
- 開発用DB `solvi` には SELECT 以外を実行していない。開発スタックの停止・再起動はしていない。
- 接続文字列・パスワードは記録していない。

## 結果

| 検証 | 結果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| 対象テスト(承認・部署・利用者管理・新規関係履歴) | 11ファイル / 250 passed / 0 failed |
| 対象単体テスト(approval-* + catalog-*) | 19ファイル / 731 passed / 0 failed |
| `vitest run tests/security` | 35 passed / 6 failed(既知の読み込み不能6ファイル) / 760 passed / 10 skipped |
| `npm run test:unit` | 34 failed / 4397 passed。変更前と失敗テスト名が完全一致(新規失敗0) |
| `node tools/check_rls.mjs` | 問題0件 / OK |
| `npm run check:all` | exit 0 |
| 開発用DBの件数 | 作業前後で完全一致。`schema_migration` 38件・最大 `0038` |

## 再割当を見送った理由(重要)

段階Bの再割当は、経路の `route` / `route_hash` / `route_generation` を
`local_request_revision` に保存し直す必要がある。しかし、アプリ接続ロール
`solvi_app` の `local_request_revision` に対する権限は **SELECT / INSERT のみ**で、
UPDATE が無い。実際に再割当の書込みを実行すると `42501 permission denied for table
local_request_revision` で失敗することを確認した。

`GRANT UPDATE`(または SECURITY DEFINER 関数)の追加は Migration を必要とし、
ブリーフの「段階Bでは新しい Migration を作らない。必要になった場合は作らずに理由を
報告する」に該当するため、実装を止めた。中途半端な API・遷移・監査イベント・テストは
作業ツリーから削除した。

実現する場合の設計上の選択肢は、最終報告
`.local/briefs/WP-P4-APR-015-B.report.md` に記載する。

## 成果物

`raw/` に実行ログと件数・状態のスナップショットを保存している。

- `wp015b-typecheck-final.log`
- `wp015b-lint-final.log`
- `wp015b-targeted-final.log`(承認・部署・利用者管理・関係履歴と一部 unit の同時実行)
- `wp015b-security-targeted-final.log`(承認・部署・利用者管理・関係履歴の11ファイル)
- `wp015b-security-final.log`(tests/security 全体)
- `wp015b-rel-final.log`(関係履歴API)
- `wp015b-unit-before.log` / `wp015b-unit-final.log`
- `wp015b-unit-catalog-final.log`(approval-* + catalog-* の unit)
- `wp015b-unit-before-fails.txt` / `wp015b-unit-final-fails.txt`
- `wp015b-check-all-final.log`
- `wp015b-check-rls-final.log`
- `wp015b-dev-counts-before.json` / `wp015b-dev-counts-final.json`
- `wp015b-db-state-final.json`
- `git-status.txt` / `git-diff-stat.txt`
