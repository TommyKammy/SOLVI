# WP-P2-UIX-044 実画面 Evidence (2026-11-18)

UI v2のアプリシェル(256pxの薄いブルーの左サイドバー + 56px上部バー)と、
ライト/ダークのデザイントークン・テーマ切替の Evidence。

- Timestamp: 2026-11-18 13:10–13:28 JST
- Branch: `wp/WP-P2-UIX-044`(作業ツリー。コミット前)
- Command: `node capture.mjs evidence/WP-P2-UIX-044/20261118-1310`(`capture.mjs.txt` を `capture.mjs` としてコピーして実行。スクリプトは `capture.mjs.txt`)
- Result: **20スキャンで axe の違反 0件**(serious/critical も 0)。375pxの横はみ出し 0。コンソールエラー 0。テーマ属性の不一致 0。全ルート HTTP 200。

## 環境

- Web: 本番ビルド(`next build` + `next start`)を 127.0.0.1:3100 で起動。
  - 別のローカル開発スタックが 3000/3001 と `apps/web/.next` を使っていたため、同じソースを一時ディレクトリへ複製してビルドした。複製では `output: 'standalone'` だけを外している(`next start` で配信するため)。アプリのコードは同一。
- API: `services/api/src/main.ts`(`NODE_ENV=development`、ADR-0019のローカル認証)を 127.0.0.1:3101 で起動。
- DB: 使い捨てDB `solvi_wp044_evidence_test`(colima-solvi の Postgres)。Migration 42件を適用し、`tools/seed.mjs` の合成データを投入した。**開発用DB `solvi` には接続していない。**
- 利用者: seed の合成ユーザー `org_admin@acme.example.test`(運用画面)、`requester@acme.example.test`(ポータル)、`agent@acme.example.test`(複数組織の切替確認)。パスワードは seed ファイルから読み、出力・保存していない。
- 合成チケット: APIで1件作成し、管理者へ割当(`ticket-create.json`)。件数と詳細画面の表示用。
- ブラウザ: Chromium headless shell 1248(Playwright 1.62.0)。axe の規則は `wcag2a/2aa/21a/21aa/22aa`。
- テーマ: Playwright の `colorScheme` でOS設定をライト/ダークに切り替え、初期化スクリプトの結果を撮影した。

## 対象画面(5画面 × 2幅 × 2テーマ = 20スキャン)

| 画面 | パス | 利用者 |
|---|---|---|
| ログイン | `/login` | 未ログイン |
| 業務受信箱 | `/inbox` | org_admin |
| チケット対応 | `/ops` | org_admin |
| チケット詳細 | `/ops/{合成チケット}` | org_admin |
| サポートポータル | `/portal` | requester |

- 幅: 1440×900 / 375×812
- テーマ: ライト / ダーク
- 追加: `screens/mobile-sidebar-open.png`(375px、サイドバーを開いた状態)

## axe の結果

`summary.json` の `totals`:

```json
{
  "scans": 20,
  "seriousOrCritical": 0,
  "anyViolationNodes": 0,
  "overflow375": [],
  "redirectedToLogin": [],
  "consoleErrorScans": [],
  "themeAttributeMismatches": []
}
```

画面ごとの完全な結果は `axe/<theme>-<width>-<page>.json`。

## 挙動の確認(`summary.json` の `checks`)

| WP §7 の基準 | 結果 |
|---|---|
| 左サイドバー256px・上部バー56px | `sidebarWidth: 256`, `topbarHeight: 56` |
| 64pxアイコンレール/フライアウトが無い | `flyoutPresent: false`、DOMに`.fs-flyout`なし |
| サイドバーが薄いブルー | ライト `rgb(238,244,252)` = `#EEF4FC`。ダークは `#152233` |
| 現在地に`aria-current="page"` | `/inbox` は「業務受信箱」。`/ops?assignment=mine&state=…` でも「自分の担当」 |
| 全項目にTabで到達 | デスクトップ 26/26、モバイル開 26/26 |
| 件数は2つのAPIだけ | 業務受信箱7・自分の担当7・解決期限超過0。0は強調しない |
| 上部バーの中身 | 現在地、組織、日付、検索、新規チケット、通知、ユーザー |
| 検索の送信先 | staff `/ops`(`q`付きGET) |
| テーマ初期値はOS | `light`/`dark` の各コンテキストで `data-theme` が一致 |
| 選択の保存 | クリック後 `localStorage['solvi-theme']='dark'`、再読込後もダーク |
| 保存領域の失敗 | `localStorage`を例外にしても切替でき、表示は壊れない |
| 800px以下で初期閉 | 375pxは `visibility: hidden`、Tabで閉じたサイドバーに入らない |
| メニューボタンで開閉 | 開くと「メニューを閉じる」へフォーカス、背景は`inert`、Escapeで開閉ボタンへ復帰 |
| モバイルの背景 | 開くと全面のbackdrop(375×812、`rgba(9,18,30,0.45)`)を表示 |
| 801pxでは表示 | `visibility: visible`, `margin-left: 256px` |
| CSP nonce | ヘッダーのnonceとインラインスクリプトのnonceが一致。`script-src`は`'self' 'nonce-…' 'strict-dynamic'` |
| 全ルート | 20ルートすべて200(`/select-organization`は複数組織の合成agent) |

## コントラスト

`contrast.md` に11.3 §4の文字色/背景色の組み合わせをライト/ダーク両方で記載した。
本文・補足・サイドバー文字はすべて4.5:1以上、入力境界は3:1以上。

## 変更前

`before/` は直前のWP-P2-UIX-043の実画面(`evidence/WP-P2-UIX-043/20261117-1513-browser/screens/`)と、
HEAD時点の旧シェルを一時ディレクトリでビルドして撮った `/inbox` からなる。

| 変更前 | 変更後 |
|---|---|
| `before/light-1440-inbox.png`(HEAD時点の旧シェル) | `screens/light-1440-inbox.png` |
| `before/light-375-inbox.png`(HEAD時点の旧シェル) | `screens/light-375-inbox.png` |
| `before/light-1440-ops.png` | `screens/light-1440-ops.png` |
| `before/light-1440-ticket-detail.png` | `screens/light-1440-ticket-detail.png` |
| `before/light-1440-portal.png` | `screens/light-1440-portal.png` |
| `before/light-375-ops.png` ほか | `screens/light-375-ops.png` ほか |
| `before/light-375-mobile-rail-open.png` | `screens/mobile-sidebar-open.png` |

UIX-043はダークテーマを撮っていない(旧シェルにダークテーマが無い)ため、ダークの変更前は無い。

## ファイル

| パス | 内容 |
|---|---|
| `summary.json` | 全スキャンと挙動の確認 |
| `axe/<theme>-<width>-<page>.json` | 画面ごとのaxe結果(すべて空) |
| `screens/<theme>-<width>-<page>.png` | 20画面のスクリーンショット |
| `screens/mobile-sidebar-open.png` | 375pxのサイドバー開 |
| `before/` | UIX-043時点の変更前画面 |
| `contrast.md` | コントラスト比の一覧 |
| `logs/` | typecheck / lint / check:all / vitest / test:unit の出力 |
| `capture.mjs.txt` / `run_stack.sh` | 実行スクリプトの複製 |
| `ticket-create.json` | 合成チケットの作成・割当結果 |

## 実行していないこと

- WebKit の実画面撮影(axeはChromiumのみ)。UIX-043ではWebKitのaxeも実行したが、本WPはデザイントークンの変更なのでChromiumで確認した。
- 実機の iOS / Android。375px・タッチ有効・`pointer: coarse` で代用した。
- スクリーンリーダー実機での読み上げ確認。

## npm run lint について

`npm run lint` は `.claude/worktrees/*/apps/web/next-env.d.ts`(git管理外のローカルworktree)の
triple-slash-reference 3件で失敗する。本WPの変更ファイルではない。
追跡対象のファイルだけを `eslint --max-warnings=0 --no-warn-ignored` で検査した結果は
`logs/lint-tracked-files.txt`(成功)。変更ファイル単体のlintは `logs/lint-changed-files.txt`。
