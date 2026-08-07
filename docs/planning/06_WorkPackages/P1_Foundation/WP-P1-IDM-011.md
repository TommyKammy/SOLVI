---
project: SOLVI
doc_id: "WP-P1-IDM-011"
title: "退職者のアクセス停止"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-07"
updated: "2026-08-07"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "security"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "high"
story_points: 5
depends_on: ["WP-P1-IDM-009"]
requirement_ids: ["FR-IDM-007", "FR-IDM-008"]
aliases: ["WP-P1-IDM-011"]
---

# WP-P1-IDM-011: 退職者のアクセス停止

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | high |
| Story Points | 5 |
| 依存 | [[WP-P1-IDM-009]] |
| 要求 | FR-IDM-007 / FR-IDM-008 |
| Evidence | `evidence/WP-P1-IDM-011/20260807-0030/` |

## 1. 背景 — 開いたままの扉

`FR-IDM-007` の受入基準は「**deactivate後のログイン不可**、履歴は残る」。

`SessionService.deactivateUser` は [[WP-P1-IDM-009]] で作られていた。
`app_user.status` を更新し、全セッションを失効させ、監査へ残す。
**中身は正しかった。呼ぶ経路が無かった。**

HTTPの入口も、画面のボタンも、運用の手順も無い。
退職者のアカウントは有効なまま残り続け、受入基準を満たす手段が
どこにも存在しなかった。

[[04.23_Wiring_Verification|「定義したが動いていない」]]の15件目である。
そして**その中で最も実害が直接的なもの**だった。
他の14件は「見えない」「効かない」だったが、これは開いたままの扉である。

検査 (`check_unwired`) は [[WP-P2-SLAUI-016]] で粒度をメソッド単位まで
下げたときにこれを検出し、[[WP-P2-SEARCH-017]] で理由付きの
承知リストへ登録していた。**承知していた未接続を繋いだ。**

## 2. 実装

| 経路 | 内容 |
|---|---|
| `GET /users` | 在籍者と状態、役割、対応中の件数 |
| `POST /users/:id/deactivate` | 停止。理由が必須 |
| `POST /users/:id/reactivate` | 復帰。理由が必須 |
| `/ops/users` | 管理画面(`org_admin` / `platform_admin` のみ) |

`DELETE` ではなく `POST` にした。**取り消せない見た目の操作をリンクに置かない**
という既存の方針([[WP-P2-RELUI-012]])に合わせる。

マイグレーションは無い。`app_user.status` / `deactivated_at` は
[[WP-P1-DATA-002]] の時点で存在していた。**足りなかったのは経路だけである。**

## 3. 決めたこと

### 3.1 止めることを妨げない

停止は security の操作でもある。「担当チケットが残っている」ことを
理由にAPIが拒むと、**漏えいが疑われる状況で止められなくなる。**

件数は返す。画面は止める前に警告として出す。**判断は人に残す。**
→ [[99.4_Decision_Log|DL-027]]

### 3.2 締め出しを作らない

- **自分自身は止められない** — その場でセッションが切れて元に戻せない
- **組織の最後の管理者は止められない** — 以後は誰も権限を戻せない

`platform_admin` の束縛は組織に属さない
(`organization_id IS NULL`、`role_binding_scope_org_consistency`)。
したがって**その組織の管理者としては数えない。**
組織の自治を保てるのは組織に束縛された管理者だけである。

この差により、最後の管理者の防御は**実際に到達する経路を持つ** —
プラットフォーム管理者が組織唯一の `org_admin` を止めようとした場合。
検査もその形で書いた。

### 3.3 理由を必須にする

停止も復帰も理由を要求し、監査へ残す。

**「なぜ止めたか」が無いと、退職と事故対応を後から区別できない。**
記録として意味を持たない。
→ [[99.4_Decision_Log|DL-028]]

### 3.4 復帰でセッションを戻さない

停止中に窃取された可能性のあるトークンまで生き返る。
本人に改めてログインしてもらう。

### 3.5 ここは名簿を出してよい場所である

[[WP-P2-GRP-015]] では担当グループの画面に在籍者の一覧を出さないと決めた。
[[WP-P2-SEARCH-017]] では検索の依頼者に選択肢を出さないと決めた。
いずれも**業務の画面に名簿を置かない**という判断だった。

在籍者の管理そのものを行う画面は事情が違う。一覧が無いと仕事にならない。
代わりに `org_admin` / `platform_admin` に閉じる — 担当者も依頼者も 403。

## 4. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1322 passed (28 files)** — 停止・復帰の検査20件を追加 |
| `tools/e2e/leaver_flow.mjs` | **28項目すべて OK**(新規) |
| 既存 e2e 5本 | すべて OK |
| `check_accessibility.mjs` | **13画面 violation 0**(`/ops/users` を追加) |
| `check_unwired.mjs` | OK。`deactivateUser` を承知リストから外した |
| `check_rls` / `check_architecture` / `check_allowed_paths` | OK |

**通し確認が私の誤りを1件捉えた。** 確認用のコードが存在しない
`/auth/session` を叩いていた(正しくは `/auth/me`)。
書いていなければ「停止前のセッションが切れること」を
一度も確かめないまま「実装した」と書いていた。

## 5. 検査がまた種を壊した(3度目)

「最後の管理者」の検査はシードの管理者を停止して状況を作る。
**戻さないまま終わり、後続の検査が落ちた。**

`local_credential` の全削除、`role_binding` の全削除に続く3度目である。
`beforeEach` と `afterAll` の両方でシード利用者を有効へ戻すようにした。

**共有DBに対する検査は、自分が変えたものを必ず戻す。**

## 6. 残っている制約

- **担当の一括振り替えが無い。** 件数は見えるが、振り直しは1件ずつ
- **予約停止が無い。** 「2026-08-31 付で」と書いても即時に止まる。
  退職日での自動停止は人事システム連携([[WP-P1-IDM-003]])の話になる
- **役割の付け外しが画面から出来ない。** 停止と復帰だけ
- **`role_binding` の有効期限切れが監査に出ない**(FR-IDM-006 の未達分)
- 停止した利用者が**依頼者だった場合の扱いを決めていない**

## 7. 関連

- [[WP-P1-IDM-009]] — `deactivateUser` の実装元
- [[WP-P1-IDM-010]] — 組織IDの手入力を無くす
- [[WP-P1-IDM-003]] — 外部IdP連携(未着手)
- [[04.23_Wiring_Verification]] — 欠陥15
- [[03.3_Functional_Requirements]] — FR-IDM-007 / FR-IDM-008
