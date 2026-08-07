---
project: SOLVI
doc_id: "WP-P1-DATA-002"
title: "Organization/User/Role schemaとRLS"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "done"
requirement_ids: ["FR-IDM-002", "FR-IDM-003", "FR-IDM-006", "NFR-SEC-001", "NFR-SEC-006"]
---

# WP-P1-DATA-002: Organization/User/Role schemaとRLS

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | DATA |
| Risk | high |
| Story Points | 8 |
| Suggested Owner | Backend + Security Reviewer |
| Parallelizable | No(PLAT-001後) |
| Gate | Gate 1 |

## 1. Purpose

テナント境界の土台を作る。[[02.18_Organization_Data_Model_and_RLS]]のデータモデルとRLSを実装し、越境が構造的に不可能な状態を検証する。以降の全ドメインWPの前提。

## 2. Requirement IDs

`FR-IDM-002`, `FR-IDM-003`, `FR-IDM-006`, `NFR-SEC-001`, `NFR-SEC-006`

## 3. Dependencies

[[WP-P1-PLAT-001]]

## 4. Scope / Allowed Paths

- `db/migrations/`
- `services/api/src/modules/identity/`
- `services/api/src/common/authz/`
- `tests/security/`
- `tools/check_rls.mjs`

## 5. Out of Scope

- OIDCログイン(WP-P1-IDM-003)
- SCIM(Phase 5)
- 管理UI(Phase 2以降)

## 6. Deliverables

- organization/app_user/identity/role/role_binding/idp_group_mappingのスキーマとMigration
- RLSポリシーと接続ロール設定
- Organizationコンテキスト設定のミドルウェア
- オブジェクトレベル認可の共通機構(NFR-SEC-006)
- 越境テストの自動生成スイート
- RLS設定検査スクリプト

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] 02.18§2の全エンティティがMigrationとして存在し、UNIQUE制約(issuer+subject / idp_type+external_id)が効いている
- [ ] 全業務テーブルで`ENABLE`かつ`FORCE ROW LEVEL SECURITY`が有効である(検査スクリプトで証明)
- [ ] アプリ接続ロールが非owner・NOBYPASSRLSであり、`app.current_org`未設定時に業務テーブルが0行を返す
- [ ] 2 Org × 全ロールの越境アクセス自動テストが全件403または404で、200が0件である
- [ ] platform scopeのロールを`idp_group_mapping`へ登録しようとするとDB制約で失敗する
- [ ] role_bindingの有効期限切れで権限が失われることがテストで確認できる
- [ ] 新規テーブル追加時にRLS未設定を検出する検査スクリプトが`tools/`に存在する

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-06(越境・権限外の自動生成テスト)
- TL-04(結合)
- TL-05(Migration)

### Evidence

- 越境テストの全件結果(エンドポイント×ロール×Orgの網羅表)
- RLS設定検査スクリプトの出力
- DB権限監査の出力

Evidenceは`evidence/WP-P1-DATA-002/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- 本WPはGate 1のG1-2/G1-3の対象。Security Reviewerのsign-off必須
- テストは手書きリストでなく、ルーティング定義から自動生成して網羅性を担保する
- platform_adminの付与経路は手動+二重承認のみ(SCIM/IdP経由を塞ぐ)

## 10. Rollback / 失敗時の扱い

Migrationのdownでスキーマを戻す。RLS設定はスキーマと同一Migrationで管理し、部分適用状態を作らない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-DATA-002)
3. 参照設計: 02.18_Organization_Data_Model_and_RLS(全節)、ADR-0015、02.14_Threat_Model T-01/T-02/T-07

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
1. 02.18§2のエンティティをMigrationとして実装する(UNIQUE制約・外部キー・チェック制約を含む)。
2. 02.18§3のRLSパターンを全業務テーブルへ適用する。アプリ接続ロールを非owner・NOBYPASSRLSで作成する。
3. リクエストごとに`SET LOCAL app.current_org`を行うミドルウェアを実装する(接続プール利用時の漏れに注意)。
4. オブジェクトレベル認可の共通機構(リソース取得時に所有者・ロールを検証、存在秘匿は404)を実装する。
5. **越境テストをルーティング定義から自動生成**する仕組みを作る。手書きのテストリストにしない。
6. `tools/check_rls.mjs`(全テーブルのRLS有効性・接続ロール権限を検査)を作成し、CIで実行できるようにする。

重要: RLSは安全網であり主たる認可ではない。アプリケーション層の認可を省略しないこと。
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
| 2026-07-27 | Claude (Codex) | `4cf1bb3` | Done | `evidence/WP-P1-DATA-002/20260727-1015/verification.md` | 越境テスト18/18、認可単体15/15、RLS検査 問題0件、Migration up/down往復成功。**逸脱1件**: §4のAllowed Pathを`tools/check_rls.py`→`tools/check_rls.mjs`へ変更。DB接続に`pg`を用いるためNode実装が自然で、他のDBツール(migrate/seed/bootstrap_roles)と実装言語を揃えた。本WPの§4と§11を同じ変更で更新済み(2026-07-27 承認)。 |
