---
project: SOLVI
doc_id: "WP-P1-BCK-007"
title: "Backup/Restore基盤とDrill"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "not-started"
---

# WP-P1-BCK-007: Backup/Restore基盤とDrill

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | BCK |
| Risk | high |
| Story Points | 5 |
| Suggested Owner | Tech Lead + Ops |
| Parallelizable | Yes(DATA-002後) |
| Gate | Gate 1 |

## 1. Purpose

バックアップの取得ではなく**復旧できること**を早期に証明する。Phase 1で実演し、以降四半期ごとに繰り返す。

## 2. Requirement IDs

`NFR-OPS-002`, `NFR-SEC-009`

## 3. Dependencies

[[WP-P1-DATA-002]]

## 4. Scope / Allowed Paths

- `infra/backup/`
- `tools/restore/`
- `08_Runbooks/08.2_Backup_and_Restore_Runbook.md`

## 5. Out of Scope

- 本番DR構成(Phase 9のGame Day)
- マルチリージョン冗長化

## 6. Deliverables

- DBバックアップ(PITR)とObject Storageバージョニングの設定
- リストア手順([[08.2_Backup_and_Restore_Runbook]])
- リストア実演の記録(RPO/RTO実測)
- バックアップの暗号化とアクセス制御

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] DBのバックアップが自動取得され、PITRが有効である
- [ ] **リストア実演を1回完了**し、所要時間(RTO)とデータ欠損(RPO)の実測値が目標(RTO≤4h/RPO≤24h)以内である
- [ ] リストア手順が第三者(実施者以外)の手で再現できる粒度で文書化されている
- [ ] リストア後にRLS・接続ロール・監査アンカーが正しく機能することを確認した
- [ ] バックアップが暗号化され、権限のないロールからアクセスできない(拒否テスト)
- [ ] Object Storageのバージョニングで誤削除からの復元ができる

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-14(Backup/Restore Drill)
- TL-16(バックアップへのアクセス拒否)

### Evidence

- リストア実演の記録(開始/完了時刻、RPO/RTO実測、確認項目のチェック結果)

Evidenceは`evidence/WP-P1-BCK-007/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate 1のG1-8の対象
- バックアップからの復元データに本番PIIを含む場合の取扱手順を明記する(NFR-SEC-009)
- リストア演習用の環境は本番と分離する

## 10. Rollback / 失敗時の扱い

リストア演習で問題が見つかった場合はGate 1を保留し、原因解消後に再演習する。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-BCK-007)
3. 参照設計: ADR-0003, ADR-0010, ADR-0018、02.15_Backup_DR_and_Continuity

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
1. PostgreSQLのバックアップ(PITR)とObject Storageのバージョニングを設定する(ローカル/開発環境で実装、本番設定はIaCとして記述)。
2. 08.2_Backup_and_Restore_Runbookを、前提・判断基準・具体コマンド・検証・ロールバック・証跡を含む実手順として書く。
3. **実際にリストアを実演**し、RPO/RTOを実測して記録する。
4. リストア後の確認項目(RLS有効性、接続ロール権限、監査アンカー、添付の参照可否)をチェックリスト化して検証する。
5. バックアップへのアクセス制御を検証する(権限のないロールからの取得が失敗すること)。

「バックアップが取れている」ではなく「復元できた」ことをEvidenceにすること。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Ops担当とTech Leadの双方が確認した
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
