---
project: SOLVI
doc_id: "ADR-0016_Secret_Management"
title: "Secretは用途別に分離したSecrets Managerで管理し、コードとログから排除する"
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

# ADR-0016: Secretは用途別に分離したSecrets Managerで管理し、コードとログから排除する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

SOLVIはOkta/Graphの特権資格情報、SCIMトークン、DB資格情報、AIプロバイダキー、署名鍵を扱う。これらが混在管理されると、1つの侵害が全体に波及する。またAIサービスへのprompt送信やログ出力での漏えい経路もある。

## Decision

全SecretをAWS Secrets Manager(ローカルは.env + gitignore、コミット禁止)で管理し、**用途別パスとIAMポリシーで分離**する: `solvi/core/*` `solvi/executor/*` `solvi/ai/*` `solvi/scim/*`。**Core・AIのIAMロールから`solvi/executor/*`を読めない**ことをポリシーで保証する(ADR-0006の実装)。Command署名鍵はKMS管理とし、平文で取り出さない。CIにsecret scanを必須ゲートとして組み込み、ログ・トレース・AI promptへのSecret出力をredactionで排除する。

## Consequences

### 得られるもの

- 1つの資格情報の漏えいが他へ波及しない
- ローテーションを用途ごとに独立して実施できる
- 漏えい経路(git/ログ/prompt)を機械的に塞げる

### 受け入れるコスト

- ローテーション手順を用途ごとに用意・演習する必要がある
- ローカル開発の初期設定が増える

## Rejected Alternatives

- **環境変数のみ(Secrets Manager不使用)** — ローテーション・監査・アクセス制御ができない
- **単一のSecretパスに集約** — Executor資格情報の分離というADR-0006の前提が崩れる
- **HashiCorp Vault自前運用** — 運用対象が増える。マネージドで足りる

## Security Impact

T-06/T-11/T-22の主対策。Secretの平文再表示はUIに実装しない(生成時のみ表示 — FR-IDM-009)。バックアップにもSecretを含めない。

## Operational Impact

ローテーション手順: Executor資格情報は[[08.7_Executor_Credential_Rotation]]、SCIMトークンは[[08.5_SCIM_Failure_Runbook]]。証明書更新も同様の手順様式で管理する。Break Glass用資格情報は封緘保管し、使用時に必ず監査イベントと事後レビューを伴う([[08.13_Break_Glass_Runbook]])。

## Migration Impact

Freshserviceの資格情報は移行しない。移行作業用の一時資格情報は作業完了後に失効させる。

## Follow-up

- Secret一覧(用途・保管先・ローテーション周期・所有者)をWP-P1-PLAT-001の成果物として作成する
- 四半期のアクセスレビュー(NFR-SEC-002)に本一覧を用いる

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
