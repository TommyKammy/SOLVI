---
project: SOLVI
doc_id: "ADR-0014_No_Custom_Inventory_Agent"
title: "独自の端末インベントリエージェントを開発しない"
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

# ADR-0014: 独自の端末インベントリエージェントを開発しない

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

資産情報の鮮度を上げるにはエージェント配布が有効だが、配布・署名・自動更新・脆弱性対応・EDRとの共存を自社で永続的に負うことになる。既にIntune・CrowdStrike・AWSが同等の情報を保有している。

## Decision

端末・サーバ情報は**既存ソース(Intune / Microsoft Graph / CrowdStrike / AWS)からの同期とCSV取込**で取得する。SOLVI独自のエージェントは開発・配布しない。属性ごとに正本ソースを定義し(Attribute Ownership)、手入力は補完としてのみ許可する。

## Consequences

### 得られるもの

- エージェントの配布・更新・脆弱性対応という永続負債を負わない
- 既存ソースの情報鮮度をそのまま活用できる
- 端末への追加ソフト導入という組織的な調整が不要

### 受け入れるコスト

- 取得できる属性は各ソースの提供範囲に制限される
- リアルタイム性はソースの同期間隔に依存する
- ソース間の重複・矛盾を解決するReconciliationが必要(FR-AST-003)

## Rejected Alternatives

- **独自エージェント開発** — 上記の永続負債。CMDBの価値に対して割に合わない
- **手入力のみ** — 鮮度と網羅性が確保できず、CMDBが陳腐化する

## Security Impact

各ソースへの接続は読取専用の最小権限とし、資産同期用の資格情報とExecutorの書込み用資格情報を分離する(NFR-SEC-002)。

## Operational Impact

同期失敗時はSource別に結果を追跡し、部分的失敗を許容する(FR-AST-004)。

## Migration Impact

Freshserviceの資産データはActive分のみ移行し、Source SystemをFreshserviceとして記録する。

## Follow-up

- 属性ごとの正本責任表(Attribute Ownership)をWP-P6-AST-001の成果物として作成する(OQ-007)

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
