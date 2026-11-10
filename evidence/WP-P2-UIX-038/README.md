# WP-P2-UIX-038: サポートポータル回帰修正

対象: `562211d` からの表示層4ファイルの修正。実行日: 2026-11-10 JST。

## 変更と検証

- サポートメニューは既存のロール別ナビゲーションから受信箱・変更管理・資産を引き継ぐ。監査者をstaffへ昇格させない。
- 業務受信箱を利用できる利用者のカードは受信箱へ、その他は自分の申請へ接続し、文言も一致させた。
- 検索送信ボタンを常時表示。キーボードフォーカス時にクリッピングされないこととEnterによる検索を検査。
- 対象ブラウザは最新版Chrome/Edge/Safari。`:has()`非対応環境は対象外で、既存の`:has()`ルールは変更していない。

## テスト

- `tests/unit/support-portal-ui.test.ts`: 21件。修正前は14件失敗、修正後は全件成功。
  - 6ロールのメニュー、非staffのサブページ、他組織のロール、グローバル管理者、複合ロール。
  - カードの遷移先・文言と、現在の利用者に固定したチケット取得条件。
- 関連4ファイル: 計119件成功。
- 新規テストファイルのstrict TypeScript検査: 成功。
- アプリの型チェック、lint、本番ビルド: 成功。本番ビルドは稼働中のNext開発サーバーと分離したコピーで実行。
- `npm run check:all`: RTMのテスト対応と台帳を更新し成功。
- `tools/ui_support_portal_check.mjs`: 依頼者・承認者・監査者・担当者・組織管理者の5ロールで、実ログイン、メニューからの遷移、カードからの遷移、シェルの境界を検査。
  - Chrome: 20検査・11回のaxe検査成功。axe違反0。
  - WebKit: 20検査・11回のaxe検査成功。axe違反0。Safari系エンジンでの検証であり、Safari製品実機での検証とは区別する。
  - 検索入力からTabで送信ボタンへ移動し、可視フォーカスとEnter送信を確認。1440px/375pxで確認。
  - macOS WebKitは既定のキーボード操作に合わせOption-Tabを使用し、フォーカス・可視性・Enter送信の同じ検査を実行した。[Appleのキーボード操作説明](https://support.apple.com/guide/safari/keyboard-shortcuts-and-gestures-cpsh003/mac)。OSやSafariの設定は変更していない。
  - 375pxでページ幅375px、横スクロールなし。
  - 予定外のHTTPリクエスト0。業務状態の変更・外部送信は行わず、合成アカウントの認証・組織選択だけPOSTを許可。

ブラウザ結果とスクリーンショットは `chrome/` と `webkit/` に保存。
Edge実機はホストに未導入のため未実施。

## 再実行

起動中のローカル試用環境と合成アカウントを使用する。
`SOLVI_SMOKE_PASSWORD`を非公開の環境変数として設定してから実行する。資格情報をコード・ログへ記載しない。

```sh
rtk proxy node node_modules/vitest/vitest.mjs run tests/unit/support-portal-ui.test.ts tests/unit/portal-catalog.test.ts tests/unit/operations-overview.test.ts tests/unit/ticket-queue.test.ts
rtk proxy node tools/ui_support_portal_check.mjs
```

ブラウザ検査の任意設定:

- `SOLVI_UI_BASE`: 既定`http://127.0.0.1:3000`。localhostのみ許可。
- `SOLVI_UI_OUT`: Evidence出力先。
- `SOLVI_UI_BROWSER`: `chromium`（既定）または`webkit`。
- `SOLVI_UI_BROWSER_CHANNEL`: 例`chrome`または`msedge`。既存ブラウザを使う場合に指定。
- Playwrightの同梱ブラウザを使う場合は対応バイナリを事前に導入する。npm依存の追加は不要。

## 全体テストの既存失敗

`npm run test:unit`は81ファイル成功・4ファイル失敗、3863件成功・34件失敗。これとは別に1スイートがfixture読込み時に失敗した。
今回の関連119件の成功を、全体スイートの成功として扱わない。

失敗した4ファイルを、修正前`562211d`のGit archiveで作った隔離コピーでも再実行した。現在の失敗全件が修正前にも存在することを確認した。
隔離コピーではコピー先パスに依存する既存テストも1件追加で失敗した。
対応する失敗名は `baseline-unit-failures.json` に保存。

- `knowledge-list.test.ts`: スナップショットに含まれない`knowledge-fixture.mjs`をimportする。
- `performance-runtime.test.ts`: スナップショットに含まれない過去コミットのソースを`git show`で参照する。
- `performance-search-static-cli.test.ts`: 過去の固定Evidence/ソースの検証前提が、このスナップショットと一致しない。
- `knowledge-search-page.test.ts`: 変更前から旧UIのリンク名・公開状態表示を前提とする2件が失敗する。

これらのテストの削除・skip・ガード無効化・不足資料の捏造は行っていない。
復元資料・履歴と既存期待値の整合は別の作業が必要で、全体テスト合格は未達。

## 範囲とロールバック

API・DB・Migration・認可定義・RLS・監査・npm依存の変更なし。
表示層4ファイルの変更を戻せばロールバックできる。検証で保存済み業務データは変更していない。
詳細ログはGit管理外の`.local/fix-038/`に保存。
