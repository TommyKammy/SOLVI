# レポート表示の比較

採用済みの操作式HTML `#reports` とSOLVIを同じChromeで比較した。確認対象は1440pxのマウス・キーボードと375pxのタッチエミュレーションのライト・ダーク。業務操作には隔離PostgreSQLと合成チケットを用いた。

## 受付件数カード

| 項目 | モックアップとSOLVIの実測 |
|---|---|
| ライトの通常時 | 白背景 `#FFFFFF`、枠 `#DFE5ED` |
| ライトのホバー・選択時 | 淡い青の背景 `#E6EEFB`、青い枠 `#2459A9` |
| ダークのホバー・選択時 | 背景 `#283E60`、枠 `#AACAFF` |
| PC | 4列、受付件数カード高113.39px |
| モバイル | 2列、受付件数カード高103.73px |

ホバーを外すと通常色に戻り、選択済みのカードには青い枠と背景が残る。キーボードのフォーカスは青い枠・背景に加えアウトラインで分かる。カード全体が「対象チケット →」へのリンクで、選択時に一覧の見出しへフォーカスが移る。

[修正前のホバー](screens/before-1440-hover.png) · [モックアップのホバー](screens/light-1440-mock-hover.png) · [修正後のホバー](screens/light-1440-report-hover.png) · [ダーク](screens/dark-1440-report-hover.png)

## 集計と対象チケット

- 初期画面は「グループ別の対応状況」。実際の受付、解決済み、期限超過を表示し、グループ内の件数リンクで対象を開ける。最大受付件数の行を基準に横棒を表示する。
- 選択後の表にはチケット、担当グループ、状態、受付日、解決期限のSLA状況を表示する。詳細から戻ると、日付・グループ・集計と元の行に復帰する。「グループ別の集計に戻る」でも日付・グループを保持する。
- 同じ合成グループ・チケットで両幅と両テーマを確認した。受付4件、解決済み1件、未解決3件、期限超過1件。SLA停止中は未解決に含まれ、期限超過から除外された。前日の0件、逆転した日付範囲の入力エラーと値の保持、監査担当者によるレポート表示の拒否も確認した。
- 日付の入力とUTCの範囲指定を維持した。対象表は、既存のページ送りに合わせて受付の新しい順を使う。SLAは残り時間・超過・停止状態を既存データに基づいて表示する。

[PCの集計](screens/light-1440-report.png) · [モバイルの集計](screens/light-375-report.png) · [モバイルの対象表](screens/light-375-received.png) · [測定値と検証結果](summary.json)

## 検査

- 両幅・両テーマで、集計、受付件数の対象表、期限超過の対象表、空の結果にaxeを実行した。計16条件で違反0件、判定保留0件、ページの横はみ出し0px。狭い画面で対象表だけを横スクロールできた。
- 型検査、lint（`.claude/` の別ワークツリーを除外）、ガバナンス、本番向けビルドが成功。ユニット検査は4,899件合格、既存skip 26件、失敗0件。
- ポート3000で通常時とホバー時の色、カードの高さ、初期集計と2つの日付入力を確認した。[ポート3000の計測](logs/live-3000.txt)

## 再現

リポジトリのルートで、ローカルの合成シードとループバックの隔離DBを使用する。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-rpt054.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_rpt051_$(date +%s)_test"
qa_evidence=evidence/WP-P2-UIX-054/20261120-0657
qa_base=evidence/WP-P2-RPT-051/20261119-2138
for piece in stack helpers fixtures; do
  rtk proxy cp "$qa_base/$piece.mjs.txt" "$qa_tmp/$piece.mjs"
done
rtk proxy cp "$qa_evidence/capture.mjs.txt" "$qa_tmp/capture.mjs"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3241/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3241 WEB_BASE_URL=http://127.0.0.1:3240 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
  rtk proxy mkdir -p .next/standalone/.next/static
  rtk proxy cp -R .next/static/. .next/standalone/.next/static/
)
(
  cd "$qa_tmp/buildroot/apps/web/.next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3240 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3241 WEB_BASE_URL=http://127.0.0.1:3240 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3240/login
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/results" "$qa_database" 01
```
