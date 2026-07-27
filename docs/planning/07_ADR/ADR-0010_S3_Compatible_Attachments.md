---
project: SOLVI
doc_id: "ADR-0010_S3_Compatible_Attachments"
title: "添付本体をS3互換Object Storageへ置く"
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

# ADR-0010: 添付本体をS3互換Object Storageへ置く

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

チケット添付・ナレッジ画像はサイズが大きく、DBに置くとバックアップ時間とコストが跳ね上がる。一方でアクセス制御と監査はDB側の権限モデルに従う必要がある。

## Decision

**添付の本体はS3互換Object Storage、メタデータと権限はPostgreSQL**。ダウンロードは有効期限10分以内の署名付きURLを、要求のたびに認可検証してから発行する。バケットは非公開・バージョニング有効・サーバサイド暗号化。ローカル開発はMinIOを使う。

## Consequences

### 得られるもの

- DBサイズとバックアップ時間を抑えられる
- バージョニングで誤削除から復旧できる
- 署名付きURLで配信負荷をアプリから切り離せる

### 受け入れるコスト

- DBとObject Storageの整合(孤児オブジェクト・参照切れ)を別途管理する必要がある
- 署名付きURLは発行後に無効化しにくいため有効期限を短く保つ必要がある(T-16)

## Rejected Alternatives

- **DB BLOB** — バックアップ・リストア時間とコストが許容できない
- **ファイルシステム直** — 可用性・バックアップ・権限管理を自前で作ることになる

## Security Impact

URLにOrganization情報を含めない。単一オブジェクト限定・短期限(02.18§4)。ウイルススキャン完了まで配布しない(FR-TKT-005)。バックアップ・エクスポートの持出しはNFR-SEC-009で保護する。

## Operational Impact

整合性回復: DBに存在しないオブジェクトの定期棚卸し(週次)と、参照切れメタデータの検知。手順は[[08.11_Data_Reconciliation]]。アップロードは「オブジェクト保存→メタデータ確定」の順とし、失敗時は孤児オブジェクトとしてGCする(逆順にすると参照切れが発生する)。

## Migration Impact

Freshserviceの添付移行はサイズ・件数を事前計測し上限方針を決める(MIG-001)。

## Follow-up

- 本番のObject Storage(S3)とローカル(MinIO)の差異をContract Testで吸収する

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
