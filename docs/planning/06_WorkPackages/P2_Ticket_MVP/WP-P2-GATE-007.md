---
project: SOLVI
doc_id: "WP-P2-GATE-007"
title: "Gate A Limited Pilot"
category: "06_WorkPackages"
type: "work-package"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["work-package", "p2", "gate"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "GATE"
risk: "medium"
story_points: 5
depends_on: ["WP-P2-PORTAL-002", "WP-P2-OPS-003", "WP-P2-COLLAB-004", "WP-P2-NTF-005", "WP-P2-SEARCH-006"]
requirement_ids: ["BR-001", "BR-006", "NFR-UX-001"]
aliases: ["WP-P2-GATE-007"]
---

# WP-P2-GATE-007: Gate A 審査(限定パイロット開始の可否)

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | GATE |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Product Owner + Tech Lead |
| Gate | Gate A |

## 1. Purpose

Phase 2 の成果を Gate A の8条件に照らして判定し、
**限定パイロットを始めてよいかを決める**。

ゲートの目的は「通すこと」ではなく「**通してはいけない状態で通さないこと**」である。
条件を緩めて通すなら、そのゲートは最初から不要だった。

## 2. Requirement IDs

`BR-001`, `BR-006`, `NFR-UX-001`

## 3. Dependencies

- [[WP-P2-PORTAL-002]] / [[WP-P2-OPS-003]] / [[WP-P2-COLLAB-004]]
- [[WP-P2-NTF-005]] / [[WP-P2-SEARCH-006]] / [[WP-P2-SLO-008]]

## 4. Scope / Allowed Paths

- `tests/security/`
- `99_Project_Files`
- `11_UI_UX`

## 5. Out of Scope

- 未達条件を埋めるための実装(それぞれのWPの責務)
- パイロットの実施そのもの

## 6. Deliverables

- 縦切りE2Eテスト(GA-1 の判定材料)
- Gate A 審査記録

## 7. 判定結果

> [!warning] **不合格**(2026-07-27)
> 8条件中 5件達成 / 3件未達。条件付き通過も認めない。

| # | 条件 | 判定 |
|---|---|---|
| GA-1 | 縦切りE2E + 内部メモ非漏えい | **達成** |
| GA-2 | 状態遷移と不正遷移の拒否 | **達成** |
| GA-3 | 添付署名URLの越境防止 | **達成** |
| GA-4 | ユーザビリティテスト | **未達** |
| GA-5 | axe violation 0 | **達成** |
| GA-6 | Runbook実手順化と机上演習 | **未達** |
| GA-7 | パイロット計画の文書化 | **未達** |
| GA-8 | 本番相当環境での再計測 | **未達** |

**未達の3件(GA-4 / GA-6 / GA-7 / GA-8 のうち実装で埋まらないもの)は、
いずれも実装不足ではない。** 実利用者・オンコール担当者・パイロット対象の決定・
本番相当環境という、開発側で調達できないものを必要とする。

さらに Gate A の前提である **Gate 1 も未達**(G1-6 CI / G1-8 Restore Drill)。
どちらも利用者の指示で延期されたものであり、再開の判断はプロジェクト側にある。

詳細は `evidence/WP-P2-GATE-007/<timestamp>/gate_a_assessment.md`。

## 8. GA-1 で新たに実装したもの

個々の機能は各WPで確認済みだったが、**繋いだときに繋ぎ目から漏れないこと**は
未検証だった。部品単位のテストは「自分の側は正しい」を示すものであり、
事故は部品の中ではなく部品と部品の間で起きる。

`tests/security/vertical-slice.test.ts` は1つの業務フローを最初から最後まで通し、
**依頼者の目に触れる全ての出口**を検査する。

| 出口 | 検査 |
|---|---|
| 画面(API応答) | 内部メモの文言が現れない。担当者には見える |
| 通知(送信内容) | 内部メモも公開コメント本文も送られない |
| 通知(DB) | `notification` 行にも本文が無い |
| 監査 | 各段階が記録され、内部メモ本文と宛先アドレスは入らない |

**内部メモのイベントは Outbox に積み、通知側が `visibility` を見て弾く。**
積まない実装だと、将来別の経路がイベントを拾ったときに漏れる。
積んでも出ないことを確かめている。

## 9. 条件外だがパイロット前に判断が要る点

Gate A の条件には無いが、記録しておく。

- **担当者向けの操作画面が無い。** APIは実装済みだが画面が無く、
  IT担当は状態遷移・割当を画面から行えない
- **コメント・添付の画面が無い。** 依頼者は起票後に追記できず、
  やり取りは結局メールや電話に戻る

**この状態でパイロットを始めると「使ってみたが結局電話した」となり、
パイロットで測りたかったことが測れない。**

## 10. Definition of Done

- [x] 8条件それぞれを実測値で判定した
- [x] 未達項目の性質(実装で埋まるか / 人と環境が必要か)を切り分けた
- [x] 審査記録を Evidence へ保存した
- [x] Gate定義([[04.22_Gate_Definitions]])へ判定を反映した
- [x] Execution Logへ結果を追記した

## 11. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | `0683975` | 審査完了(判定: 不合格) | `evidence/WP-P2-GATE-007/` | 縦切りE2E 3件追加。全体 1093 tests passed |

### 審査中に確認したこと

`assign()` が担当者を設定するだけで状態を動かさないことを確認した。
これは意図した設計である(担当を替えても状態が勝手に戻らない)。
状態遷移は `transition()` を明示的に呼ぶ。

### 次に必要なもの

| 項目 | 必要なもの | 判断者 |
|---|---|---|
| GA-4 | 初見の利用者5名 | Product Owner |
| GA-6 | オンコール担当者の確定(OQ-013) | Tech Lead |
| GA-6 | 08.1 デプロイRunbookの実体化 | **実装可能** |
| GA-6 | 机上演習の実施 | Tech Lead |
| GA-7 | パイロット対象・期間の決定 | Product Owner |
| GA-8 | 本番相当環境の調達 | Product Owner |
| G1-6 | リモートリポジトリ(DL-005) | Product Owner |
| G1-8 | Restore Drill の実施(DL-004) | Tech Lead |
| 担当者向け画面 | — | **実装可能** |
