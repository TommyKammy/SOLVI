---
project: SOLVI
doc_id: "WP-P2-REL-009"
title: "Ticket関連付けとMerge"
category: "06_WorkPackages"
type: "workpackage"
status: "draft"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2"]
source_of_truth: false
implementation_status: "not-started"
---

# WP-P2-REL-009: Ticket関連付けとMerge

> [!warning] この文書は骨子のみ(status: draft)
> 実装根拠に使用できません(AGENTS.md §0)。**着手2週間前**までに実体化します。
> [[WP-P2-OPS-003]] からの分割で新設されたWPです(2026-07-27)。

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | REL |
| Risk | medium |
| Story Points | 5 |
| Gate | Gate A |

## 分割の経緯

[[WP-P2-OPS-003]] が13ポイントで単一PRに収まらなかったため、
関連付けとMergeを分離した。一覧・割当(OPS-003)とは扱うデータも
リスクの性質も異なるため、分けたほうが検証も明確になる。

## 想定スコープ

- Related Ticket(相互参照)
- Parent / Child(**1階層のみ**。多階層は[[01.5_Scope_and_Non_Goals]]で対象外)
- Merge / 重複統合(FR-TKT-011)

## 実体化時に決める必要があること

- Merge時のコメント・添付の扱い(統合先へ移すか、参照で残すか)
- Merge元チケットの依頼者への通知内容
- 循環参照の検出方法(Parent/Child、Related の両方)
- Parent解決時にChildが未解決の場合の扱い(警告か拒否か)

## 要求

`FR-TKT-010`, `FR-TKT-011`

## Dependencies

[[WP-P2-OPS-003]]
