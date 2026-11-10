# WP-P2-UIX-029 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-029`
- 対象: 管理画面のカードグリッド化
- 変更範囲: 表示層のみ(API・DB・認可・監査は未変更)

## 1. 実装内容

- `/ops/admin` を追加し、Freshserviceの管理ホーム風のカードグリッドにした。
  - アカウント設定: カタログ管理、通知状況(org_adminのみ)、資産CSV取込
  - ユーザー管理: 利用者管理、担当グループ、アクセスレビュー
- 左レールの「管理」を `/ops/admin` へ変更し、フライアウトに「管理ホーム」を追加。
- 管理権限がない利用者にはカードを出さず、権限がない旨を表示。
- カードは既存画面へのリンクだけ。新しい管理機能は追加していない。

## 2. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | org_adminで管理カードが表示される | 充足 | `desktop-admin.png`, `summary.json` |
| 2 | 権限なしはカードを出さない | 充足 | `desktop-admin-denied.png`, `summary.json` の `agent.cards=0` |
| 3 | 既存管理画面へのカード | 充足 | `summary.json` の `orgAdmin.cards` |
| 4 | org_adminのみ通知状況カード | 充足 | `orgAdmin.cards` に通知状況を含む。platform_adminの`notifications=false`は既存の単体テストで確認済み |
| 5 | レールの管理が`/ops/admin`、現在地 | 充足 | `railHref=/ops/admin`, `breadcrumb=管理 管理ホーム` |
| 6 | 800px以下で1列 | 充足 | `mobile-admin.png` |
| 7 | axe | 充足 | `summary.json` (違反0) |
| 8 | typecheck / lint / check:all | 充足 | §3 |
| 9 | API・DB変更なし | 充足 | `git diff --stat` |

## 3. 実行した検証

```sh
npm run typecheck
# 成功
npm run lint
# 成功
npm run check:all
# 成功

node .local/ui-check-029.mjs
# axe: /ops/admin 違反0
# org_admin cards: カタログ管理, 通知状況, 資産CSV取込, 利用者管理, 担当グループ, アクセスレビュー
# groups: アカウント設定, ユーザー管理
# railHref: /ops/admin
# agent cards: 0 / 「管理画面を表示する権限がありません。」
```

## 4. セキュリティ影響

- 表示層のみ。管理APIの認可は既存のまま。
- カードを隠すことを認可にしない。API側の権限検査は残る。
- Evidenceは合成データのみ。実PII・Secretなし。

## 5. 残課題

- platform_admin専用の管理カード(テナント横断操作)は、その機能自体が未実装のため出していない。
- 管理ホームの検索・お気に入り・最近使った項目は未実装。
- Freshserviceにしかない設定(アカウントモード、プラン、デバイス等)は追加していない。

## 6. Evidence一覧

- `desktop-admin.png`: 1440×900の管理ホーム(org_admin)
- `mobile-admin.png`: 375×812の管理ホーム
- `desktop-admin-denied.png`: 権限なし(agent)の表示
- `summary.json`: カード一覧、グループ、レール、axe結果
- `run.log`: 実行ログ
