# WP-P2-UIX-026 実行記録

- 日付: 2026-11-10
- ブランチ: `wp/WP-P2-UIX-026`
- 対象: チケット一覧・詳細のFreshservice化
- 変更範囲: 表示層のみ(API・DB・認可・監査は未変更)

## 1. 実装内容

### チケット一覧 `/ops`
- 左に一覧、右に絞り込みの2カラム(1100px超)。1200px以下では絞り込みを一覧の下へ移動。
- 一覧の列を「問い合わせ / 依頼者 / 状況 / 優先度 / 担当 / グループ / SLAの目安 / 受付日」に変更。
- 状況セルの下に「次の対応・待ち先」を補助表示。
- 絞り込みフォームを右パネル用の縦並びレイアウトに変更(`TicketFilters`の`variant="panel"`)。
- キーワード・担当・期限・並び順・詳細条件・ページングは既存のURLパラメータを維持。

### チケット詳細 `/ops/{id}`
- 上部に「返信する」「関連付け」のクイック操作。
- 「詳細 / やり取り / 返信 / 添付 / 関連・資産・変更」のアンカータブ。
- 右パネルに「プロパティ」見出しを追加。
- アンカーが`<details>`を指したとき、その節を開く`HashOpenDetails`を追加。

## 2. 受入基準の充足

| # | 基準 | 結果 | 証拠 |
|---|---|---|---|
| 1 | 1100px以上で2カラム | 充足 | `desktop-ops.png` |
| 2 | 1100px未満で絞り込みが下へ、横スクロールなし | 充足 | `mobile-ops-filters.png` |
| 3 | 一覧の8列表示 | 充足 | `desktop-ops.png` |
| 4 | 絞り込み・並び順・ページングが従来どおり | 充足 | §3のfilters結果 |
| 5 | 詳細のアンカータブ | 充足 | `summary.json`の`detailAnchor`/`detailOpen` |
| 6 | 右パネルの「プロパティ」 | 充足 | `desktop-ticket-detail.png` |
| 7 | 既存操作が変わらず動作 | 充足 | `tools/smoke_ticket_flow.mjs`成功 |
| 8 | axeでserious/criticalなし | 充足 | `summary.json` |
| 9 | typecheck / lint / check:all | 充足 | §3 |
| 10 | API・DB・Migration変更なし | 充足 | `git diff --stat` |

## 3. 実行した検証

```sh
npm run typecheck
# 成功

npm run lint
# 成功

npm run check:all
# 成功(WP 89件 / 616ポイント)

node .local/ui-check-026.mjs
# axe: /ops, /ops/{id} ともに違反0
# 絞り込み:
#   keyword=VPN            -> 3件
#   assignment=unassigned  -> 4件
#   sort=deadline          -> 7件・期限が近い順
# 詳細タブ: #ticket-relations へ移動し、details が open=true

SOLVI_SMOKE_PASSWORD=local-dev-password-1 node --env-file=.env tools/smoke_ticket_flow.mjs
# 成功: INC-2026-000005
# 作成・割当・対応開始、公開返信と解決、同時更新409、越境404、
# 内部メモ非公開、再開、カーソル、DB永続化・監査を確認
```

## 4. セキュリティ影響

- API・DB・RLS・認可・監査・Executorの変更なし。
- 表示するのは既存APIが返す範囲のみ。
- Evidenceに実PII・Secretを含めない(合成データのみ)。

## 5. 残課題

- 一覧の一括選択・一括更新・CSVエクスポートは未実装(Freshserviceにはあるが、SOLVIの業務操作として未定義)。
- 詳細のタブはアンカー方式。タブごとに独立した画面(遅延読み込み)にはしていない。
- モバイルの一覧テーブルは横スクロールする。カード表示への切替は後続WP。
- 右フィルタパネルの「基本的な絞り込み/高度な絞り込み」タブ分割は、既存の「詳細な条件」開閉で代替している。

## 6. Evidence一覧

- `desktop-ops.png`: 1440×900の一覧
- `desktop-ticket-detail.png`: 1440×900の詳細
- `mobile-ops.png`: 375×812の一覧
- `mobile-ops-filters.png`: 375×812の絞り込みパネル
- `mobile-ticket-detail.png`: 375×812の詳細
- `summary.json`: axe結果・絞り込み結果・アンカー検証
