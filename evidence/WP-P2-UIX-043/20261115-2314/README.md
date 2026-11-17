# WP-P2-UIX-043 Evidence (2026-11-15)

modern-web-guidance 点検で見つかったP1/P2の修正。

## 変更の狙い

- `FeedbackForm` のSSR `inert` を外し、JS無効・ハイドレーション失敗時もフォームを操作可能にする。
- モバイルの閉じたレールを `visibility: hidden` にし、開閉時のフォーカス移動・復帰・背景 `inert` を追加する。
- ポータル検索のフォーカスリングと、入力境界の3:1コントラストを追加する。
- 全25テーブルを `TableRegion` + captionへ統一する。
- 16px以上の入力文字、coarse pointerの44pxターゲット、rem typographyへ移行する。
- 日時表示と「今日」をJST固定にする。

## 検証

- `tests-focused.txt`: 5ファイル・52テスト成功。
- `typecheck.txt`: `npm run typecheck` 成功。
- `eslint.txt`: 変更ファイルの `eslint --max-warnings=0` 成功。
- `unit-summary.txt`: 全体ユニットは34失敗。失敗4ファイルは本WPの変更前から存在するfixture欠落・過去コミット参照・既存期待値で、追加テストは成功している。

## 未実施

- 実ブラウザのaxe。既存の `tools/check_accessibility.mjs` は現環境の `SYNTHETIC_*` でログインが401となり、認証後画面を検査できなかった。
- CSP/HSTS等のセキュリティヘッダーはADRが必要なため、本WPの対象外。
