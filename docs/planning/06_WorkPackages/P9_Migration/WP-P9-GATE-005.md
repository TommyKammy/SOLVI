---
project: SOLVI
doc_id: "WP-P9-GATE-005"
title: "Gate C Build/Hybrid/Buy Decision"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p9", "gate"]
source_of_truth: false
implementation_status: "not-started"
phase: "P9"
workstream: "GATE"
risk: "critical"
story_points: 8
depends_on: ["WP-P9-OPS-003", "WP-P9-ADP-004"]
requirement_ids: ["BR-002", "BR-003", "BR-004", "BR-005", "BR-006"]
aliases: ["WP-P9-GATE-005"]
---

# Gate C Build/Hybrid/Buy Decision

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

Function、Quality、Safety、Ops、Cost、Satisfactionを比較し最終判断。

## 2. Requirement IDs

- `BR-002`
- `BR-003`
- `BR-004`
- `BR-005`
- `BR-006`

## 3. Dependencies

- [[WP-P9-OPS-003]]
- [[WP-P9-ADP-004]]

## 4. Scope / Allowed Paths

- `99_Project_Files`
- `00_Index`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Decision paper
- TCO
- Risk summary
- Metric comparison
- Residual backlog
- Approval

## 7. Acceptance Criteria

- [ ] 3案同一指標比較
- [ ] 重大Risk明示
- [ ] Next plan
- [ ] Decision owner sign

## 8. Verification and Evidence

- Evidence audit
- Stakeholder review
- Decision record

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
Gate C Build/Hybrid/Buy Decisionを実装し、AcceptanceとEvidenceを満たしてください。
このWork PackageのScopeに限定してください。依存WPが未完了なら実装せず報告してください。
実装後は変更File、Migration、検証CommandとResult、未解決事項、Security影響、Evidence保存先を提示してください。
```

## 11. Definition of Done

- [ ] Acceptanceをすべて満たす。
- [ ] Riskに応じたUnit/Integration/E2E/Security Testが通る。
- [ ] DB変更にMigrationとCompatibility説明がある。
- [ ] API、Runbook、Architecture、RTMを更新する。
- [ ] 未解決Critical/Highがない。
- [ ] 必要なHuman Reviewを完了する。
- [ ] Execution LogとEvidenceを追記する。

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
