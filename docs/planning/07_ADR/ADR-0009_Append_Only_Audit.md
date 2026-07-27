---
project: SOLVI
doc_id: "ADR-0009_Append_Only_Audit"
title: "監査イベントをappend-onlyとし、日次外部アンカーで改ざんを検知する"
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

# ADR-0009: 監査イベントをappend-onlyとし、日次外部アンカーで改ざんを検知する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

承認と特権実行の証跡は本システムの存在価値そのものであり、事後の改変ができてはならない。一方で、DBの権限設定だけではDBA・インフラ管理者による改変を検知できない。

## Decision

`audit_event`テーブルへのUPDATE/DELETE/TRUNCATEをアプリケーションロールからREVOKEし、トリガで二重に拒否する。加えて**日次バッチで当日イベントの連鎖ハッシュのルート値と件数をS3 Object Lock(compliance mode)へ書き出す**。事後改変は翌日以降の照合で検知できる。スキーマとイベント一覧は[[02.17_Audit_Event_Catalog]]。

## Consequences

### 得られるもの

- アプリ由来の改変が構造的に不可能
- 特権を持つ内部者による改変も事後検知できる(T-19/T-20)
- 監査説明時に「消せない」ことを技術的に示せる

### 受け入れるコスト

- 訂正が必要な場合も打消しイベントの追加でしか表現できない(運用上の制約)
- 誤登録された個人情報を物理削除できないため、登録時のマスキング設計が必須(02.17§4)
- 日次アンカーのため、当日中の改変は翌日まで検知されない(RA-01として明示受容)

## Rejected Alternatives

- **全行ハッシュチェーンをDB内で連鎖** — 書込みの直列化が必要で性能・複雑性が見合わない。日次アンカーで検知要件を満たす
- **通常の履歴テーブルのみ** — 管理者権限で消去可能であり、監査証跡として弱い
- **外部SaaSのログ基盤を正本にする** — 可用性・retention・コストを外部に依存し、正本の二重化も招く

## Security Impact

監査の閲覧権限はauditor/platform_auditorに限定し、閲覧・export自体も記録する(AUD-002)。管理者UIに削除機能を実装しない。

## Operational Impact

アンカーの照合手順は[[08.10_Audit_Export]]。照合不一致はセキュリティインシデントとして[[08.12_Security_Incident]]へ。

## Migration Impact

Freshserviceの監査ログは移行せず、必要期間はFreshservice側で参照保管する(MIG-001)。

## Follow-up

- retention年数(暫定5年)を法務・監査確認でGate 0までに確定する
- SIEM連携はPhase 8で再検討(RA-02)

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
