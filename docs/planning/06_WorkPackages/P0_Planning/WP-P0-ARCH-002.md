---
project: SOLVI
doc_id: "WP-P0-ARCH-002"
title: "Architecture baselineとADR承認"
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
requirement_ids: ["NFR-MNT-001"]
---

# WP-P0-ARCH-002: Architecture baselineとADR承認

| 項目 | 値 |
|---|---|
| Phase | P0 |
| Workstream | ARCH |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Architect |
| Parallelizable | No(GOV-001後) |
| Gate | Gate 0 |

## 1. Purpose

ADR-0001〜0018の内容をレビューし、アーキテクチャ文書(02系)との矛盾を解消して、実装が参照できる決定集合を確定する。

## 2. Requirement IDs

`NFR-MNT-001`

## 3. Dependencies

[[WP-P0-GOV-001]]

## 4. Scope / Allowed Paths

- `02_Architecture/`
- `07_ADR/`
- `00_Index/00.6_Decision_Register.md`

## 5. Out of Scope

- 脅威モデルの作成(WP-P0-SEC-003)
- 実装コード
- リポジトリ構造の確定(WP-P0-DEV-005)

## 6. Deliverables

- accepted状態のADR 18件
- 02系アーキテクチャ文書とADRの整合レビュー結果
- 禁止依存リスト(Architecture Testの入力)
- Decision Registerの更新

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] ADR-0001〜0018がすべてaccepted、proposedが0件である
- [ ] 各ADRにContext・Decision・得られるもの・受け入れるコスト・却下理由・Security/Operational/Migration Impact・Follow-upが記入されている
- [ ] 02系文書の記述とADRの決定に矛盾がない(矛盾一覧が0件、または解消済み)
- [ ] 禁止依存が具体的なパス/モジュール名で列挙され、WP-P1-CI-006で自動検査可能な形式になっている
- [ ] [[00.6_Decision_Register]]と[[07.0_ADR_Index]]の内容が一致する

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-16の入力となる禁止依存リストのレビュー

### Evidence

- ADRレビュー記録(レビュー者・日付・指摘と対応)
- 矛盾一覧と解消記録

Evidenceは`evidence/WP-P0-ARCH-002/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- ADR-0006(Executor分離)、ADR-0007(AI advisory-only)、ADR-0015(RLS)はSecurity Reviewerの承認必須

## 10. Rollback / 失敗時の扱い

決定が覆る場合は該当ADRをSupersedeする後継ADRを起票し、影響WPを再計画する。既存ADRの内容を書き換えない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P0-ARCH-002)
3. 参照設計: 07_ADR配下全件、02_Architecture配下全件

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
1. ADR 18件と02系文書を突き合わせ、矛盾・重複・未反映の決定を一覧化する。
2. 各ADRのFollow-up項目が担当WPに反映されているかRTMで確認し、未反映を報告する。
3. 禁止依存(モジュール間・サービス間)を具体的なパス指定で列挙し、依存検査ツールの設定案を作成する。
4. 00.6_Decision_RegisterをADR Indexと同期する。
※ ADRの決定内容自体を変更しない。矛盾があれば報告のみ。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Architect + Security ReviewerのReviewを完了した
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
