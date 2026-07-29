---
project: SOLVI
doc_id: "WP-P2-PRIO-013"
title: "見立ての見直しと優先度の出どころ"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-29"
updated: "2026-07-29"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ticket", "sla"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "TICKET"
risk: "medium"
story_points: 5
depends_on: ["WP-P2-TKT-001", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-009", "NFR-UX-001"]
aliases: ["WP-P2-PRIO-013"]
---

# WP-P2-PRIO-013: 見立ての見直しと優先度の出どころ

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | TICKET |
| Risk | medium |
| Story Points | 5 |
| Gate | Gate A(GA-1) |

## 1. Purpose

**申告時の見立てを、調べた結果に合わせて直せるようにする。**

横断点検([[04.23_Wiring_Verification]])は `isDerivedPriority` を
「画面側が未実装」と記録していた。調べると前提が違っていた。
**手で変える経路がそもそも存在しない。**

優先度は起票時に影響度×緊急度から導かれるきりで、以後変える手段が無い。
これは表示の欠落ではなく**機能の欠落**である。

申告時の影響度・緊急度は依頼者の見立てであり、調べた結果と食い違うのが普通である。
「1台だけだと思ったら3部署で起きていた」「回避策が見つかった」——
どちらも日常的に起きる。見直せないと、現場は
**「とりあえず緊急にして起票する」**を覚え、優先度が意味を失う。

## 2. Requirement IDs

`FR-TKT-009`(優先度の導出)、`NFR-UX-001`

## 3. Dependencies

- [[WP-P2-TKT-001]] — 優先度の導出規則と状態機械
- [[WP-P2-OPSUI-010]] — 担当者の作業画面

## 4. Scope / Allowed Paths

- `services/api/src/modules/ticket/`
- `services/api/src/modules/notification/`
- `services/api/src/common/`
- `services/api/src/main.ts`
- `apps/web/src/`
- `tools/`
- `tests/`

## 5. Out of Scope

- **優先度の直接変更** — §6 の設計判断により、経路そのものを作らない
- SLA の目標時間そのものの見直し — `sla_policy` の編集画面は別WP
- 依頼者による見直し依頼のワークフロー

## 6. Deliverables

- 影響度・緊急度の見直しエンドポイント(`POST /tickets/:id/assessment`)
- 保存されている優先度が規則どおりかの検査(`priorityIsDerived`)
- 担当者の作業画面の「見立て」節
- 監査イベント型 `ticket.reassessed`
- 優先度が変わったときの通知

## 7. Acceptance Criteria

- [x] 担当者が影響度・緊急度を見直せる
- [x] **優先度は受け取らない**(送っても効かない)
- [x] 優先度が規則から導き直される
- [x] **理由が必須**(SLAの期限が動く操作である)
- [x] **変更が無ければ拒否する**(黙って成功にしない)
- [x] 依頼者は見直せない
- [x] **終了・取消・統合済みは見直せない**(SLAの達成状況を後から書き換えない)
- [x] 他組織のチケットは見直せない
- [x] 前後の値と理由が監査に残る
- [x] **優先度が変わったときだけ**通知する
- [x] 画面に**優先度の根拠**が書かれている
- [x] 保存値が規則と食い違っていれば画面が警告する
- [x] axe による自動検査で violation 0

## 8. Verification and Evidence

- `tests/security/collaboration-routes.test.ts`(見直しの検査10件)
- `tools/e2e/conversation_flow.mjs`(見立ての8項目)

Evidenceは`evidence/WP-P2-PRIO-013/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 優先度の偽装 | 入力として受け取らない。常にサーバが導く |
| SLA記録の改変 | 終端状態のチケットは見直せない |
| 越境 | `requireAccess` で組織とロールを確認。他組織は 404 |
| 監査 | `ticket.reassessed` に前後の影響度・緊急度・優先度と理由を残す |
| 情報漏えい | 通知の件名に優先度の値を書かない |

## 10. Rollback / 失敗時の扱い

DBスキーマを変更しない。監査イベント型の追加は TypeScript の台帳のみ。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] `check_unwired.mjs` が通る(`isDerivedPriority` が承知の未接続から外れた)
- [x] **稼働中のスタックで実際に動くことを確認した**(通知の実配送を含む)
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-29 | Opus 5 | `4be1040` / merge `9857949` | Done | `evidence/WP-P2-PRIO-013/20260729-1334/` | 検査10件 + 通し確認8項目 + a11y 12画面。全体 1242 tests passed |

### 設計判断

**優先度を直接いじらせない。** 影響度と緊急度を直し、優先度は規則から導き直す。

1. **同じ入力から常に同じ優先度が出ること**が、SLA計測と監査の前提である
   ([[WP-P2-TKT-001]] / `packages/shared/src/ticket/priority.ts`)。
   直接書き換えを許すと、その優先度を後から再現できなくなる
2. 監査に残るのが「誰かが critical にした」ではなく
   **「影響範囲が広いと分かった」**になる。判断の当否を後から検証できる
3. 優先度を直接上げられると、上げること自体が交渉の道具になる。
   影響度・緊急度で語らせるほうが、議論が事実に向く

**`isDerivedPriority` は読むたびの整合検査に使う。**

直接書き換える経路は作らなかったが、DBを直接触られたり、
将来の機能が上書きしたりすれば食い違いうる。
食い違ったまま表示すると、**再現できない優先度**を根拠に対応順が決まる。
合わないなら合わないと言う。

**優先度の根拠を画面に書く。** 「最優先」とだけ出ていると、
誰かが決めた値なのか自動で決まった値なのか分からない。
「影響 高い × 急ぎ 高い から決まっています」と書く。

**変更が無ければ拒否する。** 押したのに何も起きないと、
利用者は操作が効いていないと考える。黙って成功にもしない。

**優先度が変わったときだけ通知する。** 影響度と緊急度の入れ替えで
優先度が動かないこともある(`高 × 低` も `中 × 中` もどちらも `中`)。
変わっていないものを知らせても「また来た」としか受け取られない。

件名は「優先度が見直されました」まで。「critical になりました」と書くと、
メールの一覧に緊急度が並び、**本文を読まずに騒ぎが起きる**。

### 残っている制約

- **SLAの期限は変わるが、経過時間は据え置く。** 見直しで優先度が上がると
  目標時間が短くなり、その時点で既に超過していることがありうる。
  意図した挙動だが、画面に「見直した結果、期限を超過しました」とは出ない
