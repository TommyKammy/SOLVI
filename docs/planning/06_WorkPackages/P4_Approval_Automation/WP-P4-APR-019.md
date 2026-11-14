---
project: SOLVI
doc_id: "WP-P4-APR-019"
title: "承認の依頼時と期限前の通知・期限切れの記録・承認者不在時の管理者への通知"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.1.0"
created: "2026-11-14"
updated: "2026-11-15"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "notification", "escalation"]
source_of_truth: true
implementation_status: "review"
story_points: 8
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-011"]
depends_on: ["WP-P4-APR-018", "WP-P2-NTF-005"]
---

# WP-P4-APR-019: 承認の依頼時と期限前の通知・期限切れの記録・承認者不在時の管理者への通知

> [!note] 2026-11-15 に利用者(人間)の承認で `baseline` とした。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No([[WP-P4-APR-018]] の後) |
| Gate | Gate B(GB-3) |

## 1. Purpose

FR-CAT-011 の残りを引き受ける。承認者と申請者と組織管理者が、承認の進み具合を画面を見に行かなくても知れるようにし、期限切れを監査に残す。[[WP-P4-APR-017]] の §6-4 を分けたものである。

2026-11-14 に利用者が次を決定した。

- **エスカレーション先**: 承認者不在の申請を、その組織の組織管理者へ知らせる。承認者の移行は、人が実行する再割当([[WP-P4-APR-018]])だけで行う。ルールに代わりの承認者を持たせる方式は採らない(データモデルの変更もADRも不要)。
- **期限前の通知**: 期限の24時間前に、承認者へ1回。
- **依頼時の通知**: 段が承認待ちになった時点で、承認者へ通知する(現在は受信箱に出るだけで、通知が無い)。本WPに含める。
- **期限切れ**: 申請者へ通知する。

## 2. Requirement IDs

`FR-CAT-011`

## 3. Dependencies

[[WP-P4-APR-018]](done)、[[WP-P2-NTF-005]](done。Outbox と通知の経路)。先例: 役割の期限の予告([[WP-P1-IDM-017]]、`services/api/src/common/identity/binding-expiry.ts`)。

## 4. Scope / Allowed Paths

- `db/migrations/`(0041 の up / down だけ)
- `services/api/src/modules/catalog/`
- `services/api/src/modules/notification/`
- `services/api/src/common/outbox/outbox.ts`(イベント型の追加だけ)
- `services/api/src/common/audit/audit.ts`
- `services/api/src/main.ts`(定期処理の開始と停止の登録と、Outbox の処理へのイベント型の登録だけ)
- `packages/shared/src/`(通知の時点などの定数だけ)
- `apps/web/src/app/requests/`、`apps/web/src/app/ops/approvals/`、`apps/web/src/lib/`(状態 `expired` の行の表示への追従と、通知一覧の表示名が要る場合だけ)
- `tests/security/approval-notice.test.ts`、`tests/unit/approval-notice.test.ts`(新規)
- `tests/unit/` と `tests/security/` の既存の承認・通知テスト(追従だけ。削除・skip・緩和は不可)
- `tests/support/cleanup.ts`
- `tools/check_rls.mjs`(新しいテーブルの登録が必要な場合だけ)
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-019.md`(§13 だけ)
- `evidence/WP-P4-APR-019/`

## 5. Out of Scope

- 営業日カレンダー(期限は暫定の暦時間72時間のまま)。期限の長さを組織やルールごとに変える設定。
- 自動での承認者の差し替え、ルールに代わりの承認者を定義する方式([[ADR-0023_Relationship_Based_Approval_Authority]] §6)。
- 期限切れのステップの再割当(従来どおり再申請を求める)。
- 通知の文面への申請内容の掲載。チャットなど新しい通知の経路。利用者ごとの通知設定の画面の追加。
- 代理承認([[WP-P4-APR-020]])、高リスク二重承認([[WP-P4-APR-021]])。

## 6. Deliverables

### 6.1 通知の種類

| 種類 | 契機 | 宛先 | 回数 |
|---|---|---|---|
| 承認の依頼 | 段が `pending` になった(申請、申請内容の変更、前の段の承認、再割当) | その段の承認者 | ステップごとに1回 |
| 期限前の通知 | `pending` のまま、期限まで24時間以内になった | その段の承認者 | ステップごとに1回 |
| 期限切れ | `pending` のまま期限を過ぎた | 申請者 | ステップごとに1回 |
| 承認者不在 | `pending` で期限内のステップの承認者が無効([[WP-P4-APR-018]] の共有の判定) | その組織の、現在有効な組織管理者の全員 | ステップごとに1回 |

- 通知は既存の経路(Outbox → 通知)を使う。件名とリンクだけを持ち、**申請の入力値・理由・個人データを載せない**(既存の本文最小化の方針)。件名には申請番号を含めてよい。
- 宛先は、送る時点で「有効な所属」([[ADR-0023_Relationship_Based_Approval_Authority]] §1)である利用者に限る。無効な宛先には送らず、件数を記録する。
- 承認者不在の通知を、申請者本人である組織管理者へも送ってよい(知らせるだけで、再割当はできない)。
- 既存の利用者ごとの通知設定(`notification_preference`)との関係は、既存の通知の流儀に合わせる。判断が要る場合は、実装せずに報告する。

### 6.2 重複させない仕組み

- **Migration 0041**: 送信の記録 `local_request_approval_notice`(`organization_id`、`approval_id`、`kind`、`created_at`。主キー `(approval_id, kind)`、承認行への複合外部キー、RLS(ENABLE + FORCE)、`SELECT` / `INSERT` だけ、`UPDATE` / `DELETE` はトリガで拒否)。`kind` は CHECK で4種類に限る。down はデータがあれば拒否する。
- 通知を積むときは、同じトランザクションで先に記録を `INSERT` し、主キーの衝突なら積まない。定期処理の再実行・同時実行・プロセスの再起動で重複しない。
- 承認の依頼の通知は、ステップを作る処理と同じトランザクションで積む(定期処理に任せない)。

### 6.3 定期処理

- APIプロセスに、役割の期限の処理と同じ形の定期処理を1つ加える(期限前の通知、期限切れ、承認者不在の検知)。1周で扱う件数に上限を設ける。
- **組織境界**: 組織の一覧だけを、登録した読み取り専用の例外で読む(`organization` の `FOR SELECT` だけ、専用のフラグ `app.approval_sweep`、`SET LOCAL`。Migration 0041 に含め、[[02.18_Organization_Data_Model_and_RLS]] §3.6 に登録する。2026-11-15 に利用者が承認)。読むのは組織のIDだけである。承認・申請・通知・利用者のテーブルは越境させず、組織を1つずつ、その組織の文脈で読み書きする([[99.4_Decision_Log]] DL-019)。この1つ以外の例外を作らない。既存の例外のフラグを流用しない。
- **期限切れ**: 期限を過ぎた `pending` のステップを、遷移表の `expire` を通して `expired` にし、`approval.expired` を記録し、申請者への通知を積む。申請の行をロックし、決定・再割当と直列化する。監査の書込みに失敗したら、その1件を失敗させる(状態も変えない)。
- 実行者は「システム」として監査に残す。利用者の権限を借りない。
- 定期処理が止まっても、期限切れの承認で実行できないこと(実行前検証は期限をステップの行から直接検査する。現行のまま)。

### 6.4 状態 `expired` の行への追従

現在、期限切れは表示上の導出であり、行の状態は `pending` のままである。本WPから、行の状態が `expired` になる。次が従来と同じ結果になること。

- 決定・再割当: 期限切れのステップでは実行できない(409)。
- 実行前検証: 失敗する。
- 一覧・詳細・受信箱: 「期限切れ・再申請が必要」の表示。承認待ちとして出ない。承認者不在の一覧に出ない。
- 申請内容の変更: 期限切れのステップを無効化して、新しい版で再解決できる(遷移表に既にある)。
- 行が `pending` のまま期限を過ぎている状態(定期処理がまだ回っていない)でも、同じ結果になること。

### 6.5 監査

`approval.expired`(ステップ、段、世代、期限、申請の状態)。通知の送信は既存の `notification.sent` / `notification.failed` に従う。承認者不在の検知そのものは状態を変えないため、監査イベントを新設しない(送信の記録と通知の監査で追える)。

## 7. Acceptance Criteria

- [ ] 段が `pending` になる4つの契機(申請、申請内容の変更、前の段の承認、再割当)のそれぞれで、承認者への通知が1件だけ積まれる。
- [ ] 期限まで24時間以内の `pending` のステップに、期限前の通知が1回だけ積まれる。定期処理の再実行・同時実行で重複しない。24時間より前には積まれない。決定済み・無効・期限切れのステップには積まれない。
- [ ] 期限を過ぎたステップが `expired` になり、`approval.expired` が1回だけ記録され、申請者への通知が1件だけ積まれる。期限切れの承認での決定・再割当・実行が拒否される。
- [ ] 承認者不在のステップについて、その組織の有効な組織管理者の全員へ、ステップごとに1回だけ通知が積まれる。組織管理者が0人のときは積まれず、申請は滞留として残る。自動で別の人に承認権限が移らない。
- [ ] 通知の件名・リンク・Outbox の内容に、申請の入力値・理由・社員番号・役職・勤務地が含まれない。
- [ ] 通知と定期処理が組織境界を越えない(他組織の利用者へ送られない、他組織のステップを変えない)。RLS の例外は、登録した `organization` の読み取り1つだけである(承認・申請・通知のテーブルに例外ポリシーが無い。例外のフラグが次のトランザクションへ残らない。フラグ無しでは組織の一覧が0件になる)。
- [ ] 無効な宛先(停止された利用者、所属の切れた利用者)へ通知が送られない。
- [ ] 送信の記録が追記専用である(アプリケーションロールからの `UPDATE` / `DELETE` が拒否される)。他組織の記録が読めない。
- [ ] 期限切れと決定、期限切れと再割当が同時に起きても、状態と監査が二重にならない。
- [ ] 行が `pending` のまま期限を過ぎた状態と、`expired` になった状態で、決定・実行前検証・一覧・詳細・受信箱の結果が同じである。
- [ ] 定期処理を止めても、期限切れの承認で実行できない。
- [ ] Migration 0041 の up / down が往復でき、データがある状態の down が拒否される。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。既存の承認・通知テストに新しい失敗が無い。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態遷移)、TL-04(Migration)、TL-06(組織境界・宛先)、TL-16

### Evidence

- 通知の重複防止・期限切れ・承認者不在の通知のテスト結果、通知の内容に個人データが無いことの確認

`evidence/WP-P4-APR-019/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- **Security Reviewer(人間)の sign-off 必須**(監査への書込み、RLS 付きのテーブル、システムによる状態遷移を追加する)。
- 通知は情報の持ち出し経路になる。件名とリンクだけに限り、宛先を有効な所属に限る。
- 脅威 [[02.14_Threat_Model]] T-02(組織境界)、T-08。
- 生成する監査イベント: `approval.expired`。

## 10. Rollback / 失敗時の扱い

定期処理を止めれば、期限前の通知・期限切れの記録・承認者不在の通知が止まる。期限切れは、行の状態が `pending` のままでも従来どおり導出され、実行は拒否される。すでに `expired` になった行はそのまま有効である。Migration の down はデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに上がった後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(§1・§2・§6・§8) / ADR-0024(§3) / 03.5(FR-CAT-011) /
02.17(approval.expired) / WP-P2-NTF-005・WP-P1-IDM-017 の成果(Outbox、通知、定期処理の先例)。

手順:
1. 受入基準をテストへ変換し、先に書く(重複防止、4つの契機、期限切れの状態への追従、組織境界、宛先)。
2. Migration 0041、通知の種類、依頼時の通知、定期処理、期限切れの遷移、表示の追従の順に実装する。
3. 行が pending のまま期限を過ぎた場合と expired の場合の両方で、既存の検査が同じ結果になることを確かめる。

やってはいけないこと:
- 登録した1つ(`organization` の読み取り)以外の RLS の例外ポリシー。自動での承認者の差し替え。通知への申請内容の掲載。
- 遷移表を通さない状態の更新。承認済みステップの行の書き換え。
- テストのskip・削除、新規依存、Allowed Paths外の変更、ADRの決定の黙った変更。
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
| 2026-11-15 | 監督者 | - | 着手前の訂正 | - | (1) §4 の `main.ts` に「Outbox の処理へのイベント型の登録」を加えた(登録しないと、積んだ通知が処理されない)。(2) §6.3 の「組織を1つずつ処理する」には組織の一覧が要るが、`organization` は RLS 配下で、組織の文脈が無い定期処理からは読めない([[02.18_Organization_Data_Model_and_RLS]] §3 の例外は登録制)。計画時の見落としである。段階Aでは組織1つ分の処理までを実装し、一覧の取得と定期処理の登録は、利用者の判断を待つ。 |
| 2026-11-15 | 実装担当(AI) | 作業ツリー(未コミット) | 段階A 完了(定期処理の登録は未実施) | `evidence/WP-P4-APR-019/20261115-0647/` | Migration 0041(通知の記録)・通知の4種類と配送・依頼時の通知(4契機)・組織1つ分の定期処理・期限切れの遷移と監査・`expired` の追従。**定期処理の開始・停止と組織の一覧の取得は、ブリーフの指示により実装していない**(`check:all` の未接続検査はこの理由で失敗する)。`apps/web/` は未変更(画面の変更は不要と判断。報告に根拠)。 |
| 2026-11-15 | 実装担当(AI) | 作業ツリー(未コミット) | 段階B 完了(検査待ち) | `evidence/WP-P4-APR-019/20261115-0721/` | 検査の指摘1.1〜1.3 の修正、Migration 0041 への `organization` の読み取り例外(§3.6)、全組織の巡回と `main.ts` への開始・停止の登録、`expired` の画面確認と通知の表示名。`check:all`・`typecheck`・`check_rls` が通る。開発用DBは未変更(40件・最大 `0040`)。 |

### 2026-11-15 段階A 実装記録

**範囲**: §6 の 1〜4・6.5(監査)。§6.4 の画面は段階B。§6.3 のうち組織の一覧の取得と定期処理の `main.ts` への登録は、ブリーフの指示により対象外。

#### 変更ファイル

- `db/migrations/0041_local_request_approval_notice.sql`(新規)
- `services/api/src/modules/catalog/approval-notice.ts`(新規。通知の記録と依頼の通知、宛先のSQL)
- `services/api/src/modules/catalog/approval-notice-sweep.ts`(新規。組織1つ分の1周)
- `services/api/src/modules/catalog/membership.ts`(新規。有効な所属のSQL述語を循環なしで共有)
- `services/api/src/modules/catalog/approval-state.ts`(ステップ作成と依頼の通知を1か所に統合、表示用の状態)
- `services/api/src/modules/catalog/approval-assertion.ts`(期限切れの行を `approval_expired` で fail closed)
- `services/api/src/modules/catalog/approval-resolver.ts`(`activeMembershipSql` の再輸出だけ)
- `services/api/src/modules/catalog/catalog.routes.ts`(一覧・詳細の表示、再割当の期限切れコード、通知の記録)
- `services/api/src/modules/inbox/inbox.routes.ts`(期限切れの行を承認待ちにしない)
- `services/api/src/modules/notification/notification.service.ts`(件名・リンク・宛先の解決)
- `services/api/src/modules/notification/notification-list.service.ts`(イベント型の表示)
- `services/api/src/common/outbox/outbox.ts`(イベント型4件)
- `services/api/src/common/audit/audit.ts`(コメントの追従のみ。`approval.expired` は既にあった)
- `services/api/src/main.ts`(Outbox の処理への登録だけ)
- `packages/shared/src/index.ts` / `packages/shared/src/notification/approval-notice.ts`(新規、24時間の定数)
- `tests/security/approval-notice.test.ts`(新規、32 tests)
- `tests/unit/approval-notice.test.ts`(新規、10 tests)
- `tests/security/approval-assertion.test.ts` / `approval-steps.test.ts` / `approval-reassign.test.ts` / `approval-routing.test.ts`(後始末と 0041 追加への追従だけ)
- `tests/support/cleanup.ts`(通知の記録の後始末)

`apps/web/`、`tools/ui_approval_routing_check.mjs`、`package.json`、lockfile、`.env` は未変更。

#### Migration 0041

- 新規 `local_request_approval_notice`。列は `organization_id` / `approval_id` / `kind` / `created_at`。
  主キー `(approval_id, kind)`。承認行 `local_request_approval (id, organization_id)` への複合外部キー
  (既存の `UNIQUE(id, organization_id)` を使う。承認行に制約は足していない)。
- `kind` は `requested` / `expiring` / `expired` / `approver_unavailable` の CHECK。
- RLS(ENABLE + FORCE、`organization_id = app_current_org()`)。`solvi_app` は `SELECT` / `INSERT` だけ。
  `UPDATE` / `DELETE` は共有の拒否関数 `reject_asset_history_change()` で拒否する(0040 と同じ流儀)。
- down は行が1件でもあれば拒否する(`SET LOCAL row_security = off` で数える)。既存のテーブルの定義・権限は変えない。

#### 通知の種類と配送

- Outbox のイベント型: `approval.notice.requested` / `approval.notice.expiring` /
  `approval.notice.expired` / `approval.notice.approver_unavailable`。payload は
  `{ approvalId, requestId }` の識別子だけ。
- 件名は `[申請番号] <種類の文>`。リンクは `/requests/<申請ID>`。入力値・理由・社員番号・役職・勤務地を載せない。
- 宛先は配送時にDBから解決する。承認者・申請者は `activeMembershipSql`(ADR-0023 §1)で有効な所属を再確認し、
  承認者不在は `activeOrgAdminRecipientSql` で現在有効な `org_admin` の全員にする。
- `notification_preference` は `ticket_email_enabled` だけを持ち、チケット以外の通知を止めない。
  既存の `role.binding.expiring` と同じ扱い(常に送る)にした。新しい設定キーは作っていない。

#### 依頼の通知を積む箇所

`insertPendingApprovalStep`(`approval-notice.ts`)の**1か所**。申請・申請内容の変更(`addRevisionAndStep`)、
前の段の承認(`applyApprovalDecision`)、再割当(`applyReassignment`)のすべてがこの関数を通る。
同じトランザクションで `local_request_approval_notice` を `ON CONFLICT DO NOTHING` で `INSERT` し、
記録できたときだけ Outbox へ積む。

#### 組織1つ分の定期処理

`ApprovalNoticeSweeper.runOnce({ organizationId, now })`。期限前 → 期限切れ → 承認者不在の順。
候補の読み取りは `LIMIT 200`(`APPROVAL_NOTICE_BATCH_LIMIT`)。1件ごとに1トランザクションで、
その組織の `app.current_org` を設定する。期限切れは申請の行を `FOR UPDATE` でロックし、ロック後に
状態と期限を読み直し、遷移表の `expire` を引いてから `expired` にする。監査に失敗したらその1件だけを
巻き戻し、ほかの件は続ける。承認者が0人のときは記録も Outbox も作らない。経路・世代・承認済みの行は変えない。

#### 状態 `expired` の追従

`state = 'pending'` を見ていた問い合わせの扱いは、最終報告(`.local/briefs/WP-P4-APR-019-A.report.md`)の
第5節に一覧で記録した。要点だけ:

- 決定: 同じ 409・同じ文言(変更なし。行の状態で拒否する)。
- 再割当: 期限切れの理由コードを、行が `pending` のままでも `expired` でも `expired` にそろえた。
- 実行前検証: 期限切れの行を `approval_expired` として失敗させる(fail closed)。
- 一覧: `approvalState` を期限で `expired` にそろえ、承認者不在の一覧から期限切れを外した。
- 詳細: `approval` / `steps` / `effectiveSteps` / `history` の状態を同じ規則でそろえ、`approverUnavailable` を
  期限切れでは出さない。
- 受信箱: 期限を過ぎたステップを承認待ちにしない(行が `pending` でも `expired` でも同じ)。
- 申請内容の変更: 遷移表のとおり、どちらの状態でも新しい版を作れる。

画面(`apps/web/`)は既に `expires_at` から期限切れを導出し、`expired` のステップの表示名も持っていたため、
変更していない。

#### 検証

```text
npm run typecheck                      # exit 0
npm run lint                           # exit 1(リポジトリ外の .claude/ の worktree の1件。下記)
npx eslint . --ignore-pattern '.claude/**'   # exit 0
npm run check:all                      # exit 1(check_unwired が ApprovalNoticeSweeper を未接続とする)
node tools/check_rls.mjs               # OK(使い捨てDB)
npx vitest run tests/security/approval-*.test.ts   # 7 files / 189 passed
npx vitest run tests/security           # 9 failed | 34 passed(30 failed / 811 passed / 10 skipped)
                                        # 既知の読み込み不能6ファイル + S3 403 の3ファイルのみ
npm run test:unit                       # 34 failed / 4515 passed(失敗名は基点と完全一致、新規失敗0)
```

- `npm run lint` の1件は `.claude/worktrees/.../apps/web/next-env.d.ts`(このWPの変更ではない、
  追跡外の作業ツリー)。`.claude/**` を除くと exit 0。
- `npm run check:all` の失敗は `check_unwired` の「`ApprovalNoticeSweeper` がテストからしか呼ばれていない」。
  定期処理の開始・停止の登録と組織の一覧の取得は、ブリーフの指示により実施していないため、想定どおりである。
- 開発用DBは `SELECT count(*)` のみ。作業前後で件数は同じ(すべて0)、Migration は40件・最大 `0040`。
  - **2026-11-15 段階B 訂正**: 「すべて0」は誤りである。アプリ用の接続で組織の文脈なしに数えたため、RLS で0件に見えていた。段階Aの報告の「環境が初期化されている」も同じ理由で誤りである。管理者接続(`DATABASE_ADMIN_URL`)で数えた段階Bの作業前後の値は `app_user` 15、`role_binding` 26、`local_service_request` 17、`local_request_revision` 22、`local_request_approval` 29、`local_request_route_generation` 2、`outbox_event` 440、`notification` 82。前後で同じ。Migration は40件・最大 `0040` のままである。

#### §7 受入基準の充足

| 基準 | 状態 | 証拠 |
|---|---|---|
| 4契機で依頼の通知が1件 | 充足 | `approval-notice.test.ts` の「依頼の通知」5件 |
| 24時間以内に1回・再実行/同時実行で重複しない・古い状態には積まない | 充足 | 同「期限前の通知」4件 |
| 期限切れ・監査1回・申請者への通知1件・決定/再割当/実行の拒否 | 充足 | 同「期限切れ」6件 |
| 承認者不在の全員通知・0人なら積まない・自動で差し替えない | 充足 | 同「承認者不在」4件 |
| 件名・リンク・Outbox に個人データを載せない | 充足 | 同「通知の内容」1件 |
| 組織境界(RLS の例外なし) | 充足 | 同「組織境界」「RLS の例外ポリシー」 |
| 無効な宛先へ送らない | 充足 | 同「宛先は配送の時点の有効な所属」 |
| 記録が追記専用・他組織から読めない | 充足 | 同「送信の記録の保護」2件 |
| 期限切れ×決定/再割当の同時実行 | 充足 | 同「期限切れ×決定」「期限切れ×再割当」 |
| `pending` のまま期限超過と `expired` の結果が同じ | 充足 | 同「状態 expired の行への追従」3件 |
| 定期処理を止めても実行できない | 充足 | 同「実行前検証は定期処理に依存しない」 |
| Migration 0041 の往復とデータあり down の拒否 | 充足 | 同「Migration 0041」2件 |
| `check:all` / `typecheck` / `lint` | 一部 | `typecheck` は通過。`lint` は追跡外の `.claude/` の1件、`check:all` は定期処理未登録のため未接続検査で失敗(いずれも理由は上記) |
| 定期的な通知・期限切れの実行(定期処理の登録) | **登録待ち** | 組織の一覧の取得と併せて、利用者の判断を待つ |

#### セキュリティ影響

RLS 付きの新しいテーブル1つ、`approval.expired` の監査書込み、システムによる状態遷移を追加した
(人間の Security Reviewer の sign-off が必須)。新しい RLS の例外ポリシー・`SECURITY DEFINER`・
`BYPASSRLS` は作っていない。通知は件名とリンクと識別子だけに限り、宛先は配送時の有効な所属に限った。
承認者の自動差し替えと通知への申請内容の掲載は行っていない。

#### 未解決事項

- 組織の一覧の取得方法(登録制の例外)と、定期処理の開始・停止の `main.ts` への登録。
- `npm run check:all` の未接続検査をどう扱うか(登録までの間、意図的に未接続であることを記録する方法)。
- `notification_preference` に承認通知の設定を足すか(現行は既存の `role.binding.expiring` と同じく常に送る)。

#### Evidence

`evidence/WP-P4-APR-019/20261115-0647/`。

### 2026-11-15 段階B 実装記録

**範囲**: 監督者の検査の指摘1.1〜1.3、§6.3 の組織の一覧の取得と定期処理の `main.ts` への登録、§6.4 の画面の確認、通知一覧の表示名。

#### 指摘への対応

- **1.1 候補の抽出**: `findExpiring` / `findUnavailable` に、同じ `(approval_id, kind)` の送信の記録があるステップを除く `NOT EXISTS` を足した。記録の `INSERT` 時の主キーによる重複防止は残した(抽出は効率、主キーは正しさ)。承認者が0人の組織では、不在の候補を読んだあと**組織管理者の人数を1回だけ**確かめ、0人ならその周の不在の処理を打ち切る(1件ずつのトランザクションを繰り返さない)。管理者が任命されれば次の周から進む。上限はコンストラクタの引数 `batchLimit` で小さくできる(環境変数は使わない)。
- **1.2 非 null 表明**: `approval-state.ts` の `routeGeneration: input.nextRouteGeneration!` をやめ、`typeof === 'number'`・整数・1以上を先に検査し、満たさなければ409で止める。`input.nextStep!` も同じく明示の検査にした。
- **1.3 開発用DBの件数**: 管理者接続(`DATABASE_ADMIN_URL`)の `SELECT count(*)` で数え直した。段階Aの「すべて0」はRLSによる見え方の誤りであり、上記の訂正を付けた。作業前後で件数は同じ。

#### Migration 0041 の変更

0041 は開発用DBに未適用のため、ファイルを直接直した(0042 は作らない)。

- `organization` に `organization_approval_sweep_lookup`(`FOR SELECT`、`current_setting('app.approval_sweep', true) = 'on'`)を1件だけ足した。`COMMENT ON POLICY` を既存の例外(0016 / 0020)の流儀で付け、down で `DROP POLICY IF EXISTS` する。これ以外のポリシー・権限・関数は足していない。
- 使い捨てDBは 0041 を down してから up し直した。up → down → up と、データがある状態の down の拒否(前進修復)を確認した。

#### 巡回

- 組織の一覧: 専用の短いトランザクションで `set_config('app.approval_sweep','on',true)` を立て、`organization` の `id` だけを読んでコミットする。そのトランザクションで業務テーブルは読み書きしない。
- そのあと `ApprovalNoticeSweeper.runOnce({ organizationId, now })` を組織ごとに呼ぶ。組織ごとの処理では `app.approval_sweep` を立てない。順序は期限前 → 期限切れ → 承認者不在。
- 1つの組織の失敗は数えてログに残し、次の組織へ進む(申請の内容・個人データはログに出さない)。
- 前の周が終わっていないうちに次の周を始めない(同じプロセス内の `sweeping` で判定。別プロセスとの重なりは、記録の主キーと申請行のロックで吸収する)。
- 間隔は10分(`APPROVAL_NOTICE_SWEEP_INTERVAL_MS`)。起動時に1周し、停止時に `clearInterval` する。`binding-expiry.ts` の `startRoleBindingExpiryLoop` と同じ形で、`main.ts` の変更はこの登録だけである。接続プールは役割の期限の処理と同じ `db.authPool()` を使い、既存の例外のフラグを立てない。

#### 画面

- 一覧・詳細・承認待ち・受信箱は、期限を `expires_at` から導出しており、`expired` の行と `pending` のまま期限を過ぎた行で「期限切れ・再申請が必要」の表示になる。承認・再割当の操作は出ない(APIも両方を同じに扱う)。
- 詳細の承認の経過は、画面でも API と同じ規則(`displayStepState`)で `pending` の期限超過を `expired` にそろえた。応答が届いてから描画するまでに期限が過ぎても表示が変わらない。
- 通知の一覧(管理者向け)に4種類の日本語の表示名を足した。内部のイベント型は画面に出ない。表示名が無いと `parseNotificationList` が一覧全体を拒否していたため、これは必須の追従である。
- 通知のリンク `/requests/<申請ID>` は、承認者・申請者・組織管理者のいずれも開ける(詳細APIの `visible` と `staff`)。承認者は期限前ならそのまま承認でき、申請者は期限切れのあと内容を変更して再申請できる。組織管理者は開けるが、再割当の操作は `/ops/approvals` にあり、詳細画面には無い。認可は変えず、リンク先の候補として最終報告に挙げた。

#### 変更ファイル(段階B)

- `db/migrations/0041_local_request_approval_notice.sql`(組織一覧の例外を追加)
- `services/api/src/modules/catalog/approval-notice-sweep.ts`(候補の除外・上限の引数・0人の打ち切り・組織の一覧・全組織の巡回・ループ)
- `services/api/src/modules/catalog/approval-state.ts`(非 null 表明の除去)
- `services/api/src/main.ts`(定期処理の開始と停止の登録)
- `packages/shared/src/notification/approval-notice.ts`(巡回の間隔)
- `apps/web/src/lib/notification-list.ts`(4種類の表示名)
- `apps/web/src/lib/approval-route.ts`(`displayStepState`)
- `apps/web/src/app/requests/[id]/page.tsx`(表示のそろえ)
- `tests/security/approval-notice.test.ts`(指摘1.1・2.2・3、Migration のポリシー2件)
- `tests/unit/approval-notice.test.ts`(間隔、表示名、表示規則のAPIとの一致)
- `tests/unit/approval-state.test.ts`(世代が数値でない場合に409で止め、DBを触らない)
- `tests/unit/request-detail-recovery-ui.test.ts`(`expired` と期限超過の表示・操作)

#### 検証

```text
npm run typecheck                                    # exit 0
npm run check:all                                    # exit 0(check:unwired を含む)
node tools/check_rls.mjs                             # 問題 0 件(使い捨てDB)
npx eslint . --max-warnings=0 --ignore-pattern '.claude/**'   # exit 0
npm run lint                                         # exit 1(.claude/worktrees/ の追跡外ファイル1件のみ)
npx vitest run tests/security/approval-*.test.ts     # 5 files / 167 passed
npx vitest run tests/security                         # 6 failed(既知の読み込み不能6ファイル)/ 37 passed
                                                      # 853 passed / 10 skipped。S3 の 403 は無し
npm run test:unit                                    # 34 failed / 4526 passed(基点と同じ34件。新規失敗0)
```

- `npm run lint` の1件は `.claude/worktrees/.../apps/web/next-env.d.ts`(このWPの変更ではない)。`.claude/**` を除くと exit 0。
- `npm run test:unit` の失敗は `knowledge-list` / `knowledge-search-page` / `performance-runtime` / `performance-search-static-cli` の4ファイルだけである。承認・通知・申請のテストは失敗していない。
- 開発用DBは管理者接続の `SELECT` のみ。前後で件数は同じ(上記の訂正)。Migration は40件・最大 `0040`。

#### §7 受入基準の充足

| 基準 | 状態 | 証拠 |
|---|---|---|
| 4契機で依頼の通知が1件 | 充足 | `approval-notice.test.ts` の「依頼の通知」5件 |
| 24時間以内に1回・再実行/同時実行で重複しない・古い状態には積まない | 充足 | 同「期限前の通知」4件、同「候補の抽出」3件 |
| 期限切れ・監査1回・申請者への通知1件・決定/再割当/実行の拒否 | 充足 | 同「期限切れ」6件 |
| 承認者不在の全員通知・0人なら積まない・自動で差し替えない | 充足 | 同「承認者不在」4件、同「候補の抽出」1件 |
| 件名・リンク・Outbox に個人データを載せない | 充足 | 同「通知の内容」1件 |
| 組織境界(例外は `organization` の読み取り1つだけ。フラグは残らない。フラグ無しは0件) | 充足 | 同「組織の一覧の例外」4件、同「巡回」3件、同「RLS」1件 |
| 無効な宛先へ送らない | 充足 | 同「宛先は配送の時点の有効な所属」 |
| 記録が追記専用・他組織から読めない | 充足 | 同「送信の記録の保護」2件 |
| 期限切れ×決定/再割当の同時実行 | 充足 | 同「期限切れ×決定」「期限切れ×再割当」 |
| `pending` のまま期限超過と `expired` の結果が同じ | 充足 | 同「状態 expired の行への追従」3件、`request-detail-recovery-ui.test.ts` 2件 |
| 定期処理を止めても実行できない | 充足 | 同「実行前検証は定期処理に依存しない」 |
| 定期処理の登録(開始・停止・10分・起動時に1周・重なりの防止) | 充足 | 同「巡回」3件、同「バッチの上限・定期処理の登録」2件 |
| Migration 0041 の往復とデータあり down の拒否 | 充足 | 同「Migration 0041」2件 |
| `check:all` / `typecheck` / `lint` | 充足 | 上記の検証。`lint` は追跡外の `.claude/` の1件のみ |
| 新規依存0件 | 充足 | `package.json`・lockfile は未変更 |

#### セキュリティ影響

RLS の例外を1件だけ追加した(`organization` の `FOR SELECT`、`app.approval_sweep`。`SET LOCAL` のみ、読むのは `id` だけ)。承認・申請・通知・利用者のテーブルには例外を設けていない。システムによる期限切れの状態遷移と監査の書込みは段階Aから変わらない。定期処理は組織を1つずつ処理し、失敗を隔離する。通知の宛先・内容の制約は段階Aから変わらない。**人間の Security Reviewer の sign-off が必須**である。

#### 未解決事項

- 承認者不在の通知のリンクは `/requests/<申請ID>` であり、組織管理者は申請を開けるが、再割当の操作は `/ops/approvals` にある。より適したリンク先の候補として `/ops/approvals#approval-unavailable` を最終報告に挙げた(認可は変えていない)。
- 開発用DBへ 0041 を適用するまで、開発環境で申請・決定・再割当が失敗する(段階Aから同じ)。定期処理は組織の一覧が0件のまま何もしない。
- `notification_preference` に承認通知の設定を足すか(現行は `role.binding.expiring` と同じく常に送る)。

#### Evidence

`evidence/WP-P4-APR-019/20261115-0721/`
