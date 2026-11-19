# 管理画面と採用モックアップの比較

採用HTMLの `#admin` 配下とSOLVIを同じChromeで比較した。PCは1440pxでマウス・キーボード、モバイルは375pxでタッチエミュレーションを使用した。業務操作は隔離PostgreSQLと合成データで、本番向けWebビルドを使って確認した。

| 画面 | PC | モバイル |
|---|---|---|
| 管理ホーム | [モックアップ](screens/mock-1440-admin.png) / [SOLVI](screens/after-1440-admin.png) | [モックアップ](screens/mock-375-admin.png) / [SOLVI](screens/after-375-admin.png) |
| 利用者管理 | [モックアップ](screens/mock-1440-users.png) / [SOLVI](screens/after-1440-users.png) | [モックアップ](screens/mock-375-users.png) / [SOLVI](screens/after-375-users.png) |
| 部署管理 | [モックアップ](screens/mock-1440-departments.png) / [SOLVI](screens/after-1440-departments.png) | [モックアップ](screens/mock-375-departments.png) / [SOLVI](screens/after-375-departments.png) |
| 担当グループ | [モックアップ](screens/mock-1440-groups.png) / [SOLVI](screens/after-1440-groups.png) | [モックアップ](screens/mock-375-groups.png) / [SOLVI](screens/after-375-groups.png) |
| 承認ルール | [モックアップ](screens/mock-1440-approvals.png) / [SOLVI](screens/after-1440-approvals.png) | [モックアップ](screens/mock-375-approvals.png) / [SOLVI](screens/after-375-approvals.png) |
| 通知状況 | [モックアップ](screens/mock-1440-notifications.png) / [SOLVI](screens/after-1440-notifications.png) | [モックアップ](screens/mock-375-notifications.png) / [SOLVI](screens/after-375-notifications.png) |
| アクセスレビュー | [モックアップ](screens/mock-1440-access-review.png) / [SOLVI](screens/after-1440-access-review.png) | [モックアップ](screens/mock-375-access-review.png) / [SOLVI](screens/after-375-access-review.png) |

- 全7画面で見出しの大きさはPC 32px・モバイル28px、左端はPC 256px・モバイル20pxでモックアップと一致した。管理ホームはPC 2列・モバイル1列。ホームの行はホバー中に `#E6EEFB` になり、ポインターを離すと通常色に戻った。配下の6画面で「管理機能」ナビゲーションの現在地を照合した。[修正前の管理ホーム](screens/before-1440-admin.png) · [モックアップのホバー](screens/mock-1440-admin-hover.png) · [SOLVIのホバー](screens/after-1440-admin-hover.png) · [計測値](geometry.json) · [開発版ポート3000の計測値](geometry-live.json)
- 利用者、部署、担当グループ、承認ルール、通知の詳細をPCでは一覧の右側、モバイルでは一覧の下に表示した。通知は行の件名から詳細を開き、閉じると元のボタンにフォーカスが戻る。通知の内部IDが画面のHTMLに含まれないことも検査した。[PCの通知詳細](screens/light-1440-notification-detail.png) · [モバイルの通知詳細](screens/light-375-notification-detail.png)
- 両幅で、利用者の検索と組織プロフィール保存、部署作成、担当グループの作成・メンバー追加、承認ルール保存と経路プレビュー、失敗通知の絞り込みと再試行の受付、アクセスレビューの開始・判断・完了を確認した。通知は隔離DBに再試行予約が1件入ったことを照合した。
- 管理者と監査担当者は別の実セッションで操作した。監査担当者はアクセスレビューを閲覧でき、編集フォームは組織管理者に表示された。権限外のURLから管理ホームに戻り、セッション失効から再ログインすると利用者の検索と選択に復帰した。別ロールで再ログインした場合は復帰先で権限を再判定した。[閲覧](screens/light-375-review-viewer.png) · [権限案内](screens/light-375-forbidden.png) · [セッション失効](screens/dark-375-expired.png)
- SOLVIでは実際の組織名とロール、既存の操作フォーム、権限で許可されたタブを表示する。「担当グループの管理」の見出しと、管理ホームの「カタログ管理」「資産CSV」の導線は既存の文言と構成を使用した。
- ライト・ダークの計44条件でaxe違反0件、判定保留0件、ページ全体の横はみ出し0px。型検査、lint（`.claude/` の別ワークツリーを除外）、ユニット、ガバナンス、本番向けビルドも成功した。[操作とaxeの結果](summary.json) · [ユニット集計](logs/unit.txt) · [ガバナンス](logs/governance.txt)

## 再現

[前段WPの手順](../../WP-P2-ADMUI-050/20261119-2112/README.md#再現)に従って隔離環境を開始し、テスト起動前に以下のスクリプトを配置する。リポジトリのルートで実行する。

```zsh
qa_evidence=evidence/WP-P2-UIX-055/20261120-0741
for script in capture compare live-helpers; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_tmp/$script.mjs"
done
rtk proxy node --env-file=.env "$qa_tmp/capture.mjs" "$qa_tmp/results" "$qa_database" 01
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/comparison" after http://127.0.0.1:3230 http://127.0.0.1:3231
rtk proxy node "$qa_tmp/compare.mjs" "$qa_tmp/live" after
```

最後の行は、開発版のWebとAPIがそれぞれポート3000、3001で起動している場合に実行する。
