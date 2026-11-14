# WP-P4-APR-018 修正C(画面の2点)のEvidence

- 日時: 2026-11-14 21:48〜21:55 (JST)
- ブランチ: `wp/WP-P4-APR-018`(変更は作業ツリーに未コミット)
- 対象: 再割当の欄のレイアウト、再割当の成功表示の条件
- 環境: 開発スタック(127.0.0.1:3000 / 3001)、開発用DB `solvi`(Migration 40件・最大 `0040`)
- 合成アカウント: `org_admin@acme.example.test`(画面を見るだけ。書込みなし)

## 重要: レイアウトの画像はハーネスである

開発用DBに書き込まずに「承認者不在の申請」の行を作れないため、`harness-*` の画像は
**レイアウトハーネス**である。稼働中の `/ops/approvals` を組織管理者で開き、
実際の `globals.css` が適用された状態で、`#approval-unavailable` の中だけを
実装と同じ表・同じ行構造(申請の行 + `colspan=6` の欄の行)に置き換えて撮っている。
ナビゲーションとページ全体のCSSは実画面のままである。

`live-*` の画像は、稼働中の画面を**開いて見ただけ**の実測である。
開発用DBへの書込みは、ログインによる `session`・監査イベント以外に無い。

## レイアウトの実測(ハーネス、Chromium / WebKit 共通)

| 項目 | 1440px | 375px |
|---|---:|---:|
| 理由の欄(textarea)の幅 | 672px | 301px |
| 欄全体(details)の幅 | — | 301px |
| 操作の列の幅 | 90px | — |
| 申請の行の高さ(欄を閉じた状態) | 64px | — |
| 欄の行の高さ(閉じた状態) | 56px | — |
| 比較: 承認ルールの表の行の高さ | 84px(2行の内容) | — |
| 文書の幅 / viewport | 1440 / 1440 | 375 / 375(横溢れなし) |

- 申請の行の直後に `<td colspan="6">` の行を置き、その中に `details` / `summary` を置いた。
  欄は操作の列の中に無い(`inOperationCell: false`)。
- `summary` の次は `form` で、DOMの順序で隣り合う(`summaryNextIsForm: true`)。
- `summary` の表示は `再割当（申請番号 REQ-2026-000999）`。`details` にも
  `aria-label="申請番号 REQ-2026-000999 の再割当"` を付け、申請番号をラベルに含めた。
  開閉はキーボードの Enter で動いた(`keyboardOpened: true`、両エンジン)。
- 操作の列は汎用の 7%(実測 90px)に戻し、`colgroup` は外した。詳細リンクだけなので足りる。
- チェック欄は 24×24px のまま。

## 成功表示の条件と文(実画面)

- `?reassigned=01a1d9e6-aeee-7000-ab55-7b36b732073f`(B2 で再割当した合成の申請)
  - 表示: `段1の承認者は「サンプル株式会社 agent」に再割当されました(2026年11月14日 20:58)。`
  - 詳細APIの `routeGenerations` のうち、世代2以上の最新の記録(段・新しい承認者・作成日時)から組み立てた。
- `?reassigned=01a1d774-2407-7000-b286-1430d9b49664`(再割当の記録が無い既存の申請)
  - 成功の表示は出ない(`fakeSuccessShown: false`、両エンジン、1440/375)。
- 不正なID(`not-a-uuid`)は詳細を読まず、取得失敗時は成功もエラーも出さない(unit で固定)。
- 注: 詳細APIは申請番号を返さない。表示する値は詳細APIの応答だけから取る制約と、
  `services/` を変更しない制約のため、文には申請番号を含めていない。
  欄のラベルには一覧APIの申請番号を含めている。

## スクリーンショット

| 状態 | Chromium | WebKit |
|---|---|---|
| ハーネス: 欄を開いた状態 1440/375 | `chromium/harness-reassign-open-*.png` | `webkit/harness-reassign-open-*.png` |
| ハーネス: 失敗の表示 1440/375 | `chromium/harness-reassign-failure-*.png` | `webkit/harness-reassign-failure-*.png` |
| 実画面: 承認者不在0件 1440/375 | `chromium/live-unavailable-empty-*.png` | `webkit/live-unavailable-empty-*.png` |
| 実画面: 成功の表示 1440/375 | `chromium/live-reassigned-success-*.png` | `webkit/live-reassigned-success-*.png` |
| 実画面: 記録が無いID 1440/375 | `chromium/live-reassigned-absent-*.png` | `webkit/live-reassigned-absent-*.png` |

## axe

`#approval-unavailable` を対象に、`wcag2a` / `wcag2aa` / `wcag21aa` / `wcag22aa` で実行。
ハーネスの「開いた状態」「失敗の表示」× 1440px / 375px × Chromium / WebKit の8回、
すべて violations 0(serious / critical も 0)。詳細は `raw/browser-check.json`。

## 検証コマンド

```text
npm run typecheck                              # exit 0
npm run lint                                   # exit 0
npm run check:all                              # exit 0
npx vitest run tests/unit/approval-assertion.test.ts tests/unit/approval-reassign-ui.test.ts \
  tests/unit/approval-reassign.test.ts tests/unit/approval-resolver.test.ts \
  tests/unit/approval-route-ui.test.ts tests/unit/approval-state.test.ts \
  tests/unit/requests-ui.test.ts                # 254 passed / 0 failed
npm run test:unit                              # 34 failed / 4505 passed(4539)
# B2 の基点(34 failed / 4501 passed)と失敗名の集合が一致。新規失敗0。
```

`raw/failure-diff.json` は B2 の `unit-baseline-failures.txt` と今回の失敗行の差。
追加・削除ともに0。

## 開発用DBの件数

`SELECT count(*)` のみ。前後で `role_binding` は 25 のまま、`app_user` は 15 のまま。
すべての表で前後が一致した。`session` と監査イベントは除く。

| テーブル | 前 | 後 |
|---|---:|---:|
| `app_user` | 15 | 15 |
| `role_binding` | 25 | 25 |
| `local_catalog_item` | 25 | 25 |
| `local_service_request` | 16 | 16 |
| `local_request_revision` | 21 | 21 |
| `local_request_approval` | 27 | 27 |
| `local_request_route_generation` | 2 | 2 |
| `local_simulation_receipt` | 8 | 8 |
| `department` | 21 | 21 |
| `department_head` | 7 | 7 |
| `approval_rule` | 13 | 13 |
| `approval_rule_revision` | 19 | 19 |
| `org_member_profile` | 15 | 15 |
| `schema_migration` | 40件・最大 `0040` | 40件・最大 `0040` |

## 変更ファイル(C)

- `apps/web/src/app/ops/approvals/page.tsx`
- `apps/web/src/app/ops/approvals/ReassignForm.tsx`
- `apps/web/src/app/ops/approvals/actions.ts`(コメントのみ)
- `apps/web/src/lib/approval-route.ts`
- `tests/unit/approval-reassign-ui.test.ts`
- `tools/ui_approval_routing_check.mjs`(レイアウトへの追従のみ。実行はしていない)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-018.md`(§13 のみ)

`git status` には段階A/B2の未コミット変更(services/・db/・tests/security など)も残っている。
修正Cで追加した変更は上記だけである。
