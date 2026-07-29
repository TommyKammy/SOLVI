---
project: SOLVI
doc_id: "WP-P2-GRP-015"
title: "担当グループ"
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
story_points: 8
depends_on: ["WP-P2-OPS-003", "WP-P2-OPSUI-010"]
requirement_ids: ["FR-TKT-003", "FR-TKT-006"]
aliases: ["WP-P2-GRP-015"]
---

# WP-P2-GRP-015: 担当グループ

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | TICKET |
| Risk | medium |
| Story Points | 8 |
| Gate | Gate A(GA-1) |

## 1. Purpose

**ITSMの基本動作を入れる。**

`FR-TKT-003` は「担当 Group / User を設定」だが、実装は**個人割当だけ**だった。

問い合わせはまず担当グループのキューに入り、そこから個人が引き受ける。
個人指名しかできないと、「誰に振ればいいか分かる人」が全件を捌くことになり、
**その人が休んだ日に問い合わせが止まる。**

Must要求で唯一の未達だった。

## 2. Requirement IDs

`FR-TKT-003`(担当割当)、`FR-TKT-006`(検索・絞り込み)

## 3. Dependencies

- [[WP-P2-OPS-003]] — 一覧・絞り込み・個人割当
- [[WP-P2-OPSUI-010]] — 担当者の作業画面

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/ticket/`
- `services/api/src/main.ts`
- `apps/web/src/`
- `tools/`
- `tests/`

## 5. Out of Scope

- **グループ単位のSLA** — 目標時間は優先度だけで決まる
- **グループ宛の通知** — 購読設定を作るまでは送らない(Watcher は 03.3 の Non-Goals)
- 入れ子のグループ(1階層のみ)
- 自動振り分け規則 — Phase 4 の Workflow
- 依頼者へのグループ表示 — 内部の体制を外へ出す判断は別途必要

## 6. Deliverables

- migration 0017(`assignment_group` / メンバー / `ticket.assignee_group_id` / 履歴)
- `GroupService` と `TicketService.assignGroup`
- グループの管理と割当のHTTP経路
- 担当者一覧の**キュー絞り込み**(自分のグループ / 未割当 / 特定のグループ)
- 作業画面の振り先
- **グループ管理の画面**(org_admin)
- シードに各組織2グループ

## 7. Acceptance Criteria

- [x] 組織管理者がグループを作れる
- [x] **担当者はグループを作れない**(体制を変えられるのは管理者)
- [x] 依頼者はグループを見られない
- [x] 記号の重複は 409、形式違反は 400
- [x] **無効化しても消えない**(過去のチケットが振り先を失わない)
- [x] 無効化したグループへは**新しく振れない**
- [x] メンバーを追加・削除でき、二重追加で増えない
- [x] **他組織の利用者はメンバーにできない**
- [x] 本人の所属グループを引ける
- [x] グループへ振れる
- [x] **振っても状態は動かない**(キューは経路であって進行状態ではない)
- [x] **振り直しても個人の担当は外れない**
- [x] 依頼者は振れない
- [x] **他組織のグループへは振れない**
- [x] 振り先の変更が履歴と監査に残る
- [x] 同じグループへの振り直しは履歴を増やさない
- [x] グループ・自分のグループ・未割当で絞り込める
- [x] **所属が無い人の「自分のグループ」は0件になる**
- [x] 知らない絞り込み値は 400
- [x] **管理画面がある**(作る手段が無い機能は使えない)
- [x] axe による自動検査で violation 0

## 8. Verification and Evidence

- `tests/security/assignment-group.test.ts`(28件)
- `tools/e2e/group_flow.mjs`(27項目)

Evidenceは`evidence/WP-P2-GRP-015/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 論点 | 対応 |
|---|---|
| 越境 | `assignment_group` / メンバーに組織RLS。**越境の例外は作らない** |
| キュー経由の情報漏えい | 他組織の利用者はメンバーにできない(在籍を確認) |
| 権限 | 作る・無効化・メンバー変更は `org_admin` / `platform_admin` のみ |
| 名簿の露出 | **在籍者の一覧を画面に出さない。** 追加は利用者IDの入力 |
| 監査 | グループの作成・無効化は `config.changed`、メンバーは `org.member.added` / `removed`、振り分けは `ticket.assigned`(`action=assign_group`) |

## 10. Rollback / 失敗時の扱い

migration 0017 の `down` で戻せる。0006 の制約も復元する。

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
| 2026-07-29 | Opus 5 | `69bbea6` / merge `83f3d3a` | Done | `evidence/WP-P2-GRP-015/20260729-2227/` | 検査28件 + 通し確認27項目 + a11y 13画面。全体 1280 tests passed |

### 設計判断

**グループは経路であって進行状態ではない。** 状態機械に手を入れていない。

キューに入っただけのチケットを `assigned` にすると「担当者が決まった」ことに
なるが、実際には誰も見ていない。SLAの応答時間は**人が応答するまでの時間**であり、
キューに入った時刻ではない。グループと個人は別の軸として持つ。

**振り直しても個人の担当を外さない。** 既に誰かが持っているチケットの
グループを直しても、その人が担当であることは変わらない。
「振り直したら担当が消えた」は事故になる。

**消さずに閉じる。** 削除の経路を作っていない(`REVOKE DELETE`)。
削除すると過去のチケットが「どこへ振られたか」を失う。

**管理する手段を同時に作った。** 振る機能だけを作って作る手段を用意しないと、
新しく構築した環境では誰もグループを作れず、機能が使えない。
**シードのデータでしか動かないものは「作ったが使えない」状態である。**

**グループ割当で通知しない。** 購読設定が無い状態で全員へ送ると、
すぐに誰も読まなくなる。誰かが引き受けた時点で依頼者へ通知される。

**「自分のグループ」が0件のとき全件を返さない。** 空配列のまま条件を落とすと
**絞り込んだつもりで全件が出る**。一致しないIDを1つ渡して0件にする。

**在籍者の一覧を出さない。** メンバー追加は利用者IDの入力で行う。
組織の在籍者一覧は、それ自体が名簿である。

### 既存の制約を1つ広げた

0006 の `ticket_assignment_changes_assignee`
(`assignee_id IS DISTINCT FROM previous_assignee_id`)は、
グループだけを変える履歴を弾いてしまう。
意図は「何も変わらない行を残さない」ことであり、担当者に限る理由は無い。

`ticket_assignment_changes_something` に置き換え、
**どちらかが変わっていればよい**ことにした。

### axe が捉えた設計の誤り

無効化したグループを `opacity: 0.65` で薄く見せていたところ、
axe が **2.92:1** のコントラスト不足を検出した(要 4.5:1)。

`opacity` は文字のコントラストも一緒に落とす。
「色だけに頼らない」と書きながら、透明度だけに頼っていた。
区別は左の罫線と文言(「運用から外れています」)で行うよう直した。

### 残っている制約

- **メンバーの追加が利用者IDの手入力である。** 利用者管理の画面ができたら
  選択式にすべき。いまは在籍者一覧を出さない判断を優先した
- グループ単位のSLAが無い
- グループ宛の通知が無い
- 依頼者にはグループを見せない
