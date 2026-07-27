---
project: SOLVI
doc_id: "ADR-0007_AI_Advisory_Only"
title: "AIはadvisory-onlyとし、業務状態を確定させない"
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

# ADR-0007: AIはadvisory-onlyとし、業務状態を確定させない

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

LLMは非決定的であり、入力(チケット本文・ナレッジ・添付)には第三者が書いた文字列が含まれる。間接プロンプトインジェクションを完全に防ぐ技術は現時点で存在しない。一方でAIの分類・要約・検索は運用価値が大きい。

## Decision

AIは**分類案・要約・検索・回答案・リスク案**の生成に限定する。AIは以下を行わない: チケット状態の変更、承認の代行・決定、ナレッジの自動公開、権限やグループの変更、変更リスクの確定、監査ログへの書込み。**確定は常に人間または決定論的ルール**が行う。AI提案はUI上で人間の入力と視覚的に区別し(NFR-UX-005)、採否を記録する(FR-AI-002)。

## Consequences

### 得られるもの

- AIが停止・誤動作してもITSMの基本機能が継続する(FR-AI-007)
- Prompt Injectionの被害が「誤った提案が表示される」に留まり、権限操作に到達しない
- モデル・プロバイダを差し替えても業務の正しさが変わらない

### 受け入れるコスト

- 自動化率の上限が人間の確認速度に縛られる
- AI提案の採否操作という手間が増える(採否ログは評価データとして回収する)

## Rejected Alternatives

- **完全自律エージェント(AIが承認・実行を行う)** — Injectionと非決定性を特権境界へ持ち込む。監査上の責任主体も不明確になる
- **AIによるナレッジ自動公開** — 誤情報が全社の正解として流通するリスク

## Security Impact

T-13/T-14の主対策。AIサービスはExecutor資格情報を保持せず、Executor APIへの経路も持たない。AIへ渡すコンテキストはCoreがユーザ権限で構築し、権限外文書を混入させない。Secret/PIIはpromptへ送らない(NFR-SEC-004)。

## Operational Impact

AI障害時は手動運用を継続し、Kill Switchで機能を落とす([[08.8_AI_Kill_Switch]])。AIのコスト超過も同じスイッチで制御する。

## Migration Impact

なし

## Follow-up

- AIの権限拡大(書込みを伴う機能)を検討する場合は、本ADRのSupersedeが必須であり、Threat Model更新とSecurity Reviewer承認を伴う

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
