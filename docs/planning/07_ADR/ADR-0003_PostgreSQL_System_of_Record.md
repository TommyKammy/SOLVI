---
project: SOLVI
doc_id: "ADR-0003_PostgreSQL_System_of_Record"
title: "PostgreSQLを業務状態の正本とする"
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

# ADR-0003: PostgreSQLを業務状態の正本とする

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

ITSMの業務データは強い整合性(承認と実行の因果)、テナント分離、監査、全文検索、スキーマ進化を同時に要求する。複数ストアに分散すると整合性の担保コストが跳ね上がる。

## Decision

Ticket、Catalog、Approval、Workflow、Identity/RoleBinding、Asset、Change、Audit、Attachmentメタデータの**正本はPostgreSQL**とする。検索インデックス・キャッシュ・外部SaaSは常に派生であり、失われても再構築できるものとして扱う。

## Consequences

### 得られるもの

- トランザクション境界が明確で、状態変更+Outbox+監査を原子的に書ける
- RLSによるテナント分離の安全網が使える(ADR-0015)
- 全文検索(FTS)を追加ミドルウェアなしで開始できる(ADR-0011)
- バックアップ/PITRの復旧単位が1つで済む(NFR-OPS-002)

### 受け入れるコスト

- 書き込みが単一クラスタに集中する(初期規模では問題にならない。将来は読取レプリカ)
- 大容量の添付本体はDBに置けない(ADR-0010で分離)
- スキーマ変更が全モジュールに影響しうるためMigration規律が必須

## Rejected Alternatives

- **外部ITSM(Freshservice)を正本にしたまま機能追加** — 承認・実行・監査の一貫性を自社で保証できず、本プロジェクトの目的に反する
- **検索インデックスを正本** — 再構築不能なデータを失うリスク。整合性保証がない

## Security Impact

正本が1つであることで、監査時に「どのデータが真か」の争点が生まれない。DBへのアクセス経路(アプリロール/マイグレーションロール/DBA)の権限分離が重要(ADR-0009/0015)。

## Operational Impact

バックアップ・リストア・PITRの手順は[[08.2_Backup_and_Restore_Runbook]]。Restore Drillは四半期ごと。

## Migration Impact

Freshserviceからの移行は本DBへの一方向。移行後の逆同期は行わない(MIG-005のRollbackはルーティング切り戻しであってデータ同期ではない)。

## Follow-up

- 読取レプリカ導入の判断はNFR-PERF-001の未達が2四半期続いた場合

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
