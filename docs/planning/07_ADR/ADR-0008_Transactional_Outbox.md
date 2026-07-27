---
project: SOLVI
doc_id: "ADR-0008_Transactional_Outbox"
title: "Transactional Outboxで状態変更とイベント発行を原子化する"
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

# ADR-0008: Transactional Outboxで状態変更とイベント発行を原子化する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

承認成立→Command発行→通知、のように業務状態の変更に外部作用が続く。HTTPリクエスト内で外部APIを直接呼ぶと、DBコミットと外部呼び出しの間で不整合(二重通知・イベント喪失)が発生する。

## Decision

業務状態の変更と`outbox_event`への書込みを**同一トランザクション**で行い、別プロセスのWorkerが取り出して配送する。配送はat-least-onceとし、受信側(Executor・通知)が冪等性で重複を吸収する(ADR-0006、02.16§4)。

## Consequences

### 得られるもの

- イベントの取りこぼしがない(コミットされた変更は必ず配送される)
- HTTPリクエストが外部APIのレイテンシに引きずられない
- 再送・順序制御・DLQをWorker側で一元管理できる

### 受け入れるコスト

- at-least-onceのため受信側に必ず冪等性が必要
- Outboxテーブルの肥大化対策(アーカイブ)が要る
- 結果整合になるためUIに「処理中」状態の表現が必要

## Rejected Alternatives

- **同期外部呼び出し** — タイムアウト時に状態が不明になり、二重実行の温床になる
- **Dual write(DBと外部キューへ個別に書く)** — 片方失敗時に不整合。分散トランザクションは複雑性が見合わない
- **CDC(logical decoding)** — 運用要素が増える。Outboxで足りる

## Security Impact

イベント本文に機微情報を含めない(参照IDのみ)。Outboxの改ざんは業務改ざんに直結するため、書込みはアプリケーションサービス経由のみとする。

## Operational Impact

配送遅延はNFR-PERF-003(p95 30秒)で監視。滞留時は[[08.3_SOLVI_Incident_Response]]。

## Migration Impact

なし

## Follow-up

- Outboxのアーカイブ方針(90日でパーティション移動)をWP-P4-WF-003で確定する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
