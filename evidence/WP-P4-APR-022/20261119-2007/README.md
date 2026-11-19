# WP-P4-APR-022 実画面の検証

2026-11-19 JST。既存のMigration 42件を適用した隔離PostgreSQLで、SOLVIのWeb本番ビルドとAPIを使用。管理者・依頼者・承認者は別のChromeセッションにログインし、合成データで操作した。

| 画面幅 | 申請番号 | 判断 | 条件付きの「返却場所」 |
|---|---|---|---|
| 1440px | REQ-2026-000001 | 承認 | 入力後に条件を外し、保存値から除外されたことを確認 |
| 375px | REQ-2026-000002 | 理由付き却下 | 表示条件を満たし、回答が申請内容に保存されたことを確認 |

- 各端末の管理者が承認ルールを作成し、依頼者を選んで経路を確認した。選択質問を元に条件付きの必須質問を設定し、保存した下書きで両分岐と必須エラーを試した。プレビュー中のPOSTは0件。公開前のサービスは依頼者のカタログから取得できず、公開後の版は試した保存版と一致した。
- 依頼者は公開版のフォームと承認経路を確認して申請し、受付番号を受け取った。承認者は業務受信箱から同じ番号を開き、判断理由を記録した。判断後も申請時のスナップショットハッシュは一致した。
- 依頼者は「自分の申請」を開いて結果と理由を読み、自分の画面に承認操作が出ないことを確認した。両申請を反対側の端末でも開き、同じID・申請番号・判断・理由を確認した。
- ルール管理、下書き、公開フォーム、承認者の判断、依頼者の結果を、1440px／375px・ライト／ダークで計20回axe検査した。違反と判定保留は0件、文書全体の横はみ出しは0pxだった。

[経路と検査の結果](summary.json) · [モバイルの判断画面](screens/light-375-decision.png) · [PCで見る結果](screens/light-1440-outcome.png) · [同じ申請のモバイル画面](screens/light-375-outcome.png)

## 再現

ルートから実行する。ループバックのPostgreSQLに、未使用の `solvi_apr022_<数字>_test` を作る。ポート3200・3201が空いており、Google Chromeが利用できる状態で実行する。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-apr022.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_apr022_$(date +%s)_test"
qa_evidence=evidence/WP-P4-APR-022/20261119-2007
for script in stack helpers capture; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3201/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3201 WEB_BASE_URL=http://127.0.0.1:3200 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
rtk proxy cp -R "$qa_tmp/buildroot/apps/web/.next/static" "$qa_tmp/buildroot/apps/web/.next/standalone/.next/static"
(
  cd "$qa_tmp/buildroot/apps/web/.next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3200 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3201 WEB_BASE_URL=http://127.0.0.1:3200 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3200/login
rtk proxy node "$qa_tmp/capture.mjs" "$qa_tmp/results"
```

スクリプトはテスト組織の承認ルールの有効化と、合成サービス・申請・承認の保存を行う。再実行は新しい隔離DBから開始する。
