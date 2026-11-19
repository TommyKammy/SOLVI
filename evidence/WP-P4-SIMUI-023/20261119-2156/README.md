# WP-P4-SIMUI-023 AI支援プレビューから監査ログまでの実操作

2026-11-19 JST。42件のMigrationを適用した隔離PostgreSQLに合成アカウントと模擬カタログ申請を用意し、ローカルAPIとWebの本番ビルドをGoogle Chromeで確認した。

| 画面幅 | 入力 | チケット上の採用・承認・模擬実行・監査 | 別チケットでの見送り |
|---|---|---|---|
| PC 1440px | キーボードのEnter | 一連の操作を確認 | 判断の保持と導線の非表示を確認 |
| モバイル幅375px | Chromeのタッチエミュレーション | 一連の操作を確認 | 判断の保持と導線の非表示を確認 |

- 担当者はカタログから起票されたチケットのAI支援プレビューを開き、定型の確認手順と公開版・申請内容版を確認した。採用を保存して再読み込みし、同じチケットに結び付く既存の申請へ進んだ。採否を記録した時点では承認待ちの状態が維持された。
- 承認者は業務受信箱で同じ申請を開いて承認した。承認前は担当者による模擬実行APIを409で拒否し、承認者には模擬実行の操作が表示されなかった。承認後に担当者が模擬実行し、外部変更0件、証跡ID、元のチケットへの復帰を確認した。再送は同じ証跡を返し、DBでも1件であることを確認した。
- 監査担当者はAI支援から同じ申請に絞り、採用、承認、模擬実行のイベントを確認した。監査の関連チケットIDと証跡IDが結果画面と一致した。通常の担当者は監査APIで403となり、別組織の監査ログは対象が0件だった。提案の読取りと記録は他組織から404、非担当の承認者・監査担当者・依頼者には403。別版や同じ版で判断を反転する操作を拒否し、同じ判断の再送で採否イベントが増えないことも確認した。
- 合成環境で監査ロールを併せ持つスタッフとして、同一の完了済みチケットをPCとモバイル両方から開き直した。結果の証跡から同じ申請の監査ログへ移動し、一致するIDを確認した。検証後に合成アカウントの追加ロールを取り消した。
- ライト・ダークと両幅で計16回axeを実行し、違反・判定保留0件、横方向のはみ出し0pxだった。

[操作・検査結果](summary.json) · [PCのAI支援プレビュー](screens/light-1440-proposal.png) · [モバイルの模擬実行結果](screens/light-375-receipt.png) · [モバイルの監査詳細](screens/dark-375-shared-audit-receipt.png)

## 再現

リポジトリのルートから実行する。ループバックのポート3250と3251、PostgreSQL、Google Chromeを使用する。承認、採否、模擬実行、ロールの一時付与と取消は隔離環境で既存の認証を使って実行する。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-simui023.XXXXXX)
qa_repo="$PWD"
qa_database="solvi_simui023_$(date +%s)_test"
qa_evidence=evidence/WP-P4-SIMUI-023/20261119-2156
for script in stack helpers fixtures capture; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" prepare "$qa_database"
rtk proxy node --env-file=.env "$qa_tmp/stack.mjs" api "$qa_database" > "$qa_tmp/api.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3251/readyz
rtk proxy mkdir -p "$qa_tmp/buildroot/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/buildroot/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/buildroot/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/buildroot/package.json"
(
  cd "$qa_tmp/buildroot/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3251 WEB_BASE_URL=http://127.0.0.1:3250 \
    rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
)
qa_next="$qa_tmp/buildroot/apps/web/.next"
rtk proxy mkdir -p "$qa_next/standalone/.next/static"
rtk proxy cp -R "$qa_next/static/." "$qa_next/standalone/.next/static/"
(
  cd "$qa_next/standalone"
  NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3250 NEXT_TELEMETRY_DISABLED=1 API_BASE_URL=http://127.0.0.1:3251 WEB_BASE_URL=http://127.0.0.1:3250 S3_PUBLIC_ENDPOINT=http://127.0.0.1:9100 \
    rtk proxy node --env-file="$qa_repo/.env" server.js
) > "$qa_tmp/web.log" 2>&1 &
rtk proxy curl --fail --retry 10 --retry-connrefused -o /dev/null http://127.0.0.1:3250/login
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/results" "$qa_database" 02
```
