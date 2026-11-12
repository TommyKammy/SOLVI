---
project: SOLVI
doc_id: "WP-P4-APR-015"
title: "承認ルール・リゾルバ・プレビュー・関係ベース認可・一覧の可視性"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-11-12"
updated: "2026-11-12"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "authorization", "resolver"]
source_of_truth: true
implementation_status: "not-started"
story_points: 8
risk: "critical"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-007", "FR-CAT-010", "FR-CAT-012", "FR-CAT-013", "FR-CAT-014", "FR-CAT-016", "FR-CAT-017"]
depends_on: ["WP-P4-IDM-012", "WP-P4-APR-014"]
---

# WP-P4-APR-015: 承認ルール・リゾルバ・プレビュー・関係ベース認可・一覧の可視性

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | critical |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(IDM-012とAPR-014の後) |
| Gate | Gate B(GB-3) |

## 1. Purpose

承認ルールに従って承認者を決め(固定・申請者選択の互換・上長・部署長・直列多段)、`manager` / `department_head` のステップを `approver` ロール無しで決定できるようにする。これは認可モデルの変更([[ADR-0023_Relationship_Based_Approval_Authority]] §2)であり、決定時の6項目検証、承認待ち一覧・詳細の可視性、再割当(経路を変える唯一の遷移)、解決不能な申請の拒否までを含む。

## 2. Requirement IDs

`FR-CAT-007`, `FR-CAT-010`, `FR-CAT-012`, `FR-CAT-013`, `FR-CAT-014`, `FR-CAT-016`, `FR-CAT-017`

## 3. Dependencies

**有効化の前提(2026-11-12 監督者が追加)**: 上長・部署長の変更履歴をアクセスレビュー([[WP-P1-SEC-024]])で確認できるようにしてから、関係ベース承認を組織で有効化する(リスク受容 RA-04 の検知手段。[[WP-P4-IDM-013]] は監査イベントの記録までを行う)。本WPの成果物と受入基準に含める。

[[WP-P4-IDM-012]], [[WP-P4-APR-014]]。実体化(`draft` → `baseline`)は、ADR-0023が `accepted` であることを確認し、`要確認` の2点(最大段数、高リスク申請の判定基準)をレビューで確定してから行う。

## 4. Scope / Allowed Paths

- `db/migrations/`
- `packages/shared/src/catalog.ts`
- `services/api/src/modules/catalog/approval-resolver.ts`
- `services/api/src/modules/catalog/approval-rule.service.ts`
- `services/api/src/modules/catalog/approval-rule.routes.ts`
- `services/api/src/modules/catalog/catalog-definition.ts`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `services/api/src/modules/catalog/approval-assertion.ts`
- `services/api/src/common/audit/audit.ts`
- `tests/unit/approval-resolver.test.ts`
- `tests/security/approval-routing.test.ts`
- `tests/security/approval-rule.test.ts`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-015.md`
- `evidence/WP-P4-APR-015/`

## 5. Out of Scope

- UI([[WP-P4-APR-016]])。代理承認・高リスクの二重承認とSoD評価器・並列/定足数/グループ承認・リマインドとエスカレーション([[WP-P4-APR-017]])。ただし本WPは「高リスク申請では `fixed` 段を必須とする」ルール保存時検証を持つ(判定基準の実体は[[WP-P4-APR-017]]。確定までは `要確認` として保存時検証を無効にせず、ルールの `highRisk` 指定を拒否する側(fail closed)に倒す)。
- Executor接続、IdP/SCIM同期、`org_admin` への自動フォールバック(設けない)、上長の上長への自動遡及。

## 6. Deliverables

1. Migration: `approval_rule`(`id, organization_id, code, name, active, current_revision, created_by, created_at, updated_at`、`UNIQUE(organization_id, code)`、`UNIQUE(id, organization_id)`)、`approval_rule_revision`(`rule_id, organization_id, revision, steps jsonb, created_by, created_at`、`PRIMARY KEY(rule_id, organization_id, revision)`、UPDATE/DELETEをトリガで拒否するappend-only)。RLS(`ENABLE`/`FORCE`、`organization_id = app_current_org()`)、`GRANT`、ルール使用の組織単位の有効化設定(DB。環境変数にしない。既存に組織単位の設定テーブルは無いため、組織ごとの1行テーブルを新設する案を想定する。**`要確認`**)。部署の無効化トリガへ「承認ルールの参照」を追加する。
2. `definition.approval` の拡張: 任意の `ruleId` を版属性として追加(旧属性の欠落は受理。[[ADR-0020_Catalog_Form_Definition_Extensions]]〜[[ADR-0022_Catalog_Optional_Request_Fields]]と同じ)。`steps` の共有Zodスキーマ(`fixed: {approverId}` / `manager: {onUnresolved: 'department_head'|'reject'}` / `department_head: {onUnresolved: 'reject'}`)。**最大段数は `要確認`(上限値を実体化時に確定し、DBとAPIの両方で検証する)。**
3. リゾルバ(`approval-resolver.ts`): [[ADR-0023_Relationship_Based_Approval_Authority]] §9 の解決順。入力 `{organizationId, requesterId, definition, now}`、出力 `{steps[{stepNo, approverId, authorityType, resolvedFrom}], ruleRef, routeHash}` または解決不能の理由(足りない設定)。決定的(`now` は引数)。`routeHash` は [[WP-P4-APR-011]] の `snapshot-hash.ts` と同じ正規化。
4. 申請(`create`)・変更での経路解決と保存(`route` / `route_hash` / ステップ行)。ルールのある項目では `approverId` を受け付けない(無視または拒否)。解決不能な申請は拒否し、足りない設定を返す。`approval.route.resolved` を記録する。
5. 決定時の関係ベース認可: ADR-0023 §2 の6項目。`manager` / `department_head` は `approver` ロール不要。承認待ち一覧・詳細の可視性を「自分が `approver_id` のステップを持つ」で判定する(担当者ロールの可視性は変更しない)。
6. 再割当API(`org_admin` のみ): 未決定ステップの承認者が無効なときに、現在の経路世代の未決定ステップを `invalidated`、`route_generation` を増やして残りのステップだけ再解決し、`route`・`route_hash` を保存する。承認済みステップを保持する。`approval.reassigned` を記録する。自己承認・重複の検証は同じものを通す。
7. 承認ルール管理API(作成・版追加・無効化・一覧・版履歴。`org_admin` のみ)と、経路プレビュー(「この申請者なら誰が承認するか」)、現在の全利用者のうち解決できない人の一覧。`approval.rule.created|revised|deactivated` を記録する。
8. 高リスク申請: 関係ベースのステップだけの経路は承認として成立しない。`fixed` 段を必須とする保存時検証(判定基準は[[WP-P4-APR-017]]で確定。`要確認`)。

## 7. Acceptance Criteria

- [ ] リゾルバの全分岐に単体テストがある: 固定(正常・無効・他組織・`approver` ロールなし)/ 上長(正常・未設定・無効な所属・`role_binding` 期限切れ・申請者本人)/ 部署長(自部署・祖先・申請者本人が部署長で上位へ・期限切れ・不在)/ 多段(順序・同一人物の重複拒否)/ 互換(`approverId` のみの定義・どちらも無い定義)/ 決定性(同じ入力で同じ `routeHash`)。
- [ ] `onUnresolved` が `reject` の上長・部署長ステップは、解決不能で申請を拒否し、応答に足りない設定(例: 申請者の上長が未設定)が含まれる。部署長も不在のとき `org_admin` へのフォールバックは起きない。
- [ ] `approver` ロールを持たない上長が、自分宛ての `manager` ステップを承認・却下できる。他人宛てのステップは決定できない(404または403)。
- [ ] `approver` ロールを持たない利用者が `fixed` / `legacy` ステップを決定できない。
- [ ] 決定時の6項目(承認者一致・有効な所属・申請者本人でない・`pending` かつ期限内かつ現在の `route_generation`・hash一致・`fixed` の `approver` ロール)の各違反が拒否される(1項目1テスト)。
- [ ] 承認者の `role_binding` が決定前に期限切れ・`app_user` が `deactivated` なら、決定が拒否され、申請は滞留(承認者不在)として一覧に出る。自動で承認者は差し替わらない。
- [ ] 再割当: `org_admin` の再割当後、新しい承認者が決定でき、旧経路世代のステップでは決定できない。承認済みステップは保持され、`approval.reassigned` が記録される。`org_admin` 以外は再割当できない。再割当後の経路でも自己承認・重複・SoDの検証を通る。
- [ ] 上長が変更されても、進行中の申請の経路は変わらない(再割当以外で経路が変わるコード経路が無い)。
- [ ] 他人の申請IDを指定した決定・閲覧が404。ルールのある項目で `approverId` を送っても承認者として使われない。`approver_id` を持たない `approver` ロール保持者は承認待ち一覧に他人宛てを見ない。
- [ ] ルールの版(`approval_rule_revision`)を `UPDATE` / `DELETE` できない(トリガ)。他組織のルールを参照・指定できない。組織単位の有効化を無効にしても、進行中の多段申請は全ステップの承認を要求し続ける(1段だけで実行可能にならない)。
- [ ] 高リスク扱いのルール保存で `fixed` 段が無いものが拒否される(判定基準確定後。確定までは `highRisk` 指定そのものを拒否する)。
- [ ] 新規テーブルが `tools/check_rls.mjs` を通り、`check:all` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-01(リゾルバ)、TL-02(状態遷移と再割当)、TL-04、TL-06(承認者スコープ・ロール×エンドポイント総当り)、TL-16(IDOR/mass assignment/自己承認の全経路)

### Evidence

- リゾルバ分岐の網羅結果、決定時6項目の拒否ログ、再割当の前後の経路とイベント、権限テストの総当り結果

`evidence/WP-P4-APR-015/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3の対象。**Security Reviewer(人間)のレビュー必須**(認可・承認統制・RLS)。脅威 [[02.14_Threat_Model]] T-02、T-03、T-07、T-08、T-26。
- 承認者・上長・部署長は同組織のレコード経由でのみ解決する(自由入力のIDを禁止)。AIは承認者を選ばない。
- 生成する監査イベント: `approval.route.resolved`、`approval.reassigned`、`approval.rule.created|revised|deactivated`、決定系の `approval.*`。
- 申請・チケット本文などの利用者由来データを、承認者・特権操作の対象の決定に使わない。

## 10. Rollback / 失敗時の扱い

ルールの有効化は組織単位のDB設定であり、無効にすれば新規申請でルールを使わない(現行互換に戻る)。進行中の多段申請は全ステップを要求し続ける。新テーブルのdownはデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに実体化された後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(全体。特に§2・§5・§6・§9・§10) / 03.5 / 03.7 / 02.17 / 02.14 T-26 /
WP-P4-IDM-012 のスキーマ / WP-P4-APR-014 の状態機械・assertApprovalComplete。

手順:
1. 依存WPの完了とADR-0023のstatus、`要確認`の確定を確認する。満たなければ実装せず報告する。
2. リゾルバの分岐・決定時6項目・再割当・可視性をテストへ変換し、先に書く。
3. Migration、Zodスキーマ、リゾルバ、API、再割当、ルール管理、プレビューの順に実装する。
4. 全ステップ検証をフラグ非依存に保つ。ルールの有効化は組織単位のDB設定。

やってはいけないこと:
- 承認者の自動差し替え・org_admin への自動フォールバック・上長の上長への自動遡及。
- 経路を再割当以外で変えるコード。ルールのある項目で approverId を使うこと。
- 関係ベース承認での approver ロールの代用付与。高リスク判定基準の自己決定(要確認として報告)。
- 環境変数での有効化、テストのskip・削除、新規依存、Allowed Paths外の変更。
完了時に報告: 変更ファイル、Migrationと rollback、検証コマンドと結果、受入基準ごとの充足、セキュリティ影響、未解決事項、Evidence。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration(up/down)とロールバック方針、既存データ互換の説明
- [ ] 関連ドキュメント(02.17・03.5・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off(認可・承認統制のため必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
