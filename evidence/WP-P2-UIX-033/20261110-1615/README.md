# WP-P2-UIX-033 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-033`
- 対象: サポートポータル配下のサブ画面を専用シェルへ展開
- 変更範囲: `AppFrame.tsx`、`SupportFrame.tsx`、`freshservice.css`

## 1. 対象ルート

サポートシェル(左レールなし・白いサブページヘッダー):

- `/catalog`, `/catalog/{id}`
- `/knowledge`, `/knowledge/{id}`
- `/tickets/new`, `/tickets/{id}`
- `/requests`, `/requests/{id}`
- `/settings/notifications`

エージェントシェルのまま(意図的に除外):

- `/catalog/manage`
- `/knowledge/new`
- `/inbox`
- `/ops`
- `/assets`
- `/changes`

## 2. サブページのデザイン

- ヘッダー: 白背景、ダークテキスト、下線。スクロール時は上部に固定。
- ロゴ、ハンバーガーメニュー、通知ベル、ユーザーメニューはポータルと同じ。
- 背景: `#EBEFF3`。
- ナレッジ/カタログの一覧: 左ナビと表/カードを白いパネルとして表示。
- チケット詳細・申請詳細・フォーム・設定: ページ全体を白いカードに。
- モバイル: ヘッダー固定、カード1列、横スクロールなし。

## 3. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | 対象サブ画面で左レールなし | 充足 | `summary.json` の全対象 `rail=0` |
| 2 | 白いサブページヘッダー | 充足 | `headerBackground=rgb(255,255,255)` / `headerColor=rgb(18,51,76)` |
| 3 | 管理・編集画面はエージェントシェル | 充足 | `catalog-manage` / `knowledge-new` が `rail=1` |
| 4 | `/inbox`, `/ops` はエージェントシェル | 充足 | `inbox` / `ops` が `rail=1` |
| 5 | ポータルからの遷移でシェル維持 | 充足 | カタログ/チケット作成/詳細のスクリーンショット |
| 6 | 既存機能の維持 | 充足 | ポータル/申請/チケットの既存テスト・画面確認 |
| 7 | モバイルで横スクロールなし | 充足 | `bodyWidth=375` / `viewportWidth=375` |
| 8 | axe | 充足 | 全対象画面・全15画面で違反0 |
| 9 | typecheck / lint / check:all | 充足 | §4 |
| 10 | API・DB変更なし | 充足 | `git diff --stat` |

## 4. 実行した検証

```sh
npm run typecheck
# 成功
npm run lint
# 成功
npm run check:all
# 成功

node .local/ui-check-033.mjs
# catalog / catalog-item / knowledge / knowledge-article /
# ticket-new / ticket-detail / requests / request-detail / settings:
#   rail=0, supportHeader=1, subpage=1
#   headerBackground=rgb(255,255,255), headerColor=rgb(18,51,76)
#   axe違反0
# excluded:
#   catalog-manage / knowledge-new / inbox / ops: rail=1, supportHeader=0
# mobile: bodyWidth=375, viewportWidth=375
```

全15画面のaxeも違反0:
`/inbox`, `/ops`, `/ops/{id}`, `/ops/overview`, `/portal`, `/knowledge`, `/catalog`, `/assets`, `/changes`, `/requests`, `/ops/users`, `/ops/groups`, `/ops/admin`, `/catalog/manage`, `/settings/notifications`。

## 5. 補足

- サブページではヒント文字が `#EBEFF3` 上に載るため、`--fs-text-muted` を `#5f7183` から `#596b7d` へ少し暗くした(コントラスト 4.35 → 4.75)。
- 申請詳細の確認用に、ローカルDBへ合成サービス申請を1件作成した(`01a1c433-8a7c-7001-87d7-81eccbddd483`)。本番データではない。
- Freshservice本番は読み取り専用。写真・ロゴ・アイコン素材は複製していない。

## 6. 残課題

- サポートシェルは `/catalog`, `/knowledge`, `/tickets`, `/requests`, `/settings` 配下のみ。`/assets` は対象外。
- 管理・編集画面(`/catalog/manage`, `/knowledge/new`)はエージェントシェルのまま。管理操作の誤認を避けるため。
- サポートポータルの横断検索(チケット・サービス・記事)は未実装。

## 7. Evidence一覧

- `desktop-*.png`: 各対象画面(1440×900)
- `mobile-catalog.png` / `mobile-knowledge.png` / `mobile-ticket-detail.png`
- `summary.json`: rail/header/subpage、axe、モバイル幅
- `run.log`: 実行ログ
