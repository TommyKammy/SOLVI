---
project: SOLVI
doc_id: "WP-P6-SYNC-004"
title: "Intune/Graph Asset Sync"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p6", "sync"]
source_of_truth: false
implementation_status: "not-started"
phase: "P6"
workstream: "SYNC"
risk: "high"
story_points: 8
depends_on: ["WP-P6-REC-003", "WP-P4-ENTRA-006"]
requirement_ids: ["FR-AST-004"]
aliases: ["WP-P6-SYNC-004"]
---

# Intune/Graph Asset Sync

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

Read-onlyで端末属性を取得しOwnershipに従い反映。

## 2. Requirement IDs

- `FR-AST-004`

## 3. Dependencies

- [[WP-P6-REC-003]]
- [[WP-P4-ENTRA-006]]

## 4. Scope / Allowed Paths

- `packages/connectors/entra`
- `services/worker`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Read connector
- Delta cursor
- Field ownership
- Job status
- Throttle

## 7. Acceptance Criteria

- [ ] 最小Read permission
- [ ] Manual属性非上書き
- [ ] Partial failure再開

## 8. Verification and Evidence

- Contract fixture
- Tenant sync
- Reconciliation report

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
Intune/Graph Asset Syncを実装し、AcceptanceとEvidenceを満たしてください。
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
