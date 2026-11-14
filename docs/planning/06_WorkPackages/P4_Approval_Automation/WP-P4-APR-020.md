---
project: SOLVI
doc_id: "WP-P4-APR-020"
title: "代理承認(期間限定の委任と、原承認者・代理者の記録)"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-14"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "delegation"]
source_of_truth: true
implementation_status: "not-started"
story_points: 5
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-006"]
depends_on: ["WP-P4-APR-018"]
---

# WP-P4-APR-020: 代理承認(期間限定の委任と、原承認者・代理者の記録)

> [!warning] この文書は骨子のみ(`status: draft`、2026-11-14)。実装の根拠にしない。下の `要確認` を決め、ADRの要否を判断してから `baseline` へ上げる。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | No |
| Gate | Gate B(GB-3) |

## 1. Purpose

FR-CAT-006(代理承認)を実装する。承認者が、期間を限って、自分宛ての承認を別の人に任せられるようにする。[[WP-P4-APR-017]] の §6-1 を分けたものである。

## 2. Requirement IDs

`FR-CAT-006`

## 3. Dependencies

[[WP-P4-APR-018]](現在の経路の導出と実行前検証の拡張の上に載せる)。

## 4. Scope / Allowed Paths

`要確認`(baseline へ上げる際に確定する)。見込み: `db/migrations/`、`services/api/src/modules/catalog/`、`services/api/src/modules/inbox/inbox.routes.ts`、`services/api/src/common/audit/audit.ts`、`packages/shared/src/catalog.ts`、`apps/web/src/app/ops/approvals/`、`apps/web/src/app/requests/`、`tests/unit/approval-delegation.test.ts`、`tests/security/approval-delegation.test.ts`、本WP、`evidence/WP-P4-APR-020/`。

## 5. Out of Scope

- 高リスク二重承認([[WP-P4-APR-021]])。ただし「独立性は決定者で数える」前提を崩さないこと([[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §5)。
- 代理者のさらなる委任(再委任)。経路の差し替え(代理は経路を変えない)。

## 6. Deliverables

1. `approval_delegation`(組織・原承認者・代理者・開始と終了・範囲・作成者・取消。RLS付き)。期間の上限を設ける。
2. 決定時の検証: 代理者が決定する場合、委任が決定時点で有効であること、代理者が「有効な所属」であること、原承認者がそのステップの承認者であり [[ADR-0023_Relationship_Based_Approval_Authority]] §2 を満たすことを検証する。
3. 記録: `decided_by`(代理者)と `approver_id`(原承認者)の両方を、ステップの行と監査イベントに残す。経路(`route`)と `route_hash` は変えない。
4. 自己承認・重複の防止: 申請者が代理者として自分の申請を決定できない。同じ人が、代理を使って同じ申請の複数の段を決定できない。
5. 一覧・詳細の可視性: 代理者は、有効な委任の範囲の承認待ちを見られる。
6. 監査イベント: `approval.delegated`(委任の作成・取消)。決定のイベントに原承認者と代理者の両方を含める。

### 実体化の際に決めること(`要確認`)

- 委任を作れるのは誰か(原承認者本人、`org_admin`、その両方)。本人が作る委任は承認権限の付与と同格の特権操作になるため、ADRの要否を判断する(§1.9)。
- 代理者の資格: `fixed` の段は `approver` ロールを持つ人に限るか。関係ベースの段(上長・部署長)の代理を認めるか。
- 範囲の単位(すべて / カタログ項目ごと)。期間の上限。
- 実行前検証(`assertApprovalComplete`)が、決定時点の委任の有効性をどう検証するか(委任の行を参照するか、ステップの行に委任のIDを固定するか)。
- 代理者が後から無効になった場合の扱い(承認済みステップは [[ADR-0023_Relationship_Based_Approval_Authority]] §7 と同じく有効のままとするか)。

## 7. Acceptance Criteria

- [ ] 代理期間外・代理範囲外・取り消された委任での承認が拒否される。
- [ ] 有効な代理での承認が、原承認者と代理者の両方を含む監査イベントとして記録される。
- [ ] 申請者本人が代理者として自分の申請を承認する経路(UI/API/代理経由)が、すべて拒否される。
- [ ] 同じ人が、代理を使って同じ申請の2つの段を決定できない。
- [ ] 委任の作成・取消が、権限の無いロールと他組織から拒否される。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態機械)、TL-06(承認者スコープ・代理範囲)、TL-16

### Evidence

- 代理の拒否ログ(全経路分)、監査イベントの記録

`evidence/WP-P4-APR-020/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3 の対象。**Security Reviewer(人間)の sign-off 必須**。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)。
- 生成する監査イベント: `approval.delegated`。

## 10. Rollback / 失敗時の扱い

委任の機能を止めると、代理者は決定できなくなり、原承認者による決定へ戻る。代理で承認済みのステップは有効のまま残る。新しいテーブルの down はデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
このWPは骨子のみ(draft)である。baselineへ上がるまで実装しない。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration(up/down)とロールバック方針、既存データ互換の説明
- [ ] 関連ドキュメント(02.17・03.5・RTMのStatus)の更新
- [ ] Security Reviewer(人間)のsign-off(必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
