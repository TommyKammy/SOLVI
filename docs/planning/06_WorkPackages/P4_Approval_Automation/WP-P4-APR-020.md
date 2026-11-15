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
implementation_status: "in-progress"
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

