---
project: SOLVI
doc_id: "ADR-0001_Modular_Monolith_First"
title: "モジュラーモノリスから開始"
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

# ADR-0001: モジュラーモノリスから開始

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

初期チームは実質1〜2名+Codex appであり、分散トランザクション・サービス間認証・複数デプロイパイプラインの運用負荷を負う体力がない。一方でAIと特権実行だけは侵害半径の観点から分離が必須である。

## Decision

Core API(NestJS)を単一デプロイ単位とし、内部をDomain Module(Ticket/Catalog/Approval/Workflow/Knowledge/Asset/Change/Identity/Audit)で分離する。**別プロセスにするのはAI Advisory ServiceとSOLVI Run(Executor)の2つのみ**。Module間はアプリケーションサービス経由の呼び出しのみとし、他ModuleのテーブルへのSQL直接アクセスを禁止する。

## Consequences

### 得られるもの

- 単一トランザクションで業務状態とOutboxを原子的に保存できる(ADR-0008の前提)
- ローカル環境がdocker compose 1コマンドで再現でき、Clean-host検証(NFR-MNT-002)が容易
- 障害切り分けとデバッグが単純

### 受け入れるコスト

- Module境界の腐敗が起きやすく、依存検査を自動化しないと数か月で崩れる
- スケール単位がモジュールごとに選べない(初期規模では問題にならない)
- デプロイ時は全機能が同時に影響を受ける

## Rejected Alternatives

- **全面マイクロサービス** — 運用・認証・可観測性のコストが現体制の能力を超える。境界の正解が判明する前の分割は手戻りが大きい
- **単一巨大Module(境界なし)** — 将来の分割余地がなくなり、Executor分離という必須要件すら曖昧になる

## Security Impact

Executor/AIの分離により、Core侵害時でも特権APIへの到達が資格情報の分離とネットワーク制御で妨げられる(T-11)。逆にCore内部はモジュール境界が信頼境界ではないため、Core内の脆弱性は全ドメインに及ぶ前提で認可設計を行う。

## Operational Impact

デプロイ単位は web / api / worker / ai-advisor / executor の5つ。障害時の切り分けはまずこの単位で行う。

## Migration Impact

将来サービス分割する場合はModuleのDBスキーマ分離→API化の順で行う。分割条件は§Follow-upに定義。

## Follow-up

- Module間の禁止依存をArchitecture Test(TL-16)で強制する — WP-P0-DEV-005/WP-P1-CI-006
- 分割の判断条件: ①独立スケールが必要 ②デプロイ頻度が他の3倍以上 ③チームが分かれる — のいずれか2つを満たしたとき後継ADRを起票する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
