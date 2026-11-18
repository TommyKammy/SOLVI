# WP-P2-UIX-046 実画面 Evidence (2026-11-18)

UI v2 のチケット一覧(`/ops`)、業務受信箱(`/inbox`)、チケット詳細(`/ops/[id]`)の実装 Evidence。
絞り込みボタンの押下状態、共通表、社内メモの区別、右側のプロパティと履歴、
返信送信、両テーマの axe を確認した。

- Timestamp: 2026-11-18 14:58–15:35 JST
- Branch: `wp/WP-P2-UIX-046`(作業ツリー。コミット前)
- Web(変更後): 本番ビルド(`next build` + `next start`)を 127.0.0.1:3100 で起動。
- Web(変更前): HEAD(UIX-045)の本番ビルドを 127.0.0.1:3102 で起動。
- API: `services/api/src/main.ts`(`NODE_ENV=development`、ADR-0019のローカル認証)を 127.0.0.1:3101 で起動。
- DB: 使い捨てDB `solvi_wp046_evidence_test`(colima-solvi の Postgres)。
  Migration 42件を適用し、`tools/seed.mjs` の合成データを投入した。
  **開発用DB `solvi` には接続していない。**
- 利用者: seed の合成ユーザー `org_admin@acme.example.test`。
  パスワードは `tools/seed.mjs` から読み、出力・保存していない。
- 合成データ: チケット8件、公開返信・社内メモ・公開返信の3コメント、
  合成の変更1件、合成の承認1件(`fixture.json`)。
  **すべて合成データで、実在の人物・組織・PIIを含まない。**
- ブラウザ: Chromium headless shell 1248(Playwright 1.62.0)。
  axe の規則は `wcag2a/2aa/21a/21aa/22aa`。
- テーマ: Playwright の `colorScheme` でOS設定をライト/ダークに切り替えた。

## 結果

**32スキャン(変更前16 + 変更後16)で axe の違反 0件。serious/critical も 0。**
375pxのページ全体の横はみ出し 0。変更後の表は領域内だけで横スクロールする。
コンソールエラー 0、テーマ属性の不一致 0。

```json
{
  "scans": 32,
  "seriousOrCritical": 0,
  "anyViolationNodes": 0,
  "overflow375": [],
  "redirectedToLogin": [],
  "consoleErrorScans": [],
  "themeAttributeMismatches": []
}
```

375pxの表(変更後、ライト/ダーク共通):

| 画面 | 表示領域 | 表の幅 | 領域内スクロール |
|---|---:|---:|---|
| `/ops` | 343px | 1040px | あり |
| `/ops?...&assignment=unassigned` | 343px | 1040px | あり |
| `/inbox` | 343px | 940px | あり |

## 対象画面

| slug | 内容 | 幅 | テーマ |
|---|---|---|---|
| `ops` | 絞り込みボタンと罫線だけの表 | 1440 / 375 | light / dark |
| `ops-filter` | 「担当者未割当」を押した状態(`aria-pressed=true`) | 1440 / 375 | light / dark |
| `inbox` | チケット・申請承認・変更が混在する1つの表 | 1440 / 375 | light / dark |
| `ticket-detail` | 社内メモと返信が混在、履歴あり | 1440 / 375 | light / dark |
| `before/ops` | UIX-045時点の一覧 | 1440 / 375 | light / dark |
| `before/ops-filter` | UIX-045時点の未割当shortcut | 1440 / 375 | light / dark |
| `before/inbox` | UIX-045時点の受信箱 | 1440 / 375 | light / dark |
| `before/ticket-detail` | UIX-045時点の詳細 | 1440 / 375 | light / dark |

- 変更後: `screens/<theme>-<width>-<slug>.png`
- 変更前: `before/<theme>-<width>-<slug>.png`
- axe: `axe/<theme>-<width>-<slug>.json`(変更後16スキャン。変更前も同じ条件で実行し、
  `summary.json` の `scans` に0件として残る)
- TL-12: `tl12/01-login.png` 〜 `06-reply-sent.png`

## §7 の充足確認

| WP §7 の基準 | 結果 |
|---|---|
| `/ops` の絞り込みボタンは `OPERATIONS_METRICS` と同じクエリ | 6ボタンの `href` は `operationsMetricQuery`。`summary.json` の `checks.ops.chips` に6件のURLを記録 |
| 押した状態は `aria-pressed` | 「担当者未割当」を押すと `false` → `true`。他5件は `false`。`checks.opsFilter` |
| 一覧の列 | 番号・件名・状態・優先度・担当グループ・担当者・解決期限・依頼者・受付日。`checks.ops.headers` |
| 状態・優先度の表示名は `labels.ts` | `stateLabel` / `priorityLabel` を使用。表の値は「受付済み」「最優先」など |
| 優先度は色の点と文字 | `data-priority` で `critical`=danger、`high`=warn、`medium/low`=muted。文字は「最優先」「高」「中」「低」 |
| 解決期限超過は色と文字 | `2時間超過` を `--danger` で表示。読み上げ用に「解決期限超過」も付与 |
| 表は `TableRegion`、狭い幅は表だけ横スクロール | `TableRegion` + `table-scroll--plain`。`contain: paint` でページ全体への漏れを防ぎ、375pxで `overflow375: []` |
| 社内メモの区別 | `comment.internal` の背景を `--panel`、左罫線を `--side-brand`、ラベル「社内メモ（依頼者には表示されません）」。`checks.detail.internalNotes` |
| 返信・社内メモ・解決、送信後の表示と競合時 | `ReplyForm` の props と `sendReply` は変更なし。TL-12で「返信を保存しました。」を確認。競合表示のコードは変更していない |
| 右側の項目一覧と `TicketRoutingForm` | プロパティ(状態・優先度・解決期限・担当グループ・担当者・依頼者・受付日時・関連資産)。`TicketRoutingForm` は送信ボタン式で、候補は `availableGroups` のみ。自由入力のIDなし。`checks.detail.routing` |
| 履歴は既存の取得結果を新しい順 | 起票・解決・コメント・添付を新しい順に表示。`checks.detail.historyNewestFirst: true` |
| `/inbox` は同じ表の見た目、共通列、種類ラベル | 1つの表。列は番号・件名・種類・状態・期限・次の対応。種類は「チケット」「申請承認」「変更」。`checks.inbox.kindSet` |
| 既存のUIX-026の受け入れ条件 | 2カラム(1100px以上)、1100px未満で積む、詳細タブ、プロパティ見出し、引き受け・状態遷移・返信・添付・関連・統合のコードを維持。キーワード・担当・期限・並び順・詳細条件・ページングのフォームも維持 |
| typecheck / lint / check:all / §4のテスト | `logs/` を参照。lintのみ追跡外の既知3件 |
| axeで両テーマ serious/critical 0 | `summary.json` の `totals` |

## TL-12

`summary.json` の `checks.tl12`。

1. `/login` を開く(544ms)
2. 合成 org_admin でログイン → `/inbox`(790ms)
3. サイドバーの「チケット対応」→ `/ops`(929ms)
4. 「担当者未割当」を押す → `/ops?state=new&state=assigned&state=in_progress&state=pending&assignment=unassigned`(1102ms)。
   `aria-pressed` は `false` → `true`。
5. 先頭の件名「WP46 合成アクセス申請」→ 詳細(1232ms)
6. `返信する` で合成の返信を送信 → 「返信を保存しました。」(1433ms)。
   コメント 7→8件、履歴 8→9件。

## 実行した検証

| コマンド | 結果 | ログ |
|---|---|---|
| `npm run typecheck` | 成功 | `logs/typecheck.txt` |
| `npm run lint` | **失敗(既知の3件のみ)** | `logs/lint-full.txt` |
| `git ls-files ... \| xargs eslint --max-warnings=0 --no-warn-ignored` | 成功 | `logs/lint-tracked-files.txt` |
| 変更ファイルの `eslint` | 成功 | `logs/lint-changed-files.txt` |
| `npm run check:all` | 成功 | `logs/check-all.txt` |
| `npx vitest run tests/unit/ticket-detail-recovery-ui.test.ts tests/unit/table-regions.test.ts tests/unit/navigation-ui.test.ts tests/unit/ui-contrast-and-focus.test.ts` | 99件成功 | `logs/vitest-targeted.txt` |
| `npm run test:unit` | 116ファイル / 4810成功・26 skip | `logs/test-unit.txt` |
| `next build`(変更後) | 成功 | `logs/next-build-after.txt` |
| `next build`(変更前=UIX-045) | 成功 | `logs/next-build-before.txt` |

`npm run lint` の3件は `.claude/worktrees/*/apps/web/next-env.d.ts`(git管理外の
ローカルworktree)の triple-slash-reference である。本WPの変更ファイルではない。
`.claude` をlint対象外にする変更は §4 Allowed Paths の外なので行っていない。

## 変更前後

| 変更前(UIX-045) | 変更後 |
|---|---|
| 上部のプリセットタブと右側の絞り込みパネル、8列の表 | 6つの絞り込みボタン(`aria-pressed`)、罫線だけの9列の表、条件は折りたたみ |
| 受信箱は「業務・状況・期限・次の対応」の4列 | 番号・件名・種類・状態・期限・次の対応の6列。種類ラベルで1つの表に統合 |
| 詳細は左に本文/やり取り、右に操作の詰め合わせ | 左にやり取り/返信/添付、右にプロパティ/履歴/操作/担当グループ/優先度/関連 |
| `before/light-1440-ops.png` ほか | `screens/light-1440-ops.png` ほか |

## 実装上の判断

- 絞り込みボタンは `Link` に `role="button"` を付けた。移動はURLで行い、
  `aria-pressed` を支援技術へ正しく伝えるためである。キーボードはEnterで移動できる。
- 現在の条件が `OPERATIONS_METRICS` のどれとも一致しない場合は、
  既存の `ticketQueuePreset` で「カスタム条件」と表示する。`check:unwired` の
  本番経路の参照を保つためでもある。
- `/ops` の既定表示ではどのボタンも押下にしない。URLの条件が1つも無い状態を
  「未完了」と読み替えると、完了済みが見えていないことに気付けない。
- 表の列はWP §7の7列に、UIX-026が求める依頼者・受付日を加えた9列にした。
  UIX-026の受け入れ条件を落とさないためである。
- 履歴は既存の取得結果(起票・解決・コメント・添付)だけから作る。
  状態遷移の監査ログを取るAPIはこの画面に無く、追加するとAPI変更になる。
- `contain: paint` を表のスクロール領域に付けた。固定幅の表が文書全体の
  `scrollWidth` に漏れるブラウザ挙動を抑え、375pxのページ横スクロールを0にするためである。

## 実行していないこと

- WebKit の実画面撮影(axeはChromiumのみ)。
- 実機の iOS / Android。375px・タッチ有効・`pointer: coarse` で代用した。
- スクリーンリーダー実機での読み上げ確認。
- 実DBの性能測定(p95)。
- 変更前のaxe個別JSONの保存(変更前も実行し、`summary.json` に0件として記録)。

## 未解決事項(スコープ外)

- 詳細の「カテゴリ」は既存APIが返さないため表示していない。項目追加はAPI変更になる。
- 「関連資産」はプロパティから既存の「関連する問い合わせ・資産・変更」へ移動する
  リンクにした。資産の直接一覧は同節の `TicketAssetPanel` にある。
- `npm run lint` の3件は `.claude/worktrees` 由来。`eslint.config.mjs` は
  §4 Allowed Paths の外なので変更していない。
- `tools/e2e/operations_overview_flow.mjs` など、旧一覧のDOMを前提にするE2Eは
  §4の外なので更新していない。

## ファイル

| パス | 内容 |
|---|---|
| `summary.json` | 全スキャン、挙動確認、TL-12、totals |
| `axe/` | 変更後16スキャンのaxe結果(すべて空) |
| `screens/` | 変更後16画面 |
| `before/` | UIX-045時点の16画面 |
| `tl12/` | ログイン→受信箱→一覧→絞り込み→詳細→返信送信の6枚 |
| `fixture.json` | 合成チケット・コメント・変更・承認のIDと可視件数 |
| `contrast.md` | コントラスト比 |
| `logs/` | typecheck / lint / check:all / vitest / test:unit / build / DB |
| `capture.mjs.txt` | 撮影・axe・TL-12のスクリプト(実行時は `.mjs` にコピー) |
| `setup_fixture.mjs.txt` | 使い捨てDBの合成データ投入(実行時は `.mjs` にコピー) |
| `run_stack.sh` | API + 変更前後Webの起動例 |
