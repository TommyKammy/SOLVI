---
project: SOLVI
doc_id: "WP-P2-UISTATE-020"
title: "競合とオフライン — 状態モデルの残り"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-08"
updated: "2026-08-08"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ux", "ticket"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "UISTATE"
risk: "medium"
story_points: 5
depends_on: ["WP-P2-UISTATE-018", "WP-P2-OPSUI-010"]
requirement_ids: ["NFR-UX-004", "FR-TKT-002", "FR-TKT-003"]
aliases: ["WP-P2-UISTATE-020"]
---

# WP-P2-UISTATE-020: 競合とオフライン — 状態モデルの残り

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UISTATE |
| Risk | medium |
| Story Points | 5 |
| 依存 | [[WP-P2-UISTATE-018]] / [[WP-P2-OPSUI-010]] |
| Evidence | `evidence/WP-P2-UISTATE-020/20260808-0200/` |

## 1. 出発点

[[WP-P2-UISTATE-018]] で NFR-UX-004 の状態表示を入れたが、
**競合とオフラインの2つを残していた。**

[[11.11_UI_State_and_Error_Model]] を実体化するにあたり、
未実装の状態を含む文書を書くと**書いた瞬間に実態と食い違う。**
先に塞いだ。

## 2. 競合 — 二人が同じ問い合わせを開いている

ITSMでは日常的に起きる。これまで、**片方の変更をもう片方が
気付かずに上書きできた。**

状態機械は不正な遷移を止めるが、**同じ状態のままの上書き**は止めない。

```
A: 作業画面を開く(担当なし)
B: 作業画面を開く(担当なし)
B: 自分を担当にする
A: 別の人を担当にする   ← 通る。B の割当は消える。誰も知らない。
```

### 版を持ち回る

`ticket.updated_at` をそのまま版とする。

**連番の列を足さない。** `updated_at` には既に更新トリガが付いており、
版が2つあると片方だけ進む。

対象は作業画面の4操作 — 状態遷移・担当割当・グループ振替・見立ての見直し。
コメントは追記なので競合しない。

### 版を送らない呼び出しは素通しする

定期処理(自動クローズ)やAPIを直接叩く運用がある。
**守りたいのは画面から操作する人**である。

ただし**空文字は素通ししない。** 未指定と混ぜると、
フォームが空を送ったときに競合の検出が黙って無効になる。

### 業務規則の競合と別の型にする

`Problems.stale` を新設した。同じ 409 でも**利用者がとるべき行動が違う**。
→ [[99.4_Decision_Log|DL-041]]

### 何も変えない操作は版を動かさない

`assignGroup` は同じグループを渡されたとき早期に戻る。
そのため**他人の空振りが自分の競合にならない。**
通し確認を書いていて気付いた性質であり、そのまま残した。

## 3. オフライン — サーバ側では分からない状態

`/unavailable`(基盤が落ちている)とは**別の状態**である。

| | 誰が落ちているか | 利用者にできること |
|---|---|---|
| `/unavailable` | サービス側 | 待つ |
| オフラインの表示 | 手元の回線 | **自分で直せる** |

区別しないと、自分のWi-Fiが切れているときに
「サービスに接続できていません」と読み、情報システム部門へ連絡が来る。

`navigator.onLine` は完璧ではない。
**分かる範囲だけを言い、分からないときは何も言わない。**

## 4. アクセシビリティ検査が機能の欠陥を捕まえた

axe が `nextjs-portal` のコントラスト違反を報告した。
**Next.js の開発時エラー表示**である。つまり画面が例外を起こしていた。

```
Error: Functions cannot be passed directly to Client Components
```

競合の判定を1か所にまとめるつもりでコンポーネントの中に
`failWith()` を定義しており、サーバアクションがそれを閉包に取り込もうとして
落ちていた。**閉包へ入れてよいのは値であって、関数ではない。**

**検査は、それが探しているものだけを見つけるわけではない。**
コントラスト比を測る検査が、サーバアクションの誤りを教えた。
→ [[99.4_Decision_Log|DL-042]] / [[04.23_Wiring_Verification]] §16

## 5. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1362 passed (31 files)** — 競合の検査10件を追加 |
| `tools/e2e/ui_state_flow.mjs` | **26項目すべて OK**(競合9項目を追加) |
| 既存 e2e 6本 | すべて OK |
| `check_accessibility.mjs` | **16画面 violation 0** |
| `check_traceability.mjs` | OK。NFR-UX-004 が「検査あり」へ |

マイグレーションは無い(`updated_at` は既存)。

## 6. 残っている制約

- **読み込み中の表示は依然として無い。** [[WP-P2-UISTATE-018]] §5 の
  判断(状態コードの正しさを取る)を変えていない
- 競合の検出は**作業画面の4操作だけ**
- **どこが変わったかを示さない。** 「他の人が変更しました」とだけ言う
- `navigator.onLine` は「繋がっているが到達できない」を検出できない
- 依頼者の画面には競合の検出が無い

## 7. 関連

- [[11.11_UI_State_and_Error_Model]] — 本WPで baseline へ
- [[WP-P2-UISTATE-018]]
- [[04.23_Wiring_Verification]] §15 / §16
