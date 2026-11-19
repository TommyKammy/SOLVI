# WP-P2-UIX-052 採用したモックアップとSOLVIの表示比較

隔離PostgreSQLに既存Migrationを適用し、合成アカウントとチケット・申請・記事・資産・変更を既存APIで準備した。Google Chromeで参照HTMLとWebの本番ビルドを開いた。375pxと320pxはタッチエミュレーションを使用した。

## 表示の照合

| 運営状況で測った項目 | PC 1440px | モバイル幅375px |
|---|---:|---:|
| 見出しの大きさ・行高 | 32px・44.8px | 28px・39.2px |
| 見出しの左端・上端（画面原点） | 256px・98px | 20px・88px |
| 本文の大きさ・行高 | 14px・23.1px | 14px・23.1px |
| 上部バーの高さ | 64px | 64px |
| 本文左右の余白 | 32px | 20px |
| 左サイドバー | 224px | メニューから開閉 |

表の値は同じブラウザでモックアップと本体が一致した。運営状況の見出しに使われた書体はChromeの描画情報で両方とも Hiragino Sans W7。PCの業務列は今日の対応・自分の担当、状況列はグループ・承認待ち・通知。モバイルでは1列に折り返す。

[PCのモックアップ](screens/mock-light-1440-overview.png) · [PCのSOLVI](screens/live-light-1440-overview.png) · [モバイルのモックアップ](screens/mock-light-375-overview.png) · [モバイルのSOLVI](screens/live-light-375-overview.png)

## 業務画面と操作

- 業務受信箱で件数、絞り込み、一覧の順を確認。上部の検索、運営状況からチケットを開いて公開返信、元の一覧とフォーカスへの復帰、業務受信箱から詳細と一覧への往復を実セッションで確認。依頼者は同じチケットで返信を読み、ポータルから障害報告と公開ナレッジの記事へ進んだ。
- チケット・ポータル、カタログ・承認、ナレッジ、資産・CSV取込・変更、管理、レポートと監査、AI支援と模擬実行を検証した。両幅でライト32画面とダーク10画面を開き、横方向のページはみ出しとaxeを計84条件で確認した。アクセスレビューと監査は監査担当者、申請承認は承認者で開いた。別途13画面の見出しサイズを各幅でモックアップと照合した。
- axeの自動検出違反は0件。ポータル見出しのグラデーション背景とモバイルの横スクロール表の一部はコントラストの自動判定保留。ポータル見出しにはグラデーション両端の配色で4.5:1以上を確認するユニット検査も適用した。
- 実画面のメニュー、フォーム項目、操作の確認、エラー・進捗、日時と件数は、ログイン中のロールや業務データによってモックアップのサンプル表示と異なる。
- 稼働中のポート3000で、PCとモバイル幅の業務受信箱の文字・余白と、運営状況への遷移と列構成を再計測した。

[測定値・各画面のaxe結果](summary.json) · [ポート3000の実測](logs/live-3000.txt)

[受信箱 モックアップ](screens/mock-light-1440-inbox.png) · [受信箱 SOLVI](screens/live-light-1440-inbox.png) · [ポータル モバイルのモックアップ](screens/mock-light-375-portal.png) · [ポータル モバイルのSOLVI](screens/live-light-375-portal.png)

## 再現

リポジトリのルートで実行する。隔離DBとループバックのポート3260・3261を使う。各書込みは合成データ専用のAPIで行う。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-uix052.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_uix052_$(date +%s)_test"
qa_evidence=evidence/WP-P2-UIX-052/20261119-2233
for script in stack helpers fixtures capture live; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3261/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3261 WEB_BASE_URL=http://127.0.0.1:3260 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
qa_next="$qa_tmp/buildroot/apps/web/.next"
rtk proxy mkdir -p "$qa_next/standalone/.next/static"
rtk proxy cp -R "$qa_next/static/." "$qa_next/standalone/.next/static/"
(
  cd "$qa_next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3260 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3261 WEB_BASE_URL=http://127.0.0.1:3260 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3260/login
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/results" "$qa_database" 01
```

ポート3000と3001の開発サーバーで合成ログインが使える場合、`rtk proxy node "$qa_tmp/live.mjs"` で稼働画面の寸法を確認できる。
