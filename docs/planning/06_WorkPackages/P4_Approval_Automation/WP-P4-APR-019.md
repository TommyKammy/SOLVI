---
project: SOLVI
doc_id: "WP-P4-APR-019"
title: "承認期限前の通知・期限切れの記録・承認者不在時のエスカレーション"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-14"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "notification", "escalation"]
source_of_truth: true
implementation_status: "not-started"
story_points: 5
risk: "medium"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-011"]
depends_on: ["WP-P4-APR-018", "WP-P2-NTF-005"]
---

# WP-P4-APR-019: 承認期限前の通知・期限切れの記録・承認者不在時のエスカレーション

> [!warning] この文書は骨子のみ(`status: draft`、2026-11-14)。実装の根拠にしない。[[WP-P4-APR-018]] の完了後に、下の `要確認` を決めて `baseline` へ上げる。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Backend |
| Parallelizable | No([[WP-P4-APR-018]] の後) |
| Gate | Gate B(GB-3) |

## 1. Purpose

FR-CAT-011 の残りを引き受ける: 承認期限前の通知(リマインド)、期限切れの監査への記録(`approval.expired`)、承認者不在時のエスカレーション先の定義。[[WP-P4-APR-017]] の §6-4 を分けたものである。

## 2. Requirement IDs

`FR-CAT-011`

## 3. Dependencies

[[WP-P4-APR-018]](エスカレーションは再割当と同じ遷移を使う)、[[WP-P2-NTF-005]](通知の経路。done)。

## 4. Scope / Allowed Paths

`要確認`(baseline へ上げる際に確定する)。見込み: `db/migrations/`、`services/api/src/modules/catalog/`、`services/api/src/modules/notification/`、`services/worker/src/jobs/`、`services/api/src/common/audit/audit.ts`、`apps/web/src/app/ops/approvals/`、対応するテスト、本WP、`evidence/WP-P4-APR-019/`。

## 5. Out of Scope

- 営業日カレンダー(期限は暫定の暦時間72時間のまま)。
- 自動での承認者の差し替え([[ADR-0023_Relationship_Based_Approval_Authority]] §6)。
- 代理承認([[WP-P4-APR-020]])、高リスク二重承認([[WP-P4-APR-021]])。

## 6. Deliverables

1. 期限前の通知: `pending` のステップの承認者へ、期限前に1回だけ通知する。送信済みの記録を持ち、ジョブの再実行で重複させない。通知に申請の本文を載せない。
2. 期限切れの記録: 期限を過ぎた `pending` のステップを `expired` へ遷移させ、`approval.expired` を記録する。現在は表示上の導出だけで、書込みが無い。
3. エスカレーション: 承認者不在の申請を、組織管理者へ知らせる(通知と一覧)。承認者の移行は、人が実行する再割当([[WP-P4-APR-018]])だけで行う。
4. 監査イベント: `approval.expired`、通知の送信記録。

### 実体化の際に決めること(`要確認`)

- 期限前の通知の時点(期限の24時間前、など)と、送信済みの記録の持ち方。
- 「エスカレーション先の定義」の意味。FR-CAT-011 は「エスカレーション先定義」を求めるが、自動で権限を移さない方針([[ADR-0023_Relationship_Based_Approval_Authority]] §6)のもとでは、(a) 知らせる先を組織ごとに定義する、(b) 再割当の際に使う代わりの承認者をルールに定義する、のどちらかになる。(b) はルールのデータモデルを変えるため、ADRの要否を判断する。
- 期限切れの遷移を、定期ジョブで書くか、期限切れを最初に検知した処理で書くか([[02.17_Audit_Event_Catalog]] §2.1 の `要確認`)。
- 期限切れのステップを再割当の対象に含めるか(現在は含めない。再申請を求める)。

## 7. Acceptance Criteria

- [ ] 期限前の通知が1回だけ送られ、ジョブの再実行・再送で重複しない。
- [ ] 期限を過ぎたステップが `expired` になり、`approval.expired` が1回だけ記録される。期限切れの承認での実行が拒否される。
- [ ] エスカレーション先が未定義のとき、承認者不在の申請は滞留として残り、自動で別の人に承認権限が移らない。定義された場合も、移行は再割当として監査イベントに記録される。
- [ ] 通知とジョブが組織境界を越えない。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態遷移)、TL-06(組織境界)

### Evidence

- 通知の重複防止・期限切れ・エスカレーションのテスト結果

`evidence/WP-P4-APR-019/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 監査への書込みを追加するため、Security Reviewer(人間)のレビュー対象。
- 生成する監査イベント: `approval.expired`。

## 10. Rollback / 失敗時の扱い

ジョブを止めれば、期限切れは従来どおり表示上の導出へ戻る。実行前検証は期限をステップの行から直接検査するため、ジョブの停止で期限切れの承認が実行可能になることは無い。

## 11. Codex app Prompt

```text
このWPは骨子のみ(draft)である。baselineへ上がるまで実装しない。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] 関連ドキュメント(02.17・03.5・RTMのStatus)の更新
- [ ] Security Reviewer(人間)のsign-off
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
