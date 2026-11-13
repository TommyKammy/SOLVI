---
project: SOLVI
doc_id: "WP-P4-APR-015"
title: "承認ルール・リゾルバ・プレビュー・関係ベース認可・一覧の可視性"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-11-12"
updated: "2026-11-13"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "authorization", "resolver"]
source_of_truth: true
implementation_status: "in-progress"
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

[[WP-P4-IDM-012]](done)、[[WP-P4-IDM-013]](done)、[[WP-P4-APR-014]](done)。ADR-0023 は `accepted`。2026-11-13 に利用者の決定(最大3段、変更の見直しは変更履歴の一覧まで)と §6.1 の確定事項を加えて `baseline` に実体化した。

**作業は2段階で行う**: (段階A)ルール・有効化設定・リゾルバ・プレビュー・申請と変更での経路解決。(段階B)関係ベースの決定の認可・一覧の可視性・滞留・再割当・上長と部署長の変更履歴API。

## 4. Scope / Allowed Paths

- `db/migrations/`
- `packages/shared/src/catalog.ts`
- `services/api/src/modules/catalog/approval-resolver.ts`
- `services/api/src/modules/catalog/approval-rule.service.ts`
- `services/api/src/modules/catalog/approval-rule.routes.ts`
- `services/api/src/modules/catalog/catalog-definition.ts`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `services/api/src/modules/catalog/approval-assertion.ts`
- `services/api/src/modules/catalog/approval-state.ts`
- `services/api/src/modules/catalog/catalog-admin.routes.ts`(定義の `ruleId` の保存時検証だけ)
- `services/api/src/modules/inbox/inbox.routes.ts`(承認待ちの抽出を「自分が承認者のステップ」で判定するための最小限の変更だけ)
- `services/api/src/modules/auth/relationship-change.service.ts`
- `services/api/src/modules/auth/relationship-change.routes.ts`
- `services/api/src/main.ts`(経路の登録だけ)
- `tests/security/relationship-change.test.ts`
- `tests/security/approval-steps.test.ts`(新しい認可・経路解決への追従だけ。検証内容の緩和は不可)
- `tests/security/approval-assertion.test.ts`(同上)
- `tests/security/approval-migration-compat.test.ts`(同上)
- `tests/security/department-profile.test.ts`(Migrationの巻き戻しを伴うテストが後続のMigrationでも成り立つための追従だけ)
- `tests/unit/approval-state.test.ts`
- `tests/unit/approval-assertion.test.ts`
- `tests/unit/catalog-flexible.test.ts`(偽DBの追従だけ。期待値の緩和は不可)
- `tests/unit/catalog-operations.test.ts`(同上)
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

### 6.1 実体化で確定した事項(2026-11-13)

利用者の決定:

- **最大段数は3**。ルールの `steps` は1〜3要素。DB(CHECK)とAPI(共有スキーマ)の両方で検証する。
- **上長・部署長の変更の見直しは「変更履歴の一覧」まで**。本WPは読み取りAPIを作り、画面への表示は[[WP-P4-APR-016]]。アクセスレビューの項目として1件ずつ判定する仕組みは作らない(必要になれば別WP)。

監督者の確定:

- **有効化設定**: `org_approval_setting(organization_id PK, rule_routing_enabled boolean NOT NULL DEFAULT false, updated_by, updated_at)` を新設する(RLS、行が無ければ無効)。切替は `org_admin` のみ。切替を `approval.routing.enabled` / `approval.routing.disabled` として監査する。環境変数・フラグにしない。
- **無効な組織での扱い**: 定義に `ruleId` があっても、組織で無効なら新規の版ではルールを使わず、現行互換(固定承認者、無ければ申請者が選ぶ)で経路を決める。定義への `ruleId` の保存は無効な組織でも許す(準備のため)。進行中の申請の検証は設定に関係なく全ステップを要求する。
- **`approverId` の扱い**: ルールで経路を決める版では、入力の `approverId` を承認者として使わない(無視する。Webは[[WP-P4-APR-016]]まで従来どおり送ってくるため、拒否はしない)。`create` / 変更の入力で `approverId` を任意にし、ルールを使わない版では従来どおり必須とする。
- **使うルールの版**: 申請・変更の時点の `current_revision`。経路の `ruleRef` に `{ruleId, revision}` を保存する。ルールが無効(`active=false`)・他組織・存在しない場合は、申請を拒否する(現行互換へ黙って落とさない)。
- **申請者が組織管理者の場合**: 当該組織で有効な `org_admin` ロールを持つ申請者は、プロフィールのデータに関係なく上長を未設定として扱う(ADR-0023 §3)。
- **部署長の探索**: 申請者の主部署から祖先へ。無効な部署は飛ばす。その時点で有効な部署長(期間内)で、有効な所属であり、申請者本人でない者を採用する。探索は部署の深さ上限(10)で打ち切る。
- **経路内の重複**: 解決した結果、同一人物が複数の段に現れる場合は申請を拒否する(統合しない)。
- **`resolvedFrom` の語彙**: `fixed` / `requester_selected` / `manager` / `manager>department_head`(上長が解決できず部署長へ進んだ)/ `department_head:self`(自部署)/ `department_head:ancestor`(祖先)。本WP以降に作る版に入れる。既存の版は変更しない。
- **決定の認可**: `manager` / `department_head` のステップは `approver` ロールを要求しない。ADR-0023 §2 の6項目を毎回検証する。`fixed` / `legacy` は従来どおり `approver` ロールを要求する。
- **滞留**: 現在の `pending` のステップの承認者が有効な所属でない(`fixed` / `legacy` は `approver` ロールも無い)申請を「承認者不在」とする。一覧に導出の項目として出し、`org_admin` が絞り込める。状態は変えない。
- **再割当**: ルールで決めた経路だけが対象。現在の `pending` のステップが「承認者不在」のときだけ実行できる(それ以外は409)。再解決にはその時点の `current_revision` を使い、新しい `ruleRef` を保存する。承認済みのステップと重複する承認者・申請者本人になる経路は拒否する。ルールを使わない経路(固定・申請者選択)は再割当の対象外とし、申請者による内容の変更(承認者の選び直し)で対処する。
- **高リスク**: ルールの共有スキーマは未知のキーを拒否する。`highRisk` を含むルールは保存できない(判定基準は[[WP-P4-APR-017]])。
- **部署の無効化トリガへの追加は行わない**: 承認ルールは部署を参照しない(`manager` / `department_head` は申請者から辿る。`fixed` は利用者を指す)。進行中の申請の経路は版に固定されているため、部署の無効化で変わらない。§6-1 の「部署の無効化トリガへ承認ルールの参照を追加する」は取り下げる。
- **変更履歴API**: 上長・主部署の変更(`org.member.profile.updated` のうち上長または主部署が変わったもの)と、部署長の設定・終了(`org.department.head.assigned|removed`)を、期間を指定して新しい順に返す。`org_admin` と `auditor` だけ。操作者・対象者・変更前後・時刻を返し、社員番号・役職・勤務地は返さない。監査イベントを読むだけで、新しいテーブルは作らない。
- **監査イベント**: `approval.route.resolved`(経路を決めた各版)、`approval.reassigned`、`approval.rule.created|revised|deactivated`、`approval.routing.enabled|disabled`。`afterState` には、ルール参照・段数・各段の種別と `resolvedFrom` を入れる。申請の入力値・個人データは載せない。

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
- [ ] `highRisk` を含むルールの保存が拒否される(判定基準は[[WP-P4-APR-017]])。4段以上・0段のルールがAPIとDBの両方で拒否される。
- [ ] 組織で有効化していない間は、`ruleId` のある定義でも現行互換の経路になる。有効化・無効化は `org_admin` だけができ、監査に残る。
- [ ] 有効な `org_admin` ロールを持つ申請者は、プロフィールに上長のデータがあっても上長が未設定として解決される。
- [ ] 再割当は、現在のステップが承認者不在のときだけ実行でき、それ以外は409。ルールを使わない経路は再割当できない。
- [ ] 変更履歴APIが、上長・主部署の変更と部署長の設定・終了を期間指定で返し、`org_admin` と `auditor` 以外には403、他組織の変更は含まれず、社員番号・役職・勤務地を含まない。
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
| 2026-11-13 | 実装担当(Codex) | 作業ツリー(未コミット) | 段階A 完了。段階B 未着手 | `evidence/WP-P4-APR-015/20261113-2225/` | ルール・有効化設定・リゾルバ・プレビュー・申請/変更の経路解決。`decide` の認可は変更せず |

### 2026-11-13 段階A 実装記録

**範囲**: WP §6 の 1・2・3・4・7・8(段階A)。決定の認可・可視性・滞留・再割当・変更履歴API(段階B)は未着手。

#### 変更ファイル

- `db/migrations/0039_approval_rules_and_routing.sql`(新規)
- `packages/shared/src/catalog.ts`
- `services/api/src/common/audit/audit.ts`
- `services/api/src/main.ts`
- `services/api/src/modules/catalog/approval-resolver.ts`(新規)
- `services/api/src/modules/catalog/approval-rule.service.ts`(新規)
- `services/api/src/modules/catalog/approval-rule.routes.ts`(新規)
- `services/api/src/modules/catalog/approval-assertion.ts`
- `services/api/src/modules/catalog/approval-state.ts`
- `services/api/src/modules/catalog/catalog-admin.routes.ts`
- `services/api/src/modules/catalog/catalog.routes.ts`
- `tests/unit/approval-resolver.test.ts`(新規)
- `tests/unit/catalog-flexible.test.ts`(偽DBの追従)
- `tests/unit/catalog-operations.test.ts`(偽DBの追従)
- `tests/security/approval-rule.test.ts`(新規)
- `tests/security/approval-routing.test.ts`(新規)
- `tests/security/approval-steps.test.ts`(新しい経路解決イベントへの追従)
- `tests/security/approval-migration-compat.test.ts`(0039 と使い捨てDB名への追従)
- `tests/security/department-profile.test.ts`(0039 の down 前の後片付け)

#### Migration 0039

- 新規: `approval_rule`、`approval_rule_revision`(append-only)、`org_approval_setting`。
- 3テーブルとも `organization_id` + RLS(ENABLE/FORCE)+ 組織分離ポリシー。
- `approval_rule`: 組織内コード一意、`UNIQUE(id, organization_id)`、識別列不変、
  `current_revision` の後退禁止、無効化の一方向化。`current_revision` は実在する版を
  遅延外部キーで参照する。
- `approval_rule_revision`: `(rule_id, organization_id, revision)` 主キー。複合FKで他組織の
  ルール改版を作れない。`UPDATE/DELETE` は `reject_asset_history_change()` トリガで拒否。
- `steps` は jsonb 配列で1〜3要素(CHECK)。要素の形は共有 Zod スキーマで検証する。
- `org_approval_setting`: 組織ごとの1行。行が無ければ無効。切替は `org_admin` のみ。
- GRANT: アプリロールに `approval_rule` は SELECT/INSERT/UPDATE、`approval_rule_revision` は
  SELECT/INSERT、`org_approval_setting` は SELECT/INSERT/UPDATE。**DELETE は与えない**。
- 部署の無効化トリガへの追加は行わない(§6.1 で取り下げ)。
- **ロールバック**: down は3テーブルのいずれかに行があれば拒否する(前進修復)。
  データが無ければ 0039 を削除し、`approval_rule_guard()` を削除する。
  検証: down(データなし)→up、データあり down の拒否を実施。

#### 検証コマンドと結果

すべて使い捨てDB `solvi_wp015_test`(Migration 0039・seed 済み)で実行。接続文字列は記録しない。

```text
node tools/migrate.mjs up                       # 39 件適用
node tools/migrate.mjs down                     # 0039 を巻き戻し(データなし)
node tools/migrate.mjs up                       # 0039 を再適用
node tools/migrate.mjs down                     # データあり: 0039 rollback refused
npx vitest run tests/unit/approval-resolver.test.ts \
  tests/security/approval-rule.test.ts tests/security/approval-routing.test.ts \
  tests/security/approval-steps.test.ts tests/security/approval-assertion.test.ts \
  tests/security/approval-migration-compat.test.ts tests/security/department-profile.test.ts
# 149 passed / 0 failed
npx vitest run tests/security
# 734 passed / 10 skipped / 個別テストの失敗0(既知の読み込み不能6ファイルのみ失敗)
npm run test:unit
# 34 failed / 4397 passed。変更前と失敗テスト名が完全一致(差分0)
node tools/check_rls.mjs                        # 問題0件 / OK
npm run typecheck                               # exit 0
npm run lint                                    # exit 0
npm run check:all                               # exit 0
```

開発用DB `solvi` の件数(`app_user` 15、`role_binding` 21、`ticket` 23、
`local_service_request` 12、`local_request_revision` 17、`local_request_approval` 17、
`local_simulation_receipt` 4、`department` 17、`org_member_profile` 15、`department_head` 5)は
作業前後で完全一致。`schema_migration` は38件・最大 `0038` のまま。

#### §7 受入基準の充足(段階A)

- ✅ リゾルバの全分岐(固定・上長・部署長・多段・互換・決定性):
  `tests/unit/approval-resolver.test.ts`(29 tests)。
- ✅ `onUnresolved=reject` の解決不能で申請を拒否し、足りない設定を応答に含める。
  部署長不在でも `org_admin` へフォールバックしない: `tests/security/approval-routing.test.ts`。
- ⏳ `approver` ロールを持たない上長の決定: 段階B。段階Aでは `decide` のロール要求を残し、
  テストで 403 になることを固定。
- ✅ `approver` ロールを持たない利用者が `fixed` / `legacy` を決定できない: 既存の
  `tests/security/approval-steps.test.ts`。
- ⏳ 決定時の6項目の各違反: 段階B(既存の検証は変更しない)。
- ⏳ 承認者の期限切れ・停止後の滞留と自動差し替えなし: 段階B。
- ⏳ 再割当: 段階B。
- ✅ 上長が変わっても進行中の申請の経路が変わらない: `tests/security/approval-routing.test.ts`。
- ✅ ルールのある項目で `approverId` を送っても承認者に使われない:
  `tests/security/approval-routing.test.ts`。他人の申請IDの404・一覧の可視性は段階B。
- ✅ ルール版の UPDATE/DELETE 拒否、他組織ルールの拒否、有効化を無効にしても進行中の
  多段申請が1段で実行できない: `tests/security/approval-rule.test.ts` /
  `tests/security/approval-routing.test.ts`。
- ✅ `highRisk` の保存拒否、0段/4段のAPI・DB拒否: `tests/security/approval-rule.test.ts`。
- ✅ 無効な組織では `ruleId` があっても現行互換。切替は `org_admin` のみで監査に残る:
  `tests/security/approval-rule.test.ts` / `tests/security/approval-routing.test.ts`。
- ✅ `org_admin` の申請者は上長が未設定として解決される: `tests/unit/approval-resolver.test.ts`。
- ⏳ 再割当の409条件・変更履歴API: 段階B。
- ✅ 新規テーブルが `check_rls` を通り、`check:all` が通り、新規依存0件。

#### セキュリティ影響

- 承認者・上長・部署長は同じ組織のレコード経由でのみ解決する。入力IDは再検証する。
- ルール・設定は `org_admin` のみ。RLS・API認可・複合FKの二層で組織境界を守る。
- ルール版は append-only。APIにUPDATE/DELETE経路を作らず、DBでも拒否する。
- 解決不能は現行互換へ落とさず拒否。`approval.route.resolved` は成功時に業務と同一
  トランザクション、拒否時にロールバック後の独立トランザクションで記録する。
- 監査・エラー応答・プレビューに申請入力値や個人データ(役職・勤務地・社員番号)を載せない。
  プレビューの表示名は同じ組織の有効な所属に限定する。
- `decide` の認可・状態機械・実行前検証は変更していない。
- 新規依存パッケージ0件。`apps/web/`、`package.json`、lockfile、`.env` は未変更。

#### 未解決事項

- 段階B(決定の認可、承認待ち一覧・詳細の可視性、滞留の導出、再割当API、
  上長・部署長の変更履歴API)は未着手。
- `docs/planning/03_Requirements/03.18_*`(RTM)と `docs/planning/MANIFEST.md` は
  ブリーフの指示により変更していない。RTMの Status 更新は監督者の判断で行う。
- 高リスクの判定基準は WP-P4-APR-017 で確定する。それまで `highRisk` を含むルールは保存できない。
- 経路プレビューのカタログ項目は**公開済みの定義**を使う。下書きプレビューは WP-P4-APR-016 のUIで扱う。
- ルールの再有効化は設けていない(無効化は一方向)。必要になった場合は監査付きの新しい経路を追加する。

#### Evidence

`evidence/WP-P4-APR-015/20261113-2225/`(`README.md` と `raw/`)。使い捨てDBは
`solvi_wp015_test` を検査用に残している。
