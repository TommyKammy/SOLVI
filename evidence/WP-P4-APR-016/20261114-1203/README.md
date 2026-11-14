# WP-P4-APR-016 段階C — 文言・表示修正のEvidence

- 日時: 2026-11-14
- ブランチ: `wp/WP-P4-APR-016`
- HEAD: `ef63365d95084e2d3c2c64a3bff212dc3f4b5f6f`(段階Cの変更は作業ツリーに未コミット)
- 範囲: 申請前の解決不能理由、利用者向けの文の「API」、申請詳細の「承認の記録」の3点
- API・サービス・スキーマ・Migration・新規依存: 変更なし

## 構成

- `counts-before.json` / `counts-after.json`: 開発用DBの件数(前後で同一)
- `browser/chromium/` / `browser/webkit/`: 1440px・375px のスクリーンショット、`summary.json`、axe結果
- `raw/unit-after.txt`: `npm run test:unit` の実行ログ
- `raw/unit-failure-names-baseline.txt`: 同一WPの基点(段階AのEvidence)の失敗名
- `raw/unit-failure-names-after.txt`: 今回の失敗名
- `raw/unit-failure-name-diff.txt`: 空(差分なし)
- `raw/verification-commands.txt`: 実行したコマンドと結果

## ブラウザで確認した画面

読み取りのみ。ログインによるセッション・監査イベントの増加以外の書込みはない。

- 2段の完了済み合成申請: 「承認の記録」が版ごとに1件、2段は「承認の経過」。
- 1段の完了済み申請: 記録が1件のまま、結果・日時・理由・承認者・申請内容が残る。
- 過去版を持つ申請: 版1(無効)と版2(承認済み)が別々に1件、過去版の中に段・承認者・状態・日時・理由。
- `details` は Enter で開く。1440px/375px で横溢れなし、axe serious/critical 0。

## ブラウザで確認していないこと

申請画面の解決不能理由と注記は、開発用DBへの書込みなしでは再現できないため未確認。
`tests/unit/requests-ui.test.ts` の実レンダリングで文言を固定している。

## 環境上の注意

Playwright 1.62 が期待する chromium-1234 が環境に無かったため、ダウンロードはせず、
既存の chromium-1248 と webkit-2336 を `executablePath` で使用した。
