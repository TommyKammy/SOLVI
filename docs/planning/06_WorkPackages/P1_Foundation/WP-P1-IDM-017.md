---
project: SOLVI
doc_id: "WP-P1-IDM-017"
title: "役割の期限を切れる前に知らせる"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-08"
updated: "2026-08-08"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "notification"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "medium"
story_points: 5
depends_on: ["WP-P1-IDM-014", "WP-P2-NTF-005"]
requirement_ids: ["FR-IDM-006"]
aliases: ["WP-P1-IDM-017"]
---

# WP-P1-IDM-017: 役割の期限を切れる前に知らせる

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | medium |
| Story Points | 5 |
| 依存 | [[WP-P1-IDM-014]] / [[WP-P2-NTF-005]] |
| Evidence | `evidence/WP-P1-IDM-017/20260808-0630/` |

## 1. 出発点

[[WP-P1-IDM-014]] で期限到来を記録できるようにした。
**気付けるのは切れたあと**である。

画面には出したが、管理者が `/ops/users` を見に行かなければ分からない。
**切れる前に知らせなければ、延長するかどうかを判断する機会が無い。**

自分で書いた制約(IDM-014 §6)を閉じる。

## 2. Outbox はチケットの仕組みではなかった

`NotificationService.deliverForEvent` が**チケット番号を必須**にしており、
チケット以外の出来事を積むと**恒久失敗として捨てられる**。

Outbox は「業務の状態が変わったことを別プロセスへ確実に伝える仕組み」
(ADR-0008)であって、問い合わせ専用ではない。非チケットの経路を足した。

`OUTBOX_EVENT_TYPES` が閉じた列挙だったおかげで、
**型が先に「これは想定外だ」と言った。** 広げるかどうかを考える機会になった。
→ [[99.4_Decision_Log|DL-049]]

## 3. 予告と到来は別の出来事

| 印 | 意味 |
|---|---|
| `expiry_notified_at` | 予告を送った |
| `expiry_recorded_at` | 期限が来たことを記録した |

**1つの列で2つの事実を表そうとすると、片方が消える。**

「あと N 日」は期限到来と同じく**状態であって出来事ではない**。
印が無ければ毎周回で送ってしまう。

## 4. 宛先は本人と組織の管理者

| 宛先 | なぜ |
|---|---|
| 本人 | 予定を立てられる。切れてから「入れない」と気付くのを防ぐ |
| 管理者 | **延長を決められるのは管理者だけ** |

**役割名を件名に書かない。** 「監査者の権限が切れます」と件名に出ると、
メールの一覧にその人の権限が並ぶ。何の期限かは画面で見てもらう。

残り日数は書く。**いつまでかが分からなければ動けない。**

## 5. 閾値を2か所に置かない — 置き方を変えた

最初、`ROLE_EXPIRY_WARNING_DAYS` を `packages/shared` に置き、
画面とサーバの両方から import した。**画面が壊れた。**

`apps/web` から `@solvi/shared` を読むと barrel 全体が引かれ、
Next.js のビルドで解決できない依存(node専用)が混ざる。

直し方を変えた。**画面は閾値を持たない。**
`expiringSoon` / `daysRemaining` をAPIが計算して返し、画面は描くだけにする。

共有定数より良い。**判定が1か所にあるのではなく、判定する側が1つになる。**
画面が独自に数える余地そのものが消えた。
→ [[99.4_Decision_Log|DL-050]]

## 6. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1409 passed (32 files)** — 予告8件・配送4件を追加 |
| e2e 7本 | すべて OK |
| マイグレーション往復 (0022) | OK |
| `check_accessibility` / `check_rls` / `check:all` | OK |

実スタックで、あと10日で切れる束縛について本人と管理者の2名へ
「あと 10 日」の通知が届くことを確認。

## 7. 途中で読み違えかけた

マイグレーションの往復のあと、通し確認が26件落ちた。
**製品の欠陥ではなく、§5 の共有 import が原因**で画面が起動できていなかった。

往復そのものは通っており、落ちたのは画面である。
**「マイグレーションを戻したから壊れた」と読み違えかけた** —
順序が紛らわしかっただけである。

## 8. 残っている制約

- **予告は1度だけ。** 切れる直前の念押しが無い
- **閾値は30日固定。** 環境変数にしていない
- **platform スコープは対象外**(IDM-014 と同じ理由)
- 管理者を全員宛先に含める。**管理者が多い組織では騒がしい**
- 予告を受けて延長する導線が無い。`/ops/users` を開いて手で操作する

## 9. 関連

- [[WP-P1-IDM-014]] — 期限到来の記録(本WPが閉じた制約の出どころ)
- [[WP-P2-NTF-005]] — 通知と Outbox
- [[ADR-0008_Transactional_Outbox]]
