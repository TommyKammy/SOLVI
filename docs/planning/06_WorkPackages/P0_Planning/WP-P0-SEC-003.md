---
project: SOLVI
doc_id: "WP-P0-SEC-003"
title: "Threat ModelとSecurity Requirement"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p0"]
source_of_truth: true
implementation_status: "not-started"
---

# WP-P0-SEC-003: Threat ModelとSecurity Requirement

| 項目 | 値 |
|---|---|
| Phase | P0 |
| Workstream | SEC |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Security Reviewer |
| Parallelizable | No(ARCH-002後) |
| Gate | Gate 0 |

## 1. Purpose

[[02.14_Threat_Model]]の脅威T-01〜T-24をレビューし、各脅威に対策要求・検証手段・Gate条件が対応していることを確認して、Phase 1以降のセキュリティ実装の基準を固定する。

## 2. Requirement IDs

`NFR-SEC-001`, `NFR-SEC-010`

## 3. Dependencies

[[WP-P0-ARCH-002]]

## 4. Scope / Allowed Paths

- `02_Architecture/02.14_Threat_Model.md`
- `03_Requirements/03.11_Security_Requirements.md`
- `04_Development/04.22_Gate_Definitions.md`

## 5. Out of Scope

- セキュリティ実装(Phase 1以降)
- ペネトレーションテストの実施(Gate B)

## 6. Deliverables

- レビュー済みThreat Model
- 脅威↔要求↔テスト↔Gateの対応表
- Gate 1/Gate Bチェックリストの確定

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] T-01〜T-24のすべてに、対策要求ID(NFR-SEC系等)または期限付きリスク受容(RA-xx)が対応している
- [ ] 各対策要求が[[03.18_Requirements_Traceability_Matrix]]でWPとTest Layer IDに接続されている
- [ ] Gate 1(G1-1〜G1-9)とGate B(GB-1〜GB-10)の各項目が、対応する脅威IDを持つ
- [ ] リスク受容(RA-01〜03)に再評価時期と承認者が記録されている
- [ ] Security Reviewerの承認記録がある

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- レビューのみ。ただし各脅威に対応するテストレイヤー(TL-06/09/10/11/16/17)の割当を確認する

### Evidence

- Threat Modelレビュー記録
- 脅威-要求-テスト対応表

Evidenceは`evidence/WP-P0-SEC-003/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 本WPの成果物がGate BのSecurity Test設計の入力になる。曖昧な対策記述(「検証する」等)を残さない

## 10. Rollback / 失敗時の扱い

新たな脅威が発見された場合はThreat Modelを更新し、対応要求を追加してからPhase 1を継続する(Phase 1の停止は不要)。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P0-SEC-003)
3. 参照設計: 02.14_Threat_Model、03.11_Security_Requirements、04.22_Gate_Definitions

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
1. 02.14_Threat_ModelのT-01〜T-24について、対策要求IDが実在し、RTMでWP・テストに接続されているかを機械的に検査する。
2. 未接続・対策不十分な脅威を報告する(対策の追加提案も可)。
3. Gate 1/Gate Bのチェックリスト項目と脅威IDの対応表を作成する。
4. OWASP ASVS等の一般的な観点で、T-01〜T-24に漏れている脅威があれば候補として提示する(勝手に追加せず提案する)。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewerの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
