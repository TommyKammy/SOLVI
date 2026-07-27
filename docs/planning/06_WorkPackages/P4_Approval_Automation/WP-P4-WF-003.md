---
project: SOLVI
doc_id: "WP-P4-WF-003"
title: "Workflow RunとTransactional Outbox"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p4", "wf"]
source_of_truth: false
implementation_status: "not-started"
phase: "P4"
workstream: "WF"
risk: "high"
story_points: 13
depends_on: ["WP-P4-APR-002", "WP-P1-AUD-004"]
requirement_ids: ["FR-AUT-001", "NFR-OPS-003"]
aliases: ["WP-P4-WF-003"]
---

# Workflow RunとTransactional Outbox

> [!note] スコープ変更(2026-07-27 / DL-007)
> Transactional Outbox の**基盤**(`outbox_event`テーブル、ディスパッチャ、リトライ、失敗記録)は
> [[WP-P2-NTF-005]] で実装済みです。本WPはその上に Workflow Run の状態機械・Command発行・
> 補償処理を載せる範囲になります。着手時に見積り(13pt)を再評価してください。

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

申請→Approval→Command→Notificationの永続Workflowを実装。

## 2. Requirement IDs

- `FR-AUT-001`
- `NFR-OPS-003`

## 3. Dependencies

- [[WP-P4-APR-002]]
- [[WP-P1-AUD-004]]

## 4. Scope / Allowed Paths

- `packages/workflow`
- `services/worker`
- `database`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- Workflow schema
- Handlers
- Outbox
- Worker
- Retry/Timeout/Cancel

## 7. Acceptance Criteria

- [ ] State/Outbox原子的
- [ ] Worker restart継続
- [ ] Duplicate収束

## 8. Verification and Evidence

- Crash/restart
- Rollback
- Concurrency

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
Workflow RunとTransactional Outboxを実装し、AcceptanceとEvidenceを満たしてください。
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
