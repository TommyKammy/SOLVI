---
project: SOLVI
doc_id: "WP-P4-APR-018"
title: "承認者不在の申請の再割当(経路の世代の保存・API・画面)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "1.0.0"
created: "2026-11-14"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "reassignment"]
source_of_truth: true
implementation_status: "not-started"
story_points: 5
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-013"]
depends_on: ["WP-P4-APR-015", "WP-P4-APR-016"]
---

# WP-P4-APR-018: 承認者不在の申請の再割当(経路の世代の保存・API・画面)

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Backend + Frontend + Security Reviewer |
| Parallelizable | No([[WP-P4-APR-019]] の前) |
| Gate | Gate B(GB-3) |

## 1. Purpose

承認者不在で止まった申請を、組織管理者が「再割当」で進められるようにする。[[WP-P4-APR-015]] §6.2 で見送り、[[WP-P4-APR-017]] へ移していた項目である。再割当後の経路は、[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]] §1〜§3 のとおり、追記専用の別テーブルに世代として保存する。版のテーブルは書き換えない。

## 2. Requirement IDs

`FR-CAT-013`(承認経路の固定と再割当のうち、未充足の「再割当」)

## 3. Dependencies

[[WP-P4-APR-015]](done)、[[WP-P4-APR-016]](done)。[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]](accepted、2026-11-14)。

## 4. Scope / Allowed Paths

- `db/migrations/`(0040 の up / down だけ)
- `services/api/src/modules/catalog/`
- `services/api/src/modules/inbox/inbox.routes.ts`
- `services/api/src/common/audit/audit.ts`
- `packages/shared/src/catalog.ts`
- `apps/web/src/app/ops/approvals/`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/requests/actions.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/approval-route.ts`
- `tests/security/approval-reassign.test.ts`(新規)
- `tests/unit/approval-reassign.test.ts`、`tests/unit/approval-reassign-ui.test.ts`(新規)
- `tests/unit/` と `tests/security/` の既存の承認テスト(現在の経路の導出が変わることへの追従だけ。削除・skip・緩和は不可)
- `tests/support/cleanup.ts`
- `tools/check_rls.mjs`(新しいテーブルの登録が必要な場合だけ)
- `tools/ui_approval_routing_check.mjs`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-018.md`(§13 だけ)
- `evidence/WP-P4-APR-018/`

## 5. Out of Scope

- 期限前の通知とエスカレーション([[WP-P4-APR-019]])、代理承認([[WP-P4-APR-020]])、高リスク二重承認([[WP-P4-APR-021]])。
- 期限切れのステップの再割当(従来どおり再申請を求める)。
- 承認ルールを使わない経路(承認者を1人指定する従来方式)の再割当。
- 承認者を管理者が手で選ぶ機能。再割当は、ルールと現時点の組織データからの再解決だけである。
- 版のテーブルへの `UPDATE` 権限の付与。Executor との接続。

## 6. Deliverables

1. **Migration 0040**: `local_request_route_generation`(ADR-0024 §1 の列・主キー・版への複合外部キー・RLS(ENABLE + FORCE)・`SELECT` / `INSERT` だけの権限・`UPDATE` / `DELETE` を拒否するトリガ)。`route_generation >= 2`、`from_step_no` は1〜3、`reason` の長さの CHECK。down はデータがあれば拒否する。
2. **現在の経路の導出**: 版の列と世代の行から「現在の経路」「段ごとの有効な世代」を返す共有関数を1つ置く。決定、`assertApprovalComplete` / `checkApprovalComplete`、承認待ち一覧、申請の詳細、滞留の導出を、すべてこの関数へ置き換える。
3. **実行前検証の拡張**: 各段について、有効な世代のステップ行が承認済みで、承認者・権限種別・`route_hash` が現在の経路と一致することを検証する。`from_step_no` より前の段が直前の世代と一致しない場合は失敗する。世代の行が読めない・欠けている場合も失敗する(fail closed)。
4. **再割当API**: 申請を指定する POST のエンドポイントを1つ加える(パスは既存の決定APIの並びに合わせる。本文は `reason` だけ。承認者のIDは受け取らない)。条件は ADR-0024 §3 のとおり。
   - `org_admin` 以外は403。申請者本人は `org_admin` でも403。他組織・存在しないIDは404。
   - 現在の `pending` のステップが承認者不在でない、ルールを使わない経路、期限切れ、完了済み・取消済みは409。
   - 再解決に失敗したら、何も変更せず、理由のコードを返す(409)。
   - 成功時: 申請の行をロックし、未決定ステップを `invalidated`、世代の行を追加、新しい `pending` のステップを作成(期限はその時点から72時間)、`current_approval_id` を更新、`approval.reassigned` と新しいステップの `approval.requested` を記録する。すべて1トランザクション。
5. **状態機械**: 遷移表に `reassign` を加える(`pending` → `invalidated`。申請の状態は変えない)。再割当以外で経路が変わるコード経路を作らない。
6. **画面**:
   - `/ops/approvals` の承認者不在の一覧に、「再割当」の操作を加える(理由の入力、確認、結果の表示)。現在の案内「申請者による内容の変更で対処する」を、再割当の案内に改める。申請者本人が `org_admin` の場合は、操作を出さず理由を示す。
   - 申請の詳細の「承認の経過」に、再割当があったこと(日時、実行者、理由、無効になったステップ、新しい承認者)を表示する。
7. **監査**: `approval.reassigned`(旧・新の世代、無効化したステップ、新しい承認者、実行者、理由)。[[02.17_Audit_Event_Catalog]] の担当WPの記載を本WPへ改める。

## 7. Acceptance Criteria

- [ ] `org_admin` の再割当後、新しい承認者が決定でき、旧世代の未決定ステップでは決定できない。承認済みステップの行は変更されず、`approval.reassigned` が記録される。
- [ ] 再割当後に全段が承認されると `assertApprovalComplete` が成功する。承認済みの段が旧世代、残りが新世代にある場合を含む。
- [ ] 世代の行を欠く・`from_step_no` より前の段が直前の世代と違う・`route_hash` が合わない場合、`assertApprovalComplete` が失敗する。
- [ ] 再割当は、現在のステップが承認者不在のときだけ実行できる。それ以外(承認者が有効、期限切れ、完了済み、取消済み、ルールを使わない経路)は409で、行は変更されない。
- [ ] `org_admin` 以外のすべてのロールで403。申請者本人の `org_admin` で403。他組織の申請IDで404。
- [ ] 再解決に失敗した場合(新しい上長が未設定、申請者本人に解決される、など)、409で理由が返り、ステップ・世代・監査のどれも増えない。
- [ ] 同じ申請への再割当と決定、再割当と再割当を同時に実行しても、世代とステップが二重に作られない。
- [ ] 版のテーブルの行は、再割当の前後で1バイトも変わらない。アプリケーションロールから世代の行の `UPDATE` / `DELETE` が拒否される。他組織の世代の行が読めない(RLS)。
- [ ] 上長の変更だけでは、進行中の申請の経路は変わらない(再割当以外で経路が変わるコード経路が無い)。
- [ ] 画面: 承認者不在の一覧から再割当でき、詳細に再割当の記録が出る。1440px と 375px、Chromium と WebKit で崩れず、axe の serious / critical が0。
- [ ] Migration 0040 の up / down が往復でき、データがある状態の down が拒否される。
- [ ] `check:all`・`typecheck`・`lint` が通り、新規依存が0件である。既存の承認テストに新しい失敗が無い。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態遷移と再割当)、TL-04(Migration)、TL-06(ロール×エンドポイントの総当り、組織境界)、TL-16(IDOR、申請者本人による再割当)

### Evidence

- 再割当の前後の経路・ステップ・監査イベント、条件外の拒否ログ、同時実行のテスト結果、画面のスクリーンショットと axe の結果

`evidence/WP-P4-APR-018/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3 の対象。**Security Reviewer(人間)の sign-off 必須**(認可・RLS・監査を変更する)。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)、T-26(関係の改ざんによる承認者の作出)。残余リスクは RA-04 のまま。
- 生成する監査イベント: `approval.reassigned`、`approval.invalidated`(原因=再割当)、`approval.requested`。

## 10. Rollback / 失敗時の扱い

再割当のAPIと画面を取り除いても、世代の行が無い申請は従来どおり動く。世代の行がある申請は、現在の経路の導出(§6-2)を残したまま完了させる。Migration の down はデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに上がった後のみ)。

正本: AGENTS.md / 本WP / ADR-0024(§1〜§3) / ADR-0023(§2・§6・§7) / 03.5(FR-CAT-013) /
02.17(approval.reassigned) / 02.14 T-08・T-26 / WP-P4-APR-014・015 の成果。

手順:
1. 受入基準をテストへ変換し、先に書く(世代をまたぐ実行前検証、条件外の拒否、権限の総当り、同時実行)。
2. Migration 0040、現在の経路の導出の共有関数、実行前検証、遷移表、再割当API、画面の順に実装する。
3. 現在の経路を読む箇所を、すべて共有関数へ置き換える。置き換え漏れを検索で確かめ、報告する。

やってはいけないこと:
- 版のテーブルの更新、承認済みステップの行の複製・書き換え。
- 承認者のIDを本文で受け取ること。自動での差し替え。
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
