# WP-P2-UIX-045 実画面 Evidence (2026-11-18)

UI v2 のホーム(`/ops/overview`)の実装 Evidence。
「今日の対応」の期限別一覧、担当グループの状況、承認待ちカード、通知、
および空・権限なし・部分失敗の表示を確認した。

- Timestamp: 2026-11-18 14:14–14:30 JST
- Branch: `wp/WP-P2-UIX-045`(作業ツリー。コミット前)
- Web(変更後): 本番ビルド(`next build` + `next start`)を 127.0.0.1:3100 で起動。
- Web(変更前): HEAD(UIX-044)の本番ビルドを 127.0.0.1:3102 で起動。
- Web(部分失敗): 127.0.0.1:3103 のプロキシで `/inbox` だけ 503 にし、127.0.0.1:3104 で起動。
- API: `services/api/src/main.ts`(`NODE_ENV=development`、ADR-0019のローカル認証)を 127.0.0.1:3101 で起動。
- DB: 使い捨てDB `solvi_wp045_evidence_test`(colima-solvi の Postgres)。
  Migration 42件を適用し、`tools/seed.mjs` の合成データを投入した。
  **開発用DB `solvi` には接続していない。**
- 利用者: seed の合成ユーザー `org_admin@acme.example.test`(ホーム)、
  `agent@acme.example.test`(空状態)、`requester@acme.example.test`(権限なし)。
  パスワードは `tools/seed.mjs` から読み、出力・保存していない。
- 合成チケット: APIで6件作成し、SLA経過秒数と担当グループだけをDBで調整した
  (`fixture.json`)。承認待ちは合成の `vpn-demo` カタログ項目から1件作成した。
  **すべて合成データで、実在の人物・組織・PIIを含まない。**
- ブラウザ: Chromium headless shell 1248(Playwright 1.62.0)。
  axe の規則は `wcag2a/2aa/21a/21aa/22aa`。
- テーマ: Playwright の `colorScheme` でOS設定をライト/ダークに切り替えた。

## 結果

**20スキャン(変更前4 + 変更後16)で axe の違反 0件。serious/critical も 0。**
375pxの横はみ出し 0、コンソールエラー 0、テーマ属性の不一致 0。
変更後16スキャンはすべて `/ops/overview` が最終URL(ログインへ戻されていない)。

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

## 対象画面

| slug | 内容 | 利用者 | 幅 | テーマ |
|---|---|---|---|---|
| `overview` | 今日の対応・承認待ち・通知 | org_admin | 1440 / 375 | light / dark |
| `overview-empty` | 自分・承認・通知が空 | agent | 1440 / 375 | light / dark |
| `overview-partial-error` | `/inbox` だけ 503 | org_admin | 1440 / 375 | light / dark |
| `overview-requester` | staff以外の権限なし | requester | 1440 / 375 | light / dark |
| `before/overview` | UIX-044時点の旧ホーム | org_admin | 1440 / 375 | light / dark |

- 変更後: `screens/<theme>-<width>-<slug>.png`
- 変更前: `before/<theme>-<width>-overview.png`
- axe: `axe/<theme>-<width>-<slug>.json`(変更後の16スキャンのみ)
- TL-12: `tl12/01-login.png` 〜 `04-ticket-detail.png`(期限超過行は `04-overdue-row.png`)

## §7 の充足確認

| WP §7 の基準 | 結果 |
|---|---|
| `/ops/overview` を置き換え、見出しに自分の未完了件数と期限別件数 | 見出し「今日の対応は 6件です」、`解決期限超過 2件 / 今日 1件 / 今週 2件` |
| 自分の担当を期限の早い順に並べ、超過/今日/今週に分ける | APIは `assignment=mine` + 未完了4状態 + `sort=deadline`。行は 1日2時間超過 → 2時間超過 → 今日17:11 → 11/19(木) → 11/20(金) の順 |
| 期限は日本時間、今週は日曜0:00〜土曜24:00 | `tests/unit/operations-overview.test.ts` で日付跨ぎ・土曜23:59:59・日曜0:00・日曜始まりの週を固定 |
| 期限超過は `--danger`、今日は `--warn`、色だけに頼らない | `data-due` と文字「1日2時間超過」「今日 17:11」。axeのコントラスト違反 0 |
| 担当グループは `api.ticketOverview` の未完了・超過を横棒で表示 | `未完了 7件` / `解決期限超過 2件(未完了の29%)`。`OperationsGroupSelect` も残存 |
| 承認待ちは `api.inbox` の `request_approval` / `change` から1件、確定はしない | `VPN アクセス申請（模擬）` をカード表示。リンクは `/requests/...`。`/decisions` を呼ぶフォームは0。注意書きあり |
| 承認待ち・通知・チケットがないときの空表示 | `overview-empty` に3つの空表示。`summary.json` の `checks.empty` |
| 失敗した部分だけエラー、ほかは表示 | `overview-partial-error` で承認・通知だけエラー。一覧5行と横棒2本は表示 |
| API呼び出し数が変更前より増えない | ページのデータ取得は4回(`listGroups` / `ticketOverview` / `listTickets` / `inbox`)。旧ページも4回。`tests/unit/performance-overview.test.ts` で固定 |
| staff以外は権限がない旨 | `overview-requester` に「この画面を表示する権限がありません。」。データ取得0回 |
| 一覧の見出しと区切りをスクリーンリーダーが読める | `h3`「解決期限超過」「今日」「今週」と `aria-labelledby`。文字でも期限を示す |
| typecheck / lint / check:all / §4のテスト | `logs/` を参照。lintのみ既知の3件(下記) |
| axeで両テーマ serious/critical 0 | `summary.json` の `totals` |

## TL-12

`summary.json` の `checks.tl12`。

1. `/login` を開く(544ms)
2. 合成 org_admin でログイン → `/inbox`(773ms)。現在のログイン後の着地は `/inbox`
3. サイドバーの「運営状況」→ `/ops/overview`(921ms)
4. 期限超過の行「WP45合成: 期限を1日過ぎたアカウント申請」を押す
5. `/ops/01a1ed16-...?returnTo=%2Fops%2Foverview` の詳細へ(1170ms)。見出しが同じ件名

## 実行した検証

| コマンド | 結果 | ログ |
|---|---|---|
| `npm run typecheck` | 成功 | `logs/typecheck.txt` |
| `npm run lint` | **失敗(既知の3件のみ)** | `logs/lint-full.txt` |
| `git ls-files ... \| xargs eslint --max-warnings=0 --no-warn-ignored` | 成功 | `logs/lint-tracked-files.txt` |
| 変更4ファイルの `eslint` | 成功 | `logs/lint-changed-files.txt` |
| `npm run check:all` | 成功 | `logs/check-all.txt` |
| `npx vitest run tests/unit/operations-overview.test.ts tests/unit/performance-overview.test.ts tests/unit/navigation-ui.test.ts tests/unit/ui-contrast-and-focus.test.ts` | 101件成功 | `logs/vitest-targeted.txt` |
| `npm run test:unit` | 116ファイル / 4807成功・26 skip | `logs/test-unit.txt` |
| `next build`(変更後の一時コピー) | 成功 | `logs/next-build.txt` |

`npm run lint` の3件は `.claude/worktrees/*/apps/web/next-env.d.ts`(git管理外の
ローカルworktree)の triple-slash-reference である。本WPの変更ファイルではない。
追跡対象のファイルだけのlintは成功している。

## 変更前後

| 変更前(UIX-044) | 変更後 |
|---|---|
| 件数カード6つ、優先度・状況のドーナツ、期限一覧 | 今日の対応(3区切り)、担当グループの横棒、承認待ち、通知 |
| `before/light-1440-overview.png` | `screens/light-1440-overview.png` |
| `before/dark-375-overview.png` ほか | `screens/dark-375-overview.png` ほか |

## コントラスト

`contrast.md` に11.3 §4のトークンを使った組み合わせをライト/ダーク両方で記載した。
本文・補足・期限超過・今日・承認カード・ホバー行・主ボタンはすべて4.5:1以上。

## ファイル

| パス | 内容 |
|---|---|
| `summary.json` | 全スキャン、挙動確認、TL-12、totals |
| `axe/<theme>-<width>-<slug>.json` | 変更後16スキャンのaxe結果(すべて空) |
| `screens/` | 変更後16画面 |
| `before/` | UIX-044時点の4画面 |
| `tl12/` | ログイン→ホーム→期限超過→詳細の5枚 |
| `fixture.json` | 合成チケット・承認のIDと可視件数 |
| `contrast.md` | コントラスト比 |
| `logs/` | typecheck / lint / check:all / vitest / test:unit / build |
| `capture.mjs.txt` | 撮影・axe・TL-12のスクリプト(実行時は `.mjs` にコピー) |
| `setup_fixture.mjs.txt` | 使い捨てDBの合成データ投入(実行時は `.mjs` にコピー) |
| `inbox_failure_proxy.mjs.txt` | `/inbox` だけ503にするプロキシ |
| `run_stack.sh` | API + 変更前後Web + プロキシの起動例 |

## 実装上の判断

- 担当グループ切替は「担当グループの状況」だけを絞る。個人の一覧は、選択中のグループに
  かかわらず常に自分の担当(`assignment=mine`)を表す。WP §1の「自分の担当」と
  「担当グループの状況」を混ぜないため。
- 通知は `api.inbox` の業務更新を表示する。`api.notifications` を追加するとページの
  API呼び出しが5回になるため使っていない。外部への通知送信は行わない。
- ページのデータ取得は4回(`listGroups` / `ticketOverview` / `listTickets` / `inbox`)。
  旧ホームも4回で、`tests/unit/performance-overview.test.ts` で固定した。

## 実行していないこと

- WebKit の実画面撮影(axeはChromiumのみ)。
- 実機の iOS / Android。375px・タッチ有効・`pointer: coarse` で代用した。
- スクリーンリーダー実機での読み上げ確認。
- 実DBの性能測定(p95)。API呼び出し数の固定はユニットテストで確認した。
- 変更前のaxe(比較のため変更後のみ)。

## 未解決事項(スコープ外)

- 左サイドバーのラベルは「運営状況」のまま。`apps/web/src/lib/navigation-groups.ts` は
  §4 Allowed Paths の外なので変更していない。
- `tools/e2e/operations_overview_flow.mjs` は旧ホームの `.overview-*` を前提にしており、
  このWPでは更新していない(§4の外)。別WPで追随が必要。
- 見出しの個人名(「◯◯さん」)は出していない。`SessionView` に表示名が無く、
  追加のAPI呼び出しを増やさないため。
- 「通知」は `api.inbox` の業務更新を表示している。`api.notifications` を追加すると
  ページのAPI呼び出しが5回になるため使っていない。
- 承認待ちが複数ある場合、カードは1件だけ出し、残りは業務受信箱へのリンクにしている。
