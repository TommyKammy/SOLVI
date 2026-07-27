# WP-P1-CI-006 Evidence

- 実施日時: 2026-07-27 10:23:22 JST
- 対象: CI品質ゲート(Gate 1 G1-6)

## 検査が実際に違反を捕捉することの確認

各検査に意図的な違反を注入し、失敗することを実証した。
「検査が存在する」ことと「検査が効く」ことは別であるため。

| 検査 | 注入した違反 | 結果 |
|---|---|---|
| check_architecture | services/api から @solvi/connectors を import | 検出・失敗 |
| check_no_skipped_tests | SKIP-UNTIL注釈のない it.skip | 検出・失敗 |
| check_image_pinning | docker-compose の image を tag のみに変更 | 検出・失敗 |

注入を取り除いた後、3件とも正常に通過することも確認済み。

## ローカルでの実行結果
```
$ npm run lint

$ npm run format:check
All matched files use Prettier code style!
$ npm run check:architecture
アーキテクチャ検査: 23 ファイル / 5 ルール
OK: 禁止依存はありません。
$ npm run check:skips
skip検査: 7 テストファイル
OK: 未注釈・期限切れの skip はありません。
$ npm run check:images
checked 6 image references
OK: すべてのイメージ参照が digest 固定されています。
$ npm run check:paths
checked 18 baseline work packages, 66 allowed paths
OK: すべてのAllowed Pathがリポジトリ構造と一致しています。
$ npm run check:rls
OK: RLS設定と接続ロール権限は期待どおりです。
$ npx vitest run
 Test Files  3 passed (3)
      Tests  51 passed (51)
```

## CIジョブ構成

| ジョブ | 内容 |
|---|---|
| static | lint / format / typecheck |
| unit | 単体テスト + skip検査 |
| database | マイグレーション / RLS検査 / 越境・監査テスト / down-up往復 |
| supply-chain | npm audit(High以上で失敗) / lockfile整合 / digest固定 / gitleaks |
| architecture | 禁止依存 / WPとの整合 / AIサービス境界 |

## 未実施

- GitHub Actions 上での実行は未検証(リモートリポジトリが未作成のため)。
  Gate 1 の判定前に、実際のPRでワークフローが動作することを確認する必要がある。
