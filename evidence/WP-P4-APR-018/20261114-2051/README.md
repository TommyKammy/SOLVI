# WP-P4-APR-018 ブラウザ確認(B2)のEvidence

- 日時: 2026-11-14 20:51〜21:25 (JST)
- ブランチ: `wp/WP-P4-APR-018`(変更は作業ツリーに未コミット)
- 対象: 承認者不在の申請の再割当(画面・API・ロールの一時変更)
- 環境: 開発スタック(127.0.0.1:3000 / 3001)、開発用DB `solvi`(Migration 40件・最大 0040)
- 合成データの目印: ルール `ui018-syn-`、部署 `UI018-SYN-`、カタログ題名・申請理由・再割当理由に `UI018`

## 構成

- `chromium/` / `webkit/`: `summary.json`、1440px・375px のスクリーンショット
- `raw/`: 実行ログ、unit / security のログ、DB件数、ロールの前後、監査イベント、
  レイアウト修正の確認用ハーネスのスクリーンショット
- `../WP-P4-APR-018.md` §13「2026-11-14 ブラウザ確認(B2)」に要約

## 通し確認の結果

| エンジン | 結果 | checks | axe scans |
|---|---|---:|---:|
| Chromium(Chrome 157) | PASS | 6(最終の完了確認) | 8(先行の実行で一覧・失敗の4 scans も0) |
| WebKit 26.5 | PASS | 15 | 10 |

- 承認者不在の一覧 → 再割当の失敗(理由なし・確認なし・上長Aのまま) → 成功 → 詳細 →
  上長Aの拒否 → 上長B・固定承認者の承認 → 模擬完了 → 片付け、まで通した。
- 成功の表示: `段1の承認者を「サンプル株式会社 agent」に再割当しました。`
- 上長Aのままの再割当は `manager_inactive`(「上長が今は有効な所属ではないため…」)で拒否。
  ブリーフが期待した `approver_unchanged`(「再割当後の承認者が今と同じ」)ではない。
- 申請者本人にも再割当の記録(日時・実行者・理由・無効になったステップ・新しい承認者)が見えた。
- 片付け: 上長Aの役割 → ルールの使用 → プロフィール → 部署 → カタログ → ルールの順で完了。

## スクリーンショット

| 状態 | Chromium | WebKit |
|---|---|---|
| 承認者不在の一覧(再割当の欄を開いた状態) 1440/375 | `chromium/approvals-unavailable-reassign-open-*.png` ※修正前の実測 | `webkit/approvals-unavailable-reassign-open-*.png` ※修正前の実測 |
| 失敗の表示 1440/375 | `chromium/reassign-failure-*.png` ※修正前の実測 | `webkit/reassign-failure-*.png` ※修正前の実測 |
| 成功の表示 1440/375 | `chromium/reassign-success-*.png` | `webkit/reassign-success-*.png` |
| 申請の詳細(再割当の記録) 1440/375 | `chromium/request-detail-reassigned-*.png` | `webkit/request-detail-reassigned-*.png` |
| 承認後の詳細 1440/375 | `chromium/request-detail-approved-*.png` | `webkit/request-detail-approved-*.png` |
| 上長A(置き換え後)の詳細 1440/375 | `chromium/request-detail-replaced-manager-*.png` | `webkit/request-detail-replaced-manager-*.png` |
| 修正後の一覧レイアウト(ハーネス) 1440/375 | `raw/layout-fixed-unavailable-*.png` | 同左(共通CSS) |

**レイアウトの注記**: 一覧・失敗のスクリーンショットは、操作列が汎用の7%だった修正前の実測で、
1440px では1文字ずつ折り返す崩れが出ている。修正後は `colgroup` で操作列を24%にし、
モバイルでは `details` をセル幅へ広げた。同じ表・同じCSSを使うハーネスで、
操作列の実測幅が 1440px: 257px / 375px: 325px、横溢れなしを確認した
(`raw/layout-harness.txt`)。unit テストでも列幅の合計100%・操作列22%以上を固定している。

## 修正した不具合

1. 確認のチェックボックスが 16×16px で axe `target-size`(serious)。24×24px にした。
2. 承認者不在の表の操作列が 7% で、再割当フォームとエラーが読めない幅だった。
   `colgroup` で列幅を配分し、モバイルでは `details` を `grid-column: 1 / -1` にした。
3. 再割当の成功後、一覧が最新になって行が消え、成功の表示も消えていた。
   申請IDだけをURL(`reassigned=`)に残して同じ画面へ戻し、サーバー側で
   現在の段と新しい承認者を読み直して成功の文を出すようにした(表示名はURLに載せない)。

変更ファイル: `apps/web/src/app/ops/approvals/{page.tsx,actions.ts,ReassignForm.tsx}`、
`apps/web/src/lib/approval-route.ts`、`tests/unit/approval-reassign-ui.test.ts`、
`tests/unit/approval-route-ui.test.ts`、`tools/ui_approval_routing_check.mjs`。

## axe

- WebKit: 10 scans、violations 0(すべて serious / critical 0)。
- Chromium: 最終の完了確認 8 scans、violations 0。先行の実行で一覧・失敗の4 scans も0。
- ルールの無効化はしていない。検査は `wcag2a` / `wcag2aa` / `wcag21aa` / `wcag22aa`。

## ロールの一時変更

対象: `auditor@acme.example.test`、ロール `auditor`(org)、期限なし。
作業前: 有効な `auditor` 1件。最終: 有効な `auditor` 1件(期限なし・同じ組織)。
`role_binding` は 21 → 25(+4)。増分はすべて同じアカウントの付け直し(期限切れの行が残る)。

| 外した時刻 (UTC) | 戻した時刻 (UTC) | 理由 |
|---|---|---|
| 11:54:50.758 | 11:56:07.816 | 最初の試行(ツールの事後確認が `/users` 前提で失敗) |
| 11:57:07.295 | 11:57:09.537 | axe `target-size` の修正 |
| 11:58:08.913 | 11:58:40.306 | 成功の表示が消える不具合の修正 |
| 12:07:25.004 | 12:07:37.459 | WebKit の通し確認 |

**画面の不具合**: 最後の役割を外した利用者は `/ops/users` の一覧から消え、
画面から役割を戻せない。復元は画面と同じ認証済みの管理API `POST /users/:id/roles` で行った
(直接のSQL変更は無い)。`summary.json` の `roleChange.restoreVia = "management-api"`、
`hiddenFromDirectory = true` に記録。本WPの Allowed Paths 外のため、修正は別WP/Issue。

## 開発用DBの件数

`SELECT count(*)` のみ。前後で `app_user` は 15 のまま。

| テーブル | 前 | 後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 21 | 25 |
| `local_catalog_item` | 23 | 25 |
| `local_service_request` | 14 | 16 |
| `local_request_revision` | 19 | 21 |
| `local_request_approval` | 21 | 27 |
| `local_request_route_generation` | 0 | 2 |
| `local_simulation_receipt` | 6 | 8 |
| `department` | 19 | 21 |
| `department_head` | 7 | 7 |
| `approval_rule` | 11 | 13 |
| `approval_rule_revision` | 17 | 19 |
| `org_member_profile` | 15 | 15 |
| `schema_migration` | 40件・最大 `0040` | 40件・最大 `0040` |

検査後: ルールの使用が有効な組織0件、有効な `ui018-syn-` ルール0件、
有効な `UI018-SYN-` 部署0件、値の入ったプロフィール0件(作業前と同じ)。

残した合成データ:
- Chromium: ルール `01a1d9e6-909c-7000-a629-47706e9058a3`(無効)、
  部署 `01a1d9e6-8552-7000-ab58-e63c8ec4a775`(無効)、
  カタログ `01a1d9e6-9747-7000-b37a-e3f9933f1a34`(非公開)、
  申請 `REQ-2026-000162`(模擬完了)
- WebKit: ルール `01a1d9f4-656c-7000-9e3b-33294fe59f42`(無効)、
  部署 `01a1d9f4-5c43-7000-a979-2851faebc76e`(無効)、
  カタログ `01a1d9f4-6ce6-7000-9eba-df66e87bb604`(非公開)、
  申請 `REQ-2026-000163`(模擬完了)
- 経路世代2件、模擬実行の証跡2件。

## 検証コマンド

```text
npm run typecheck                              # exit 0
npm run lint                                   # exit 0
npm run check:all                              # exit 0
npx vitest run tests/unit/(承認の6ファイル)       # 221 passed / 0 failed
npx vitest run tests/security/approval-reassign.test.ts   # 38 passed
npx vitest run tests/security/(承認の10ファイル)          # 285 passed
npm run test:unit                              # 34 failed / 4501 passed(4535)
# 基点(34 failed / 4500 passed / 4534)と失敗名が一致。新規失敗0。
```

security テストの接続先は使い捨てDB `solvi_wp018_wp015_test`(名前に `wp018` を含む)。
接続文字列・パスワードは記録していない。

## `tools/ui_approval_routing_check.mjs`

既存の WP-P4-APR-016 の段階(`full` / `b2` / `cleanup` / `verify` など)は変更せず、
`wp018` / `wp018resume` / `wp018cleanup` を追加した。上限(両エンジン合計)を事前確認で強制し、
再実行は読み取りの照合または片付けに切り替える。

## 実行できなかった確認

- 組織管理者が申請者本人の場合の再割当の表示は、追加の書込み(2人目の org_admin の申請など)が
  必要になるため、ブラウザでは作っていない。`tests/unit/approval-reassign-ui.test.ts` で
  自分の行に操作を出さず案内を出すことを固定している。
- 修正後の一覧・失敗の実フローのスクリーンショットは、上限(ルール2・部署2・カタログ2)に
  達したため再取得していない。同じ表・CSSのハーネスと unit テストで確認した。
- `approver_unchanged` の文は、通常の組織データでは再解決が先に失敗するため到達しない。

**注**: `chromium/summary.json` の `writes` は最後のフェーズのカウンタであり、
再試行・片付けで上書きされた累計ではない。累計は上の DB 件数と監査イベント
(`raw/audit-events.txt`)を正とする。
