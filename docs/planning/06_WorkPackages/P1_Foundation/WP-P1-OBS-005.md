---
project: SOLVI
doc_id: "WP-P1-OBS-005"
title: "Log/Metric/Trace"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p1"]
source_of_truth: true
implementation_status: "done"
---

# WP-P1-OBS-005: Log/Metric/Trace

| 項目 | 値 |
|---|---|
| Phase | P1 |
| Workstream | OBS |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Backend |
| Parallelizable | Yes(AUD-004後) |
| Gate | Gate 1 |

## 1. Purpose

構造化ログ・メトリクス・分散トレースを整備し、障害解析と性能計測の基盤を作る。監査(正本)と運用ログ(補助)を明確に分離する。

## 2. Requirement IDs

`NFR-OPS-003`, `NFR-SEC-004`

## 3. Dependencies

[[WP-P1-PLAT-001]], [[WP-P1-AUD-004]]

## 4. Scope / Allowed Paths

- `services/*/src/observability/`
- `packages/shared/src/logging/`
- `infra/monitoring/`

## 5. Out of Scope

- SLOとアラートの運用定義(WP-P2-SLO-008)
- AI固有の可観測性(WP-P8-OPS-005)

## 6. Deliverables

- OpenTelemetry計装(trace/metric)
- 構造化ログ(JSON)とredaction
- 相関IDのログ横断
- ヘルス/レディネスエンドポイント
- ローカル可視化(Jaeger等)

## 7. Acceptance Criteria

検証可能な条件のみ。すべて満たさない限りDoneにしない。

- [ ] 1リクエストのtraceがweb→api→outbox→workerまで1つのtrace idで追跡できる
- [ ] ログが構造化JSONで出力され、correlation_id/organization_id/actorを含む
- [ ] Secret・トークン・PII・チケット本文がログに出力されない(パターン検査テストで証明)
- [ ] 運用ログを監査の正本として使っていない(監査は必ずaudit_event)
- [ ] 主要メトリクス(リクエスト数・エラー率・レイテンシ・Outbox滞留数)が取得できる

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-16(ログredactionのパターン検査)
- TL-12(相関ID追跡)

### Evidence

- 1リクエストのend-to-endトレースのスクリーンショット
- redaction検査の結果

Evidenceは`evidence/WP-P1-OBS-005/<YYYYMMDD-HHMM>/`へ保存し、Command・Environment・Commit SHA・Result・Timestampを含める([[06.2_Evidence_Index]])。

## 9. Security and Audit

- ログのredactionはブロックリストでなく、出力可能フィールドのホワイトリスト方式を優先する

## 10. Rollback / 失敗時の扱い

計装の追加は機能に影響しない。性能劣化が出た場合はサンプリング率を下げる。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Packageのみを実装してください。

正本(この順で読む):
1. AGENTS.md(絶対ルール)
2. 本WP(WP-P1-OBS-005)
3. 参照設計: 02.13_Observability、ADR-0018

制約:
- §4 Allowed Paths以外のファイルを変更しない。必要が生じたらPRを分けるか、WP追加を提案する。
- §5 Out of Scopeの内容を先取り実装しない。
- ADRの決定(特にAI advisory-only、Executor分離、RLS必須)を変更しない。変更が必要なら実装を止めて後継ADRを提案する。
- 依存WPが未完了なら実装せず、不足を報告する。
- 新規依存パッケージの追加は事前に理由と代替案を提示して承認を得る。
- Secret・実データ・PIIをコード、テスト、ログ、コミットに含めない。

完了時に報告すること:
- 変更ファイル一覧 / Migrationの有無と内容 / 実行した検証コマンドと結果
- §7 Acceptance Criteria の各項目に対する充足状況(証拠付き)
- セキュリティ影響 / 未解決事項 / Evidenceの保存先

作業内容:
1. OpenTelemetryで各サービスを計装する(HTTP/DB/キュー)。
2. 構造化ログを実装し、correlation_id・organization_id・actorを必須フィールドにする。
3. redactionをホワイトリスト方式で実装し、Secret/トークン/PII/本文が出力されないことをテストで検証する。
4. ヘルス/レディネスエンドポイントを実装する(依存先の状態を含む)。
5. ローカルでtraceを可視化できる構成(Jaeger等)をdocker composeへ追加する。

監査イベント(audit_event)と運用ログを混同しないこと。監査の正本はDBであり、ログではない。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある
- [ ] 関連ドキュメント(API定義・Runbook・RTM)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Tech Leadのレビューを完了した
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Claude (Codex) | `8ada7b7` | Done | `evidence/WP-P1-OBS-005/20260727-1531/verification.md` | トレース疎通7/7、全951テスト通過。**重要な発見**: OpenTelemetryの自動計装が tsx/ESM 環境で無言で無効になっていた(SDKは起動するがスパンが0件、エラーもログも出ない)。実スタックへの疎通確認スクリプトを書いていたため発覚。HTTPハンドラで明示的にスパンを張る方式へ変更し、自動計装には依存しない構成にした。 |

### 後日判明した実装欠陥 (2026-07-27 / [[WP-P2-SLO-008]] で修正)

> [!bug] メトリクスは一度も記録されていなかった
> `NodeSDK` に `metricReader` を渡していなかったため MeterProvider が生成されず、
> `metrics.getMeter()` は `NoopMeterProvider` を返していた。
> `recordHttpRequest()` `recordOutboxLag()` `recordAuthzDenial()` の呼び出しは
> **すべて黙って捨てられていた。例外も警告も出ない。**
>
> 単体テストは自前のインメモリリーダーを立てるため、全て緑のままだった。
> 上記のトレースの欠陥とまったく同じ形であり、**同じ教訓を2度学び損ねた**ことになる。
> 「計器を定義した」ことと「本番の経路で出ている」ことは別の主張である。
>
> 修正: [[WP-P2-SLO-008]] で `PrometheusExporter` を接続し、`METRICS_PORT` で有効化。
> 本番経路の確認を `tools/verify_slo_pipeline.mjs` として常設した。
> → [[99.4_Decision_Log]] DL-009
