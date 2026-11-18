---
project: SOLVI
doc_id: "WP-P2-UIX-045"
title: "UI v2のホーム(今日の対応・承認待ち・担当グループの状況)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-18"
updated: "2026-11-18"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui"]
source_of_truth: true
implementation_status: "not-started"
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

## 7. Acceptance Criteria

- [ ] 新しいホームは `/ops/overview` を置き換える(パスと着地先は変えない)。`/ops/overview` を開くと、見出しに自分の担当の未完了件数と、期限ごとの件数(解決期限超過・今日・今週)が出る。
- [ ] 一覧は、自分の担当の未完了チケットを解決期限の早い順に並べ、「解決期限超過/今日/今週」に分ける。区切りは日本時間で、「今週」は日曜0:00〜土曜24:00とする(今日より後で今週中のもの)。各行に番号・件名・担当グループ・期限が出て、行からチケット詳細へ移れる。
- [ ] 期限超過の行は `--danger`、今日が期限の行は `--warn` で表す。色だけに頼らず、文字(「2時間超過」など)でも伝える。
- [ ] 担当グループの状況は、既存の `api.ticketOverview` の値(未完了・解決期限超過)を使う。既存の担当グループ切替(`OperationsGroupSelect`)は残す。
- [ ] 承認待ちカードは、`api.inbox` の `request_approval` / `change` 項目から1件を出す。ボタンは既存の承認画面へ移るリンクにし、ホームでは承認を確定しない。カードに「承認の確定は承認者が行います」と書く。
- [ ] 承認待ちがないとき、通知がないとき、チケットがないときに、それぞれ空の表示が出る。
- [ ] 取得に失敗した部分だけがエラー表示になり、ほかの部分は表示される。
- [ ] ページのAPI呼び出し数が、変更前より増えない(`performance-overview` テストで確認)。
- [ ] staff以外が開いたときは、従来どおり権限がない旨を出す。
- [ ] 一覧の見出しと区切りは、スクリーンリーダーで「解決期限超過」「今日」「今週」と読み上げられる。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`、§4のテストが通る。
- [ ] axeで `/ops/overview` を両テーマで検査し、serious/criticalの違反がない。

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

- [ ] §7をすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] 関連ドキュメントを更新した
- [ ] Product Ownerの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-18 | Claude | - | Draft | `assets/ui/SOLVI_UI_v2_Mockup.html` | UI v2のWP案として起草した。 |
| 2026-11-18 | Product Owner | - | Baseline | - | 未決事項の決定を反映し、baselineとして承認。 |

## 14. 決定事項(2026-11-18 Product Owner)

- **SLA達成率**: 出さない。未完了・期限超過の件数で表す。
- **「今日」「今週」の区切り**: 日本時間。週は**日曜始まり**(日曜0:00〜土曜24:00)。
- **ホームのパス**: `/ops/overview` を置き換える。運営状況のドーナツグラフは、ホームからは外す。
