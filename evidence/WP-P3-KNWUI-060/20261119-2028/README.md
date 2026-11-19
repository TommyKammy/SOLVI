# WP-P3-KNWUI-060 実画面の検証

2026-11-19 JST。既存のMigration 42件を適用した隔離PostgreSQLで、SOLVIのWeb本番ビルドとAPIを使用した。担当者・組織管理者・依頼者は別々のChromeセッションで、合成データを操作した。

| 操作を開始した画面幅 | 合成記事ID | 組織内で公開 | 担当者限定で再公開 |
|---|---|---|---|
| 1440px・Enter | `01a1f390-dd78-7000-a295-b3910b31d438` | 版3 | 版6 |
| 375px・タップ | `01a1f390-fbdc-7000-ace5-716670d15c05` | 版3 | 版6 |

- 各記事について、担当者が下書き（版1）を保存してレビュー（版2）へ送った。未保存の変更があるとレビュー送信が無効になり、公開操作は組織管理者の画面に表示された。組織管理者はレビュー対象の本文と閲覧範囲を確認して公開（版3）した。
- 依頼者はポータルから検索し、タイトル・本文・版3を確認した。一覧へ戻っても検索語を保持した。同じ記事の作業版を担当者限定に変更して保存（版4）し、レビュー（版5）へ送っている間は、依頼者は旧公開版を読み続けられた。
- 担当者限定で再公開（版6）すると、担当者は検索から同じIDの新しい本文を読めた。依頼者の検索は0件になり、直接URLと管理表示パラメーター付きURLはいずれも404になった。管理用APIも依頼者には403を返した。各記事について反対側の画面幅で組織内公開・担当者限定公開・依頼者の0件と404を照合した。
- 別の検索語でも0件を表示した。検索語の再入力へフォーカスでき、条件を解除できた。不正な取得位置では専用エラーを表示し、検索語を保ったまま先頭の結果へ戻れた。
- 作成・レビュー・検索・組織内公開の詳細・担当者限定の詳細・0件を、1440px／375px・ライト／ダークで計24回axe検査した。違反・判定保留は0件で、文書の横はみ出しは0pxだった。

[記事ID・版・axeの結果](summary.json) · [PCの作成](screens/light-1440-author.png) · [モバイルのレビュー](screens/light-375-review.png) · [モバイルの公開記事](screens/light-375-public-article.png) · [モバイルの0件](screens/dark-375-zero.png)

## 再現

リポジトリのルートから実行する。ポート3210と3211、ループバックのPostgreSQL、Google Chromeを使用する。スクリプトは隔離DBで合成記事を作成する。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-knwui060.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_knwui060_$(date +%s)_test"
qa_evidence=evidence/WP-P3-KNWUI-060/20261119-2028
for script in stack helpers capture; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3211/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3211 WEB_BASE_URL=http://127.0.0.1:3210 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
qa_next="$qa_tmp/buildroot/apps/web/.next"
rtk proxy mkdir -p "$qa_next/standalone/.next/static"
rtk proxy cp -R "$qa_next/static/." "$qa_next/standalone/.next/static/"
(
  cd "$qa_next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3210 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3211 WEB_BASE_URL=http://127.0.0.1:3210 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3210/login
rtk proxy node "$qa_tmp/capture.mjs" "$qa_tmp/results" 01
```
