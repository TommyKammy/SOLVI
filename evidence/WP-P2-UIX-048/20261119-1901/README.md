# WP-P2-UIX-048 実画面の検証

2026-11-19 JST。Chromeの認証済みセッションからSOLVIのWeb本番ビルドとローカルAPIを操作した。PostgreSQLは42件のMigrationを適用した隔離テストDB。29件の合成チケットを作成し、同じ受付番号 `INC-2026-000001` で6通りの返信と復帰を確認した。

| 確認 | 結果 |
|---|---|
| AC-1 本文寸法 | 320・375・600・601・1100・1101・1440・1920pxの各幅で、運営状況、業務受信箱、一覧、詳細の4画面を実測。指定の左右余白と最大枠1536pxが一致し、文書全体の横はみ出しは0px。狭い画面では表内だけ横スクロール可能。 |
| AC-2 返信と復帰 | 1440pxのEnterと375pxのタップで、3つの入口から同じチケットに返信。依頼者の権限でAPIを読み、各返信が1件ずつ表示されることを確認した。担当グループ、業務受信箱の検索・2ページ目、一覧の検索・複数の状態条件と、選んだ行のフォーカスを保持。未読から外れた場合は見出しに復帰し、Tabで一覧の操作を継続。 |
| AC-3 競合と戻り先 | 同じ返信コンテキストの再送はHTTP 409で、保存は1件。別の投稿が入った状態で返信を試みると入力を保持し、最新の内容を読み直してから保存可能。外部への戻り先はチケット一覧へフォールバック。 |
| AC-4 画面・アクセシビリティ | 1440px・375pxのライト／ダーク、4画面ずつのaxe計16スキャンで違反0件。横スクロール表でaxeが判定保留にした文字40要素は個別に計算し、最小5.96:1。PCのフォーカス位置とモバイルの44px以上の業務を開くボタンを確認。 |

- [ブラウザ検証結果](summary.json)
- [モバイル表の文字コントラスト補足](contrast.json)
- [PC・復帰した業務受信箱](screens/light-1440-inbox-return.png)
- [モバイル・復帰した業務受信箱](screens/light-375-inbox-return.png)
- [エビデンスの実行ログ](logs/)

## 再現手順

プロジェクトルートから実行する。PlaywrightはローカルのGoogle Chromeを使用する。スクリプトはループバックのPostgreSQLと `solvi_uix048_<数字>_test` のDBを要求する。DB名は未使用の名前を選ぶ。

```zsh
qa_root=$(mktemp -d /tmp/solvi-uix048.XXXXXX)
qa_evidence=evidence/WP-P2-UIX-048/20261119-1901
qa_database="solvi_uix048_$(date +%s)_test"
qa_repo="$PWD"
for script in stack helpers fixture capture contrast; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_root/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_root/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_root/stack.mjs" api "$qa_database" > "$qa_root/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused http://127.0.0.1:3183/readyz
rtk proxy node --env-file=.env "$qa_root/fixture.mjs" "$qa_database" "$qa_root/fixture.json"
rtk proxy mkdir -p "$qa_root/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_root/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_root/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_root/buildroot/package.json"
(
  cd "$qa_root/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3183 WEB_BASE_URL=http://127.0.0.1:3182 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
rtk proxy cp -R "$qa_root/buildroot/apps/web/.next/static" "$qa_root/buildroot/apps/web/.next/standalone/.next/static"
(
  cd "$qa_root/buildroot/apps/web/.next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3182 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3183 WEB_BASE_URL=http://127.0.0.1:3182 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_root/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3182/login
rtk proxy node "$qa_root/capture.mjs" "$qa_root/fixture.json" "$qa_root/results"
rtk proxy node "$qa_root/contrast.mjs" "$qa_root/results/contrast.json"
```

`capture.mjs` は隔離DBに返信と既読を書き込む。再試行時は新規DBでフィクスチャを作る。公開返信、既読記録、競合検知は既存のWeb・APIを通す。
