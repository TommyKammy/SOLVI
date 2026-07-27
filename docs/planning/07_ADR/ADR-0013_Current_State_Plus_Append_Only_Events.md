---
project: SOLVI
doc_id: "ADR-0013_Current_State_Plus_Append_Only_Events"
title: "現在状態テーブル + append-onlyイベントの併用(完全Event Sourcingは採らない)"
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

# ADR-0013: 現在状態テーブル + append-onlyイベントの併用(完全Event Sourcingは採らない)

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

監査可能性は必須だが、完全なEvent Sourcingは読取モデルの構築・スキーマ進化・デバッグの複雑性が大きく、現体制には重い。

## Decision

業務データは**通常の現在状態テーブル**で保持し、変更履歴と証跡は**append-onlyのドメインイベント/監査イベント**で保持する。現在状態はイベントから再構築されるのではなく、それ自体が正本である(ADR-0003)。

## Consequences

### 得られるもの

- 通常のCRUDとSQLで開発でき、Codexにも人間にも扱いやすい
- 監査に必要な履歴は確保される
- 状態の読取が単純で性能が出る

### 受け入れるコスト

- 現在状態とイベントの二重書込みになるため、アプリケーションサービス層で必ず両方を書く規律が要る(直接UPDATE禁止)
- 任意時点への完全な巻き戻しはできない(PITRで代替)

## Rejected Alternatives

- **完全Event Sourcing** — 複雑性が体制に見合わない。読取モデル整備とスキーマ進化のコストが大きい
- **現在状態のみ(履歴なし)** — 監査可能性(BR-004)を満たせない

## Security Impact

イベント書込みの欠落は証跡欠落であり、Evidence completeness(01.8)のゼロトレランス対象。状態変更をアプリケーションサービス経由に限定するアーキテクチャテストで担保する。

## Operational Impact

調査時は現在状態→イベント→Receiptの順に辿る。相関IDで横断する(NFR-OPS-003)。

## Migration Impact

移行データは現在状態として投入し、移行イベント(`migrated`)を1件記録する。

## Follow-up

- ドメインイベントと監査イベントの重複を整理し、02.17のカタログに一本化する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
