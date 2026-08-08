---
project: SOLVI
doc_id: "WP-P1-AUD-019"
title: "監査アンカーの外部保存"
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
story_points: 5
depends_on: ["WP-P1-AUD-018"]
requirement_ids: ["AUD-003"]
aliases: ["WP-P1-AUD-019"]
---

# WP-P1-AUD-019: 監査アンカーの外部保存

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | AUD |
| Risk | high |
| Story Points | 5 |
| 依存 | [[WP-P1-AUD-018]] |
| Evidence | `evidence/WP-P1-AUD-019/20260808-0830/` |

## 1. 出発点 — 自分で書いた限界を閉じる

[[WP-P1-AUD-018]] で照合の道具を作ったとき、末尾にこう書いた。

> **DB の中だけで完結する照合は、DB を書ける者には破れる。**

**外に置いて初めて、2か所を同時に偽る必要が生まれる。**

準備は揃っていた — `external_uri` 列(0003 から)、`S3_BUCKET_AUDIT_ANCHOR`、
`solvi-audit-anchor` バケット。**書き込みだけが無かった**
(`persistAnchor(client, result, null)`)。

## 2. 列はあったが、埋める書き込みを schema 自身が禁じていた

`audit_anchor_no_update` が**あらゆる UPDATE を拒む**。
行を入れたあとで URI を書き足すことはできない。

最初「後から埋める」実装を書いて、**検査が落ちた。**
誰も書いていなかったので、この矛盾は10日以上表に出なかった。

### 順序を変えて解いた

先に外へ置き、URI を持った状態で行を入れる。
鍵は日付から決まる(`anchors/<date>.json`)ので、置く前から分かる。

**不変性を緩めない。** トリガを外す案は採らなかった —
不変であることがこの表の値である。
→ [[99.4_Decision_Log|DL-053]]

### 後から埋めない

**DB の値から作った写しは、DB が偽られていたらその偽りを写すだけ**である。
同時に書いたものでなければ、突き合わせる意味が無い。

## 3. 実際に改ざんを検知させた

不変トリガを外して DB のルートだけを書き換え、
**DB へ書ける攻撃者**を模した。

```
改ざん前: match
改ざん後: mismatch stored=ffffffffffff external=ae97058984ca
復元後:   match
```

**これが [[WP-P1-AUD-018]] の時点では出来なかったことである。**

## 4. 列だけを見て「置いてある」と信じない

照合は `external_uri` の有無ではなく、**実物を取りに行く**。
外部の実物が消えていれば `not_uploaded` を返し、
**「一致した」とは言わない。**

## 5. ローカルでは改ざん防止になっていない

本番では Object Lock(WORM)を有効にしたバケットへ置く前提である。
ローカルの MinIO では有効化していない。

**ローカルでは「2か所に書く」だけであり、消せない保証は無い。**

## 6. 通し確認の失敗を読み違えかけた

`audit_export_flow` が照合で落ちた。**製品の欠陥ではなかった。**

照合の道具に環境変数を渡しておらず、道具は 78 で終了していた。
catch が `stdout` だけを出していたため、
**「環境変数が無い」が「一致しなかった」に見えていた。**

**失敗の理由を捨てる検査は、嘘の診断を出す。**
前提を先に確かめ、`stderr` も出すように直した。
→ [[99.4_Decision_Log|DL-054]]

## 7. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1432 passed (34 files)** |
| `tools/e2e/audit_export_flow.mjs` | **19項目すべて OK** |
| 既存 e2e 7本 | すべて OK |
| `check:all` / `check_accessibility` | OK |

実スタックで `s3://solvi-audit-anchor/anchors/2026-08-07.json` を確認。

## 8. 残っている制約

- **ローカルに Object Lock が無い**(§5)
- **この変更より前のアンカーには外部の写しが無い。** 後から作らない
- 外部保存の失敗は記録に残るが、**再試行しない**
- **アンカーの実体は1か所(同じ MinIO)にしかない。**
  本当の分離には別アカウント・別リージョンが要る
- **監査人が自分で照合する経路が無い。** worker の周回でのみ行われる

## 9. 関連

- [[WP-P1-AUD-018]] — 書き出しと照合(本WPが閉じた限界の出どころ)
- [[WP-P1-AUD-004]] — アンカーの計算
- [[ADR-0009_Append_Only_Audit]]
