# サポートポータルの表示継続

開発版ポート3000と、隔離PostgreSQL・本番向けローカルビルドで確認した。ChromeのPC幅1440pxはキーボード、モバイル幅375pxはタッチエミュレーションを使用した。

| サポートポータルのリンク | 管理者のPC | 依頼者のPC | 管理者のモバイル | 依頼者のモバイル |
|---|---|---|---|---|
| サービスカタログ | [画像](screens/org_admin-1440-catalog.png) | [画像](screens/requester-1440-catalog.png) | [画像](screens/org_admin-375-catalog.png) | [画像](screens/requester-375-catalog.png) |
| 申請の状況 | [画像](screens/org_admin-1440-requests.png) | [画像](screens/requester-1440-requests.png) | [画像](screens/org_admin-375-requests.png) | [画像](screens/requester-375-requests.png) |
| ヘルプ記事 | [画像](screens/org_admin-1440-knowledge.png) | [画像](screens/requester-1440-knowledge.png) | [画像](screens/org_admin-375-knowledge.png) | [画像](screens/requester-375-knowledge.png) |

- 組織管理者と依頼者の両ログインで、3リンクからサポートポータルのヘッダーを保ち、同じ見出しと現在地を表示した。検索、絞り込み、リロード、詳細からの復帰で `portal=1` が継続した。従来の業務URLからは管理者が従来の業務画面を開けた。
- 公開サービスから模擬申請を送り、受付と「自分の申請を見る」までサポートポータルの表示が続いた。承認済みの合成申請をそれぞれの本人で開き、担当者向けの実行操作が表示されず、他人の申請の直接URLは404だった。
- ヘルプ記事では同じ検索語を持つ組織内公開記事と担当者限定記事を用意した。両ログインで組織内公開記事1件を表示し、担当者限定記事のポータル表示は404だった。管理者は業務画面で担当者限定記事を閲覧できた。APIに表示範囲と管理指定を同時に渡しても、管理者の結果は公開範囲に絞られ、依頼者の管理指定は403だった。
- 認証とロールは実際のログインセッションを使う。モード指定はリンク・画面と読み取り範囲に使用し、変更操作のサーバー認可は従来どおりにした。

[開発版の結果](live.json) · [業務導線とaxeの詳細](isolated.json) · [ロール別の既存回帰](smoke.json)

## 検査

- 両ロール・両幅の12条件とロール別回帰の11条件でaxe違反0件。両幅でページ全体の横はみ出しはなかった。
- 型、lint、ガバナンス、本番向けローカルビルド、ユニットに合格した。ユニットは4,909件合格、既存skip 26件、失敗0件。ビルドに既存CSSのautoprefixer警告が出た。[ユニット集計](logs/unit.txt) · [ガバナンス](logs/governance.txt) · [ビルド](logs/build.txt)

## 再現

[前段WPの再現手順](../../WP-P2-UIX-057/20261120-0832/README.md#再現)で、Webを3280、APIを3281に変更して起動する。このフォルダーの `stack.mjs.txt` と、未使用の `solvi_uix049_<UNIX時刻>_test` を使用する。

```zsh
qa_evidence=evidence/WP-P2-UIX-058/20261120-0844
for script in stack capture live-helpers; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_root/$script.mjs"
done
rtk proxy node "$qa_root/capture.mjs" "$qa_root/results" isolated
rtk proxy node "$qa_root/capture.mjs" "$qa_root/live" live
```

隔離モードは合成サービス・記事・申請を作る。開発版の検証はこれらの合成レコードを追加しない。
