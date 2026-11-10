---
project: SOLVI
doc_id: "WP-P2-UIX-031"
title: "運営状況の背景をFreshservice準拠に修正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-11-10"
updated: "2026-11-10"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ui", "bugfix", "dashboard"]
source_of_truth: true
implementation_status: "done"
story_points: 1
risk: "low"
workstream: "UIX"
phase: "P2"
requirement_ids: ["NFR-UX-002", "NFR-UX-003"]
depends_on: ["WP-P2-UIX-027"]
---

# WP-P2-UIX-031: 運営状況の背景をFreshservice準拠に修正

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UIX |
| Risk | low |
| Story Points | 1 |
| Suggested Owner | Frontend |
| Parallelizable | Yes |
| Gate | Gate A |

## 1. Purpose

`/ops/overview` だけコンテンツ面が青(#EFF6FF)になっていた。
FreshserviceのダッシュボードをREAで再確認すると、**左レールと上部バーだけが淡い青**で、
**コンテンツ面は白(#FFFFFF)** だった。運営状況も同じ構造に戻す。

## 2. Requirement IDs

`NFR-UX-002`, `NFR-UX-003`

## 3. Dependencies

[[WP-P2-UIX-027]]

## 4. Scope / Allowed Paths

- `apps/web/src/app/freshservice.css`
- `docs/planning/06_WorkPackages/P2_Ticket_MVP/WP-P2-UIX-031.md`
- `docs/planning/06_WorkPackages/06.0_WorkPackage_Register.md`
- `docs/planning/06_WorkPackages/06.1_Dependency_Map.md`
- `docs/planning/03_Requirements/03.18_Requirements_Traceability_Matrix.md`
- `docs/planning/MANIFEST.md`
- `evidence/WP-P2-UIX-031/`

## 5. Out of Scope

- ダッシュボードのカード構成・チャート・集計ロジックの変更
- 左レール・上部バーの色変更
- API・DB・認可の変更

## 6. Deliverables

- `.fs-dashboard` の透明背景オーバーライドを削除し、標準の白いコンテンツ面へ戻す
- カードは背景色ではなく境界線と影で区切る
- 修正前後のスクリーンショットと画素サンプル

## 7. Acceptance Criteria

- [ ] `/ops/overview` のコンテンツ面が白(#FFFFFF)になる。
- [ ] 左レールと上部バーは淡い青(#EFF6FF)のまま。
- [ ] スコアカード・チャートカード・期限一覧が白い面でも境界線/影で区別できる。
- [ ] 他の画面の背景は変わらない。
- [ ] axeで `/ops/overview` にserious/criticalの違反がない。
- [ ] `npm run typecheck`、`npm run lint`、`npm run check:all`が通る。
- [ ] API・DB・Migrationの変更がない。

## 8. Verification and Evidence

- REAで取得済みのFreshserviceダッシュボード画像の画素サンプル:
  - コンテンツ面: `#FFFFFF` (x=100,y=200 / x=700,y=200 / x=1430,y=200)
  - 左レール: `#EFF6FF` (x=30,y=120)
- SOLVIの修正前後スクリーンショット
- axe結果
- Evidence: `evidence/WP-P2-UIX-031/<YYYYMMDD-HHMM>/`

## 9. Security and Audit

- 表示層のみ。認可・RLS・監査の変更なし。
- Evidenceに実PII・Secretを含めない。

## 10. Rollback / 失敗時の扱い

`freshservice.css` の変更を戻す。Migrationなし。

## 11. Codex app Prompt

```text
WP-P2-UIX-031だけを実装してください。
- /ops/overview の透明背景オーバーライドを削除し、白いコンテンツ面に戻す。
- レール/上部バーの青は維持する。
- 他の画面に影響させない。
- axe/typecheck/lint/check:allを実行する。
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
| 2026-11-10 | Codex | - | Done | `evidence/WP-P2-UIX-031/20261110-1510/` | 利用者報告: 運営状況だけ背景が青い。 |

### 2026-11-10 の実行結果

- 変更ファイル: `apps/web/src/app/freshservice.css`
- REA再確認: Freshserviceダッシュボードはコンテンツ面 `#FFFFFF`、レール/上部バー `#EFF6FF`。
- 修正: `.fs-dashboard` の透明背景オーバーライドを削除し、標準の白いコンテンツ面へ戻した。
- 検証:
  - SOLVIコンテンツ面 `#FFFFFF`、レール `#EFF6FF`、上部バー `#EFF6FF`
  - axe `/ops/overview` 違反0
  - `npm run typecheck` / `npm run lint` / `npm run check:all` 成功
- セキュリティ影響: なし。CSSのみ。
- Rollback: `freshservice.css` の変更を戻す。
