---
project: SOLVI
doc_id: "WP-P2-SLO-008"
title: "SLO・監視・オンコール整備"
category: "06_WorkPackages"
type: "workpackage"
status: "baseline"
version: "0.2.0"
created: "2026-07-27"
updated: "2026-07-27"
owner: "SOLVI Product Team"
tags: ["workpackage", "p2"]
source_of_truth: true
implementation_status: "partial"
requirement_ids: ["NFR-OPS-001", "NFR-OPS-004"]
---

# WP-P2-SLO-008: SLO・監視・オンコール整備

| 項目 | 値 |
|---|---|
| Phase | P2 |
| Workstream | SLO |
| Risk | medium |
| Story Points | 5 |
| Suggested Owner | Ops + Tech Lead |
| Parallelizable | Yes(WP-P1-OBS-005後) |
| Gate | Gate A |

## 1. Purpose

限定パイロット開始前に、SLO・アラート・オンコール体制を整備する。パイロットは実利用者が使うため、障害検知と一次対応の体制なしに開始しない。

## 2. Requirement IDs

`NFR-OPS-001`, `NFR-OPS-004`

## 3. Dependencies

[[WP-P1-OBS-005]]

## 4. Scope / Allowed Paths

- `infra/monitoring/`
- `08_Runbooks/08.3_SOLVI_Incident_Response.md`
- `docs/ops/`

## 5. Out of Scope

- 本番規模のDR構成(Phase 9)
- AI固有のコスト監視(WP-P8-OPS-005)

## 6. Deliverables

- SLO定義(可用性・レイテンシ・エラー率の目標とエラーバジェット)
- アラート定義(Actionableなものだけ)とエスカレーション先
- オンコール表と対応時間帯(パイロット期間は営業時間内で可)
- 合成監視(主要導線の外部監視)
- 疑似アラート対応の演習記録

## 7. Acceptance Criteria

- [x] SLO(可用性99.5%/月、主要画面p95 1.5秒、エラー率1%未満)が文書化され、計測手段が動作している
      — `docs/ops/slo.md`。計測手段は `tools/verify_slo_pipeline.mjs` で実測確認
- [x] アラートが発火→通知→一次対応者へ到達することを疑似アラートで1回以上実証した
      — executor停止から2分34秒でfiring到達、復旧後にresolved到達。**解決通知まで確認**
- [ ] 「対応不要な通知」が定常的に発生していない(1週間の観測でノイズアラート0件)
      — **未達。** 実利用のトラフィックが必要でパイロット開始後にしか測れない。
      現に `SolviNoTraffic` は無トラフィック環境でpendingになり、
      パイロット期間の夜間・休日には誤検知しうる
- [~] オンコール表・連絡経路・エスカレーション先が[[08.3_SOLVI_Incident_Response]]に記載されている
      — **部分達成。** 役割・エスカレーション経路・Severity判定・中断基準は確定。
      **担当者名と連絡先が未記入**(OQ-013)。この状態では障害時に
      「誰に連絡すればよいか」が決まらない
- [x] 合成監視がPortalトップ・ログイン・チケット作成の3導線を定期実行している
      — **達成**(2026-07-27 / [[WP-P2-PORTAL-002]])。portal_top / api_ready / login /
      ticket_create の4件。[[ADR-0019_Local_Authentication_For_Development]] により
      外部IdPを待たずに認証導線を実行できるようになった。
      専用アカウントを使う(実在の利用者を使い回すと、その人が無効化された瞬間に監視が落ちる)。
      資格情報が未設定の場合は `solvi_synthetic_skipped` として公開し、成功扱いにしない
- [x] パイロット中断の判断基準(重大障害の定義)が明記されている
      — [[08.3_SOLVI_Incident_Response]] §2

## 8. Verification and Evidence

### テスト(→ [[04.16_Test_Strategy]])

- TL-15(SLO計測の妥当性確認)

### Evidence

- 疑似アラートの発火から一次対応までの記録(時刻付き)
- 1週間のアラート発生一覧(ノイズの有無)

Evidenceは`evidence/WP-P2-SLO-008/<YYYYMMDD-HHMM>/`へ保存する([[06.2_Evidence_Index]])。

## 9. Security and Audit

- アラート通知に機微情報(チケット本文・個人情報)を含めない
- 監視ツールへのアクセス権限を最小化する

## 10. Rollback / 失敗時の扱い

アラートがノイズ過多の場合は閾値を調整する。監視が機能しない状態ではGate A(パイロット開始)を通過させない。

## 11. Codex app Prompt

```text
あなたはSOLVIの実装担当です。このWork Package(WP-P2-SLO-008)のみを実装してください。

正本: AGENTS.md → 本WP → 03.12_Operations_Performance_Requirements、01.8_Success_Metrics、02.13_Observability

作業内容:
1. SLO定義(SLI・目標・エラーバジェット・計測クエリ)を docs/ops/slo.md として作成する。
2. WP-P1-OBS-005のメトリクスを使い、SLO違反を検知するアラートを定義する。
   Actionableでないアラート(単発のエラー、想定内の遅延)を作らない。
3. 合成監視(Portalトップ・ログイン・チケット作成)を実装する。
4. 08.3_SOLVI_Incident_Responseへオンコール表・連絡経路・エスカレーション基準・パイロット中断基準を追記する。
5. 疑似アラートを1回発火させ、通知到達を確認して記録する。

制約: §4 Allowed Paths以外を変更しない。通知内容に機微情報を含めない。
完了時: 変更ファイル、SLO定義、アラート一覧、疑似アラート演習の記録、未解決事項を報告する。
```

## 12. Definition of Done

- [ ] §7 Acceptance Criteriaをすべて満たす — **2件が未達**(§7参照)。
      いずれも実装作業ではなく、実運用データと担当者確定を要する
- [x] §8のテストが通り、Evidenceを保存した
- [x] DB変更なし(本WPはスキーマを変更しない)
- [x] 関連ドキュメント(Runbook・SLO定義)を更新した
- [x] 未解決のCritical/Highがない
- [ ] Ops担当とTech Leadの確認を得た — 未実施
- [x] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| 2026-07-27 | Fable 5 | `ba5b200` / merge `9b93147` | **Partial** | `evidence/WP-P2-SLO-008/20260727-1631/` | 配線・アラート・演習は完了。受入基準3件が運用データ待ち |

### 着手して最初に見つかったこと

> [!bug] [[WP-P1-OBS-005]] のメトリクスは一度も記録されていなかった
> `NodeSDK` に `metricReader` を渡しておらず、MeterProvider が生成されていなかった。
> `metrics.getMeter()` が `NoopMeterProvider` を返すため、記録呼び出しは
> **すべて黙って捨てられていた。例外も警告も出ない。**
> 単体テストは自前のリーダーを立てるため全て緑だった。
>
> メトリクスが1件も出ていない状態では、SLOを何本定義しても判定できない。
> したがって本WPの最初の作業は配管を通すことになった。→ [[99.4_Decision_Log]] DL-009

### 実装時の設計判断

**ヘルスチェックをSLIから記録時点で除外**(DL-008)。`/healthz` は高頻度・常に高速・
常に成功する。混ぜると可用性が水増しされ p95 が薄まり、利用者が1件も成功していなくても
可用性99.9%と表示されうる。クエリ側のフィルタにしなかったのは、新しいダッシュボードを
書く人が1度忘れた時点で数字が静かに嘘になるため。

**アラートは燃焼速度(短窓と長窓の両方)で判定する。** 閾値超過の瞬間に鳴らすと
一瞬の失敗で人が起きる。月次集計だけでは気付いたときには使い切っている。

**収録の基準は「鳴ったら人が何かをすること」だけ。** 知っておくと良い程度のものを
入れると鳴っても誰も動かなくなり、本当に動くべきアラートも見過ごされる。
アラートの敵は見逃しではなくノイズである。

**通知に業務情報を載せない。** アラートは経路が広く宛先を絞りにくい。
メトリクスのラベルに識別子を入れていないため、そもそも載せられない設計になっている。

**未実行の合成監視を成功として扱わない。** `solvi_synthetic_skipped` として明示し、
監視できているつもりになるのを防ぐ。

### 演習で見つけた抑止ルールの欠陥

当初の `inhibit_rules` は `target_matchers: [slo = availability]` としており、
**源である `SolviTargetDown` 自身が抑止対象に含まれていた**。さらに `equal: ['job']` は、
`job` ラベルを持つのが `SolviTargetDown` だけであるため一致せず、**抑止は成立していなかった**。

抑止は「鳴らさない」設定であり、間違えても何も起きないため気付けない。
alertname の明示列挙に変更し、読んで効果を判断できる形にした。

### Gate A への影響

> [!warning] **Gate A(GA-6)は本WP完了時点では通過できない。**
> 残る3件はいずれも実装作業ではなく、実運用データ(1週間のノイズ観測)と
> 担当者確定(OQ-013)、および [[WP-P1-IDM-003]] の完了を要する。
