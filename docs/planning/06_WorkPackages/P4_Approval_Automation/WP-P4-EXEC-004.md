---
project: SOLVI
doc_id: "WP-P4-EXEC-004"
title: "Executor契約・署名検証・Policy評価"
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
requirement_ids: ["BR-003", "FR-AUT-001", "FR-AUT-002", "FR-AUT-004", "FR-CAT-008", "NFR-SEC-002", "NFR-SEC-010"]
---

# WP-P4-EXEC-004: Executor契約・署名検証・Policy評価

| 項目 | 値 |
|---|---|
| Phase | P4 |
| Workstream | EXEC |
| Risk | critical |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(WF-003後) |
| Gate | Gate B |

## 1. Purpose

SOLVI Runの入口を作る。[[02.16_Executor_Command_Contract]]§1〜3の契約検証・Allowlist評価・承認再検証を実装し、不正なCommandが1件も通らない状態にする。

## 2. Requirement IDs

`FR-AUT-001`, `FR-AUT-002`, `FR-AUT-004`, `FR-CAT-008`, `NFR-SEC-002`, `NFR-SEC-010`

## 3. Dependencies

[[WP-P4-WF-003]], [[WP-P0-SEC-003]]

## 4. Scope / Allowed Paths

- `services/executor/`
- `packages/shared/src/command/`
- `db/migrations/`
- `tests/security/executor/`

## 5. Out of Scope

- 冪等ストアとReceipt(WP-P4-EXEC-008)
- Dry Run/Retry/Kill Switch(WP-P4-EXEC-009)
- 実際のOkta/Graph呼び出し(WP-P4-OKTA-005/ENTRA-006)
- 任意のHTTP/Shell実行(恒久的にNon-Goal)

## 6. Deliverables

- Command受信エンドポイント(内部ネットワーク限定)
- JWS(Ed25519)署名検証と鍵管理(KMS)
- expires_at・nonce一回性の検証
- Allowlistテーブル(action/resource)と評価器
- Allowlist変更の二重承認フローと監査
- 承認再検証クライアント(Core読取API)
- SoD再検証
- 拒否時の監査イベント(policy_violation)

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] 02.16§1のスキーマ以外のCommandが拒否される(スキーマ違反・未知フィールド)
- [ ] 署名不正・未知kid・expires_at超過(15分)・nonce再利用のそれぞれが拒否される(4ケース独立のテスト)
- [ ] Allowlistに存在しないaction_type/resource_idが拒否され、`policy_violation`監査イベントが生成される
- [ ] Allowlistの変更が管理者2名の承認と監査イベントなしには反映されない
- [ ] 実行直前の承認再検証で、未承認・取消済み・期限切れ・snapshot hash不一致のいずれかなら実行されない
- [ ] SoD検証で、実行対象subjectと承認者が同一の場合に拒否される
- [ ] Executorのプロセスから`solvi/executor/*`以外のSecretパスを読めない(IAM検証)
- [ ] AIサービスからExecutorのエンドポイントへ到達できない(ネットワーク検証)
- [ ] 外部IDがCommandに直接含まれず、Allowlistレコード経由でのみ解決される

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-10(Executor契約のネガティブテスト)
- TL-16(IAM/ネットワーク検証)
- TL-06

### Evidence

- 4種の署名/期限/nonce拒否テスト結果
- Allowlist違反の拒否ログと監査イベント
- IAMポリシー検証の出力
- ネットワーク到達性検証の出力

Evidenceは`evidence/WP-P4-EXEC-004/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate BのGB-1/GB-4/GB-7/GB-8の対象。Security Reviewerのsign-off必須
- 本WPの完了までExecutorは外部APIへ接続しない(接続はOKTA-005以降)
- 拒否は必ずfail closed。判定不能な場合も拒否する

## 10. Rollback / 失敗時の扱い

Executorは独立サービスのため、問題時はサービス停止でCommand受付が止まる(Workflowは待機し、二重実行は起きない)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P4-EXEC-004)
3. 参照設計: 02.16_Executor_Command_Contract §1〜§3・§8、ADR-0006、ADR-0016、02.14_Threat_Model T-09/T-11/T-12

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
1. services/executor に独立サービスを作る。Ingressは内部ネットワークのWorkflow Dispatcherのみ。
2. 02.16§1のCommandスキーマを packages/shared に定義し、Workflow側とExecutor側で共有する。
3. JWS(Ed25519)署名検証を実装する。鍵はKMS管理。kid未知・署名不一致・expires_at超過・nonce再利用を個別に拒否する。
   nonceストアはDBのUNIQUE制約で一回性を保証する。
4. Allowlistテーブル(executor_allowed_action / executor_allowed_resource)を作り、評価器を実装する。
   **Allowlistの変更は管理者2名の承認と監査イベントを必須**にする。ファイル・環境変数での定義は作らない。
5. 実行直前の承認再検証を実装する(Core APIの読取専用エンドポイントを呼ぶ)。
   検証項目: approved / 未失効 / 未取消 / snapshot hash一致 / SoD。
6. 拒否時は`rejected_policy`として監査イベントを生成し、理由を記録する。
7. 外部IDの解決はAllowlistレコード経由のみ。Commandに外部IDを載せない。

このWPでは**外部APIを呼ばない**。検証と拒否までを完成させ、実行はWP-P4-EXEC-008/009/OKTA-005で追加する。
判定に迷うケースはすべて拒否(fail closed)にすること。
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
