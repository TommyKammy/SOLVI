---
project: SOLVI
doc_id: "WP-P1-IDM-009"
title: "ローカルアカウント認証とセッション基盤"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.1.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1", "identity"]
source_of_truth: true
implementation_status: "done"
phase: "P1"
workstream: "IDM"
risk: "high"
story_points: 8
depends_on: ["WP-P1-DATA-002", "WP-P1-AUD-004"]
requirement_ids: ["FR-IDM-002", "FR-IDM-008", "NFR-SEC-003"]
aliases: ["WP-P1-IDM-009"]
---

# WP-P1-IDM-009: ローカルアカウント認証とセッション基盤

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(DATA-002後) |
| Gate | Gate 1(G1-1 / G1-9) |

## 1. Purpose

ログインとセッション生涯管理を実装し、業務機能を認証込みで検証できる状態にする。

根拠は [[ADR-0019_Local_Authentication_For_Development]]。
認証には2つの独立した関心事がある。

1. **本人確認** — 外部IdP固有。テナントが無いため今は作れない
2. **セッション生涯管理** — IdP非依存。今すぐ作れて、後で作り直す必要がない

本WPは 2 を最終形として作り、1 は差し替え可能なローカル実装で埋める。
外部IdP接続([[WP-P1-IDM-003]])で追加するのは
**IDトークンを検証してセッションを発行する部分だけ**になる。

> [!important] このWPで最も重要なのは「本番で使えないこと」の保証
> ローカル認証は検証専用である。運用ルールではなく**起動拒否**で担保する。
> 警告は無視されるが、起動失敗は無視できない。

## 2. Requirement IDs

`FR-IDM-002`(Identity Link)、`FR-IDM-008`(セッション失効15分以内)、`NFR-SEC-003`

## 3. Dependencies

- [[WP-P1-DATA-002]] — `app_user` / `identity` / `role_binding`
- [[WP-P1-AUD-004]] — 認証イベントの監査

## 4. Scope / Allowed Paths

- `db/migrations/`
- `packages/shared/src/auth/`
- `packages/shared/src/config/`
- `services/api/src/modules/auth/`
- `services/api/src/common/`
- `tools/`
- `tests/`

## 5. Out of Scope

- 外部IdPのOIDC接続 → [[WP-P1-IDM-003]](Gate D)
- SCIM → Phase 5
- MFA(ローカル環境に限るため持たない)
- Break Glass 経路(要件が異なる。[[08.13_Break_Glass_Runbook]])
- パスワードリセットのメール送信(検証段階では管理者が直接再設定する)

## 6. Deliverables

- `local_credential` テーブル(scrypt ハッシュ、ソルト、失敗回数、ロック期限)
- `session` テーブル(不透明トークンのハッシュ、絶対期限、アイドル期限、失効)
- ログイン / ログアウト / セッション検証のエンドポイント
- 失効機構(個別・ユーザ単位・全件)
- 認証ミドルウェア(既存の `AuthzContext` を実セッションから組み立てる)
- **本番構成での起動拒否**
- ローカルアカウント作成ツール(`tools/create_local_user.mjs`)
- 認証監査イベント(`auth_method` を含む)

## 7. Acceptance Criteria

- [x] 正しい資格情報でログインでき、セッションCookieが `HttpOnly` + `SameSite=Lax` で発行される
- [x] 誤ったパスワード・存在しないユーザ・無効化済みユーザのいずれも**同じ応答**を返す
      (どれが原因かを攻撃者に教えない)
- [x] 失敗回数の上限に達するとロックアウトされ、ロック中は正しいパスワードでも通らない
- [x] **成否にかかわらず応答時間が一定**(存在しないユーザで即座に返ると、
      ユーザ名の存在有無が測定できてしまう)
- [x] パスワードが scrypt で保存され、DBに平文・可逆な形が存在しない
- [x] セッショントークンが**DBに平文で保存されない**(ハッシュで保存する)
- [x] 失効したセッションでのアクセスが拒否される
- [x] **ユーザ無効化からセッション失効までが15分以内**(`FR-IDM-008` / G1-9)。実測値を記録する
- [x] 絶対期限とアイドル期限の両方が効く
- [x] `AUTH_LOCAL_ENABLED=true` かつ `NODE_ENV=production` で**プロセスが起動しない**
- [x] ローカル認証が既定で無効(未設定なら認証経路が存在しない)
- [x] 認証の成功・失敗が監査に記録され、`auth_method` が含まれる
- [x] **監査にパスワードもセッショントークンも記録されない**
- [x] `identity.issuer` が `urn:solvi:local` で、外部IdPの issuer と混在しても取り違えない
- [x] セッションが Organization をまたがない(他組織のコンテキストを取得できない)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-08(認証のネガティブテスト)
- TL-06(組織境界)
- TL-16(監査)

### Evidence

- ネガティブテストの拒否ケース一覧
- **セッション失効の実測時間**(G1-9 の判定材料)
- 本番構成での起動拒否ログ

Evidenceは`evidence/WP-P1-IDM-009/<YYYYMMDD-HHMM>/`へ保存する。

## 9. Security and Audit

| 脅威 | 対策 |
|---|---|
| T-25 ローカル認証の本番混入 | 起動拒否 + 既定無効 + `auth_method` 監査 |
| 資格情報の総当たり | ロックアウト + 応答時間の一定化 |
| セッション窃取 | `HttpOnly` + トークンをDBにハッシュ保存 + 失効機構 |
| セッション固定 | ログイン時に必ず新しいセッションIDを発行する |
| 情報の非対称漏えい | 失敗理由を返さない(ログには記録する) |

## 10. Rollback / 失敗時の扱い

`AUTH_LOCAL_ENABLED=false` で認証経路ごと無効化できる。
Migration は down を用意し、`session` / `local_credential` を削除できる。

## 11. Definition of Done

- [x] §7 Acceptance Criteriaをすべて満たす
- [x] §8のテストが通り、Evidenceを保存した
- [x] Migration に down があり、up→down→up が成功する
- [x] `check_rls.mjs` と `check_architecture.mjs` が通る
- [x] Security Reviewer のレビューを完了した(認証は侵入経路のため)
- [x] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | `c7134ff` / merge `374f85c` | Done | `evidence/WP-P1-IDM-009/20260727-2206/` | 単体26 + 統合39。全体 1071 tests passed |

### 実測値

| 項目 | 要求 | 実測 |
|---|---|---|
| セッション失効(`FR-IDM-008` / G1-9) | 15分以内 | **0.032秒** |

失効がこれだけ速いのは設計の帰結である。セッションに役割を焼き込まず、
毎リクエストで `role_binding` を読み直している。焼き込むと、権限を剥奪しても
セッションが切れるまで古い権限で動き続ける。
また、無効化されたユーザは一括失効処理を待たずに `validate()` で弾かれる。

### 実装中に見つけた問題

1. **ログイン時に組織所属を検証していなかった。**
   クライアントが送った `organizationId` をそのままセッションに記録しており、
   **利用者は任意の組織を名乗ってセッションを取れた**。後段の認可判定が
   役割束縛を見るため越境は起きないが、RLSのコンテキストが他組織に設定された
   状態で動くことになり、防御が1枚だけになる。
   有効な役割束縛の確認を追加した。

2. **認証は組織コンテキストより手前にある(循環)。**
   `app_user` / `role_binding` は組織スコープのRLS配下だが、ログインは
   「メールアドレスから利用者を引く」ところから始まる。
   migration 0010(Outboxディスパッチャ)と同じ**登録制の例外**にしたが、
   今回はさらに絞った: `FOR SELECT` のみ / 対象は2テーブル / `SET LOCAL`。
   → [[02.18_Organization_Data_Model_and_RLS]] §3.2

   この結果、`deactivateUser` と `createCredential` は認証ではなく
   **管理操作**として組織コンテキストの中で呼ぶ、という区別が明確になった。

### 残っている制約

- MFA は無い(ローカル環境限定のため受容 / [[ADR-0019_Local_Authentication_For_Development]])
- パスワードリセットのメール送信は無い。管理者が `tools/create_local_user.mjs` で再設定する
- **期限切れセッションの掃除(`purgeExpired`)を定期実行に組み込んでいない。**
  実装済みだが worker へ未登録のため、保持期間30日を超えた行が溜まる
- ローカルアカウントは外部IdP接続時に全て破棄する(Gate D GD-5)
