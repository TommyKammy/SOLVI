---
project: SOLVI
doc_id: "ADR-0006_Privileged_Executor_Separation"
title: "特権操作をPrivileged Executor(SOLVI Run)へ分離する"
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

# ADR-0006: 特権操作をPrivileged Executor(SOLVI Run)へ分離する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

SOLVIはOkta/Entraのグループ操作という強い権限を持つ。Core APIはユーザ入力・添付・AI出力といった信頼できないデータを大量に扱うため、Core内に特権資格情報を置くと、Coreの任意の脆弱性がディレクトリ権限の掌握に直結する。

## Decision

特権操作は**独立プロセス SOLVI Run** のみが実行する。Executorは Core とは別の資格情報・別のIAMロール・別のネットワークポリシーで動作し、[[02.16_Executor_Command_Contract]]に定義した**署名付き・期限付き・Allowlist済みの型付きCommandのみ**を受理する。任意のHTTP/Shell実行、自由入力のリソースID、AIからの直接呼び出しは設けない。

## Consequences

### 得られるもの

- Core/AI侵害時でも、攻撃者が実行できるのはAllowlist内の操作に限定される
- 冪等性・Receipt・Policy評価を1か所に集約でき、監査の説明が単純になる
- 外部API仕様の変更をExecutor内に閉じ込められる

### 受け入れるコスト

- 1操作ごとにCommand定義・Allowlist登録・テストが必要で、新しい自動化の追加コストが上がる(意図的なコスト)
- 非同期化により、UI上の即時完了フィードバックが得られない
- Executor自体が単一障害点になるためKill Switchと復旧手順が必須

## Rejected Alternatives

- **Core APIが直接Okta/Graphを呼ぶ** — Coreの任意の脆弱性が特権掌握に直結する。本プロジェクトの中心的な回避対象
- **AIのTool(function calling)として特権APIを公開** — Prompt Injectionが特権実行に直結する。ADR-0007と両立しない
- **既存のiPaaS/RPAへ委譲** — 承認状態の再検証・冪等性・Receiptを自社の統制で保証できない

## Security Impact

T-09〜T-12の主対策。「承認済みだから安全」に依存せず、実行直前に**承認の再検証・SoD・snapshot hash照合**を行う(02.16§3)。ExecutorからAIサービスへの経路は存在させず、Gate BのGB-8で検査する。

## Operational Impact

Executor障害時は[[08.6_SOLVI_Run_Failure]]。資格情報ローテーションは[[08.7_Executor_Credential_Rotation]]。全停止はKill Switch(02.16§8)。

## Migration Impact

既存のFreshservice上の手動運用からの移行時は、まず低リスクのグループ操作のみをAllowlistに載せ、Gate B通過後に拡大する。

## Follow-up

- Allowlistへの新Action Type追加時は[[02.14_Threat_Model]]の更新とSecurity Reviewer承認を必須にする
- Gate B(GB-1〜GB-10)の全項目通過まで本番テナントへの接続を行わない

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
