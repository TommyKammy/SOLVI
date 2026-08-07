---
project: SOLVI
doc_id: "WP-P2-SCAN-012"
title: "スキャン結果を書く場所を1つにする"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-07"
updated: "2026-08-07"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "security", "maintainability"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "SCAN"
risk: "medium"
story_points: 2
depends_on: ["WP-P2-SCAN-011", "WP-P1-IDM-012"]
requirement_ids: ["FR-TKT-005", "NFR-SEC-004", "NFR-MNT-001"]
aliases: ["WP-P2-SCAN-012"]
---

# WP-P2-SCAN-012: スキャン結果を書く場所を1つにする

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | SCAN |
| Risk | medium |
| Story Points | 2 |
| 依存 | [[WP-P2-SCAN-011]] / [[WP-P1-IDM-012]] |
| Evidence | `evidence/WP-P2-SCAN-012/20260807-0200/` |

## 1. 出発点

`CollaborationService.recordScanResult` は本番経路から呼ばれていなかった。
検査からだけ呼ばれていた。

書いていたのは worker の `AttachmentScanner.recordResult` である。
**同じ列を、二か所が違う内容で書いていた。**

[[WP-P1-IDM-012]] と同じ形の欠陥である
(呼ばれない関数と同じことをする写し)が、こちらは**方向が逆**だった。
写しのほうが本物になり、元が取り残された。

## 2. 写しは古いまま取り残されていた

| 列 | `recordScanResult`(API側) | `recordResult`(worker) |
|---|---|---|
| `scan_status` | 書く | 書く |
| `scanned_at` | `now()` | 注入された時刻 |
| `scan_signature` | **書かない** | 書く |
| `scan_attempts` | **増やさない** | +1 |
| `scan_last_error` | **消さない** | NULL に消す |

原因ははっきりしている。**`recordScanResult` のほうが古い。**

`scan_signature` / `scan_attempts` / `scan_last_error` は
migration 0012([[WP-P2-SCAN-011]])で追加された。
その時点で worker 側は書くようになったが、**API側の写しは追随していない。**

もしAPI側が使われていたら:

- **感染を検出しても検体名が残らない** — 何に感染したか分からない
- **前回の失敗理由が消えない** — いま健全な添付が「エラーを抱えている」ように
  見え続け、本当に調べるべきものが埋もれる
- 試行回数が増えないため、上限による打ち切りが効かない

## 3. 直し方 — 繋がずに消す

書く場所は worker である。API側の写しは削除した。

**繋ぎ先を作るのではなく、消すのが正しい場合がある。**

この関数は「スキャナ本体の統合は後続WP」という但し書き付きの仮置きだった。
後続WPは来たが、実装先は worker であり、仮置きのほうは片付けられずに残った。

**仮置きは、本物が出来た時点で消さないと写しになる。**
→ [[99.4_Decision_Log|DL-033]]

## 4. 検査の下準備も1つにした

検査は前提を作るために `scan_status` を直接書いてよい。
ただし**書き方は1つにする。**

`tests/support/scan.ts` の `markScanned()` に集めた。
以前は `recordScanResult` 経由が4か所、生SQLが1か所あり、
**後者は `scanned_at` しか埋めていなかった。**

検査ごとに違う列を埋めると、「この状態のとき何が起きるか」を
確かめているつもりで、**検査ごとに違う状態を作る**ことになる。

## 5. 振る舞いの検査を足した

`check_unwired.mjs` セクションF に `scan_status` を加えたうえで、
動かして見る検査を1件足した。

> 一度失敗しても、次に成功すれば前回の失敗は消える

**静的検査では捉えられない。** 列が増えたときに片方だけ取り残される事故は、
「増えた列が正しく扱われているか」を実際に動かして見るしかない。
→ [[04.23_Wiring_Verification]] §9

## 6. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1331 passed (28 files)** |
| `check_unwired.mjs` | OK。セクションF に scan_status 追加 |
| e2e 6本 | すべて OK |
| `check_rls` / `check_architecture` / `check_allowed_paths` | OK |

実経路(ClamAV 実体):1周目 pending + エラー有 → 2周目 clean + エラー消去 + 試行2回。

## 7. 残っている制約

- **API から結果を受け取る口は無い。** 外部スキャナからの callback を
  受ける設計にはしていない。現状 worker が自分で取りに行く
- `markScanned()` は infected のとき既定の検体名を入れる(DB制約を満たすため)
- **セクションF の対象は手で選んでいる。** 網羅ではない

## 8. 関連

- [[WP-P2-SCAN-011]] — スキャナ本体と migration 0012
- [[WP-P1-IDM-012]] — 同じ形の欠陥(写し)とセクションF の追加
- [[04.23_Wiring_Verification]] §9
