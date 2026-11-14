---
project: SOLVI
doc_id: "WP-P4-APR-019"
title: "承認の依頼時と期限前の通知・期限切れの記録・承認者不在時の管理者への通知"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.0.0"
created: "2026-11-14"
updated: "2026-11-15"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "notification", "escalation"]
source_of_truth: true
implementation_status: "not-started"
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
- `services/api/src/main.ts`(定期処理の開始と停止の登録だけ)
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
- **組織境界**: 新しい横断の読み取り例外(RLS の例外ポリシー)を作らない。組織を1つずつ、その組織の文脈で処理する。組織の一覧を取れない場合は、例外を足さずに報告する。
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
- [ ] 通知と定期処理が組織境界を越えない(他組織の利用者へ送られない、他組織のステップを変えない)。新しい RLS の例外ポリシーが無い。
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
- 新しい RLS の例外ポリシー。自動での承認者の差し替え。通知への申請内容の掲載。
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
| - | - | - | Not started | - | - |
