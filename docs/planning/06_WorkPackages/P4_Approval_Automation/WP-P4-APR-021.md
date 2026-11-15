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
implementation_status: "review"
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
| 2026-11-15 | Codex(段階A) | 未コミット | 段階A(属性・共有の判定・API)を実装・検証済み。画面(§6.8)は段階B | `evidence/WP-P4-APR-021/20261115-1736/` | 下記 |
| 2026-11-15 | Codex(段階B) | 未コミット | 段階B(画面)を実装・検証済み。実画面の確認は段階C | `evidence/WP-P4-APR-021/20261115-1815/` | 下記 |

### 段階A の実行記録(2026-11-15)

#### 変更ファイル

- `packages/shared/src/catalog.ts`(`approval.highRisk` の追加。真偽値・省略可)
- `services/api/src/modules/catalog/approval-high-risk.ts`(新規。判定の純粋関数3つ・属性の読み方・可視性の SQL 述語)
- `services/api/src/modules/catalog/approval-high-risk-store.ts`(新規。ロックの順序・公開中の高リスク項目の読み取り・409 の Problem)
- `services/api/src/modules/catalog/catalog-admin.routes.ts`(下書きの属性の権限、公開の条件と `catalog.high_risk_changed`)
- `services/api/src/modules/catalog/approval-rule.service.ts`(設定→ルールのロック順、版の追加・無効化・使用の停止の拒否)
- `services/api/src/modules/catalog/catalog.routes.ts`(申請・変更の検証、決定の代理の拒否、可視性、再割当)
- `services/api/src/modules/catalog/approval-assertion.ts`(実行前検証の3つの失敗コード)
- `services/api/src/modules/catalog/approval-resolver.ts`(`high_risk_route_invalid` の失敗コードと Problem)
- `services/api/src/modules/inbox/inbox.routes.ts`(受信箱から代理者へ高リスクを見せない)
- `services/api/src/modules/notification/notification.service.ts`(依頼・期限前の宛先から代理者を除く)
- `services/api/src/common/audit/audit.ts`(`catalog.high_risk_changed` の追加)
- `tests/security/approval-dual-control.test.ts`(新規37件)、`tests/unit/approval-dual-control.test.ts`(新規21件)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-021.md`(本節と `implementation_status` だけ)
- `evidence/WP-P4-APR-021/20261115-1736/`

#### Migration

なし(属性は定義の版の JSON に入る。テーブル・列を追加しない)。Migration は42件のまま。
ロールバックは、属性を偽に戻した新しい版を公開する(§10)。

#### 検証(使い捨てDB `solvi_wp021_wp020_wp019_wp018_wp015_test`・42 Migration・seed 済み)

- `npx vitest run tests/security/approval-dual-control.test.ts`: 37 passed。
- `npx vitest run tests/unit/approval-dual-control.test.ts`: 21 passed。
- `npx vitest run tests/security/approval-rule.test.ts approval-routing approval-reassign approval-delegation approval-assertion approval-notice approval-steps approval-migration-compat`: 250 passed(既存の「ルールに `highRisk` は保存できない」を含む)。
- `npx vitest run tests/security` 全体(`.env` を読み込んで実行): 939 passed / 10 skipped。失敗は既知の読み込み不能6ファイルだけ。
- `npx vitest run tests/unit/approval-*.test.ts tests/unit/catalog-*.test.ts tests/unit/requests-ui.test.ts`: 990 passed(27ファイル)。
- `npm run test:unit`: 34 failed / 4619 passed。失敗は knowledge・performance の4ファイルだけ(基点の34件と同じ)。
- `node tools/check_rls.mjs`: 問題0件。`npm run check:all`: OK。`npm run typecheck`: エラー0。`npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'`: 0件。
- 開発用DB `solvi` の件数は前後で不変(Migration 42・最大0042)。書込みは行っていない。

#### §7 の充足(段階A)

- §7-1(申請者・同一人物の2段の拒否): 充足(申請者は403、`decided_by` の重複は409。API)。
- §7-2(代理者の拒否・非表示・通知): 充足(403と同じ文言、一覧・受信箱・詳細は404/非表示、依頼・期限前の宛先から除外)。
- §7-3(独立2名の `fixed`・代理・読めない値): 充足(`high_risk_insufficient_approvers` / `high_risk_delegated_decision` / `high_risk_unreadable`)。
- §7-4(関係ベースだけ・`fixed` 1段・同じ承認者の2段): 充足(公開400・ルール変更409・申請409)。
- §7-5(条件を崩す変更の拒否と同時実行): 充足(公開×版の追加・無効化・使用の停止)。
- §7-6(ルール無し・使用が無効な組織での公開と申請): 充足。
- §7-7(属性の変更権限と監査): 充足(`org_admin` 以外は403、公開時に前後の値だけを記録)。
- §7-8(再割当後の条件): 充足(409 `high_risk_route_invalid`)。
- §7-9(既存の定義・申請・高リスクでない申請の挙動): 充足(既存テストの期待値を変えていない)。
- §7-10(画面): **段階B**。
- §7-11(`check:all`・`typecheck`・`lint`・新規依存0): 充足。

#### セキュリティ影響

- 決定の認可に「高リスクでは代理者を認めない」制約を加えた。判定は snapshot の属性(真偽値の `true` だけ)で行う。
- 公開・ルール/設定の変更・申請・変更・再割当・実行前検証が、同じ純粋関数の判定を通る。値が読めない場合は拒否する。
- 新しい RLS の例外・`SECURITY DEFINER`・環境変数/フラグによる切替は設けていない。Migration も無い。
- `catalog.high_risk_changed` は前後の真偽値・コード・版・実行者だけを記録し、入力値・個人データを載せない。
- Security Reviewer(人間)の sign-off は**未取得**(Gate B GB-3)。

#### 未解決・確認事項

1. **`decide` の高リスクの代理の応答**: 代理者には `visible()` が 404 を返すため、決定の直前に「有効な委任があれば 403(委任の無い場合と同じ文言)」を返す分岐を置いた。委任の無い第三者は従来どおり 404。応答の違いから「委任している承認者が高リスクの申請の現在の承認者である」ことが分かり得る(§6.5-2 の 403 を優先した)。監督者の確認を求める。
2. **ルールの版の追加での重複の拒否**: `fixed` の重複は既存の保存の検証が 400 で拒否するため、公開中の高リスクの項目を壊す場合に限り、高リスクの判定を先に行い 409(影響する項目つき)にした。重複が高リスクの項目を壊さない場合は従来の 400 のまま。
3. **ルールの使用の停止のロック**: 停止では、公開中の高リスクの項目が参照するルールの行も ID の昇順で `FOR UPDATE` する。組織の設定の行を先に取るため、公開・版の追加・無効化・停止のすべてが「設定 → ルール」の順になり、デッドロックしない。
4. **`org_approval_setting` の行が無い組織**: 「ルールの使用が無効」として扱う(行を作らない。行を作るのは `setRouting` だけ)。
5. **再割当の検証**: §6.6 のとおり経路の条件だけを見る(組織の設定は、公開中の項目がある限り停止できないため前提とする)。`fixed` の段は再割当できないため、条件を崩す再割当は DB を直接いじった場合にだけ生じる。
6. **公開時のハッシュ整合**: 承認の実行前検証は snapshot のハッシュを先に検査する。属性を DB で直接書き換える検査では、snapshot・版・承認行のハッシュを同時に更新している(本番の経路ではない)。

#### Evidence

`evidence/WP-P4-APR-021/20261115-1736/`(検証ログ・開発用DBの件数・`git status`)。


#### 監督者の検査(段階A、2026-11-15)

- **決定の応答の修正**: 段階Aの実装は、高リスクの申請に対する代理者の決定を、可視性の判定より前に 403 で拒否していた。この結果、代理者は 403、委任の無い同じ組織の利用者は 404 となり、応答の違いから「委任者がその申請の現在の承認者である」ことが分かり得た。[[ADR-0026_High_Risk_Approval_Constraints]] §1 の「委任の無い場合の代理者と同じ応答」に合わせ、判定を可視性の後へ移した。見えない代理者は 404、見える利用者(承認者でない)には従来の 403 となる。§6.5-2 の「従来の 403」は、見える利用者についての記述として読む。テストを「委任の無い利用者と同じ 404」に改めた。
- **実行前検証の修正**: 代理による決定の検出が `fixed` の段だけを見ていた。ADR-0026 §1 のとおり、段の種別によらず検出するよう直し、関係ベースの段の代理の決定を拒否する unit テストを足した。
- 監督者が使い捨てDB(`solvi_wp021_wp020_wp019_wp018_wp015_test`)で再実行した: `typecheck`、`check:all`、`eslint`(`.claude/**` を除く)、`tools/check_rls.mjs`、`vitest run tests/security`(939件通過。失敗は既知の読み込み不能6ファイルだけ)、承認・カタログ・申請の unit テスト990件。開発用DBの件数は作業前と同じ(Migration 42件)。
- 段階Aの確認事項への回答: (2) 公開中の高リスクの項目を壊す場合に限り、固定承認者の重複を 409 にする順序の入れ替えは許容する。(3)(4)(5)(6)(7) は報告のとおりでよい。(8) は段階Bで扱う。

### 段階B の実行記録(2026-11-15)

#### 変更ファイル

- `apps/web/src/components/CatalogAdminForm.tsx`(`approval.highRisk` の指定。`org_admin` だけに操作、委任された編集者には表示だけ。公開の 400 を項目へ結び付け、保存の 403 を分かりやすく表示)
- `apps/web/src/app/catalog/manage/actions.ts`(高リスクの指定の送信。管理者は明示的な真偽、委任された編集者は現在値の保持)
- `apps/web/src/app/catalog/manage/page.tsx`、`apps/web/src/app/catalog/manage/[id]/page.tsx`(一覧・詳細のテキストの目印)
- `apps/web/src/app/catalog/[itemId]/page.tsx`(申請画面の「2名の承認が必要」)
- `apps/web/src/app/requests/[id]/page.tsx`(申請の詳細の「2名の承認が必要」)
- `apps/web/src/app/requests/actions.ts`(高リスクの 409 は `detail` の文だけを出し、コードを出さない)
- `apps/web/src/app/ops/approvals/actions.ts`、`apps/web/src/app/ops/approvals/page.tsx`(条件を崩す変更の 409 を、影響する項目の一覧つきで表示)
- `apps/web/src/lib/approval-route.ts`(高リスクの文言・409 の組み立て・`high_risk_route_invalid` の再割当の理由)
- `apps/web/src/lib/api.ts`(応答の加算の型)
- `services/api/src/modules/catalog/catalog-admin.routes.ts`(一覧・詳細の `highRisk` / `publishedHighRisk`)
- `services/api/src/modules/catalog/catalog.routes.ts`(カタログ項目の `highRisk`、申請の詳細の `highRisk`)
- `tests/unit/approval-dual-control-ui.test.ts`(新規17件)、`tests/security/approval-dual-control.test.ts`(段階Bの応答の加算2件を追加)
- `tools/ui_approval_routing_check.mjs`(`wp021` 段階を追加。**今回は実行していない**)
- 本WP(§13 と `implementation_status` だけ)、`evidence/WP-P4-APR-021/20261115-1815/`

Migration・依存・`.env` の変更は無い。

#### API の加算(認可・検証は変えない)

- `GET /catalog-admin` の各行に `highRisk`(下書きの版)と `publishedHighRisk`(公開中の版)。
- `GET /catalog-admin/:id` に同じ2つ。
- `GET /catalog` の各項目に `highRisk`。
- `GET /service-requests/:id` に `highRisk`。
- 判定はすべて `readHighRiskAttribute(...) === 'true'`。存在して真偽値でない値を真にはしない(段階Aの拒否はそのまま)。

#### 画面の内容

- 管理画面: 「高リスク（2名の承認が必要）」のチェック(24px・ラベルと同じ行)と説明。`org_admin` 以外にはチェックを出さず、現在値の表示と「高リスクの指定は組織管理者だけが変更できます。」を出す。送信値は管理者が明示的な真偽、委任された編集者は直前の値のまま。
- 公開の 400 は、公開の失敗の表示と、高リスクの指定の項目の直近の両方に出す。保存の 403 は「高リスクの指定を変更できるのは組織管理者だけです。」として項目に結び付ける。
- 申請画面と詳細: 「この申請は2名の承認が必要です。代理による承認はできません。」を API の `highRisk` が真のときだけ出す。
- 申請の 409(`approval-high-risk-unresolved`)は `detail` の文を既存の失敗の表示に出す。`high_risk_route_invalid` は出さない。
- ルール画面の 409(`high-risk-approval-constraint`)は「公開中の高リスクの項目が条件を満たさなくなるため、変更できません。」と影響する項目(`code: title`)の一覧を出す。`high_risk_definition_blocked` は出さない。

#### 検証(使い捨てDB `solvi_wp021_wp020_wp019_wp018_wp015_test`・42 Migration・seed 済み)

- `npx vitest run tests/security/approval-`: 289 passed。
- `npx vitest run tests/security`(`.env` を読み込む): 941 passed / 10 skipped。失敗は既知の読み込み不能6ファイルだけ。
- `npx vitest run tests/unit/approval- tests/unit/catalog- tests/unit/requests-ui.test.ts`: 1008 passed(28ファイル)。
- `npm run test:unit`: 34 failed / 4637 passed。失敗名の集合は基点(WP-P4-APR-020 の Evidence)と一致(新規失敗0)。
- `node tools/check_rls.mjs`: 問題0件。`npm run check:all`: OK。`npm run typecheck`: エラー0。`npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'`: 0件。
- 見た目は**ハーネス**(実画面ではない)。実際の `globals.css` / `freshservice.css` を読み込んだ静的HTMLを Chromium と WebKit の 1440px / 375px で撮り、axe を実行した。28スキャン、serious / critical 0、横はみ出し0。`evidence/WP-P4-APR-021/20261115-1815/harness/`。
- 開発用DB `solvi` の件数は前後で不変(Migration 42・最大0042)。書込みは行っていない。
- `tools/ui_approval_routing_check.mjs` は `node --check` と eslint だけ。`wp021` 段階は**未実行**(実画面の操作は利用者の承認後)。

#### §7 の充足(段階B)

- §7-1〜§7-9: 段階Aで充足済み。段階Bは表示と、その表示に使う応答の加算を追加した。
- §7-10(画面): **段階C**。今回の Evidence はハーネスであり、実画面ではない。
- §7-11: 充足(上記の各検査)。

#### 段階C に必要な開発用データ(最小)

1. 組織で承認ルールの使用を有効にする(`/ops/approvals`)。
2. 別人の固定承認者を2段持つ承認ルール(1件)。
3. 2人目の固定承認者にする合成アカウントへ `approver` ロールを一時付与(`agent@acme.example.test` を想定)。

`tools/ui_approval_routing_check.mjs` の `wp021` 段階は、この3つを前提に、合成の高リスク項目・申請・委任を作成し、最後に片付ける。

#### セキュリティ影響

- 画面は高リスクの可否を API の `highRisk` だけで決め、定義の JSON や経路から推測しない。
- 委任された編集者には指定の操作を出さず、送信値も変えない。API の 403 は段階Aのまま。
- 影響する項目の一覧と拒否の文だけを表示し、理由コード・内部の識別子を出さない。
- 新しい権限・RLS・`SECURITY_DEFINER`・Migration・環境変数/フラグは無い。
- Security Reviewer(人間)の sign-off は**未取得**(Gate B GB-3)。

#### 確認事項

1. 実画面の確認(§7-10)は段階C。ハーネスのスクリーンショットは実画面の代わりではない。
2. 一覧・詳細の目印は下書きと公開中の版を分けて出す。公開中が高リスクで下書きが外れている場合は「公開中の版で指定されています」と出す。
3. `ui_approval_routing_check.mjs` の `wp021` 段階は未実行のため、初回実行時に開発用データの前提と画面のセレクタを確認する必要がある。

#### Evidence

`evidence/WP-P4-APR-021/20261115-1815/`(検証ログ・ハーネスの HTML / PNG / axe・開発用DBの件数・`git status`)。

#### 監督者の検査(段階B、2026-11-15)

- 監督者が再実行した: `typecheck`、`check:all`、`eslint`、承認・カタログ・申請の unit テスト1008件。
- 段階Bの確認事項への回答: (1) 応答への加算は WP §4 の範囲とする。(2)(3)(5)(6) は報告のとおりでよい。(4) ルール画面の失敗の表示の500文字の上限で、影響する項目が多い場合に一覧が切れ得る点は、残る点として記録し、本WPでは変えない。
- 開発用DBの確認(管理者接続の `SELECT`): 公開中の有効な9項目は、どれも承認ルールを使っていない。組織でルールの使用を有効にしても、既存の項目の経路は変わらない。
- 確認スクリプトの `wp021` 段階は、組織でのルールの使用の有効化を前提とし、片付けで元に戻さない。段階Cの前に、有効化と片付けでの無効化をスクリプトに含める。
