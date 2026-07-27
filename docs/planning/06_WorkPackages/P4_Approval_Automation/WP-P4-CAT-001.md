---
project: SOLVI
doc_id: "WP-P4-CAT-001"
title: "Service CatalogとForm Definition"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p4", "cat"]
source_of_truth: false
implementation_status: "not-started"
phase: "P4"
workstream: "CAT"
risk: "high"
story_points: 13
depends_on: ["WP-P2-TKT-001"]
requirement_ids: ["FR-CAT-001", "FR-CAT-002", "FR-CAT-003"]
aliases: ["WP-P4-CAT-001"]
---

# Service CatalogとForm Definition

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

Catalog Itemと型付きFormをVersion管理しRequest生成。

## 2. Requirement IDs

- `FR-CAT-001`
- `FR-CAT-002`
- `FR-CAT-003`

## 3. Dependencies

- [[WP-P2-TKT-001]]

## 4. Scope / Allowed Paths

- `packages/domain`
- `apps/api`
- `apps/web`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Catalog schema
- Form schema
- Validation
- Publication
- Portal UI

## 7. Acceptance Criteria

- [ ] Server validation
- [ ] Definition version固定
- [ ] Publication condition適用

## 8. Verification and Evidence

- Property test
- E2E

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
Service CatalogとForm Definitionを実装し、AcceptanceとEvidenceを満たしてください。
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
