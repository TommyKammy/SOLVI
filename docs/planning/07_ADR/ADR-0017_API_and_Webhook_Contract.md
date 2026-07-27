---
project: SOLVI
doc_id: "ADR-0017_API_and_Webhook_Contract"
title: "REST + OpenAPI を API 契約とし、Webhookは署名必須とする"
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

# ADR-0017: REST + OpenAPI を API 契約とし、Webhookは署名必須とする

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

Portal/Ops/外部連携が同一のCore APIを利用する。契約が曖昧だと、フロントとバックの不整合、認可漏れ、外部連携の互換性問題が生じる。またWebhook受信は認証されていない入口になりやすい。

## Decision

Core APIは**REST + OpenAPI 3.1をスキーマ正本**とし、型・クライアント・契約テスト(TL-03)をここから生成する。エラー形式はRFC 9457 (Problem Details) に統一する。リクエストボディは**明示フィールドのホワイトリスト**でのみバインドする(mass assignment防止)。**受信Webhookは HMAC-SHA256署名 + timestamp(±5分) + リプレイ拒否を必須**とし、検証失敗は本文を処理せず破棄する。送信Webhookにも署名を付与する。GraphQLは採用しない。

## Consequences

### 得られるもの

- 契約が単一で、フロント・外部連携・テストが同じ定義を参照する
- 破壊的変更を契約テストで検知できる
- エラー表現が統一され、UIの状態表示(NFR-UX-004)が作りやすい

### 受け入れるコスト

- スキーマ更新の手間が増える(生成の自動化で緩和)
- RESTの表現力の制約(必要に応じてクエリ用エンドポイントを個別設計)

## Rejected Alternatives

- **GraphQL** — 認可のオブジェクト単位設計とクエリコスト制御が複雑になり、IDOR対策の面積が広がる
- **契約なしのRESTだけ** — フロント・外部との不整合と認可漏れの温床
- **Webhook署名なし(IP制限のみ)** — 偽装(T-17)を防げない

## Security Impact

T-03(mass assignment)、T-17(Webhook spoofing)、T-18(SSRF: 送信先はallowlist、プライベートIP帯遮断)の対策を契約層で規定する。APIバージョンは`/api/v1`で開始する。

## Operational Impact

破壊的変更は最低1バージョンの並行提供。契約テストの失敗はCIをfailさせる。

## Migration Impact

Freshserviceからの移行ツールも本APIを経由し、DB直接投入は行わない(監査イベントを残すため)。ただし大量投入時の性能上の例外はWP-P9-MIG-001で個別に判断し、その場合も移行イベントを記録する。

## Follow-up

- OpenAPI定義の置き場と生成パイプラインをWP-P1-PLAT-001で確定する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
