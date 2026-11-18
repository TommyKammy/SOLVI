---
project: SOLVI
doc_id: "WP-P2-UIX-045"
title: "UI v2のホーム(今日の対応・承認待ち・担当グループの状況)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-18"
updated: "2026-11-18"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004", "NFR-PERF-001"]
depends_on: ["WP-P2-UIX-044", "WP-P2-UIX-027"]
---

# WP-P2-UIX-045: UI v2のホーム(今日の対応・承認待ち・担当グループの状況)

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | UIX-046と並行できる(触るファイルが重ならない) |
| Gate | Gate A |

## 1. Purpose

staffの着地画面 `/ops/overview`(運営状況)を、UI v2の「今日の対応」型のホームに作り替える。
**集計・認可・APIは変えない。** 既存APIの結果の並べ方と見た目だけを変える。

画面構成(見本: `assets/ui/SOLVI_UI_v2_Mockup.html` のホーム):

- 見出し:「◯◯さん、今日の対応は N件です」と、期限ごとの件数(解決期限超過・今日が期限・今週)
- 自分の担当の未完了チケットを、解決期限で「解決期限超過/今日/今週」に分けた一覧
- 担当グループの状況(既存の運営状況スコアカードの値を横棒で表示)
- 右列:あなたの承認待ち(1件をカードで表示)、通知

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`, `NFR-PERF-001`

## 3. Dependencies

[[WP-P2-UIX-044]], [[WP-P2-UIX-027]]

UIX-044のシェルとトークンが完了していること。

## 4. Scope / Allowed Paths

- `apps/web/src/app/ops/overview/page.tsx`
- `apps/web/src/components/DonutChart.tsx`
- `apps/web/src/lib/operations-overview.ts`
- `apps/web/src/app/freshservice.css`
- `tests/unit/operations-overview.test.ts`
- `tests/unit/performance-overview.test.ts`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-045.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-045/`

## 5. Out of Scope

- API・DB・集計ロジック・認可の変更
- SLA達成率(%)の表示。既存APIに達成率がないため、件数で表す(§14)
- 承認の判断をホームから直接行うこと。カードは既存の承認画面へのリンクにする
- requesterのホーム(`/portal`)の変更
- AIによる要約・提案の表示

## 6. Deliverables

- 「今日の対応」の見出しと、期限ごとに分けた一覧
- 担当グループの状況(横棒)
- 承認待ちカードと通知の右列
- 読み込み中・空・権限なし・取得失敗の表示([[11.11_UI_State_and_Error_Model]] に従う)
- Evidence(両テーマ、1440×900と375×812)

- [x] 新しいホームは `/ops/overview` を置き換える(パスと着地先は変えない)。`/ops/overview` を開くと、見出しに自分の担当の未完了件数と、期限ごとの件数(解決期限超過・今日・今週)が出る。件数は一覧APIで読み込めた分から数え、読み込みが上限で切れたときはその旨(「期限の近いN件のうち…」)を示す(§14)。
- [x] 一覧は、自分の担当の未完了チケットを解決期限の早い順に並べ、「解決期限超過/今日/今週」に分ける。区切りは日本時間で、「今週」は日曜0:00〜土曜24:00とする(今日より後で今週中のもの)。各行に番号・件名・担当グループ・期限が出て、行からチケット詳細へ移れる。
- [x] 期限超過の行は `--danger`、今日が期限の行は `--warn` で表す。色だけに頼らず、文字(「2時間超過」など)でも伝える。
- [x] 担当グループの状況は、既存の `api.ticketOverview` の値(未完了・解決期限超過)を使う。既存の担当グループ切替(`OperationsGroupSelect`)は残す。
- [x] 承認待ちカードは、`api.inbox` の項目のうち、承認者向けに分類されたもの(`request_approval`、および自分が承認者に指名された `change`)から1件を出す。自分が起票・担当しているだけの変更は出さない。ボタンは既存の承認画面へ移るリンクにし、ホームでは承認を確定しない。カードに「承認の確定は承認者が行います」と書く。
- [x] 承認待ちがないとき、通知がないとき、チケットがないときに、それぞれ空の表示が出る。
- [x] 取得に失敗した部分だけがエラー表示になり、ほかの部分は表示される。
- [x] ページのAPI呼び出し数が、変更前より増えない(`performance-overview` テストで確認)。
- [x] staff以外が開いたときは、従来どおり権限がない旨を出す。
- [x] 一覧の見出しと区切りは、スクリーンリーダーで「解決期限超過」「今日」「今週」と読み上げられる。
- [x] `npm run typecheck`、`npm run lint`、`npm run check:all`、§4のテストが通る。
- [x] axeで `/ops/overview` を両テーマで検査し、serious/criticalの違反がない。

## 8. Verification and Evidence

- TL-12: ログイン→ホーム→期限超過の行→チケット詳細
- TL-13: axe(両テーマ)
- `evidence/WP-P2-UIX-045/<YYYYMMDD-HHMM>/` に、変更前後のスクリーンショット、検証コマンドと結果、axeの結果を保存する。

## 9. Security and Audit

- 表示層だけの変更。承認の確定・状態の変更をホームから行う経路を作らない。
- 承認待ちカードの表示は `api.inbox` の結果だけに基づく。表示の有無を認可の代わりにしない。
- Evidenceには実データ・実PIIを含めない。

## 10. Rollback / 失敗時の扱い

Migrationはない。`ops/overview/page.tsx` と関連CSSをUIX-044完了時点に戻せばよい。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。WP-P2-UIX-045だけを実装してください。
正本: AGENTS.md、本WP、docs/planning/assets/ui/SOLVI_UI_v2_Mockup.html(ホーム)、既存の /ops/overview 実装。
既存APIの結果の並べ方と見た目だけを変え、API呼び出し数を増やさないこと。
承認の確定をホームから行わないこと。新規npm依存を追加しないこと。
完了時は、変更ファイル・検証コマンドと結果・§7の充足状況・セキュリティ影響・未解決事項・Evidenceの保存先を報告すること。
```

## 12. Definition of Done

- [x] §7をすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] 関連ドキュメントを更新した
- [x] Product Ownerの承認を得た
- [x] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | Claude | - | Draft | `assets/ui/SOLVI_UI_v2_Mockup.html` | UI v2のWP案として起草した。 |
| 2026-11-18 | Product Owner | - | Baseline | - | 未決事項の決定を反映し、baselineとして承認。 |
| 2026-11-18 | Codex | - | Review | `evidence/WP-P2-UIX-045/20261118-1414/` | UI v2ホームを実装。§7の12項目を満たし、axe serious/critical 0。Product Owner承認待ち。 |
| 2026-11-18 | Codex | - | Review fix | `evidence/WP-P2-UIX-045/20261118-1414/logs/review-fix.txt` | レビュー指摘3件(承認待ちの全件数、SLA計測停止中、通知の既読)を修正。API呼び出しは4回のまま。 |
| 2026-11-18 | Codex | - | Review fix 2 | `evidence/WP-P2-UIX-045/20261118-1414/logs/review-fix-2.txt` | 見出しの件数を読み込んだ範囲だけから数え、切り詰め時は範囲と全件リンクを明示。一覧行をパネル幅のコンテナクエリで縦積みに変更。API呼び出しは4回のまま。 |

### 実装記録 (2026-11-18 / Codex)

**変更ファイル**

- `apps/web/src/app/ops/overview/page.tsx` — ホームへ置き換え(見出し・期限別一覧・担当グループの横棒・承認待ち・通知・空/失敗/権限なし)
- `apps/web/src/lib/operations-overview.ts` — 自分の担当のAPI条件、日本時間の日付/週境界、期限別の分類、承認待ちの分類とリンク検証
- `apps/web/src/app/freshservice.css` — ホームの表示だけを追加(トークン参照。影なし・1pxの線)
- `apps/web/src/components/DonutChart.tsx` — 削除(§14によりホームからドーナツを外したため、参照元が無くなった)
- `tests/unit/operations-overview.test.ts` — 日本時間の境界、分類、承認待ちの分類・リンク検証
- `tests/unit/performance-overview.test.ts` — ホームのAPI呼び出し4回、部分失敗、空、権限なし
- `evidence/WP-P2-UIX-045/20261118-1414/` — 変更前後、axe、TL-12、検証ログ
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-045.md` — 本記録と status
- `docs/planning/MANIFEST.md` — 再生成

**Migration**

なし。DB・API・集計・認可・監査は変更していない。

**検証コマンドと結果**

```text
npm run typecheck
→ 成功

npm run lint
→ 失敗(既知の3件のみ: .claude/worktrees/*/apps/web/next-env.d.ts の triple-slash-reference)

git ls-files ... | xargs npx eslint --max-warnings=0 --no-warn-ignored
→ 成功

npm run check:all
→ 成功

npx vitest run tests/unit/operations-overview.test.ts tests/unit/performance-overview.test.ts tests/unit/navigation-ui.test.ts tests/unit/ui-contrast-and-focus.test.ts
→ 4ファイル / 101件成功

npm run test:unit
→ 116ファイル / 4807件成功・26件skip

next build (変更後の一時コピー)
→ 成功
```

ブラウザ検証は `evidence/WP-P2-UIX-045/20261118-1414/README.md` を参照。
変更後16スキャン(1440×900 / 375×812 × ライト/ダーク × 通常/空/部分失敗/権限なし)と
変更前4スキャンで、axe serious/critical 0、375pxの横はみ出し0、コンソールエラー0。

**§7 Acceptance Criteria の充足**

| 基準 | 証拠 |
|---|---|
| `/ops/overview` の置き換えと見出しの件数 | `summary.json` の `checks.home.heading` = 「今日の対応は 6件です」、件数3つ |
| 期限の早い順と3区切り、日本時間の週 | ブラウザの行順、`tests/unit/operations-overview.test.ts` の境界テスト |
| 超過 `--danger` / 今日 `--warn`、文字でも表示 | `data-due` と「1日2時間超過」「今日 17:11」、axe違反0 |
| 担当グループの状況と切替 | `checks.home.bars`、`groupSelect: true` |
| 承認待ちカードと確定しないリンク | `checks.home.approval`、`decisionForms: 0` |
| 3つの空表示 | `checks.empty.emptyTexts` |
| 部分失敗 | `checks.partialFailure`(行5・横棒2を維持) |
| API呼び出し4回 | `tests/unit/performance-overview.test.ts` |
| staff以外 | `checks.requester` |
| 見出しの読み上げ | `h3`「解決期限超過」「今日」「今週」と `aria-labelledby` |
| typecheck / lint / check:all / テスト | 上記と `logs/` |
| axe両テーマ serious/critical 0 | `summary.json` の `totals` |

**セキュリティ影響**

表示層のみ。承認の確定・状態変更・監査書込みの経路は追加していない。
承認待ちカードは `api.inbox` の結果だけを使い、リンク先は
`/ops` `/requests` `/changes` のUUIDだけに限定した。AIは関与しない。
新規依存・外部フォント・外部CSS・CDNの読込みは無い。CSPは変更していない。
Evidenceは合成データのみで、パスワード・トークン・Cookieを保存していない。
開発用DB `solvi` には接続していない。

**未解決事項**

- 左サイドバーのラベルは「運営状況」のまま。`apps/web/src/lib/navigation-groups.ts` は
  §4 Allowed Paths の外のため変更していない。
- `tools/e2e/operations_overview_flow.mjs` は旧ホームの `.overview-*` を前提にしており、
  §4の外なので更新していない。別WPでの追随が必要。
- 見出しの個人名は `SessionView` に表示名が無いため出していない(API呼び出しを増やさないため)。
- 「通知」は `api.inbox` の業務更新を使う。`api.notifications` を足すとページのAPI呼び出しが
  5回になるため使っていない。

**Evidence**

`evidence/WP-P2-UIX-045/20261118-1414/`

#### 利用者の承認(2026-11-18)

- **2026-11-18、利用者(Product Owner)が PR #26(本WPの実装)をマージした**(main の `3437c77`)。これをProduct Ownerの承認として扱い、`done` とする。
- 先行して PR #24(UI v2のWPと [[11.3_Design_System]] のbaseline、`80c883b`)と PR #28(npm audit の期限付き例外、`f1eb703`)がマージされている。
- §7 は、Execution Log に記した範囲と未解決事項を含めて、PRのマージにより受け入れられたものとする。
- 残り: サイドバーのラベル「運営状況」の見直し、`tools/e2e/operations_overview_flow.mjs` の新ホームへの追随、見出しへの表示名の追加は、Allowed Paths外のため後続WPで扱う。

## 14. 決定事項(2026-11-18 Product Owner)

- **SLA達成率**: 出さない。未完了・期限超過の件数で表す。
- **「今日」「今週」の区切り**: 日本時間。週は**日曜始まり**(日曜0:00〜土曜24:00)。
- **ホームのパス**: `/ops/overview` を置き換える。運営状況のドーナツグラフは、ホームからは外す。

## 15. 決定事項(2026-11-18 Product Owner、done後の追記)

- **期限ごとの件数**: 一覧APIで読み込めた分だけを数える現状の表示を仕様とする。読み込みが上限で切れたときは「期限の近いN件のうち…」と示し、全件の件数であるかのように見せない。全件を正確に数えるためのAPIの集計は追加しない。
- **承認待ちカードの対象**: 承認者向けに分類された項目(申請承認と、自分が承認者に指名された変更)に限る。§7の文面を実装に合わせて直した。
