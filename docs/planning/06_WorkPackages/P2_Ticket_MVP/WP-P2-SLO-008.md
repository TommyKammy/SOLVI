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
implementation_status: "not-started"
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

- [ ] SLO(可用性99.5%/月、主要画面p95 1.5秒、エラー率1%未満)が文書化され、計測手段が動作している
- [ ] アラートが発火→通知→一次対応者へ到達することを疑似アラートで1回以上実証した
- [ ] 「対応不要な通知」が定常的に発生していない(1週間の観測でノイズアラート0件)
- [ ] オンコール表・連絡経路・エスカレーション先が[[08.3_SOLVI_Incident_Response]]に記載されている
- [ ] 合成監視がPortalトップ・ログイン・チケット作成の3導線を定期実行している
- [ ] パイロット中断の判断基準(重大障害の定義)が明記されている

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

- [ ] §7 Acceptance Criteriaをすべて満たす
- [ ] §8のテストが通り、Evidenceを保存した
- [ ] DB変更にMigrationとロールバック方針、既存データ互換の説明がある(該当なければ明記)
- [ ] 関連ドキュメント(Runbook・SLO定義)を更新した
- [ ] 未解決のCritical/Highがない
- [ ] Ops担当とTech Leadの確認を得た
- [ ] Execution Logへ結果を追記した

## 13. Execution Log

| Date | Actor | Commit/PR | Result | Evidence | Notes |
|---|---|---|---|---|---|
| - | - | - | Not started | - | - |
