# WP-P2-UIX-028 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-028`
- 対象: ポータル・ナレッジ・カタログのFreshservice化
- 変更範囲: 表示層のみ(API・DB・認可・監査は未変更)

## 1. 実装内容

### `/portal`
- 青いヒーロー(「どういった事でお困りですか？」)とヘルプ記事検索。
- 4つのアクションカード:
  - サービスを申請する → `/catalog`
  - 障害を報告する → `/tickets/new?kind=incident`
  - ヘルプ記事を閲覧する → `/knowledge`
  - 承認を確認する → `/requests?view=mine`
- 既存の「あなたの問い合わせ」「最近の申請」セクションは維持。

### `/knowledge`
- 左サイドバー: すべての記事 / ナレッジ管理 / 記事を作成 / タグ(表示中の記事から最大12件)。
- 記事一覧を表形式(タイトル、状態、公開範囲、版、更新日、タグ)へ変更。
- 検索語はタイトル・本文・タグにハイライトされ、タグを押すと `q=` 検索へ移動。
- 既存の検索・ページング・管理/公開の導線を維持。

### `/catalog`
- 左サイドバー: すべてのアイテム / 対象カテゴリ(公開サービスの `targetLabel`)。
- サービスをカードグリッドで表示。アイコン、説明、対象、詳細への矢印。
- 既存の検索・対象絞り込み・ページングを維持。

## 2. 画面確認用の合成データ

UI確認のため、ローカルのSOLVI DBへ以下の合成データを作成した(本番Freshserviceには書き込んでいない)。

- ナレッジ公開記事3件:
  - VPN に接続できないときの確認手順 (VPN, ネットワーク, リモートワーク)
  - パスワードの再設定方法 (アカウント, パスワード, ログイン)
  - プリンターを追加する手順 (プリンター, 端末, 設定)
- カタログ公開サービス3件:
  - PC利用申請 [ノートPC] (PC・周辺機器)
  - 業務アカウント発行申請 (アカウント)
  - ネットワーク共有フォルダー申請 (ネットワーク)

これらは画面確認用であり、seedやリポジトリの一部ではない。

## 3. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | ポータルのヒーローと検索 | 充足 | `desktop-portal.png`, `mobile-portal.png` |
| 2 | 4つのアクションカード | 充足 | `desktop-portal.png` |
| 3 | ナレッジの左カテゴリ/タグ | 充足 | `desktop-knowledge.png`, `summary.json` |
| 4 | ナレッジの表形式と検索/ページング | 充足 | `desktop-knowledge.png`, `desktop-knowledge-tag.png` |
| 5 | カタログの左カテゴリ | 充足 | `desktop-catalog.png`, `summary.json` |
| 6 | カタログのカードグリッドと絞り込み | 充足 | `desktop-catalog.png`, `desktop-catalog-category.png` |
| 7 | 800px以下で左ナビが上に積まれる | 充足 | `mobile-knowledge.png`, `mobile-catalog.png` |
| 8 | axeで3画面に違反なし | 充足 | `summary.json` |
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

node .local/ui-check-028.mjs
# axe: /portal, /knowledge, /catalog 違反0
# ナレッジ: タグ9件、VPN検索で1件
# カタログ: カテゴリ3件、カード3件、PC・周辺機器で1件
```

## 5. セキュリティ影響

- API・DB・RLS・認可・監査の変更なし。
- ナレッジの公開範囲(`audience`)と状態は既存APIの値をそのまま表示。
- Evidenceは合成データのみ。実PII・Secretなし。

## 6. 残課題

- ナレッジのカテゴリ/フォルダはDBに存在しないため、タグをカテゴリ代わりにしている。
- カタログの「最も人気」は閲覧数・申請数を持たないため表示していない。
- ポータルの検索はヘルプ記事のみ。チケット・サービス・記事の横断検索は未実装。
- モバイルのナレッジは左ナビが上に積まれるため、タグは6件まで表示し、残りはデスクトップ幅で見る。

## 7. Evidence一覧

- `desktop-portal.png` / `mobile-portal.png`
- `desktop-knowledge.png` / `desktop-knowledge-tag.png` / `mobile-knowledge.png`
- `desktop-catalog.png` / `desktop-catalog-category.png` / `mobile-catalog.png`
- `summary.json`: axe結果、タグ、カテゴリ、カード数
- `run.log`: 実行ログ
