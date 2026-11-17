# WP-P2-UIX-043 実画面の axe・スクリーンショット Evidence (2026-11-17)

AGENTS.md §1.15 の、UI変更に対するスクリーンショットと axe の Evidence。

- Timestamp: 2026-11-17 15:13 JST
- Commit: `3f2898b` に、本Evidenceで見つけた欠陥の修正(`freshservice.css` のモバイルの `.fs-flyout`)を加えた作業ツリー
- Command: `node capture.mjs evidence/WP-P2-UIX-043/20261117-1513-browser`(スクリプトは `capture.mjs.txt`、起動は `run_stack.sh.txt`)
- Result: 60スキャンで axe の違反 0件(serious/critical も 0)。375pxの横はみ出し 0。コンソールエラー 0。全スキャン HTTP 200(ログイン画面へのリダイレクトなし)。

## 環境

- Web: `next build` の本番ビルドを `next start` で起動(127.0.0.1:3000)。
- API: `services/api/src/main.ts`(`NODE_ENV=development`、ADR-0019 のローカル認証)。
- DB: 検証専用の使い捨てDB `solvi_wp043_evidence_test`(colima-solvi の Postgres)。Migration 42件を適用し、`tools/seed.mjs` の合成データを投入した。**開発用DB `solvi` には接続していない。**
- 利用者: seed の合成ユーザー `org_admin@acme.example.test`(運用画面)と `requester@acme.example.test`(ポータル・起票)。パスワードは seed ファイルから読み、出力していない。
- 合成チケット1件を API で作成(`ticket-create.json`)。詳細・統合画面の表示用。
- ブラウザ: Chromium headless shell 1248、WebKit 2336(Playwright 1.62.0)。axe の規則は `tools/check_accessibility.mjs` と同じ `wcag2a/2aa/21a/21aa/22aa`。

### 以前の 401 の原因

`.env` の `SYNTHETIC_ORG` が空で、検査対象のDBに合成ユーザーがいなかった。今回は使い捨てDBに seed を入れ、organizationId を明示してログインした。

## 対象画面(15画面 × Chromium/WebKit × 1440/375px)

ポータル、ホーム、起票(障害)、ナレッジ、業務受信箱、アクセスレビュー、承認ルール、承認の変更履歴、利用者管理、委任設定、カタログ作成、資産CSV取込、チケット詳細(担当者)、チケット統合、チケット詳細(依頼者)。

## 挙動の確認(`summary.json` の `checks`)

| §7 の基準 | 結果 |
|---|---|
| SSR HTML に `inert` が無く、操作要素がある | `inert` なし、input/textarea/select あり |
| JS無効でもフォームが操作できる | フォーム内の操作要素 13個、`inert` なし(`screens/chromium-1440-ticket-new-nojs.png`) |
| 閉じたモバイルレールが Tab 順から外れる | 25回の Tab でレール内に入らない。レールは `visibility: hidden` |
| 開くと閉じるボタンへ、閉じると開閉ボタンへフォーカス | 開: 「メニューを閉じる」へ移動。Escape で開閉ボタンへ戻る |
| 開いている間は背景が `inert` | 開: `.fs-main` が `inert`。閉: 解除 |
| `aria-controls` がレールを指す | `solvi-main-navigation` を指す |
| ポータル検索のフォーカスリング | `outline: 3px solid`(`screens/chromium-1440-portal-search-focus.png`) |
| 入力文字 16px 以上 | 起票画面の入力欄はすべて 16px |
| 開閉ボタンのタッチターゲット | 44×44px |
| テーブルの region と caption | 利用者管理: 1/1。承認の変更履歴・アクセスレビュー・委任設定は合成データでは0行で、テーブル自体が描画されない(単体テスト `table-regions.test.ts` で全25箇所を検査済み) |

## 本Evidenceで見つけて直した欠陥

最初の実行で、**閉じたモバイルレールのリンクに Tab でフォーカスが入る**ことが分かった。レールは
`visibility: hidden` だが、モバイルの `.fs-flyout` に `visibility: visible` が明示されていたため、
子孫のリンクだけが可視・フォーカス可能のままだった(CSSの `visibility` は子孫が上書きできる)。

- 修正: モバイルの `.fs-flyout`(と `.fs-rail-item.is-open .fs-flyout`)を `visibility: inherit` にした。
- 回帰テスト: `tests/unit/ui-contrast-and-focus.test.ts` に、モバイルの `.fs-flyout` が `visibility: visible` を持たないことの検査を追加した。修正前のCSSで失敗し、修正後に成功することを確認した。
- 修正後に再ビルドし、全スキャンを撮り直したものが本ディレクトリである(修正前の結果は残していない)。

## ファイル

| パス | 内容 |
|---|---|
| `summary.json` | 全スキャンの結果と挙動の確認 |
| `axe/<engine>-<width>-<page>.json` | 画面ごとの axe の違反(すべて空) |
| `screens/chromium-<width>-<page>.png` | 全画面のスクリーンショット(Chromium) |
| `screens/chromium-375-mobile-rail-open.png` / `-closed.png` | モバイルレールの開閉 |
| `screens/chromium-1440-ticket-new-nojs.png` | JS無効時の起票フォーム |
| `screens/chromium-1440-portal-search-focus.png` | ポータル検索のフォーカス |
| `ticket-create.json` | 合成チケットの作成結果 |
| `capture.mjs.txt` / `run_stack.sh.txt` | 実行スクリプトの複製 |

## 実行していないこと

- WebKit のスクリーンショット(axe は WebKit でも実行した)。
- 実機の iOS / Android。375px の幅とタッチの有効化で代用した。
