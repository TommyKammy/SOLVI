---
project: SOLVI
doc_id: "ADR-0015_Organization_Isolation_and_RLS"
title: "Organization分離は共有スキーマ+RLS必須の論理分離とする"
category: "07_ADR"
type: "adr"
status: "accepted"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["adr"]
source_of_truth: true
implementation_status: "not-started"
---

# ADR-0015: Organization分離は共有スキーマ+RLS必須の論理分離とする

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

グループ会社・複数組織での利用を前提とし、テナント間のデータ漏えいは事業上許容できない。分離方式には環境分離・スキーマ分離・行レベル分離があり、運用コストと安全性のトレードオフがある。この決定は全テーブル設計の前提であり、Phase 1着手前に確定が必要(OQ-004)。

## Decision

**単一DBクラスタ・共有スキーマとし、全業務テーブルに`organization_id`を持たせ、Row Level Securityを必須**とする。防御は二層: ①アプリケーション認可(主たる認可判定)②RLS(安全網)。アプリ接続ロールは非owner・NOBYPASSRLS、`FORCE ROW LEVEL SECURITY`を全テーブルに適用する。設計詳細は[[02.18_Organization_Data_Model_and_RLS]]。Cross-org操作は3つの明示例外のみ(platform管理/マイグレーション/監査アンカー)。

## Consequences

### 得られるもの

- アプリのバグや新規エンドポイントの認可漏れがあってもDBが越境を遮断する
- 組織の追加が設定操作で済み、環境の複製が不要
- バックアップ・監視・移行の運用対象が1つ

### 受け入れるコスト

- 全クエリでOrganizationコンテキストの設定が必要(接続プール利用時は`SET LOCAL`の徹底が必須)
- RLSポリシーの設定漏れが即座に穴になるため、テーブル追加時の検査を自動化する必要がある
- 「物理的に別DB」という説明ができないため、監査説明では二層防御とテスト結果で示す

## Rejected Alternatives

- **Organizationごとに別環境/別DB** — 運用対象とコストが組織数に比例。数社規模でも維持が難しく、共通ナレッジの扱いも複雑
- **スキーマ分離(organizationごとにschema)** — マイグレーションがスキーマ数に比例。接続時のsearch_path管理も同様に間違えやすい
- **アプリケーション認可のみ(RLSなし)** — 認可漏れが即データ漏えいになる。単一の防御層では監査上も弱い

## Security Impact

T-01/T-02の主対策。RLSは「主たる認可」ではなく安全網であり、オブジェクトレベル認可(NFR-SEC-006)はアプリ層の責務。platform_adminのIdPグループ経由付与を禁止し、org切替を監査イベント化する(T-07/T-20)。

## Operational Impact

テーブル追加時にRLS有効化を強制するCI検査(TL-06)。Gate 1でDB権限監査(G1-3)。

## Migration Impact

移行データ投入時もorganization_idを必ず設定する。マイグレーションはowner接続で行い、実行を監査する。

## Follow-up

- 新規テーブルのRLS有効化検査をWP-P1-CI-006で自動化する
- 子Organization階層の閲覧継承は初期非対応(RA-03)。必要になれば後継ADR

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
