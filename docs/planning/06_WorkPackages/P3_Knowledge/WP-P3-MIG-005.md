---
project: SOLVI
doc_id: "WP-P3-MIG-005"
title: "Freshservice Knowledge移行試行"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p3", "mig"]
source_of_truth: false
implementation_status: "not-started"
phase: "P3"
workstream: "MIG"
risk: "medium"
story_points: 5
depends_on: ["WP-P3-KNW-001"]
requirement_ids: ["BR-002", "FR-KNW-001"]
aliases: ["WP-P3-MIG-005"]
---

# Freshservice Knowledge移行試行

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

公開ArticleのExtract/Transform/Link/Attachment/Visibility品質を検証。

## 2. Requirement IDs

- `BR-002`
- `FR-KNW-001`

## 3. Dependencies

- [[WP-P3-KNW-001]]

## 4. Scope / Allowed Paths

- `scripts/migration`
- `99_Project_Files`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Mapping
- Importer
- Dry-run
- Sample migration
- Reconciliation

## 7. Acceptance Criteria

- [ ] Source ID保持
- [ ] 欠落/文字化けReport
- [ ] Re-run重複なし

## 8. Verification and Evidence

- 30 article review
- Count/hash

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
Freshservice Knowledge移行試行を実装し、AcceptanceとEvidenceを満たしてください。
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
