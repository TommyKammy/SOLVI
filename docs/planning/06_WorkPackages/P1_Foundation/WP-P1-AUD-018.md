---
project: SOLVI
doc_id: "WP-P1-AUD-018"
title: "監査の書き出しとアンカー照合"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-08"
updated: "2026-08-08"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "audit", "security"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "AUD"
risk: "high"
story_points: 8
depends_on: ["WP-P1-AUD-004"]
requirement_ids: ["AUD-002", "AUD-003"]
aliases: ["WP-P1-AUD-018"]
---

# WP-P1-AUD-018: 監査の書き出しとアンカー照合

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | AUD |
| Risk | high |
| Story Points | 8 |
| 依存 | [[WP-P1-AUD-004]] |
| Evidence | `evidence/WP-P1-AUD-018/20260808-0730/` |

## 1. 出発点

[[WP-P1-AUD-004]] で追記専用・ハッシュ連鎖の監査を作り、日次アンカーで固定した。
**取り出す手段が無かった。**

`audit.export.executed` は監査イベント型として定義されていたが、
発行する者が居ない。`check_unwired` が**最後まで報告し続けていた1件**である。

**読めない記録は、記録していないことに近い。**
→ [[99.4_Decision_Log|DL-051]]

## 2. 連鎖は組織をまたいで1本である

`computeDailyRoot` はその日の**全イベント**を `event_id` 順に連ねる。
組織で絞った書き出しからは日次ルートを再計算できない。

| 書き出し | アンカー照合 |
|---|---|
| `platform_auditor` の全体書き出し(前日以前) | **できる** |
| `auditor` の自組織書き出し | **できない** |
| 当日の書き出し | **できない**(§4) |

**できないことを、できるふりで隠さない。**
manifest に `anchorVerifiable` を持たせ、照合の道具はそれを見て
理由つきで止まる。

横断の読み取りには `app.auditexport` を**登録制の例外**として追加した(7つ目)。

## 3. 正準形を書き写さなかった

**書き写すと、片方だけ直したときにアンカーと書き出しが食い違い、
「改ざんされた」ように見える。それは最悪の誤報である。**

プロセスが別(worker と api)なので1か所には寄せられない。
`check_unwired` セクションF に**許容2か所**として登録し、
3か所目が現れたら落ちるようにした。
→ [[99.4_Decision_Log|DL-052]]

## 4. 当日は照合できない — 検査が教えた

最初、全体書き出しは常に `anchorVerifiable: true` にしていた。
検査が 22 対 23 で落ちた。

**書き出しそのものが `audit.export.executed` を記録する。**
当日を書き出すと、書き出した記録は書き出しに含まれない。
あとから再計算すれば、その1件の差で必ず食い違う。

**これは製品の誤りであり、検査が見つけた。**

## 5. 監査人が居なかった

シードに `platform_auditor` が1人も居なかった。
つまり**新しく構築した環境では、アンカーの照合手順を誰も実行できない。**

[[99.4_Decision_Log|DL-022]] が、**監査の手順そのもの**でも守られていなかった。
→ [[04.23_Wiring_Verification]] §22

## 6. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1424 passed (33 files)** |
| `tools/e2e/audit_export_flow.mjs` | **19項目すべて OK**(新規) |
| 既存 e2e 7本 | すべて OK |
| マイグレーション往復 (0023) | OK |
| `check_unwired.mjs` | **監査イベント型 27 件すべてが記録経路を持つ**(未使用 0 件) |

実経路で、再計算したルートがアンカーと一致することを確認
(`182685fc2a22b40a…`)。

## 7. 何を証明し、何を証明しないか

> ただしこれは**連鎖の一致**であり、正準形の作り方そのものは検証していない。
> アンカーの実体を外部(S3 Object Lock)の値と突き合わせて初めて改ざん検知になる。

**DB の中だけで完結する照合は、DB を書ける者には破れる。**
アンカーの外部書き出しは ADR-0009 の設計にあるが、まだ実装されていない。

## 8. 残っている制約

- **アンカーの外部保存が未実装**(§7)
- **1回の書き出しは50,000件まで。** 超えると打ち切り、照合不可にする
- 画面が無い。HTTP クライアントで取り出す
- **開発環境では検査が監査行を消すため、アンカーと食い違うことがある**
- 保持5年(AUD-003)の削除・退避は未実装

## 9. 関連

- [[WP-P1-AUD-004]] — 監査基盤とアンカー
- [[03.19_Migration_and_Audit_Requirements]] — AUD-002 / AUD-003
- [[ADR-0009_Append_Only_Audit]]
