---
project: SOLVI
doc_id: "WP-P2-RTM-019"
title: "要求台帳の Status を導出値にする"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-08"
updated: "2026-08-08"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "maintainability", "governance"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "RTM"
risk: "low"
story_points: 3
depends_on: []
requirement_ids: ["NFR-MNT-001"]
aliases: ["WP-P2-RTM-019"]
---

# WP-P2-RTM-019: 要求台帳の Status を導出値にする

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | RTM |
| Risk | low |
| Story Points | 3 |
| Evidence | `evidence/WP-P2-RTM-019/20260808-0030/` |

## 1. 出発点

[[03.18_Requirements_Traceability_Matrix]] の Status 欄は**手で書かれていた**。

その結果、WPを28件完了し検査が1352件通っている時点で、
**93行のうち92行が `Not tested` のまま**だった。
唯一の例外は、前々日に私が手で書き換えた FR-IDM-007 の1行である。

**何が検証済みかを知るための台帳が、それを知る役に立っていなかった。**

手で書いた欄は腐る。書き換える人が居なければ、
台帳は「最後に誰かが気にした日」で止まる。
15回のWP完了を挟んで、誰も気にしなかった。

## 2. 直し方 — 書かずに導出する

`tools/check_traceability.mjs` が3つの事実から Status を導く。

| 事実 | 出どころ |
|---|---|
| どのWPがどの要求を担うか | WPノートの `requirement_ids` |
| そのWPは完了したか | WPノートの `implementation_status` |
| どの検査が要求IDを名指しするか | `tests/` `tools/e2e/` `tools/check_*.mjs` |

導出値と台帳が食い違えば `check:all` が落ちる。
**台帳を直さないと検査が通らないので、腐りようが無くなる。**
→ [[99.4_Decision_Log|DL-039]]

## 3. 導出できることと、できないこと

導出できるのは「**検査が要求IDを名指ししている**」までである。
それは「要求を満たしている」証明ではない。

**言葉を選んだ。** `Verified` とは書かず `検査あり (Nファイル)` とした。
台帳に強い言葉を書くと、読んだ人が確かめずに信じる。
警告として台帳の冒頭にも同じことを書いた。
→ [[99.4_Decision_Log|DL-040]]

## 4. 双方向で突き合わせたら146件ずれていた

| 向き | 件数 | 直し方 |
|---|---|---|
| WPが担うと書くが台帳に無い | 62 | 台帳へ追記 |
| 台帳が担うと書くがWPが書いていない | 84 | WPノートへ追記 |

台帳は計画時に生成され、WPノートの `requirement_ids` は
その後それぞれ独立に育っていた。**片方だけ見ても気付けない**
([[04.23_Wiring_Verification]] §7 と同じ形)。

### 欄そのものが無いWPノートがあった

初期に作られた4件([[WP-P0-GOV-001]] [[WP-P0-REQ-004]]
[[WP-P1-AUD-004]] [[WP-P4-EXEC-004]])には
`requirement_ids` の項目が無かった。
**「欄が無い」と「担う要求が無い」は違う。**

[[WP-P1-AUD-004]] は完了済みであり、これを足したことで
BR-004(監査可能性)などが `未着手` から実態に合った値へ変わった。

## 5. 名指しの無かった要求に名前を付けた — 付けなかったものもある

検査は在るのに要求IDが書かれていないものを4件、実際に確かめて付けた
(FR-TKT-001 / FR-TKT-007 / FR-IDM-002 / FR-IDM-003)。

**付けなかったものもある。** NFR-SEC-002(最小権限+アクセスレビュー)は
RLSと権限の検査はあるがアクセスレビューが未実装であり、
名前を付けると**やっていないことをやったことにする**。
NFR-PERF-001(p95)も負荷試験そのものが無い。

## 6. 結果

| | 以前 | いま |
|---|---:|---:|
| 検査あり | 1(手書き) | **27** |
| 実装済み・名指し無し | — | 8 |
| 検査のみ(WP未完) | — | 1 |
| 未着手 | 92(実質) | 57 |

残る8件は正直な欠落である。

| 要求 | なぜ名指しできないか |
|---|---|
| BR-001 / BR-004 / BR-006 | 業務要求。個々の検査ではなく全体で満たす |
| NFR-SEC-002 | アクセスレビューが未実装 |
| NFR-PERF-001 | 負荷試験が無い |
| NFR-UX-001 | 3クリック以内の検査が無い(GA-4 は人による確認) |
| NFR-UX-003 | 日本語レビューは人が行う |
| NFR-MNT-002 | clean-host 再現は [[08.1_Deployment_Runbook]] で実測したが自動検査は無い |

## 7. 「2回実行してください」を作らない

`requirement_ids` を足すと導出値が変わるため、最初は `--write` を
2回回す必要があった。**口伝を残さない** — 追記が起きたら自分を
もう一度呼ぶようにした(5周で収束しなければ、それ自体を失敗として報告する)。

## 8. 残っている制約

- **「検査あり」は名指しの有無であって品質ではない**(§3)
- 逆向きの不一致を機械的に「WPへ追記」で解決した。
  **台帳側が誤っている可能性は検討していない**
- Test 欄(TL-xx)と Evidence URI は手書きのまま。**次に腐る候補**
- `implementation_status` は手で書く。ここが誤ると Status も誤る

## 9. 関連

- [[03.18_Requirements_Traceability_Matrix]]
- [[04.23_Wiring_Verification]] §7 / §14
- [[09.2_WorkPackage_Template]] — `requirement_ids` は必須項目である
