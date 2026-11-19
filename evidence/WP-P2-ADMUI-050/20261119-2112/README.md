# WP-P2-ADMUI-050 管理画面の実操作

2026-11-19 JST。既存Migration 42件を適用した隔離PostgreSQL、SOLVIのWeb本番ビルドとAPI、Google Chromeを使用した。組織管理者と監査担当者は別々の合成アカウントで動作を確認した。

| 操作の画面幅 | 入力 | アクセスレビュー |
|---|---|---|
| PC 1440px | Enter | QA-1440-01 |
| モバイル幅375px | タップ | QA-375-01 |

- 組織管理者は管理ホームから利用者・部署・担当グループ、承認ルール、通知、アクセスレビューを開いた。部署を作成し、担当者の組織プロフィールに主部署と役職を保存した。担当グループを作って同じ担当者を追加した。
- 固定承認者を指定した新しいルールを保存し、合成依頼者で経路をプレビューした。失敗通知を絞り込み、再試行の予約が1件だけ登録されたことを隔離DBで確認した。
- アクセスレビューを開始し、対象の役割を維持する判断と理由を保存して完了した。監査担当者は同じ進行中のレビューと完了後の判断を読み、管理者用のフォームは表示されなかった。管理ホームから許可済みの管理機能だけを開けた。
- 監査担当者で利用者・部署・担当グループ一覧と詳細、承認ルール、通知の直接URLを開くと権限案内が出た。管理ホームへ戻り、APIの許否も照合した。
- ブラウザが持つテストセッションのアイドル期限を隔離DB内で過去にし、再アクセスで期限切れを再現した。同じ管理者での再ログイン後は、利用者の選択と検索語を保持した。監査担当者で入り直した場合は、組織選択を経て元URLに戻った時点で権限が再判定され、管理ホームへ戻れた。
- 10画面をPC・モバイル幅とライト・ダークで計40回axe検査した。違反・判定保留は0件、ページの横はみ出しは0pxだった。PCの利用者一覧は全列を表示できた。

[レコードID・検査詳細](summary.json) · [PCの管理ホーム](screens/light-1440-admin-home.png) · [モバイルの閲覧者画面](screens/light-375-review-viewer.png) · [モバイルの権限案内](screens/light-375-forbidden.png) · [モバイルの期限切れ](screens/dark-375-expired.png)

## 再現

リポジトリのルートから実行する。ポート3230と3231、ループバックのPostgreSQL、Google Chromeを使用する。通知の元データとセッション期限の操作は、合成ユーザーを用意した隔離DB内で行う。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-admui050.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_admui050_$(date +%s)_test"
qa_evidence=evidence/WP-P2-ADMUI-050/20261119-2112
for script in stack helpers fixtures capture; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3231/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3231 WEB_BASE_URL=http://127.0.0.1:3230 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
qa_next="$qa_tmp/buildroot/apps/web/.next"
rtk proxy mkdir -p "$qa_next/standalone/.next/static"
rtk proxy cp -R "$qa_next/static/." "$qa_next/standalone/.next/static/"
(
  cd "$qa_next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3230 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3231 WEB_BASE_URL=http://127.0.0.1:3230 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3230/login
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/results" "$qa_database" 01
```
