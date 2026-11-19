# 依頼者ポータルと採用モックアップの比較

採用HTMLの `#portal`、`#report`、`#my-tickets`、`#request/…` をSOLVIの本番向けローカルビルドと同じChromeで表示した。PCは1440×900px、モバイルは375×812pxでタッチ入力をエミュレーションした。

| 画面 | PC | モバイル |
|---|---|---|
| トップ | [モックアップ](screens/1440-home-mock.png) / [SOLVI](screens/1440-home-solvi.png) | [モックアップ](screens/375-home-mock.png) / [SOLVI](screens/375-home-solvi.png) |
| 障害報告 | [モックアップ](screens/1440-report-mock.png) / [SOLVI](screens/1440-report-solvi.png) | [モックアップ](screens/375-report-mock.png) / [SOLVI](screens/375-report-solvi.png) |
| 問い合わせ一覧 | [モックアップ](screens/1440-list-mock.png) / [SOLVI](screens/1440-list-solvi.png) | [モックアップ](screens/375-list-mock.png) / [SOLVI](screens/375-list-solvi.png) |
| 詳細 | [モックアップ](screens/1440-detail-mock.png) / [SOLVI](screens/1440-detail-solvi.png) | [モックアップ](screens/375-detail-mock.png) / [SOLVI](screens/375-detail-solvi.png) |
| 受付完了 | [モックアップ](screens/1440-receipt-mock.png) / [送信直後のSOLVI](screens/light-1440-receipt.png) | [モックアップ](screens/375-receipt-mock.png) / [送信直後のSOLVI](screens/light-375-receipt.png) |

- 5画面・2幅で、見出しの左端、文字サイズと太さが一致した。トップでヘルプ検索ボタンと入力欄の下端を揃えた。ポータル共通ナビをモバイルで折り返し、PCでは行のホバー・フォーカス時の背景色がモックアップと同じ `#EEF2F7` になることを確認した。[計測](measurements.json) · [ポート3000](measurements-live.json) · [修正前のモバイル報告](screens/before-375-report.png)
- PCの報告フォームは幅784pxを上限として中央に置いた。詳細ではPCでやり取りの右側、モバイルでその上に対応状況を置いた。モバイルの戻るリンクは44pxの操作高さを確保した。アカウント、自分の資産・通知設定などのメニューは実際のロールと既存の機能に沿って表示した。
- 送信時のエラーから入力済み件名が残ること、受付案内にフォーカスが移ること、未解決・すべての切替とページ2への復帰を検証した。詳細から戻るリンクで元の一覧条件を保ったまま該当行に復帰し、行を強調した。添付、関連情報、期限と再開の入口も利用できる。

## 同じ受付番号での操作

隔離PostgreSQLと合成利用者を使用し、PCとモバイルで各1件を新規報告した。各ケースで依頼者が報告し、担当者が同じ受付番号のチケットを引き受け、対応を開始して公開返信した。依頼者が一覧から開き直して返信本文・進捗を確認し、追加情報を送信した。担当者画面でも追加内容を照合した。反対側の画面幅からも同じIDの返信と進捗を確認した。

- 依頼者のやり取りには担当者の内部メモが含まれない。別利用者のチケットは一覧に表示されず、詳細URLは404だった。
- ページ2に戻った後もページ番号とカーソルが一致した。テーマを切り替え、報告画面に移動しても選択が持続した。

[実操作と画面幅の測定](journey.json) · [モバイルの返信と対応状況](screens/375-detail-solvi-full.png)

## 検査

- 操作16条件、画面比較10条件、ロール別回帰11条件でaxe違反0件。グラデーション上の文字はaxeが判定を保留したため、背景の両端とのコントラストを実測した。最小5.10:1で、本文の基準4.5:1を満たす。[実測](contrast.json) · [ロール別回帰](smoke.json)
- 8種類の幅で4画面を測定し、ページ全体の横はみ出し0px。型、lint、ガバナンス、本番向けビルドとユニットに合格した。ユニットは4,899件合格、既存skip 26件、失敗0件。[ユニット集計](logs/unit.txt) · [ガバナンス](logs/governance.txt)

## 再現

[前段WPの再現手順](../../WP-P2-UIX-049/20261119-1944/README.md#再現手順)を使用する。スクリプトはこのフォルダーのものをコピーし、起動するWebを3270、APIを3271とする。テスト用のループバックPostgreSQLに未使用の `solvi_uix049_<UNIX時刻>_test` を作成する。

```zsh
qa_evidence=evidence/WP-P2-UIX-057/20261120-0832
for script in stack helpers capture compare contrast live-helpers; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_root/$script.mjs"
done
rtk proxy node "$qa_root/capture.mjs" "$qa_root/results"
rtk proxy node "$qa_root/compare.mjs" "$qa_root/comparison" after http://127.0.0.1:3270 http://127.0.0.1:3271
rtk proxy node "$qa_root/contrast.mjs" "$qa_root/contrast.json"
rtk proxy node "$qa_root/compare.mjs" "$qa_root/live" after
```
