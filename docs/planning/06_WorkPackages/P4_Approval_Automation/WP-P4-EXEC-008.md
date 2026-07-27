---
project: SOLVI
doc_id: "WP-P4-EXEC-008"
title: "冪等ストアとExecution Receipt"
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
---

# WP-P4-EXEC-008: 冪等ストアとExecution Receipt

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | EXEC |
| Risk | critical |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(EXEC-004後) |
| Gate | Gate B |

## 1. Purpose

[[02.16_Executor_Command_Contract]]§4〜5を実装し、二重配送・並行実行があっても外部変更が正確に1回になる状態と、完全な実行証跡を作る。

## 2. Requirement IDs

`FR-AUT-003`, `FR-AUT-005`

## 3. Dependencies

[[WP-P4-EXEC-004]]

## 4. Scope / Allowed Paths

- `services/executor/src/idempotency/`
- `services/executor/src/receipt/`
- `db/migrations/`
- `tests/security/executor/`

## 5. Out of Scope

- Retry/エラー分類(WP-P4-EXEC-009)
- 外部API呼び出し(WP-P4-OKTA-005)

## 6. Deliverables

- idempotency_key生成の共有ライブラリ(決定的生成)
- execution_receiptテーブル(UNIQUE制約)
- 実行前INSERT(in_progress)による排他
- Receiptスキーマ(02.16§5)の実装
- in_progress滞留の検出と人間判断への回送
- Ticket/Workflowからのreceipt参照

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] idempotency_keyが`sha256(workflow_run_id+step_id+action_type+resource_id+subject_id)`で決定的に生成され、再送で同一値になる
- [ ] 同一keyの**並行**二重配送テストで、外部変更に相当する処理が正確に1回だけ実行される(TL-09)
- [ ] 実行前INSERTのUNIQUE制約違反時に既存Receiptを返し、二重実行しない
- [ ] Receiptが02.16§5の全フィールドを持ち、pre_state/post_state/external_request_idが記録される
- [ ] Receiptがappend-onlyで、UPDATEはstatus/finished_at等の確定時のみ(実行結果の書き換えが不可能)
- [ ] in_progressのまま10分経過したReceiptが検出され、自動再実行されずに人間判断へ回る
- [ ] TicketとWorkflow Runの画面からReceiptを参照できる
- [ ] Receiptにトークン・Secret・PIIが含まれない(external_response_summaryのredaction)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-09(冪等・並行二重配送)
- TL-04
- TL-16(redaction)

### Evidence

- 並行二重配送テストの結果(外部変更が1回であることの証明)
- in_progress滞留検出のログ
- Receiptサンプル(redaction後)

Evidenceは`evidence/WP-P4-EXEC-008/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate BのGB-2/GB-10の対象。Security Reviewerのsign-off必須
- 「結果不明(unknown)」を握りつぶして成功扱いにしない。unknownは必ず人間判断へ
- Receiptは監査証跡の一部であり、削除経路を作らない

## 10. Rollback / 失敗時の扱い

冪等ストアの不整合が疑われる場合はKill Switch(EXEC-009)でCommand受付を停止し、外部状態と突合してから再開する。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P4-EXEC-008)
3. 参照設計: 02.16_Executor_Command_Contract §4〜§5、02.14_Threat_Model T-10

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
1. idempotency_keyの決定的生成を packages/shared に実装する(Workflow側とExecutor側で同一結果になること)。
2. execution_receiptテーブルを作る。idempotency_keyにUNIQUE制約。
3. **実行前にstatus=in_progressでINSERT**し、UNIQUE違反なら既存Receiptを返す方式で排他する。
   (実行後にINSERTする方式にしないこと。並行実行で二重実行になる)
4. 02.16§5のReceiptスキーマを実装する。pre_state/post_stateは外部状態の読取結果を保存する。
5. in_progressのまま10分経過したReceiptを検出するジョブを作る。**自動再実行はしない**。Runbook 08.6へ回す。
6. Ticket/Workflow画面からReceiptを参照できるAPIを追加する。
7. external_response_summaryのredactionを実装する。

テストの要点: 同一keyのCommandを並行に複数投げ、外部変更に相当する処理(このWPではモック)が1回だけ呼ばれることを検証する。
逐次の再送だけでなく**並行**でテストすること。
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
