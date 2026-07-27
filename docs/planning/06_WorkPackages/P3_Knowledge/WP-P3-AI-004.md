---
project: SOLVI
doc_id: "WP-P3-AI-004"
title: "根拠付き回答案PoC"
category: "06_WorkPackages"
type: "work-package"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p3", "ai"]
source_of_truth: false
implementation_status: "not-started"
phase: "P3"
workstream: "AI"
risk: "high"
story_points: 8
depends_on: ["WP-P3-SRCH-002", "WP-P3-LINK-003"]
requirement_ids: ["FR-AI-003", "FR-AI-004", "BR-005"]
aliases: ["WP-P3-AI-004"]
---

# 根拠付き回答案PoC

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**該当Phase開始2週間前**までに実体化します。
> 現時点で確定している内容は、リンク先の`baseline`文書を参照してください。

## 1. 目的

許可Articleから回答案を作りAgentが編集送信。

## 2. Requirement IDs

- `FR-AI-003`
- `FR-AI-004`
- `BR-005`

## 3. Dependencies

- [[WP-P3-SRCH-002]]
- [[WP-P3-LINK-003]]

## 4. Scope / Allowed Paths

- `services/ai-advisor`
- `apps/api`
- `apps/web`

## 5. Out of Scope

- 後続Phaseの本格機能

## 6. Deliverables

- AI adapter
- Prompt version
- Context builder
- Citation UI
- Feedback

## 7. Acceptance Criteria

- [ ] 根拠不足は回答不能
- [ ] Article/Version表示
- [ ] 自動送信なし
- [ ] AI停止可能

## 8. Verification and Evidence

- Golden questions
- Hallucination review
- Kill switch

EvidenceにはCommand、Environment、Commit SHA、Result、Timestamp、ScreenshotまたはLog URIを含める。

## 9. Security and Audit

- Organization境界とRoleを検証する。
- 状態変更はAudit Eventを生成する。
- Secret、Token、PIIをLog、Prompt、Ticketへ出力しない。
- 特権操作はApproval、期限、Allowlist、Idempotency、Receiptを検証する。

## 10. Codex app Prompt

```text
根拠付き回答案PoCを実装し、AcceptanceとEvidenceを満たしてください。
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
