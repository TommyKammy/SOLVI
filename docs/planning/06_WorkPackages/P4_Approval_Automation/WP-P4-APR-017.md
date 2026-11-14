---
project: SOLVI
doc_id: "WP-P4-APR-017"
title: "代理承認・高リスク二重承認とSoD・並列/定足数/グループ承認・リマインドとエスカレーション"
category: "06_WorkPackages"
type: "workpackage"
status: "superseded"
version: "0.2.0"
created: "2026-11-12"
updated: "2026-11-14"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4", "approval", "sod", "delegation"]
source_of_truth: true
implementation_status: "not-started"
story_points: 13
risk: "critical"
workstream: "APR"
phase: "P4"
requirement_ids: []
depends_on: ["WP-P4-APR-015"]
---

# WP-P4-APR-017: 代理承認・高リスク二重承認とSoD・並列/定足数/グループ承認・リマインドとエスカレーション

> [!warning] このWPは `superseded` である(2026-11-14)。Issue化・実装の根拠にしない。
> 「着手前に分割を検討する」としていた本WPを、次の後継WPへ分けて置き換えた(2026-11-14 利用者の決定)。要求IDの担当は各後継WPの `requirement_ids` と[[03.18_Requirements_Traceability_Matrix]]が正本であり、本WPのfrontmatterの `requirement_ids` は空にしてある。以下の本文(§1〜§13)は履歴として変更していない。
>
> | 後継WP | 内容 | 本WPの項目との対応 |
> |---|---|---|
> | [[WP-P4-APR-018]] | 承認者不在の申請の再割当(経路の世代の保存・API・画面) | §6 冒頭の「再割当」 |
> | [[WP-P4-APR-019]] | 承認期限前の通知・期限切れの記録・承認者不在時のエスカレーション | §6-4 |
> | [[WP-P4-APR-020]] | 代理承認 | §6-1 |
> | [[WP-P4-APR-021]] | 高リスク申請の二重承認とSoD | §6-2 |
>
> §6-3(並列・定足数・グループ承認)は後継WPを置かない。これを求める要求IDが無いため、必要になった時点で要求と後継ADRから起こす。設計上の決定は[[ADR-0024_Approval_Route_Generations_And_High_Risk_Criterion]]。本WPに依存していた[[WP-P4-GATE-007]]・[[WP-P7-APR-002]]の依存は後継WPへ付け替えた。

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | critical |
| Story Points | 13 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(APR-015の後。WP-P4-WF-003 / WP-P4-EXEC-004の前に必要な範囲を確定する) |
| Gate | Gate B(GB-3) |

## 1. Purpose

[[WP-P4-APR-002]](`superseded`)が担っていた項目のうち、初期の承認ルーティング([[WP-P4-APR-010]]〜[[WP-P4-APR-016]])に含めなかった残りを引き受ける: 代理承認(FR-CAT-006)、高リスク申請の二重承認とSoD(FR-CAT-010。高リスクの判定基準の確定を含む)、並列・定足数・グループ承認、承認リマインドとエスカレーション(FR-CAT-011の残り)。Executor側の承認再検証との結合は[[WP-P4-EXEC-004]]と調整する。**13ポイントのため着手前に分割を検討する**(同一WP IDで複数PRに分ける場合は §11 の順序)。

## 2. Requirement IDs

`FR-CAT-006`, `FR-CAT-010`, `FR-CAT-011`

## 3. Dependencies

[[WP-P4-APR-015]]。実体化(`draft` → `baseline`)は、ADR-0023 §4(高リスクは固定承認者必須)の判定基準の確定と、並列・定足数・グループ承認の設計が[[ADR-0023_Relationship_Based_Approval_Authority]]の範囲を超える場合の後継ADRの要否判断(`要確認`)を経て行う。

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/catalog/`
- `services/api/src/common/audit/audit.ts`
- `apps/web/src/app/requests/[id]/page.tsx`
- `apps/web/src/app/ops/approvals/`
- `tests/unit/approval-delegation.test.ts`
- `tests/security/approval-delegation.test.ts`
- `tests/security/approval-dual-control.test.ts`
- `docs/planning/06_WorkPackages/P4_Approval_Automation/WP-P4-APR-017.md`
- `evidence/WP-P4-APR-017/`

## 5. Out of Scope

- 汎用ローコードWorkflowデザイナー(恒久的Non-Goal)、金額ベースの動的承認ルート、Change承認のCAB機能([[WP-P7-APR-002]])。
- Executor側の承認再検証の実装([[WP-P4-EXEC-004]])と、`approval_ref` の多段での意味の決定(02.16の改訂とADRが必要)。
- 営業日カレンダー(エスカレーションの時間基準は暫定の暦時間)。

## 6. Deliverables

- **再割当**([[WP-P4-APR-015]] §6.2 から移管、2026-11-14): 承認者不在の申請について、組織管理者が残りのステップだけを再解決する。版の経路を更新できない(アプリロールは版のテーブルに SELECT / INSERT のみ)ため、Migration と設計判断(版の経路の列だけ更新を許す案、または経路の世代を追記専用の別テーブルに持つ案)が必要。承認済みステップの行を複製・書き換えしないこと。実体化の際に、本項を独立したWPへ分けるかを判断する。
1. 代理承認(`approval_delegation`: 組織・原承認者・代理者・期間・範囲・作成者。期間限定、RLS付き)。決定時に委任の有効性を検証し、`decided_by`(代理者)と `approver_id`(原承認者)の両方を監査に残す。代理経由でも自己承認・重複・SoDを拒否する。
2. 高リスク二重承認とSoD評価器: Critical Action(Allowlist変更、Critical Command)の承認で独立した2名を要求し、申請者・1人目承認者と同一人物による2人目の承認を拒否する。**高リスクかどうかの判定基準(カタログ定義の属性か、Executor側の分類か)をここで確定する**(`要確認`)。関係ベース承認だけの経路を高リスクとして成立させない([[ADR-0023_Relationship_Based_Approval_Authority]] §4)。
3. 並列ステップ・定足数・グループ承認(`steps` の拡張。直列のみの初期仕様を超えるため、データモデルとADRの要否を実体化時に確定する)。
4. 承認リマインド(期限前の通知。通知は既存の[[WP-P2-NTF-005]]の経路を使う)と、承認者不在時のエスカレーション先定義(FR-CAT-011)。エスカレーションは経路の暗黙の差し替えにせず、再割当と同じ監査可能な遷移で行う。
5. 監査イベント: `approval.delegated` ほか、02.17のカタログにある `approval.*`。

## 7. Acceptance Criteria

- [ ] 代理期間外・代理範囲外の承認が拒否される。有効な代理での承認が、原承認者と代理者の双方を含む監査イベントとして記録される。
- [ ] 申請者本人が代理者として自分の申請を承認する経路(UI/API/代理経由)が全て拒否される。
- [ ] Critical Actionの承認で、申請者・1人目承認者と同一人物による2人目の承認が全経路で拒否される。独立した2名の承認が揃うまで実行できない(`assertApprovalComplete` が失敗する)。
- [ ] 関係ベース(上長・部署長)のステップだけで構成された高リスク申請が、ルール保存時と申請時の双方で拒否される。
- [ ] 定足数・並列ステップで、必要数に満たない承認では実行できず、同一人物の重複票が数えられない(確定した設計に対応するテスト)。
- [ ] 承認期限(既定72時間、営業日カレンダー導入まで暫定)超過で `expired` になり、期限切れの承認での実行が拒否される。期限前のリマインドが1回だけ送られ、再送で重複しない。
- [ ] エスカレーション先が未定義のとき承認者不在の申請が滞留として残り、自動で別の人に承認権限が移らない。定義された場合も、移行が監査イベントに記録される。
- [ ] `check:all`・型・lintが通り、新規依存が0件である(追加が必要なら事前に承認を得る)。

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態機械)、TL-06(承認者スコープ・代理範囲)、TL-10(Executor側での承認再検証との結合は[[WP-P4-EXEC-004]]と調整)、TL-16

### Evidence

- 代理・二重承認・SoD違反の拒否ログ(全経路分)、期限切れ・エスカレーションのテスト結果

`evidence/WP-P4-APR-017/<YYYYMMDD-HHMM>/` へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate B GB-3の対象。**Security Reviewer(人間)のsign-off必須**。承認レコードは改変不能(状態遷移としてのみ変更)。承認者決定はIdP属性でなくSOLVI内のRoleBinding/組織データを正とする(T-07)。
- 脅威 [[02.14_Threat_Model]] T-08(自己承認・偽装承認)、T-26(関係の改ざんによる承認者の作出)。
- 生成する監査イベント: `approval.delegated|expired` ほか(02.17)。

## 10. Rollback / 失敗時の扱い

承認ロジックの不具合は特権実行の安全性に直結する。機能は組織単位のDB設定で停止でき、停止時は直列の固定・関係ベースの承認(WP-P4-APR-015の範囲)へ戻る。新テーブルのdownはデータがあれば拒否する(前進修復)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください(baselineに実体化された後のみ)。

正本: AGENTS.md / 本WP / ADR-0023(§4・§6) / 03.5(FR-CAT-006/010/011) / 02.16_Executor_Command_Contract §3 /
02.14 T-08・T-26 / WP-P4-APR-015 の成果。

このWPは13ポイントで単一PRには大きい。次の順でPRを分けてよい(WP IDは同一):
(a) 代理承認 (b) 高リスク二重承認とSoD (c) 並列/定足数/グループ承認 (d) リマインドとエスカレーション

手順:
1. 高リスクの判定基準と、並列等のデータモデルの要否(ADR)を確認する。未確定なら実装せず報告する。
2. 各PRで受入基準をテストへ変換してから実装する。代理経由の自己承認・重複を必ず塞ぐ。
3. 全遷移で監査イベントを生成し、assertApprovalComplete を新しいステップ構造へ拡張する(フラグ非依存)。

やってはいけないこと:
- 代理・エスカレーションによる経路の暗黙の差し替え。同一人物の複数票。
- Executorとの接続(WP-P4-EXEC-004)。汎用Workflowデザイナー。
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
