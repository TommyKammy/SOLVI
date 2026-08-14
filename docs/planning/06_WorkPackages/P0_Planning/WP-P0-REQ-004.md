---
project: SOLVI
doc_id: "WP-P0-REQ-004"
title: "Requirement baselineとRTM"
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
story_points: 5
risk: "medium"
workstream: "REQ"
phase: "P0"
requirement_ids: ["BR-001", "BR-002", "BR-006"]
---

# WP-P0-REQ-004: Requirement baselineとRTM

| 項目 | 値 |
|---|---|
| Phase | P0 |
| Workstream | REQ |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Product Owner |
| Parallelizable | No(SEC-003後) |
| Gate | Gate 0 |

## 1. Purpose

要求101件のレジストリ・カテゴリ別詳細・RTMの3点整合を確立し、全要求がWP/ADR/Testへ追跡可能な状態を確定する。

## 2. Requirement IDs

`BR-001`, `BR-002`, `BR-006`

## 3. Dependencies

[[WP-P0-GOV-001]], [[WP-P0-ARCH-002]], [[WP-P0-SEC-003]]

## 4. Scope / Allowed Paths

- `03_Requirements/`

## 5. Out of Scope

- Phase 2以降の要求の詳細化(該当Phase前に実施)
- テストケースの作成

## 6. Deliverables

- 整合した[[03.1_Requirements_Baseline]]・カテゴリ別ノート・[[03.18_Requirements_Traceability_Matrix]]
- 3点整合を検査するスクリプト
- 孤立要求/孤立WPの検査結果

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] 要求IDが一意で、レジストリ・カテゴリ別ノート・RTMの3箇所で件数と内容が一致する
- [ ] 全Must要求の受入基準が数値または二値判定可能である(名詞止めの受入基準が0件)
- [ ] WPに紐づかない要求が0件、要求に紐づかないWPが0件(検査スクリプトの出力で証明)
- [ ] 全要求にGate列が入っており、対応するGate定義に該当条件が存在する
- [ ] 検査スクリプトがCIで実行可能な形で`tools/`配下に存在する

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- 整合検査スクリプトの実行(要求⇔WP⇔ADR⇔Gate)

### Evidence

- 検査スクリプトの実行ログ(孤立0件の出力)

Evidenceは`evidence/WP-P0-REQ-004/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- セキュリティ要求(NFR-SEC-001〜010)の削除・優先度降格にはSecurity Reviewerの承認が必要

## 10. Rollback / 失敗時の扱い

要求の追加・変更で整合が崩れた場合は、検査スクリプトがCIで失敗するため取り込まれない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P0-REQ-004)
3. 参照設計: 03_Requirements配下全件、06.0_WorkPackage_Register

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
1. 03.1_Requirements_Baseline / カテゴリ別ノート / 03.18_RTM の3点整合を検査するスクリプトを`tools/check_requirements.py`として作成する。
   検査項目: ID一意性、3点の件数一致、孤立要求、孤立WP、未知WP参照、未知ADR参照、Gate定義との相互参照、受入基準の名詞止め検出。
2. スクリプトを実行し、検出された不整合を修正する(要求の意味は変えない。判断が要る場合は報告)。
3. CI(GitHub Actions)から実行する設定案を提示する。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Product Ownerの承認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
