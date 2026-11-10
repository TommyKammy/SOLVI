# WP-P2-UIX-041 browser evidence

検証日: 2026-11-10〜11-11 JST。ローカルの Next.js/API/PostgreSQL を使用し、Chrome 157.0.8103.39 と Playwright WebKit 26.5 で確認した。WebKit は Safari エンジンによる検証であり、macOS Safari アプリの操作ではない。

| Browser | 業務シナリオ | axe                    | 375px 横幅 | 想定外の業務書込み |
| ------- | ------------ | ---------------------- | ---------- | ------------------ |
| Chrome  | 9/9 成功     | 6 scans / violations 0 | 375 = 375  | 0                  |
| WebKit  | 9/9 成功     | 6 scans / violations 0 | 375 = 375  | 0                  |

各 engine の `summary.json` にシナリオ結果、axe 違反配列、業務書込みの種類別件数、合成レコード ID、画像一覧、チェック進捗更新前後の不変条件を保存した。axe 対象は共有項目ライブラリ・運用情報を含む編集フォーム・agent 作業チェックの各 1440×900 / 375×900。キーボードの前進操作は Chrome で Tab、WebKit で Alt+Tab を使用し、見える入力要素へのフォーカスを確認した。

## 実操作で確認したこと

1. セクション・条件付き質問を含む新しい合成サービスを保存する。
2. 保存版を元に共有質問セットを作り、元サービスが変わらないことを確認する。
3. 別の新規サービスに独立した質問コピーを挿入し、質問キー・セクションキー・表示条件参照を一緒に再採番する。責任者・既存担当グループ・必須/任意の作業項目を保存する。
4. 複製 GET の業務 POST が 0 であることを確認し、新しい管理コードの非公開下書きを 1 件保存する。コピー元の内容は変えない。
5. 自身の合成複製だけを公開し、一覧に責任者・更新日時・公開前チェックが表示されることを確認する。
6. requester で合成複製を申請し、責任者・担当グループ・作業項目を閲覧でき、作業更新ボタンがないことを確認する。
7. その申請に指定した合成 approver で承認する。
8. agent で必須作業未完了の案内と模擬実行ボタン非表示を確認し、必須作業を 1 回更新する。申請の snapshot・hash・request.version は同一、独立した checklistVersion だけが 1→2 になる。
9. 任意作業を未完了のまま必須完了後にローカル模擬実行でき、completed と receipt を取得することを確認する。

各 engine の業務書込みは、新規 catalog 3 件（source / target / clone）、共有 set 1 件、clone 公開 1 回、申請 1 件、承認 1 回、チェック更新 1 回、ローカル模擬実行 1 回に限定した。既存サービス・既存申請の変更、role grant/revoke、実リソースへの権限付与や外部操作は行っていない。API/DB の role 有効期限・失効・組織境界・RLS の検証は別の backend evidence を参照する。

## 画像

各 engine ディレクトリの通常シナリオ画像 9 枚に加え、production build 後の runtime に再ログインして既存の own target/request を読む補足画像を 6 枚保存した。補足撮影中は認証以外の書込みをすべて拒否し、業務書込み 0 を確認した。共有セットの選択は画面内の未保存選択のみで、追加・保存・申請は行っていない。

- `shared-set-controls-readonly-{1440,375}.png`: 共有セット選択・コピー案内。375px で長いセット名もページを横に広げない。
- `operations-controls-readonly-{1440,375}.png`: 保存済み責任者・担当グループ・必須作業。
- `completed-checklist-controls-readonly-{1440,375}.png`: 完了必須 1/1、任意未完了、模擬実行後の読み取り表示。

## 中断と再開

Chrome の初回は API TicketView が省略する任意の groupName への harness 期待で、チェック更新前に停止した。実際のグループは request fulfillment と backend の DB 検証で確認した。次の再開ではボタンの ARIA ラベルに含まれる引用符を harness に反映し、同じ approved 申請を再利用した。チェック・模擬実行の再送や新規 catalog/set/申請/承認はない。

WebKit は target 保存前に 375px の native select 内容から 428px へ横溢れする不具合を検出した。共有セット領域の最小幅・grid・折返しを整え、select 自身の overflow/text-overflow/white-space を制御して解消した。祖先コンテナ全体の clip は使用していない。読み取り専用の診断で 375 = 375 を確認してから、既存 source/set を再利用し残りのシナリオを実行した。追加 source/set 作成は 0。

## 再実行方法と記録

検証 tool は `tools/ui_catalog_operations_check.mjs`。`SOLVI_SMOKE_PASSWORD` はローカル seed の開発パスワードを環境変数として渡し、値を出力しない。Node 24 を使用する。新しい合成データを作る再実行では、既存 evidence を上書きせず `SOLVI_UI_OUT` に新しい保存先を指定する。

```sh
rtk proxy /opt/homebrew/opt/node@24/bin/node tools/ui_catalog_operations_check.mjs
```

`SOLVI_UI_BROWSER=chromium` または `webkit` を選ぶ。既存書込みのある summary を通常モードで再利用することは tool が拒否する。限定再開は既存の成功段階・種類別書込み件数・ID を照合してから行う `SOLVI_UI_RESUME_AGENT=1` / `SOLVI_UI_RESUME_TARGET=1` のみで、今回の成功 evidence には適用できない。

資格情報・cookie・storage state・trace は保存しない。私有ログは `.local/fix-041/` の `browser-chromium*.log`、`browser-webkit*.log`、`browser-readonly-capture.log`、`overflow-*.log`。最終 evidence に失敗画面・診断用画像は含めていない。セキュリティ変更に必要な人間レビューと main への公開判断は、このローカル実動作検証とは別である。
