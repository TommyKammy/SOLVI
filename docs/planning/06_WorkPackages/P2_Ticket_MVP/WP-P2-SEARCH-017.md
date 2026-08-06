---
project: SOLVI
doc_id: "WP-P2-SEARCH-017"
title: "検索条件の公開(依頼者・期間)"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-06"
updated: "2026-08-06"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ticket", "search"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "TICKET"
risk: "low"
story_points: 3
depends_on: ["WP-P2-SEARCH-006", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-006"]
aliases: ["WP-P2-SEARCH-017"]
---

# WP-P2-SEARCH-017: 検索条件の公開(依頼者・期間)

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | TICKET |
| Risk | low |
| Story Points | 3 |
| Gate | Gate A(GA-1) |

## 1. Purpose

`FR-TKT-006` は「番号・件名・**依頼者**・状態・担当・**期間**で検索」。

`TicketFilter` には最初から `requesterId` / `createdFrom` / `createdTo` があり、
SQLの条件も書かれていた。**クエリパラメータとして読んでいなかっただけ**である。
条件は書けるのに、外から指定する経路が無かった。

## 2. 着手して見つけた、より重い欠陥

### 画面の絞り込みが**一つも効いていなかった**

一覧画面はURLの値を許可リストで転記してAPIへ渡す。その許可リストが
`['state','kind','priority','assignment','keyword']` のまま止まっており、
**`group` `sla` `sort` を後から足したとき追加していなかった。**

```
(条件なし)                                    3行
?group=ungrouped                             3行   ← 効いていない
?sla=breached                                3行   ← 効いていない
```

**プルダウンは動く。URLも変わる。結果だけが変わらない。**
フォームは送っているのに、画面が捨てていた。

[[WP-P2-GRP-015]] と [[WP-P2-SLAUI-016]] で入れた絞り込みが
どちらも画面から使えていなかった。両WPの通し確認は
「選択肢が画面にある」ことは確かめたが、
**「選ぶと結果が変わる」ことは確かめていなかった。**

通し確認に「**APIの件数と画面の行数が一致する**」検査を入れた。
片方だけ見ても気付けない類の欠陥である。

## 3. Requirement IDs

`FR-TKT-006`(検索・絞り込み)

## 4. Scope / Allowed Paths

- `services/api/src/modules/ticket/`
- `apps/web/src/`
- `tools/`
- `tests/`

## 5. Out of Scope

- 解決日・更新日での絞り込み(受付日のみ)
- 依頼者の複数指定
- 保存した検索条件

## 6. Deliverables

- 期間の絞り込み(`createdFrom` / `createdTo`)
- 依頼者の絞り込み(`requester`)と作業画面からの導線
- 画面の転送許可リストの修正
- 通し確認の「APIと画面の件数一致」検査
- `recordFirstResponse` の二重実装の解消

## 7. Acceptance Criteria

- [x] 受付日の範囲で絞り込める
- [x] **「まで」はその日の終わりまで含む**
- [x] 日付の形式が不正なら 400
- [x] **終わりが始まりより前なら 400**(0件で誤りに気付かせない、をしない)
- [x] 依頼者を指定して絞り込める
- [x] **存在しないIDでも0件を返すだけ**(実在の有無が漏れない)
- [x] **依頼者が他人のIDを指定しても自分の分しか出ない**
- [x] **他組織の依頼者のチケットは出ない**
- [x] UUID以外は 400
- [x] **画面の絞り込みがAPIと同じ件数になる**(全条件)
- [x] axe による自動検査で violation 0

## 8. Verification and Evidence

- `tests/security/ticket-filters.test.ts`(期間・依頼者の検査11件)
- `tools/e2e/portal_flow.mjs`(APIと画面の件数一致 12項目)

Evidenceは`evidence/WP-P2-SEARCH-017/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 総当たり | 依頼者は**存在が漏れない**(0件は「居ない」と「問い合わせが無い」を区別しない) |
| 越境 | 他組織の依頼者IDを指定しても認可条件とRLSで0件 |
| 名簿の露出 | **画面に依頼者の選択肢を出さない。** 作業画面の導線から辿る |
| 転送の範囲 | 画面はURLの値を許可リストで転記する。任意の項目を素通ししない |

## 10. Rollback / 失敗時の扱い

DBスキーマを変更しない。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] `check_unwired.mjs` が通る
- [x] **稼働中のスタックで実際に動くことを確認した**
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-08-06 | Opus 5 | `3e48d27` / merge `c060552` | Done | `evidence/WP-P2-SEARCH-017/20260806-2353/` | 検査11件 + 件数一致12項目 + a11y 13画面。全体 1302 tests passed |

### 設計判断

**依頼者は担当と扱いを変えた。**

担当の絞り込みでは任意の利用者IDを受け付けない([[WP-P2-OPSUI-010]])。
「他人の担当分を名指しで引く」必要が無く、受け付ければ
在籍者のIDを総当たりする経路になるためである。

依頼者は事情が違う。

| 論点 | 依頼者の場合 |
|---|---|
| 用途 | 「この人の他の問い合わせ」は調査の起点として日常的に要る |
| 存在の漏えい | **漏れない。** 0件は「その利用者が居ない」と「その利用者の問い合わせが無い」を区別しない |
| IDの入手 | 作業画面が既に `requesterId` を返している |

画面には**依頼者の選択肢を出さない**(在籍者の一覧は名簿である)。
作業画面の「この依頼者の他の問い合わせ」から辿る。

**期間は日付だけ受け取る。** 時刻まで指定させると、
「9:00 から」と入れた人が前日の夜間を取りこぼす。
「まで」はその日の終わりまで含める。

**終わりが始まりより前なら 400。** 決して一致しない範囲は
絞り込みではなく入力の誤りである。0件を返すと「該当なし」と読まれ、
指定を間違えたことに気付けない。

### 二重の真実を1つ消した

[[WP-P2-SLAUI-016]] で初回応答を記録するとき、
`TicketService.recordFirstResponse` を呼ばずに**同じSQLを書き写していた**。

検査(`check_unwired`)が「テストからしか呼ばれていない」と
報告し続けたことで気付いた。**検査が繰り返し指す先には、たいてい理由がある。**

「何を初回応答と数えるか」は業務の定義である。`TicketService` に置き、
`CollaborationService` はそれを呼ぶ形に直した。

### 未接続の残り4件を登録した

検査をメソッド単位まで下げたこと([[WP-P2-SLAUI-016]])で見えた未接続を、
理由付きで `ACCEPTED_UNWIRED` に登録した。**いずれも実在の欠落である。**

| 対象 | 内容 |
|---|---|
| `deactivateUser` | **FR-IDM-007(Leaver)の経路が無い** |
| `createCredential` | パスワード設定の経路が無い。scryptの形式が二重に定義されている |
| `purgeExpired` | 期限切れセッションの掃除が動いていない |
| `recordScanResult` | 同じ判定が worker 側にも書かれている |

### 残っている制約

- 期間は受付日のみ。解決日・更新日での絞り込みが無い
- 依頼者は1人だけ
- 保存した検索条件が無い(URLをブックマークする運用)
