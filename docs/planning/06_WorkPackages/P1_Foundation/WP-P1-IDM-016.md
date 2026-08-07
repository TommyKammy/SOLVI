---
project: SOLVI
doc_id: "WP-P1-IDM-016"
title: "利用者を作る経路と、要求IDの訂正"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-08-08"
updated: "2026-08-08"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity", "operations"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "medium"
story_points: 5
depends_on: ["WP-P1-IDM-012", "WP-P1-IDM-015"]
requirement_ids: ["NFR-MNT-002"]
aliases: ["WP-P1-IDM-016"]
---

# WP-P1-IDM-016: 利用者を作る経路と、要求IDの訂正

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | medium |
| Story Points | 5 |
| 依存 | [[WP-P1-IDM-012]] / [[WP-P1-IDM-015]] |
| Evidence | `evidence/WP-P1-IDM-016/20260808-0530/` |

## 1. まず訂正 — 台帳に嘘を書いていた

[[WP-P1-IDM-015]] で、役割の付与に `FR-IDM-005` を名乗らせた。**誤りである。**

`FR-IDM-005` は「**SCIM Group/Membership 同期**」であり、
作ったのは管理画面からの手動の役割付与である。SCIM は未実装。

結果、[[03.18_Requirements_Traceability_Matrix]] が
「SCIM Group 同期は**検査あり**」と表示した。

**台帳が嘘をつく状態を、台帳を作った次のWPで作った。**

`requirement_ids`・台帳の Work Package 欄・検査/画面/サービスの
コメント10か所から外し、`未着手` へ戻した。

### 導出の仕組みは、古さは防ぐが誤りは防がない

[[WP-P2-RTM-019]] の仕組みは「書いてあることと導出値が食い違えば落ちる」。

**入力そのものが誤っていれば、誤ったまま一貫する。**
しかも `--write` は追加しかしないので、誤って書いた要求IDは
自動では剥がれない。手で両側を消す必要があった。
→ [[04.23_Wiring_Verification]] §19 / [[99.4_Decision_Log|DL-047]]

## 2. 本題 — 人を作る経路が無かった

`app_user` を作れるのは `tools/seed.mjs` と手書きのSQLだけであり、
**新しく構築した環境では誰も招き入れられなかった。**

[[WP-P1-IDM-015]] で役割は配れるようにしたが、配る相手が居ない。
DL-022 の連鎖が、もう一段残っていた。

`user.created` が監査イベント型として未使用だったのは、その影である。

## 3. これは FR-IDM-004(SCIM User)ではない

SCIM は外部IdPが利用者を押し込む本番の経路である。
これは**検証段階で人を招き入れるための管理操作**にすぎない。

**要求IDを借りない。** §1 で直したばかりの誤りを繰り返さない。
根拠は [[ADR-0019_Local_Authentication_For_Development]] と運用上の必要である。

## 4. RLS では守れないことを認めた

`app_user` の RLS は USING しか持たず、PostgreSQL では INSERT の可否を
WITH CHECK が決めるため、INSERT はすべて拒否されていた。

仮に USING を適用できたとしても通らない。条件が「その組織に
`role_binding` を持つこと」であり、**作りたての利用者はまだ束縛を持たない。**

`app_user` は組織に属さない([[WP-P1-DATA-002]] の設計)。
組織の列が無い行に対して、RLS が書き込みを絞る根拠は無い。

**守れないものを守れるふりをしない。** migration 0021 で
`WITH CHECK (true)` を明記し、理由をコメントに書いた。
→ [[99.4_Decision_Log|DL-048]]

## 5. 他組織の重複は検出しない — 検出できない

当初、「他組織に既に居る人」を検出して**存在を教えない文面**を返す実装にした。
**前提が間違っていた。**

- 自組織のクエリは RLS により他組織を見られない
- `primary_email` に**一意制約は無い**(連絡先であって識別子ではない /
  FR-IDM-002)

検出する手段が最初から無い。検出するには組織をまたいでメールを引く必要があり、
それは**在籍者の総当たりができる経路**になる。

**検出できないことを、検出したふりで隠さない。**
自組織の重複だけを 409 で止め、他組織の重複は別の行として作られることを
検査で固定した。

## 6. 作ることと、入れるようにすることを分けた

作った利用者は `identity` も `local_credential` も持たない。**ログインできない。**

資格情報の設定は `create_local_user`([[WP-P1-IDM-012]])が別に行う。
画面はそれを明記する。**半分だけ終わった状態を「完了」と読ませない。**

## 7. 検証

| 検査 | 結果 |
|---|---|
| `npx vitest run` | **1397 passed (32 files)** |
| `tools/e2e/leaver_flow.mjs` | **59項目すべて OK** |
| マイグレーション往復 (0021) | OK |
| `check_unwired.mjs` | **未使用の監査イベント型が 2 → 1 件へ** |
| `check_rls` / `check_traceability` / `check_accessibility` | OK |

## 8. 残っている制約

- **他組織の重複を検出しない**(§5)
- **資格情報の設定が画面から出来ない。** CLI を叩く必要がある
- **利用者を消す経路は無い。** 止めるだけ(履歴を残す設計)
- **表示名とメールを直せない。** 作り直すしかない
- SCIM(FR-IDM-004)は未実装。これはその代替ではない
- `audit.export.executed` が未使用。**監査の書き出しがまだ無い**

## 9. 関連

- [[WP-P1-IDM-015]] — 役割の付与(§1 の訂正対象)
- [[WP-P1-IDM-012]] — 資格情報の設定
- [[WP-P2-RTM-019]] — 要求台帳の導出
- [[04.23_Wiring_Verification]] §19
