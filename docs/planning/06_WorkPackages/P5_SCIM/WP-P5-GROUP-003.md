---
project: SOLVI
doc_id: "WP-P5-GROUP-003"
title: "SCIM Group/Membership"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p5", "group"]
source_of_truth: false
implementation_status: "not-started"
phase: "P5"
workstream: "GROUP"
risk: "high"
story_points: 13
depends_on: ["WP-P5-SCIM-001", "WP-P5-USER-002"]
requirement_ids: ["FR-IDM-005", "FR-IDM-003"]
aliases: ["WP-P5-GROUP-003"]
---

# SCIM Group/Membership

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

Group CRUD/PATCHとRole Mappingを実装。

## 2. Requirement IDs

- `FR-IDM-005`
- `FR-IDM-003`

## 3. Dependencies

- [[WP-P5-SCIM-001]]
- [[WP-P5-USER-002]]

## 4. Scope / Allowed Paths

- `packages/scim`
- `packages/authorization`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Groups endpoint
- Membership patch
- Role map
- Reconciliation

## 7. Acceptance Criteria

- [ ] Add/remove再送収束
- [ ] 未知Group fail closed
- [ ] Large membership paging

## 8. Verification and Evidence

- Fixtures
- Concurrency
- Mapping security

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
SCIM Group/Membershipを実装し、AcceptanceとEvidenceを満たしてください。
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
