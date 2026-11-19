# WP-P7-CHGUI-005 実画面の検証

2026-11-19 JST。既存のMigration 42件を適用した隔離PostgreSQL、SOLVIのWeb本番ビルドとAPI、Google Chromeを使用した。依頼者・担当者・指名承認者は別々の合成セッションで操作した。

| 主操作の画面幅 | 資産タグ | 変更番号 | 記録した実施結果 |
|---|---|---|---|
| PC 1440px・Enter | `SYN-OPS-1440-01` | `CHG-000001` | 成功・切戻し不要 |
| モバイル幅375px・タップ | `SYN-OPS-375-01` | `CHG-000002` | 失敗・切戻しあり |

- CSVの正常1行・エラー1行をプレビューした。「不正」フィルターで3行目の除外理由を読み、台帳に未登録であることを確認した。確定すると正常1行だけを登録し、確定結果の資産リンクから台帳を開けた。エラー行だけの別CSVでは確定操作を表示しなかった。
- 資産詳細から対象を選択済みの変更計画を開き、起点チケットと承認者を選んで保存した。同じ資産ID・資産版を持つ計画を承認へ送り、指名承認者が別セッションから同じ計画版を承認した。
- 担当者が予定を確定して開始を記録し、結果・テスト結果・切戻しを記録した。同じ変更に原因、教訓、再発防止の実施後レビューを保存した。担当者と承認者の操作権限差と、実施結果の外部変更0件を確認した。失敗の計画はレビュー記録前だけ「失敗・PIR未記入」に表示された。
- 両方の資産ID・変更IDを反対側の画面幅でも照合した。エラー行と理由、確定結果の資産リンク、承認待ち、保存済みの実施結果とレビュー、資産との相互リンクを確認した。
- CSVエラー、確定結果、資産詳細、承認、レビュー済み詳細の5画面をライト・ダーク両テーマ、PC・モバイル幅で計20回axe検査した。違反・判定保留0件で、文書とCSVプレビューの横はみ出しは0pxだった。

[実レコードのIDとaxe結果](summary.json) · [モバイルのCSVエラー](screens/light-375-preview-errors.png) · [PCの承認](screens/light-1440-approval.png) · [モバイルの実施後レビュー](screens/light-375-closed-review.png)

## 再現

リポジトリのルートから実行する。ポート3220と3221、ループバックのPostgreSQL、Google Chromeを使用する。スクリプトは隔離DB内に合成資産と変更計画を保存する。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-chgui005.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_chgui005_$(date +%s)_test"
qa_evidence=evidence/WP-P7-CHGUI-005/20261119-2049
for script in stack helpers capture; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3221/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3221 WEB_BASE_URL=http://127.0.0.1:3220 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
qa_next="$qa_tmp/buildroot/apps/web/.next"
rtk proxy mkdir -p "$qa_next/standalone/.next/static"
rtk proxy cp -R "$qa_next/static/." "$qa_next/standalone/.next/static/"
(
  cd "$qa_next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3220 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3221 WEB_BASE_URL=http://127.0.0.1:3220 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3220/login
rtk proxy node "$qa_tmp/capture.mjs" "$qa_tmp/results" 01
```
