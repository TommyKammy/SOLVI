# 環境別サイジングとコスト試算(初期値)

ADR-0018 の Follow-up。**未検証の見積りであり、実測で更新する。**
確定値として扱わないこと(AGENTS.md §4)。

## 前提

- 想定利用者: 初期パイロット 30名 → 全社 800名(Phase 9時点)
- チケット: 月間 400件程度(Freshservice実績のベースライン取得後に更新 — Gate 0 G0-8)
- リージョン: ap-northeast-1

## 環境別

| 環境  | 用途          | ECS タスク                                             | RDS                            | 稼働時間               |
| ----- | ------------- | ------------------------------------------------------ | ------------------------------ | ---------------------- |
| dev   | 結合・CI      | api/worker/executor/ai 各 0.25vCPU / 0.5GB             | db.t4g.micro (Single-AZ)       | 平日日中のみ(夜間停止) |
| stage | Gate検証・UAT | 本番同等の最小構成                                     | db.t4g.small (Single-AZ)       | 常時                   |
| prod  | 本番          | api×2 / worker×1 / executor×1 / ai×1(各 0.5vCPU / 1GB) | db.t4g.medium (Multi-AZ, PITR) | 常時                   |

## 月額の粗い目安(USD、2026年時点の想定)

| 項目                  |    dev |  stage |    prod |
| --------------------- | -----: | -----: | ------: |
| ECS Fargate           |     15 |     40 |     120 |
| RDS                   |     15 |     30 |     140 |
| S3 + データ転送       |      5 |      5 |      20 |
| Secrets Manager / KMS |      3 |      3 |       5 |
| CloudWatch            |      5 |     10 |      25 |
| **小計**              | **43** | **88** | **310** |

3環境合計の目安: **約 440 USD/月**。AI推論費用は別枠(OQ-006 で提供経路が未決のため未計上)。

## 更新のタイミング

- Phase 1 完了時: 実際のリソース使用量で見直す
- Gate A(パイロット)後: 実利用データで見直す
- Gate C: `docs/planning/10_Research/10.10_Build_vs_Buy_TCO.md` へ実測値を反映し、
  Freshservice継続との比較に用いる(GC-5)
