---
project: SOLVI
doc_id: "WP-P4-APR-002"
title: "承認統制(多段・代理・SoD・再承認)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p4"]
source_of_truth: true
implementation_status: "not-started"
story_points: 13
risk: "high"
workstream: "APR"
phase: "P4"
requirement_ids: ["FR-CAT-004", "FR-CAT-005", "FR-CAT-006", "FR-CAT-007", "FR-CAT-008", "FR-CAT-009", "FR-CAT-010", "FR-CAT-011"]
---

# WP-P4-APR-002: 承認統制(多段・代理・SoD・再承認)

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | APR |
| Risk | high |
| Story Points | 13 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(CAT-001後) |
| Gate | Gate B |

## 1. Purpose

承認をExecutor実行の信頼できるゲートにする。多段・並列・代理・期限に加え、自己承認禁止・SoD・申請変更時の再承認・承認取消を実装する。

## 2. Requirement IDs

`FR-CAT-004`, `FR-CAT-005`, `FR-CAT-006`, `FR-CAT-007`, `FR-CAT-008`, `FR-CAT-009`, `FR-CAT-010`, `FR-CAT-011`

## 3. Dependencies

[[WP-P4-CAT-001]]

## 4. Scope / Allowed Paths

- `services/api/src/modules/approval/`
- `db/migrations/`
- `apps/web/src/app/approvals/`
- `tests/security/approval/`

## 5. Out of Scope

- 汎用ローコードWorkflowデザイナー(Non-Goal)
- 金額ベースの動的承認ルート
- Change承認のCAB機能(WP-P7-APR-002)

## 6. Deliverables

- 承認集約と状態機械([[03.5_Catalog_and_Approval_Requirements]]§承認状態機械)
- 承認者決定ロジック(上司/グループ/多段/並列)
- 代理承認(期間限定)
- SoDと自己承認防止の評価器
- 申請変更検知(snapshot hash)と承認無効化
- 承認取消とWorkflow停止連携
- 承認監査イベント

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] 承認状態機械の全遷移がテーブル定義され、未定義遷移がAPIで拒否される(TL-02で表と1:1)
- [ ] 申請者と同一人物が承認者に割り当てられない。割当後に同一人物になった場合も承認時に拒否される(UI/API/代理経由の全経路)
- [ ] Critical Actionの承認で、申請者・1人目承認者と同一人物による2人目の承認が拒否される(FR-CAT-010)
- [ ] 承認後に申請内容を変更すると既存承認が`Invalidated`になり、再承認が要求される。snapshot hashが変化する
- [ ] 承認取消により進行中Workflowが安全停止し、以降のCommand発行が0件になる
- [ ] 代理承認が代理期間外・代理範囲外で拒否される。原承認者と代理者の双方が監査に残る
- [ ] 承認期限(既定3営業日)超過で`Expired`になり、期限切れ承認での実行が拒否される
- [ ] `approval.requested/approved/rejected/cancelled/delegated/expired/invalidated`の監査イベントが生成される

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-02(状態機械)
- TL-06(承認者スコープ・代理範囲)
- TL-10(Executor側での承認再検証との結合)
- TL-16

### Evidence

- 状態機械テストの網羅結果
- 自己承認・SoD違反の拒否ログ(全経路分)
- snapshot hash不一致時の挙動記録

Evidenceは`evidence/WP-P4-APR-002/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate BのGB-3の対象。Security Reviewerのsign-off必須
- 承認レコードは改変不能(状態遷移としてのみ変更)。承認の削除経路を作らない
- 承認者決定はIdP属性でなくSOLVI内のRoleBinding/組織データを正とする(T-07対策)

## 10. Rollback / 失敗時の扱い

承認ロジックの不具合は特権実行の安全性に直結する。feature flagで自動化を停止し、手動運用へ戻せる状態を保つ。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P4-APR-002)
3. 参照設計: 03.5_Catalog_and_Approval_Requirements(承認状態機械含む)、02.16_Executor_Command_Contract§3、02.14_Threat_Model T-08

制約:
- §4 Allowed Paths以外のファイルを変更しない。必要が生じたらPRを分けるか、WP追加を提案する。
- §5 Out of Scopeの内容を先取り実装しない。
- ADRの決定(特にAI advisory-only、Executor分離、RLS必須)を変更しない。変更が必要なら実装を止めて後継ADRを提案する。
- 依存WPが未完了なら実装せず、不足を報告する。
- 新規依存パッケージの追加は事前に理由と代替案を提示して承認を得る。
- Secret・実データ・PIIをコード、テスト、ログ、コミットに含めない。

完了時に報告すること:
- 変更ファイル一覧 / Migrationの有無と内容 / 実行した検証コマンドと結果
- §7 Acceptance Criteria の各項目に対する充足状況(証拠付き)
- セキュリティ影響 / 未解決事項 / Evidenceの保存先

作業内容:
1. 承認集約と状態機械を実装する。遷移は明示的なテーブル/マップで定義し、文字列の直接更新をしない。
2. 承認者決定(上司承認・グループ承認・多段・並列)を実装する。決定の根拠(どのルールで誰になったか)を記録する。
3. **自己承認防止とSoD**: 申請者・各承認者の同一性チェックを、割当時と承認実行時の両方で行う。
   代理承認経由で同一人物に到達するケースも塞ぐこと。
4. **申請変更時の再承認**: 申請内容のsnapshot hashを承認時に固定し、変更検知で承認をInvalidatedにする。
   このhashはExecutorが実行直前に再検証する(02.16§3-3)ため、算出方法を共有ライブラリに置く。
5. 承認取消とWorkflow安全停止の連携を実装する。
6. 承認期限と期限切れ処理、承認者不在時のエスカレーションを実装する。
7. 全遷移で監査イベントを生成する。

このWPは13ポイントで単一PRには大きい。次の順でPRを分けてよい(WP IDは同一):
(a) 承認集約+状態機械+監査 (b) 承認者決定+多段/並列 (c) SoD・自己承認・再承認・取消 (d) 承認UI
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewerのsign-offを得た(必須)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
