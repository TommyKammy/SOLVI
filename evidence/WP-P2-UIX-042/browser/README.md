# WP-P2-UIX-042 ブラウザ検証

2026-11-11、ローカル開発環境の合成データで実施。Chrome 157.0.8103.39 と Playwright WebKit 26.5 は各9シナリオ成功、axe 9回すべて違反0。1440px/375pxで横溢れ・重複IDなし。ChromeはTab、WebKitはmacOSのAlt+Tabで共通項目スイッチ間のフォーカス移動を確認した。Safari/Edge製品実機の結果ではない。

## 確認内容

- セキュリティ例外テンプレートで、申請内容によるURL・日付・USB機器の質問切替を未保存プレビューで確認。
- 共通の理由・希望日数の4組合せを未保存プレビューで確認。機器一括申請は両方OFFで保存・再読込・公開。
- ノートPCとモニターをチェックすると後続の質問が表示され、チェック解除と再選択で以前の回答が復活しない。
- 受取方法による配送先の表示と、非表示時の古い回答除去を確認。
- 申請・改訂の実FormDataにreason/durationDaysが存在せず、APIで取得した固定snapshotにも存在しない。改訂後に非表示となった配送先も送信・保存されない。
- 申請内容版1と版2で承認履歴を比較。旧定義・入力が保持され、元のsnapshotのcanonical SHA-256が一致。現在版のsnapshot hashも再計算と一致。
- 未保存プレビューと追加の撮影は業務書込み0。各engineの保存・公開・申請・改訂はそれぞれ1回だけ。

## 実行

`SOLVI_SMOKE_PASSWORD`は既存の合成アカウントの資格情報を非出力で環境変数へ設定した。値は保存していない。

```sh
rtk proxy node --env-file=.env tools/ui_catalog_flexible_check.mjs
SOLVI_UI_BROWSER=webkit rtk proxy node --env-file=.env tools/ui_catalog_flexible_check.mjs
```

各engineの`summary.json`に結果、画像一覧、幅・重複ID・axe、フォーカス、固定snapshot、作成IDと書込み回数を記録した。第三者サービスへのアクセス・申請はこの検証に含まない。

## 再開と追加撮影

Chrome初回は最後の履歴hash検証で、検証スクリプトがsnapshot再構築時にrequesterIdを省略していたため失敗した。元snapshot自体のhash検証は成功していた。スクリプトを修正し、記録済みIDを読取APIで照合後、未実施の確認だけを再開した。保存・公開・申請・改訂は再送していない。

WebKitの初回管理画面375px画像は、幅変更直後のナビゲーションCSS遷移の途中を撮影していた。スクリプトへレールの位置が画面外へ移るまで待つ条件を追加し、既存fixtureを読み取って撮影を更新した。最初の追加撮影では閉じた編集パネルを開く手順が不足していたため中断したが、業務書込みは発生していない。

```sh
SOLVI_UI_RESUME=1 SOLVI_UI_RECAPTURE=1 rtk proxy node --env-file=.env tools/ui_catalog_flexible_check.mjs
SOLVI_UI_BROWSER=webkit SOLVI_UI_RESUME=1 SOLVI_UI_RECAPTURE=1 rtk proxy node --env-file=.env tools/ui_catalog_flexible_check.mjs
```

追加撮影では「入社時の機器一括申請」の新規フォームへ合成テンプレートを入力したが保存していない。`readonlyRecapture.additionalBusinessWrites`は両engineとも0。失敗時の画像・詳細ログはGit管理外の`.local/fix-042/`へ保存した。

## 画像

各engineに13枚。利用者向けの確認には以下を使用できる。

- `chromium/flexible-form-desktop-1440.png`: 共通項目OFFと、機器の選択で表示された質問を同時に表示。
- `webkit/flexible-form-mobile-375.png`: 共通項目の設定。
- `webkit/flexible-preview-mobile-375.png`: 機器の複数選択と後続質問。
- `chromium/security-preview-desktop-1440.png`: 申請内容による質問切替。
- 各engineの`request-form-*.png`、`request-edit-desktop-1440.png`、`request-detail-*.png`: 申請・改訂・確認画面。

## 合成fixture

| Engine | カタログID | 申請ID |
| --- | --- | --- |
| Chrome | 01a1c78c-b913-7000-8e37-3b60f6238c6a | 01a1c78c-c897-7000-b61a-91bed1d4ce20 |
| WebKit | 01a1c78d-f722-7000-b9e1-8d17f0b2eccc | 01a1c78e-0655-7000-a3a0-edc0ddb44ee0 |

タイトルは`UI042-SYN-`で始まる。新規合成サービスと申請のみを作成し、既存サービスは変更していない。両fixtureを確認可能な状態で保持した。実際のリソース手配・権限操作は行っていない。
