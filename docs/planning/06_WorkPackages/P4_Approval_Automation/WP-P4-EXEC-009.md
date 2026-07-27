---
project: SOLVI
doc_id: "WP-P4-EXEC-009"
title: "Dry Run・Retry・エラー分類・Kill Switch"
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

# WP-P4-EXEC-009: Dry Run・Retry・エラー分類・Kill Switch

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | EXEC |
| Risk | critical |
| Story Points | 5 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | Yes(EXEC-004後、EXEC-008と並行可) |
| Gate | Gate B |

## 1. Purpose

[[02.16_Executor_Command_Contract]]§6〜8を実装し、外部障害への耐性と緊急停止手段を備える。

## 2. Requirement IDs

`FR-AUT-006`, `FR-AUT-007`

## 3. Dependencies

[[WP-P4-EXEC-004]]

## 4. Scope / Allowed Paths

- `services/executor/src/policy/`
- `services/executor/src/retry/`
- `services/api/src/modules/admin/killswitch/`
- `tests/security/executor/`

## 5. Out of Scope

- 自動Compensation(02.16§6により恒久的に不採用。補償は新規承認済みWorkflowとしてのみ)

## 6. Deliverables

- Dry Runモード(検証は本番同一、書込みのみスキップ)
- エラー分類(02.16§6の5分類)
- 指数バックオフRetry(同一idempotency key)
- Rate Limit対応(Retry-After尊重)
- Executor Kill Switch(DB+環境の二重)と監査
- 補償Commandの定義(自動実行はしない)

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] Dry Runが§3の全検証と事前条件取得まで実行し、外部書込みのみをスキップする
- [ ] Dry Runと本番実行のPolicy評価が同一コードパスであることがテストで証明される(分岐は最終書込み呼出しのみ)
- [ ] エラーが5分類(rejected_policy/rejected_precondition/failed_retryable/failed_permanent/unknown)に正しく分類される
- [ ] failed_retryableのみRetryされ、最大5回・指数バックオフ・同一idempotency keyで実行される
- [ ] 429応答時にRetry-Afterヘッダが尊重される
- [ ] unknownが自動Retryされない(人間判断へ回る)
- [ ] Kill Switch有効時に全Commandが拒否され、解除まで新規実行が0件である
- [ ] Kill Switchの発動・解除が監査イベントとして記録される
- [ ] Kill SwitchがDB障害時でも環境変数側で有効化できる(二重化の検証)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-20(障害注入: タイムアウト・429・5xx・接続断)
- TL-10(Dry Runの同一性)
- TL-16

### Evidence

- 障害注入テストの結果(分類別の挙動)
- Kill Switch発動・復帰の演習記録
- Dry Run/本番のコードパス同一性の証明

Evidenceは`evidence/WP-P4-EXEC-009/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate BのGB-5の対象。Security Reviewerのsign-off必須
- 自動Compensationを実装しない(承認なき逆操作を作らない)
- Kill Switchの操作権限はplatform_adminに限定し、操作を監査する

## 10. Rollback / 失敗時の扱い

Kill Switch自体がこのWPのロールバック手段。Kill Switchが動作しない状態でGate Bを通過させない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P4-EXEC-009)
3. 参照設計: 02.16_Executor_Command_Contract §6〜§8

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
1. Dry Runを実装する。**Policy評価と事前条件取得は本番と完全に同一のコードパス**を通し、最終的な外部書込み呼出しのみを分岐でスキップする。
   (別実装のDry Runを作らないこと。乖離が生じる)
2. 02.16§6のエラー分類を実装する。外部APIの応答・例外を5分類へマップする表をコードに持つ。
3. failed_retryableのみRetryする。指数バックオフ、最大5回、同一idempotency key。429はRetry-Afterを尊重。
4. unknownは自動Retryせず、Runbook 08.6の人間判断へ回す。
5. Executor Kill Switchを実装する。DBフラグ+環境変数の二重化(DB障害時も止められること)。
   発動・解除は監査イベント必須。platform_adminのみ操作可能。
6. 補償Commandの定義(add⇄remove)は行うが、**自動実行はしない**。新規の承認済みWorkflowとしてのみ実行される設計にする。

障害注入テスト(TL-20)を実装し、タイムアウト・429・5xx・接続断のそれぞれで期待どおりの分類と挙動になることを検証すること。
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
