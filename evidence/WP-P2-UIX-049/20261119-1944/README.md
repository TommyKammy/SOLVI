# WP-P2-UIX-049 依頼者ポータルの実画面検証

2026-11-19 JST。隔離PostgreSQLへ既存Migration 42件を適用し、合成ユーザーでSOLVIのWeb本番ビルドとAPIを使用した。依頼者と担当者は別のChromeセッションを使った。

| 端末 | 受付番号 | 一連の操作 |
|---|---|---|
| PC 1440×900 | `INC-2026-000002` | 報告、受付番号確認、担当割当、対応開始、公開返信、依頼者による返信・対応状況確認 |
| モバイル 375×812 | `INC-2026-000003` | 報告、受付番号確認、担当割当、対応開始、公開返信、依頼者による返信・対応状況確認 |

- 各端末で役割をまたいでも同じチケットIDと受付番号が一致し、反対側の端末からも同じIDで返信本文を確認した。依頼者のAPI読み取りでは公開返信が1件あり、内部メモは含まれない。別利用者のチケットは一覧に出ず、詳細は404。
- 未入力の項目にはエラー表示が出て入力済みの件名を保持した。送信後は受付案内にフォーカスし、受付番号を表示した。
- 自分の問い合わせに戻ると表示条件が保持される。すべての問い合わせの2ページ目で、カーソルとページ番号を保持した。
- 8種類の画面幅と4画面の32測定で、左右の余白と幅上限が設計正本と一致した。文書全体の横はみ出しは0px。モバイルでは対応状況がやり取りより上に出る。
- ライト／ダーク、PC／モバイルでポータル・一覧・報告・詳細を計16回axe検査し、違反0件、判定保留0件。ポータルのテーマ設定は報告画面への遷移後も維持された。既存のロール別メニューとナレッジ検索の回帰検査も5ロールで通過した。

[実測とブラウザ操作の結果](summary.json) · [既存のポータル回帰](support-smoke.json) · [PCで見る返信と進捗](screens/light-1440-detail.png) · [モバイルで見る同じ返信と進捗](screens/light-375-detail.png) · [モバイルの受付画面](screens/light-375-receipt.png)

## 再現手順

作業ツリーのルートで実行する。ローカルのGoogle Chromeを使用し、ポート3190・3191を使用する。DB名は未使用を選ぶ。スクリプトはループバック接続および `solvi_uix049_<数字>_test` のDBに限定して準備・起動する。

```zsh
qa_root=$(mktemp -d /tmp/solvi-uix049.XXXXXX)
qa_evidence=evidence/WP-P2-UIX-049/20261119-1944
qa_database="solvi_uix049_$(date +%s)_test"
qa_repo="$PWD"
for script in stack helpers capture; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_root/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_root/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_root/stack.mjs" api "$qa_database" > "$qa_root/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3191/readyz
rtk proxy mkdir -p "$qa_root/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_root/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_root/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_root/buildroot/package.json"
(
  cd "$qa_root/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3191 WEB_BASE_URL=http://127.0.0.1:3190 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
rtk proxy cp -R "$qa_root/buildroot/apps/web/.next/static" "$qa_root/buildroot/apps/web/.next/standalone/.next/static"
(
  cd "$qa_root/buildroot/apps/web/.next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3190 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3191 WEB_BASE_URL=http://127.0.0.1:3190 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_root/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3190/login
rtk proxy node "$qa_root/capture.mjs" "$qa_root/results"
```

`capture.mjs` は隔離DBに新規チケットやコメントを保存する。再実行は新規DBから開始する。ロール別回帰は `SOLVI_UI_BASE=http://127.0.0.1:3190`、`SOLVI_UI_BROWSER_CHANNEL=chrome`、`SOLVI_UI_OUT` を隔離結果フォルダーに設定し、`SOLVI_SMOKE_PASSWORD` に合成シードの値を設定して `rtk proxy node tools/ui_support_portal_check.mjs` を実行する。証跡には資格情報を含めない。
