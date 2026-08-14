---
project: SOLVI
doc_id: "WP-P0-GOV-001"
title: "製品ScopeとSuccess Metric承認"
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
story_points: 3
risk: "low"
workstream: "GOV"
phase: "P0"
requirement_ids: ["BR-001", "BR-002", "BR-006"]
---

# WP-P0-GOV-001: 製品ScopeとSuccess Metric承認

| 項目 | 値 |
|---|---|
| Phase | P0 |
| Workstream | GOV |
| Risk | low |
| Story Points | 3 |
| Suggested Owner | Product Owner |
| Parallelizable | Yes(P0の起点) |
| Gate | Gate 0 |

## 1. Purpose

SOLVIのMVP範囲・非対象・成功指標をステークホルダー合意まで持っていき、以降の全WPが参照する判断基準を固定する。Freshservice現状値のベースライン取得を開始する。

## 2. Requirement IDs

`BR-001`, `BR-002`, `BR-006`

## 3. Dependencies

なし(Phase先頭)

## 4. Scope / Allowed Paths

- `01_Product/`
- `00_Index/00.8_Status_Dashboard.md`
- `99_Project_Files/99.1_Project_Charter.md`

## 5. Out of Scope

- アーキテクチャ決定(WP-P0-ARCH-002)
- 要求の詳細化(WP-P0-REQ-004)
- 実装コード全般

## 6. Deliverables

- 合意済みのScope/Non-Goals([[01.5_Scope_and_Non_Goals]])
- 目標値入りSuccess Metrics([[01.8_Success_Metrics]])
- Freshservice現状値のベースライン(件数/月・初回応答・解決時間・CSAT・ライセンス費用)
- Gate 0 Decision Recordのドラフト

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] [[01.5_Scope_and_Non_Goals]]のMVP対象と非対象が、Phase 0〜9のどのPhaseで扱うかまで明記されている
- [ ] [[01.8_Success_Metrics]]の全指標に目標値・計測方法・計測担当が記入されている
- [ ] Freshserviceのベースライン値が実データで記入され、出典と取得日が記録されている
- [ ] ステークホルダー(IT部門責任者・Product Owner)の合意記録が[[99.4_Decision_Log]]にある
- [ ] 非対象と決めた機能が[[01.5_Scope_and_Non_Goals]]と各要求ノートで矛盾しない

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- 該当なし(文書WP)。ただしScope⇔要求⇔WPの整合をレビューで確認する

### Evidence

- 合意会議の記録(日付・参加者・決定事項)
- ベースライン取得のスクリーンショットまたはエクスポート(機微情報を除く)

Evidenceは`evidence/WP-P0-GOV-001/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Freshserviceからのエクスポートに個人情報を含めない(集計値のみ)

## 10. Rollback / 失敗時の扱い

文書WPのため技術的ロールバックは不要。合意が得られない場合はScopeを縮小して再提案し、Gate 0を延期する。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P0-GOV-001)
3. 参照設計: 01_Product配下、04.22_Gate_Definitions

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
1. 01_Product配下の各ノートを読み、Scope/Non-Goalsの矛盾点を一覧化する。
2. 01.8_Success_Metricsの各指標について、目標値が計測可能な形式(数値+単位+条件)になっているか検証し、不足を指摘する。
3. Freshserviceベースライン取得に必要な項目リストと取得手順案を作成する。
4. Gate 0 Decision Recordのドラフトを04.22_Gate_Definitionsのチェックリスト形式で作成する。
※ 合意形成そのものは人間が行う。あなたは資料の準備と矛盾検出まで。
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
