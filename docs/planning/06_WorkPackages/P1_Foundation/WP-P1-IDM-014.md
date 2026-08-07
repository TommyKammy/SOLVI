---
project: SOLVI
doc_id: "WP-P1-IDM-014"
title: "役割の期限到来を記録する"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-08"
updated: "2026-08-08"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "audit"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "medium"
story_points: 5
depends_on: ["WP-P1-DATA-002", "WP-P1-IDM-011"]
requirement_ids: ["FR-IDM-006"]
aliases: ["WP-P1-IDM-014"]
---

# WP-P1-IDM-014: 役割の期限到来を記録する

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | medium |
| Story Points | 5 |
| 依存 | [[WP-P1-DATA-002]] / [[WP-P1-IDM-011]] |
| Evidence | `evidence/WP-P1-IDM-014/20260808-0330/` |

## 1. 出発点 — 受入基準の半分だけができていた

`FR-IDM-006`(兼務・出向)の受入基準は
「期限到来で**自動失権+監査イベント**」。

**自動失権は動いていた。** `resolveBindings()` が `valid_until` を見ており、
期限を過ぎた束縛は権限として数えられない(検査もある)。

**監査イベントだけが無かった。**

`role.binding.created` / `role.binding.deleted` は監査イベント型として
定義されているのに、**発行する者がどこにも居ない。**
`check_unwired` の A節が「4/27 件の監査イベント型が未使用」として
報告し続けていた。

## 2. 実害は静かである

兼務・出向の期限が切れると、ある日その組織が見えなくなる。

- 本人には理由が分からない(画面から消えるだけ)
- 管理者にも「いつ切れたか」を示す記録が無い
- `valid_until` の列は残るが、それは**予定**であって**事実**ではない
  (途中で延長されたか、切れる前に手で消されたかを区別しない)

**「権限を失った」ことは、失った瞬間に記録しないと後から作れない。**
→ [[99.4_Decision_Log|DL-043]]

## 3. 決めたこと

### 3.1 記録する — 消さない

`role.binding.deleted` を `action: 'expire'` で記録する。
**束縛の行は消さない。** 履歴として残す。

実行者は `system`。人が行った操作ではなく、**期限が来ただけ**である。

### 3.2 期限切れは状態であって出来事ではない

`valid_until < now()` は何度読んでも真であり、
そのままでは毎周回で同じ監査を書いてしまう。

migration 0020 で `expiry_recorded_at` を足し、
**1つの期限切れにつき1件だけ**書く。
印を先に付け、更新できた場合だけ記録する。

**印は失権の判定に使わない。** 記録の有無に関わらず、
期限を過ぎた束縛は権限にならない。

### 3.3 越境は読み取りだけ

`app.expiry` を**登録制の例外**として追加した。6つ目である
(`app.dispatcher` / `app.auth` / `app.scanner` / `app.anchor` /
`app.autoclose` / `app.expiry`)。

読むのは記録に要る列だけにした。氏名もメールも読まない —
**横断の読み取りで拾う情報は、必要な最小限に留める。**

### 3.4 platform スコープは対象外にし、件数で返す

platform スコープの束縛は組織に属さないため、記録を書き込む
組織の文脈が無い。書けるようにするには例外を UPDATE まで広げる必要があり、
**読み取りだけという原則を崩す**ことになる。

**黙って飛ばさない。** `skippedPlatform` として件数を返し、ログに出す。
→ [[99.4_Decision_Log|DL-044]]

### 3.5 画面に出す — 切れる前に

`/ops/users` に期限つきの役割を出した。**期限は静かに来る。**
30日以内のものは「あと N 日」と**文言で**書く(色だけに頼らない)。

## 4. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1371 passed (32 files)** — 期限到来の検査9件を追加 |
| `tools/e2e/leaver_flow.mjs` | **32項目すべて OK** |
| マイグレーション往復 (0020) | OK |
| `check_unwired.mjs` | **未使用の監査イベント型が 4 → 3 件へ** |
| `check_rls` / `check_accessibility` / `check:all` | OK |

実スタックで、10日前に切れた束縛が再起動後に記録されることを確認。

## 5. 検査がまた種を壊しかけた(4度目)

片付けを `created_via = 'admin'` で書いたところ、
**他の検査が作った利用者まで巻き込み**、チケットの外部キーで落ちた。

さらに、最初の修正が**反映されていなかった。**
prettier が整形したあとの文字列に対して置換を書いており、
一致せず黙って何もしなかった。検査が同じ理由で落ち続けて気付いた。
→ [[04.23_Wiring_Verification]] §17

## 6. 残っている制約

- **platform スコープの期限切れを記録しない**(§3.4)
- **切れる前の通知が無い。** 画面に出るだけで、メールは飛ばない
- **`role.binding.created` は依然として未使用。** 役割を配る画面が無い
- 期限を延長する画面が無い。延長はSQLで行う
- 本人には期限が見えない。管理者の画面にしか出ていない

## 7. 関連

- [[03.7_Identity_OIDC_SCIM_Requirements]] — FR-IDM-006
- [[WP-P1-IDM-011]] — 退職者のアクセス停止
- [[02.18_Organization_Data_Model_and_RLS]] — 登録制の越境例外
