---
project: SOLVI
doc_id: "ADR-0004_External_Identity_OIDC"
title: "認証を外部IdPのOIDCへ委譲する"
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

# ADR-0004: 認証を外部IdPのOIDCへ委譲する

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし
- **Amended by: [[ADR-0019_Local_Authentication_For_Development]]**(2026-07-27)
  — 検証段階に限りローカルアカウント認証を許可する。
  **本ADRの決定(実利用の認証はOIDCに限定)は変更されていない。**
  変わったのは外部IdPへ接続する時期だけである。

## Context

MFA・条件付きアクセス・パスワードポリシー・失効はIdP(Okta/Entra)が既に運用している。SOLVIが独自のパスワード認証を持つと、資格情報の保護責任と退職者管理の二重化を抱える。

## Decision

通常利用の認証は**Okta/Entra IdPのOIDC Authorization Code + PKCE**に限定する。ローカルパスワード認証は提供しない。issuer / audience / state / nonce / exp を全て検証し、いずれか不正なら拒否する(fail closed)。IdPごとにissuerを固定し、複数IdP混在時も取り違えを起こさない。

## Consequences

### 得られるもの

- パスワード漏えい・MFA未実施のリスクをSOLVIが負わない
- 退職者の停止がIdP側の操作で一元化される
- Okta/Entraのどちらでも同一の実装で対応できる

### 受け入れるコスト

- IdP障害時にSOLVIへログインできない(緊急時手順が別途必要 — Follow-up)
- IdP設定ミスがそのまま認証の脆弱性になるため、設定検証テストが必須(TL-08)

## Rejected Alternatives

- **独自パスワード認証** — 資格情報保護・MFA・退職者管理の責任を負う。本プロジェクトの体制では割に合わない
- **SAMLのみ** — 実装が重く、モバイル/SPAとの相性が悪い。OIDCで足りる

## Security Impact

T-04(OIDC設定不備)への対策そのもの。トークン検証の抜けが即座に認証バイパスになるため、ネガティブテストをGate 1の合格条件(G1-1)にする。IdP側で無効化されたユーザのセッション失効はOIDCだけでは保証されないため、FR-IDM-008で別途担保する。

## Operational Impact

IdP障害時は[[08.4_OIDC_Outage_Runbook]]。Break Glass用のローカル管理経路は通常無効・使用時監査必須([[08.13_Break_Glass_Runbook]])。

## Migration Impact

Freshserviceの既存ユーザはSCIM/JITで再生成し、パスワードは移行しない。

## Follow-up

- Phase 1はOktaのみ。EntraのOIDC対応はPhase 4で追加(OQ-001の決定に従う)
- Break Glass経路の設計をADR-0016と08.13で確定する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
