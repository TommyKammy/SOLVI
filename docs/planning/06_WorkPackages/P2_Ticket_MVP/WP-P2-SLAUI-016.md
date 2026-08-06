---
project: SOLVI
doc_id: "WP-P2-SLAUI-016"
title: "SLAの可視化と期限の追跡"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-06"
updated: "2026-08-06"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2", "ticket", "sla"]
source_of_truth: true
implementation_status: "done"
phase: "P2"
workstream: "TICKET"
risk: "medium"
story_points: 8
depends_on: ["WP-P2-SEARCH-006", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-008", "FR-TKT-006"]
aliases: ["WP-P2-SLAUI-016"]
---

# WP-P2-SLAUI-016: SLAの可視化と期限の追跡

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | TICKET |
| Risk | medium |
| Story Points | 8 |
| Gate | Gate A(GA-1) |

## 1. Purpose

**SLAはITSMツールが「次に何をやるべきか」を教える仕組みである。**

`FR-TKT-008`(SLA Lite)は [[WP-P2-SEARCH-006]] で「実装済み」とされていた。
要求台帳との突き合わせで**3つの欠陥**が見つかった。

### 1.1 期限が誰にも見えていない

`TicketService.slaStatus()` は**テストからしか呼ばれていなかった**。
HTTP経路も画面も無い。期限が見えなければ、対応待ちの一覧は
登録順に並んだ箱でしかない。

### 1.2 放置されたチケットは超過にならない

判定は `response_sla_breached` / `resolution_sla_breached` に保存され、
更新するのは**状態遷移の1箇所だけ**だった。

誰も触らないチケットは期限を過ぎてもフラグが立たない。
**一覧で最も見たいのは放置されたものであり、そこだけが更新されない。**

しかもこの列はどのAPI応答にも画面にも出ていなかったため、
誰も気付かないまま「SLAを実装した」ことになっていた。

### 1.3 初回応答が記録されていない

`recordFirstResponse()` には「担当者の公開コメントで初めて呼ばれる」と
書かれていたが**呼ぶ側が居なかった**。`first_responded_at` は永久に NULL で、
応答SLAは全件が「未応答」として判定され続けていた。

## 2. Requirement IDs

`FR-TKT-008`(SLA)、`FR-TKT-006`(絞り込み・並び替え)

## 3. Dependencies

- [[WP-P2-SEARCH-006]] — SLAクロックと `sla_policy`
- [[WP-P2-OPSUI-010]] — 担当者の一覧と作業画面

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `apps/web/src/`
- `tools/`
- `tests/`

## 5. Out of Scope

- **営業時間の考慮** — 目標時間は暦時間で数える
- `sla_policy` を編集する画面
- 応答SLAの絞り込み(解決期限の超過のみ)
- SLA違反の通知・エスカレーション

## 6. Deliverables

- 一覧・詳細のSQLで期限を**計算する**(`SLA_SELECT_SQL`)
- migration 0018(保存列の削除)
- 作業画面・依頼者画面・一覧への期限表示
- 期限順の並び替えと超過の絞り込み
- 初回応答の記録を担当者の公開コメントに接続
- `check_unwired.mjs` のメソッド検査

## 7. Acceptance Criteria

- [x] **一覧に期限が載る**(保存値ではなく計算値)
- [x] **放置しただけで超過になる**(誰も触らなくても判定される)
- [x] 超過だけを絞り込める
- [x] **期限が近い順に並べられる**(最も遅れているものが先頭)
- [x] 知らない並び順・期限の値は 400
- [x] **期限順では続きの取得を受け付けない**(壊れた頁を黙って返さない)
- [x] **担当者の公開コメントで初回応答が記録される**
- [x] **内部メモは応答に数えない**(依頼者に届いていない)
- [x] **依頼者自身の追記は応答ではない**
- [x] 2回目以降のコメントで時刻が上書きされない
- [x] **依頼者にも期限が見える**
- [x] 目標未設定の組織を「超過」にしない
- [x] axe による自動検査で violation 0

## 8. Verification and Evidence

- `tests/security/ticket-filters.test.ts`(期限と初回応答の検査11件)
- `tests/security/ticket-search-sla.test.ts`(計算値での判定へ書き換え)
- `tools/e2e/conversation_flow.mjs`(期限の12項目)

Evidenceは`evidence/WP-P2-SLAUI-016/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 越境 | 期限の計算は既存の認可条件とRLSの内側で行う。新しい経路を作らない |
| 情報漏えい | 依頼者へ出すのは残り時間だけ。目標値そのものは出さない |
| 誤読 | 目標未設定は「目標未設定」と表示する。**空欄にも超過にもしない** |

## 10. Rollback / 失敗時の扱い

migration 0018 の `down` で列と索引を復元できる。
ただし復元しても値は入っていない(元から更新されていなかった)。

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
| 2026-08-06 | Opus 5 | `1a17901` / merge `6760a9f` | Done | `evidence/WP-P2-SLAUI-016/20260806-2337/` | 検査11件 + 通し確認12項目 + a11y 13画面。全体 1291 tests passed |

### 設計判断

**保存をやめて計算する。**

陳腐化しうる値を定期処理で追いかけるのではなく、
**陳腐化する余地そのものを無くした。**

自動クローズ([[WP-P2-CLOSE-014]])では定期処理を採ったが、
あちらは「状態を実際に変える」操作であり、SLAの判定は「読むたびに分かる」値である。
**変えるものは定期処理、見るだけのものは計算**という分け方になる。

**二か所に書かない。** 一覧と詳細で同じSQL式(`SLA_SELECT_SQL`)を使う。
別々に書くと、一覧と詳細で違う期限が出る。
実際、最初は一覧にしか書いておらず、**通し確認が
「依頼者の画面に期限が出ない」を捉えた。**

**列ごと消す。** 列を残したまま書き込みだけをやめると、
古い値が入ったまま「参照してよい列」に見え続ける。
次に触る人が信じてしまう。

**目標未設定を「超過」にしない。** 既定値をSQLに書くと
TypeScript 側の `DEFAULT_SLA_TARGETS` と二重に持つことになる。
NULL のまま「目標未設定」と表示する。
設定漏れを超過として並べると、本当に遅れているものが埋もれる。

**期限の列を担当より前に置く。** 担当者が最初に見るべきは
「どれが遅れているか」であり、誰が持っているかではない。

**秒を出さない。** 「あと 3600 秒」では誰も判断できない。

**依頼者にも期限を見せる。** 「いつまでに返ってくるか」は
依頼者が最も知りたいことであり、見えないと「まだですか」が増える。

**期限順ではカーソル頁を受け付けない。** カーソルは `(created_at, id)` で
判定するため、別の列で並べた一覧に適用すると飛ばし・重複が起きる。
**黙って壊れた頁を返さない。**

### 検査の穴 (04.23 の続き)

この欠陥を `check_unwired.mjs` は捉えられなかった。
セクションCが `export function` と `export class` しか見ておらず、
**公開クラスのメソッドを見ていなかった**ためである。

`TicketService` 自体はあちこちで使われているので「使われている」と
判定されてしまう。**使われている物の中に、誰も呼ばないものが隠れる。**

メソッドの抽出を追加したところ、さらに4件が出た
(`deactivateUser` / `createCredential` / `purgeExpired` / `recordScanResult`)。
いずれも本WPの範囲外なので、次の候補として記録する。

### 残っている制約

- **営業時間を考慮しない。** 金曜夕方の起票は土日を挟んで超過する
- 応答SLAの絞り込みが無い
- **件数が増えたときの索引が無い。** 計算列なので既存の索引が効かない。
  増えたときは「保存して定期更新」ではなく**生成列と索引**を検討する
  (生成列なら書き忘れが起きない)
