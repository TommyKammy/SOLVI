---
project: SOLVI
doc_id: "WP-P4-APR-020"
title: "代理承認(承認者本人による期間限定の委任と、委任者・代理者の記録)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.0.0"
created: "2026-11-14"
updated: "2026-11-15"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "delegation"]
source_of_truth: true
implementation_status: "done"
story_points: 8
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-006"]
depends_on: ["WP-P4-APR-018", "WP-P4-APR-019"]
---

# WP-P4-APR-020: 代理承認(承認者本人による期間限定の委任と、委任者・代理者の記録)

> [!note] 2026-11-15 に、[[ADR-0025_Approval_Delegation]] の `accepted` とあわせて、利用者(人間)の承認で `baseline` とした。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | No([[WP-P4-APR-019]] の後) |
| Gate | Gate B(GB-3) |

## 1. Purpose

FR-CAT-006(代理承認)を実装する。承認者が、期間を限って、自分宛ての承認を別の人に任せられるようにする。[[WP-P4-APR-017]] の §6-1 を分けたものである。

2026-11-15 に利用者が次を決定した。決定の全体は [[ADR-0025_Approval_Delegation]] にある。

- **委任を作れるのは本人だけ。** `org_admin` は取消だけできる。
- **代理者は `approver` ロールを持つ有効な所属の人。** 段の種別(固定・上長・部署長)を問わず代理できる。
- **範囲は自分宛てのすべて、期間は最長30日。** カタログ項目ごとの指定は設けない。

## 2. Requirement IDs

`FR-CAT-006`

## 3. Dependencies

[[WP-P4-APR-018]](done。現在の経路の導出、実行前検証)、[[WP-P4-APR-019]](done。承認の通知)。[[ADR-0025_Approval_Delegation]] の `accepted`。

## 4. Scope / Allowed Paths

- `db/migrations/`(0042 の up / down だけ)
- `services/api/src/modules/catalog/`
- `services/api/src/modules/inbox/inbox.routes.ts`
- `services/api/src/modules/notification/`(承認の通知の宛先に代理者を加える変更と、委任の作成・取消の通知だけ)
- `services/api/src/common/outbox/outbox.ts`(イベント型の追加だけ)
- `services/api/src/common/audit/audit.ts`
- `services/api/src/main.ts`(経路の登録と、Outbox の処理へのイベント型の登録だけ)
- `packages/shared/src/`(入力のスキーマと定数だけ)
- `apps/web/src/app/approvals/delegations/`(新規。委任の画面)
- `apps/web/src/app/ops/approvals/`、`apps/web/src/app/requests/`、`apps/web/src/app/inbox/`、`apps/web/src/lib/`、`apps/web/src/components/`(ナビゲーションへの追加と、代理の表示だけ)
- `tests/security/approval-delegation.test.ts`、`tests/unit/approval-delegation.test.ts`、`tests/unit/approval-delegation-ui.test.ts`(新規)
- `tests/unit/` と `tests/security/` の既存の承認・通知テスト(追従だけ。削除・skip・緩和は不可)
- `tests/support/cleanup.ts`
- `tools/ui_approval_routing_check.mjs`、`tools/check_rls.mjs`(新しいテーブルの登録が必要な場合だけ)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-020.md`(§13 だけ)
- `evidence/WP-P4-APR-020/`

画面の置き場所(`/approvals/delegations`)は見込みである。既存の画面の構成に合わない場合は、実装せずに報告する。

## 5. Out of Scope

- 高リスク二重承認([[WP-P4-APR-021]])と、高リスクの段での代理の可否。ただし「独立性は決定者で数える」前提を崩さない([[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §5)。
- `org_admin` による他人の委任の作成。再委任。カタログ項目ごとの範囲。期間の変更(延長は新しい委任)。
- 経路の差し替え(代理は経路・`route_hash`・`approver_id` を変えない)。
- Change の承認(`local_change_approval`)への適用。
- 新しい RLS の例外。

## 6. Deliverables

### 6.1 Migration 0042

- `approval_delegation`: `id`、`organization_id`、`delegator_id`(委任者)、`delegate_id`(代理者)、`starts_at`、`ends_at`、`created_by`、`created_at`、`revoked_at`、`revoked_by`、`revoke_reason`。
  - CHECK: `ends_at > starts_at`、期間が30日以内、委任者と代理者が別人、取消の3列がすべて NULL かすべて非 NULL、理由の長さ。
  - 同じ委任者の、取り消されていない委任の期間が重ならないこと(排他制約。使えない場合は、作成時のロックと検査で守り、その旨を報告する)。
  - 利用者への外部キーは、組織を含む既存の流儀に合わせる。RLS(ENABLE + FORCE、`organization_id = app_current_org()`)。
  - **追記専用に準じる**: `DELETE` を拒否する。`UPDATE` は、取消の3列を NULL から一度だけ埋める場合に限って許し、それ以外の列の変更と、取消の書き換えをトリガで拒否する。
- `local_request_approval` に `delegation_id`(NULL 可、委任への複合外部キー)を加える。CHECK: `delegation_id` があるなら `decided_by` があり `approver_id` と異なる。既存の行は NULL のまま。
- down は、委任の行、または `delegation_id` を持つステップが1件でもあれば拒否する。

### 6.2 委任の作成・取消・一覧(API)

- 作成: 認証済みの利用者が、**自分を委任者として**作る。本文は代理者・開始・終了だけ(未知のキーは拒否)。委任者のIDを本文で受け取らない。代理者は、組織の利用者の一覧から選ぶ形にし、IDの自由入力の経路を作らない(存在しない・他組織・資格の無い利用者は、同じ応答で拒否して存在を漏らさない)。
  - 検証: 委任者が有効な所属、代理者が有効な所属かつ `approver` ロール、別人、期間(終了が現在より後、長さ30日以内、開始は現在の少し前から許す範囲を実装で定めて報告する)、重なり。
- 取消: 委任者本人、代理者本人、`org_admin`。理由が必須。取り消し済み・期間の終わった委任の取消は 409。
- 一覧: 自分が委任者のもの、自分が代理者のもの。`org_admin` は組織のすべて。状態(予定・有効・終了・取消済み・代理者が資格なし)は導出する。
- 他組織・存在しないIDは 404。

### 6.3 代理者による決定

- 決定のAPIは既存のものを使う(新しい決定の経路を作らない)。決定者がステップの `approver_id` でない場合に限り、[[ADR-0025_Approval_Delegation]] §3 の6項目を検証し、満たす委任が1件あれば、その委任のIDをステップの行に残して決定する。満たさなければ、従来と同じ応答(存在を漏らさない)で拒否する。
- 委任の検証と決定は、決定と同じトランザクション・同じロックの中で行う。委任の行をロックして、取消と直列化する。
- 委任者本人の決定は、従来どおり(委任のIDは残さない)。
- 状態遷移は遷移表を通す(新しい遷移は足さない)。承認取消(`revoke`)の権限に、そのステップを決定した代理者を加える。

### 6.4 実行前検証

`assertApprovalComplete` / `checkApprovalComplete` を [[ADR-0025_Approval_Delegation]] §4 のとおり拡張する。`decided_by` が `approver_id` と異なるのに委任のIDが無い、委任の委任者・代理者が合わない、決定の時刻が委任の期間外、取消より後、のそれぞれで失敗する。値が読めない場合も失敗する。申請者と決定者の非同一、決定者同士の非重複を、`decided_by` でも検証する。

### 6.5 可視性と通知

- 承認待ちの一覧・受信箱・申請の詳細で、有効な委任の代理者に、委任者宛ての承認待ちを見せる。代理であること(誰の代理か)を応答に含める。委任が無効になったら見えない。
- 承認者不在の判定([[WP-P4-APR-018]])は変えない(委任があっても、委任者が無効なら承認者不在)。
- 承認の通知([[WP-P4-APR-019]])の依頼・期限前を、配送の時点で有効な委任の代理者へも送る。
- 委任の作成・取消を、委任者と代理者へ通知する(件名とリンクだけ)。

### 6.6 監査

`approval.delegated`(作成)、`approval.delegation_revoked`(取消。理由を含む)。決定の監査イベントに、委任者・代理者・委任のIDを含める。申請の入力値・個人データを載せない。

### 6.7 画面

- 委任の画面: 自分の委任の一覧、作成(代理者の選択、開始、終了)、取消(理由)。自分が代理者の委任の一覧と辞退。`org_admin` には組織の委任の一覧と取消。
- 承認待ち・受信箱・詳細: 代理の対象に「◯◯さんの代理」と表示する。承認の経過と記録に、代理で決定されたこと(委任者と代理者)を表示する。
- 既存の画面の流儀(確認のチェック、失敗の表示、キーボード操作、375px)に合わせる。

## 7. Acceptance Criteria

- [ ] 委任を作れるのは本人だけである。本文で委任者を指定する試み、`org_admin` による他人の委任の作成、他組織からの作成が拒否される。
- [ ] 資格の無い代理者(`approver` ロールが無い、停止、所属切れ、他組織、存在しない、委任者自身)への委任が、同じ応答で拒否される。
- [ ] 30日を超える期間、終了が開始以前、過去に終わる期間、同じ委任者の期間の重なる委任が拒否される。
- [ ] 有効な委任の代理者が、委任者宛ての `fixed`・`manager`・`department_head` のそれぞれの段を決定でき、ステップの行に `decided_by`(代理者)・`approver_id`(委任者)・委任のIDが残り、監査に委任者・代理者・委任のIDが残る。経路・`route_hash`・世代が変わらない。
- [ ] 期間前・期間後・取消後の委任、代理者が資格を失った委任、委任者が無効になった委任での決定が、全経路(UI/API)で拒否される。
- [ ] 申請者本人が代理者として自分の申請を決定できない。同じ人が、代理を使って同じ申請の2つの段を決定できない(本人として1段+代理として1段、代理として2段、の両方)。
- [ ] 再委任ができない(代理者が、委任者宛ての承認をさらに別の人へ任せても、その人は決定できない)。
- [ ] 代理で承認されたステップが、委任の取消・期間の終了・代理者や委任者の無効化のあとも有効で、実行前検証が成功する。
- [ ] 実行前検証が、委任のIDの欠落・委任者や代理者の不一致・期間外の決定時刻・取消より後の決定時刻で失敗する。
- [ ] 代理者に、有効な委任の委任者宛ての承認待ちだけが見える。委任の無い他人宛ての承認待ち・詳細は 404 のままである。委任が無効になると見えなくなる。
- [ ] 取消が、委任者・代理者・`org_admin` にだけでき、それ以外のロールと他組織から拒否される。取消と決定が同時に起きても、取消後の決定が成立しない。
- [ ] 委任の行の `DELETE` と、取消の3列以外の `UPDATE`、取消の書き換えが、アプリケーションロールから拒否される。他組織の委任が読めない。新しい RLS の例外ポリシーが無い。
- [ ] 承認の通知が、有効な委任の代理者へも届く。通知と監査に申請の入力値・個人データが含まれない。
- [ ] 委任の無い既存の申請・承認の挙動が変わらない。Migration 0042 の up / down が往復でき、データがある状態の down が拒否される。
- [ ] 画面: 委任の作成・取消・辞退、代理の表示が、Chromium と WebKit、1440px と 375px で動き、axe の serious / critical が0件である。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態機械)、TL-04(Migration)、TL-06(承認者スコープ・代理範囲・組織境界)、TL-16

### Evidence

- 代理の拒否ログ(全経路分)、監査イベントの記録、画面のスクリーンショットと axe

`evidence/WP-P4-APR-020/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3 の対象。**Security Reviewer(人間)の sign-off 必須**(承認権限の付与、決定の認可の変更、RLS 付きのテーブル、監査への書込み)。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)、T-02(組織境界)。
- 残る弱点: 委任者と代理者の共謀は防げない(代理者のロールの統制と監査で抑止する)。乗っ取られたアカウントによる委任は、作成の通知と監査で検知する。
- 生成する監査イベント: `approval.delegated`、`approval.delegation_revoked`。

## 10. Rollback / 失敗時の扱い

委任の作成を止めれば、新しい代理は生まれない。既存の委任を取り消せば、代理者は決定できなくなり、承認者本人による決定へ戻る。代理で承認済みのステップは有効のまま残る。Migration の down はデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに上がった後のみ)。

正本: AGENTS.md / 本WP / ADR-0025(全体) / ADR-0023(§1・§2・§5・§7) / ADR-0024(§2・§5) /
03.5(FR-CAT-006) / 02.17 / WP-P4-APR-018・019 の成果(現在の経路の導出、実行前検証、承認の通知)。

手順:
1. 受入基準をテストへ変換し、先に書く(作成の権限、代理者の資格、期間、決定の6項目、自己承認と複数段、実行前検証、可視性、追記専用とRLS)。
2. Migration 0042、委任のAPI、代理者による決定、実行前検証、可視性と通知、画面の順に実装する。
3. 委任の無い申請の挙動が変わらないことを、既存のテストで確かめる。

やってはいけないこと:
- 委任者のIDを本文で受け取る経路。org_admin による他人の委任の作成。再委任。
- 経路・route_hash・approver_id の書き換え。遷移表を通さない状態の更新。
- 新しい RLS の例外。テストのskip・削除、新規依存、Allowed Paths外の変更、ADRの決定の黙った変更。
完了時に報告: 変更ファイル、Migrationと rollback、検証コマンドと結果、受入基準ごとの充足、セキュリティ影響、未解決事項、Evidence。
```

## 12. Definition of Done

- [ ] §7をすべて満たす / §8のテスト通過とEvidence保存
- [ ] Migration(up/down)とロールバック方針、既存データ互換の説明
- [ ] 関連ドキュメント(02.17・03.5・RTMのStatus)の更新
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewer(人間)のsign-off(必須)
- [ ] Execution Logへ追記

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-11-15 | Codex(段階A) | 未コミット | 段階A(スキーマ・API・通知)を実装・検証済み。画面は段階B | `evidence/WP-P4-APR-020/20261115-0930/` | 下記 |
| 2026-11-15 | Codex(段階B) | 未コミット | 段階B(指摘の修正と画面)を実装・検証済み。実画面の操作は未実施 | `evidence/WP-P4-APR-020/20261115-1016/` | 下記 |
| 2026-11-15 | Codex(段階C) | 未コミット | 実画面の確認は委任の作成まで。確認スクリプトの不備で停止し、委任・一時ロールは片付け済み。申請以降は未実施 | `evidence/WP-P4-APR-020/20261115-1050/` | 下記 |

### 段階A の実行記録(2026-11-15)

#### 変更ファイル

- `db/migrations/0042_approval_delegation.sql`(新規)
- `services/api/src/modules/catalog/approval-delegation.ts`(新規。判定・共有述語)
- `services/api/src/modules/catalog/approval-delegation.routes.ts`(新規。作成・取消・一覧・候補)
- `services/api/src/modules/catalog/catalog.routes.ts`(`decide` の代理分岐、`visible`、一覧、詳細)
- `services/api/src/modules/catalog/approval-assertion.ts`(実行前検証)
- `services/api/src/modules/catalog/approval-notice.ts`(委任の通知・代理者の宛先)
- `services/api/src/modules/catalog/approval-state.ts`(`delegation_id` の記録)
- `services/api/src/modules/inbox/inbox.routes.ts`(受信箱の代理)
- `services/api/src/modules/notification/notification.service.ts`(宛先と委任の通知)
- `services/api/src/common/audit/audit.ts`、`services/api/src/common/outbox/outbox.ts`、`services/api/src/main.ts`(型・経路・配送の登録)
- `packages/shared/src/catalog.ts`(入力スキーマと定数)
- `tests/security/approval-delegation.test.ts`(新規)、`tests/unit/approval-delegation.test.ts`(新規)
- `tests/security/approval-notice.test.ts`、`tests/unit/approval-assertion.test.ts`(0042 への追従のみ)

#### Migration 0042 とロールバック

- `approval_delegation`(RLS ENABLE + FORCE、組織分離ポリシー1件、`SELECT/INSERT/UPDATE` をアプリロールへ、`DELETE` は与えない)。
- 重なりは `btree_gist` を足さず、**委任者単位の助言ロック**(`pg_advisory_xact_lock`)を INSERT トリガで取ってから検査する。API も同じ鍵でロックして事前検査する。
- UPDATE は取消の3列を NULL から一度だけ埋める場合だけ許可。DELETE・その他の列の変更・取消の書き換えはトリガで拒否。
- `local_request_approval.delegation_id`(複合 FK、CHECK: 委任のIDがあるなら決定者があり承認者と異なる)。
- down は、委任の行または `delegation_id` を持つステップが1件でもあれば拒否(前進修復)。データが無ければ down → up が往復する。

#### 検証(使い捨てDB `solvi_wp020_wp019_wp018_wp015_test`)

- `npx vitest run tests/security`: 900 passed / 10 skipped。失敗は既知の読み込み不能6ファイルのみ(`knowledge-pagination` / `notification-*` 4件 / `user-directory-consistency`)。
- `npx vitest run tests/unit/approval-*.test.ts tests/unit/catalog-*.test.ts tests/unit/requests-ui.test.ts`: 911 passed。
- `npm run test:unit`: 34 failed / 4539 passed。失敗は knowledge・performance の4ファイルのみで、承認・カタログ・受信箱の失敗は0(基点と同じ34件)。
- `node tools/check_rls.mjs`: 問題0件。`npm run check:all`: OK。`npm run typecheck`: エラー0。`npx eslint . --max-warnings=0`: 警告0。
- 開発用DB `solvi` の件数は前後で不変(申請18 / 版23 / 承認30 / 世代2 / 通知記録8 / 監査1960 / 通知95 / Outbox454、Migration 41・最大0041)。書込みは行っていない。

#### §7 の充足(段階A)

- 本人だけが作成・本文で委任者を指定できない・`org_admin` も他人の委任を作れない・他組織から作成できない: 充足(§7-1)。
- 資格の無い代理者は同じ403と同じ文言: 充足(§7-2)。
- 期間の上下限・30日超・過去終了・重なり: 充足(§7-3)。
- `fixed` / `manager` / `department_head` の代理決定、`decided_by`・`approver_id`・委任のID・監査、経路と `route_hash`・世代の不変: 充足(§7-4)。
- 期間前・期間後・取消後・資格喪失・委任者無効での拒否: 充足(§7-5、API。画面は段階B)。
- 自己承認・同一人物の2段: 充足(§7-6)。ADR-0025 §3-6 により「代理で1段目→本人で2段目」は正規の経路では到達しない(下記「未解決」)。
- 再委任の禁止: 充足(§7-7。委任は委任者本人が `approver_id` の段にだけ効く)。
- 取消・期間終了・資格喪失の後も承認済みは有効: 充足(§7-8)。
- 実行前検証の4種の失敗: 充足(§7-9)。
- 可視性(委任者宛ての承認待ちだけ・取消後に見えない): 充足(§7-10)。
- 取消の権限と、取消×決定の直列化: 充足(§7-11)。
- 追記専用・RLS・新規例外なし: 充足(§7-12)。
- 通知の宛先・個人データを載せない: 充足(§7-13)。
- 委任の無い申請の挙動不変・Migration の往復・データがある down の拒否: 充足(§7-14)。
- 画面(§7-15)と `check:all`/`typecheck`/`lint`/新規依存0(§7-16): 後者は充足。画面は段階B。

#### セキュリティ影響

- 決定の認可に「有効な委任の代理者」を1つ追加した。委任者が本人であること・期間・取消・委任者の権限根拠・代理者の資格・申請者でないこと・決定者としての非重複を、決定と同じトランザクションで検証する。
- 代理者が資格を失う・委任者が無効になる・期間外・取消済みのときは、可視性も決定も成立しない(fail closed)。
- 委任の作成・取消は承認権限の付与と同格の特権操作として監査に残す。入力値・個人データは監査・通知・Outbox に載せない。
- 新しい RLS の例外・`SECURITY DEFINER`・環境変数/フラグによる切替は設けていない。
- Security Reviewer(人間)の sign-off は**未取得**(Gate B GB-3)。

#### 未解決・確認事項

1. **決定の拒否の応答**: 委任が無い・資格を満たさない場合は、従来の 403「指定された承認者だけが決定できます」を維持した(WP §6.3 の「従来と同じ応答」、既存テストの期待)。一方、委任が有効でも ADR-0025 §3-6(ほかの段の approver_id である)や decided_by の非重複で拒否する場合は 404(「見えない申請」と同じ)にした。ブリーフの「決定の拒否は従来の「見えない申請」と同じ応答」と字面が異なるため、監督者の確認を求める。
2. **2段の相互作用**: 「代理として1段目→本人として2段目」は、ADR-0025 §3-6 が代理者の決定自体を拒否するため、正規の経路では到達しない。ADR・WP との矛盾ではなく、ADR §3-6 が decided_by の非重複より先に効く。実行前検証の `decided_by_duplicate` も多層の防御として残した。
3. 通知の一覧(`notification-list.service.ts`)のイベント型に委任の2種を加えていない。段階Bで画面の表示名(`apps/web`)と一緒に追加する(現状は「その他」と表示される)。
4. 委任の一覧は最大200件でページングしない(段階Bで必要なら追加する)。
5. 期間の上限30日・開始の猶予5分は API と DB の CHECK(30日)の両方で検証する。猶予5分は API だけである。

#### Evidence

`evidence/WP-P4-APR-020/20261115-0930/`(検証ログ・開発用DBの件数・`git status`)。


### 段階B の実行記録(2026-11-15)

段階Aへの指摘(ブリーフ §1)への対応、画面(§6.7)、検証。

#### 指摘への対応

1. **決定の拒否の応答**: 変更なし。委任が無い・資格を満たさない場合は従来の 403、委任は有効でも ADR-0025 §3-6・`decided_by` の非重複で拒否する場合は 404、の使い分けを維持した。
2. **委任の状態 `unknown`**: 変更なし。画面は「状態を確認できません」と表示し、有効とは扱わない(取消の入口も出さない)。
3. **助言ロック+トリガでの重なりの防止**: 変更なし。
4. **通知の一覧のイベント型**: `services/api/src/modules/notification/notification-list.service.ts` の `NOTIFICATION_EVENT_TYPES` と `apps/web/src/lib/notification-list.ts` の `NOTIFICATION_EVENTS` に `approval.delegation.created` / `approval.delegation.revoked` を追加した。表示名は「代理承認の委任の作成」「代理承認の委任の取消」。段階Aではサーバが委任のイベントを `other` に落としていた(画面では「その他」)。今回、サーバと画面の両方に型を追加し、通知の一覧の解析(`parseNotificationList`)も委任の通知をそのまま受け付ける。
5. **プロフィールの行が無い利用者**: 次のとおり**不具合だった**。
   - 現状: 有効な所属でも `org_member_profile` の行が無い利用者は、委任の作成で `approval_delegation` の複合外部キー(23503)に当たり、`create` は 23514 だけを 409 に変換していたため **500** になった。代理者の候補の一覧は、所属と `approver` ロールだけを見ており、行の無い利用者も候補に含めていた。
   - 既存の流儀: `services/api/src/modules/auth/department.service.ts` の `requireActiveMember` は、有効な所属でもプロフィール行が無い利用者を **409「組織プロフィールが未設定の利用者です。先にプロフィールを設定してください。」** で拒否する。行は `user-admin.service.ts` の `ensureOrgMemberProfile`(役割の付与・プロフィール更新と同じトランザクション)が作り、作らないのは役割の付与の経路が無い場合だけである(0037 のバックフィルも同じ前提)。
   - 対処(スキーマ・認可は変えない): 候補の一覧からプロフィール行の無い利用者を除く。委任者自身の行が無い場合は **409**(上記と同じ扱い)。代理者の行が無い場合は、存在・資格を漏らさないため**他の資格の無い代理者と同じ 403** にする。このAPIはプロフィールの行を作らない。
   - テスト: 「プロフィールの行が無い利用者: 委任者は 409、代理者は候補外・同じ 403(500 にしない)」。
6. **委任者本人の決定で足された 409**: 委任の無い既存の経路では**到達しない**ことをコードで確認した。理由は、(a) 固定承認者の重複はルールの保存時に 400 で拒否され、(b) 種別をまたぐ重複(固定承認者と上長が同じ人等)は申請の作成時にリゾルバの `duplicate_approver` が 409 で拒否し、(c) 再割当の再解決は承認済みの段の承認者を除外し重複も拒否し、(d) 申請内容の変更は旧版・旧世代の全ステップを `invalidated` にし、(e) `decide` が見るステップは現在の版だけである、ため。委任が無ければ `decided_by` は `approver_id` と一致するので、同一人物が2つの段の `decided_by` になる経路が残らない。テスト「委任の無い申請は、承認者の重複をリゾルバが拒否し、決定者の重複の 409 に到達しない」で、重複の保存 400・作成 409・1段目を承認した本人による2段目の決定が **403**(409ではない)を固定した。到達し得るのは、APIを経由せずに重複した `approver_id` の行・経路を作った場合だけである(サポートする経路ではない)。

#### 画面(§6.7)

- 置き場所は **`/settings/delegations`** にした(理由: これは「自分宛ての承認を誰に任せるか」という利用者ごとの設定であり、承認者でない利用者も上長として承認が来るため全員が開く。`/ops/approvals` は組織管理者だけの承認ルール、`/approvals` は既存の上位領域に無い。`/settings` はエージェント/サポート両方のシェルと戻り先の検証で既に扱われている)。WP §4 の想定(`apps/web/src/app/approvals/delegations/`)とは異なるため、`apps/web/src/app/settings/delegations/` を追加した。通知のリンク先も `/settings/delegations` に変えた。
- ナビゲーション: エージェントのユーザーメニュー(`AppFrame`)とサポートポータルのメニュー(`SupportFrame`)に「承認の委任」を追加。`/ops/approvals` の見出しから「代理承認の委任」、`/requests?view=approvals` から「代理承認の委任を管理する」を追加。
- 内容: 自分が任せている委任(代理者・開始・終了・状態・取消)、作成(代理者の `select`、開始・終了、確認のチェック)、自分が任されている委任(委任者・期間・状態・辞退)、組織管理者の組織のすべての委任と取消。作成の操作は管理者にも自分の分だけ。候補が0人のときは理由を出してフォームを出さない。説明文として範囲・最長30日・期間中も自分で承認できる・取消後も承認済みは有効・代理者は同時に1人を出した。
- 日時は `datetime-local` + 「日本時間・JST」で、既存の変更管理と同じく `+09:00` として送る。開始の既定は現在、終了の既定は無し。30日超・終了が開始以前などはAPIの 400 を項目(`startsAt` / `endsAt` / `delegateId`)に結び付けて表示し、理由のコードは出さない。成功は一覧を読み直し、実在する記録から文を作る(URLの値だけでは出さない)。表示名だけを使い、メールアドレス・社員番号は出さない。
- 代理の表示: 承認待ちの一覧に「◯◯さんの代理で判断できます」、受信箱はAPIの「◯◯さんの代理」をそのまま表示、詳細は `currentDelegation` があるときだけ代理の案内と承認・却下の操作を出す。承認の経過と記録は「承認者: ◯◯(代理: △△)」と表示する。委任の無い申請の表示は変えていない。

#### API 側の追加(応答への加算だけ)

- `GET /approval-delegations/candidates`: `org_member_profile` の行が無い利用者を除いた。
- `POST /approval-delegations`: 委任者自身のプロフィール行が無い場合 409、代理者の行が無い場合は 403(既存の資格の無い代理者と同じ文言)。
- 申請の詳細の `history[]` に `delegated`(boolean)を加算した(画面が `decided_by` と `approver_id` を突き合わせ直さないため)。
- 認可・検証・Migration の変更はない。

#### 変更ファイル

- `db/migrations/` — 変更なし(0042 は段階Aのまま)。
- `services/api/src/modules/catalog/approval-delegation.routes.ts`(プロフィール行の検査、候補の除外)
- `services/api/src/modules/catalog/catalog.routes.ts`(`history[].delegated` の加算)
- `services/api/src/modules/notification/notification-list.service.ts`(委任のイベント型)
- `services/api/src/modules/notification/notification.service.ts`(委任の通知のリンク先)
- `apps/web/src/lib/api.ts`(委任のAPI・型、`delegated` / `decidedBy` / `currentDelegation`)
- `apps/web/src/lib/approval-delegation.ts`(新規。表示名・文言・日時の変換・失敗の対応付け)
- `apps/web/src/lib/approval-route.ts`(経過の型に `delegated` / `decidedByName` を加算)
- `apps/web/src/lib/notification-list.ts`(委任の表示名)
- `apps/web/src/app/settings/delegations/page.tsx`、`actions.ts`、`DelegationForms.tsx`(新規)
- `apps/web/src/app/requests/page.tsx`、`apps/web/src/app/requests/[id]/page.tsx`(代理の表示。受信箱はAPIの値をそのまま表示するため画面の変更なし)
- `apps/web/src/app/ops/approvals/page.tsx`、`apps/web/src/components/AppFrame.tsx`、`apps/web/src/components/SupportFrame.tsx`(導線)
- `tests/security/approval-delegation.test.ts`(指摘5・6のテスト、通知のリンク先)
- `tests/unit/approval-delegation-ui.test.ts`(新規)、`tests/unit/notification-list-ui.test.ts`(委任のイベント型)
- `tools/ui_approval_routing_check.mjs`(`wp020` の段階。**今回は実行しない**。構文と既存の段階は確認済み)
- `docs/planning/.../WP-P4-APR-020.md`(§13 と `implementation_status`)
- `evidence/WP-P4-APR-020/20261115-1016/`

#### 検証(使い捨てDB `solvi_wp020_wp019_wp018_wp015_test`)

- `npx vitest run tests/security/approval-*.test.ts`: 250 passed(8ファイル)。
- `npx vitest run tests/security` 全体: 902 passed / 10 skipped。失敗は既知の読み込み不能6ファイルのみ(`knowledge-pagination`、`notification-*` 4件、`user-directory-consistency`)。テスト自体の失敗は0。
- `npx vitest run tests/unit/approval-*.test.ts tests/unit/catalog-*.test.ts tests/unit/requests-ui.test.ts tests/unit/notification-list.test.ts tests/unit/notification-list-ui.test.ts`: 1083 passed(28ファイル)。
- `npm run test:unit`: 34 failed / 4594 passed(108ファイル中4ファイル)。失敗は `knowledge-list`、`knowledge-search-page`、`performance-runtime`、`performance-search-static-cli` のみで、段階Aの基点(34件)と同じ。承認・カタログ・受信箱・通知の新規失敗は0。増えた pass 55 は新しいテスト(54 + 通知の1)である。
- `npm run typecheck`: エラー0。`npm run check:all`: OK。`npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'`: 警告0。`node tools/check_rls.mjs`(使い捨てDB): 問題0件。
- 見た目: **実画面ではないハーネス**(`globals.css` と `freshservice.css` をそのまま読み込み、画面と同じクラス・文言で組んだ静的HTML)で、Chromium と WebKit の 1440px / 375px のスクリーンショットと axe(serious / critical 0)。7状態 × 2エンジン × 2幅 = 28スキャン、深刻な違反0、375px の横はみ出し0。委任の画面の各状態(委任者・代理者・組織管理者・候補0人)と、代理の表示(一覧・詳細・受信箱)を撮った。**実画面の確認は 0042 適用後に別途**行う(下記「未解決」)。
- 開発用DB `solvi`: 作業の前後で件数は不変(下表)。書込み・Migration・seed・cleanup は行っていない(管理者接続の `SELECT` のみ)。

| テーブル | 作業前 | 作業後 |
|---|---|---|
| `app_user` | 15 | 15 |
| `role_binding` | 26 | 26 |
| `local_catalog_item` | 26 | 26 |
| `local_service_request` | 18 | 18 |
| `local_request_revision` | 23 | 23 |
| `local_request_approval` | 30 | 30 |
| `local_request_route_generation` | 2 | 2 |
| `local_request_approval_notice` | 8 | 8 |
| `department` | 22 | 22 |
| `department_head` | 7 | 7 |
| `approval_rule` | 14 | 14 |
| `approval_rule_revision` | 20 | 20 |
| `org_member_profile` | 15 | 15 |
| `audit_event` | 1960 | 1960 |
| `notification` | 95 | 95 |
| `outbox_event` | 454 | 454 |
| `schema_migration` | 42(最大0042) | 42(最大0042) |
| `pg_policies`(public) | 79 | 79 |

**注意**: ブリーフでは開発用DBは41件(0042 未適用)の前提だったが、実際には **0042 が既に適用されていた**(`schema_migration` の `0042.applied_at = 2026-11-15T00:55:15Z`。段階Bの作業開始より前)。42件・ポリシー79件はその結果であり、本作業では変更していない。`approval_delegation` は0行。

#### §7 の充足(段階B)

- 画面(§7-15): 委任の作成・取消・辞退、代理の表示を unit テストとハーネスで確認した。実画面(Chromium/WebKit、1440/375、axe)の操作は **0042 適用後に別の指示で行う**(本記録では未実施)。
- `check:all`・`typecheck`・`lint`・新規依存0(§7-16): 充足(依存の追加なし)。
- §7-1〜§7-14: 段階Aの充足を維持。指摘5・6の追加テストも含めて `tests/security/approval-*` が通過。

#### セキュリティ影響

- 段階Bでは認可を広げていない。候補の一覧は狭くし(プロフィール行の無い利用者を除く)、委任者自身の行が無い場合は 409、代理者の行が無い場合は他の資格の無い代理者と同じ 403 にした。
- 画面は認可を判定しない。作成・取消・一覧・候補の可否はAPIが決め、画面はAPIの値で表示を制御するだけである。
- 委任の画面は全認証済み利用者が開けるが、表示されるのはAPIが返した自分の委任(と `org_admin` の組織の委任)だけである。
- 新しい RLS の例外・`SECURITY DEFINER`・環境変数/フラグによる切替はない。Migration の変更もない。
- 代理の表示は表示名だけを使い、メールアドレス・社員番号を出さない。成功の文は実在する記録から作る。
- **Security Reviewer(人間)の sign-off は未取得**(Gate B GB-3)。

#### 未解決・確認事項

1. **開発用DBの Migration**: ブリーフの前提(41件・0042 未適用)と異なり、0042 が既に適用済みだった。本作業では変更していない。`tools/ui_approval_routing_check.mjs` の `wp020` は「今回は実行しない」の指示に従い実行していない。実画面の確認は監督者の指示を待つ。
2. **画面の置き場所**: WP §4 の想定 `/approvals/delegations` ではなく `/settings/delegations` にした(ブリーフ §2.1 の指示)。`apps/web/src/app/settings/delegations/` は WP §4 の列挙に無いパスである。通知のリンク先も合わせて変えた。
3. 実画面の操作は未実施。スクリーンショットと axe は**ハーネス**の結果であり、実画面の証明ではない。
4. 委任の一覧は最大200件でページングしない(段階Aから変わらず)。
5. 委任の詳細画面は無い(一覧の行とフォームだけ)。代理者が自分の決定を取り消す(`revoke`)操作は、詳細画面の既存の規則(`assigned` は現在の承認者だけ)に合わせて出していない。APIは許可する。
6. `notification-list.service.ts` の委任の2種は、通知の一覧の解析を通すために必要だった。表示名は `apps/web` と API の両方に置いている(既存の承認の通知と同じ)。

#### Evidence

`evidence/WP-P4-APR-020/20261115-1016/`(ハーネスのスクリーンショット・axe、検証ログ、開発用DBの件数、`git status`)。

#### 監督者の注記(2026-11-15、段階Bの検査)

- 委任の画面は `/settings/delegations`(`apps/web/src/app/settings/delegations/`)に置いた。§4 は `apps/web/src/app/approvals/delegations/` を見込みとして挙げ、「合わない場合は報告する」としていた。利用者ごとの設定であり、`/settings/notifications` と同じ流儀で作れるため、監督者がこの置き場所を認める。§4 の該当行は、このパスに読み替える。
- 利用者の指示で、開発用DBへ Migration 0042 を適用した(2026-11-15、42件)。

### 段階C の実行記録(2026-11-15)

開発用DB(`solvi`、Migration 42件・0042 適用済み)の実画面で、代理承認の委任を1回通した。**委任の作成までで停止した。** 申請の作成以降(ブリーフの6〜12)は未実施である。

#### 実施したこと

- 作業前の件数を管理者接続の `SELECT count(*)` で記録した。
- 承認者(`approver@acme.example.test`)の `/settings/delegations` で**候補0人**の表示を、Chromium / WebKit、1440px / 375px で撮影し、axe を実行した。
- 既存の公開済みカタログ項目「PC利用申請 [ノートPC]」(固定承認者 = `approver@acme.example.test`)の申請画面で、**設定された承認者**が委任者になることを読み取りで確認した。
- 組織管理者(`org_admin@acme.example.test`)が `/ops/users` から、`agent@acme.example.test` に `approver` ロールを**1回だけ**付与した(組織スコープ、期限なし)。付与前に、対象が `agent` ロールと `org_member_profile` の行を持つことを確認した。
- 承認者が `/settings/delegations` から、対象を代理者にして委任を**1件**作成した(開始は現在、終了は2日後)。成功の表示と一覧を両エンジン・両幅で撮影した。
- 確認スクリプトの不備で次の段階(作成フォームのキーボード確認)が失敗したため、**まず委任を取り消し、`approver` ロールを外した**(いずれも管理画面から)。2回目の実行はしていない。
- 片付けのあと、候補0人に戻ること、代理者だったアカウントの承認待ち・受信箱に代理の対象が無いこと、組織の委任一覧、通知の一覧を読み取りで確認し、両エンジン・両幅で撮影した。

#### 停止の原因

確認スクリプト(リポジトリ外の `.local/tmp/` に置いた)のセレクタの不備である。委任を1件作ったあとは `#delegation-mine` の中に「作成」と「取消」の2つのフォームが並び、どちらも `confirm` という名前のチェック欄を持つ。スクリプトが `#delegation-mine input[name="confirm"]` で1つに絞れている前提で `isChecked()` を呼んだため、strict mode violation で停止した。**製品の画面・APIの不具合ではない**(各フォームのスコープでは一意である)。実画面で観察した範囲では、委任の作成・成功の表示・一覧の状態表示に不具合は無かった。

#### 変更ファイル

- なし(製品コード・テスト・Migration を変更していない)。

#### 開発用DBの件数(作業前 10:41 / 作業後 10:52)

| テーブル | 作業前 | 作業後 | 差 |
|---|---|---|---|
| `app_user` | 15 | 15 | 0 |
| `role_binding` | 26 | 27 | +1(取消は行の削除ではなく `valid_until` の設定。下記) |
| `org_member_profile` | 15 | 15 | 0 |
| `local_service_request` | 18 | 18 | 0 |
| `local_request_revision` | 23 | 23 | 0 |
| `local_request_approval` | 30 | 30 | 0 |
| `local_request_route_generation` | 2 | 2 | 0 |
| `approval_delegation` | 0 | 1 | +1(取消済み) |
| `local_request_approval_notice` | 8 | 8 | 0 |
| `outbox_event` | 454 | 456 | +2(委任の作成・取消) |
| `notification` | 95 | 99 | +4(委任の作成・取消 × 委任者と代理者) |
| `department` | 22 | 22 | 0 |
| `approval_rule` | 14 | 14 | 0 |
| `local_catalog_item` | 26 | 26 | 0 |
| `audit_event` | 1960 | 2017 | +57(下記) |
| `schema_migration` | 42(最大0042) | 42(最大0042) | 0 |

- `role_binding` の +1 は、`approver` の付与で作られた行が、取消でも削除されず `valid_until` を入れて失効するためである(`valid_until = 2026-11-15T01:51:07Z`、現在より前)。対象の**有効な**ロールは作業前と同じ `agent`(acme)と `requester`(beta)である。
- `audit_event` の +57 の内訳は、`auth.login.success` 40、`platform.org_context.switched` 9、`notification.sent` 4、`role.binding.created` 1、`role.binding.deleted` 1、`approval.delegated` 1、`approval.delegation_revoked` 1。ログインと組織切替の49件は、両エンジンのブラウザセッション(下見を含む)によるものである。
- 片付け後: 取り消されていない委任0件、`UI020` を含む申請0件、対象アカウントの有効なロールは作業前と同じ、`org_approval_setting.rule_routing_enabled = true` の組織0件。

#### Migration

- なし(0042 は適用済み。変更していない)。

#### 画面と axe(実画面)

- 40枚(10状態 × Chromium / WebKit × 1440px / 375px)。`evidence/WP-P4-APR-020/20261115-1050/`(20枚)と同 `post-cleanup/`(20枚)。
- axe(wcag2a / 2aa / 21aa / 22aa): 40スキャンすべて違反0件(serious / critical は0)。375px の横はみ出し0、重複ID0。
- 見た目: 候補0人の案内、委任の成功の文(実在する記録から生成)、一覧の「有効」「取消済み」、対象アカウントの役割表示「オペレーター / 承認者」、取消後の「—」、通知の「代理承認の委任の作成」「代理承認の委任の取消」を確認した。

#### §7 の充足(段階C)

- 画面(§7-15): **一部のみ**。委任の画面の候補0人(付与前・取消後)、作成の成功、一覧の状態、組織の委任の一覧、通知の一覧を実画面で確認した。**委任の取消・辞退のフォーム、代理の表示、承認の経過、申請の完了は実画面で未確認**。キーボード操作も未確認(作成フォームの確認欄に到達する前に停止した)。
- §7-1〜§7-14: 段階A・Bの充足を維持(本段階では認可・APIを変更していない)。実画面での再確認は上記の範囲だけである。

#### セキュリティ影響

- 一時的に `approver` ロールを1つ付与し、同じ画面から失効させた(付与1回・取り外し1回)。有効なロールは作業前と同じである。
- 委任は1件だけ作成し、取消済みである。有効な委任は残っていない。
- 申請・カタログ・プロフィール・部署・承認ルール・ほかの利用者のロールは変更していない。
- 監査には `role.binding.created` / `role.binding.deleted` / `approval.delegated` / `approval.delegation_revoked` が残り、委任のイベントは委任者・代理者・委任のIDだけを含む(入力値・個人データなし)。通知の件名・リンクに `UI020` は含まれない。

#### 未実施・未確認

1. 申請の作成、代理者による承認、承認の経過の表示、模擬実行、委任の取消(通常の操作として)、2件目の委任と辞退、代理者宛ての承認の依頼の通知。**いずれも未実施**。
2. 30日を超える期間の作成失敗の表示(撮影していない)。
3. 作成・取消・辞退フォームのキーボード操作(作成フォームの確認欄に到達する前に停止)。
4. 委任の取消は、確認スクリプトの片付けとして管理画面から行った(理由を入力)。通常の操作としての撮影はしていない。

#### Evidence

`evidence/WP-P4-APR-020/20261115-1050/`(スクリーンショット20枚、`flow.json`、`session.json`、`run-log.txt`)と `post-cleanup/`(スクリーンショット20枚、`session.json`)。

### 段階C2 の実行記録(2026-11-15)

段階Cの停止(確認スクリプトのセレクタの不備)を直して実画面の確認をやり直した。**委任の作成から代理者による承認までは通ったが、確認スクリプトの別の不備(承認の依頼の通知の行の選び方)で停止した。** 停止後に委任の取消とロールの取り外しを行い、3回目は行っていない。2件目の委任と辞退、取消・辞退フォームのキーボード操作は未実施である。

#### 直したこと(ロールを付ける前)

- 確認スクリプト: 書込みを伴う操作を**フォーム単位**で特定するようにした。作成のフォームは「代理者の選択欄を持つフォーム」、取消・辞退は「対象の相手の名前を持つ `details`」で絞り、書込みの直前に要素がちょうど1つであることを検査し、そうでなければ書込みをせずに片付けへ進む。0件・1件・2件(1件取消済み)の状態をハーネスで、1件(取消済み)の実画面で下見した。
- 画面: 「委任の範囲と期間」に常に出ていた「代理者が今は承認者の役割を持たないか…」を常設の説明から外し、状態「代理者が資格なし」の行にだけ出した(`delegationStateNote`)。unit テスト、`typecheck`、`eslint` を通した。

#### 実施したこと

- 組織管理者が `agent@acme.example.test` に `approver` ロールを**1回だけ**付与した(11:40:54、組織スコープ・期限なし)。
- 承認者が委任を1件作成した(11:41:01、現在〜2日後)。成功の表示と一覧、30日を超える期間の作成失敗(何も作られないこと)、作成フォームのキーボード操作(両エンジン)を確認した。
- 申請者が `UI020` の申請を1件作成した(11:41:15)。代理者の受信箱・承認待ち・申請の詳細で「◯◯さんの代理」を確認し、**代理者として承認した**(11:41:37)。ステップの行(`approver_id`=委任者、`decided_by`=代理者、`delegation_id`)、監査 `approval.approved`、経路・`route_hash`・世代の不変を `SELECT` で確認した。
- 代理者宛ての「承認の依頼」の通知(件名 `[REQ-2026-000166] 承認の依頼があります`、リンク `/requests/<id>`、`UI020` を含まない)を `SELECT` で確認した。
- 承認の依頼の通知の確認で、スクリプトが同じ申請の通知の1件目(委任者宛て)を取り出して代理者宛てとみなす誤りがあり、停止した。**製品の不具合ではない**(委任者・代理者の2件が正しく配送されていた)。停止後、まず委任を取り消し(11:41:38、画面)、`approver` ロールを外した(11:41:39、画面)。2回目の付与は行っていない。
- 片付けのあと、申請を模擬実行で完了した(11:44:41、既存の `agent` 権限)。取消しのあとも承認済みのステップは有効のままだった。

#### 見つけて直した不具合

- **承認の記録(現在の版)に「(代理: △△)」が出ていなかった。** 承認の経過には出ていたが、「この版の申請内容を見る」の中の「承認者: ◯◯」に代理の表示が無かった。`apps/web/src/app/requests/[id]/page.tsx` で、現在の版にも `delegated`/`decidedByName` がある場合に「（代理: ◯◯）」を出すようにし、unit テストを追加した。ロールを外したあとの修正であり、実画面でも修正後の表示を確認した(ロールの再付与はしていない)。

#### 画面と axe(実画面)

- 96枚(24状態 × Chromium / WebKit × 1440px / 375px)。`evidence/WP-P4-APR-020/20261115-1140/`(52枚、13状態。停止までの記録)と同 `post-cleanup/`(44枚、11状態)。
- axe(wcag2a / 2aa / 21aa / 22aa): 96スキャンすべて違反0件(serious / critical は0)。375px の横はみ出し0、重複ID0、オフオリジンへのリクエスト0。
- 見た目: 候補0人、委任の作成の成功、状態「有効」「取消済み」、30日超の失敗(「30日以内」)、代理者の一覧・受信箱・承認待ち・詳細の「◯◯さんの代理」、承認の経過と記録の「承認者: ◯◯（代理: △△）」、完了、組織の委任の一覧(2件・取消済み)、通知の日本語の種別を確認した。

#### 開発用DBの件数(作業前 11:40 / 作業後 11:54)

| テーブル | 作業前 | 作業後 | 差 |
|---|---|---|---|
| `app_user` | 15 | 15 | 0 |
| `role_binding` | 27 | 28 | +1(取消は `valid_until` の設定) |
| `org_member_profile` | 15 | 15 | 0 |
| `local_service_request` | 18 | 19 | +1(合成の申請1件) |
| `local_request_revision` | 23 | 24 | +1 |
| `local_request_approval` | 30 | 31 | +1 |
| `local_request_route_generation` | 2 | 2 | 0 |
| `approval_delegation` | 1 | 2 | +1(取消済み) |
| `local_request_approval_notice` | 8 | 9 | +1 |
| `outbox_event` | 456 | 465 | +9(委任の作成・取消、承認の依頼、申請のチケットの出来事) |
| `notification` | 99 | 110 | +11(委任の作成・取消 × 委任者と代理者、承認の依頼 × 2、チケットの通知5) |
| `department` | 22 | 22 | 0 |
| `approval_rule` | 14 | 14 | 0 |
| `local_catalog_item` | 26 | 26 | 0 |
| `audit_event` | 2066 | 2126 | +60(ログイン28、組織切替6、通知11、承認5、ロール2、チケット・申請8) |
| `schema_migration` | 42(最大0042) | 42(最大0042) | 0 |

- 検査後: 取り消されていない委任0件、`UI020` の申請1件(完了)、対象アカウントの**有効な**ロールは作業前と同じ(`agent`(acme)+`requester`(beta))、ルールの使用が有効な組織0件。
- 残した合成データ: 取消済みの委任2件(段階Cの1件と本段階の1件)、完了した申請1件、期限切れの `role_binding` 2行(段階Cの1行と本段階の1行)。

#### §7 の充足(段階C2)

- 画面(§7-15): **一部のみ**。候補0人、委任の作成の成功、一覧の状態、30日超の失敗、代理者による承認、代理の表示、承認の経過と記録の「承認者: ◯◯（代理: △△）」、完了、取消後の一覧、組織の委任の一覧、通知の一覧を実画面で確認した。
- **未確認**: 2件目の委任と辞退、取消・辞退フォームのキーボード操作、2件(1件取消済み)の実画面でのセレクタ確認(ハーネスのみ)。
- §7-4(代理による決定の記録)は実画面と `SELECT` で確認した。§7-1〜§7-14 の残りは段階A・Bの充足を維持する(本段階で認可・APIは変更していない)。

#### セキュリティ影響

- 一時的に `approver` ロールを1つ付与し、1回だけ取り外した。有効なロールは作業前と同じである。2回目の付与はしていない。
- 委任は1件だけ作成し、取消済みである。有効な委任は残っていない。
- 申請・カタログ・プロフィール・部署・承認ルール・ほかの利用者のロールは変更していない。
- 監査の委任イベントは委任者・代理者・委任のIDだけを含み、入力値・個人データを含まない。通知の件名・リンクに `UI020` は含まれない。

#### 未実施・未確認

1. 2件目の委任と辞退(ロールの再付与が必要なため行っていない)。
2. 取消・辞退フォームのキーボード操作(委任の取消は片付けとして画面から行ったが、キーボードでは操作していない)。
3. 委任が2件(1件取消済み)の状態のセレクタのうち、**辞退フォーム**の実画面での確認(2件目を作っていない。取消のフォームは片付けで実画面から使用した)。0件・1件・2件(1件取消済み)の各状態の確認はハーネスで行った。
4. 通知一覧の日本語の種別は確認したが、代理者宛ての「承認の依頼」の行そのものの画面表示は `SELECT` で確認した(通知の一覧は種別の表示まで)。

#### 変更ファイル

- `apps/web/src/app/settings/delegations/page.tsx`(資格なしの説明を行に出す)
- `apps/web/src/lib/approval-delegation.ts`(`delegationStateNote`)
- `apps/web/src/app/requests/[id]/page.tsx`(現在の版の承認の記録に代理の表示)
- `tests/unit/approval-delegation-ui.test.ts`(2件のテスト)

#### Evidence

`evidence/WP-P4-APR-020/20261115-1140/`(スクリーンショット52枚、`flow.json`、`session.json`)と `post-cleanup/`(スクリーンショット44枚、`post.json`、`session.json`)。

#### 監督者の検査と利用者の承認(2026-11-15)

- 監督者が使い捨てDB(`solvi_wp020_wp019_wp018_wp015_test`)で再実行した: `typecheck`、`check:all`、`eslint`(`.claude/**` を除く)、`tools/check_rls.mjs`、`vitest run tests/security`(902件通過。失敗は既知の読み込み不能6ファイルだけ)、承認のセキュリティテスト250件、画面の unit テスト196件。コミット `23e89fe`、`b0750f8`、`b8c7aee`、`f03248a`。
- 利用者の指示で、開発用DBへ Migration 0042 を適用した(42件)。実画面の確認のため、利用者の承認のもとで、合成アカウント1つ(`agent@acme.example.test`)への `approver` ロールの一時的な付与を2回(段階C・段階C2で各1回)行い、いずれも同じ実行のなかで取り外した。監督者が管理者接続の `SELECT` で、有効なロールが作業前と同じであること、有効な委任が0件であること(取消済みの合成の委任が2件残る。委任の行は削除できない設計)、未完了の合成の申請が無いことを確かめた。
- 段階C2で、opencode が「書込みの無い下見」として実行したスクリプトが停止条件の誤りで本番の流れまで進んだ。書込みは承認の範囲(付与と取り外しは各1回、委任1件、申請1件)に収まった。
- 段階C2で見つけた不具合(承認の記録の欄に「(代理: …)」が出ない)は、ロールを外したあとに監督者の指示で直し、実画面で表示を確かめた(`f03248a`)。
- **実画面で確認していないもの**(テストで確認): 2件目の委任と代理者による辞退、取消・辞退フォームのキーボード操作、完了の後に委任を取り消す順序。
- **残る点**: (1) 代理者が自分の決定を取り消す操作は API では許すが、画面には出していない。(2) 承認の画面の置き場所は WP §4 の `/approvals/delegations` ではなく `/settings/delegations` とした(監督者が承認した逸脱。段階Bの記録)。(3) 高リスクの段での代理の可否は [[WP-P4-APR-021]] で決める。(4) Executor 側の承認再検証での代理の扱いは [[WP-P4-EXEC-004]] で決める。
- **2026-11-15、利用者(人間)が承認した。** セキュリティ関連の変更(承認の認可の拡張、新しいテーブルと RLS、監査、実行前検証)に対する人間のレビューを兼ねる。`done` とする。
