# WP-P2-UIX-027 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-027`
- 対象: 運営状況ダッシュボードのスコアカードとチャート
- 変更範囲: 表示層のみ(API・DB・認可・監査は未変更)

## 1. 実装内容

- `/ops/overview` をFreshservice風のダッシュボードに変更。
  - 淡い背景に6つのスコアカード。
  - 優先度の内訳(最優先/高/中/低)のドーナツチャート。
  - 状況の内訳(受付済み/担当決定/対応中/確認・対応待ち)のドーナツチャート。
  - 担当グループの絞り込みに追従。
  - 0件時は「対象のチケットはありません」を表示。
  - 一覧取得失敗時はチャートだけエラー表示。
- 外部チャートライブラリは追加せず、`DonutChart` のインラインSVGで描画。
- ドーナツは色だけで区別せず、凡例にラベルと件数を表示。

## 2. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | 6つのスコアカード | 充足 | `desktop-overview.png` |
| 2 | 2つのドーナツと凡例 | 充足 | `summary.json` の `charts` |
| 3 | グループ絞り込みに追従 | 充足 | `desktop-overview-ungrouped.png`, `summary.json` |
| 4 | 0件時に壊れた円を描かない | 充足 | `desktop-overview-empty.png`, `summary.json` の `emptyGroup` |
| 5 | 取得失敗時も他は残る | 充足 | チャートだけを `chartError` で分岐 |
| 6 | 既存のリンク・期限一覧 | 充足 | `desktop-overview.png` |
| 7 | 800px以下で1列 | 充足 | `mobile-overview.png` |
| 8 | axe | 充足 | `summary.json` (違反0) |
| 9 | typecheck / lint / check:all | 充足 | §3 |
| 10 | API・DB変更なし | 充足 | `git diff --stat` |

## 3. 実行した検証

```sh
npm run typecheck
# 成功
npm run lint
# 成功
npm run check:all
# 成功(WP 90件 / 621ポイント)

node .local/ui-check-027.mjs
# axe: /ops/overview 違反0
# 優先度: 最優先0 / 高0 / 中4 / 低5 (合計9)
# 状況: 受付済み5 / 担当決定0 / 対応中4 / 確認・対応待ち0 (合計9)
# インフラ担当: 0件 -> 「対象のチケットはありません」を2つ表示
```

## 4. セキュリティ影響

- API・DB・RLS・認可・監査の変更なし。
- チャートは件数と区分のみ。チケット本文・依頼者名は出さない。
- Evidenceは合成データのみ。

## 5. 残課題

- チャートは一覧APIの先頭50件から表示時に集計している。全件の正確な分布が必要になったら、読み取り専用の集計APIを別WPで追加する。
- 期間別推移、CSAT、エージェント別ランキング、ドラッグ&ドロップ編集は未実装。
- スコアカードの「取得処理完了」は画面全体の取得時刻であり、チャートの取得時刻とは別。

## 6. Evidence一覧

- `desktop-overview.png`: 1440×900のダッシュボード
- `desktop-overview-ungrouped.png`: グループ未割当の絞り込み
- `desktop-overview-empty.png`: 0件の空状態
- `mobile-overview.png`: 375×812のダッシュボード
- `summary.json`: axe結果、チャート件数、空状態
- `run.log`: 実行ログ
