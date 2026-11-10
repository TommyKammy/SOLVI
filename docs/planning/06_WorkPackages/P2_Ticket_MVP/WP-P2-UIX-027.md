---
project: SOLVI
doc_id: "WP-P2-UIX-027"
title: "運営状況ダッシュボードのスコアカードとチャート"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "dashboard"]
source_of_truth: true
implementation_status: "done"
story_points: 5
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-001", "NFR-UX-002", "NFR-UX-003", "NFR-UX-004", "NFR-PERF-001"]
depends_on: ["WP-P2-UIX-025", "WP-P2-UIX-026", "WP-P2-PERF-020"]
---

# WP-P2-UIX-027: 運営状況ダッシュボードのスコアカードとチャート

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 5 |
| Suggested Owner | Frontend + Product Owner |
| Parallelizable | Yes(UIX-026完了後) |
| Gate | Gate A |

## 1. Purpose

Freshserviceのダッシュボードに寄せて、`/ops/overview` にスコアカードと優先度・状況の内訳チャートを置く。
集計は既存のチケット一覧API(最大50件)から表示時に行い、新しいAPIやDB集計は追加しない。

## 2. Requirement IDs

`NFR-UX-001`, `NFR-UX-002`, `NFR-UX-003`, `NFR-UX-004`, `NFR-PERF-001`

## 3. Dependencies

[[WP-P2-UIX-025]], [[WP-P2-UIX-026]], [[WP-P2-PERF-020]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/ops/overview/page.tsx`
- `apps/web/src/components/DonutChart.tsx`
- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-027.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-027/`

## 5. Out of Scope

- 新しい集計API・DBビュー・マテリアライズドビュー
- 期間別の履歴チャート、CSAT、エージェント別ランキング
- ドラッグ&ドロップによるダッシュボード編集
- 外部チャートライブラリの追加

## 6. Deliverables

- 優先度のドーナツチャート(最優先/高/中/低)
- 状況のドーナツチャート(受付済み/担当決定/対応中/確認・対応待ち)
- チャートの凡例・件数・空状態・取得失敗表示
- スコアカードとチャートのレスポンシブ配置
- スクリーンショットとaxe結果

## 7. Acceptance Criteria

- [ ] `/ops/overview` に6つのスコアカードが表示される。
- [ ] 優先度と状況の2つのドーナツチャートが表示され、凡例にラベルと件数が出る。
- [ ] チャートは担当グループの絞り込みに追従し、見出しに表示範囲が出る。
- [ ] チケットが0件のとき、チャートは「対象なし」を表示し、壊れた円を描かない。
- [ ] 一覧取得に失敗したとき、チャートだけがエラー表示になり、スコアカードと期限一覧は残る。
- [ ] 既存のスコアカードのリンク、期限一覧、再読み込みが従来どおり動作する。
- [ ] 800px以下でチャートが1列に積まれる。
- [ ] axeで `/ops/overview` にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- 1440×900と375×812の `/ops/overview` スクリーンショット
- グループ絞り込み後のスクリーンショット
- axe結果
- `summary.json` にチャートの件数と合計を記録

Evidence: `evidence/WP-P2-UIX-027/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。既存APIの認可範囲を越えない。
- チケット本文・依頼者名はチャートに出さない(件数と区分のみ)。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

Migrationなし。`overview/page.tsx` と `DonutChart.tsx`、CSSの変更を戻す。

## 11. Codex app Prompt

```text
WP-P2-UIX-027だけを実装してください。API/DBは変更しない。
- /ops/overview に優先度・状況のドーナツチャートを追加する。
- 既存の6スコアカードと期限一覧を壊さない。
- 0件・取得失敗・モバイルを確認する。
- typecheck/lint/check:all/axeを実行しEvidenceを保存する。
```

## 12. Definition of Done

- [ ] §7をすべて満たす
- [ ] §8のEvidenceを保存した
- [ ] API/DB変更なしを確認した
- [ ] WP台帳・RTM・Dependency Map・MANIFESTを更新した
- [ ] Execution Logへ追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-027/20261110-1340/` | Freshservice UI移植の第3段階。 |

### 2026-11-10 の実行結果

- 変更ファイル:
  - `apps/web/src/app/ops/overview/page.tsx`
  - `apps/web/src/components/DonutChart.tsx`(新規)
  - `apps/web/src/app/freshservice.css`
- Migration: なし。API/DB/認可/監査の変更なし。
- 検証:
  - `npm run typecheck` 成功
  - `npm run lint` 成功
  - `npm run check:all` 成功
  - axe: `/ops/overview` 違反0
  - チャート: 優先度(最優先0/高0/中4/低5)、状況(受付済み5/担当決定0/対応中4/確認・対応待ち0)
  - 0件グループ: 「対象のチケットはありません」を2つ表示
- セキュリティ影響: なし。
- 未解決事項: 全件集計API、期間推移、CSAT、エージェント別ランキング。
- Rollback: `overview/page.tsx`、`DonutChart.tsx`、`freshservice.css` の変更を戻す。
