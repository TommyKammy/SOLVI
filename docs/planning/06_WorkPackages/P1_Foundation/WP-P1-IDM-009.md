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
implementation_status: "not-started"
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

- [ ] 正しい資格情報でログインでき、セッションCookieが `HttpOnly` + `SameSite=Lax` で発行される
- [ ] 誤ったパスワード・存在しないユーザ・無効化済みユーザのいずれも**同じ応答**を返す
      (どれが原因かを攻撃者に教えない)
- [ ] 失敗回数の上限に達するとロックアウトされ、ロック中は正しいパスワードでも通らない
- [ ] **成否にかかわらず応答時間が一定**(存在しないユーザで即座に返ると、
      ユーザ名の存在有無が測定できてしまう)
- [ ] パスワードが scrypt で保存され、DBに平文・可逆な形が存在しない
- [ ] セッショントークンが**DBに平文で保存されない**(ハッシュで保存する)
- [ ] 失効したセッションでのアクセスが拒否される
- [ ] **ユーザ無効化からセッション失効までが15分以内**(`FR-IDM-008` / G1-9)。実測値を記録する
- [ ] 絶対期限とアイドル期限の両方が効く
- [ ] `AUTH_LOCAL_ENABLED=true` かつ `NODE_ENV=production` で**プロセスが起動しない**
- [ ] ローカル認証が既定で無効(未設定なら認証経路が存在しない)
- [ ] 認証の成功・失敗が監査に記録され、`auth_method` が含まれる
- [ ] **監査にパスワードもセッショントークンも記録されない**
- [ ] `identity.issuer` が `urn:solvi:local` で、外部IdPの issuer と混在しても取り違えない
- [ ] セッションが Organization をまたがない(他組織のコンテキストを取得できない)

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

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] Migration に down があり、up→down→up が成功する
- [ ] `check_rls.mjs` と `check_architecture.mjs` が通る
- [ ] Security Reviewer のレビューを完了した(認証は侵入経路のため)
- [ ] Execution Logへ結果を追記した

## 12. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
