# 業務画面のパンくずと本文

ローカル開発版と本番向けローカルビルドをChromeで確認した。PCは1440px、モバイルは375pxのタッチエミュレーション。監査ログは監査担当者、他の業務画面は組織管理者で確認した。前後の画像は同じ開発用の合成データを使い、本番向けローカルビルドで撮影した。

| 画面 | PC | モバイル |
|---|---|---|
| 業務受信箱 | [変更前](before/1440-inbox.png) · [変更後](after/1440-inbox.png) | [変更前](before/375-inbox.png) · [変更後](after/375-inbox.png) |
| レポート | [変更前](before/1440-reports.png) · [変更後](after/1440-reports.png) | [変更前](before/375-reports.png) · [変更後](after/375-reports.png) |
| 管理ホーム | [変更前](before/1440-admin.png) · [変更後](after/1440-admin.png) | [変更前](before/375-admin.png) · [変更後](after/375-admin.png) |
| ナレッジ検索 | [変更前](before/1440-knowledge.png) · [変更後](after/1440-knowledge.png) | [変更前](before/375-knowledge.png) · [変更後](after/375-knowledge.png) |
| 監査ログ | [変更前](before/1440-audit.png) · [変更後](after/1440-audit.png) | [変更前](before/375-audit.png) · [変更後](after/375-audit.png) |

- 業務受信箱の件数欄はPCで58px、モバイルで115px上がった。レポートの日付絞り込みはPCで92px、モバイルで86px上がった。管理ホームの組織・役割の表示はPCで108px、モバイルで102px上がった。[変更前の測定](before.json) · [変更後の測定](after.json)
- 30画面×2幅で、現在地、支援技術用のレベル1見出し、ページ全体の横はみ出し0pxを確認した。axe違反は0件。モバイルのチケット一覧は横スクロール表の色コントラスト192要素が自動判定保留となり、変更前後で同じ結果だった。[axeの比較](logs/queue-axe.txt)
- 業務受信箱へのメニュー遷移、レポートの日付絞り込み、チケット詳細の件名と返信操作、元の行が見つからない場合のフォーカス、監査ログの権限案内を両幅で確認した。管理者と依頼者の両方で、サポートポータルからカタログ・申請・ヘルプ記事へ移動し、従来の見出しを表示した。[操作結果](journeys.json)
- 型検査、lint、ガバナンス、ユニット、本番用ローカルビルドに合格した。ユニットは4,909件合格、失敗0、既存skip 26件。既存CSSのautoprefixer警告はビルドに残っている。[ユニット](logs/unit.txt) · [ガバナンス](logs/governance.txt) · [ビルド](logs/build.txt)

## 再現

ローカルの合成データで開発版を起動した状態で、リポジトリのルートから実行する。

```zsh
qa_root=$(rtk proxy mktemp -d /tmp/solvi-uix059.XXXXXX)
qa_evidence=evidence/WP-P2-UIX-059/20261120-0914
for script in capture live-helpers journeys queue-baseline; do
  rtk proxy cp "$qa_evidence/$script.mjs.txt" "$qa_root/$script.mjs"
done
rtk proxy node "$qa_root/capture.mjs" after "$qa_root/results"
rtk proxy node "$qa_root/journeys.mjs" "$qa_root/journeys.json"
```

前後の比較は変更前の `d08b05c` のWebを3292、変更後のWebを3290で起動する。両方のAPI接続先は同じ開発版3001を使う。各ビルドでキャプチャを実行し、必要に応じてモバイルの横スクロール表のaxe結果も比較する。

```zsh
SOLVI_UI_BASE=http://127.0.0.1:3292 rtk proxy node "$qa_root/capture.mjs" before "$qa_root/before"
SOLVI_UI_BASE=http://127.0.0.1:3290 rtk proxy node "$qa_root/capture.mjs" after "$qa_root/after"
SOLVI_UI_BASE=http://127.0.0.1:3290 rtk proxy node "$qa_root/journeys.mjs" "$qa_root/journeys-release.json"
rtk proxy node "$qa_root/queue-baseline.mjs"
```
