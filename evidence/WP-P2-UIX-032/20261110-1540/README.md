# WP-P2-UIX-032 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-032`
- 対象: サポートポータルのFreshservice準拠レイアウト
- 変更範囲: `/portal` の専用シェルと表示層のみ(API・DB・認可は未変更)

## 1. REAでのFreshserviceサポートポータル分析

- 対象: `https://ts-pharma.freshservice.com/support/home`
- REA capture: `ev_e3254d8efa8ff29c6fe1d4de9f81799247b00a4f985235e56a7e05dfa33fbcd7`
- 本番は読み取り専用。入力・保存・削除・設定変更は行っていない。

| 要素 | Freshserviceの実測値 | SOLVIの反映 |
|---|---|---|
| レイアウト | 左レールなし。ヒーロー上に透過ヘッダー | `/portal` 専用 `SupportFrame` |
| ヘッダー | 64px、ハンバーガー、ロゴ、ベル、アバター | 同構成 |
| ヒーロー | 372px、タイトル40px/48、検索680×60 | 同寸法。写真は複製せずブランドグラデーション |
| 背景 | `#EBEFF3` | 同じ淡いグレー |
| カード | 400×142、2×2、間隔32、影 `0 6px 19px rgba(32,33,39,.08)` | 同寸法・同配置 |
| カードアイコン | 64px、色分け | 64px、サービス/障害/ナレッジ/承認で色分け |
| タブパネル | 白、タブはアクティブ下線、`#2C5CC5` | 白パネル+下線タブ |
| タブ | オープンなチケット等 | オープンなチケット / 申請の状況 / サービスを探す |

Freshworksの写真・ロゴ・アイコン素材は複製していない。

## 2. 実装内容

- `/portal` ではエージェント用の左レールを出さない。
- `SupportFrame` を追加し、ヒーロー上に透過ヘッダーを重ねた。
  - ハンバーガーメニュー: ホーム、自分の問い合わせ、申請の状況、サービスカタログ、ナレッジ、通知設定、担当業務へ。
  - 通知ベル、ユーザーメニュー(通知設定・組織切替・ログアウト)。
- ヒーロー: 「どういった事でお困りですか？」+ ヘルプ記事検索。
- 2×2のアクションカード:
  - サービスをリクエストする → `/catalog`
  - 問題を報告する → `/tickets/new?kind=incident`
  - ヘルプ記事を閲覧する → `/knowledge`
  - アクションアイテムを完了する → `/requests?view=mine`
- 白いタブパネル:
  - オープンなチケット: 未解決/すべて、ページング、詳細へ。
  - 申請の状況: 最近の申請、`/requests?view=mine` へ。
  - サービスを探す: サービス検索・一覧、ナレッジ検索。
- `tab` クエリでタブを切り替え。リンクなのでURL共有・戻るが効く。

## 3. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | 左レールなし | 充足 | `railCount=0` |
| 2 | ヒーロー検索が `/knowledge?q=` へ | 充足 | `heroSearch=http://127.0.0.1:3000/knowledge?q=VPN` |
| 3 | 2×2カードと遷移先 | 充足 | `summary.json` の `cards`/`cardHrefs` |
| 4 | 3タブと`tab`切替 | 充足 | `desktop-portal-requests.png`, `desktop-portal-services.png` |
| 5 | チケットの表示切替・ページング | 充足 | 既存 `TicketPagination`/`portalHref` を維持 |
| 6 | 申請タブ | 充足 | `desktop-portal-requests.png` |
| 7 | サービスタブ | 充足 | `desktop-portal-services.png`、サービス3件 |
| 8 | 800px以下で1列・横スクロールなし | 充足 | `mobile-portal.png`, `bodyWidth=375` |
| 9 | axe | 充足 | `/portal`、各タブ、全15画面で違反0 |
| 10 | typecheck / lint / check:all | 充足 | §4 |
| 11 | API・DB変更なし | 充足 | `git diff --stat` |

## 4. 実行した検証

```sh
npm run typecheck
# 成功
npm run lint
# 成功
npm run check:all
# 成功

npx vitest run tests/unit/portal-catalog.test.ts
# 26件成功

node .local/ui-check-032.mjs
# railCount=0、header=1、カード4件、タブ3件
# メニュー: ホーム/自分の問い合わせ/申請の状況/サービスカタログ/ナレッジ/通知設定/担当業務へ
# メニューはリンククリック後に閉じる
# heroSearch=/knowledge?q=VPN
# 申請タブ: 「最近の申請」/ axe違反0
# サービスタブ: 「サービスを探す」「解決のヒントを探す」/ サービス3件 / axe違反0
# mobile: bodyWidth=375, viewportWidth=375, cardColumns=343px(1列)
```

全15画面のaxe: `/inbox`, `/ops`, `/ops/{id}`, `/ops/overview`, `/portal`, `/knowledge`, `/catalog`, `/assets`, `/changes`, `/requests`, `/ops/users`, `/ops/groups`, `/ops/admin`, `/catalog/manage`, `/settings/notifications` — すべて違反0。

## 5. セキュリティ影響

- 表示層のみ。API・DB・RLS・認可・監査の変更なし。
- Freshservice本番は読み取り専用。写真・ロゴ・アイコン素材は複製していない。
- Evidenceに実PII・Secretを含めない。

## 6. 残課題

- サポート専用レイアウトは `/portal` のみ。カタログ・ナレッジ・チケット詳細はエージェント用シェルのまま。
- ヒーロー検索はヘルプ記事のみ。チケット・サービス・記事の横断検索は未実装。
- Freshserviceの写真に相当するビジュアルは、ブランドグラデーションで代替している。
- ジャーニー/登録解除などSOLVIに存在しないタブは追加していない。

## 7. Evidence一覧

- `desktop-portal.png` / `desktop-portal-full.png`: 1440×900のサポートポータル
- `desktop-support-menu.png`: ハンバーガーメニュー
- `desktop-support-user-menu.png`: ユーザーメニュー
- `desktop-portal-requests.png`: 申請タブ
- `desktop-portal-services.png`: サービスタブ
- `mobile-portal.png`: 375×812
- `summary.json`: カード、タブ、検索、メニュー、モバイル、axe
- `run.log`: 実行ログ
