---
project: SOLVI
doc_id: "WP-P1-IDM-003"
title: "Okta OIDC Loginとセッション失効"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "not-started"
---

# WP-P1-IDM-003: Okta OIDC Loginとセッション失効

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | IDM |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(DATA-002後) |
| Gate | Gate 1 |

## 1. Purpose

Okta OIDCによるログインを実装し、IdP側の無効化がSOLVIのセッションへ15分以内に反映される状態を作る。

## 2. Requirement IDs

`FR-IDM-001`, `FR-IDM-002`, `FR-IDM-008`

## 3. Dependencies

[[WP-P1-DATA-002]]

## 4. Scope / Allowed Paths

- `services/api/src/modules/auth/`
- `apps/web/src/app/(auth)/`
- `tests/security/auth/`

## 5. Out of Scope

- Entra OIDC(Phase 4)
- SCIM(Phase 5)
- ローカルパスワード認証(ADR-0004で不採用)

## 6. Deliverables

- Authorization Code + PKCEフロー
- IDトークン検証(issuer/audience/state/nonce/exp)
- identity linkとJITユーザ作成
- セッション管理と失効機構
- ログイン監査イベント

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] Oktaテストテナントでログイン・ログアウトが動作する
- [ ] issuer不一致・audience不一致・state不一致・nonce再利用・exp超過・署名不正の6ケースがすべて拒否される
- [ ] PKCEなしの認可リクエストが拒否される
- [ ] メールアドレスを変更しても同一user_idが維持される(issuer+subjectでの同定)
- [ ] IdPでユーザを無効化してから15分以内に既存セッションとリフレッシュが失効する(FR-IDM-008)
- [ ] `auth.login.success` `auth.login.denied` `auth.session.revoked`の監査イベントが生成される
- [ ] 未知のIdPグループ所属ユーザがrequester以外の権限を得ない(fail closed)

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-08(OIDCネガティブテスト)
- TL-06(ロール解決の権限テスト)
- TL-04

### Evidence

- 6ケースのネガティブテスト結果
- 失効SLAの実測ログ(無効化→失効までの経過時間)

Evidenceは`evidence/WP-P1-IDM-003/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- Gate 1のG1-1/G1-9の対象。Security Reviewerのsign-off必須
- IDトークン・アクセストークンをログへ出力しない(redaction検証を含める)
- セッション失効の実装方式(短命トークン+IdP照会 / バックチャネルログアウト)を選定理由とともに記録する

## 10. Rollback / 失敗時の扱い

認証の不具合は全機能停止に直結するため、feature flagで旧経路へ戻せる状態を保つ。テストテナントのみで検証し、本番IdP接続はGate 1後。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-IDM-003)
3. 参照設計: ADR-0004、03.7_Identity_OIDC_SCIM_Requirements、02.14_Threat_Model T-04/T-05

制約:
- §4 Allowed Paths以外のファイルを変更しない。必要が生じたらPRを分けるか、WP追加を提案する。
- §5 Out of Scopeの内容を先取り実装しない。
- ADRの決定(特にAI advisory-only、Executor分離、RLS必須)を変更しない。変更が必要なら実装を止めて後継ADRを提案する。
- 依存WPが未完了なら実装せず、不足を報告する。
- 新規依存パッケージの追加は事前に理由と代替案を提示して承認を得る。
- Secret・実データ・PIIをコード、テスト、ログ、コミットに含めない。

完了時に報告すること:
- 変更ファイル一覧 / Migrationの有無と内容 / 実行した検証コマンドと結果
- §7 Acceptance Criteria の各項目に対する充足状況(証拠付き)
- セキュリティ影響 / 未解決事項 / Evidenceの保存先

作業内容:
1. Okta OIDCのAuthorization Code + PKCEフローを実装する。
2. IDトークン検証を実装する。issuer/audience/state/nonce/exp/署名のいずれか不正なら拒否(fail closed)。
3. identity(issuer, subject)によるユーザ同定とJIT作成を実装する。メールは識別子にしない。
4. IdPグループ→SOLVIロールのマッピングを実装する。未知グループはrequesterのみ(fail closed)。platform scopeへのマッピングは拒否。
5. **セッション失効**: IdP無効化を15分以内に反映する方式を設計・実装する。
   選択肢(選定理由を記録すること): ①アクセストークン短命化+定期的なIdP照会 ②OIDC Back-Channel Logout ③両方
6. TL-08のネガティブテストを6ケース以上実装する。

Oktaテストテナントの情報は環境変数から読む。テナント情報・クライアントシークレットをコードに書かない。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Security Reviewerのsign-offを得た(必須)
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
