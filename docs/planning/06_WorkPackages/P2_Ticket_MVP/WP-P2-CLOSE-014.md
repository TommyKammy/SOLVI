---
project: SOLVI
doc_id: "WP-P2-CLOSE-014"
title: "自動クローズの実行とReopenの導線"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-29"
updated: "2026-07-29"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ticket"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "TICKET"
risk: "medium"
story_points: 5
depends_on: ["WP-P2-TKT-001", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-012", "FR-TKT-002"]
aliases: ["WP-P2-CLOSE-014"]
---

# WP-P2-CLOSE-014: 自動クローズの実行とReopenの導線

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | TICKET |
| Risk | medium |
| Story Points | 5 |
| Gate | Gate A(GA-1) |

## 1. Purpose

**チケットが完了しない状態を終わらせる。**

[[03.3_Ticket_Requirements]] の状態機械は「Closed(Resolved後14日で自動)」と
定めており、`state-machine.ts` にも `resolved → closed (auto_close)` の規則がある。

しかし `grep auto_close services/ apps/ tools/` の結果は **0件**。
**実行する者が居なかった。** 解決済みチケットは永久に `resolved` のまま残る。

さらにこの遷移が担当者画面に**手で押せるボタンとして出ていた**。

```
[ in_progress にする ]  [ 完了にする ]  [ closed にする ]
```

1. `reopen` と `auto_close` に訳が無く、**内部の状態名が生で出ていた**
2. `close` と `auto_close` で**同じ意味のボタンが2つ並んでいた**
3. 自動化のための遷移理由が、手動操作の選択肢になっていた

これで7件目の「定義したが動いていない」である([[04.23_Wiring_Verification]])。
**今回は動いていないだけでなく、間違った形で画面に出ていた。**

## 2. Requirement IDs

`FR-TKT-012`(Reopen)、`FR-TKT-002`(状態遷移)

## 3. Dependencies

- [[WP-P2-TKT-001]] — 状態機械と Reopen の窓
- [[WP-P2-OPSUI-010]] — 担当者の作業画面

## 4. Scope / Allowed Paths

- `services/api/src/common/`
- `services/api/src/modules/ticket/`
- `services/api/src/main.ts`
- `apps/web/src/`
- `db/migrations/`
- `tools/`
- `tests/`

## 5. Out of Scope

- **営業日の考慮** — 暦日で14日を数える。営業日カレンダーは別WP
- 組織ごとの日数設定 — 定数(`AUTO_CLOSE_AFTER_DAYS`)のまま
- 自動クローズ専用の通知文面 — `ticket.transitioned` として送る

## 6. Deliverables

- 自動クローズの定期実行(`services/api/src/common/close/auto-close.ts`)
- migration 0016(`app.autoclose` の読み取り例外と抽出用の索引)
- `TicketService.autoClose` と `applyTransition` の共通化
- `auto_close` / `merge` を担当者の選択肢から除外
- `reopen` のラベルと、**依頼者の再開導線**
- 自動遷移を `actorType: 'system'` として記録

## 7. Acceptance Criteria

- [x] **14日を過ぎた解決済みが自動で閉じる**
- [x] **14日以内は閉じない**(Reopenの窓が開いている間は閉じない)
- [x] 抽出後に状態が動いていたら閉じない
- [x] 全組織を横断して候補を拾う。**閉じる操作は各組織のコンテキストで行う**
- [x] 1件の失敗で全体が止まらない
- [x] **自動遷移が `system` として監査に残る**(`actorId` を載せない)
- [x] **`auto_close` が担当者の選択肢に出ない**
- [x] **内部の状態名が画面へ出ない**(すべての選択肢に訳がある)
- [x] **依頼者が自分のチケットを再開できる**
- [x] 14日を過ぎた再開は拒否される
- [x] 他人のチケットは再開できない
- [x] 依頼者の画面に再開の導線と期限の説明がある
- [x] axe による自動検査で violation 0

## 8. Verification and Evidence

- `tests/security/collaboration-routes.test.ts`(自動クローズと再開の検査10件)
- `tools/e2e/conversation_flow.mjs`(解決後の扱い10項目)

Evidenceは`evidence/WP-P2-CLOSE-014/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 越境 | 読み取りのみ `app.autoclose` で越境。**書き込みは各組織のコンテキスト** |
| 監査の誤読 | 自動遷移は `actorType: 'system'`、`actorId` を載せない |
| 他人のチケットの再開 | `requesterId` の一致を要求。不一致は 404(存在秘匿) |
| 期限の迂回 | 14日の判定は状態機械が持つ。画面では数えない |

## 10. Rollback / 失敗時の扱い

migration 0016 は `FOR SELECT` ポリシーと索引の追加のみ。`down` で戻せる。
定期実行を止めても業務は継続する(解決済みが閉じなくなるだけ)。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] `check_rls.mjs` / `check_architecture.mjs` / `check_allowed_paths.mjs` が通る
- [x] `check_unwired.mjs` が通る
- [x] **稼働中のスタックで実際に閉じることを確認した**
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-29 | Opus 5 | `5c5774d` / merge `64ed797` | Done | `evidence/WP-P2-CLOSE-014/20260729-2143/` | 検査10件 + 通し確認10項目 + a11y 12画面。全体 1252 tests passed |

### 設計判断

**読み取りは越境させ、書き込みは越境させない。**

候補の一覧を作るには全組織を横断する必要がある(migration 0016 の `app.autoclose`)。
一方、1件を閉じる操作は必ずその組織のコンテキストで行い、監査もその組織に残る。
この分け方が要点である。

**抽出時点の判断を信じない。** 抽出から実行までに人が Reopen していることがある。
1件ごとに状態機械へもう一度問う。

**1件の失敗で全体を止めない。** 止めると滞留が積み上がり、
あとで一度に大量に閉じることになる。

**ラベルの既定値を変えた。** `?? \`${rule.to} にする\`` は
**訳が無いことを隠す**。`?? \`${rule.to} (${rule.reason})\`` にして、
訳の欠落が画面から見て分かる形にした。
テストでも「どの選択肢のラベルも `状態名 (理由)` の形にならない」ことを固定した。

**依頼者に許すのは cancel と reopen の2つだけ。**

`cancel` が無いと「やっぱり不要でした」のためだけに担当者へ連絡することになる。
`reopen` が無いと、依頼者は同じ件で新規に起票し直すしかなく、
**履歴が分断される**。担当側から見ても再発なのか未解決なのか区別できなくなる。

**自動遷移を人の操作として記録しない。** 人として記録すると、
記録を読む人が「誰が閉じたのか」を探して見つからず、時間を使うことになる。

通知の `actorId` も省く。自動遷移には操作者が居ないため、
通知側の自己除外が誰にも当たらず**関係者全員へ届く**。それが正しい。

**14日は Reopen の窓と同じ長さにする。** 閉じてから再開できないと、
依頼者は同じ件で新規に起票し直すことになる。窓が開いている間は閉じない。

### 残っている制約

- **自動クローズの通知は `ticket.transitioned` として送られる。**
  件名は「状況が更新されました」であり、「14日経過したため完了にしました」とは
  書かれない。依頼者から見ると、なぜ今更updateが来たのか分かりにくい
- 14日は定数。組織ごとに変えられない
- **営業日を数えない。** 暦日で14日。年末年始に解決したものは休みの間に窓が閉じる
