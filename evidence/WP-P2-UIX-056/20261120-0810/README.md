# サービス管理と採用モックアップの比較

採用HTMLとSOLVIをChromeで比較した。PCは1440px、モバイルは375pxのタッチエミュレーションを使用した。下の画像は本番向けWebビルドと隔離PostgreSQL、合成アカウント・データで撮影した。

| 画面 | PC | モバイル |
|---|---|---|
| ナレッジ検索 | [モックアップ](screens/1440-knowledge-mock.png) / [SOLVI](screens/1440-knowledge-solvi.png) | [モックアップ](screens/375-knowledge-mock.png) / [SOLVI](screens/375-knowledge-solvi.png) |
| ナレッジ管理 | [モックアップ](screens/1440-knowledge-manage-mock.png) / [SOLVI](screens/1440-knowledge-manage-solvi.png) | [モックアップ](screens/375-knowledge-manage-mock.png) / [SOLVI](screens/375-knowledge-manage-solvi.png) |
| カタログ管理 | [モックアップの編集](screens/1440-catalog-manage-mock.png) / [SOLVIの管理一覧](screens/1440-catalog-manage-solvi.png) / [SOLVIの作成](screens/1440-catalog-new-solvi.png) | [モックアップの編集](screens/375-catalog-manage-mock.png) / [SOLVIの管理一覧](screens/375-catalog-manage-solvi.png) / [SOLVIの作成](screens/375-catalog-new-solvi.png) |
| 利用者のカタログ | [モックアップ](screens/1440-requester-catalog-mock.png) / [SOLVI](screens/1440-requester-catalog-solvi.png) | [モックアップ](screens/375-requester-catalog-mock.png) / [SOLVI](screens/375-requester-catalog-solvi.png) |
| 申請の状況 | [モックアップ](screens/1440-requester-requests-mock.png) / [SOLVI](screens/1440-requester-requests-solvi.png) | [モックアップ](screens/375-requester-requests-mock.png) / [SOLVI](screens/375-requester-requests-solvi.png) |
| 資産台帳 | [モックアップ](screens/1440-assets-mock.png) / [SOLVI](screens/1440-assets-solvi.png) | [モックアップ](screens/375-assets-mock.png) / [SOLVI](screens/375-assets-solvi.png) |
| CSV取込 | [モックアップ](screens/1440-import-new-mock.png) / [SOLVI](screens/1440-import-new-solvi.png) | [モックアップ](screens/375-import-new-mock.png) / [SOLVI](screens/375-import-new-solvi.png) |
| 変更管理 | [モックアップ](screens/1440-changes-mock.png) / [SOLVI](screens/1440-changes-solvi.png) | [モックアップ](screens/375-changes-mock.png) / [SOLVI](screens/375-changes-solvi.png) |
| 変更を計画 | [モックアップ](screens/1440-change-new-mock.png) / [SOLVI](screens/1440-change-new-solvi.png) | [モックアップ](screens/375-change-new-mock.png) / [SOLVI](screens/375-change-new-solvi.png) |

[修正前のナレッジ検索](screens/before-1440-knowledge.png) · [キーボードでフォーカスした行](screens/1440-knowledge-focused.png) · [本番向けビルドの計測](measurements.json) · [ポート3000の計測](measurements-live.json)

- ナレッジ検索と管理を、タイトルと公開範囲、版を持つ行リンクに揃えた。PC・モバイルで検索欄とボタンの下端を照合し、PCでホバーとフォーカスの背景色 `#F7F9FC` が参照と一致した。
- カタログ作成・編集はサービス情報、質問、承認を扱うフォームと既存の入力試験を並べた。申請一覧では状態と更新時刻を揃えた。CSV入力とガイド、変更の入力と対象資産はPCで2列、モバイルで1列になった。
- 組織のデータ、公開範囲、カタログ管理の検索・一覧と編集の分割、各フォームの既存項目を使用した。カタログ・申請は担当者には業務画面の枠、依頼者にはポータルの枠で表示される。モックアップの自動化はSOLVIではチケット・申請から既存の操作を使用する。

## 操作

- ナレッジでは、両幅で同じ記事を下書き、レビュー、組織内公開、担当者限定公開へ進めた。依頼者の検索と記事本文、一覧への復帰、0件、直接URLの拒否を確認した。[結果](knowledge.json) · [0件](screens/knowledge-zero-mobile.png)
- カタログは条件付き質問を設定し、経路をプレビューして公開した。同じ申請を依頼者と承認者で開き、PCは承認、モバイルは却下と理由を反映することを確認した。[結果](catalog.json)
- 資産・変更はCSVプレビューで不正行を照合し、正常行を確定して同じ資産から変更を作成した。承認・予定確定・実施開始・実施結果・PIRを記録し、モバイルでは失敗時のPIR絞り込みと記録後の解除を確認した。[結果](asset.json) · [エラー行](screens/asset-preview-mobile.png) · [実施後レビュー](screens/asset-review-mobile.png)

## 検査

- 本番向けビルドで15画面×2幅の見出しの大きさと太さを照合した。いずれもPC 32px、モバイル28px、ウェイト700。業務導線はライト・ダークの計64条件、入口と作成画面の比較はライトの30条件でaxeを実行し、違反・判定保留0件、ページ全体の横はみ出し0px。開発版ポート3000でも30条件の表示を確認した。
- 型検査、lint（`.claude/` の別ワークツリーを除外）、ユニット、ガバナンス、本番向けビルドが成功した。ユニット4,899件合格、既存skip 26件、失敗0件。

[ユニット集計](logs/unit.txt) · [ガバナンス](logs/governance.txt)

## 再現

リポジトリのルートで、ループバックPostgreSQLとポート3260、3261を使用する。ビルドと起動方法は[先行WPの手順](../../WP-P2-ADMUI-050/20261119-2112/README.md#再現)を使い、Webを3260、APIを3261、DB名を `solvi_knwui060_<UNIX時刻>_test` とする。`stack.mjs` はこのEvidenceのものを使用する。

```zsh
qa_evidence=evidence/WP-P2-UIX-056/20261120-0810
for script in stack compare live-helpers; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
for suite in knowledge catalog asset; do
  rtk proxy mkdir -p "$qa_tmp/$suite"
  rtk proxy cp "$qa_evidence/$suite-capture.mjs.txt" "$qa_tmp/$suite/capture.mjs"
  rtk proxy cp "$qa_evidence/$suite-helpers.mjs.txt" "$qa_tmp/$suite/helpers.mjs"
done

# 隔離環境の起動後に実行する
rtk proxy node "$qa_tmp/knowledge/capture.mjs" "$qa_tmp/results/knowledge" 01
rtk proxy node "$qa_tmp/catalog/capture.mjs" "$qa_tmp/results/catalog" 01
rtk proxy node "$qa_tmp/asset/capture.mjs" "$qa_tmp/results/asset" 01
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/comparison" after http://127.0.0.1:3260 http://127.0.0.1:3261
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/live" after
```
