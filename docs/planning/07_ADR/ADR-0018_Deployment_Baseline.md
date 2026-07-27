---
project: SOLVI
doc_id: "ADR-0018_Deployment_Baseline"
title: "本番はAWS ECS on Fargate、ローカルはDocker Composeを基準とする"
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

# ADR-0018: 本番はAWS ECS on Fargate、ローカルはDocker Composeを基準とする

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

本番配備先が未定のままではCI/CD・ネットワーク境界・Secret参照・監視の設計ができない(OQ-002)。EKSは機能豊富だがKubernetesの運用知識と維持工数を要し、EC2直載せは構成管理を自前で負う。現体制は少人数であり運用の単純さを優先すべきである。

## Decision

本番は **AWS ECS on Fargate**(サービス: web / api / worker / ai-advisor / executor)、DBは **Amazon RDS for PostgreSQL**(Multi-AZ、PITR有効)、ストレージは **S3**、Secretは **Secrets Manager**(ADR-0016)とする。ローカルは **Docker Compose**(PostgreSQL + MinIO + 各サービス)。**同一イメージをdigest指定で dev → stage → prod へ昇格**させ、環境差は環境変数とSecretのみとする。Executorは専用のタスク定義・専用IAMロール・専用サブネットに配置し、Egressを必要な外部APIに限定する。

## Consequences

### 得られるもの

- Kubernetesの運用負債を負わずにコンテナ運用の利点を得られる
- タスクロールでサービスごとのIAM分離が自然に書け、ADR-0006/0016の要件と噛み合う
- マネージドDB/ストレージによりバックアップ・PITRの担保が容易(NFR-OPS-002)

### 受け入れるコスト

- ECS固有の設定知識が必要(EKSほどではない)
- 将来Kubernetesへ移行する場合はタスク定義の書き換えが必要
- Fargateのコストはリソース確保単位に依存するため、サイジングの見直しが定期的に必要

## Rejected Alternatives

- **EKS** — 少人数体制に対してKubernetes運用の恒常コストが見合わない。将来必要になれば移行する
- **EC2 + docker compose** — 構成管理・パッチ適用・スケールを自前で負う。監査上の説明も弱い
- **サーバレス(Lambda)中心** — 長時間実行のWorkerと常駐接続に不向き。ローカルとの差異も大きい

## Security Impact

ネットワーク境界: ALB(public) → api/web(private subnet)、worker/executor/ai-advisor はpublic ingressなし。ExecutorのEgressはNAT + 宛先制限。RDSとS3はVPC内アクセス(S3はVPC Endpoint)。イメージはdigest固定(NFR-SEC-008)。

## Operational Impact

デプロイ・ロールバックは[[08.1_Deployment_Runbook]]。Migrationは専用タスクとして実行し、ロールバック方針を持つ(TL-05)。監視はCloudWatch + OpenTelemetry。

## Migration Impact

ローカルPoCと本番の差異(MinIO↔S3、Compose↔ECS)はContract Testと同一イメージ昇格で吸収する。差異一覧を[[99.7_Environment_and_Integration_Inventory]]で管理する。

## Follow-up

- 環境別のサイジングとコスト試算をWP-P1-PLAT-001で作成し、[[10.10_Build_vs_Buy_TCO]]へ反映する
- Multi-AZ/DR構成の詳細はGate A前に確定する(NFR-OPS-002のRPO/RTOに対応)

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
