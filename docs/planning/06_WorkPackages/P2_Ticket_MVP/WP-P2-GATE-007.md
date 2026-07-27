---
project: SOLVI
doc_id: "WP-P2-GATE-007"
title: "Gate A Limited Pilot"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p2", "gate"]
source_of_truth: false
implementation_status: "not-started"
phase: "P2"
workstream: "GATE"
risk: "medium"
story_points: 5
depends_on: ["WP-P2-PORTAL-002", "WP-P2-OPS-003", "WP-P2-COLLAB-004", "WP-P2-NTF-005", "WP-P2-SEARCH-006"]
requirement_ids: ["BR-001", "BR-006", "NFR-UX-001"]
aliases: ["WP-P2-GATE-007"]
---

# Gate A Limited Pilot

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

20～30名想定でTicket MVPのUX/運用を評価。

## 2. Requirement IDs

- `BR-001`
- `BR-006`
- `NFR-UX-001`

## 3. Dependencies

- [[WP-P2-PORTAL-002]]
- [[WP-P2-OPS-003]]
- [[WP-P2-COLLAB-004]]
- [[WP-P2-NTF-005]]
- [[WP-P2-SEARCH-006]]

## 4. Scope / Allowed Paths

- `99_Project_Files`
- `11_UI_UX`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Pilot plan
- Feedback
- Metrics
- Defect backlog
- Decision

## 7. Acceptance Criteria

- [ ] 主要Task完了
- [ ] 重大権限不具合0
- [ ] Freshservice比較
- [ ] 継続判断

## 8. Verification and Evidence

- User test
- Support log review
- Metric report

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
Gate A Limited Pilotを実装し、AcceptanceとEvidenceを満たしてください。
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
