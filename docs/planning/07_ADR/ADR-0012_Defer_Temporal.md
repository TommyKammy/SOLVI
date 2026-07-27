---
project: SOLVI
doc_id: "ADR-0012_Defer_Temporal"
title: "ワークフローはDB State Machine + Workerで開始し、Temporalは閾値到達まで導入しない"
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

# ADR-0012: ワークフローはDB State Machine + Workerで開始し、Temporalは閾値到達まで導入しない

## Status

**ACCEPTED**(2026-07-27 / Owner: Product Owner + Security Reviewer)

- Supersedes: なし
- Superseded by: なし

## Context

承認は数日待機し、外部API実行はリトライ・補償・タイムアウトを伴う。Temporalのような永続ワークフローエンジンは有力だが、運用要素(クラスタ、バージョニング、学習)が増える。初期の複雑性は限定的である。

## Decision

Phase 4までは`workflow_run` / `workflow_step`テーブルによる**明示的State MachineとOutbox駆動Worker**で実装する。Temporalの導入は、下記の**複雑性閾値のいずれか2つを満たした時点で後継ADRとして再判断**する。閾値: ①待機種別(承認待ち・外部完了待ち・スケジュール)が5種を超える ②補償(Compensation)を要するステップが5個を超える ③1ワークフロー定義の平均ステップ数が10を超える ④ワークフロー起因の障害が四半期3件を超える。

## Consequences

### 得られるもの

- 導入・学習・運用コストを先送りできる
- 状態がPostgreSQL上にあり、SQLで調査・修復できる(ADR-0003と整合)
- Temporalへ移行する場合も、State Machineの定義が移行元仕様になる

### 受け入れるコスト

- リトライ・タイムアウト・キャンセルを自前で実装・テストする必要がある
- ワークフロー定義のバージョニング(実行中の定義変更)を自前で扱う必要がある
- 複雑化した場合の書き直しコスト

## Rejected Alternatives

- **初日からTemporal** — 現時点の複雑性に対して過剰。運用対象が増える
- **永続ワークフローを持たない(同期処理のみ)** — 数日待機する承認を扱えない。ADR-0008とも矛盾する

## Security Impact

ワークフローの状態遷移は監査イベント化する。実行中定義の差し替えによる承認迂回が起きないよう、WorkflowRunは開始時の定義バージョンに固定する。

## Operational Impact

滞留・失敗の可視化をOps画面に持つ。キャンセルと再開の手順をRunbook化する。

## Migration Impact

なし

## Follow-up

- Gate B時点で閾値の充足状況をレビューし、結果を本ADRに追記する(充足なら後継ADR起票)

## Verification

この決定の遵守は、関連WPのAcceptance CriteriaとArchitecture/Security Test(TL-16)で検証する。PR Reviewで本ADRへのリンクを確認する。決定を変更する場合は本ADRを編集せず、後継ADRでSupersedeする。
