---
project: SOLVI
doc_id: "ADR-0005_SCIM_Service_Provider"
title: "SCIM 2.0 Service Providerを範囲限定で内製する"
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

# ADR-0005: SCIM 2.0 Service Providerを範囲限定で内製する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

ユーザのライフサイクル(入社・異動・退職)をIdPから自動反映したい。JITプロビジョニングだけでは退職・異動が反映されず、権限の残存が発生する。一方で SCIM 2.0 の全機能準拠は実装・試験コストが大きい。

## Decision

SOLVIが **/Users・/Groups と Discovery エンドポイント(/ServiceProviderConfig, /Schemas, /ResourceTypes)を提供**する。準拠範囲は[[03.7_Identity_OIDC_SCIM_Requirements]]の**SCIM準拠マトリクスで明示的に限定**し、非対応(ETag、Bulk、汎用filter、sort、/Me)は501で返して文書化する。「SCIM 2.0準拠」を無限定に名乗らない。

## Consequences

### 得られるもの

- Okta/Entra双方の標準プロビジョニングが使える
- 退職・異動が自動反映され権限残存が減る(FR-IDM-007)
- 範囲を明示することで受入判定(Gate 5)が可能になる

### 受け入れるコスト

- PATCH の方言差(Okta/Entra)への追随が継続的な保守負担
- SCIMエンドポイントは認証済みの強力な書込み口であり、トークン漏えいが致命傷になる(T-06)
- 準拠範囲外の要求がIdP側の仕様変更で発生しうる

## Rejected Alternatives

- **JITのみ** — 退職・異動が反映されず権限が残存する。監査上受け入れられない
- **ベンダ固有API同期(Okta APIをこちらから叩く)** — IdPごとに実装が増え、Entra追加時に作り直しになる
- **商用SCIMミドルウェア/ライブラリの全面採用** — Phase 5開始時に再評価する(Follow-up)。現時点では業務データモデルとの結合が強く、薄い自製実装のほうが見通しが良いと判断

## Security Impact

SCIMトークンは90日ローテーション・平文再表示なし(FR-IDM-009)、エンドポイントは専用ホスト+IdP IPアローリスト。**SCIM経由でplatform_adminロールを付与できない**制約をDBレベルで課す(T-07)。

## Operational Impact

SCIM障害時は[[08.5_SCIM_Failure_Runbook]]。再送は冪等に収束すること(FR-IDM-005)。

## Migration Impact

Freshserviceのユーザは移行せずSCIMで再生成する([[04.20_Migration_and_Cutover_Strategy]])。

## Follow-up

- Phase 5開始時に実装ライブラリ利用の再評価を行い、結果をこのADRへ追記する
- Okta/Entra実機のContract Test(TL-07)をGate 5の合格条件にする

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
