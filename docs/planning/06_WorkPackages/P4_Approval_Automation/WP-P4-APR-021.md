---
project: SOLVI
doc_id: "WP-P4-APR-021"
title: "高リスク申請の二重承認とSoD(カタログ定義の属性による判定)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.0.0"
created: "2026-11-14"
updated: "2026-11-15"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "sod", "high-risk"]
source_of_truth: true
implementation_status: "not-started"
story_points: 8
risk: "critical"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-010"]
depends_on: ["WP-P4-APR-018", "WP-P4-APR-020"]
---

# WP-P4-APR-021: 高リスク申請の二重承認とSoD(カタログ定義の属性による判定)

> [!note] 2026-11-15 に、[[ADR-0026_High_Risk_Approval_Constraints]] の `accepted` とあわせて、利用者(人間)の承認で `baseline` とした。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | critical |
| Story Points | 8(骨子の5から、代理の不可・条件を崩す変更の拒否・属性の変更の監査を加えて改めた) |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | No([[WP-P4-EXEC-004]] の前に完了する) |
| Gate | Gate B(GB-3) |

## 1. Purpose

FR-CAT-010(高リスク二重承認とSoD)を実装する。高リスクかどうかは、カタログ定義の版属性 `approval.highRisk` で判定する([[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §4〜§5)。高リスクの申請での代理の不可、条件を崩す変更の拒否、属性の変更の扱いは [[ADR-0026_High_Risk_Approval_Constraints]] に従う。[[WP-P4-APR-017]] の §6-2 を分けたものである。

## 2. Requirement IDs

`FR-CAT-010`

## 3. Dependencies

- [[WP-P4-APR-018]](done)、[[WP-P4-APR-020]](done。独立性を決定者 `decided_by` で数える)。
- [[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]](accepted)、[[ADR-0026_High_Risk_Approval_Constraints]](accepted)。

## 4. Scope / Allowed Paths

- `packages/shared/src/catalog.ts`(定義のスキーマへの `approval.highRisk` の追加と、表示用の型だけ)
- `services/api/src/modules/catalog/`
- `services/api/src/modules/inbox/inbox.routes.ts`(代理者への高リスクの申請の非表示だけ)
- `services/api/src/modules/notification/`(高リスクの申請の通知を代理者へ送らない変更だけ)
- `services/api/src/common/audit/audit.ts`(`catalog.high_risk_changed` の追加だけ)
- `apps/web/src/components/CatalogAdminForm.tsx`、`apps/web/src/app/catalog/`(高リスクの指定と表示)
- `apps/web/src/app/ops/approvals/`(ルールの変更・無効化・ルールの使用の停止の拒否の表示)
- `apps/web/src/app/requests/`、`apps/web/src/lib/`(「2名の承認が必要」の表示)
- `tests/security/approval-dual-control.test.ts`、`tests/unit/approval-dual-control.test.ts`、`tests/unit/approval-dual-control-ui.test.ts`(新規)
- `tests/unit/` と `tests/security/` の既存の承認・カタログ・通知テスト(追従だけ。削除・skip・緩和は不可)
- `tests/support/cleanup.ts`
- `tools/ui_approval_routing_check.mjs`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-021.md`(§13 だけ)
- `evidence/WP-P4-APR-021/`

スキーマの変更(Migration)は無い。属性は定義の版の JSON に入る。

## 5. Out of Scope

- Executor 側の分類(Allowlist変更、Critical Command)を判定に加えること、および Executor 側の承認再検証([[WP-P4-EXEC-004]])。
- 並列・定足数・グループ承認(扱わない。[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §6)。
- 金額ベースの動的承認ルート、Change承認のCAB機能([[WP-P7-APR-002]])。
- 委任そのもの(作成・取消・範囲)の変更。
- 固定承認者の無効化(停止・所属の終了・ロールの失効)の拒否([[ADR-0026_High_Risk_Approval_Constraints]] §2)。
- 新しい RLS の例外、新しいテーブル・列。

## 6. Deliverables

### 6.1 属性と、その変更の権限

1. 定義のスキーマに `approval.highRisk`(真偽値、省略可)を加える。省略は「高リスクではない」。真偽値以外は 400。
2. カタログの編集を委任された利用者(`org_admin` でない人)は、下書きの保存で、その項目の直前の版と異なる値を保存できない(新規の項目では真を保存できない)。拒否は 403 とし、ほかの項目の保存の扱いを変えない。
3. 公開の時点で、公開中だった版と属性の値が異なれば、`catalog.high_risk_changed` を公開と同じトランザクションで記録する(項目、版、前後の値、実行者。入力値・個人データは載せない)。初めての公開で真の場合も記録する。
4. [[WP-P4-APR-015]] が置いた「`highRisk` を含むルールは保存できない」は維持する(属性はルールではなく定義に置く)。

### 6.2 条件の判定(1か所に置く)

高リスクの条件([[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §5)を判定する共有の関数を1つ置き、次の全箇所で使う。

- 定義が `approval.ruleId` を持ち、組織でルールの使用が有効で、ルールが有効であること。
- ルールの段のうち `fixed` が2つ以上あり、その承認者が互いに別人であること(段数の上限3は変えない)。
- 解決した経路では、`authorityType` が `fixed` の段が2つ以上あり、承認者が互いに別人で、どれも申請者でないこと。

### 6.3 公開と、ルール・設定の変更

1. 高リスクの定義の公開は、6.2 の条件を満たさなければ 400 で拒否する(どの条件かを項目に結び付けた文で示す)。
2. ルールの版の追加・ルールの無効化・組織でのルールの使用の停止は、公開中の高リスクの定義(有効な項目の公開中の版)が条件を満たさなくなる場合、409 で拒否し、影響する項目のコードと名前を返す。
3. 公開とルール・設定の変更の直列化: 両方の処理が、同じトランザクションで、ルールの行と組織の設定の行を同じ順でロックしてから判定する。同時に実行しても条件が崩れないことをテストで確かめる。

### 6.4 申請と申請内容の変更

高リスクの snapshot で、解決した経路が 6.2 の条件を満たさなければ、申請・申請内容の変更を拒否する(既存の解決不能と同じ応答の形)。組織でルールの使用が無効な場合、ルールの無い定義(固定承認者1人、申請者による選択)の場合も拒否する。

### 6.5 決定と、代理の不可

1. 高リスクの申請では、同じ人(`decided_by`)が2つの段を決定できない。申請者はどの段も決定できない(既存の検証が満たしていることをテストで確かめる)。
2. 高リスクの申請では、代理者による決定を拒否する。応答は、委任の無い利用者が決定しようとした場合と同じ(従来の 403)にする。
3. 代理者に、高リスクの申請を委任による可視性で見せない(一覧・受信箱・詳細)。代理者が自分で決定したステップのある申請は、従来の規則で見える(高リスクでは代理の決定が起きないため、実際には生じない)。
4. 承認の通知(依頼・期限前)を、高リスクの申請については代理者へ送らない。

### 6.6 再割当

再割当後の経路を、申請時と同じく 6.2 で検証し、満たさなければ 409 で拒否する([[ADR-0026_High_Risk_Approval_Constraints]] §4。`fixed` の段は再割当できないため、通常は生じない)。

### 6.7 実行前検証

`assertApprovalComplete` は、snapshot が高リスクの場合、次のいずれかで失敗する(失敗コードは既存の並びに合わせて足す)。

- 承認済みの `fixed` の段が2つ未満、またはその決定者が互いに別人でない。
- 承認済みのステップに、`decided_by` が `approver_id` と異なるもの(代理による決定)がある。
- 判定に必要な値(snapshot の属性、経路、決定者)が読めない、型が違う。

属性が無い・偽の snapshot の検証は変えない。

### 6.8 画面

- カタログ項目の管理画面: 高リスクの指定(`org_admin` だけに操作を出す。委任された編集者には値の表示だけ)。条件の説明(承認ルールが必要、別人の固定承認者が2段以上、代理による承認はできない)。公開の拒否の表示。
- 申請画面と申請の詳細: 「この申請は2名の承認が必要です。代理による承認はできません。」の表示(snapshot の属性による)。
- 承認ルールの管理画面(`/ops/approvals`): ルールの変更・無効化・ルールの使用の停止の拒否を、影響する項目の名前とともに表示する。
- 既存の画面の流儀(確認のチェック、失敗の表示、キーボード操作、375px で横にはみ出さない)に合わせる。

## 7. Acceptance Criteria

1. [ ] 高リスクの申請で、申請者による決定、1人目の決定者と同一人物による2人目の決定が、UI/APIで拒否される。
2. [ ] 高リスクの申請で、有効な委任の代理者が決定できない(応答は委任の無い利用者と同じ)。代理者の一覧・受信箱・詳細に高リスクの申請が出ない。代理者へ承認の通知が送られない。
3. [ ] 独立した2名の本人による `fixed` の段の承認が揃うまで、`assertApprovalComplete` が失敗する。代理による決定を含む場合、値が読めない場合も失敗する。
4. [ ] 関係ベース(上長・部署長)の段だけの経路、`fixed` が1段だけの経路、`fixed` の2段が同じ承認者の経路が、公開時・ルールの版の追加時・申請時のすべてで拒否される。
5. [ ] 公開中の高リスクの項目を条件に合わなくする、ルールの版の追加・ルールの無効化・組織でのルールの使用の停止が、影響する項目を示して拒否される。公開との同時実行でも条件が崩れない。
6. [ ] 高リスクの定義が、ルール無し・ルールの使用が無効な組織で、公開も申請もできない。
7. [ ] `approval.highRisk` の変更が、`org_admin` 以外(カタログの編集を委任された利用者を含む)から拒否される。公開の時点で `catalog.high_risk_changed` が前後の値とともに記録される。
8. [ ] 再割当後の経路が条件を満たさない場合に再割当が拒否される。
9. [ ] 属性の無い既存の定義と過去の申請、高リスクでない申請での代理承認の挙動が変わらない。
10. [ ] 画面(実画面): 管理画面の指定、申請画面と詳細の表示、ルール管理画面の拒否の表示を、Chromium と WebKit の 1440px / 375px で確かめ、axe の serious / critical が0。
11. [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02、TL-06、TL-10(Executor 側での承認再検証との結合は [[WP-P4-EXEC-004]] と調整)、TL-16
- ロール(`org_admin`・カタログの委任された編集者・承認者・代理者・申請者)×操作の総当り。
- 6.3-3 の同時実行(公開×ルールの版の追加、公開×ルールの無効化、公開×ルールの使用の停止)。

### 実画面での確認

実画面の確認には、開発用DBで、組織のルールの使用の有効化、2名の固定承認者を持つルール、承認者ロールを持つ2つ目の合成アカウントが要る見込みである。これらの開発用データの変更は、段階C の前に、利用者の承認を個別に得てから行う。

### Evidence

- 二重承認・SoD違反・代理の拒否ログ(全経路分)、条件を崩す変更の拒否、属性の変更権限のテスト結果、画面のスクリーンショットと axe

`evidence/WP-P4-APR-021/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3 の対象。**Security Reviewer(人間)の sign-off 必須**(決定の認可の変更、実行前検証、監査への書込み)。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)、T-26。
- 生成する監査イベント: `catalog.high_risk_changed`(新規)。
- 残る弱点: 高リスクの指定漏れ・指定の取り外しは、Executor 側の分類を加える([[WP-P4-EXEC-004]])まで検知できない(取り外しは監査に残る)。

## 10. Rollback / 失敗時の扱い

属性を偽に戻した新しい版を公開すれば、以後の申請は通常の経路になる。進行中の高リスクの申請は、snapshot のとおり2名の本人の承認を要求し続ける。検証を弱める形の切り戻しはしない。Migration は無い。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに上がった後のみ)。

正本: AGENTS.md / 本WP / ADR-0024(§4・§5) / ADR-0026(全体) / ADR-0025(§3・§5) / ADR-0021(委任された編集者) /
03.5(FR-CAT-010) / 02.17 / WP-P4-APR-015・018・020 の成果(ルール、再割当、代理承認)。

手順:
1. 受入基準をテストへ変換し、先に書く。
2. 条件の判定の共有関数、属性と権限、公開とルール・設定の変更、申請、決定と代理の不可、再割当、実行前検証、画面の順に実装する。
3. 高リスクでない申請の挙動が変わらないことを、既存のテストで確かめる。

やってはいけないこと:
- 条件の判定を2か所以上に書くこと。値が読めないときに通すこと(fail closed)。
- 委任・ルール・再割当の既存の挙動を、高リスクでない申請について変えること。
- Migration、新しい RLS の例外。テストのskip・削除、新規依存、Allowed Paths外の変更、ADRの決定の黙った変更。
完了時に報告: 変更ファイル、検証コマンドと結果、受入基準ごとの充足、セキュリティ影響、未解決事項、Evidence。
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
