# SOLVI 第9段階の横断レビュー

Chromeの1440pxでキーボード操作、375pxでタッチ操作を実行した。各段階で合成データの隔離PostgreSQLと本番向けWebビルドを使った。担当者、依頼者、組織管理者、承認者、監査担当者・閲覧者は実際のロールで別のブラウザーコンテキストにログインした。

## 操作結果

| 段階 | PC・モバイルで確認した操作 | 実測結果 |
|---|---|---|
| 1 担当者 | 運営状況・業務受信箱・チケット一覧から同じチケットを開き、公開返信して元の絞り込み・ページ・フォーカスへ復帰。未読条件から外れた場合は一覧見出しへ復帰 | [01](results/01.json) |
| 2 依頼者 | 障害を報告して受付番号を取得。担当者が引き受け・対応開始・返信し、依頼者が同じチケットの進捗と公開返信を確認。依頼者の追加連絡が担当者側に表示され、内部メモは依頼者側に表示されない | [02](results/02.json) |
| 3 カタログと承認 | 管理者が質問・分岐・承認ルールを設定し、プレビューした版を公開。依頼者が申請、承認者が判断し、同じ申請を依頼者が再表示。PCは承認、モバイルは理由付き却下 | [03](results/03.json) |
| 4 ナレッジ | 同じ記事を下書き・レビュー・公開し、依頼者が検索・閲覧。担当者向けに再公開すると依頼者の検索は0件、直接URLは404。担当者には新版が表示される | [04](results/04.json) |
| 5 資産と変更 | CSVの正常行とエラー行をプレビューし、正常行だけ取り込む。登録した資産で変更計画を作り、指名承認者の承認、実施結果の記録、実施後レビューまで進めた | [05](results/05.json) |
| 6 管理 | 利用者、部署、担当グループ、承認ルール、通知、アクセスレビューを操作。監査担当者の閲覧のみ表示、閲覧者の権限外表示と、再ログイン後の復帰・権限の再確認 | [06](results/06.json) |
| 7 レポートと監査 | SLA・対応件数の集計から対象チケットへ移動。承認・権限変更の監査履歴を絞り込み、詳細を確認 | [07](results/07.json) |
| 8 AI支援と自動化 | チケット上で提案を採用、別の提案を見送り。別セッションの承認者が判断した後に、担当者が同じ申請を模擬実行し、結果の証跡と監査ログを確認。外部変更は0件 | [08](results/08.json) |

## 表示の比較と修正

- チケット一覧の名称を見出し・メニュー・戻り先で統一した。モバイルでは件名の操作高を44px以上とし、表の初期表示範囲に収めた。一覧と受信箱の番号に行見出しを付け、表の横スクロールを表内に収めた。
- 受信箱は検索を全幅、種類と更新状態を同じ行に置き、352px以下では1列にした。PCでは絞り込みボタンと入力欄の下端を揃え、Tabの移動を見た目の順序に合わせた。
- モバイルのチケット詳細は件名の下に「返信する」「関連付け」「AI支援」の操作を並べた。ナレッジの検索欄とボタンは同じ行にし、管理ホームは分類ごとにパネルにまとめた。
- 左メニューで現在地が画面外にある場合は、メニュー内だけをスクロールする。ポータルの障害報告を問い合わせ一覧の現在地として表示していた状態を修正し、Escでメニューを閉じて開くボタンへフォーカスを戻せるようにした。

[修正前の表示計測](results/before.json) · [修正後の表示計測](results/review.json) · [共通寸法とaxeの詳細](results/visual.json)

チケット一覧の件名リンクは375pxで高16pxから44pxになり、初期表示範囲に収まった。PCとモバイルで管理ホームの現在地をメニュー内に表示でき、本文の縦スクロールは0pxだった。業務受信箱は両幅で種類と更新状態のセレクトを揃え、絞り込みと解除を同じ行に置いた。ナレッジの検索とボタンは下端を揃え、条件解除を次の行に置いた。

[モバイルのチケット一覧 修正前](screens/before-review-queue-375.png) / [修正後](screens/review-queue-375.png) · [PCの現在地 修正前](screens/before-review-current-navigation-1440.png) / [修正後](screens/review-current-navigation-1440.png)

| 比較対象 | モックアップ PC / モバイル | 実画面 PC / モバイル |
|---|---|---|
| 業務受信箱 | [PC](screens/reference-inbox-1440.png) / [モバイル](screens/reference-inbox-375.png) | [PC](screens/live-light-1440-inbox.png) / [モバイル](screens/live-light-375-inbox.png) |
| 障害報告 | [PC](screens/reference-portal-report-1440.png) / [モバイル](screens/reference-portal-report-375.png) | [PC](screens/live-light-1440-portal-report.png) / [モバイル](screens/live-light-375-portal-report.png) |
| カタログ編集 | [PC](screens/reference-catalog-manage-1440.png) / [モバイル](screens/reference-catalog-manage-375.png) | [PC](screens/actual-1440-catalog-draft.png) / [モバイル](screens/actual-375-catalog-draft.png) |
| ナレッジ検索 | [PC](screens/reference-knowledge-1440.png) / [モバイル](screens/reference-knowledge-375.png) | [PC](screens/live-light-1440-knowledge.png) / [モバイル](screens/live-light-375-knowledge.png) |
| 資産台帳 | [PC](screens/reference-assets-1440.png) / [モバイル](screens/reference-assets-375.png) | [PC](screens/live-light-1440-assets.png) / [モバイル](screens/live-light-375-assets.png) |
| 管理ホーム | [PC](screens/reference-admin-1440.png) / [モバイル](screens/reference-admin-375.png) | [PC](screens/live-light-1440-admin.png) / [モバイル](screens/live-light-375-admin.png) |
| レポート | [PC](screens/reference-reports-1440.png) / [モバイル](screens/reference-reports-375.png) | [PC](screens/live-light-1440-reports.png) / [モバイル](screens/live-light-375-reports.png) |
| AI支援 | [PC](screens/reference-assistance-1440.png) / [モバイル](screens/reference-assistance-375.png) | [PC](screens/live-light-1440-assistance.png) / [モバイル](screens/live-light-375-assistance.png) |

実画面では役割に応じた操作と実データを表示する。カタログ管理はサービスを一覧から選び、編集・プレビューに進む。資産台帳には実データを絞り込む条件が加わる。レポートの期間はUTCの日付を指定し、チケットの時刻はJSTで表示する。AI支援の結果は対象申請の証跡に紐づく。モバイルの依頼者用ナビゲーションはメニューを開いて使う。

## 検証の集計

- ライト・ダーク計252条件のaxeは自動検出違反0件。モバイルの横スクロール表とポータル見出しのグラデーションで、計11条件のコントラストが自動判定保留になった。別途測った表のテキスト24箇所は最小5.95:1、ポータル見出しはグラデーション端点でライト13.57:1、ダーク9.59:1だった。[集計](results/summary.json) · [表の測定](results/mobile-table-contrast.json)
- 運営状況の書体・太さ・左右余白・上部バーに加え、13画面の見出しサイズを各幅で参照と照合した。320pxでも運営状況・受信箱・レポートのページ横はみ出しは0px。WebKitの375pxでは10画面の表示と、一覧から詳細へのタップ・一覧復帰を確認した。モバイルの検証はエミュレーションで実施した。
- ポート3000で両幅の受信箱、チケット一覧、管理ホームの現在地を確認。型検査・lint（`.claude/` の別ワークツリーを除外）・ガバナンス検査・本番向けビルドが成功した。ユニットは4,897件合格、既存skip 26件、失敗0件。[ポート3000の計測](logs/live-3000.txt) · [ユニット](logs/unit.json)

## 再現

リポジトリのルートで、既存依存とローカル合成シードを使う。ランナーは段階ごとに隔離DBを作り、ループバックの3182〜3261の指定ポートにAPIとWebを起動して終了時に停止する。PostgreSQLロールの初期化を含むMigrationは直列、ブラウザー検証は最大3並列。再実行には新規の一時ディレクトリを使う。

```zsh
qa_tmp=$(mktemp -d /tmp/solvi-stage9.XXXXXX)
qa_repo="$PWD"
qa_evidence=evidence/WP-P2-UIX-053/20261119-2300
rtk proxy cp "$qa_evidence/run.py" "$qa_tmp/run.py"
rtk proxy cp -R "$qa_evidence/overrides" "$qa_tmp/overrides"
rtk proxy mkdir -p "$qa_tmp/fixed/apps/web"
rtk proxy rsync -a --exclude .next --exclude node_modules --exclude tsconfig.tsbuildinfo apps/web/ "$qa_tmp/fixed/apps/web/"
rtk proxy ln -s "$qa_repo/node_modules" "$qa_tmp/fixed/node_modules"
rtk proxy ln -s "$qa_repo/package.json" "$qa_tmp/fixed/package.json"
(
  cd "$qa_tmp/fixed/apps/web"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 rtk proxy node --env-file="$qa_repo/.env" "$qa_repo/node_modules/next/dist/bin/next" build
  rtk proxy mkdir -p .next/standalone/.next/static
  rtk proxy cp -R .next/static/. .next/standalone/.next/static/
)
rtk proxy python3 "$qa_tmp/run.py" fixed release
```

検証を限定する場合は末尾に `01`〜`08` または `visual` を指定する。以前の段階のスクリプトを再利用し、変更されたラベル・操作の特定と追加連絡の検証は同梱の `overrides/` に記録した。

上記の `release` を実行した環境で、ポート3000・3001の合成ログインが使える場合は、`rtk proxy cp "$qa_evidence/live.mjs.txt" "$qa_tmp/live.mjs"` に続けて `rtk proxy node "$qa_tmp/live.mjs"` を実行すると開発サーバー側の表示を再計測できる。
