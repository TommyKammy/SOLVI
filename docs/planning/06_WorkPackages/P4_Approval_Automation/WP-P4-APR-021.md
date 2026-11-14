---
project: SOLVI
doc_id: "WP-P4-APR-021"
title: "高リスク申請の二重承認とSoD(カタログ定義の属性による判定)"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-14"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "sod", "high-risk"]
source_of_truth: true
implementation_status: "not-started"
story_points: 5
risk: "critical"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-010"]
depends_on: ["WP-P4-APR-018", "WP-P4-APR-020"]
---

# WP-P4-APR-021: 高リスク申請の二重承認とSoD(カタログ定義の属性による判定)

> [!warning] この文書は骨子のみ(`status: draft`、2026-11-14)。実装の根拠にしない。[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] の `accepted` と、[[WP-P4-APR-020]] の完了後に `baseline` へ上げる。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | critical |
| Story Points | 5 |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | No([[WP-P4-EXEC-004]] の前に完了する) |
| Gate | Gate B(GB-3) |

## 1. Purpose

FR-CAT-010(高リスク二重承認とSoD)を実装する。高リスクかどうかは、カタログ定義の版属性 `approval.highRisk` で判定する([[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §4〜§5)。[[WP-P4-APR-017]] の §6-2 を分けたものである。

## 2. Requirement IDs

`FR-CAT-010`

## 3. Dependencies

[[WP-P4-APR-018]]、[[WP-P4-APR-020]](独立性を決定者 `decided_by` で数えるため、代理承認の後に行う)。[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] の `accepted`。

## 4. Scope / Allowed Paths

`要確認`(baseline へ上げる際に確定する)。見込み: `packages/shared/src/catalog.ts`、`services/api/src/modules/catalog/`、`services/api/src/common/audit/audit.ts`、`apps/web/src/components/CatalogAdminForm.tsx`、`apps/web/src/app/catalog/`、`apps/web/src/app/ops/approvals/`、`apps/web/src/app/requests/`、`tests/unit/approval-dual-control.test.ts`、`tests/security/approval-dual-control.test.ts`、本WP、`evidence/WP-P4-APR-021/`。スキーマの変更が要るかは実体化の際に確かめる(属性は定義の版の JSON に入るため、不要の見込み)。

## 5. Out of Scope

- Executor 側の分類(Allowlist変更、Critical Command)を判定に加えること、および Executor 側の承認再検証([[WP-P4-EXEC-004]])。
- 並列・定足数・グループ承認(扱わない。[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §6)。
- 金額ベースの動的承認ルート、Change承認のCAB機能([[WP-P7-APR-002]])。

## 6. Deliverables

1. カタログ定義の版属性 `approval.highRisk`(真偽値。無い定義は高リスクではない)。値の変更は `org_admin` だけ。変更の前後を監査に残す。
2. 公開時とルールの版の追加時の検証: 高リスクの定義は、ルールが必須で、`fixed` の段を2つ以上含み、その承認者が別人であること。満たさない公開・ルールの変更を拒否する。ルール側の変更で、そのルールを使う高リスクの定義が条件を満たさなくなる場合も拒否する。
3. 申請時・申請内容の変更時の検証: 高リスクの snapshot で、解決した経路が条件を満たさない場合は申請を拒否する。組織でルールの使用が無効な場合も拒否する。
4. 決定時の検証: 同じ人(`decided_by`)が、同じ申請の2つの段を決定できない。申請者はどの段も決定できない。代理経由も同じ。
5. 実行前検証: snapshot が高リスクなのに、別人2名による承認済みの `fixed` の段が揃っていなければ `assertApprovalComplete` が失敗する。判定に必要な値が読めない場合も失敗する。
6. 画面: カタログ項目の管理画面での高リスクの指定(`org_admin` だけ)、申請画面と詳細での「2名の承認が必要」の表示、ルール管理画面での条件違反の表示。
7. [[WP-P4-APR-015]] が置いた「`highRisk` を含むルールは保存できない」は維持する(属性はルールではなく定義に置く)。

### 実体化の際に決めること(`要確認`)

- 高リスクの定義で、再割当([[WP-P4-APR-018]])後の経路が条件を満たさなくなる場合の扱い(再割当を拒否する見込み)。
- 既存の公開済みの定義を高リスクにする場合の、進行中の申請の扱い(snapshot に固定されるため、進行中の申請は変わらない見込み)。
- 高リスクの指定を外す操作に、理由の入力を必須にするか。

## 7. Acceptance Criteria

- [ ] 高リスクの申請で、申請者・1人目の決定者と同一人物による2人目の承認が、全経路(UI/API/代理経由)で拒否される。
- [ ] 独立した2名の承認が揃うまで実行できない(`assertApprovalComplete` が失敗する)。
- [ ] 関係ベース(上長・部署長)の段だけで構成された経路、`fixed` が1段だけの経路、`fixed` の2段が同じ承認者の経路が、公開時・ルール保存時・申請時のすべてで拒否される。
- [ ] `approval.highRisk` の変更が、`org_admin` 以外(カタログの編集を委任された利用者を含む)から拒否される。変更が監査に記録される。
- [ ] 高リスクの定義が、ルール無し・ルールの使用が無効な組織で、公開も申請もできない。
- [ ] 属性の無い既存の定義と過去の申請の挙動が変わらない。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02、TL-06、TL-10(Executor 側での承認再検証との結合は [[WP-P4-EXEC-004]] と調整)、TL-16

### Evidence

- 二重承認・SoD違反の拒否ログ(全経路分)、属性の変更権限のテスト結果

`evidence/WP-P4-APR-021/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3 の対象。**Security Reviewer(人間)の sign-off 必須**。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)、T-26。
- 残る弱点: 高リスクの指定漏れは、Executor 側の分類を加える([[WP-P4-EXEC-004]])まで検知できない。

## 10. Rollback / 失敗時の扱い

属性を偽に戻した新しい版を公開すれば、以後の申請は通常の経路になる。進行中の高リスクの申請は、snapshot のとおり2名の承認を要求し続ける。検証を弱める形の切り戻しはしない。

## 11. Codex app Prompt

```text
このWPは骨子のみ(draft)である。baselineへ上がるまで実装しない。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] 関連ドキュメント(02.17・03.5・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off(必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
