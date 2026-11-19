# WP-P2-RPT-051 レポートと監査ログの実操作

2026-11-19 JST。現行の42件のMigrationを適用した隔離PostgreSQLに合成データを作成し、SOLVI Webの本番ビルドとローカルAPIをGoogle Chromeで確認した。

| 画面幅 | 入力 | 受付・解決済み・未完了・解決期限超過 | 監査ログのページ送り |
|---|---|---|---|
| PC 1440px | キーボードのEnter | 4・1・3・1 | 25件 → 5件 → 25件 |
| モバイル幅375px | Chromeのタッチエミュレーション | 4・1・3・1 | 25件 → 5件 → 25件 |

- 担当者のメニューからレポートを開き、UTCの受付日と担当グループを指定した。集計のカードを切り替えると、対象チケットの一覧が件数と一致した。SLA停止中のチケットは未完了には表示され、解決期限超過の対象から外れた。期限超過・解決済みのチケット詳細から元の集計に戻り、フィルターと選択を保持し、期限超過の対象行にフォーカスが戻った。前日を指定すると0件になった。
- 組織管理者による公開、依頼者の申請、承認者の承認、組織管理者による役割の付与・取消とアクセスレビュー開始を既存APIで実行した。監査担当者は期間と種別を変更し、同じ申請の承認依頼・承認判断と、同じ役割の付与・取消を詳細から絞り込んだ。アクセスレビュー開始、期間変更による0件、逆順の日付の入力エラー、条件解除も確認した。
- 組織管理者は監査ログ画面で権限案内になり、監査担当者も担当者用レポートを開けなかった。監査APIは組織管理者・担当者・依頼者・承認者に403を返した。別組織では同じ記録を確認できることを照合したうえで、開始側の組織から一覧と詳細の双方で対象が返らないことを確認した。APIは監査ログの表示用フィールドのみを返し、閲覧成功は `audit.viewed` としてDBに残った。監査書込みが失敗した場合は結果を返さずロールバックすることをユニットテストで確認した。隔離DBで閲覧監査の書込みだけを一時的に失敗させ、両画面幅で0件の表示ではなく取得失敗と再読み込みの案内が出ることを確認した。
- 両画面幅でライト・ダークを含めて計16回のaxe検査を行い、違反・判定保留は0件、横方向のはみ出しは0pxだった。対象フォームでは日付、選択欄、実行ボタンの高さが揃い、PCでは上端が揃うことも確認した。

[操作・検査結果](summary.json) · [PCのレポート](screens/light-1440-report.png) · [モバイルのSLA別一覧](screens/light-375-sla-drilldown.png) · [PCの承認ログ](screens/light-1440-audit-approval.png) · [モバイルの権限変更ログ詳細](screens/light-375-audit-role-detail.png)

## 再現

リポジトリのルートから実行する。ループバックのポート3240と3241、PostgreSQL、Google Chromeを使用する。チケットの状態とSLA時計の設定だけを合成データの隔離DB内で行う。承認・役割変更・監査閲覧は既存の認証を使い、各APIを通る。再実行時は、新しい隔離DBを作成する。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-rpt051.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_rpt051_$(date +%s)_test"
qa_evidence=evidence/WP-P2-RPT-051/20261119-2138
for script in stack helpers fixtures capture audit-failure; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
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
)
qa_next="$qa_tmp/buildroot/apps/web/.next"
rtk proxy mkdir -p "$qa_next/standalone/.next/static"
rtk proxy cp -R "$qa_next/static/." "$qa_next/standalone/.next/static/"
(
  cd "$qa_next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3240 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3241 WEB_BASE_URL=http://127.0.0.1:3240 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3240/login
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/results" "$qa_database" 01
rtk proxy node --env-file=.env "$qa_tmp/audit-failure.mjs" "$qa_database"
```
