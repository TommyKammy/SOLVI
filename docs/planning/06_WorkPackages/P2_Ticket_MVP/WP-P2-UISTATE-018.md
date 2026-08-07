---
project: SOLVI
doc_id: "WP-P2-UISTATE-018"
title: "画面の状態表示"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-07"
updated: "2026-08-07"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ux", "accessibility"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "UISTATE"
risk: "medium"
story_points: 5
depends_on: ["WP-P1-IDM-010", "WP-P2-PORTAL-002"]
requirement_ids: ["NFR-UX-004", "NFR-UX-003", "NFR-UX-002"]
aliases: ["WP-P2-UISTATE-018"]
---

# WP-P2-UISTATE-018: 画面の状態表示

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | UISTATE |
| Risk | medium |
| Story Points | 5 |
| 依存 | [[WP-P1-IDM-010]] / [[WP-P2-PORTAL-002]] |
| Evidence | `evidence/WP-P2-UISTATE-018/20260807-0330/` |

## 1. 出発点

`NFR-UX-004`(Should)は「Loading / Empty / 権限なし / 競合 / 期限切れ /
オフラインの各状態に、**次の行動を示す表示**を持つ」。

根拠文書 [[11.11_UI_State_and_Error_Model]] は骨子のみの draft で、
冒頭にこう書かれている。

> **Phase 2着手前**までに実体化します。

Phase 2 は終わっている。実体化されていない。
そして `loading.tsx` / `error.tsx` / `not-found.tsx` は**1つも無かった。**

## 2. 最も重い欠陥 — 障害時に「パスワードが違う」ように見えていた

APIを実際に止めて画面を開いたところ、こうなった。

```
/ops       → 307 /login
/          → 307 /login
/ops/users → 307 /login
```

**全画面が黙ってログイン画面へ送られる。**

利用者から見ると、いきなりログアウトさせられたように見える。
そしてログインを試みると**同じ理由で失敗し**、画面には
「メールアドレスまたはパスワードが正しくありません」と出る。

全員が自分の資格情報を疑いながら何度も試すことになる。
本当の原因はどこにも書かれていない。

### 情報はあった。呼ぶ側が捨てていた

`call()` は最初から到達不能を 503 として返していた。
`requireSession()` がそれを見ずに、失敗をすべて同じ扱いにしていた。

**両端は正しく、繋ぎ目が判断を捨てていた**([[04.23_Wiring_Verification]] §7 と同じ形)。

皮肉なことに、この関数のコメントには
「401と組織未選択を同じ扱いにしない。**直しようのない行き止まり**になる」と
書かれていた([[99.4_Decision_Log|DL-017]])。
**同じ誤りをもう1種類やっていた。**
→ [[99.4_Decision_Log|DL-036]]

## 3. 直したこと

| 状態 | 以前 | いま |
|---|---|---|
| 基盤へ届かない | 黙ってログイン画面 | `/unavailable`。「ログアウトされたわけではありません」 |
| セッション期限切れ | 黙ってログイン画面 | `/login?expired=1`。理由を書く |
| 未ログイン | ログイン画面 | 変えない(期限切れとは言わない) |
| 見つからない | **ヘッダだけの空白ページ** | 文言と戻る導線 |
| 画面遷移中の例外 | Next.js の既定画面 | `error.tsx` |

**「なぜ画面から追い出されたのか」が分からないまま戻されると、
利用者は自分の操作を疑う。**

## 4. `error.tsx` では足りなかった

最初は「5xx なら例外を投げ、`error.tsx` が文面を出す」形にした。**動かなかった。**

サーバ側の描画中に投げた例外は `error.tsx` へ届かない。
全ページ読み込みでは Next.js の既定の500画面が出るだけで、
**日本語ですらない。**
`error.tsx` が効くのは画面遷移中とハイドレーション後であり、
**最初の1枚には効かない。**

投げるのをやめ、`/unavailable` という普通のページへ送る形に変えた。

**通し確認で実際にAPIを止めていなければ、この誤りに気付かなかった。**
文言は書けていたので、コードを読む限りは正しく見える。
→ [[99.4_Decision_Log|DL-037]]

## 5. `loading.tsx` は入れて、外した

入れたところ、**404も500も 200 になった。**

`loading.tsx` があるセグメントは Next.js がストリーミングで返すため、
HTTPの状態コードが先に確定する。`notFound()` も例外も、
本文の中に流れ込むだけになる。

合成監視は状態コードを見ている。**「見つからない」を 200 で返す画面は、
壊れていることを検知できなくする。**

この案件の主題そのものなので、**状態コードの正しさを取った。**
→ [[99.4_Decision_Log|DL-038]]

## 6. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1352 passed (30 files)** — `requireSession` の分岐9件を追加 |
| `tools/e2e/ui_state_flow.mjs` | **17項目すべて OK**(新規。**APIを実際に停止**) |
| 既存 e2e 6本 | すべて OK |
| `check_accessibility.mjs` | **16画面 violation 0**(状態表示3画面を追加) |
| `check:all` | OK |

## 7. 通し確認の書き方で1つ学んだ

最初、配信された本文から `<script>` を落として文言を探し、
**すべて「無い」と判定された。**

not-found と error の境界は flight payload として script の中で配信され、
ブラウザが描く。script を落とすと「配信されているのに無い」と誤判定する。

判定を「配信されたか」に変え、**実際に見えるか**は
`check_accessibility.mjs`(実ブラウザ)へ渡した。

## 8. 残っている制約

- **読み込み中の表示が無い**(§5)。状態コードの正しさと引き換えにした
- **`/unavailable` へ送ると、開いていた画面を見失う。** `?from=` で戻す案は
  外部URLを載せられる経路になるため採らなかった
- 障害中もヘッダは「未ログイン」の見た目になる。**紛らわしい**
- **オフライン(ブラウザ側の切断)は扱っていない。**
  NFR-UX-004 が挙げる状態のうち、これだけ未対応
- 競合(409)の共通表示は無い。画面ごとに文言を書いている
- **[[11.11_UI_State_and_Error_Model]] は本WPで実体化していない。**
  実装が先行した状態が続いている

## 9. 関連

- [[03.13_UX_Accessibility_Requirements]] — NFR-UX-004
- [[11.11_UI_State_and_Error_Model]] — draft のまま
- [[WP-P1-IDM-010]] — `requireSession()` の導入と DL-017
- [[04.23_Wiring_Verification]] §7 / §11
