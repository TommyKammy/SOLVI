---
project: SOLVI
doc_id: "ADR-0002_TypeScript_Core_and_Python_AI"
title: "TypeScript CoreとPython AI"
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

# ADR-0002: TypeScript CoreとPython AI

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

Web(Next.js)とAPI間の型共有による安全性と、AI/評価領域のライブラリ資産(評価フレームワーク、埋め込み、データ処理)の双方を得たい。単一言語に寄せると片方を大きく損なう。

## Decision

Web / Core API / Worker / Executor は **TypeScript**(Next.js + NestJS)。AI Advisory Service と評価パイプラインは **Python**(FastAPI)。両者の境界は OpenAPI 契約とし、AIサービスはCoreのDBへ直接接続しない。

## Consequences

### 得られるもの

- Portal〜APIの型を共有でき、フォーム・DTOの不整合を早期に検出
- AI側でPythonの評価・埋め込みエコシステムを利用できる
- AIサービスの停止・置換がCoreに影響しない(FR-AI-007)

### 受け入れるコスト

- 言語が2つになり、CI・依存管理・開発者の学習対象が増える
- AI境界のスキーマを二重定義するコスト(OpenAPIからの生成で緩和)

## Rejected Alternatives

- **All Python** — Web/APIの型共有とNext.jsエコシステムを失う
- **All TypeScript** — AI評価・埋め込み周辺のライブラリ選択肢が狭く、評価基盤(TL-18)の構築コストが上がる

## Security Impact

AIサービスにDB資格情報とExecutor資格情報を一切渡さない(ADR-0006/0007)。AIへ渡すコンテキストはCoreが構築し必要最小限にする。

## Operational Impact

コンテナは言語ごとに分離。依存脆弱性scanはnpm/pip双方で実施(NFR-SEC-008)。

## Migration Impact

なし

## Follow-up

- OpenAPIからAIクライアント型を生成する仕組みをWP-P3-AI-004で用意する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
